using System.Diagnostics;
using System.Net.NetworkInformation;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
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
    GatewayBinaryVersion Bun,
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
/// itself always runs on Bun (<c>bun src/server.ts</c>); when
/// <see cref="OneTubeOptions.Backend"/> is
/// <see cref="OneTubeBackend.Workerd"/> the gateway spawns workerd as
/// its own subprocess, which we point at via <c>--workerd-bin</c>.
///
/// One <see cref="GatewayHostService"/> instance owns one Bun child
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
///   <item><description>Install the bundled gateway's own npm dependencies (<c>bun install --frozen-lockfile --production</c> in <c>OneTubeGateway/</c>) once per gateway content.</description></item>
///   <item><description>Spawn bun with the full CLI surface from <see cref="OneTubeOptions"/> + slot.</description></item>
///   <item><description>Tail stdout/stderr into the host logger (tagged with the slot label).</description></item>
///   <item><description>Periodically poll <c>/health</c>, then stop the 1tube slot on unrecoverable failure while leaving the host alive.</description></item>
///   <item><description>Kill the child cleanly on host shutdown / Ctrl+C / process-exit.</description></item>
/// </list>
///
/// State is per-instance — there is no static shared between two
/// slots (the one exception is the lock serializing the dependency
/// install, since both slots run from the same <c>OneTubeGateway/</c>).
/// </summary>
public class GatewayHostService : IHostedService, IGatewayHost, IDisposable
{
    private const int MaxBackoffMs = 30_000;
    private static readonly Regex AnsiEscapeRegex = new(@"\x1B\[[0-?]*[ -/]*[@-~]", RegexOptions.Compiled);

    /// <summary>
    /// Exit-code contract published by the gateway (see
    /// <c>src/server.ts</c> — <c>EXIT_CODES</c> /
    /// <c>PERMANENT_EXIT_CODES</c>, which points back here). The
    /// supervisor uses these to decide whether a failure is permanent
    /// (the gateway told us "my config is wrong, retrying won't help")
    /// or transient (an actual crash worth restarting). We do
    /// <em>not</em> guess based on timing — the gateway is the
    /// authority on what kind of failure it just suffered.
    /// <list type="bullet">
    ///   <item><description><c>0</c> OK — clean shutdown.</description></item>
    ///   <item><description><c>1</c> CRASH — generic runtime crash (transient).</description></item>
    ///   <item><description><c>64</c> EX_USAGE — bad CLI args (permanent).</description></item>
    ///   <item><description><c>78</c> EX_CONFIG — missing/invalid required env or manifest (permanent).</description></item>
    /// </list>
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

    /// <summary>
    /// Upper bound for the one-time <c>bun install</c> of the bundled
    /// gateway's own dependencies. A cold install is a few seconds;
    /// the cap only exists so a wedged registry can't hang host startup
    /// forever.
    /// </summary>
    private static readonly TimeSpan GatewayInstallTimeout = TimeSpan.FromMinutes(5);

    /// <summary>
    /// Written into <c>OneTubeGateway/node_modules/</c> after a
    /// successful install. Holds a fingerprint of <c>package.json</c> +
    /// <c>bun.lock</c> + the host RID, so a redeployed gateway (new
    /// lockfile) or a tree copied across platforms (esbuild ships a
    /// per-platform binary) re-installs, and an unchanged one skips the
    /// install entirely.
    /// </summary>
    private const string GatewayInstallStampFile = ".onetube-install-stamp";

    /// <summary>
    /// Active and candidate slots share one <c>OneTubeGateway/</c>
    /// directory; serialize the install so two concurrent spawns can't
    /// both write <c>node_modules</c>.
    /// </summary>
    private static readonly object GatewayInstallLock = new();

    private readonly OneTubeOptions _options;
    private readonly GatewaySlot _slot;
    private readonly ILogger<GatewayHostService> _logger;

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
    private string? _bunExe;
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
    /// <see cref="GatewayHostService(OneTubeOptions, GatewaySlot, ILogger{GatewayHostService}, Func{IReadOnlyDictionary{string, string}?}?)"/>
    /// overload to create candidate slots on demand.
    /// </summary>
    public GatewayHostService(
        Microsoft.Extensions.Options.IOptions<OneTubeOptions> options,
        ILogger<GatewayHostService> logger)
        : this(options.Value, new GatewaySlot("active", options.Value.Port), logger, secretsProvider: null)
    {
    }

