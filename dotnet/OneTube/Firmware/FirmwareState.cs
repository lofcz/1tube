using System.Text.Json.Serialization;

namespace OneTube.Firmware;

/// <summary>
/// On-disk state.json schema. The bootloader equivalent: the single
/// authoritative record of "what version is currently active" and
/// "what version do we roll back to". All other in-memory state is
/// derived from this file at startup.
///
/// Atomicity: the supervisor writes a temp file, fsyncs, then renames.
/// On Windows this is best-effort atomic; on POSIX it's atomic for a
/// rename within the same filesystem, which it always is here because
/// state.json sits in <c>DataRoot/onetube/</c> next to <c>versions/</c>.
/// </summary>
public sealed class FirmwareState
{
    public const int CurrentSchema = 1;

    [JsonPropertyName("schemaVersion")]
    public int SchemaVersion { get; set; } = CurrentSchema;

    /// <summary>
    /// Currently-serving version id. Maps to a directory under
    /// <c>versions/&lt;current&gt;/</c>. Null when the supervisor has
    /// never accepted a successful upload (cold install).
    /// </summary>
    [JsonPropertyName("current")]
    public string? Current { get; set; }

    /// <summary>
    /// Previous version id, populated on every successful promote.
    /// Used by <c>POST /1tube/api/firmware/rollback</c>. We keep
    /// exactly one previous slot — older versions are trim history,
    /// not recovery anchors.
    /// </summary>
    [JsonPropertyName("previous")]
    public string? Previous { get; set; }

    [JsonPropertyName("history")]
    public List<FirmwareHistoryEntry> History { get; set; } = new();
}

public sealed class FirmwareHistoryEntry
{
    [JsonPropertyName("version")]
    public string Version { get; set; } = "";

    [JsonPropertyName("promotedAt")]
    public string PromotedAt { get; set; } = "";

    [JsonPropertyName("envelopeManifestSha256")]
    public string EnvelopeManifestSha256 { get; set; } = "";
}
