namespace OneTube;

/// <summary>
/// Translates <see cref="OneTubeOptions"/> into the argv + env that
/// the 1tube Deno gateway expects. Pulled out of the host service so
/// it's independently testable: every CLI flag we emit lines up with
/// a property on <see cref="OneTubeOptions"/>, and every
/// option-derived env var lives in one place.
///
/// Conventions:
/// <list type="bullet">
///   <item>
///     <description>
///       Knobs that have a CLI flag use the flag (more visible in
///       process listings, easier to grep in logs).
///     </description>
///   </item>
///   <item>
///     <description>
///       Knobs that 1tube only reads from env vars (body limits,
///       timeouts, INTERNAL_KEY) are forwarded as env vars on the
///       child <see cref="ProcessStartInfo"/>. We never mutate the
///       host process env.
///     </description>
///   </item>
///   <item>
///     <description>
///       <c>--allow-all</c> is unconditional. The gateway needs net,
///       fs, env, and run permissions; granting them piecemeal would
///       just be busywork for the operator.
///     </description>
///   </item>
/// </list>
/// </summary>
internal static class GatewayCommand
{
    /// <summary>
    /// Build the argv list (excluding the deno binary itself).
    /// The slot's port + prebuilt-dir override are honoured so the
    /// candidate gateway can boot on a different port and against
    /// a different staged version than the active one.
    /// </summary>
    public static List<string> BuildArgs(OneTubeOptions opts, GatewaySlot slot, string serverScriptPath, string? resolvedWorkerdBin)
    {
        var args = new List<string>
        {
            "run",
            "--allow-all",
            serverScriptPath,
            // Resolve to absolute against AppContext.BaseDirectory.
            // The Deno child runs with cwd = OneTubeGateway/ (so it
            // can find the bundled deno.json), which means relative
            // paths configured by the host would otherwise resolve
            // against the gateway dir, not the host's bin/. Always
            // hand the gateway absolute paths.
            "--functions", ResolveHostPath(opts.FunctionsPath),
            "--port", slot.Port.ToString(),
            "--host", opts.Host,
            "--backend", opts.Backend == OneTubeBackend.Workerd ? "workerd" : "deno",
            // A lockfile is the single biggest boot-speed lever on a large
            // functions project: without one Deno re-solves the entire
            // npm/jsr version graph on every start, a multi-second floor the
            // Worker herd all block on. We point --lock at a host-owned,
            // absolute scratch path (next to the invocation-log DB) rather
            // than letting Deno default to one next to the bundled gateway
            // config — the child runs with cwd = OneTubeGateway/, so a
            // relative default would land in the wrong place. We never pass
            // --frozen, so a consumer bumping a function's dependency is
            // appended to the lock without error on the next boot.
            "--lock", ResolveManagedLockPath(opts),
        };

        if (opts.Hmr) args.Add("--hmr");
        if (opts.Dev) args.Add("--dev");

        // Invocation log store. The DB path is always passed explicitly
        // (absolute) so the gateway and the host-side reader agree on
        // the file regardless of the child's cwd.
        if (opts.InvocationLogs)
        {
            args.Add("--log-db");
            args.Add(ResolveLogDbPath(opts));
            if (opts.LogRetentionDays is int retention && retention >= 0)
            {
                args.Add($"--log-retention-days={retention}");
            }
            if (opts.LogMaxRows is long maxRows && maxRows >= 0)
            {
                args.Add($"--log-max-rows={maxRows}");
            }
        }
        else
        {
            args.Add("--no-invocation-logs");
        }
        // The gateway flag is `--lazy` (default off). We only emit it
        // when the operator explicitly opts in; no flag means "use
        // gateway default" which is also off, so behavior matches.
        if (opts.Lazy) args.Add("--lazy");

        if (opts.Backend == OneTubeBackend.Workerd)
        {
            // Always pass the absolute resolved path here. We've
            // already validated it exists in the host service — the
            // Deno gateway will call this directly with no further
            // PATH lookup.
            if (!string.IsNullOrEmpty(resolvedWorkerdBin))
            {
                args.Add("--workerd-bin");
                args.Add(resolvedWorkerdBin);
            }

            if (opts.WorkerdEnvAllowlist is { Count: > 0 } allow)
            {
                // Comma-separated, no shell-escaping needed because
                // we're not going through a shell — Process.Start
                // arguments arrive verbatim.
                args.Add("--workerd-env=" + string.Join(",", allow));
            }

            if (opts.WorkerdSharedModules is { Count: > 0 } shared)
            {
                foreach (var module in shared.Where(s => !string.IsNullOrWhiteSpace(s)))
                {
                    args.Add("--workerd-shared");
                    args.Add(module);
                }
            }

            if (WorkerdBasePortForSlot(opts, slot) is int basePort)
            {
                args.Add($"--workerd-base-port={basePort}");
            }

            if (!string.IsNullOrWhiteSpace(opts.WorkerdInspectorAddr))
            {
                args.Add("--inspector-addr=" + opts.WorkerdInspectorAddr);
            }

            if (opts.WorkerdMaxHeapMb is int heap && heap > 0)
            {
                args.Add($"--workerd-max-heap-mb={heap}");
            }

            if (!string.IsNullOrWhiteSpace(opts.WorkerdCompatibilityDate))
            {
                args.Add("--compat-date");
                args.Add(opts.WorkerdCompatibilityDate.Trim());
            }

            if (opts.WorkerdCompatibilityFlags is { Count: > 0 } compatFlags)
            {
                foreach (var flag in compatFlags.Where(s => !string.IsNullOrWhiteSpace(s)))
                {
                    args.Add("--compat-flag");
                    args.Add(flag.Trim());
                }
            }

            if (opts.WorkerdExperimental)
            {
                args.Add("--workerd-experimental");
            }

            if (opts.KillStaleWorkerd)
            {
                args.Add("--kill-stale-workerd");
            }

            // Prefer the slot's own override (firmware-staged version)
            // over the global PrebuiltDir; the firmware supervisor
            // never mutates OneTubeOptions, it just hands the candidate
            // slot a different version directory.
            string? prebuilt = slot.PrebuiltDirOverride ?? opts.PrebuiltDir;
            if (!string.IsNullOrWhiteSpace(prebuilt))
            {
                args.Add("--prebuilt");
                args.Add(ResolveHostPath(prebuilt));
            }
        }

        return args;
    }

