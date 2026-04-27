namespace OneTube.Firmware;

/// <summary>
/// Configuration for the firmware update protocol. Bound from the
/// consumer's config under the <c>OneTube:Firmware</c> key. Disabled
/// by default so adding the OneTube package to a consumer that
/// doesn't want firmware updates is a no-op cost-wise.
/// </summary>
public sealed class FirmwareOptions
{
    /// <summary>
    /// Master switch. When false, <see cref="OneTubeExtensions.MapOneTubeFirmware"/>
    /// is a no-op; nothing gets registered, no listener gets bound,
    /// no /1tube/api/firmware/* routes appear.
    /// </summary>
    public bool Enabled { get; set; } = false;

    /// <summary>
    /// Bearer key used for the <c>Authorization: Bearer ...</c> header
    /// on every <c>/1tube/api/firmware/*</c> request. Compared in
    /// constant time. Conventionally injected from an env var so the
    /// secret never lives in source. When the supervisor is enabled
    /// and this is null/empty, AddOneTubeFirmware throws at startup —
    /// silently accepting unauthenticated firmware uploads is the
    /// kind of footgun we never want.
    /// </summary>
    public string? SharedSecret { get; set; }

    /// <summary>
    /// Number of historic versions to retain on disk. The current and
    /// previous slots are always kept regardless of this value, so the
    /// effective floor is 2. Default 3 means current + previous + one
    /// older for forensic inspection.
    /// </summary>
    public int RetainVersions { get; set; } = 3;

    /// <summary>
    /// How long to wait for a freshly-spawned candidate gateway to
    /// pass /health before giving up and rolling the candidate back.
    /// Generous default — a large prebuilt artifact can spawn dozens
    /// of workerd isolates, and Windows AV can make the first boot
    /// noticeably slower. Candidate process death is detected
    /// separately and fails fast; this is only the upper bound for a
    /// still-running candidate.
    /// </summary>
    public int SmokeTimeoutMs { get; set; } = 120_000;

    /// <summary>
    /// After flipping the destination provider, how long to wait for
    /// the old gateway's in-flight requests to finish before forcibly
    /// stopping it. The old workerd's own
    /// <c>1TUBE_SHUTDOWN_GRACE_MS</c> still applies; this is the
    /// supervisor-level upper bound.
    /// </summary>
    public int DrainGraceMs { get; set; } = 30_000;

    /// <summary>
    /// Optional function name to ping during smoke testing. Must
    /// answer 200 to a GET on the candidate's gateway. Leaving this
    /// null means the smoke test only checks that the gateway's
    /// <c>/health</c> reports ready — sufficient for most setups.
    /// </summary>
    public string? SmokeFunctionName { get; set; }

    /// <summary>
    /// Mount point for the firmware HTTP surface. Default
    /// <c>/1tube/api</c>. Configurable for the rare case where a
    /// consumer already routes that path or wants the firmware
    /// admin surface mounted under a private prefix on a private
    /// network.
    /// </summary>
    public string RoutePrefix { get; set; } = "/1tube/api";

    /// <summary>
    /// Per-request size cap for the upload endpoint, in bytes. The
    /// supervisor lifts ASP.NET Core's default 30 MB cap on this one
    /// endpoint via <c>IHttpMaxRequestBodySizeFeature</c> so a fully-
    /// bundled sciobot-next deploy (typically 30–100 MB) goes through
    /// without silent truncation.
    ///
    /// <para>Defaults to <c>512 MB</c>. Set to <c>null</c> to remove
    /// the cap entirely (not recommended in prod — at minimum gives
    /// an attacker an easy disk-fill DoS through your firmware key).
    /// Set to a smaller value if you've sized your bundles and want
    /// a tighter ceiling.</para>
    ///
    /// <para><b>Reverse proxies</b> (nginx, IIS, Cloudflare, …) and
    /// the <b>Kestrel server-wide limit</b> also apply and are
    /// outside our control. If uploads stall at exactly 30 MB and
    /// this option is set higher, suspect Kestrel; bump it via
    /// <c>builder.WebHost.ConfigureKestrel(o =&gt; o.Limits.MaxRequestBodySize = …)</c>.
    /// nginx defaults to 1 MB — set <c>client_max_body_size</c> on
    /// the location block.</para>
    /// </summary>
    public long? MaxUploadBytes { get; set; } = 512L * 1024 * 1024;
}
