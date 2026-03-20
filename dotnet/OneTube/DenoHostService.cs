using System.Diagnostics;
using System.Net.NetworkInformation;
using System.Text.Json.Serialization;

namespace OneTube;

/// <summary>
/// Manages the lifecycle of the 1tube Deno gateway process.
/// Spawns on startup, monitors health, auto-restarts on crash.
/// Modeled on ScioBot's BunProcessService pattern.
/// </summary>
public sealed class DenoHostService : IHostedService, IDisposable
{
    private const int MaxBackoffMs = 30_000;

    private readonly OneTubeOptions _options;
    private readonly ILogger<DenoHostService> _logger;

    private Process? _process;
    private CancellationTokenSource? _cts;
    private Task? _healthLoop;
    private int _consecutiveFailures;
    private int _currentBackoffMs = 1000;
    private bool _permanentlyUnavailable;

    public static bool IsRunning { get; private set; }
    public static DateTime? StartedAt { get; private set; }
    public static int RestartCount { get; private set; }

    public DenoHostService(
        Microsoft.Extensions.Options.IOptions<OneTubeOptions> options,
        ILogger<DenoHostService> logger)
    {
        _options = options.Value;
        _logger = logger;
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        _cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);

        AppDomain.CurrentDomain.ProcessExit += OnProcessExit;
        Console.CancelKeyPress += OnCancelKeyPress;

        SpawnProcess();
        _healthLoop = Task.Run(() => HealthLoopAsync(_cts.Token), _cts.Token);
        return Task.CompletedTask;
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        AppDomain.CurrentDomain.ProcessExit -= OnProcessExit;
        Console.CancelKeyPress -= OnCancelKeyPress;

        _cts?.Cancel();

        if (_healthLoop is not null)
        {
            try { await _healthLoop; }
            catch (OperationCanceledException) { }
        }

        KillProcess();
        IsRunning = false;
    }

    public void Dispose()
    {
        KillProcess();
        _cts?.Dispose();
    }

    private void OnProcessExit(object? sender, EventArgs e) => KillProcess();
    private void OnCancelKeyPress(object? sender, ConsoleCancelEventArgs e) => KillProcess();

    // ── Port conflict resolution ──

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
                            _logger.LogInformation("Killing orphaned process on port {Port} (PID {Pid}: {Name})", port, pid, target.ProcessName);
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
                            _logger.LogInformation("Killing orphaned process on port {Port} (PID {Pid}: {Name})", port, pid, target.ProcessName);
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
            _logger.LogWarning(ex, "Failed to clear port {Port}", port);
        }
    }

    // ── Process spawning ──

    private void SpawnProcess()
    {
        if (_permanentlyUnavailable) return;

        KillProcess();

        var serverScript = Path.Combine(_options.ProjectPath, "src", "server.ts");
        if (!File.Exists(serverScript))
        {
            _logger.LogError("1tube server script not found: {Path}", serverScript);
            _permanentlyUnavailable = true;
            return;
        }

        string? denoExe = null;
        if (File.Exists(_options.DenoBinary))
        {
            denoExe = _options.DenoBinary;
        }
        else
        {
            try
            {
                using var which = Process.Start(new ProcessStartInfo
                {
                    FileName = OperatingSystem.IsWindows() ? "where" : "which",
                    Arguments = "deno",
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    CreateNoWindow = true,
                });
                which?.WaitForExit(3000);
                if (which?.ExitCode == 0) denoExe = "deno";
            }
            catch { /* where/which not available */ }
        }

        if (denoExe is null)
        {
            _logger.LogError("Deno binary not found (checked {Path} and PATH)", _options.DenoBinary);
            _permanentlyUnavailable = true;
            return;
        }

        if (IsPortInUse(_options.Port))
        {
            _logger.LogWarning("Port {Port} in use, killing orphaned process", _options.Port);
            KillProcessOnPort(_options.Port);
            Thread.Sleep(500);

            if (IsPortInUse(_options.Port))
            {
                _logger.LogError("Port {Port} still in use after cleanup", _options.Port);
                return;
            }
        }

        var startInfo = new ProcessStartInfo
        {
            FileName = denoExe,
            Arguments = $"run --allow-all \"{serverScript}\" --functions \"{_options.FunctionsPath}\" --port {_options.Port}",
            WorkingDirectory = _options.ProjectPath,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };

        startInfo.Environment["PORT"] = _options.Port.ToString();
        startInfo.Environment["FUNCTIONS_PATH"] = _options.FunctionsPath;
        foreach (var (key, value) in _options.EnvVars)
        {
            startInfo.Environment[key] = value;
        }

        try
        {
            _process = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
            _process.Exited += OnDenoProcessExited;
            _process.OutputDataReceived += (_, e) => { if (e.Data != null) _logger.LogInformation("[deno] {Line}", e.Data); };
            _process.ErrorDataReceived += (_, e) => { if (e.Data != null) _logger.LogWarning("[deno] {Line}", e.Data); };
            _process.Start();
            _process.BeginOutputReadLine();
            _process.BeginErrorReadLine();

            IsRunning = true;
            StartedAt = DateTime.UtcNow;
            _consecutiveFailures = 0;
            _currentBackoffMs = 1000;

            _logger.LogInformation("1tube Deno gateway started (PID {Pid}) on port {Port}", _process.Id, _options.Port);
        }
        catch (Exception ex)
        {
            IsRunning = false;
            _logger.LogError(ex, "Failed to spawn Deno gateway");
        }
    }

    private void OnDenoProcessExited(object? sender, EventArgs e)
    {
        var exitCode = _process?.ExitCode;
        IsRunning = false;
        _logger.LogWarning("Deno gateway process exited (code {ExitCode})", exitCode);
    }

    // ── Health monitoring ──

    private async Task HealthLoopAsync(CancellationToken ct)
    {
        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
        var healthUrl = $"http://localhost:{_options.Port}/health";

        await Task.Delay(2000, ct);

        while (!ct.IsCancellationRequested)
        {
            try { await Task.Delay(_options.HealthCheckIntervalMs, ct); }
            catch (OperationCanceledException) { break; }

            if (_permanentlyUnavailable) break;

            if (_process is null || _process.HasExited)
            {
                await HandleFailureAndRestart(ct);
                continue;
            }

            try
            {
                var response = await client.GetAsync(healthUrl, ct);
                if (response.IsSuccessStatusCode)
                {
                    IsRunning = true;
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
                _logger.LogWarning("Health check failed ({Count}/{Max}): {Msg}",
                    _consecutiveFailures, _options.MaxConsecutiveFailures, ex.Message);

                if (_consecutiveFailures >= _options.MaxConsecutiveFailures)
                {
                    await HandleFailureAndRestart(ct);
                }
            }
        }
    }

    private async Task HandleFailureAndRestart(CancellationToken ct)
    {
        if (_permanentlyUnavailable) return;

        IsRunning = false;
        RestartCount++;

        _logger.LogInformation("Restarting Deno gateway (attempt #{Count}, backoff {Ms}ms)", RestartCount, _currentBackoffMs);

        try { await Task.Delay(_currentBackoffMs, ct); }
        catch (OperationCanceledException) { return; }

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
