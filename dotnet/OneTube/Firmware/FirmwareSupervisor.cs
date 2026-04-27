using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO.Compression;
using System.Security.Cryptography;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace OneTube.Firmware;

/// <summary>
/// The orchestrator that runs the firmware update state machine on
/// every uploaded <c>.1tube</c> payload, plus the bootloader-style
/// boot logic that picks the active version from <c>state.json</c>.
///
/// <para>
/// Lifecycle:
/// <list type="number">
///   <item>Construction (DI time): read state.json synchronously.
///         Compute <see cref="BootPrebuiltDir"/> so the active host's
///         slot factory can consume it.</item>
///   <item>StartAsync: housekeeping — wipe orphaned <c>incoming/</c>
///         dirs from a previous unclean shutdown, log the resolved
///         active version.</item>
///   <item>Runtime: <see cref="StageAsync"/> accepts uploads, runs
///         them through the state machine on a background task, and
///         exposes their progress via <see cref="GetJob"/>.</item>
///   <item>StopAsync: best-effort drain of any currently-running
///         candidate. The DI-registered active host has its own
///         StopAsync called by the .NET host.</item>
/// </list>
/// </para>
///
/// Concurrency: a <see cref="SemaphoreSlim"/> guarantees that only
/// one upload is processed end-to-end at a time. Subsequent uploads
/// queue behind it. The state machine intentionally never runs in
/// parallel because two simultaneous promotes would race on
/// <c>state.json</c> and the destination provider; serialising is
/// cheap and removes a whole class of subtle bugs.
/// </summary>
public sealed class FirmwareSupervisor : IHostedService
{
    private readonly OneTubeOptions _oneTubeOptions;
    private readonly FirmwareOptions _firmwareOptions;
    private readonly ILogger<FirmwareSupervisor> _logger;
    private readonly ILoggerFactory _loggerFactory;
    private readonly IServiceProvider _services;

    private readonly FirmwareLayout _layout;
    private readonly byte[] _signingKey;
    private readonly SemaphoreSlim _stagingLock = new(1, 1);
    private readonly ConcurrentDictionary<string, FirmwareJob> _jobs = new();

    /// <summary>
    /// The currently in-flight (non-terminal) job. Mutated only by
    /// <see cref="StageAsync"/> + <see cref="RunStateMachineAsync"/> /
    /// <see cref="RunRollbackAsync"/> via Interlocked, so readers can
    /// snapshot it lock-free for monitoring endpoints.
    /// </summary>
    private FirmwareJob? _activeJob;

    /// <summary>
    /// Prebuilt dir to point the active host at on cold boot. Reads
    /// <c>state.json.current</c> if present and resolves to
    /// <c>versions/&lt;current&gt;/dist</c>; null otherwise (active host
    /// then falls back to <see cref="OneTubeOptions.PrebuiltDir"/>).
    ///
    /// Computed once at construction so DI's resolution of the active
    /// <see cref="DenoHostService"/> can read it before any host starts.
    /// Post-boot, the supervisor mutates state via promotions but the
    /// active host's slot stays pinned to whatever it was given on
    /// construction; the side-by-side swap moves traffic via the
    /// <see cref="IGatewayDestinationProvider"/>, not by mutating the
    /// active host's slot.
    /// </summary>
    public string? BootPrebuiltDir { get; }

    /// <summary>
    /// Currently-running candidate host, when staging is mid-flight.
    /// Tracked here so <see cref="StopAsync"/> can shut it down on
    /// app exit even if a promote was interrupted.
    /// </summary>
    private DenoHostService? _liveCandidate;

