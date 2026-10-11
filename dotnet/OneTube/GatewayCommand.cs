namespace OneTube;

/// <summary>
/// Translates <see cref="OneTubeOptions"/> into the argv + env that
/// the 1tube gateway (<c>bun src/server.ts</c>) expects. Pulled out of the host service so
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
///       Bun has no permission model, so there are no runtime flags:
///       the argv is just the server script followed by gateway flags.
///     </description>
///   </item>
/// </list>
/// </summary>
internal static class GatewayCommand
{
    /// <summary>
    /// Build the argv list (excluding the bun binary itself).
    /// The slot's port + prebuilt-dir override are honoured so the
    /// candidate gateway can boot on a different port and against
    /// a different staged version than the active one.
    /// </summary>
    public static List<string> BuildArgs(OneTubeOptions opts, GatewaySlot slot, string serverScriptPath, string? resolvedWorkerdBin)
    {
        var args = new List<string>
        {
            // Bun auto-loads .env / .env.local from the cwd; the host hands
            // the gateway its environment explicitly, so never let a stray
            // dotenv file in OneTubeGateway/ leak in.
            "--no-env-file",
            serverScriptPath,
            // Resolve to absolute against AppContext.BaseDirectory.
            // The Bun child runs with cwd = OneTubeGateway/, which
            // means relative paths configured by the host would
            // otherwise resolve against the gateway dir, not the
            // host's bin/. Always hand the gateway absolute paths.
            "--functions", ResolveHostPath(opts.FunctionsPath),
            "--port", slot.Port.ToString(),
            "--host", opts.Host,
            "--backend", BackendName(opts.Backend),
            // The managed npm:/jsr: store (package.json + bun.lock +
            // node_modules) for the functions' own dependencies. Its
            // bun.lock is the boot-speed lever the Deno-era --lock was:
            // warm boots skip resolution entirely. Host-owned and
            // absolute — never inside OneTubeGateway/ (which may be
            // replaced on deploy) and never in the consumer's repo. A
            // function bumping a dependency just re-installs into it.
            "--deps-dir", ResolveDepsDir(opts),
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
            // gateway will call this directly with no further PATH
            // lookup.
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
    /// Gateway <c>--backend</c> value for <paramref name="backend"/>.
    /// </summary>
    internal static string BackendName(OneTubeBackend backend)
        => backend == OneTubeBackend.Workerd ? "workerd" : "bun";

    /// <summary>
    /// Resolve the 1tube-managed dependency store (<c>--deps-dir</c>).
    /// <c>{DataRoot}/onetube/deps</c> when a data root is configured;
    /// otherwise a <c>deps/</c> dir next to the invocation-log DB (the
    /// default <c>.1tube/logs.db</c> therefore yields <c>.1tube/deps</c>,
    /// the gateway's own default layout). Always absolute because the
    /// child runs with cwd = OneTubeGateway/. The gateway caches remote
    /// <c>https:</c> modules in a sibling <c>remote/</c> dir.
    /// </summary>
    internal static string ResolveDepsDir(OneTubeOptions opts)
    {
        if (!string.IsNullOrWhiteSpace(opts.DataRoot))
        {
            return ResolveHostPath(Path.Combine(opts.DataRoot, "onetube", "deps"));
        }
        var logDb = ResolveLogDbPath(opts);
        var dir = Path.GetDirectoryName(logDb) ?? AppContext.BaseDirectory;
        return Path.Combine(dir, "deps");
    }

    /// <summary>
    /// The bun binary setting to resolve: <see cref="OneTubeOptions.BunBinary"/>
    /// when set; otherwise the obsolete <see cref="OneTubeOptions.DenoBinary"/>
    /// if (and only if) it obviously points at bun (file name <c>bun</c> /
    /// <c>bun.exe</c>), so a config that was already switched over keeps
    /// working. Any other legacy value — a real deno path — is returned in
    /// <paramref name="ignoredLegacy"/> for the caller to warn about, and
    /// resolution falls back to <c>bun</c> on PATH.
    /// </summary>
    internal static string? SelectBunBinary(OneTubeOptions opts, out string? ignoredLegacy)
    {
        ignoredLegacy = null;
        if (!string.IsNullOrWhiteSpace(opts.BunBinary)) return opts.BunBinary;

#pragma warning disable CS0618 // DenoBinary is the obsolete alias we are honouring here.
        var legacy = opts.DenoBinary;
#pragma warning restore CS0618
        if (string.IsNullOrWhiteSpace(legacy)) return null;

        var name = Path.GetFileNameWithoutExtension(legacy.Trim().Replace('\\', '/').Split('/')[^1]);
        if (string.Equals(name, "bun", StringComparison.OrdinalIgnoreCase)) return legacy;

        ignoredLegacy = legacy;
        return null;
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
        // Mirrors --deps-dir. The bundler (workerd backend) builds its own
        // compat environment from env rather than parsed args, so without
        // this it would fall back to <cwd>/.1tube/deps inside
        // OneTubeGateway/.
        env["1TUBE_DEPS_DIR"] = ResolveDepsDir(opts);

        if (opts.BodyLimitMb is double bodyMb && bodyMb > 0)
        {
            // The gateway parses this as a float; invariant culture so we
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
