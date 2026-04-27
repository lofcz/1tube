using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using OneTube.Firmware;

namespace OneTube.Secrets;

/// <summary>
/// Bridges <see cref="SecretsStore.Changed"/> events to a
/// debounced call into <see cref="FirmwareSupervisor.RebootCurrentAsync"/>.
///
/// <para>The contract: <em>the next request after a successful
/// secret edit must observe the new value</em>. The implementation:
/// each Changed event resets a debounce timer; when the timer
/// fires (default 500 ms after the last edit), the watcher kicks
/// off a side-by-side gateway swap that snapshots the current
/// secrets dictionary and starts a fresh candidate with that env.
/// On promote, in-flight requests on the old child finish on the
/// old child; new requests land on the new child with the new env.
/// No request is ever served with a half-applied state.</para>
///
/// <para>If the supervisor is mid-promote (firmware update in
/// flight), the reload is rejected with
/// <see cref="FirmwareSupervisor.PreemptionRefusedException"/> and
/// the watcher retries with backoff. We don't drop the change —
/// SecretsStore.Snapshot() always reflects the latest values, so
/// retrying just means the eventual reload picks them all up.</para>
/// </summary>
public sealed class SecretsHotSwapWatcher : IHostedService, IDisposable
{
    private readonly SecretsStore _store;
    private readonly FirmwareSupervisor _supervisor;
    private readonly ILogger<SecretsHotSwapWatcher> _logger;
    private readonly int _debounceMs;

    private readonly object _timerLock = new();
    private System.Threading.Timer? _timer;
    private bool _disposed;
    private int _pendingEdits;
    private long _generation;
    private SecretsApplyStatus _status = SecretsApplyStatus.Idle();

    public event Action? StatusChanged;

    public SecretsHotSwapWatcher(
        SecretsStore store,
        FirmwareSupervisor supervisor,
        IOptions<SecretsOptions> options,
        ILogger<SecretsHotSwapWatcher> logger)
    {
        _store = store;
        _supervisor = supervisor;
        _logger = logger;
        _debounceMs = Math.Max(0, options.Value.ReloadDebounceMs);
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        // Subscribe AFTER construction so the load-time empty-store
        // fire (if any) is suppressed. We deliberately do NOT trigger
        // a reload at boot — the active host already booted with
        // whatever secrets.json contained at startup time.
        _store.Changed += OnChanged;
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        _store.Changed -= OnChanged;
        lock (_timerLock)
        {
            _timer?.Dispose();
            _timer = null;
        }
        return Task.CompletedTask;
    }

    public SecretsApplyStatus GetStatus() => Volatile.Read(ref _status);

    private void OnChanged()
    {
        if (_disposed) return;
        var generation = Interlocked.Increment(ref _generation);
        var pending = Interlocked.Increment(ref _pendingEdits);
        SetStatus(new SecretsApplyStatus(
            Generation: generation,
            State: SecretsApplyState.Pending,
            PendingEdits: pending,
            JobId: null,
            JobState: null,
            Message: _debounceMs > 0
                ? $"Waiting {_debounceMs} ms for additional secret edits before hot-swap."
                : "Secret edit queued for gateway hot-swap.",
            UpdatedAtUtc: DateTime.UtcNow));

        // Single-shot timer pattern: reschedule on every edit so a
        // burst of N edits triggers exactly one reload. The timer
        // callback runs on the threadpool so the API thread that
        // wrote the secret is never blocked on the gateway swap.
        lock (_timerLock)
        {
            if (_disposed) return;
            if (_timer is null)
            {
                _timer = new System.Threading.Timer(static state => ((SecretsHotSwapWatcher)state!).Fire(),
                    this, _debounceMs, Timeout.Infinite);
            }
            else
            {
                _timer.Change(_debounceMs, Timeout.Infinite);
            }
        }
    }

    private void Fire()
    {
        var pending = Interlocked.Exchange(ref _pendingEdits, 0);
        if (pending <= 0) return;
        var generation = Volatile.Read(ref _generation);
        _ = TriggerReloadAsync(generation, pending);
    }

