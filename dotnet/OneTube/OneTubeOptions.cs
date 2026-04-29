namespace OneTube;

/// <summary>
/// Configuration for the embedded 1tube gateway. Every knob here maps
/// directly to one of the gateway's CLI flags or env vars, so anyone
/// who has read the 1tube README will recognize the surface. Defaults
/// match the gateway's own defaults — leaving a property null means
/// "let 1tube decide", not "explicitly disable".
/// </summary>
public sealed class OneTubeOptions
{
    /// <summary>
    /// Backend that runs bundled functions. <c>"deno"</c> imports each
    /// function as a module inside the gateway process (lower memory,
    /// shared global state). <c>"workerd"</c> bundles each function and
    /// serves it from a Cloudflare-style workerd subprocess for hard
    /// V8-level isolation.
    /// </summary>
    public OneTubeBackend Backend { get; set; } = OneTubeBackend.Deno;

    // ── Required paths ────────────────────────────────────────────────

    /// <summary>
    /// Path to the edge functions directory. The gateway scans this
    /// for <c>{name}/index.ts</c> and an optional
    /// <c>{name}/1tube.json</c> manifest per function.
    ///
    /// <para>In firmware mode this is only consulted at cold-boot
    /// before any version is promoted; a tiny placeholder folder
    /// (e.g. <c>onetube/functions/</c> next to your project) is
    /// enough. After the first firmware upload the supervisor serves
    /// out of <c>{DataRoot}/onetube/versions/&lt;id&gt;/dist/</c> and
    /// this path is never read.</para>
    ///
    /// <para>Resolution: absolute paths used as-is; relative paths
    /// resolved against <see cref="AppContext.BaseDirectory"/> (the
    /// host's <c>bin/</c> at runtime), <em>not</em>
    /// <see cref="Environment.CurrentDirectory"/>, so the meaning
    /// doesn't change when the host is launched from a different
    /// shell.</para>
    /// </summary>
    public required string FunctionsPath { get; set; }

    // ── Binary paths ──────────────────────────────────────────────────

    /// <summary>
    /// Path to the <c>deno</c> binary. Resolution rules:
    /// <list type="bullet">
    ///   <item><description>Absolute path: used verbatim.</description></item>
    ///   <item><description>Relative path: resolved against
    ///   <see cref="AppContext.BaseDirectory"/>. Example: shipping
    ///   <c>deno/deno.exe</c> next to the host binary and configuring
    ///   <c>"DenoBinary": "deno/deno.exe"</c> works the same in dev
    ///   and prod regardless of the launching shell's cwd.</description></item>
    ///   <item><description>Bare name (no separator, no extension):
    ///   <c>where</c>/<c>which</c> lookup on PATH.</description></item>
    ///   <item><description>Null/empty: PATH lookup for
    ///   <c>deno</c>.</description></item>
    /// </list>
    /// </summary>
    public string? DenoBinary { get; set; }

    /// <summary>
    /// Path to the <c>workerd</c> binary. Only consulted when
    /// <see cref="Backend"/> is <see cref="OneTubeBackend.Workerd"/>.
    /// Same resolution semantics as <see cref="DenoBinary"/>:
    /// absolute → verbatim, relative → relative to
    /// <see cref="AppContext.BaseDirectory"/>, bare name → PATH.
    /// </summary>
    public string? WorkerdBinary { get; set; }

    // ── Listener ──────────────────────────────────────────────────────

    /// <summary>Port the gateway binds. Default <c>3100</c>.</summary>
    public int Port { get; set; } = 3100;

    /// <summary>
    /// Port the firmware supervisor binds the candidate gateway to
    /// during a side-by-side swap. Must differ from <see cref="Port"/>
    /// and from any port the workerd subprocess uses (8800..8807 by
    /// default). Default <c>3101</c> is the convention; firewall this
    /// to loopback in production — the candidate is an internal-only
    /// staging slot.
    /// </summary>
    public int CandidatePort { get; set; } = 3101;

