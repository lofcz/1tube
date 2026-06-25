using System.Diagnostics;
using System.Net.NetworkInformation;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace OneTube;

public sealed record GatewayProcessSnapshot(
    int Pid,
    string Name,
    long WorkingSetBytes,
    long PrivateMemoryBytes,
    TimeSpan TotalProcessorTime,
    DateTime SampledAtUtc);

public sealed record GatewayBinaryVersion(
    string Name,
    string? Path,
    string? Version,
    string? Error);

public sealed record GatewayBinaryDiagnostics(
    GatewayBinaryVersion Deno,
    GatewayBinaryVersion Workerd);

public sealed record WorkerdProbeResult(
    string? WorkerdPath,
    string CapnpPath,
    string Command,
    string WorkingDirectory,
    int? ExitCode,
    bool TimedOut,
    bool Killed,
    long DurationMs,
    string Stdout,
    string Stderr,
    string? Error);

/// <summary>
/// Manages the lifecycle of one OneTube gateway slot. The gateway
/// itself is always Deno (<c>src/server.ts</c>); when
/// <see cref="OneTubeOptions.Backend"/> is
/// <see cref="OneTubeBackend.Workerd"/> the gateway spawns workerd as
/// its own subprocess, which we point at via <c>--workerd-bin</c>.
///
/// One <see cref="DenoHostService"/> instance owns one Deno child
/// listening on one port — the slot's port. The single-host
/// deployment registers exactly one of these as both an
/// <see cref="IHostedService"/> (so it boots with the app) and an
/// <see cref="IGatewayHost"/> (so the destination provider can find
/// it). The firmware supervisor (Phase 4) creates a second instance
/// on demand for the candidate slot, drives it via the
/// <see cref="IGatewayHost"/> surface, and wires it into the
/// destination provider after a successful smoke test.
///
/// Responsibilities:
/// <list type="bullet">
///   <item><description>Validate both binary paths up front.</description></item>
///   <item><description>Spawn deno with the full CLI surface from <see cref="OneTubeOptions"/> + slot.</description></item>
///   <item><description>Tail stdout/stderr into the host logger (tagged with the slot label).</description></item>
///   <item><description>Periodically poll <c>/health</c>, then stop the 1tube slot on unrecoverable failure while leaving the host alive.</description></item>
///   <item><description>Kill the child cleanly on host shutdown / Ctrl+C / process-exit.</description></item>
/// </list>
///
/// State is per-instance — there is no static shared between two
/// slots. The class name is historical (gateway used to be the only
/// thing this service managed) but the surface fully covers both
/// backends and both slots.
/// </summary>
public sealed class DenoHostService : IHostedService, IGatewayHost, IDisposable
{
    private const int MaxBackoffMs = 30_000;
    private static readonly Regex AnsiEscapeRegex = new(@"\x1B\[[0-?]*[ -/]*[@-~]", RegexOptions.Compiled);

    /// <summary>
    /// Exit-code contract published by the gateway (see
    /// <c>src/server.ts</c> — <c>EXIT_CODES</c>). The supervisor uses
    /// these to decide whether a failure is permanent (the gateway
    /// told us "my config is wrong, retrying won't help") or transient
    /// (an actual crash worth restarting). We do <em>not</em> guess
    /// based on timing — the gateway is the authority on what kind of
    /// failure it just suffered.
    /// </summary>
    private const int ExitCodeUsageError = 64;   // EX_USAGE   — bad CLI args
    private const int ExitCodeConfigError = 78;  // EX_CONFIG  — missing/invalid required env or manifest

    /// <summary>
    /// Number of trailing stderr lines we keep so the
    /// "permanently unavailable" log includes the gateway's own
    /// FATAL output verbatim. Bounded so a chatty failure doesn't
    /// grow the buffer without limit.
    /// </summary>
    private const int StderrTailCapacity = 32;

    private readonly OneTubeOptions _options;
    private readonly GatewaySlot _slot;
    private readonly ILogger<DenoHostService> _logger;

    private Process? _process;
    private CancellationTokenSource? _cts;
    private Task? _healthLoop;
    private int _consecutiveFailures;
    private int _currentBackoffMs = 1000;
    private bool _permanentlyUnavailable;
    private bool _isRunning;
    private DateTime? _startedAt;
    private int _restartCount;

    /// <summary>
    /// Latched <c>true</c> as soon as the host signals shutdown
    /// (StopAsync, Dispose, ProcessExit, Ctrl+C). Distinct from
    /// <see cref="_permanentlyUnavailable"/> because that's reserved
    /// for "the gateway told us its config is broken"; this one is
    /// "we are tearing down, do not under any circumstance spawn a
    /// fresh child". Both gates short-circuit
    /// <see cref="SpawnProcess"/> and the restart path so a
    /// SpawnProcess already in flight when Ctrl+C is hit cannot
    /// race the cancel and produce an orphan post-shutdown.
    /// </summary>
    private volatile bool _shuttingDown;