    /// <summary>
    /// Resolve a host-side configured path to an absolute one. Absolute
    /// inputs are returned verbatim; relatives are resolved against
    /// <see cref="AppContext.BaseDirectory"/> (the host's <c>bin/</c>),
    /// matching the convention documented on <see cref="OneTubeOptions"/>.
    /// </summary>
    private static string ResolveHostPath(string path)
        => Path.IsPathRooted(path)
            ? path
            : Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, path));

    /// <summary>
    /// Resolve the 1tube-managed Deno lockfile path. Kept next to the
    /// invocation-log DB so all gateway scratch state lives together, and
    /// always absolute because the Deno child runs with cwd =
    /// OneTubeGateway/ — a relative path would resolve against the bundled
    /// gateway dir, not the host. Owned by 1tube (not the consumer's repo),
    /// so it never adds git churn or clashes with a project's own deno.lock.
    /// </summary>
    internal static string ResolveManagedLockPath(OneTubeOptions opts)
    {
        var logDb = ResolveLogDbPath(opts);
        var dir = Path.GetDirectoryName(logDb) ?? AppContext.BaseDirectory;
        return Path.Combine(dir, "deno.lock");
    }

    /// <summary>
    /// Resolve the invocation-log DB file the gateway should write and
    /// the host-side reader should read. Single source of truth — the
    /// logs reader (<c>AddOneTubeLogs</c>) calls this too.
    /// </summary>
    internal static string ResolveLogDbPath(OneTubeOptions opts)
    {
        if (!string.IsNullOrWhiteSpace(opts.LogDbPath))
        {
            return ResolveHostPath(opts.LogDbPath);
        }
        if (!string.IsNullOrWhiteSpace(opts.DataRoot))
        {
            return ResolveHostPath(Path.Combine(opts.DataRoot, "onetube", "logs", "1tube-logs.db"));
        }
        return ResolveHostPath(Path.Combine(".1tube", "logs.db"));
    }

    /// <summary>
    /// Outer gateway ports must not share the same inner workerd socket
    /// range. WorkerdBackend itself uses base and base+500 for its own
    /// reload generations, so reserve 1000 ports per outer gateway port.
    /// Firmware swaps alternate which outer port is active, therefore
    /// this is keyed by port rather than by the transient role label.
    /// </summary>
    private static int? WorkerdBasePortForSlot(OneTubeOptions opts, GatewaySlot slot)
    {
        if (opts.Backend != OneTubeBackend.Workerd) return null;
        var basePort = opts.WorkerdBasePort ?? 8800;
        return slot.Port == opts.CandidatePort
            ? basePort + 1000
            : basePort;
    }

    /// <summary>
    /// Build the env-var dictionary to layer on top of the inherited
    /// process environment. Returned as a flat dictionary so callers
    /// can apply it onto <see cref="ProcessStartInfo.Environment"/>.
    ///
    /// <para>Layering order (later wins):
    /// <list type="number">
    ///   <item>Gateway-derived bindings (PORT, FUNCTIONS_PATH, etc.)</item>
    ///   <item><see cref="OneTubeOptions.EnvVars"/> from appCfg</item>
    ///   <item><paramref name="secretsOverlay"/> — runtime-edited
    ///   secrets from the live secrets store. Wins on collision so
    ///   appCfg keys are treated as defaults that secrets can
    ///   override.</item>
    /// </list>
    /// The <c>secretsOverlay</c> argument is optional so consumers
    /// without the secrets feature pay nothing for it.</para>
    /// </summary>
    public static Dictionary<string, string> BuildEnvironment(
        OneTubeOptions opts,
        GatewaySlot slot,
        IReadOnlyDictionary<string, string>? secretsOverlay = null)
    {
        var env = new Dictionary<string, string>(StringComparer.Ordinal);

        // The gateway also reads PORT/FUNCTIONS_PATH as defaults, but
        // we pass them on the CLI for visibility. Setting them here
        // too ensures any helper code inside the gateway that looks
        // at env (rather than parsed args) agrees on the value.
        env["PORT"] = slot.Port.ToString();
        env["FUNCTIONS_PATH"] = ResolveHostPath(opts.FunctionsPath);
        env["1TUBE_HOST"] = opts.Host;
        // Let the gateway print which lockfile is in effect (it can't read
        // its own process's --lock flag back out of Deno). Mirrors the
        // --lock we pass in BuildArgs.
        env["ONETUBE_LOCK"] = ResolveManagedLockPath(opts);

        if (opts.BodyLimitMb is double bodyMb && bodyMb > 0)
        {
            // Deno parses this as a float; invariant culture so we
            // don't write `30,0` on a German-locale Windows host.
            env["1TUBE_BODY_LIMIT_MB"] = bodyMb.ToString(System.Globalization.CultureInfo.InvariantCulture);
        }

        if (opts.BodyReadIdleMs is int bodyMs && bodyMs > 0)
        {
            env["1TUBE_BODY_READ_MS"] = bodyMs.ToString();
        }

        if (opts.FunctionTimeoutMs is int fnMs && fnMs > 0)
        {
            env["FUNCTION_TIMEOUT_MS"] = fnMs.ToString();
        }

        if (opts.ShutdownGraceMs is int graceMs && graceMs > 0)
        {
            env["1TUBE_SHUTDOWN_GRACE_MS"] = graceMs.ToString();
        }

        if (!string.IsNullOrEmpty(opts.InternalKey))
        {
            env["INTERNAL_KEY"] = opts.InternalKey;
        }

        // Console capture default is on in the gateway; only emit the
        // env var when the host explicitly opts out.
        if (!opts.LogConsoleCapture)
        {
            env["1TUBE_LOG_CONSOLE"] = "0";
        }

        // Caller-supplied passthrough is layered last so it always
        // wins — operators may want to override a derived value
        // (e.g. set INTERNAL_KEY directly via EnvVars instead of the
        // typed property).
        foreach (var (k, v) in opts.EnvVars)
        {
            env[k] = v;
        }

        // Live-edited secrets layer on top of EnvVars. The secrets
        // store rejects gateway-reserved keys at write time so this
        // overlay can never accidentally clobber PORT/INTERNAL_KEY/
        // etc. — but it CAN override anything an operator put in
        // EnvVars, which is the whole point.
        if (secretsOverlay is not null)
        {
            foreach (var (k, v) in secretsOverlay)
            {
                env[k] = v;
            }
            env["1TUBE_SECRET_NAMES"] = string.Join(
                ",",
                secretsOverlay.Keys
                    .Where(IsValidEnvName)
                    .Order(StringComparer.Ordinal));
        }

        return env;
    }

    private static bool IsValidEnvName(string name)
    {
        if (string.IsNullOrEmpty(name)) return false;
        if (!(name[0] == '_' || char.IsAsciiLetter(name[0]))) return false;
        for (var i = 1; i < name.Length; i++)
        {
            var c = name[i];
            if (!(c == '_' || char.IsAsciiLetterOrDigit(c))) return false;
        }
        return true;
    }
}
