using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Logging;

namespace OneTube.Diagnostics;

/// <summary>
/// Declarative description of a process to spawn for diagnostic
/// purposes. Loaded either from the built-in catalog (so the page
/// is useful out of the box) or from JSON files dropped into
/// <c>{DataRoot}/onetube/experiments/*.json</c> by the operator —
/// the latter is the iteration loop the user explicitly asked for:
/// edit the gateway TS in <c>OneTubeGateway/</c>, tweak/clone an
/// experiment JSON, hit Run, no host rebuild needed.
///
/// All free-form string fields support <c>${TOKEN}</c> expansion.
/// The expansion table is owned by <see cref="ExperimentRunner"/>
/// and resolved at run time, never at load time, so a token like
/// <c>${ActiveCapnp}</c> picks up whatever the current firmware
/// generation is when the operator presses Run.
/// </summary>
public sealed class ExperimentSpec
{
    [JsonPropertyName("id")] public string Id { get; init; } = "";
    [JsonPropertyName("name")] public string Name { get; init; } = "";
    [JsonPropertyName("description")] public string? Description { get; init; }
    [JsonPropertyName("executable")] public string Executable { get; init; } = "";
    [JsonPropertyName("args")] public List<string> Args { get; init; } = [];
    [JsonPropertyName("cwd")] public string? Cwd { get; init; }
    [JsonPropertyName("env")] public Dictionary<string, string>? Env { get; init; }
    [JsonPropertyName("timeoutSec")] public int TimeoutSec { get; init; } = 10;
    [JsonPropertyName("source")] public string Source { get; init; } = "builtin";

    /// <summary>
    /// True if this experiment is expected to run forever (e.g. a
    /// daemon like workerd). The runner kills it after the timeout
    /// and reports <c>Killed=true</c> as the success signal — without
    /// this hint, an exit code of 0 would otherwise be treated as the
    /// only success state.
    /// </summary>
    [JsonPropertyName("daemon")] public bool Daemon { get; init; }
}

public sealed record ExperimentResult(
    string Id,
    string Name,
    string Executable,
    string ResolvedExecutable,
    IReadOnlyList<string> Args,
    string Cwd,
    IReadOnlyDictionary<string, string> Env,
    int? ExitCode,
    bool TimedOut,
    bool Killed,
    long DurationMs,
    string Stdout,
    string Stderr,
    string? Error);

public sealed class ExperimentRunner
{
    private readonly ILogger<ExperimentRunner> _logger;

    public ExperimentRunner(ILogger<ExperimentRunner> logger)
    {
        _logger = logger;
    }

