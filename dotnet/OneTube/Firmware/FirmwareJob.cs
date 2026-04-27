using System.Text.Json.Serialization;

namespace OneTube.Firmware;

/// <summary>
/// Discrete states a firmware job can be in. Mirrors the diagram in
/// the protocol plan. Any terminal state (<c>Done</c>, <c>Failed</c>,
/// <c>RolledBack</c>) is the end of the line for that job — the same
/// JobId never resurrects.
/// </summary>
public enum FirmwareJobState
{
    Received,
    Uploading,
    Uploaded,
    Unpacking,
    Verifying,
    Staging,
    SmokeTesting,
    Promoting,
    Done,
    Failed,
    RolledBack,
    /// <summary>
    /// Pre-empted by a later upload. The job ended cleanly without
    /// touching the active version — incoming/&lt;jobId&gt;/ was deleted
    /// and any candidate spawned for it was stopped.
    /// </summary>
    Cancelled,
}

/// <summary>
/// Whether a state is terminal (the job will never transition again).
/// New uploads can pre-empt non-terminal jobs but must wait for
/// terminal ones to release the lock on their own.
/// </summary>
public static class FirmwareJobStateExtensions
{
    public static bool IsTerminal(this FirmwareJobState s) => s switch
    {
        FirmwareJobState.Done or
        FirmwareJobState.Failed or
        FirmwareJobState.RolledBack or
        FirmwareJobState.Cancelled => true,
        _ => false,
    };

    /// <summary>
    /// Once Promoting begins, the side-by-side flip is in motion and
    /// state.json is about to be (or has been) rewritten — interrupting
    /// here would leave the destination provider, the live workerd
    /// processes, and the on-disk state desynchronised. Cancellation
    /// requests after this point are refused.
    /// </summary>
    public static bool IsPastCancellationDeadline(this FirmwareJobState s)
        => s is FirmwareJobState.Promoting or FirmwareJobState.Done
              or FirmwareJobState.RolledBack or FirmwareJobState.Failed
              or FirmwareJobState.Cancelled;
}

/// <summary>
/// Per-job timing record. Optional fields stay null until the
/// corresponding stage runs; serialised to JSON for the
/// <c>GET jobs/{id}</c> endpoint.
/// </summary>
public sealed class FirmwareJobTimings
{
    [JsonPropertyName("receivedAtUtc")]   public string? ReceivedAtUtc { get; set; }
    [JsonPropertyName("uploadMs")]        public long? UploadMs { get; set; }
    [JsonPropertyName("unpackMs")]        public long? UnpackMs { get; set; }
    [JsonPropertyName("verifyMs")]        public long? VerifyMs { get; set; }
    [JsonPropertyName("stageMs")]         public long? StageMs { get; set; }
    [JsonPropertyName("smokeMs")]         public long? SmokeMs { get; set; }
    [JsonPropertyName("promoteMs")]       public long? PromoteMs { get; set; }
    [JsonPropertyName("drainMs")]         public long? DrainMs { get; set; }
    [JsonPropertyName("totalMs")]         public long? TotalMs { get; set; }
}

/// <summary>
/// In-memory job record. The supervisor publishes a snapshot of
/// this through <c>GET /1tube/api/firmware/jobs/{id}</c>. Not
/// persisted to disk — jobs are an inspection surface for the
/// promote pipeline, not a recovery log. The <c>state.json</c> file
/// is the recovery anchor; jobs evaporate on host restart, which
/// is fine because any job that didn't reach Done already had its
/// staging cleaned up by the failure path.
/// </summary>
public sealed class FirmwareJob
{
    public required string JobId { get; init; }
    public required string Actor { get; init; }
    public FirmwareJobState State { get; set; } = FirmwareJobState.Received;
    public string? Version { get; set; }
    public string? Error { get; set; }
    public string? Message { get; set; }
    public long? UploadedBytes { get; set; }
    public long? TotalBytes { get; set; }
    public FirmwareJobTimings Timings { get; init; } = new();
    public DateTime CreatedAtUtc { get; init; } = DateTime.UtcNow;
    public DateTime UpdatedAtUtc { get; set; } = DateTime.UtcNow;

    /// <summary>
    /// Per-job cancellation source. Pre-emption of an in-flight job
    /// by a later upload signals this CTS; the state machine checks
    /// it at every phase boundary up to (but not including)
    /// Promoting. The supervisor disposes the CTS once the job
    /// reaches a terminal state.
    /// </summary>
    public CancellationTokenSource Cts { get; } = new();

    /// <summary>
    /// Snapshot suitable for JSON serialisation back to a caller
    /// of <c>GET /1tube/api/firmware/jobs/{id}</c>. Pure DTO — no
    /// references back into supervisor mutable state.
    /// </summary>
    public object ToSnapshot() => new
    {
        jobId = JobId,
        state = State.ToString(),
        version = Version,
        error = Error,
        message = Message,
        uploadedBytes = UploadedBytes,
        totalBytes = TotalBytes,
        uploadPercent = TotalBytes is > 0 && UploadedBytes is long uploaded
            ? Math.Round(uploaded * 100.0 / TotalBytes.Value, 1)
            : (double?)null,
        actor = Actor,
        timings = Timings,
        createdAtUtc = CreatedAtUtc.ToString("O"),
        updatedAtUtc = UpdatedAtUtc.ToString("O"),
    };
}