    public GatewayHostService(
        OneTubeOptions options,
        GatewaySlot slot,
        ILogger<GatewayHostService> logger,
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
        var bunPath = ResolveBunBinary();
        var workerdPath = ResolveWorkerdBinary();
        return new GatewayBinaryDiagnostics(
            await ProbeBinaryVersionAsync("bun", bunPath, "--version", cancellationToken),
            await ProbeBinaryVersionAsync("workerd", workerdPath, "--version", cancellationToken));
    }

    public void InvalidateBinaryCache()
    {
        _bunExe = null;
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
            BunPath: ResolveBunBinary(),
            GatewayRoot: Path.Combine(AppContext.BaseDirectory, "OneTubeGateway"),
            DataRoot: dataRoot,
            DiagnosticsDir: diagDir,
            ExperimentsDir: experimentsDir,
            BunCacheDir: BunCacheDir,
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
        // for the bun cache — guaranteed writable by the host
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

    /// <summary>
    /// Host-owned Bun install cache (<c>BUN_INSTALL_CACHE_DIR</c>).
    /// Keeps package downloads off the service identity's home dir,
    /// which on IIS / service accounts is often missing or read-only.
    /// </summary>
    private string BunCacheDir => Path.Combine(ResolveRuntimeDataRoot(), "onetube", "bun-cache");

    /// <summary>
    /// Host-owned runtime transpiler cache
    /// (<c>BUN_RUNTIME_TRANSPILER_CACHE_PATH</c>), for the same reason.
    /// </summary>
    private string BunTranspilerCacheDir => Path.Combine(ResolveRuntimeDataRoot(), "onetube", "bun-transpiler-cache");

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
        if (_bunExe is null && ResolveBunBinary() is null) return false;

        // Workerd is only required when actually running on workerd.
        // Resolving (and validating) it lazily means a Bun-backed
        // deploy doesn't need the binary on the host at all.
        if (_options.Backend == OneTubeBackend.Workerd && _workerdExe is null && ResolveWorkerdBinary() is null) return false;

        return true;
    }