    /// <summary>
    /// Root directory for OneTube's persistent state. The firmware
    /// supervisor writes <c>state.json</c>, <c>versions/&lt;ver&gt;/</c>,
    /// and <c>incoming/&lt;jobId&gt;/</c> trees under
    /// <c>{DataRoot}/onetube/</c>. Required when the firmware
    /// supervisor is enabled; otherwise unused.
    /// </summary>
    public string? DataRoot { get; set; }

    /// <summary>
    /// Bind address. Default <c>127.0.0.1</c> (loopback only). The
    /// gateway is intended to sit behind ASP.NET / YARP, so external
    /// exposure should normally come from the host app, not 1tube.
    /// </summary>
    public string Host { get; set; } = "127.0.0.1";

    // ── Mode ──────────────────────────────────────────────────────────

    /// <summary>
    /// Hot-module reload watcher. Dev only — allocates extra workerd
    /// generations and watches the filesystem.
    /// </summary>
    public bool Hmr { get; set; }

    /// <summary>
    /// Sets <c>1TUBE_DEV=1</c>, which loosens a handful of defaults
    /// (verbose logs, banner, etc.). Dev only.
    /// </summary>
    public bool Dev { get; set; }

    /// <summary>
    /// Lazy-load functions on first request instead of warming them at
    /// boot. Default <c>false</c> (eager), matching the gateway.
    /// </summary>
    public bool Lazy { get; set; }

    /// <summary>
    /// When set, points at a directory produced by
    /// <c>1tube build --out</c>. The gateway boots from the prebuilt
    /// bundles + manifest and never invokes esbuild. Implies
    /// <see cref="OneTubeBackend.Workerd"/>.
    /// </summary>
    public string? PrebuiltDir { get; set; }

    // ── Workerd-specifics ─────────────────────────────────────────────

    /// <summary>
    /// Allowlist of env-var names to forward into bundled workerd
    /// functions. Maps to <c>--workerd-env=A,B,C</c>. When null the
    /// gateway forwards every visible env var (the safer default for
    /// dev; tighten in prod).
    /// </summary>
    public IReadOnlyList<string>? WorkerdEnvAllowlist { get; set; }

    /// <summary>
    /// Source module paths that should run once in the gateway process
    /// and be consumed by workerd isolates through generated RPC stubs.
    /// Maps to repeated <c>--workerd-shared</c> flags. Relative paths
    /// are resolved by the gateway relative to <see cref="FunctionsPath"/>.
    /// The Supabase-style <c>_shared/profile-cache.ts</c> path is used
    /// by convention when present even if this list is null.
    /// </summary>
    public IReadOnlyList<string>? WorkerdSharedModules { get; set; }

    /// <summary>
    /// First loopback port the embedded workerd process may use for
    /// per-function sockets. The gateway also reserves
    /// <c>+500</c> for a hot-reload generation, so embedded hosts with
    /// side-by-side active/candidate gateways should keep at least
    /// 1000 ports between slots. Maps to <c>--workerd-base-port</c>.
    /// </summary>
    public int? WorkerdBasePort { get; set; }

    /// <summary>
    /// Bind address for the V8 inspector. Maps to <c>--inspector-addr</c>.
    /// <em>Local dev only</em> — opens an unauthenticated debug port.
    /// </summary>
    public string? WorkerdInspectorAddr { get; set; }

    /// <summary>
    /// Hard cap on V8 heap, in MB. Maps to <c>--workerd-max-heap-mb</c>.
    /// Process-wide (all isolates), not per-function.
    /// </summary>
    public int? WorkerdMaxHeapMb { get; set; }

    /// <summary>
    /// Compatibility date written into generated workerd configs.
    /// Maps to <c>--compat-date</c>. Null means the gateway's own
    /// default/clamping logic chooses the date.
    /// </summary>
    public string? WorkerdCompatibilityDate { get; set; }

