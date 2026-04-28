using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace OneTube.Firmware;

/// <summary>
/// C# mirror of the firmware envelope schema produced by
/// <c>1tube package</c>. Field names match the JSON layout 1:1 so
/// JSON deserialisation is a straight pass-through.
///
/// The schema is intentionally minimal — we resist the temptation
/// to add hashes for individual files at this layer because the
/// inner <c>manifest.json</c> already records them, and one source
/// of truth is enough. The envelope's job is to (a) bind every
/// payload to a single trust anchor (the HMAC) and (b) carry
/// metadata (version id, function count, total size) the supervisor
/// can show in logs and admin UIs without having to extract the
/// inner archive first.
/// </summary>
public sealed class FirmwareEnvelope
{
    [JsonPropertyName("envelopeSchema")]
    public int EnvelopeSchema { get; set; }

    [JsonPropertyName("version")]
    public string Version { get; set; } = "";

    [JsonPropertyName("createdAt")]
    public string CreatedAt { get; set; } = "";

    [JsonPropertyName("createdBy")]
    public string CreatedBy { get; set; } = "";

    [JsonPropertyName("manifestSha256")]
    public string ManifestSha256 { get; set; } = "";

    [JsonPropertyName("contentSha256")]
    public string? ContentSha256 { get; set; }

    [JsonPropertyName("functionCount")]
    public int FunctionCount { get; set; }

    [JsonPropertyName("totalBundleBytes")]
    public long TotalBundleBytes { get; set; }

    [JsonPropertyName("signature")]
    public FirmwareEnvelopeSignature Signature { get; set; } = new();
}

public sealed class FirmwareEnvelopeSignature
{
    [JsonPropertyName("algo")]
    public string Algo { get; set; } = "";

    [JsonPropertyName("value")]
    public string Value { get; set; } = "";
}

/// <summary>
/// Outcome of <see cref="FirmwareEnvelopeVerifier.Verify"/>. Carries
/// a precise reason for the failure so the supervisor can record
/// "why did we reject this payload" in the job log without losing
/// the distinction between "bad signature" and "bad schema".
/// </summary>
public enum EnvelopeVerificationResult
{
    Ok,
    SchemaUnsupported,
    AlgoUnsupported,
    SignatureMismatch,
    Malformed,
}

/// <summary>
/// HMAC-SHA256 verifier that produces the same canonical JSON the
/// TS-side <c>signEnvelope</c> signs. The two implementations have
/// to agree byte-for-byte over the canonicalisation rules — this
/// class is the contract.
///
/// Canonical JSON rules (mirrored exactly from <c>src/cli/envelope.ts</c>):
/// <list type="bullet">
///   <item>Object keys sorted lexicographically at every nesting level.</item>
///   <item>No whitespace anywhere.</item>
///   <item>Numbers serialised the same way <c>JSON.stringify</c> emits them.</item>
///   <item>Undefined values omitted; null serialises as the literal "null".</item>
/// </list>
///
/// The supervisor runs this on every uploaded payload and the
/// <c>tests/Firmware</c> suite cross-validates against the TS-emitted
/// payload to catch drift between the two implementations early.
/// </summary>
public static class FirmwareEnvelopeVerifier
{
    public const int SupportedSchema = 1;
    public const string SupportedAlgo = "hmac-sha256";

    /// <summary>
    /// Run the full verification pipeline: schema check, algo check,
    /// HMAC check. Returns a precise reason on failure so the caller
    /// can log diagnostics without exception overhead.
    /// </summary>
    public static EnvelopeVerificationResult Verify(FirmwareEnvelope envelope, ReadOnlySpan<byte> key)
    {
        if (envelope.EnvelopeSchema < 1 || envelope.EnvelopeSchema > SupportedSchema)
        {
            return EnvelopeVerificationResult.SchemaUnsupported;
        }
        if (envelope.Signature is null || !string.Equals(envelope.Signature.Algo, SupportedAlgo, StringComparison.Ordinal))
        {
            return EnvelopeVerificationResult.AlgoUnsupported;
        }

        byte[] expected;
        try
        {
            expected = Convert.FromHexString(envelope.Signature.Value);
        }
        catch (FormatException)
        {
            return EnvelopeVerificationResult.Malformed;
        }

        var canonical = CanonicalJsonForUnsigned(envelope);
        var canonicalBytes = Encoding.UTF8.GetBytes(canonical);

        Span<byte> actual = stackalloc byte[32]; // SHA-256 output size
        int written = HMACSHA256.HashData(key, canonicalBytes, actual);
        if (written != 32 || expected.Length != 32)
        {
            return EnvelopeVerificationResult.Malformed;
        }
        return CryptographicOperations.FixedTimeEquals(actual, expected)
            ? EnvelopeVerificationResult.Ok
            : EnvelopeVerificationResult.SignatureMismatch;
    }