    /// <summary>
    /// Bounded ring of recent stderr lines from the gateway child.
    /// On a permanent-failure exit we dump the tail into the log so
    /// the operator sees the gateway's own FATAL message inline with
    /// our "stopped restarting" announcement, instead of having to
    /// scroll up past restart noise.
    /// </summary>
    private readonly Queue<string> _stderrTail = new();
    private readonly object _stderrTailLock = new();

    /// <summary>
    /// Cached resolved binary paths. Resolved once on first spawn and
    /// reused on every restart — the binary doesn't move between
    /// crashes, and re-running the resolver on every restart adds
    /// pointless latency to the recovery path.
    /// </summary>
    private string? _denoExe;
    private string? _workerdExe;

    public string Label => _slot.Label;
    public int Port => _slot.Port;
    public string Host => _options.Host;
    public bool IsRunning => _isRunning;
    public DateTime? StartedAt => _startedAt;
    public int RestartCount => _restartCount;
    public bool IsPermanentlyUnavailable => _permanentlyUnavailable;
    public GatewayProcessSnapshot? GetProcessSnapshot()
    {
        var process = _process;
        if (process is null) return null;

        try
        {
            if (process.HasExited) return null;
            process.Refresh();
            return new GatewayProcessSnapshot(
                process.Id,
                process.ProcessName,
                process.WorkingSet64,
                process.PrivateMemorySize64,
                process.TotalProcessorTime,
                DateTime.UtcNow);
        }
        catch
        {
            return null;
        }
    }

    public string LastStderrTailForDiagnostics
    {
        get
        {
            lock (_stderrTailLock)
            {
                return string.Join(Environment.NewLine, _stderrTail);
            }
        }
    }

    /// <summary>
    /// Loopback-resolved YARP destination. We forward to 127.0.0.1
    /// when the gateway is bound to 0.0.0.0 because we're inside the
    /// same box and there's no reason to round-trip through the
    /// public interface.
    /// </summary>
    public string DestinationBaseUrl
    {
        get
        {
            string host = _options.Host == "0.0.0.0" ? "127.0.0.1" : _options.Host;
            return $"http://{host}:{_slot.Port}";
        }
    }

    /// <summary>
    /// Optional supplier of runtime-edited secrets, layered onto
    /// <see cref="OneTubeOptions.EnvVars"/> at spawn time. Stored as
    /// a delegate (not the store itself) so the secrets package
    /// remains an optional dependency: hosts without the secrets
    /// feature don't pull <c>OneTube.Secrets</c> into their object
    /// graph.
    ///
    /// <para>Captured by SpawnProcess on every (re)spawn — a
    /// supervisor-driven side-by-side swap simply spawns a fresh
    /// candidate, which calls this delegate and gets the latest
    /// snapshot. There is no in-place env mutation of a running
    /// child.</para>
    /// </summary>
    private readonly Func<IReadOnlyDictionary<string, string>?>? _secretsProvider;

    /// <summary>
    /// Constructor used by DI for the single-host (active) slot.
    /// Resolves the slot from <see cref="OneTubeOptions.Port"/> and
    /// labels it "active". The firmware supervisor uses the
    /// <see cref="DenoHostService(OneTubeOptions, GatewaySlot, ILogger{DenoHostService}, Func{IReadOnlyDictionary{string, string}?}?)"/>
    /// overload to create candidate slots on demand.
    /// </summary>
    public DenoHostService(
        Microsoft.Extensions.Options.IOptions<OneTubeOptions> options,
        ILogger<DenoHostService> logger)
        : this(options.Value, new GatewaySlot("active", options.Value.Port), logger, secretsProvider: null)
    {
    }

    public DenoHostService(
        OneTubeOptions options,
        GatewaySlot slot,
        ILogger<DenoHostService> logger,
        Func<IReadOnlyDictionary<string, string>?>? secretsProvider = null)
    {
        _options = options;
        _slot = slot;
        _logger = logger;
        _secretsProvider = secretsProvider;
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        // Idempotent spawn — if a candidate slot has already been
        // started by the supervisor, the IHostedService boot path
        // (when used as such) is a no-op.
        if (_isRunning) return Task.CompletedTask;

        _shuttingDown = false;
        _permanentlyUnavailable = false;
        InvalidateBinaryCache();
        _cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);

        AppDomain.CurrentDomain.ProcessExit += OnProcessExit;
        Console.CancelKeyPress += OnCancelKeyPress;

        SpawnProcess();
        _healthLoop = Task.Run(() => HealthLoopAsync(_cts.Token), _cts.Token);
        return Task.CompletedTask;
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        // Set the latch BEFORE cancelling — any in-flight SpawnProcess
        // or HandleFailureAndRestart will observe it and bail out
        // instead of creating an orphan child after we've torn down.
        _shuttingDown = true;

        AppDomain.CurrentDomain.ProcessExit -= OnProcessExit;
        Console.CancelKeyPress -= OnCancelKeyPress;

