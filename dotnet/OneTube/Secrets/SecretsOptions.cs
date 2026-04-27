namespace OneTube.Secrets;

/// <summary>
/// Configuration for the live-secrets store. Off by default — opt
/// in via <see cref="OneTubeExtensions.AddOneTubeSecrets"/>. Only
/// available alongside the firmware supervisor because the secret
/// hot-swap reuses the side-by-side gateway machinery to apply new
/// values without dropping requests.
///
/// <para>The store on disk is intentionally a plain JSON file with
/// the same trust level as <c>appCfg.json5</c>: whoever can read
/// the host's data root can read the secrets. Encryption-at-rest
/// (DPAPI / KMS-wrapped DEK / age) is the operator's call, not
/// something we bake into the schema. The path is configurable so
/// it can be pointed at a directory with stricter perms or a
/// network mount, but the default sits next to the firmware
/// versions store so housekeeping touches one tree, not two.</para>
/// </summary>
public sealed class SecretsOptions
{
    /// <summary>
    /// Master switch. The hosted service that registers the
    /// endpoints and the hot-swap watcher only fire when this is
    /// true; setting it to false makes <c>AddOneTubeSecrets</c> a
    /// no-op so a single config can drive prod/dev profiles.
    /// </summary>
    public bool Enabled { get; set; } = true;

    /// <summary>
    /// Path to the JSON-on-disk store. Resolved against
    /// <see cref="System.AppContext.BaseDirectory"/> when relative
    /// (same convention as everything else in OneTubeOptions).
    /// Default: <c>{DataRoot}/secrets.json</c> if DataRoot is set,
    /// else null and the store refuses to start.
    /// </summary>
    public string? Path { get; set; }

    /// <summary>
    /// Public path prefix mounted by <c>MapOneTubeSecrets</c>.
    /// Lives under the same <c>/1tube/api</c> tree as the firmware
    /// endpoints so consumers can guard them with one route group
    /// + one auth policy.
    /// </summary>
    public string RoutePrefix { get; set; } = "/1tube/api";

    /// <summary>
    /// Keys the secrets store refuses to write. These belong to the
    /// gateway's own contract (port, host, internal key, function
    /// timeout, body limits, …) and a runtime override would just
    /// confuse a debugging operator. Set in addition to whatever
    /// the operator-supplied list contains; merged at validation.
    /// </summary>
    public static readonly IReadOnlySet<string> ReservedKeys = new HashSet<string>(StringComparer.Ordinal)
    {
        "PORT",
        "FUNCTIONS_PATH",
        "1TUBE_HOST",
        "1TUBE_BODY_LIMIT_MB",
        "1TUBE_BODY_READ_MS",
        "1TUBE_SHUTDOWN_GRACE_MS",
        "FUNCTION_TIMEOUT_MS",
        "INTERNAL_KEY",
    };

    /// <summary>
    /// How long to coalesce a burst of secret edits before
    /// triggering a reload. A bulk PUT or several PUT/{key} calls
    /// from a UI rapid-clicking save would otherwise trigger one
    /// gateway swap per call. The watcher waits this long after
    /// the last change before kicking off a reboot; the next
    /// in-flight request observes the merged change.
    /// </summary>
    public int ReloadDebounceMs { get; set; } = 500;
}