    public IReadOnlyDictionary<string, string> BuildTokens(ExperimentContext ctx)
    {
        // Single source of truth for token expansion. Adding one here
        // makes it usable from every experiment (built-in or operator-
        // authored) without touching the runner.
        var tokens = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["WorkerdPath"] = ctx.WorkerdPath ?? "",
            ["DenoPath"] = ctx.DenoPath ?? "",
            ["GatewayRoot"] = ctx.GatewayRoot,
            ["ServerScript"] = Path.Combine(ctx.GatewayRoot, "src", "server.ts"),
            ["DataRoot"] = ctx.DataRoot,
            ["DiagDir"] = ctx.DiagnosticsDir,
            ["DenoCache"] = ctx.DenoCacheDir,
            ["ProbeCapnp"] = Path.Combine(ctx.DiagnosticsDir, "workerd-probe.capnp"),
            ["ActiveCapnp"] = ctx.ActiveCapnpPath ?? "",
            ["RandomPort"] = ctx.RandomPort1.ToString(),
            ["RandomPort2"] = ctx.RandomPort2.ToString(),
            ["BaseDir"] = AppContext.BaseDirectory,
        };
        return tokens;
    }

    public IReadOnlyList<ExperimentSpec> Discover(ExperimentContext ctx)
    {
        var list = new List<ExperimentSpec>(BuiltinExperiments());

        try
        {
            Directory.CreateDirectory(ctx.ExperimentsDir);
            foreach (var path in Directory.EnumerateFiles(ctx.ExperimentsDir, "*.json").OrderBy(p => p, StringComparer.Ordinal))
            {
                try
                {
                    var json = File.ReadAllText(path);
                    var spec = JsonSerializer.Deserialize<ExperimentSpec>(json, JsonOptions);
                    if (spec is null) continue;
                    var resolved = new ExperimentSpec
                    {
                        Id = string.IsNullOrWhiteSpace(spec.Id) ? Path.GetFileNameWithoutExtension(path) : spec.Id,
                        Name = string.IsNullOrWhiteSpace(spec.Name) ? Path.GetFileNameWithoutExtension(path) : spec.Name,
                        Description = spec.Description,
                        Executable = spec.Executable,
                        Args = spec.Args,
                        Cwd = spec.Cwd,
                        Env = spec.Env,
                        TimeoutSec = spec.TimeoutSec <= 0 ? 10 : spec.TimeoutSec,
                        Daemon = spec.Daemon,
                        Source = $"file:{Path.GetFileName(path)}",
                    };
                    // Disk experiments override built-ins by id —
                    // operator wins if the names clash.
                    list.RemoveAll(x => string.Equals(x.Id, resolved.Id, StringComparison.OrdinalIgnoreCase));
                    list.Add(resolved);
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "[1tube] failed to load experiment {Path}", path);
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[1tube] failed to enumerate experiments at {Path}", ctx.ExperimentsDir);
        }

        return list;
    }

    public async Task<ExperimentResult> RunAsync(
        ExperimentSpec spec,
        ExperimentContext ctx,
        CancellationToken cancellationToken)
    {
        var sw = Stopwatch.StartNew();
        var tokens = BuildTokens(ctx);

        string executable = ExpandTokens(spec.Executable, tokens);
        var args = spec.Args.Select(a => ExpandTokens(a, tokens)).ToList();
        string cwd = string.IsNullOrWhiteSpace(spec.Cwd)
            ? ctx.DiagnosticsDir
            : ExpandTokens(spec.Cwd, tokens);
        Directory.CreateDirectory(cwd);

        var env = new Dictionary<string, string>(StringComparer.Ordinal);
        if (spec.Env is not null)
        {
            foreach (var (k, v) in spec.Env) env[k] = ExpandTokens(v, tokens);
        }

        if (string.IsNullOrWhiteSpace(executable))
        {
            sw.Stop();
            return new ExperimentResult(
                spec.Id, spec.Name, spec.Executable, executable, args, cwd, env,
                ExitCode: null, TimedOut: false, Killed: false,
                DurationMs: sw.ElapsedMilliseconds, Stdout: "", Stderr: "",
                Error: "executable was empty after token expansion (was " + spec.Executable + ")");
        }
        // Bare executable names (powershell.exe, cmd.exe, deno) live
        // on PATH, not as absolute paths — resolve them ourselves so
        // template authors don't have to hard-code C:\Windows\System32
        // paths everywhere. We only do PATH lookup when the user
        // didn't supply a directory separator; absolute/relative paths
        // are checked literally and reported clearly if missing.
        if (!Path.IsPathRooted(executable) && !executable.Contains(Path.DirectorySeparatorChar) && !executable.Contains(Path.AltDirectorySeparatorChar))
        {
            executable = ResolveOnPath(executable) ?? executable;
        }
        if (!File.Exists(executable))
        {
            sw.Stop();
            return new ExperimentResult(
                spec.Id, spec.Name, spec.Executable, executable, args, cwd, env,
                ExitCode: null, TimedOut: false, Killed: false,
                DurationMs: sw.ElapsedMilliseconds, Stdout: "", Stderr: "",
                Error: $"executable not found on disk or PATH: {executable}");
        }

        // Detect args that started life as a single ${TOKEN} but
        // expanded to empty. This is the "no firmware flashed yet,
        // ${ActiveCapnp} is null" trap — without this guard workerd
        // would receive an empty positional arg and silently treat
        // its cwd as the input file, producing a cryptic CreateFile
        // OPEN_EXISTING failure.
        var emptyTokens = new List<string>();
        for (int i = 0; i < spec.Args.Count; i++)
        {
            var raw = spec.Args[i];
            if (raw.StartsWith("${", StringComparison.Ordinal) && raw.EndsWith('}') &&
                raw.IndexOf("${", 2, StringComparison.Ordinal) < 0 &&
                string.IsNullOrEmpty(args[i]))
            {
                emptyTokens.Add(raw);
            }
        }
        if (emptyTokens.Count > 0)
        {
            sw.Stop();
            return new ExperimentResult(
                spec.Id, spec.Name, spec.Executable, executable, args, cwd, env,
                ExitCode: null, TimedOut: false, Killed: false,
                DurationMs: sw.ElapsedMilliseconds, Stdout: "", Stderr: "",
                Error: "Token(s) expanded to empty string: " + string.Join(", ", emptyTokens) +
                       ". For ${ActiveCapnp} this means no firmware has been flashed yet — flash a firmware first or pick a different experiment.");
        }

        // Auto-materialize the minimal capnp probe if the experiment
        // references it — keeps the user's experiment JSON minimal
        // ("just point at ${ProbeCapnp}").
        var probeCapnp = Path.Combine(ctx.DiagnosticsDir, "workerd-probe.capnp");
        if (args.Any(a => string.Equals(a, probeCapnp, StringComparison.OrdinalIgnoreCase)) && !File.Exists(probeCapnp))
        {
            await File.WriteAllTextAsync(probeCapnp, MinimalProbeCapnp.Replace("__PORT__", ctx.RandomPort1.ToString()), cancellationToken);
        }

        var startInfo = new ProcessStartInfo
        {
            FileName = executable,
            WorkingDirectory = cwd,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        foreach (var a in args) startInfo.ArgumentList.Add(a);
        foreach (var (k, v) in env) startInfo.Environment[k] = v;

        var stdout = new StringBuilder();
        var stderr = new StringBuilder();
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
                return new ExperimentResult(
                    spec.Id, spec.Name, spec.Executable, executable, args, cwd, env,
                    ExitCode: null, TimedOut: false, Killed: false,
                    DurationMs: sw.ElapsedMilliseconds, Stdout: "", Stderr: "",
                    Error: "Process.Start returned null");
            }

            proc.OutputDataReceived += (_, e) => { if (e.Data is not null) lock (stdout) stdout.AppendLine(e.Data); };
            proc.ErrorDataReceived += (_, e) => { if (e.Data is not null) lock (stderr) stderr.AppendLine(e.Data); };
            proc.BeginOutputReadLine();
            proc.BeginErrorReadLine();

            using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeoutCts.CancelAfter(TimeSpan.FromSeconds(Math.Clamp(spec.TimeoutSec, 1, 120)));

            try { await proc.WaitForExitAsync(timeoutCts.Token); }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested) { timedOut = true; }

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

        return new ExperimentResult(
            spec.Id, spec.Name, spec.Executable, executable, args, cwd, env,
            ExitCode: exitCode,
            TimedOut: timedOut,
            Killed: killed,
            DurationMs: sw.ElapsedMilliseconds,
            Stdout: stdout.ToString(),
            Stderr: stderr.ToString(),
            Error: error);
    }

    public void EnsureStarterFiles(ExperimentContext ctx)
    {
        // Drop ready-to-edit JSON templates next to the operator-
        // authored ones, so the iteration loop is "pick a starter,
        // tweak, save, run". We never overwrite — once the operator
        // touches a file we leave it alone forever.
        //
        // The page calls Discover() (which calls us) on init AND on
        // every catalog refresh / experiment run, and the HTTP API
        // does the same — so two threads can race past the existence
        // check and both try to create the same file. FileMode.CreateNew
        // is the atomic primitive: exactly one thread wins, the loser
        // gets IOException and we treat that as "already exists".
        try { Directory.CreateDirectory(ctx.ExperimentsDir); }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[1tube] failed to create experiments dir at {Path}", ctx.ExperimentsDir);
            return;
        }

        foreach (var (filename, body) in StarterFiles())
        {
            var path = Path.Combine(ctx.ExperimentsDir, filename);
            if (File.Exists(path)) continue;
            try
            {
                using var fs = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None);
                using var writer = new StreamWriter(fs);
                writer.Write(body);
            }
            catch (IOException) { /* lost the race or operator is editing — both are fine */ }
            catch (UnauthorizedAccessException ex)
            {
                _logger.LogWarning(ex, "[1tube] cannot write starter experiment {Path}", path);
            }
        }
    }

    private static string? ResolveOnPath(string name)
    {
        // Honor PATHEXT on Windows so "powershell" resolves to
        // powershell.exe; on non-Windows we just try the name as-is.
        var pathExt = OperatingSystem.IsWindows()
            ? (Environment.GetEnvironmentVariable("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
                .Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            : new[] { "" };
        var hasExt = Path.HasExtension(name);
        var paths = (Environment.GetEnvironmentVariable("PATH") ?? "")
            .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        foreach (var dir in paths)
        {
            foreach (var ext in hasExt ? new[] { "" } : pathExt)
            {
                string candidate;
                try { candidate = Path.Combine(dir, name + ext); }
                catch { continue; }
                if (File.Exists(candidate)) return candidate;
            }
        }
        return null;
    }

    private static string ExpandTokens(string value, IReadOnlyDictionary<string, string> tokens)
    {
        if (string.IsNullOrEmpty(value) || value.IndexOf("${", StringComparison.Ordinal) < 0) return value;
        var sb = new StringBuilder(value.Length);
        int i = 0;
        while (i < value.Length)
        {
            int start = value.IndexOf("${", i, StringComparison.Ordinal);
            if (start < 0) { sb.Append(value, i, value.Length - i); break; }
            sb.Append(value, i, start - i);
            int end = value.IndexOf('}', start + 2);
            if (end < 0) { sb.Append(value, start, value.Length - start); break; }
            string key = value.Substring(start + 2, end - start - 2);
            sb.Append(tokens.TryGetValue(key, out var replacement) ? replacement : value.Substring(start, end - start + 1));
            i = end + 1;
        }
        return sb.ToString();
    }

    private static IEnumerable<ExperimentSpec> BuiltinExperiments() => new[]
    {
        new ExperimentSpec
        {
            Id = "workerd-version",
            Name = "workerd --version",
            Description = "Smoke test: does workerd even start under this identity?",
            Executable = "${WorkerdPath}",
            Args = ["--version"],
            TimeoutSec = 5,
        },
        new ExperimentSpec
        {
            Id = "deno-version",
            Name = "deno --version",
            Description = "Smoke test: deno binary sanity.",
            Executable = "${DenoPath}",
            Args = ["--version"],
            TimeoutSec = 5,
        },
        new ExperimentSpec
        {
            Id = "workerd-minimal",
            Name = "workerd serve <minimal capnp>",
            Description = "Run workerd directly on a hello-world capnp. Killed=true after timeout means the binary boots fine in this environment; an exit code means the binary itself crashed.",
            Executable = "${WorkerdPath}",
            Args = ["serve", "${ProbeCapnp}"],
            Cwd = "${DiagDir}",
            TimeoutSec = 5,
            Daemon = true,
        },
        new ExperimentSpec
        {
            Id = "workerd-active-firmware",
            Name = "workerd serve <active firmware capnp>",
            Description = "Run workerd directly on the firmware's most recent generated capnp, no deno wrapper. If this crashes but workerd-minimal doesn't, the bug is in our generated config.",
            Executable = "${WorkerdPath}",
            Args = ["serve", "${ActiveCapnp}"],
            Cwd = "${DiagDir}",
            TimeoutSec = 10,
            Daemon = true,
        },
        // ── std::terminate triage helpers ──────────────────────────
        new ExperimentSpec
        {
            Id = "workerd-help",
            Name = "workerd --help",
            Description = "Workerd starts normally and prints usage. If --version works but --help also fails, the binary's own runtime init is broken (CRT, ICU, missing DLL).",
            Executable = "${WorkerdPath}",
            Args = ["--help"],
            TimeoutSec = 5,
        },
        new ExperimentSpec
        {
            Id = "host-diag",
            Name = "host environment dump",
            Description = "Identity / Job Object / loaded modules / VC runtime version of the C# host. Most workerd std::terminate cases on shared IIS hosts come down to: process is in a restrictive Job, missing VC++ redist, or AppLocker blocking a DLL load.",
            Executable = "powershell.exe",
            Args = [
                "-NoProfile", "-NonInteractive", "-Command",
                "$ErrorActionPreference='Continue';" +
                "Write-Host '== whoami =='; whoami /all 2>&1 | Out-String;" +
                "Write-Host '== process =='; Get-Process -Id $PID | Format-List Name, Id, Path, StartTime, MainModule | Out-String;" +
                "Write-Host '== job object =='; Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class J{[DllImport(\"kernel32\")]public static extern bool IsProcessInJob(IntPtr h, IntPtr j, out bool r);[DllImport(\"kernel32\")]public static extern IntPtr GetCurrentProcess();}'; $r=$false; [J]::IsProcessInJob([J]::GetCurrentProcess(),[IntPtr]::Zero,[ref]$r) | Out-Null; \"InJob=$r\";" +
                "Write-Host '== workerd file info =='; Get-Item '${WorkerdPath}' | Format-List FullName, Length, LastWriteTime | Out-String;" +
                "(Get-Command '${WorkerdPath}').FileVersionInfo | Format-List FileVersion, ProductVersion, OriginalFilename | Out-String;" +
                "Write-Host '== vcruntime =='; Get-ChildItem 'C:\\Windows\\System32\\vcruntime*.dll','C:\\Windows\\System32\\msvcp*.dll','C:\\Windows\\System32\\ucrtbase.dll' -ErrorAction SilentlyContinue | Select-Object Name, Length, @{n='Ver';e={(Get-Command $_.FullName).FileVersionInfo.FileVersion}} | Format-Table -AutoSize | Out-String;" +
                "Write-Host '== drive map =='; Get-PSDrive -PSProvider FileSystem | Format-Table -AutoSize | Out-String;"
            ],
            TimeoutSec = 15,
        },
        new ExperimentSpec
        {
            Id = "crash-dumps",
            Name = "list workerd/deno crash dumps",
            Description = "Scans the standard Windows Error Reporting locations for recent workerd/deno crash dumps. WER writes a .dmp on std::terminate if collection is enabled; if no files appear here, WER dump collection is disabled for the host identity (HKCU\\Software\\Microsoft\\Windows\\Windows Error Reporting\\LocalDumps).",
            Executable = "powershell.exe",
            Args = [
                "-NoProfile", "-NonInteractive", "-Command",
                "$ErrorActionPreference='Continue';" +
                "$paths = @(\"$env:LOCALAPPDATA\\CrashDumps\", \"$env:USERPROFILE\\AppData\\Local\\CrashDumps\", 'C:\\ProgramData\\Microsoft\\Windows\\WER\\ReportArchive', 'C:\\ProgramData\\Microsoft\\Windows\\WER\\ReportQueue', '${DiagDir}');" +
                "foreach ($p in $paths) { Write-Host \"== $p ==\"; if (Test-Path $p) { Get-ChildItem $p -Recurse -File -ErrorAction SilentlyContinue -Include 'workerd*','*.dmp','Report.wer' | Sort-Object LastWriteTime -Descending | Select-Object -First 20 FullName, Length, LastWriteTime | Format-Table -AutoSize | Out-String } else { 'not present' } }"
            ],
            TimeoutSec = 10,
        },
        new ExperimentSpec
        {
            Id = "enable-wer-dumps",
            Name = "enable WER dumps for workerd (HKCU)",
            Description = "Configures Windows Error Reporting to write full crash dumps for workerd.exe to ${DiagDir}/wer-dumps the next time workerd terminates abnormally. Writes to HKCU so it works without admin (the registry value is per-user; the C# host runs as your domain account, which is the same identity that spawns workerd).",
            Executable = "powershell.exe",
            Args = [
                "-NoProfile", "-NonInteractive", "-Command",
                "$ErrorActionPreference='Stop';" +
                "$dump = '${DiagDir}\\wer-dumps'; New-Item -ItemType Directory -Force -Path $dump | Out-Null;" +
                "$key = 'HKCU:\\Software\\Microsoft\\Windows\\Windows Error Reporting\\LocalDumps\\workerd.exe';" +
                "New-Item -Path $key -Force | Out-Null;" +
                "Set-ItemProperty -Path $key -Name DumpFolder -Value $dump -Type ExpandString;" +
                "Set-ItemProperty -Path $key -Name DumpType -Value 2 -Type DWord;" +
                "Set-ItemProperty -Path $key -Name DumpCount -Value 10 -Type DWord;" +
                "Get-ItemProperty -Path $key | Format-List | Out-String;" +
                "Write-Host \"WER dumps for workerd.exe will land in $dump on next crash. Run a workerd experiment afterwards, then re-run crash-dumps.\""
            ],
            TimeoutSec = 8,
        },
    };

    private static IEnumerable<(string FileName, string Body)> StarterFiles() => new[]
    {
        ("README.txt",
            "Drop *.json files in this folder to define custom diagnostic experiments.\n" +
            "All string fields support ${TOKEN} expansion. Available tokens:\n" +
            "  ${WorkerdPath}    full path to the resolved workerd.exe\n" +
            "  ${DenoPath}       full path to the resolved deno.exe\n" +
            "  ${GatewayRoot}    path to OneTubeGateway/ next to the host (TS sources live here)\n" +
            "  ${ServerScript}   shortcut for ${GatewayRoot}/src/server.ts\n" +
            "  ${DataRoot}       OneTube data root\n" +
            "  ${DiagDir}        ${DataRoot}/onetube/diagnostics — writable scratch dir\n" +
            "  ${DenoCache}      ${DataRoot}/onetube/deno-cache — DENO_DIR for deno experiments\n" +
            "  ${ProbeCapnp}     auto-materialized minimal capnp config (loopback, ephemeral port)\n" +
            "  ${ActiveCapnp}    most recent config.gen-N.capnp of the live firmware (or empty)\n" +
            "  ${RandomPort}/${RandomPort2}  free TCP ports picked at run time\n" +
            "Set \"daemon\": true on long-running experiments so Killed=true is treated as success.\n" +
            "Disk experiments override built-ins by \"id\".\n"),
        ("deno-gateway-once.json",
            "{\n" +
            "  \"id\": \"deno-gateway-once\",\n" +
            "  \"name\": \"deno run gateway (one-shot)\",\n" +
            "  \"description\": \"Spawns the full deno gateway with workerd backend on ephemeral ports. Lets you iterate on TS in OneTubeGateway/ without rebuilding the host.\",\n" +
            "  \"executable\": \"${DenoPath}\",\n" +
            "  \"args\": [\n" +
            "    \"run\", \"-A\", \"--no-prompt\",\n" +
            "    \"${ServerScript}\",\n" +
            "    \"--workerd-bin\", \"${WorkerdPath}\",\n" +
            "    \"--port=${RandomPort}\",\n" +
            "    \"--workerd-base-port=${RandomPort2}\"\n" +
            "  ],\n" +
            "  \"cwd\": \"${GatewayRoot}\",\n" +
            "  \"env\": { \"DENO_DIR\": \"${DenoCache}\", \"DENO_NO_UPDATE_CHECK\": \"1\" },\n" +
            "  \"timeoutSec\": 12,\n" +
            "  \"daemon\": true\n" +
            "}\n"),
        ("workerd-active-verbose.json",
            "{\n" +
            "  \"id\": \"workerd-active-verbose\",\n" +
            "  \"name\": \"workerd serve <active capnp> -v\",\n" +
            "  \"description\": \"Same as workerd-active-firmware but with -v. Often surfaces the pre-abort log line that std::terminate eats.\",\n" +
            "  \"executable\": \"${WorkerdPath}\",\n" +
            "  \"args\": [\"serve\", \"-v\", \"${ActiveCapnp}\"],\n" +
            "  \"cwd\": \"${DiagDir}\",\n" +
            "  \"timeoutSec\": 10,\n" +
            "  \"daemon\": true\n" +
            "}\n"),
    };

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

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        ReadCommentHandling = JsonCommentHandling.Skip,
        AllowTrailingCommas = true,
    };
}

/// <summary>
/// Snapshot of host paths/state passed to <see cref="ExperimentRunner"/>.
/// Constructed by <see cref="DenoHostService"/> so the runner stays
/// pure (no DI on host services, easy to unit test).
/// </summary>
public sealed record ExperimentContext(
    string? WorkerdPath,
    string? DenoPath,
    string GatewayRoot,
    string DataRoot,
    string DiagnosticsDir,
    string ExperimentsDir,
    string DenoCacheDir,
    string? ActiveCapnpPath,
    int RandomPort1,
    int RandomPort2);