    /// <summary>
    /// Produce the canonical JSON of an envelope minus its signature.
    /// Used as the HMAC input. Public so tests can pin down byte-for-
    /// byte equality with the TS-side <c>canonicalJson</c>.
    ///
    /// Implementation: build a <see cref="JsonObject"/> with keys
    /// inserted in lexicographic order, then serialise with
    /// <see cref="JavaScriptEncoder.UnsafeRelaxedJsonEscaping"/> and
    /// no indentation. The relaxed encoder matches JS
    /// <c>JSON.stringify</c>'s string escaping policy (only escapes
    /// the JSON-mandatory chars), and STJ's number serialiser uses
    /// the round-trip format that already agrees with JS for the
    /// integer values we carry here.
    /// </summary>
    public static string CanonicalJsonForUnsigned(FirmwareEnvelope envelope)
    {
        // JsonObject preserves insertion order — inserting in the
        // sorted order we want is the simplest way to get sorted
        // output without a custom JsonConverter. The schema is
        // tiny and flat, so explicit insertion is also the most
        // readable form.
        var node = new JsonObject
        {
            ["contentSha256"]   = string.IsNullOrWhiteSpace(envelope.ContentSha256) ? null : envelope.ContentSha256,
            ["createdAt"]        = envelope.CreatedAt,
            ["createdBy"]        = envelope.CreatedBy,
            ["envelopeSchema"]   = envelope.EnvelopeSchema,
            ["functionCount"]    = envelope.FunctionCount,
            ["manifestSha256"]   = envelope.ManifestSha256,
            ["totalBundleBytes"] = envelope.TotalBundleBytes,
            ["version"]          = envelope.Version,
        };
        if (node["contentSha256"] is null)
        {
            node.Remove("contentSha256");
        }
        return node.ToJsonString(s_canonicalOpts);
    }

    private static readonly JsonSerializerOptions s_canonicalOpts = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        WriteIndented = false,
    };

    /// <summary>
    /// Decode a key string supplied via config or env var. Accepts
    /// hex (even-length, all hex digits), then base64 / base64url —
    /// matches the TS-side <c>decodeKey</c> behaviour so an operator
    /// can paste the same secret into both sides without converting.
    /// </summary>
    public static byte[] DecodeKey(string input)
    {
        var trimmed = input.Trim();
        if (trimmed.Length > 0 && trimmed.Length % 2 == 0)
        {
            // Convert.FromHexString throws on the first non-hex
            // char — try it directly and fall through to base64
            // on failure, rather than scanning twice.
            try { return Convert.FromHexString(trimmed); }
            catch (FormatException) { /* fall through to base64 */ }
        }

        var std = trimmed.Replace('-', '+').Replace('_', '/');
        switch (std.Length % 4)
        {
            case 2: std += "=="; break;
            case 3: std += "=";  break;
        }
        try
        {
            return Convert.FromBase64String(std);
        }
        catch (FormatException)
        {
            throw new FormatException("firmware key is neither valid hex nor base64/base64url");
        }
    }

    private static readonly JsonSerializerOptions s_jsonOpts = new()
    {
        PropertyNameCaseInsensitive = false,
    };

    /// <summary>
    /// Parse the envelope.json bytes into the typed model. Throws
    /// on JSON-level malformity; semantic checks (schema, algo)
    /// happen in {@link Verify}.
    /// </summary>
    public static FirmwareEnvelope Parse(ReadOnlySpan<byte> envelopeJsonBytes)
    {
        var env = JsonSerializer.Deserialize<FirmwareEnvelope>(envelopeJsonBytes, s_jsonOpts)
            ?? throw new InvalidOperationException("envelope.json deserialised to null");
        return env;
    }
}
