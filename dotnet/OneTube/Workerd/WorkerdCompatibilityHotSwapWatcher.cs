using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using OneTube.Firmware;

namespace OneTube.Workerd;

public sealed class WorkerdCompatibilityHotSwapWatcher : IHostedService, IDisposable
{
    private readonly WorkerdCompatibilityStore _store;
    private readonly FirmwareSupervisor _supervisor;
    private readonly ILogger<WorkerdCompatibilityHotSwapWatcher> _logger;
    private readonly int _debounceMs;
    private readonly object _timerLock = new();
    private System.Threading.Timer? _timer;
    private bool _disposed;
    private int _pendingEdits;
    private long _generation;
    private WorkerdCompatibilityApplyStatus _status = WorkerdCompatibilityApplyStatus.Idle();

    public event Action? StatusChanged;

    public WorkerdCompatibilityHotSwapWatcher(
        WorkerdCompatibilityStore store,
        FirmwareSupervisor supervisor,
        IOptions<WorkerdCompatibilityOptions> options,
        ILogger<WorkerdCompatibilityHotSwapWatcher> logger)
    {
        _store = store;
        _supervisor = supervisor;
        _logger = logger;
        _debounceMs = Math.Max(0, options.Value.ReloadDebounceMs);
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
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

    public WorkerdCompatibilityApplyStatus GetStatus() => Volatile.Read(ref _status);

    private void OnChanged()
    {
        if (_disposed) return;
        var generation = Interlocked.Increment(ref _generation);
        var pending = Interlocked.Increment(ref _pendingEdits);
        SetStatus(new WorkerdCompatibilityApplyStatus(
            Generation: generation,
            State: WorkerdCompatibilityApplyState.Pending,
            PendingEdits: pending,
            JobId: null,
            JobState: null,
            Message: _debounceMs > 0
                ? $"Waiting {_debounceMs} ms for additional workerd compatibility edits before hot-swap."
                : "Workerd compatibility edit queued for gateway hot-swap.",
            UpdatedAtUtc: DateTime.UtcNow));

        lock (_timerLock)
        {
            if (_disposed) return;
            if (_timer is null)
            {
                _timer = new System.Threading.Timer(static state => ((WorkerdCompatibilityHotSwapWatcher)state!).Fire(),
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
                SetStatusIfCurrent(generation, new WorkerdCompatibilityApplyStatus(
                    Generation: generation,
                    State: WorkerdCompatibilityApplyState.Applying,
                    PendingEdits: coalescedEdits,
                    JobId: null,
                    JobState: null,
                    Message: "Starting gateway hot-swap so the new workerd compatibility settings become live.",
                    UpdatedAtUtc: DateTime.UtcNow));
                var jobId = await _supervisor.RebootCurrentAsync(actor: "workerd-compatibility-watcher");
                SetStatusIfCurrent(generation, new WorkerdCompatibilityApplyStatus(
                    Generation: generation,
                    State: WorkerdCompatibilityApplyState.Applying,
                    PendingEdits: 0,
                    JobId: jobId,
                    JobState: FirmwareJobState.SmokeTesting.ToString(),
                    Message: "Gateway hot-swap started; waiting until the new child is promoted.",
                    UpdatedAtUtc: DateTime.UtcNow));
                _logger.LogInformation(
                    "[1tube/workerd] compatibility reload kicked off · jobId={JobId} · coalesced {Edits} edit(s)",
                    jobId, coalescedEdits);
                await MonitorJobAsync(generation, jobId);
                return;
            }
            catch (FirmwareSupervisor.PreemptionRefusedException ex)
            {
                if (attempt == maxAttempts)
                {
                    SetStatusIfCurrent(generation, new WorkerdCompatibilityApplyStatus(
                        Generation: generation,
                        State: WorkerdCompatibilityApplyState.Deferred,
                        PendingEdits: 0,
                        JobId: ex.ConflictingJobId,
                        JobState: ex.ConflictingState.ToString(),
                        Message: "Settings are saved, but a firmware promote is in progress. They will apply on the next gateway reload or promote.",
                        UpdatedAtUtc: DateTime.UtcNow));
                    return;
                }
                SetStatusIfCurrent(generation, new WorkerdCompatibilityApplyStatus(
                    Generation: generation,
                    State: WorkerdCompatibilityApplyState.Pending,
                    PendingEdits: coalescedEdits,
                    JobId: ex.ConflictingJobId,
                    JobState: ex.ConflictingState.ToString(),
                    Message: $"Firmware promote is busy; retrying workerd compatibility hot-swap in {delayMs} ms.",
                    UpdatedAtUtc: DateTime.UtcNow));
                await Task.Delay(delayMs);
                delayMs = Math.Min(delayMs * 2, 4000);
            }
            catch (InvalidOperationException ex)
            {
                _logger.LogInformation(
                    "[1tube/workerd] compatibility reload skipped (no current firmware version): {Reason}.",
                    ex.Message);
                SetStatusIfCurrent(generation, new WorkerdCompatibilityApplyStatus(
                    Generation: generation,
                    State: WorkerdCompatibilityApplyState.Deferred,
                    PendingEdits: 0,
                    JobId: null,
                    JobState: null,
                    Message: "Settings are saved but no firmware version is active yet; they will apply on the next promote or host restart.",
                    UpdatedAtUtc: DateTime.UtcNow));
                return;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[1tube/workerd] compatibility reload failed; giving up");
                SetStatusIfCurrent(generation, new WorkerdCompatibilityApplyStatus(
                    Generation: generation,
                    State: WorkerdCompatibilityApplyState.Failed,
                    PendingEdits: 0,
                    JobId: null,
                    JobState: null,
                    Message: "Workerd compatibility hot-swap failed: " + ex.Message,
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
                SetStatusIfCurrent(generation, new WorkerdCompatibilityApplyStatus(
                    generation, WorkerdCompatibilityApplyState.Failed, 0, jobId, null,
                    "Workerd compatibility hot-swap job disappeared before completion.",
                    DateTime.UtcNow));
                return;
            }

            var state = job.State;
            if (state == FirmwareJobState.Done)
            {
                SetStatusIfCurrent(generation, new WorkerdCompatibilityApplyStatus(
                    generation, WorkerdCompatibilityApplyState.Applied, 0, jobId, state.ToString(),
                    "New workerd compatibility settings are live for new gateway requests.",
                    DateTime.UtcNow));
                return;
            }
            if (state.IsTerminal())
            {
                SetStatusIfCurrent(generation, new WorkerdCompatibilityApplyStatus(
                    generation, WorkerdCompatibilityApplyState.Failed, 0, jobId, state.ToString(),
                    "Workerd compatibility hot-swap did not apply: " + (job.Error ?? job.Message ?? state.ToString()),
                    DateTime.UtcNow));
                return;
            }

            SetStatusIfCurrent(generation, new WorkerdCompatibilityApplyStatus(
                generation, WorkerdCompatibilityApplyState.Applying, 0, jobId, state.ToString(),
                "Gateway hot-swap in progress: " + (job.Message ?? state.ToString()),
                DateTime.UtcNow));
            await Task.Delay(500);
        }
    }

    private void SetStatusIfCurrent(long generation, WorkerdCompatibilityApplyStatus status)
    {
        if (Volatile.Read(ref _generation) != generation) return;
        SetStatus(status);
    }

    private void SetStatus(WorkerdCompatibilityApplyStatus status)
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

public enum WorkerdCompatibilityApplyState
{
    Idle,
    Pending,
    Applying,
    Applied,
    Deferred,
    Failed,
}

public sealed record WorkerdCompatibilityApplyStatus(
    long Generation,
    WorkerdCompatibilityApplyState State,
    int PendingEdits,
    string? JobId,
    string? JobState,
    string Message,
    DateTime UpdatedAtUtc)
{
    public static WorkerdCompatibilityApplyStatus Idle() => new(
        0,
        WorkerdCompatibilityApplyState.Idle,
        0,
        null,
        null,
        "No pending workerd compatibility changes.",
        DateTime.UtcNow);
}