    private string? ResolveBunBinary()
    {
        if (_bunExe is not null) return _bunExe;

        var configured = GatewayCommand.SelectBunBinary(_options, out var ignoredLegacy);
        if (ignoredLegacy is not null)
        {
            _logger.LogWarning(
                "[1tube/{Slot}] OneTubeOptions.DenoBinary ({Path}) is obsolete and ignored — the gateway runs on Bun now. " +
                "Set OneTubeOptions.BunBinary (or put bun on PATH).",
                _slot.Label, ignoredLegacy);
        }

        _bunExe = BinaryResolver.Resolve(configured, "bun", "Bun", _logger);
        if (_bunExe is not null)
        {
            _logger.LogInformation("[1tube/{Slot}] Resolved bun binary: {Path}", _slot.Label, _bunExe);
        }
        return _bunExe;
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

        if (!EnsureGatewayDependencies(gatewayRoot))
        {
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
            FileName = _bunExe!,
            // cwd = the OneTubeGateway directory we just resolved. The
            // gateway's own imports (hono, drizzle-orm, esbuild, …)
            // resolve from OneTubeGateway/node_modules by walking up
            // from src/ regardless of cwd; keeping cwd here just means
            // nothing the gateway defaults relative to cwd lands in the
            // host's arbitrary launch directory. Every host-configured
            // path is passed absolute anyway.
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
        ApplyBunCacheEnvironment(startInfo);

        try
        {
            // The managed npm:/jsr: store for the functions' own
            // dependencies. The gateway creates it on first install, but
            // creating it up front surfaces a permission problem here,
            // with a clear host-side stack, instead of mid-boot.
            Directory.CreateDirectory(GatewayCommand.ResolveDepsDir(_options));
            _process = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
            _process.Exited += OnGatewayProcessExited;
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
                // our "stopped restarting" announcement. (No progress-
                // line filter needed: unlike Deno's "Download …" spam,
                // the gateway runs its `bun install`s with piped output
                // and only logs a one-line summary.)
                lock (_stderrTailLock)
                {
                    _stderrTail.Enqueue(line);
                    while (_stderrTail.Count > StderrTailCapacity) _stderrTail.Dequeue();
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
                GatewayCommand.BackendName(_options.Backend),
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

    /// <summary>
    /// Point Bun's install + transpiler caches at host-owned dirs under
    /// the data root (the Deno-era equivalent was <c>DENO_DIR</c>). An
    /// operator who wants them elsewhere sets the same variables via
    /// <see cref="OneTubeOptions.EnvVars"/>, which wins.
    /// </summary>
    private void ApplyBunCacheEnvironment(ProcessStartInfo startInfo)
    {
        if (!_options.EnvVars.ContainsKey("BUN_INSTALL_CACHE_DIR"))
        {
            Directory.CreateDirectory(BunCacheDir);
            startInfo.Environment["BUN_INSTALL_CACHE_DIR"] = BunCacheDir;
        }
        if (!_options.EnvVars.ContainsKey("BUN_RUNTIME_TRANSPILER_CACHE_PATH"))
        {
            Directory.CreateDirectory(BunTranspilerCacheDir);
            startInfo.Environment["BUN_RUNTIME_TRANSPILER_CACHE_PATH"] = BunTranspilerCacheDir;
        }
    }

    /// <summary>
    /// Make sure the bundled gateway can resolve its own npm
    /// dependencies (hono, drizzle-orm, esbuild, es-module-lexer,
    /// @zip.js/zip.js). The NuGet package ships <c>package.json</c> +
    /// <c>bun.lock</c> next to <c>src/</c> but no <c>node_modules</c>:
    /// esbuild's binary is per-platform, so a prebuilt tree would only
    /// work on the platform it was packed on. Instead we run
    /// <c>bun install --frozen-lockfile --production</c> in
    /// <c>OneTubeGateway/</c> once — the lockfile pins exact versions,
    /// so every host gets the tree CI tested — and stamp the result so
    /// later spawns (restarts, firmware candidates) skip it.
    ///
    /// <para>Air-gapped or read-only deployments can run the same
    /// command in <c>OneTubeGateway/</c> at deploy time; when the
    /// install fails but a <c>node_modules</c> already exists we warn
    /// and use it as-is.</para>
    ///
    /// <para>Returns <c>false</c> (and stops the slot) only when there
    /// is nothing to run with. Like any other stop, the next
    /// <see cref="StartAsync"/> / <see cref="RecycleAsync"/> retries, so
    /// a transient registry outage heals without a host restart.</para>
    /// </summary>
    private bool EnsureGatewayDependencies(string gatewayRoot)
    {
        var packageJson = Path.Combine(gatewayRoot, "package.json");
        var lockfile = Path.Combine(gatewayRoot, "bun.lock");
        var nodeModules = Path.Combine(gatewayRoot, "node_modules");
        var stampPath = Path.Combine(nodeModules, GatewayInstallStampFile);

        if (!File.Exists(packageJson))
        {
            StopOneTubeSlot(
                $"gateway package.json not found at {packageJson}; OneTubeGateway/ must contain " +
                "src/, drizzle/, package.json and bun.lock",
                null);
            return false;
        }

        lock (GatewayInstallLock)
        {
            string fingerprint;
            try
            {
                fingerprint = ComputeInstallFingerprint(packageJson, lockfile);
                if (File.Exists(stampPath) && File.ReadAllText(stampPath).Trim() == fingerprint)
                {
                    return true;
                }
            }
            catch (Exception ex)
            {
                StopOneTubeSlot($"failed to read gateway package manifest: {ex.Message}", null, ex);
                return false;
            }

            var hasLockfile = File.Exists(lockfile);
            if (!hasLockfile)
            {
                _logger.LogWarning(
                    "[1tube/{Slot}] {Lockfile} is missing; installing gateway dependencies without a frozen lockfile",
                    _slot.Label, lockfile);
            }

            var startInfo = new ProcessStartInfo
            {
                FileName = _bunExe!,
                WorkingDirectory = gatewayRoot,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
            };
            startInfo.ArgumentList.Add("install");
            if (hasLockfile) startInfo.ArgumentList.Add("--frozen-lockfile");
            // --production: the shipped package.json is 1tube's own, so
            // skip its devDependencies (typescript, drizzle-kit, …).
            // --ignore-scripts: never run the package's own lifecycle
            // scripts on a production host.
            startInfo.ArgumentList.Add("--production");
            startInfo.ArgumentList.Add("--ignore-scripts");
            startInfo.ArgumentList.Add("--no-progress");
            foreach (var (key, value) in _options.EnvVars)
            {
                // Lets operators point at a private registry/mirror
                // (BUN_CONFIG_REGISTRY, NPM_CONFIG_REGISTRY, …).
                startInfo.Environment[key] = value;
            }
            ApplyBunCacheEnvironment(startInfo);

            _logger.LogInformation(
                "[1tube/{Slot}] Installing gateway dependencies in {Dir} (bun {Args})",
                _slot.Label, gatewayRoot, string.Join(' ', startInfo.ArgumentList));

            var output = new System.Text.StringBuilder();
            int? exitCode = null;
            string? error = null;
            var sw = Stopwatch.StartNew();
            try
            {
                using var proc = new Process { StartInfo = startInfo };
                proc.OutputDataReceived += (_, e) => { if (e.Data is not null) lock (output) output.AppendLine(e.Data); };
                proc.ErrorDataReceived += (_, e) => { if (e.Data is not null) lock (output) output.AppendLine(e.Data); };
                proc.Start();
                proc.BeginOutputReadLine();
                proc.BeginErrorReadLine();
                if (proc.WaitForExit(GatewayInstallTimeout))
                {
                    // Parameterless WaitForExit drains the async readers.
                    proc.WaitForExit();
                    exitCode = proc.ExitCode;
                }
                else
                {
                    try { proc.Kill(entireProcessTree: true); } catch { /* race */ }
                    error = $"timed out after {GatewayInstallTimeout.TotalSeconds:0}s";
                }
            }
            catch (Exception ex)
            {
                error = ex.Message;
            }

            string installLog;
            lock (output) installLog = AnsiEscapeRegex.Replace(output.ToString(), "").Trim();

            if (exitCode == 0)
            {
                try
                {
                    File.WriteAllText(stampPath, fingerprint);
                }
                catch (Exception ex)
                {
                    // Install worked; we'll just re-run it (cheap no-op)
                    // next spawn.
                    _logger.LogWarning(ex, "[1tube/{Slot}] Could not write {Stamp}", _slot.Label, stampPath);
                }
                _logger.LogInformation(
                    "[1tube/{Slot}] Gateway dependencies installed in {Ms}ms",
                    _slot.Label, sw.ElapsedMilliseconds);
                return true;
            }

            var reason = error ?? $"bun install exited with code {exitCode}";
            if (Directory.Exists(nodeModules))
            {
                _logger.LogWarning(
                    "[1tube/{Slot}] Gateway dependency install failed ({Reason}); using the existing {Dir} as-is.{NewLine}{Output}",
                    _slot.Label, reason, nodeModules, Environment.NewLine, installLog);
                return true;
            }

            StopOneTubeSlot(
                $"could not install gateway dependencies in {gatewayRoot} ({reason}). " +
                "Make sure the host can reach the npm registry and OneTubeGateway/ is writable, " +
                "or run `bun install --frozen-lockfile --production` there at deploy time." +
                (installLog.Length > 0 ? Environment.NewLine + installLog : ""),
                null);
            return false;
        }
    }

    private static string ComputeInstallFingerprint(string packageJson, string lockfile)
    {
        using var sha = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        sha.AppendData(File.ReadAllBytes(packageJson));
        if (File.Exists(lockfile)) sha.AppendData(File.ReadAllBytes(lockfile));
        sha.AppendData(System.Text.Encoding.UTF8.GetBytes(RuntimeInformation.RuntimeIdentifier));
        return Convert.ToHexString(sha.GetHashAndReset());
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

    private void OnGatewayProcessExited(object? sender, EventArgs e)
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

/// <summary>
/// Pre-Bun name of <see cref="GatewayHostService"/>, kept so existing
/// <c>new DenoHostService(...)</c> call sites still compile. It is a
/// plain subclass, not a DI alias: <c>AddOneTube</c> registers the
/// active slot as <see cref="GatewayHostService"/> (and
/// <see cref="IGatewayHost"/>) only, so code that resolved
/// <c>DenoHostService</c> from the container must switch to
/// <see cref="GatewayHostService"/>.
/// </summary>
[Obsolete("Renamed to GatewayHostService (the gateway runs on Bun now). AddOneTube registers the active slot as GatewayHostService / IGatewayHost; resolve that instead.")]
public sealed class DenoHostService : GatewayHostService
{
    public DenoHostService(
        Microsoft.Extensions.Options.IOptions<OneTubeOptions> options,
        ILogger<DenoHostService> logger)
        : base(options.Value, new GatewaySlot("active", options.Value.Port), logger, secretsProvider: null)
    {
    }

    public DenoHostService(
        OneTubeOptions options,
        GatewaySlot slot,
        ILogger<DenoHostService> logger,
        Func<IReadOnlyDictionary<string, string>?>? secretsProvider = null)
        : base(options, slot, logger, secretsProvider)
    {
    }
}