    /// <summary>
    /// Compatibility flags written into generated workerd configs.
    /// Maps to repeated <c>--compat-flag</c>. Null means the gateway's
    /// own defaults (<c>nodejs_compat</c>, etc.) apply.
    /// </summary>
    public IReadOnlyList<string>? WorkerdCompatibilityFlags { get; set; }

    /// <summary>
    /// Passes <c>--experimental</c> to the workerd process. Required
    /// when <see cref="WorkerdCompatibilityFlags"/> contains the
    /// <c>experimental</c> compatibility flag.
    /// </summary>
    public bool WorkerdExperimental { get; set; }

    /// <summary>
    /// Auto-kill leftover <c>workerd</c> processes when the boot-time
    /// port preflight finds one of workerd's sockets already busy.
    /// Maps to <c>--kill-stale-workerd</c>. Recommended <c>true</c> on
    /// dev boxes; leave <c>false</c> in prod.
    /// </summary>
    public bool KillStaleWorkerd { get; set; }

    // ── Limits / timeouts ─────────────────────────────────────────────

    /// <summary>
    /// Per-request body cap (MB). Maps to <c>1TUBE_BODY_LIMIT_MB</c>.
    /// </summary>
    public double? BodyLimitMb { get; set; }

    /// <summary>
    /// Slow-loris idle timeout while reading the request body, in ms.
    /// Maps to <c>1TUBE_BODY_READ_MS</c>.
    /// </summary>
    public int? BodyReadIdleMs { get; set; }

    /// <summary>
    /// Default per-function timeout (ms). Maps to
    /// <c>FUNCTION_TIMEOUT_MS</c>. Per-function <c>1tube.json#timeoutMs</c>
    /// still wins.
    /// </summary>
    public int? FunctionTimeoutMs { get; set; }

    /// <summary>
    /// Wall-clock budget for graceful shutdown, ms. Maps to
    /// <c>1TUBE_SHUTDOWN_GRACE_MS</c>.
    /// </summary>
    public int? ShutdownGraceMs { get; set; }

    // ── Auth ──────────────────────────────────────────────────────────

    /// <summary>
    /// Bearer secret for <c>/health</c> + <c>/metrics</c>. Maps to the
    /// <c>INTERNAL_KEY</c> env var. When null the detailed endpoints
    /// remain locked.
    /// </summary>
    public string? InternalKey { get; set; }

    // ── Generic env passthrough ───────────────────────────────────────

    /// <summary>
    /// Extra env vars forwarded into the gateway process (and from
    /// there into bundled functions, subject to
    /// <see cref="WorkerdEnvAllowlist"/> when running on workerd).
    /// Common entries: <c>SUPABASE_URL</c>, <c>JWT_SECRET</c>,
    /// <c>OPENAI_API_KEY</c>.
    /// </summary>
    public Dictionary<string, string> EnvVars { get; set; } = new();

    // ── Health monitoring ─────────────────────────────────────────────

    /// <summary>How often the host pings <c>/health</c>.</summary>
    public int HealthCheckIntervalMs { get; set; } = 10_000;

    /// <summary>
    /// Consecutive health-check failures before the host stops the
    /// current gateway process. The ASP.NET host remains alive so
    /// firmware and admin endpoints can recover the deployment.
    /// </summary>
    public int MaxConsecutiveFailures { get; set; } = 3;

    /// <summary>
    /// Maximum automatic gateway respawns after the initial process.
    /// Default <c>0</c>: never respawn. A bad firmware must not create
    /// an endless host loop; the OneTube slot is marked unavailable and
    /// the containing server keeps running so a new firmware can be
    /// flashed. Set to a small positive value only for deployments that
    /// explicitly want bounded self-healing.
    /// </summary>
    public int MaxGatewayRestarts { get; set; } = 0;
}

/// <summary>
/// Backend selector — string literal in the CLI, enum here so
/// callers can't typo the value.
/// </summary>
public enum OneTubeBackend
{
    Deno,
    Workerd,
}