    private async Task TriggerReloadAsync(long generation, int coalescedEdits)
    {
        const int maxAttempts = 6;
        var delayMs = 250;
        for (var attempt = 1; attempt <= maxAttempts; attempt++)
        {
            try
            {
                SetStatusIfCurrent(generation, new SecretsApplyStatus(
                    Generation: generation,
                    State: SecretsApplyState.Applying,
                    PendingEdits: coalescedEdits,
                    JobId: null,
                    JobState: null,
                    Message: "Starting gateway hot-swap so the new secrets become live.",
                    UpdatedAtUtc: DateTime.UtcNow));
                var jobId = await _supervisor.RebootCurrentAsync(actor: "secrets-watcher");
                SetStatusIfCurrent(generation, new SecretsApplyStatus(
                    Generation: generation,
                    State: SecretsApplyState.Applying,
                    PendingEdits: 0,
                    JobId: jobId,
                    JobState: FirmwareJobState.SmokeTesting.ToString(),
                    Message: "Gateway hot-swap started; waiting until the new child is promoted.",
                    UpdatedAtUtc: DateTime.UtcNow));
                _logger.LogInformation(
                    "[1tube/secrets] reload kicked off · jobId={JobId} · coalesced {Edits} edit(s)",
                    jobId, coalescedEdits);
                await MonitorJobAsync(generation, jobId);
                return;
            }
            catch (FirmwareSupervisor.PreemptionRefusedException ex)
            {
                // A firmware promote is mid-flight; retry shortly.
                // We don't treat this as a fatal error because the
                // store's Snapshot() always reflects the latest
                // edits — the eventual reload picks them up.
                _logger.LogInformation(
                    "[1tube/secrets] reload deferred (firmware promote in progress, attempt {Attempt}/{Max}): {Reason}",
                    attempt, maxAttempts, ex.Message);
                if (attempt == maxAttempts)
                {
                    _logger.LogWarning(
                        "[1tube/secrets] giving up after {Max} attempts; secrets WILL apply once " +
                        "the next gateway reload or promote picks up the latest snapshot.",
                        maxAttempts);
                    SetStatusIfCurrent(generation, new SecretsApplyStatus(
                        Generation: generation,
                        State: SecretsApplyState.Deferred,
                        PendingEdits: 0,
                        JobId: ex.ConflictingJobId,
                        JobState: ex.ConflictingState.ToString(),
                        Message: "Secrets are saved, but a firmware promote is in progress. They will apply on the next gateway reload or promote.",
                        UpdatedAtUtc: DateTime.UtcNow));
                    return;
                }
                SetStatusIfCurrent(generation, new SecretsApplyStatus(
                    Generation: generation,
                    State: SecretsApplyState.Pending,
                    PendingEdits: coalescedEdits,
                    JobId: ex.ConflictingJobId,
                    JobState: ex.ConflictingState.ToString(),
                    Message: $"Firmware promote is busy; retrying secret hot-swap in {delayMs} ms.",
                    UpdatedAtUtc: DateTime.UtcNow));
                await Task.Delay(delayMs);
                delayMs = Math.Min(delayMs * 2, 4000);
            }
            catch (InvalidOperationException ex)
            {
                // No state.json yet (no firmware ever promoted).
                // Not an error — secrets just take effect on the
                // next firmware promote / next host restart.
                _logger.LogInformation(
                    "[1tube/secrets] reload skipped (no current firmware version): {Reason}. " +
                    "Edits are persisted to secrets.json and will apply on next promote.",
                    ex.Message);
                SetStatusIfCurrent(generation, new SecretsApplyStatus(
                    Generation: generation,
                    State: SecretsApplyState.Deferred,
                    PendingEdits: 0,
                    JobId: null,
                    JobState: null,
                    Message: "Secrets are saved but no firmware version is active yet; they will apply on the next promote or host restart.",
                    UpdatedAtUtc: DateTime.UtcNow));
                return;
            }
            catch (Exception ex)
            {
                // Unexpected — log and stop. We don't want the
                // background loop to spin forever on a permanent
                // misconfiguration.
                _logger.LogError(ex, "[1tube/secrets] reload failed; giving up");
                SetStatusIfCurrent(generation, new SecretsApplyStatus(
                    Generation: generation,
                    State: SecretsApplyState.Failed,
                    PendingEdits: 0,
                    JobId: null,
                    JobState: null,
                    Message: "Secret hot-swap failed: " + ex.Message,
                    UpdatedAtUtc: DateTime.UtcNow));
                return;
            }
        }
    }