    public FirmwareSupervisor(
        IOptions<OneTubeOptions> oneTubeOptions,
        IOptions<FirmwareOptions> firmwareOptions,
        ILoggerFactory loggerFactory,
        IServiceProvider services)
    {
        _oneTubeOptions = oneTubeOptions.Value;
        _firmwareOptions = firmwareOptions.Value;
        _logger = loggerFactory.CreateLogger<FirmwareSupervisor>();
        _loggerFactory = loggerFactory;
        _services = services;

        if (string.IsNullOrWhiteSpace(_oneTubeOptions.DataRoot))
        {
            throw new InvalidOperationException(
                "OneTubeOptions.DataRoot is required when the firmware supervisor is enabled.");
        }
        if (string.IsNullOrEmpty(_firmwareOptions.SharedSecret))
        {
            throw new InvalidOperationException(
                "FirmwareOptions.SharedSecret is required. Refusing to expose " +
                "/1tube/api/firmware/* without an authentication key.");
        }

        // Same host-path convention as the gateway: relative DataRoot
        // resolves against AppContext.BaseDirectory (the host's bin/),
        // so a config like "DataRoot": "onetube/data" means the same
        // thing whether the host is launched from src/, repo root, or
        // as a Windows service.
        var dataRoot = Path.IsPathRooted(_oneTubeOptions.DataRoot)
            ? _oneTubeOptions.DataRoot
            : Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, _oneTubeOptions.DataRoot));
        _layout = new FirmwareLayout(dataRoot);
        _layout.EnsureDirectories();

        try
        {
            _signingKey = FirmwareEnvelopeVerifier.DecodeKey(_firmwareOptions.SharedSecret);
        }
        catch (FormatException ex)
        {
            throw new InvalidOperationException(
                "FirmwareOptions.SharedSecret is not valid hex/base64/base64url.", ex);
        }
        if (_signingKey.Length == 0)
        {
            throw new InvalidOperationException("FirmwareOptions.SharedSecret decoded to zero bytes.");
        }

        // Resolve the boot prebuilt dir. If state.json is missing or
        // its current version's directory has been deleted out from
        // under us, log and fall through to OneTubeOptions.PrebuiltDir
        // — never silently boot with the wrong code.
        var state = FirmwareStateStore.TryRead(_layout);
        if (state?.Current is { } current)
        {
            var dir = _layout.VersionDistDir(current);
            if (Directory.Exists(dir))
            {
                BootPrebuiltDir = dir;
            }
            else
            {
                _logger.LogError(
                    "[1tube/firmware] state.json says current={Current} but {Dir} is missing; falling back to PrebuiltDir",
                    current, dir);
            }
        }
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        // Wipe orphaned incoming/<jobId>/ dirs from a previous run.
        // These can only be left over if the host crashed mid-stage,
        // and they're never needed for recovery — state.json is the
        // recovery anchor.
        try
        {
            foreach (var stale in Directory.EnumerateDirectories(_layout.IncomingDir))
            {
                try { Directory.Delete(stale, recursive: true); }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "[1tube/firmware] failed to wipe orphaned {Dir}", stale);
                }
            }
        }
        catch (DirectoryNotFoundException) { /* fresh install, fine */ }

        var state = FirmwareStateStore.TryRead(_layout);
        _logger.LogInformation(
            "[1tube/firmware] supervisor ready · current={Current} · previous={Previous} · dataRoot={DataRoot}",
            state?.Current ?? "<none>",
            state?.Previous ?? "<none>",
            _layout.Root);
        return Task.CompletedTask;
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        var candidate = Interlocked.Exchange(ref _liveCandidate, null);
        if (candidate is not null)
        {
            try { await candidate.StopAsync(cancellationToken); }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[1tube/firmware] failed to stop candidate during shutdown");
            }
        }
    }

    public FirmwareJob? GetJob(string jobId)
        => _jobs.TryGetValue(jobId, out var job) ? job : null;

    /// <summary>
    /// Snapshot of the currently in-flight job (Received → Promoting),
    /// or null when the supervisor is idle. Stable point-in-time read —
    /// the returned reference may transition to terminal state right
    /// after the snapshot is taken; callers re-poll for liveness.
    /// </summary>
    public FirmwareJob? GetActiveJob() => Volatile.Read(ref _activeJob);

    public FirmwareState? GetState() => FirmwareStateStore.TryRead(_layout);

    /// <summary>
    /// Result of attempting to pre-empt an in-flight job with a new
    /// upload. <see cref="StageAsync"/> uses this to decide whether
    /// to reject the new upload (when a promote is already underway)
    /// or to proceed (cancelling any cancellable predecessor).
    /// </summary>
    public sealed class PreemptionRefusedException : InvalidOperationException
    {
        public string ConflictingJobId { get; }
        public FirmwareJobState ConflictingState { get; }
        public PreemptionRefusedException(FirmwareJob job)
            : base($"firmware job {job.JobId} is in non-cancellable state {job.State}; retry after it completes")
        {
            ConflictingJobId = job.JobId;
            ConflictingState = job.State;
        }
    }

    /// <summary>
    /// Stage a freshly uploaded payload. Streams the request body
    /// straight to disk (zero in-memory buffering) and then kicks
    /// off the state machine on a background task. Returns the
    /// jobId immediately so the caller can poll progress.
    ///
    /// <para><b>Pre-emption:</b> if another job is already in flight,
    /// it is signalled via its CTS. The old job ends in
    /// <see cref="FirmwareJobState.Cancelled"/>, releases the
    /// staging lock, and the new job proceeds. If the in-flight
    /// job is past the cancellation deadline (mid-Promoting or
    /// terminal-but-not-yet-cleared), the upload is refused with
    /// <see cref="PreemptionRefusedException"/> — the caller
    /// should retry after polling
    /// <c>GET /1tube/api/firmware/active</c> until idle.</para>
    /// </summary>
    public async Task<string> StageAsync(
        Stream payloadStream,
        string actor,
        CancellationToken cancellationToken,
        long? totalBytes = null)
    {
        var job = CreateStageJob(actor, totalBytes ?? (payloadStream.CanSeek ? payloadStream.Length : null));
        try
        {
            await CopyPayloadAsync(job, payloadStream, cancellationToken);
        }
        catch (OperationCanceledException)
        {
            CancelUpload(job);
            ClearActiveIf(job);
            job.Cts.Dispose();
            throw;
        }

        _ = Task.Run(() => RunStateMachineAsync(job), CancellationToken.None);
        return job.JobId;
    }

    /// <summary>
    /// Starts an upload job and returns the job id before the stream has
    /// been fully copied. Used by interactive admin UIs so they can show
    /// upload progress immediately instead of waiting for the browser to
    /// finish sending a large .1tube file.
    /// </summary>
    public string BeginStageAsync(Stream payloadStream, string actor, long? totalBytes, CancellationToken cancellationToken)
    {
        var job = CreateStageJob(actor, totalBytes);
        _ = Task.Run(async () =>
        {
            try
            {
                await using (payloadStream)
                {
                    await CopyPayloadAsync(job, payloadStream, cancellationToken);
                }
                await RunStateMachineAsync(job);
            }
            catch (OperationCanceledException)
            {
                CancelUpload(job);
                ClearActiveIf(job);
                job.Cts.Dispose();
            }
            catch (Exception ex)
            {
                CleanupIncoming(job.JobId);
                Fail(job, ex);
                ClearActiveIf(job);
                job.Cts.Dispose();
            }
        }, CancellationToken.None);
        return job.JobId;
    }

    private FirmwareJob CreateStageJob(string actor, long? totalBytes)
    {
        // Refuse-or-pre-empt decision made BEFORE we touch disk so a
        // mid-promote upload doesn't leave a half-written
        // incoming/<jobId>/payload.zip lying around.
        var existing = Volatile.Read(ref _activeJob);
        if (existing is not null && !existing.State.IsTerminal())
        {
            if (existing.State.IsPastCancellationDeadline())
            {
                throw new PreemptionRefusedException(existing);
            }
            _logger.LogInformation(
                "[1tube/firmware] pre-empting in-flight job {JobId} (state={State}) for new upload from {Actor}",
                existing.JobId, existing.State, actor);
            existing.Cts.Cancel();
        }

        var jobId = Guid.NewGuid().ToString("N");
        var job = new FirmwareJob
        {
            JobId = jobId,
            Actor = actor,
            TotalBytes = totalBytes,
            UploadedBytes = 0,
            Message = "waiting for upload",
        };
        job.Timings.ReceivedAtUtc = DateTime.UtcNow.ToString("O");
        _jobs[jobId] = job;
        Interlocked.Exchange(ref _activeJob, job);

        Directory.CreateDirectory(_layout.IncomingDirFor(jobId));
        return job;
    }

    private async Task CopyPayloadAsync(FirmwareJob job, Stream payloadStream, CancellationToken cancellationToken)
    {
        Update(job, FirmwareJobState.Uploading, "uploading payload");
        var sw = Stopwatch.StartNew();
        var payloadPath = _layout.IncomingPayload(job.JobId);
        await using var fs = new FileStream(payloadPath, FileMode.Create, FileAccess.Write, FileShare.None);
        using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, job.Cts.Token);
        var ct = linkedCts.Token;
        var buffer = new byte[1024 * 1024];
        long uploaded = 0;
        var lastPublish = Stopwatch.StartNew();
        while (true)
        {
            var read = await payloadStream.ReadAsync(buffer.AsMemory(0, buffer.Length), ct);
            if (read == 0) break;
            await fs.WriteAsync(buffer.AsMemory(0, read), ct);
            uploaded += read;
            job.UploadedBytes = uploaded;
            if (lastPublish.ElapsedMilliseconds >= 200)
            {
                job.UpdatedAtUtc = DateTime.UtcNow;
                lastPublish.Restart();
            }
        }
        await fs.FlushAsync(ct);
        sw.Stop();
        job.UploadedBytes = uploaded;
        job.Timings.UploadMs = sw.ElapsedMilliseconds;
        Update(job, FirmwareJobState.Uploaded, "upload complete");
    }

    private void CancelUpload(FirmwareJob job)
    {
        CleanupIncoming(job.JobId);
        job.State = FirmwareJobState.Cancelled;
        job.Error = "upload aborted by client";
        job.Message = job.Error;
        job.UpdatedAtUtc = DateTime.UtcNow;
    }

    /// <summary>
    /// Atomic-clear of <see cref="_activeJob"/> only when the
    /// pointer still matches the given job. Avoids races where a
    /// faster successor has already overwritten the slot.
    /// </summary>
    private void ClearActiveIf(FirmwareJob job)
    {
        Interlocked.CompareExchange(ref _activeJob, null, job);
    }

    /// <summary>
    /// Promote <c>state.json.previous</c> back to <c>current</c>.
    /// Reuses the same side-by-side path as a normal upload but
    /// skips the verify+stage steps because the on-disk version is
    /// already trusted.
    /// </summary>
    public async Task<string> RollbackAsync(string actor)
    {
        var state = FirmwareStateStore.TryRead(_layout)
            ?? throw new InvalidOperationException("no state.json to roll back from");
        if (string.IsNullOrEmpty(state.Previous))
        {
            throw new InvalidOperationException("no previous version to roll back to");
        }
        if (!Directory.Exists(_layout.VersionDir(state.Previous)))
        {
            throw new InvalidOperationException($"versions/{state.Previous}/ no longer exists on disk");
        }

        // Same pre-emption protocol as StageAsync: rolling back
        // while a promote is in progress would cross-contaminate
        // state.json. Cancel any cancellable predecessor instead.
        var existing = Volatile.Read(ref _activeJob);
        if (existing is not null && !existing.State.IsTerminal())
        {
            if (existing.State.IsPastCancellationDeadline())
            {
                throw new PreemptionRefusedException(existing);
            }
            _logger.LogInformation(
                "[1tube/firmware] pre-empting in-flight job {JobId} (state={State}) for rollback by {Actor}",
                existing.JobId, existing.State, actor);
            existing.Cts.Cancel();
        }

        var jobId = Guid.NewGuid().ToString("N");
        var job = new FirmwareJob
        {
            JobId = jobId,
            Actor = actor,
            Version = state.Previous,
            State = FirmwareJobState.SmokeTesting,
        };
        job.Timings.ReceivedAtUtc = DateTime.UtcNow.ToString("O");
        _jobs[jobId] = job;
        Interlocked.Exchange(ref _activeJob, job);

        _ = Task.Run(() => RunRollbackAsync(job, state.Previous), CancellationToken.None);
        await Task.CompletedTask;
        return jobId;
    }

    // ── State machine ────────────────────────────────────────────────

    private async Task RunStateMachineAsync(FirmwareJob job)
    {
        var totalSw = Stopwatch.StartNew();
        var ct = job.Cts.Token;
        await _stagingLock.WaitAsync();
        try
        {
            // Cancellation may have arrived while we were waiting on
            // the lock (e.g. a third upload arrives while we're
            // queued behind a slow pre-emption). Bail before doing
            // any work on disk.
            if (ct.IsCancellationRequested) { Cancelled(job); return; }

            string version;
            try
            {
                // ── Unpack ───────────────────────────────────────────
                Update(job, FirmwareJobState.Unpacking, "unpacking firmware zip");
                var unpackSw = Stopwatch.StartNew();
                UnpackPayload(job);
                unpackSw.Stop();
                job.Timings.UnpackMs = unpackSw.ElapsedMilliseconds;

                // ── Verify ───────────────────────────────────────────
                Update(job, FirmwareJobState.Verifying, "verifying envelope and bundle hashes");
                var verifySw = Stopwatch.StartNew();
                version = VerifyPayload(job);
                ct.ThrowIfCancellationRequested();
                job.Version = version;
                verifySw.Stop();
                job.Timings.VerifyMs = verifySw.ElapsedMilliseconds;
                _logger.LogInformation(
                    "[1tube/firmware] {JobId} verify ok · version={Version} · {Ms}ms",
                    job.JobId, version, verifySw.ElapsedMilliseconds);

                // ── Stage ────────────────────────────────────────────
                Update(job, FirmwareJobState.Staging, "staging verified payload");
                var stageSw = Stopwatch.StartNew();
                StagePayload(job, version);
                stageSw.Stop();
                job.Timings.StageMs = stageSw.ElapsedMilliseconds;
                _logger.LogInformation(
                    "[1tube/firmware] {JobId} stage ok · {Ms}ms", job.JobId, stageSw.ElapsedMilliseconds);
                // After stage, versions/<ver>/ exists on disk. A late
                // cancellation here is still safe: we leave the
                // version dir for operator inspection, same policy as
                // a smoke-test failure.
                ct.ThrowIfCancellationRequested();
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                CleanupIncoming(job.JobId);
                Cancelled(job);
                return;
            }
            catch (Exception ex)
            {
                // Pre-stage failures clean up incoming/<jobId>/. The
                // versions/<ver>/ tree is only created during Stage,
                // so a failure before that point can't leak.
                CleanupIncoming(job.JobId);
                Fail(job, ex);
                return;
            }

            // ── Smoke test ──────────────────────────────────────────
            DenoHostService? candidate = null;
            try
            {
                Update(job, FirmwareJobState.SmokeTesting, "booting candidate gateway");
                var smokeSw = Stopwatch.StartNew();
                candidate = await SpawnCandidateAsync(version);
                _liveCandidate = candidate;
                await SmokeTestAsync(candidate, ct);
                smokeSw.Stop();
                job.Timings.SmokeMs = smokeSw.ElapsedMilliseconds;
                _logger.LogInformation(
                    "[1tube/firmware] {JobId} smoke ok · {Ms}ms", job.JobId, smokeSw.ElapsedMilliseconds);
                ct.ThrowIfCancellationRequested();
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                if (candidate is not null) await TryStopCandidateAsync(candidate);
                _liveCandidate = null;
                Cancelled(job);
                return;
            }
            catch (Exception ex)
            {
                if (candidate is not null) await TryStopCandidateAsync(candidate);
                _liveCandidate = null;
                // Note: we INTENTIONALLY keep versions/<ver>/ on disk
                // when smoke fails — operators may want to inspect
                // the bundle that broke. A later upload of the same
                // version may replace this unpromoted tree; promoted
                // versions are protected by state.json.
                Fail(job, ex);
                return;
            }

            // ── Promote ─────────────────────────────────────────────
            // From here on we IGNORE the cancellation token. The
            // atomic flip + state.json write must complete or roll
            // back as a unit; pre-empting mid-promote would leave
            // YARP, state.json, and the live workerd processes out
            // of sync. StageAsync rejects new uploads while we're in
            // this state via PreemptionRefusedException.
            try
            {
                Update(job, FirmwareJobState.Promoting, "promoting candidate gateway");
                var promoteSw = Stopwatch.StartNew();
                await PromoteAsync(job, version, candidate!);
                promoteSw.Stop();
                job.Timings.PromoteMs = promoteSw.ElapsedMilliseconds;
                CleanupIncoming(job.JobId);
                Update(job, FirmwareJobState.Done, "firmware promoted");
                _logger.LogInformation(
                    "[1tube/firmware] {JobId} promote ok · {Ms}ms", job.JobId, promoteSw.ElapsedMilliseconds);

                // ── GC (best-effort) ───────────────────────────────
                try { GarbageCollect(); }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "[1tube/firmware] GC failed (non-fatal)");
                }
            }
            catch (Exception ex)
            {
                if (candidate is not null) await TryStopCandidateAsync(candidate);
                _liveCandidate = null;
                Fail(job, ex);
            }
        }
        finally
        {
            totalSw.Stop();
            job.Timings.TotalMs = totalSw.ElapsedMilliseconds;
            job.UpdatedAtUtc = DateTime.UtcNow;
            ClearActiveIf(job);
            job.Cts.Dispose();
            _stagingLock.Release();
        }
    }

    private async Task RunRollbackAsync(FirmwareJob job, string targetVersion)
    {
        var totalSw = Stopwatch.StartNew();
        var ct = job.Cts.Token;
        await _stagingLock.WaitAsync();
        try
        {
            if (ct.IsCancellationRequested) { Cancelled(job); return; }
            DenoHostService? candidate = null;
            try
            {
                var smokeSw = Stopwatch.StartNew();
                candidate = await SpawnCandidateAsync(targetVersion);
                _liveCandidate = candidate;
                await SmokeTestAsync(candidate, ct);
                smokeSw.Stop();
                job.Timings.SmokeMs = smokeSw.ElapsedMilliseconds;
                ct.ThrowIfCancellationRequested();
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                if (candidate is not null) await TryStopCandidateAsync(candidate);
                _liveCandidate = null;
                Cancelled(job);
                return;
            }
            catch (Exception ex)
            {
                if (candidate is not null) await TryStopCandidateAsync(candidate);
                _liveCandidate = null;
                Fail(job, ex);
                return;
            }

            try
            {
                Update(job, FirmwareJobState.Promoting);
                var promoteSw = Stopwatch.StartNew();
                await PromoteAsync(job, targetVersion, candidate!);
                promoteSw.Stop();
                job.Timings.PromoteMs = promoteSw.ElapsedMilliseconds;
                Update(job, FirmwareJobState.RolledBack);
                _logger.LogInformation(
                    "[1tube/firmware] {JobId} rollback to {Version} ok · {Ms}ms",
                    job.JobId, targetVersion, promoteSw.ElapsedMilliseconds);
            }
            catch (Exception ex)
            {
                if (candidate is not null) await TryStopCandidateAsync(candidate);
                _liveCandidate = null;
                Fail(job, ex);
            }
        }
        finally
        {
            totalSw.Stop();
            job.Timings.TotalMs = totalSw.ElapsedMilliseconds;
            job.UpdatedAtUtc = DateTime.UtcNow;
            ClearActiveIf(job);
            job.Cts.Dispose();
            _stagingLock.Release();
        }
    }

    // ── Stage implementations ────────────────────────────────────────

    private void UnpackPayload(FirmwareJob job)
    {
        var unpacked = _layout.IncomingUnpacked(job.JobId);
        Directory.CreateDirectory(unpacked);
        ZipFile.ExtractToDirectory(_layout.IncomingPayload(job.JobId), unpacked);
    }

    private string VerifyPayload(FirmwareJob job)
    {
        var unpacked = _layout.IncomingUnpacked(job.JobId);
        var envelopePath = Path.Combine(unpacked, "envelope.json");
        if (!File.Exists(envelopePath))
        {
            throw new InvalidDataException("payload missing envelope.json");
        }
        var manifestPath = Path.Combine(unpacked, "dist", "manifest.json");
        if (!File.Exists(manifestPath))
        {
            throw new InvalidDataException("payload missing dist/manifest.json");
        }

        var envelopeBytes = File.ReadAllBytes(envelopePath);
        FirmwareEnvelope envelope;
        try { envelope = FirmwareEnvelopeVerifier.Parse(envelopeBytes); }
        catch (Exception ex)
        {
            throw new InvalidDataException("envelope.json malformed: " + ex.Message, ex);
        }

        var verdict = FirmwareEnvelopeVerifier.Verify(envelope, _signingKey);
        if (verdict != EnvelopeVerificationResult.Ok)
        {
            throw new InvalidDataException($"envelope verification failed: {verdict}");
        }

        // manifestSha256 binding: signature covers the envelope which
        // contains manifestSha256, so verifying the manifest's hash
        // here transitively ties every payload byte to the signature.
        var manifestBytes = File.ReadAllBytes(manifestPath);
        var manifestHash = Convert.ToHexString(SHA256.HashData(manifestBytes)).ToLowerInvariant();
        if (!string.Equals(manifestHash, envelope.ManifestSha256, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidDataException(
                $"manifest hash mismatch: envelope={envelope.ManifestSha256} actual={manifestHash}");
        }

        // Walk every per-bundle SHA-256 in the inner manifest (functions
        // and gateway-owned shared modules). The schema is shared with
        // the runtime prebuilt loader; we
        // parse it ad-hoc here to avoid pulling Deno-specific types
        // into the C# package.
        VerifyBundleHashes(unpacked, manifestBytes);

        return envelope.Version;
    }

    private static void VerifyBundleHashes(string unpackedDir, byte[] manifestBytes)
    {
        using var doc = System.Text.Json.JsonDocument.Parse(manifestBytes);
        if (!doc.RootElement.TryGetProperty("functions", out var functions) ||
            functions.ValueKind != System.Text.Json.JsonValueKind.Array)
        {
            throw new InvalidDataException("manifest.json missing functions array");
        }

        foreach (var fn in functions.EnumerateArray())
        {
            VerifyManifestBundle(unpackedDir, fn, "function");
        }

        if (doc.RootElement.TryGetProperty("sharedModules", out var sharedModules) &&
            sharedModules.ValueKind == System.Text.Json.JsonValueKind.Array)
        {
            foreach (var shared in sharedModules.EnumerateArray())
            {
                VerifyManifestBundle(unpackedDir, shared, "shared module");
            }
        }

        if (doc.RootElement.TryGetProperty("chunks", out var chunks) &&
            chunks.ValueKind == System.Text.Json.JsonValueKind.Array)
        {
            foreach (var chunk in chunks.EnumerateArray())
            {
                VerifyManifestChunk(unpackedDir, chunk);
            }
        }
    }

    private static void VerifyManifestChunk(string unpackedDir, System.Text.Json.JsonElement entry)
    {
        var file = entry.GetProperty("file").GetString()
            ?? throw new InvalidDataException("chunk entry missing file");
        var expected = entry.GetProperty("sha256").GetString()
            ?? throw new InvalidDataException("chunk entry missing sha256");

        var chunkPath = Path.Combine(unpackedDir, "dist", file);
        if (!File.Exists(chunkPath))
        {
            throw new InvalidDataException($"chunk missing on disk: {file}");
        }
        using var fs = File.OpenRead(chunkPath);
        var actual = Convert.ToHexString(SHA256.HashData(fs)).ToLowerInvariant();
        if (!string.Equals(actual, expected, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidDataException(
                $"chunk hash mismatch for {file}: expected={expected} actual={actual}");
        }
    }

    private static void VerifyManifestBundle(
        string unpackedDir,
        System.Text.Json.JsonElement entry,
        string entryKind)
    {
        var bundleFile = entry.GetProperty("bundleFile").GetString()
            ?? throw new InvalidDataException($"{entryKind} entry missing bundleFile");
        var expected = entry.GetProperty("bundleSha256").GetString()
            ?? throw new InvalidDataException($"{entryKind} entry missing bundleSha256");

        var bundlePath = Path.Combine(unpackedDir, "dist", bundleFile);
        if (!File.Exists(bundlePath))
        {
            throw new InvalidDataException($"{entryKind} bundle missing on disk: {bundleFile}");
        }
        using var fs = File.OpenRead(bundlePath);
        var actual = Convert.ToHexString(SHA256.HashData(fs)).ToLowerInvariant();
        if (!string.Equals(actual, expected, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidDataException(
                $"{entryKind} bundle hash mismatch for {bundleFile}: expected={expected} actual={actual}");
        }
    }

    private void StagePayload(FirmwareJob job, string version)
    {
        var dest = _layout.VersionDir(version);
        if (Directory.Exists(dest))
        {
            var state = FirmwareStateStore.TryRead(_layout);
            var protectedVersions = new HashSet<string>(StringComparer.Ordinal)
            {
                state?.Current ?? "",
                state?.Previous ?? "",
            };
            if (state?.History is not null)
            {
                foreach (var h in state.History) protectedVersions.Add(h.Version);
            }

            if (protectedVersions.Contains(version))
            {
                throw new InvalidOperationException(
                    $"versions/{version}/ is recorded in state.json; refusing to overwrite a promoted firmware version.");
            }

            // A failed smoke test leaves versions/<ver>/ behind for
            // inspection, but it is not referenced from state.json and
            // has never served traffic. Re-uploading the same sealed
            // artifact should be a clean retry, not a manual disk
            // cleanup exercise.
            _logger.LogWarning(
                "[1tube/firmware] replacing unpromoted stale versions/{Version} before re-stage",
                version);
            Directory.Delete(dest, recursive: true);
        }

        var unpacked = _layout.IncomingUnpacked(job.JobId);
        // Move (rename) the entire unpacked tree. Same volume → atomic.
        Directory.Move(unpacked, dest);
    }

    private async Task<DenoHostService> SpawnCandidateAsync(string version)
    {
        var active = (_services.GetService(typeof(IGatewayDestinationProvider)) as IGatewayDestinationProvider)
            ?.GetActive();
        var candidatePort = active?.Port == _oneTubeOptions.CandidatePort
            ? _oneTubeOptions.Port
            : _oneTubeOptions.CandidatePort;

        var slot = new GatewaySlot(
            "candidate",
            candidatePort,
            _layout.VersionDistDir(version));

        var logger = _loggerFactory.CreateLogger<DenoHostService>();

        // Resolve the secrets store lazily — it's only registered
        // when AddOneTubeSecrets has been called. Without it the
        // candidate boots with appCfg.EnvVars only, matching the
        // behaviour of the active host before the secrets feature
        // existed.
        var secretsStore = _services.GetService(typeof(OneTube.Secrets.SecretsStore))
            as OneTube.Secrets.SecretsStore;
        Func<IReadOnlyDictionary<string, string>?>? secretsProvider = secretsStore is null
            ? null
            : () => secretsStore.Snapshot();

        var candidate = new DenoHostService(_oneTubeOptions, slot, logger, secretsProvider);
        await candidate.StartAsync(CancellationToken.None);
        return candidate;
    }

    private async Task SmokeTestAsync(DenoHostService candidate, CancellationToken externalCt = default)
    {
        // Smoke timeout AND the caller's pre-emption signal both
        // abort the probe loop. Linking the two avoids waiting up
        // to SmokeTimeoutMs after a pre-emption arrives.
        using var timeoutCts = new CancellationTokenSource(_firmwareOptions.SmokeTimeoutMs);
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(timeoutCts.Token, externalCt);
        var deadline = DateTime.UtcNow.AddMilliseconds(_firmwareOptions.SmokeTimeoutMs);

        while (DateTime.UtcNow < deadline)
        {
            cts.Token.ThrowIfCancellationRequested();
            if (!candidate.IsRunning || candidate.RestartCount > 0)
            {
                var tail = candidate.LastStderrTailForDiagnostics;
                throw new InvalidOperationException(
                    "candidate gateway exited before becoming healthy" +
                    (string.IsNullOrWhiteSpace(tail)
                        ? ""
                        : $"{Environment.NewLine}{tail}"));
            }
            if (await candidate.ProbeHealthAsync(cts.Token))
            {
                // Optional: ping the configured smoke function. A 2xx
                // is treated as success; anything else fails the smoke
                // test and rolls the candidate back.
                if (!string.IsNullOrEmpty(_firmwareOptions.SmokeFunctionName))
                {
                    using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
                    var url = $"{candidate.DestinationBaseUrl}/functions/v1/{_firmwareOptions.SmokeFunctionName}";
                    try
                    {
                        using var resp = await http.GetAsync(url, cts.Token);
                        if (!resp.IsSuccessStatusCode)
                        {
                            throw new InvalidOperationException(
                                $"smoke function {_firmwareOptions.SmokeFunctionName} returned {(int)resp.StatusCode}");
                        }
                    }
                    catch (HttpRequestException ex)
                    {
                        throw new InvalidOperationException(
                            $"smoke function {_firmwareOptions.SmokeFunctionName} request failed: {ex.Message}", ex);
                    }
                }
                return;
            }
            try { await Task.Delay(250, cts.Token); }
            catch (OperationCanceledException) { break; }
        }

        throw new TimeoutException(
            $"candidate did not become healthy within {_firmwareOptions.SmokeTimeoutMs}ms");
    }

    private async Task PromoteAsync(FirmwareJob job, string version, DenoHostService candidate)
    {
        // Preserve a snapshot of the previous state so we can roll
        // back state.json if the post-write half explodes.
        var previousState = FirmwareStateStore.TryRead(_layout) ?? new FirmwareState();

        var newState = new FirmwareState
        {
            SchemaVersion = FirmwareState.CurrentSchema,
            Current = version,
            Previous = previousState.Current, // old current becomes previous
            History = new List<FirmwareHistoryEntry>(previousState.History)
            {
                new()
                {
                    Version = version,
                    PromotedAt = DateTime.UtcNow.ToString("O"),
                    EnvelopeManifestSha256 = ReadEnvelopeManifestSha256(version),
                },
            },
        };

        FirmwareStateStore.Write(_layout, newState);

        await SwapDestinationAndDrainAsync(job, candidate);
    }

    /// <summary>
    /// The version-agnostic half of a promote: resolve the swappable
    /// destination provider, atomically flip it to the supplied
    /// candidate, drain the old host. Used by both
    /// <see cref="PromoteAsync"/> (which writes state.json before
    /// calling) and <see cref="RunReloadAsync"/> (which doesn't —
    /// the version doesn't change on a config reload).
    ///
    /// <para>Atomicity guarantee: from <see cref="SwappableDestinationProvider.Swap"/>
    /// onwards, every NEW request hits the candidate. In-flight
    /// requests already routed to the old host complete on it
    /// because <c>MapOneTube</c> resolves the destination once at
    /// the top of the request, not per-hop.</para>
    /// </summary>
    private async Task SwapDestinationAndDrainAsync(FirmwareJob job, DenoHostService candidate)
    {
        var provider = _services.GetService(typeof(IGatewayDestinationProvider))
            as SwappableDestinationProvider
            ?? throw new InvalidOperationException(
                "FirmwareSupervisor requires SwappableDestinationProvider; " +
                "AddOneTubeFirmware was not called or the registration was overridden.");

        var old = provider.Swap(candidate);
        _liveCandidate = null;

        // Drain + stop the old host. We bound the wait so an old
        // gateway with a hung in-flight request doesn't block the
        // promotion forever; the worst case is some late 502s as
        // the old gateway is force-killed, never a hung dirty state.
        if (old is not null)
        {
            var drainSw = Stopwatch.StartNew();
            using var drainCts = new CancellationTokenSource(_firmwareOptions.DrainGraceMs);
            try { await old.StopAsync(drainCts.Token); }
            catch (Exception ex)
            {
                _logger.LogWarning(ex,
                    "[1tube/firmware] {JobId} old host stop errored (non-fatal — host is gone either way)",
                    job.JobId);
            }
            drainSw.Stop();
            job.Timings.DrainMs = drainSw.ElapsedMilliseconds;
        }
    }

    /// <summary>
    /// Re-spawn the gateway at the currently-active version with a
    /// freshly-snapshotted environment. Used by the secrets watcher
    /// to make edits visible to the next request without dropping
    /// any in-flight ones. State.json is NOT mutated — neither
    /// <c>current</c> nor <c>previous</c> changes; the rollback
    /// target stays exactly where it was.
    ///
    /// <para>Pre-emption: identical to <see cref="StageAsync"/> /
    /// <see cref="RollbackAsync"/>. A reload arriving during a
    /// promote refuses with <see cref="PreemptionRefusedException"/>;
    /// during another reload it cancels the older one. Two reloads
    /// in quick succession therefore coalesce into the most recent
    /// snapshot, which is the desired behaviour for a UI that
    /// rapid-saves edits.</para>
    /// </summary>
    public async Task<string> RebootCurrentAsync(string actor)
    {
        var state = FirmwareStateStore.TryRead(_layout)
            ?? throw new InvalidOperationException("no state.json — cannot reload until at least one firmware version has been promoted");
        if (string.IsNullOrEmpty(state.Current))
        {
            throw new InvalidOperationException("no current version to reload (state.json.current is empty)");
        }
        if (!Directory.Exists(_layout.VersionDir(state.Current)))
        {
            throw new InvalidOperationException($"versions/{state.Current}/ no longer exists on disk");
        }

        var existing = Volatile.Read(ref _activeJob);
        if (existing is not null && !existing.State.IsTerminal())
        {
            if (existing.State.IsPastCancellationDeadline())
            {
                throw new PreemptionRefusedException(existing);
            }
            _logger.LogInformation(
                "[1tube/firmware] pre-empting in-flight job {JobId} (state={State}) for config reload by {Actor}",
                existing.JobId, existing.State, actor);
            existing.Cts.Cancel();
        }

        var jobId = Guid.NewGuid().ToString("N");
        var job = new FirmwareJob
        {
            JobId = jobId,
            Actor = actor,
            Version = state.Current,
            State = FirmwareJobState.SmokeTesting,
        };
        job.Timings.ReceivedAtUtc = DateTime.UtcNow.ToString("O");
        _jobs[jobId] = job;
        Interlocked.Exchange(ref _activeJob, job);

        _ = Task.Run(() => RunReloadAsync(job, state.Current), CancellationToken.None);
        await Task.CompletedTask;
        return jobId;
    }

    private async Task RunReloadAsync(FirmwareJob job, string version)
    {
        var totalSw = Stopwatch.StartNew();
        var ct = job.Cts.Token;
        await _stagingLock.WaitAsync();
        try
        {
            if (ct.IsCancellationRequested) { Cancelled(job); return; }

            DenoHostService? candidate = null;
            try
            {
                var smokeSw = Stopwatch.StartNew();
                candidate = await SpawnCandidateAsync(version);
                _liveCandidate = candidate;
                await SmokeTestAsync(candidate, ct);
                smokeSw.Stop();
                job.Timings.SmokeMs = smokeSw.ElapsedMilliseconds;
                ct.ThrowIfCancellationRequested();
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                if (candidate is not null) await TryStopCandidateAsync(candidate);
                _liveCandidate = null;
                Cancelled(job);
                return;
            }
            catch (Exception ex)
            {
                if (candidate is not null) await TryStopCandidateAsync(candidate);
                _liveCandidate = null;
                Fail(job, ex);
                return;
            }

            try
            {
                Update(job, FirmwareJobState.Promoting);
                var swapSw = Stopwatch.StartNew();
                await SwapDestinationAndDrainAsync(job, candidate!);
                swapSw.Stop();
                job.Timings.PromoteMs = swapSw.ElapsedMilliseconds;
                Update(job, FirmwareJobState.Done);
                _logger.LogInformation(
                    "[1tube/firmware] {JobId} config reload at version {Version} ok · {Ms}ms",
                    job.JobId, version, swapSw.ElapsedMilliseconds);
            }
            catch (Exception ex)
            {
                if (candidate is not null) await TryStopCandidateAsync(candidate);
                _liveCandidate = null;
                Fail(job, ex);
            }
        }
        finally
        {
            totalSw.Stop();
            job.Timings.TotalMs = totalSw.ElapsedMilliseconds;
            job.UpdatedAtUtc = DateTime.UtcNow;
            ClearActiveIf(job);
            job.Cts.Dispose();
            _stagingLock.Release();
        }
    }

    private string ReadEnvelopeManifestSha256(string version)
    {
        var path = _layout.VersionEnvelopePath(version);
        if (!File.Exists(path)) return "";
        try
        {
            var env = FirmwareEnvelopeVerifier.Parse(File.ReadAllBytes(path));
            return env.ManifestSha256;
        }
        catch { return ""; }
    }

    // ── GC ──────────────────────────────────────────────────────────

    /// <summary>
    /// Keep the most recent <see cref="FirmwareOptions.RetainVersions"/>
    /// versions on disk. <c>current</c> and <c>previous</c> are pinned
    /// regardless of the retention window — losing the previous slot
    /// would defeat the rollback path. Best-effort: any errors are
    /// logged and swallowed so a flaky disk doesn't fail the promote.
    /// </summary>
    private void GarbageCollect()
    {
        var state = FirmwareStateStore.TryRead(_layout);
        if (state is null) return;

        var pinned = new HashSet<string>(StringComparer.Ordinal);
        if (!string.IsNullOrEmpty(state.Current)) pinned.Add(state.Current);
        if (!string.IsNullOrEmpty(state.Previous)) pinned.Add(state.Previous);

        var allDirs = Directory.EnumerateDirectories(_layout.VersionsDir)
            .Select(d => new DirectoryInfo(d))
            .OrderByDescending(d => d.CreationTimeUtc)
            .ToList();

        var keep = new HashSet<string>(pinned, StringComparer.Ordinal);
        var keepCount = Math.Max(2, _firmwareOptions.RetainVersions);
        foreach (var dir in allDirs)
        {
            if (keep.Count >= keepCount) break;
            keep.Add(dir.Name);
        }

        foreach (var dir in allDirs)
        {
            if (keep.Contains(dir.Name)) continue;
            try
            {
                dir.Delete(recursive: true);
                _logger.LogInformation("[1tube/firmware] GC removed versions/{Version}", dir.Name);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex,
                    "[1tube/firmware] GC failed to remove versions/{Version}", dir.Name);
            }
        }
    }

    // ── Helpers ─────────────────────────────────────────────────────

    private void CleanupIncoming(string jobId)
    {
        try
        {
            var dir = _layout.IncomingDirFor(jobId);
            if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[1tube/firmware] failed to clean up incoming/{JobId}", jobId);
        }
    }

    private async Task TryStopCandidateAsync(DenoHostService candidate)
    {
        try { await candidate.StopAsync(CancellationToken.None); }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[1tube/firmware] failed to stop candidate during failure cleanup");
        }
    }

    private void Update(FirmwareJob job, FirmwareJobState state, string? message = null)
    {
        job.State = state;
        if (message is not null) job.Message = message;
        job.UpdatedAtUtc = DateTime.UtcNow;
    }

    private void Cancelled(FirmwareJob job)
    {
        job.State = FirmwareJobState.Cancelled;
        job.Error = "pre-empted by a later upload or rollback";
        job.Message = job.Error;
        job.UpdatedAtUtc = DateTime.UtcNow;
        _logger.LogInformation(
            "[1tube/firmware] {JobId} cancelled cleanly (pre-empted)", job.JobId);
    }

    private void Fail(FirmwareJob job, Exception ex)
    {
        job.State = FirmwareJobState.Failed;
        job.Error = ex.Message;
        job.Message = ex.Message;
        job.UpdatedAtUtc = DateTime.UtcNow;
        _logger.LogError(ex,
            "[1tube/firmware] {JobId} failed at {Stage}: {Message}",
            job.JobId, job.State, ex.Message);
    }
}