        _cts?.Cancel();

        if (_healthLoop is not null)
        {
            try { await _healthLoop; }
            catch (OperationCanceledException) { }
        }

        KillProcess();
        _isRunning = false;
    }

    public async Task RecycleAsync(CancellationToken cancellationToken)
    {
        InvalidateBinaryCache();
        await StopAsync(cancellationToken);
        cancellationToken.ThrowIfCancellationRequested();
        await StartAsync(cancellationToken);
    }

    public async Task<GatewayBinaryDiagnostics> GetBinaryDiagnosticsAsync(CancellationToken cancellationToken = default)
    {
        var denoPath = ResolveDenoBinary();
        var workerdPath = ResolveWorkerdBinary();
        return new GatewayBinaryDiagnostics(
            await ProbeBinaryVersionAsync("deno", denoPath, "--version", cancellationToken),
            await ProbeBinaryVersionAsync("workerd", workerdPath, "--version", cancellationToken));
    }

    public void InvalidateBinaryCache()
    {
        _denoExe = null;
        _workerdExe = null;
    }

    /// <summary>
    /// Builds the diagnostic context the experiment runner expects.
    /// Centralised here so callers (the admin UI, tests, future
    /// CLI surfaces) don't reach into private path logic.
    /// </summary>
    public OneTube.Diagnostics.ExperimentContext BuildExperimentContext(string? activeCapnpPath = null)
    {
        var dataRoot = ResolveRuntimeDataRoot();
        var diagDir = Path.Combine(dataRoot, "onetube", "diagnostics");
        var experimentsDir = Path.Combine(dataRoot, "onetube", "experiments");
        Directory.CreateDirectory(diagDir);
        Directory.CreateDirectory(experimentsDir);
        return new OneTube.Diagnostics.ExperimentContext(
            WorkerdPath: ResolveWorkerdBinary(),
            DenoPath: ResolveDenoBinary(),
            GatewayRoot: Path.Combine(AppContext.BaseDirectory, "OneTubeGateway"),
            DataRoot: dataRoot,
            DiagnosticsDir: diagDir,
            ExperimentsDir: experimentsDir,
            DenoCacheDir: DenoCacheDir,
            ActiveCapnpPath: activeCapnpPath,
            RandomPort1: PickEphemeralPort(),
            RandomPort2: PickEphemeralPort());
    }

    /// <summary>
    /// Runs the configured <c>workerd</c> binary under the host's own
    /// identity against either a caller-supplied capnp config or a
    /// minimal "hello world" config and captures stdout/stderr/exit
    /// code. This exists so an operator who can hit the firmware
    /// bearer endpoint can reproduce a workerd startup crash on a
    /// locked-down box (e.g. an IIS-hosted app running as a domain
    /// account that cannot open Event Viewer) without needing shell
    /// access. The probe always terminates the child after
    /// <paramref name="timeout"/> elapses; a clean boot will simply
    /// be killed and reported as <c>Killed=true</c>.
    /// </summary>
    public async Task<WorkerdProbeResult> ProbeWorkerdAsync(
        string? capnpPathOverride,
        TimeSpan? timeout = null,
        CancellationToken cancellationToken = default)
    {
        var sw = Stopwatch.StartNew();
        var workerdPath = ResolveWorkerdBinary();
        var effectiveTimeout = timeout ?? TimeSpan.FromSeconds(5);

        // Where to write probe artifacts: same writable area we use
        // for the deno cache — guaranteed writable by the host
        // identity, never under c:\windows\system32 or the IIS site
        // root.
        var probeDir = Path.Combine(ResolveRuntimeDataRoot(), "onetube", "diagnostics");
        Directory.CreateDirectory(probeDir);

        string capnpPath;
        if (!string.IsNullOrWhiteSpace(capnpPathOverride))
        {
            capnpPath = Path.GetFullPath(capnpPathOverride);
        }
        else
        {
            capnpPath = Path.Combine(probeDir, "workerd-probe.capnp");
            var port = PickEphemeralPort();
            await File.WriteAllTextAsync(capnpPath, MinimalProbeCapnp.Replace("__PORT__", port.ToString()), cancellationToken);
        }

        var workingDir = probeDir;
        var arguments = $"serve \"{capnpPath}\"";
        var command = workerdPath is null ? $"<unresolved> {arguments}" : $"\"{workerdPath}\" {arguments}";

        if (string.IsNullOrWhiteSpace(workerdPath))
        {
            sw.Stop();
            return new WorkerdProbeResult(
                null, capnpPath, command, workingDir,
                ExitCode: null, TimedOut: false, Killed: false,
                DurationMs: sw.ElapsedMilliseconds,
                Stdout: "", Stderr: "",
                Error: "workerd binary not resolved");
        }

        var startInfo = new ProcessStartInfo
        {
            FileName = workerdPath,
            Arguments = arguments,
            WorkingDirectory = workingDir,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };

        var stdout = new System.Text.StringBuilder();
        var stderr = new System.Text.StringBuilder();
        Process? proc = null;
        var killed = false;
        var timedOut = false;
        string? error = null;

        try
        {
            proc = Process.Start(startInfo);
            if (proc is null)
            {
                sw.Stop();
                return new WorkerdProbeResult(
                    workerdPath, capnpPath, command, workingDir,
                    ExitCode: null, TimedOut: false, Killed: false,
                    DurationMs: sw.ElapsedMilliseconds,
                    Stdout: "", Stderr: "",
                    Error: "failed to start process");
            }

            proc.OutputDataReceived += (_, e) => { if (e.Data is not null) lock (stdout) stdout.AppendLine(e.Data); };
            proc.ErrorDataReceived += (_, e) => { if (e.Data is not null) lock (stderr) stderr.AppendLine(e.Data); };
            proc.BeginOutputReadLine();
            proc.BeginErrorReadLine();

            using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeoutCts.CancelAfter(effectiveTimeout);

            try
            {
                await proc.WaitForExitAsync(timeoutCts.Token);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                timedOut = true;
            }

            if (!proc.HasExited)
            {
                try { proc.Kill(entireProcessTree: true); killed = true; } catch { /* race */ }
                try { await proc.WaitForExitAsync(CancellationToken.None); } catch { /* swallow */ }
            }
        }
        catch (Exception ex)
        {
            error = ex.Message;
        }

        sw.Stop();
        int? exitCode = null;
        try { if (proc is not null && proc.HasExited) exitCode = proc.ExitCode; } catch { /* ignore */ }
        proc?.Dispose();

        return new WorkerdProbeResult(
            workerdPath,
            capnpPath,
            command,
            workingDir,
            ExitCode: exitCode,
            TimedOut: timedOut,
            Killed: killed,
            DurationMs: sw.ElapsedMilliseconds,
            Stdout: stdout.ToString(),
            Stderr: stderr.ToString(),
            Error: error);
    }

    private static int PickEphemeralPort()
    {
        using var listener = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0);
        listener.Start();
        var port = ((System.Net.IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        return port;
    }

    private const string MinimalProbeCapnp = """
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    ( name = "probe",
      worker = (
        compatibilityDate = "2024-09-23",
        compatibilityFlags = ["nodejs_compat"],
        modules = [
          ( name = "worker",
            esModule = "export default { fetch() { return new Response('ok'); } };" )
        ]
      )
    )
  ],
  sockets = [
    ( name = "http",
      address = "127.0.0.1:__PORT__",
      http = (),
      service = "probe" )
  ]
);
""";

    public async Task<bool> ProbeHealthAsync(CancellationToken cancellationToken)
    {
        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
        var healthHost = _options.Host == "0.0.0.0" ? "127.0.0.1" : _options.Host;
        var healthUrl = $"http://{healthHost}:{_slot.Port}/health";
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, healthUrl);
            if (!string.IsNullOrEmpty(_options.InternalKey))
            {
                req.Headers.Add("Authorization", $"Bearer {_options.InternalKey}");
            }
            using var resp = await client.SendAsync(req, cancellationToken);
            return resp.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    private string DenoCacheDir => Path.Combine(ResolveRuntimeDataRoot(), "onetube", "deno-cache");

    private string ResolveRuntimeDataRoot()
    {
        if (string.IsNullOrWhiteSpace(_options.DataRoot))
        {
            return AppContext.BaseDirectory;
        }

        return Path.IsPathRooted(_options.DataRoot)
            ? _options.DataRoot
            : Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, _options.DataRoot));
    }

    public void Dispose()
    {
        _shuttingDown = true;
        try { _cts?.Cancel(); } catch { /* already disposed */ }
        KillProcess();
        _cts?.Dispose();
    }

    // Both fire on abnormal teardown paths (ProcessExit on AppDomain
    // unload, CancelKeyPress on Ctrl+C before the Generic Host's own
    // handler races us). We latch _shuttingDown FIRST so the health
    // loop, if it's mid-restart, can't sneak a fresh spawn between
    // our kill and the host-level StopAsync that follows.
    //
    // We don't set e.Cancel on Ctrl+C — the Generic Host's handler
    // already does that and triggers IHostApplicationLifetime
    // shutdown, which calls our StopAsync. Suppressing the default
    // here would cause the runtime to never terminate on a second
    // Ctrl+C.
    private void OnProcessExit(object? sender, EventArgs e)
    {
        _shuttingDown = true;
        try { _cts?.Cancel(); } catch { /* shutting down */ }
        KillProcess();
    }

    private void OnCancelKeyPress(object? sender, ConsoleCancelEventArgs e)
    {
        _shuttingDown = true;
        try { _cts?.Cancel(); } catch { /* shutting down */ }
        KillProcess();
    }

    // ── Port conflict resolution (gateway port only) ────────────────
    //
    // This handles the gateway's own listening port. The workerd
    // backend has its own boot-time preflight for the workerd
    // subprocess sockets (8800..8807), gated by the
    // KillStaleWorkerd option — we don't duplicate that logic here.

    private static bool IsPortInUse(int port)
    {
        try
        {
            var listeners = IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpListeners();
            return listeners.Any(ep => ep.Port == port);
        }
        catch { return false; }
    }

    private void KillProcessOnPort(int port)
    {
        try
        {
            if (OperatingSystem.IsWindows())
            {
                var psi = new ProcessStartInfo
                {
                    FileName = "netstat",
                    Arguments = "-ano",
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    CreateNoWindow = true,
                };

                using var proc = Process.Start(psi);
                if (proc is null) return;
                string output = proc.StandardOutput.ReadToEnd();
                proc.WaitForExit(5000);

                foreach (string line in output.Split('\n'))
                {
                    string trimmed = line.Trim();
                    if (!trimmed.Contains($":{port}") || !trimmed.Contains("LISTENING")) continue;

                    string[] parts = trimmed.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                    if (parts.Length < 5) continue;

                    if (int.TryParse(parts[^1], out int pid) && pid > 0)
                    {
                        try
                        {
                            using var target = Process.GetProcessById(pid);
                            _logger.LogInformation("[1tube/{Slot}] Killing orphaned process on port {Port} (PID {Pid}: {Name})", _slot.Label, port, pid, target.ProcessName);
                            target.Kill(entireProcessTree: true);
                            target.WaitForExit(3000);
                        }
                        catch { /* already gone */ }
                        return;
                    }
                }
            }
            else
            {
                var psi = new ProcessStartInfo
                {
                    FileName = "fuser",
                    Arguments = $"{port}/tcp",
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    CreateNoWindow = true,
                };

                using var proc = Process.Start(psi);
                if (proc is null) return;
                string output = proc.StandardOutput.ReadToEnd().Trim();
                proc.WaitForExit(5000);

                foreach (string pidStr in output.Split(' ', StringSplitOptions.RemoveEmptyEntries))
                {
                    if (int.TryParse(pidStr, out int pid) && pid > 0)
                    {
                        try
                        {
                            using var target = Process.GetProcessById(pid);
                            _logger.LogInformation("[1tube/{Slot}] Killing orphaned process on port {Port} (PID {Pid}: {Name})", _slot.Label, port, pid, target.ProcessName);
                            target.Kill(entireProcessTree: true);
                            target.WaitForExit(3000);
                        }
                        catch { /* already gone */ }
                    }
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[1tube/{Slot}] Failed to clear port {Port}", _slot.Label, port);
        }
    }

    // ── Process spawning ────────────────────────────────────────────

    private bool ResolveBinariesIfNeeded()
    {
        if (_denoExe is null && ResolveDenoBinary() is null) return false;

        // Workerd is only required when actually running on workerd.
        // Resolving (and validating) it lazily means a Deno-backed
        // deploy doesn't need the binary on the host at all.
        if (_options.Backend == OneTubeBackend.Workerd && _workerdExe is null && ResolveWorkerdBinary() is null) return false;

        return true;
    }

    private string? ResolveDenoBinary()
    {
        if (_denoExe is not null) return _denoExe;

        _denoExe = BinaryResolver.Resolve(_options.DenoBinary, "deno", "Deno", _logger);
        if (_denoExe is not null)
        {
            _logger.LogInformation("[1tube/{Slot}] Resolved deno binary: {Path}", _slot.Label, _denoExe);
        }
        return _denoExe;
    }

    private string? ResolveWorkerdBinary()
    {
        if (_workerdExe is not null) return _workerdExe;

        _workerdExe = BinaryResolver.Resolve(_options.WorkerdBinary, "workerd", "Workerd", _logger);
        if (_workerdExe is not null)
        {
            _logger.LogInformation("[1tube/{Slot}] Resolved workerd binary: {Path}", _slot.Label, _workerdExe);
        }
        return _workerdExe;
    }

    private static async Task<GatewayBinaryVersion> ProbeBinaryVersionAsync(
        string name,
        string? path,
        string arguments,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return new GatewayBinaryVersion(name, null, null, "binary not resolved");
        }

        try
        {
            var startInfo = new ProcessStartInfo
            {
                FileName = path,
                Arguments = arguments,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
            };

            using var proc = Process.Start(startInfo);
            if (proc is null)
            {
                return new GatewayBinaryVersion(name, path, null, "failed to start process");
            }

            using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeoutCts.CancelAfter(TimeSpan.FromSeconds(5));

            string stdout = await proc.StandardOutput.ReadToEndAsync(timeoutCts.Token);
            string stderr = await proc.StandardError.ReadToEndAsync(timeoutCts.Token);
            await proc.WaitForExitAsync(timeoutCts.Token);

            string version = FirstNonEmptyLine(stdout) ?? FirstNonEmptyLine(stderr) ?? $"exit {proc.ExitCode}";
            string? error = proc.ExitCode == 0 ? null : FirstNonEmptyLine(stderr) ?? $"exit {proc.ExitCode}";
            return new GatewayBinaryVersion(name, path, version, error);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return new GatewayBinaryVersion(name, path, null, "version probe timed out");
        }
        catch (Exception ex)
        {
            return new GatewayBinaryVersion(name, path, null, ex.Message);
        }
    }

    private static string? FirstNonEmptyLine(string value)
    {
        using var reader = new StringReader(value);
        for (string? line = reader.ReadLine(); line is not null; line = reader.ReadLine())
        {
            line = line.Trim();
            if (line.Length > 0) return line;
        }

        return null;
    }

    private void SpawnProcess()
    {
        if (_shuttingDown || _permanentlyUnavailable) return;

        KillProcess();

        // The gateway sources are an operator/CI-managed runtime asset:
        // NuGet publish materializes OneTubeGateway/ next to the host, and
        // deployments may update that folder independently from OneTube.dll.
        var gatewayRoot = Path.Combine(AppContext.BaseDirectory, "OneTubeGateway");
        var serverScript = Path.Combine(gatewayRoot, "src", "server.ts");
        if (!File.Exists(serverScript))
        {
            _logger.LogError(
                "[1tube/{Slot}] gateway sources not found at {Path}. " +
                "Deploy OneTubeGateway/ next to the host output. It is a runtime asset " +
                "owned by package publish or operator/CI deployment, and may be updated " +
                "independently from OneTube.dll.",
                _slot.Label, serverScript);
            _permanentlyUnavailable = true;
            return;
        }

        if (!ResolveBinariesIfNeeded())
        {
            _permanentlyUnavailable = true;
            return;
        }

        if (IsPortInUse(_slot.Port))
        {
            _logger.LogWarning("[1tube/{Slot}] Port {Port} in use, killing orphaned process", _slot.Label, _slot.Port);
            KillProcessOnPort(_slot.Port);
            Thread.Sleep(500);

            if (IsPortInUse(_slot.Port))
            {
                StopOneTubeSlot(
                    $"gateway port {_slot.Port} is still in use after cleanup; not retrying in a loop",
                    null);
                return;
            }
        }

        var args = GatewayCommand.BuildArgs(_options, _slot, serverScript, _workerdExe);

        var startInfo = new ProcessStartInfo
        {
            FileName = _denoExe!,
            // cwd = the OneTubeGateway directory we just resolved so
            // Deno picks up the bundled deno.json (import map for
            // jsr:/npm: specifiers in the gateway sources). The
            // consumer's own deno.json (if any) is irrelevant here —
            // gateway resolution and host resolution are separate
            // concerns.
            WorkingDirectory = gatewayRoot,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };

        // ArgumentList preserves arguments verbatim — important for
        // paths with spaces. The legacy Arguments string would have
        // required manual quoting and is famously easy to get wrong.
        foreach (var a in args) startInfo.ArgumentList.Add(a);

        // Snapshot secrets at spawn time. A subsequent edit (after
        // this child has started) will not affect the running
        // process — the secrets watcher triggers a side-by-side
        // swap which spawns a fresh candidate and re-snapshots.
        var secretsSnapshot = _secretsProvider?.Invoke();
        foreach (var (key, value) in GatewayCommand.BuildEnvironment(_options, _slot, secretsSnapshot))
        {
            startInfo.Environment[key] = value;
        }
        var denoCacheDir = DenoCacheDir;
        startInfo.Environment["DENO_DIR"] = denoCacheDir;
        startInfo.Environment["DENO_NO_UPDATE_CHECK"] = "1";

        // Deno 2.9 enables a 24h "minimum dependency age" by default,
        // which makes a function that pins a freshly published npm
        // version fail to resolve. NPM_CONFIG_MIN_RELEASE_AGE is the
        // lowest explicit tier in Deno's precedence chain, so setting it
        // to 0 cancels ONLY that built-in default — a project's .npmrc,
        // deno.json `minimumDependencyAge`, or `--minimum-dependency-age`
        // still wins, as does anything an operator passed via EnvVars
        // (already layered into Environment above) or the parent process.
        if (!startInfo.Environment.ContainsKey("NPM_CONFIG_MIN_RELEASE_AGE") &&
            !startInfo.Environment.ContainsKey("npm_config_min_release_age"))
        {
            startInfo.Environment["NPM_CONFIG_MIN_RELEASE_AGE"] = "0";
        }

        try
        {
            Directory.CreateDirectory(denoCacheDir);
            _process = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
            _process.Exited += OnDenoProcessExited;
            _process.OutputDataReceived += (_, e) =>
            {
                if (e.Data is null) return;
                _logger.LogInformation("[1tube] {Line}", NormalizeGatewayLogLine(e.Data));
            };
            _process.ErrorDataReceived += (_, e) =>
            {
                if (e.Data is null) return;
                string line = NormalizeGatewayLogLine(e.Data);
                if (IsGatewayErrorLine(line))
                {
                    _logger.LogWarning("[1tube] {Line}", line);
                }
                else
                {
                    _logger.LogInformation("[1tube] {Line}", line);
                }
                // Keep a bounded tail so a permanent-failure exit can
                // re-print the gateway's own FATAL line(s) inline with
                // our "stopped restarting" announcement.
                if (!IsNoisyDenoProgressLine(line))
                {
                    lock (_stderrTailLock)
                    {
                        _stderrTail.Enqueue(line);
                        while (_stderrTail.Count > StderrTailCapacity) _stderrTail.Dequeue();
                    }
                }
            };
            _process.Start();
            _process.BeginOutputReadLine();
            _process.BeginErrorReadLine();

            _isRunning = true;
            _startedAt = DateTime.UtcNow;
            _consecutiveFailures = 0;
            _currentBackoffMs = 1000;

            lock (_stderrTailLock) _stderrTail.Clear();

            _logger.LogInformation(
                "[1tube/{Slot}] gateway started (PID {Pid}, backend={Backend}) on {Host}:{Port}",
                _slot.Label,
                _process.Id,
                _options.Backend == OneTubeBackend.Workerd ? "workerd" : "deno",
                _options.Host,
                _slot.Port);
        }
        catch (Exception ex)
        {
            _isRunning = false;
            StopOneTubeSlot($"failed to spawn gateway: {ex.Message}", null, ex);
        }
    }

    private static bool IsGatewayErrorLine(string line)
    {
        return line.Contains("FATAL", StringComparison.OrdinalIgnoreCase)
            || line.Contains("ERROR", StringComparison.OrdinalIgnoreCase)
            || line.Contains("Unhandled", StringComparison.OrdinalIgnoreCase)
            || line.Contains("panic", StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsNoisyDenoProgressLine(string line)
    {
        var trimmed = line.TrimStart();
        return trimmed.StartsWith("Download ", StringComparison.OrdinalIgnoreCase)
            || trimmed.StartsWith("Check ", StringComparison.OrdinalIgnoreCase)
            || trimmed.StartsWith("Initialize ", StringComparison.OrdinalIgnoreCase);
    }

    private static string NormalizeGatewayLogLine(string line)
    {
        var value = AnsiEscapeRegex.Replace(line, "");
        while (true)
        {
            var prefixStart = 0;
            while (prefixStart < value.Length && char.IsWhiteSpace(value[prefixStart]))
            {
                prefixStart++;
            }

            var prefixCandidate = value[prefixStart..];
            if (prefixCandidate.StartsWith("[workerd]", StringComparison.OrdinalIgnoreCase))
            {
                value = prefixCandidate["[workerd]".Length..].TrimStart();
                continue;
            }
            if (prefixCandidate.StartsWith("[1tube]", StringComparison.OrdinalIgnoreCase))
            {
                value = prefixCandidate["[1tube]".Length..].TrimStart();
                continue;
            }
            return value;
        }
    }

    private void OnDenoProcessExited(object? sender, EventArgs e)
    {
        // ExitCode is undefined if we triggered the exit ourselves
        // (KillProcess sets _process to null first). Read it once,
        // tolerantly — a missing code is treated like any other crash
        // and goes through the normal restart path.
        int? exitCode = null;
        try { exitCode = _process?.ExitCode; }
        catch (InvalidOperationException) { /* never started */ }
        catch (Exception) { /* race with disposal */ }

        _isRunning = false;

        if (_shuttingDown || _permanentlyUnavailable)
        {
            return;
        }

        // Exit-code contract: the gateway publishes 64 (USAGE) and 78
        // (CONFIG) to mean "stop respawning me". Anything else — clean
        // exit (0), generic crash (1), signal — is treated as transient
        // and the health loop will respawn with backoff. We do NOT use
        // any wall-clock heuristic here; the gateway is the authority
        // on what kind of failure it just suffered.
        bool permanent = exitCode is int code && IsPermanentExitCode(code);
        if (permanent)
        {
            StopOneTubeSlot(
                $"gateway exited with permanent-failure code {exitCode} (64=usage, 78=config)",
                exitCode);
            return;
        }

        if (_restartCount >= Math.Max(0, _options.MaxGatewayRestarts))
        {
            StopOneTubeSlot(
                $"gateway process exited with code {exitCode}; restart budget exhausted " +
                $"({_restartCount}/{Math.Max(0, _options.MaxGatewayRestarts)})",
                exitCode);
            return;
        }

        _logger.LogWarning(
            "[1tube/{Slot}] gateway process exited (code {ExitCode})",
            _slot.Label, exitCode);
    }

    private static bool IsPermanentExitCode(int code)
    {
        // Mirrors PERMANENT_EXIT_CODES in src/server.ts. Keep these in
        // sync — both sides are part of the public supervisor contract.
        return code == 64 /* EX_USAGE  */
            || code == 78 /* EX_CONFIG */;
    }

    private string RenderStderrTailForLog()
    {
        string[] snapshot;
        lock (_stderrTailLock) snapshot = _stderrTail.ToArray();
        if (snapshot.Length == 0) return string.Empty;

        var sb = new System.Text.StringBuilder();
        sb.AppendLine();
        sb.AppendLine($"  ── last {snapshot.Length} stderr line(s) from gateway ──");
        foreach (var line in snapshot) sb.Append("  | ").AppendLine(line);
        return sb.ToString();
    }

    private void StopOneTubeSlot(string reason, int? exitCode, Exception? exception = null)
    {
        _permanentlyUnavailable = true;
        _isRunning = false;

        try { _cts?.Cancel(); } catch { /* health loop may already be gone */ }
        KillProcess();

        var tail = RenderStderrTailForLog();
        if (exception is not null)
        {
            _logger.LogError(
                exception,
                "[1tube/{Slot}] OneTube gateway stopped: {Reason}. The ASP.NET host remains running; " +
                "flash new firmware or fix configuration, then restart/re-promote the gateway.{Tail}",
                _slot.Label, reason, tail);
            return;
        }

        _logger.LogError(
            "[1tube/{Slot}] OneTube gateway stopped: {Reason}. ExitCode={ExitCode}. " +
            "The ASP.NET host remains running; flash new firmware or fix configuration, " +
            "then restart/re-promote the gateway.{Tail}",
            _slot.Label, reason, exitCode, tail);
    }

    // ── Health monitoring ───────────────────────────────────────────

    private async Task HealthLoopAsync(CancellationToken ct)
    {
        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
        var healthHost = _options.Host == "0.0.0.0" ? "127.0.0.1" : _options.Host;
        var healthUrl = $"http://{healthHost}:{_slot.Port}/health";

        await Task.Delay(2000, ct);

        while (!ct.IsCancellationRequested)
        {
            try { await Task.Delay(_options.HealthCheckIntervalMs, ct); }
            catch (OperationCanceledException) { break; }

            if (_shuttingDown || _permanentlyUnavailable) break;

            if (_process is null || _process.HasExited)
            {
                await HandleFailureAndMaybeRestart(ct, "gateway process is not running");
                continue;
            }

            try
            {
                using var req = new HttpRequestMessage(HttpMethod.Get, healthUrl);
                // Forward INTERNAL_KEY so detailed-mode /health works.
                // The unauthenticated /health is also fine for liveness;
                // we set the header opportunistically so the response
                // includes the richer payload when available.
                if (!string.IsNullOrEmpty(_options.InternalKey))
                {
                    req.Headers.Add("Authorization", $"Bearer {_options.InternalKey}");
                }

                var response = await client.SendAsync(req, ct);
                if (response.IsSuccessStatusCode)
                {
                    _isRunning = true;
                    _consecutiveFailures = 0;
                    _currentBackoffMs = 1000;
                }
                else
                {
                    throw new HttpRequestException($"Health check returned {response.StatusCode}");
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _consecutiveFailures++;
                _logger.LogWarning("[1tube/{Slot}] Health check failed ({Count}/{Max}): {Msg}",
                    _slot.Label, _consecutiveFailures, _options.MaxConsecutiveFailures, ex.Message);

                if (_consecutiveFailures >= _options.MaxConsecutiveFailures)
                {
                    await HandleFailureAndMaybeRestart(
                        ct,
                        $"health check failed {_consecutiveFailures} consecutive time(s)");
                }
            }
        }
    }

    private async Task HandleFailureAndMaybeRestart(CancellationToken ct, string reason)
    {
        if (_shuttingDown || _permanentlyUnavailable) return;

        _isRunning = false;

        if (_restartCount >= Math.Max(0, _options.MaxGatewayRestarts))
        {
            StopOneTubeSlot(
                $"{reason}; restart budget exhausted " +
                $"({_restartCount}/{Math.Max(0, _options.MaxGatewayRestarts)})",
                null);
            return;
        }

        _restartCount++;

        _logger.LogInformation("[1tube/{Slot}] Restarting gateway (attempt #{Count}, backoff {Ms}ms)", _slot.Label, _restartCount, _currentBackoffMs);

        try { await Task.Delay(_currentBackoffMs, ct); }
        catch (OperationCanceledException) { return; }

        if (_shuttingDown || _permanentlyUnavailable) return;

        _currentBackoffMs = Math.Min(_currentBackoffMs * 2, MaxBackoffMs);
        SpawnProcess();
    }

    private void KillProcess()
    {
        if (_process is null) return;

        try
        {
            if (!_process.HasExited)
            {
                _process.Kill(entireProcessTree: true);
                _process.WaitForExit(3000);
            }
        }
        catch { /* process already gone */ }
        finally
        {
            _process.Dispose();
            _process = null;
        }
    }
}