    private async Task MonitorJobAsync(long generation, string jobId)
    {
        var deadline = DateTime.UtcNow.AddMinutes(30);
        while (!_disposed && Volatile.Read(ref _generation) == generation && DateTime.UtcNow < deadline)
        {
            var job = _supervisor.GetJob(jobId);
            if (job is null)
            {
                SetStatusIfCurrent(generation, new SecretsApplyStatus(
                    Generation: generation,
                    State: SecretsApplyState.Failed,
                    PendingEdits: 0,
                    JobId: jobId,
                    JobState: null,
                    Message: "Secret hot-swap job disappeared before completion.",
                    UpdatedAtUtc: DateTime.UtcNow));
                return;
            }

            var state = job.State;
            if (state == FirmwareJobState.Done)
            {
                SetStatusIfCurrent(generation, new SecretsApplyStatus(
                    Generation: generation,
                    State: SecretsApplyState.Applied,
                    PendingEdits: 0,
                    JobId: jobId,
                    JobState: state.ToString(),
                    Message: "New secrets are live for new gateway requests.",
                    UpdatedAtUtc: DateTime.UtcNow));
                return;
            }
            if (state.IsTerminal())
            {
                SetStatusIfCurrent(generation, new SecretsApplyStatus(
                    Generation: generation,
                    State: SecretsApplyState.Failed,
                    PendingEdits: 0,
                    JobId: jobId,
                    JobState: state.ToString(),
                    Message: "Secret hot-swap did not apply: " + (job.Error ?? job.Message ?? state.ToString()),
                    UpdatedAtUtc: DateTime.UtcNow));
                return;
            }

            SetStatusIfCurrent(generation, new SecretsApplyStatus(
                Generation: generation,
                State: SecretsApplyState.Applying,
                PendingEdits: 0,
                JobId: jobId,
                JobState: state.ToString(),
                Message: "Gateway hot-swap in progress: " + (job.Message ?? state.ToString()),
                UpdatedAtUtc: DateTime.UtcNow));
            await Task.Delay(500);
        }

        if (Volatile.Read(ref _generation) == generation)
        {
            SetStatusIfCurrent(generation, new SecretsApplyStatus(
                Generation: generation,
                State: SecretsApplyState.Failed,
                PendingEdits: 0,
                JobId: jobId,
                JobState: null,
                Message: "Secret hot-swap did not finish within 30 minutes.",
                UpdatedAtUtc: DateTime.UtcNow));
        }
    }

    private void SetStatusIfCurrent(long generation, SecretsApplyStatus status)
    {
        if (Volatile.Read(ref _generation) != generation) return;
        SetStatus(status);
    }

    private void SetStatus(SecretsApplyStatus status)
    {
        Volatile.Write(ref _status, status);
        StatusChanged?.Invoke();
    }

    public void Dispose()
    {
        _disposed = true;
        lock (_timerLock)
        {
            _timer?.Dispose();
            _timer = null;
        }
    }
}

public enum SecretsApplyState
{
    Idle,
    Pending,
    Applying,
    Applied,
    Deferred,
    Failed,
}

public sealed record SecretsApplyStatus(
    long Generation,
    SecretsApplyState State,
    int PendingEdits,
    string? JobId,
    string? JobState,
    string Message,
    DateTime UpdatedAtUtc)
{
    public static SecretsApplyStatus Idle() => new(
        Generation: 0,
        State: SecretsApplyState.Idle,
        PendingEdits: 0,
        JobId: null,
        JobState: null,
        Message: "No pending secret changes.",
        UpdatedAtUtc: DateTime.UtcNow);

    public object ToSnapshot() => new
    {
        generation = Generation,
        state = State.ToString(),
        pendingEdits = PendingEdits,
        jobId = JobId,
        jobState = JobState,
        message = Message,
        updatedAtUtc = UpdatedAtUtc.ToString("O"),
    };
}
