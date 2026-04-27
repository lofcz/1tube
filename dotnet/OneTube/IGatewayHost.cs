using System.Threading;
using System.Threading.Tasks;

namespace OneTube;

/// <summary>
/// A single OneTube gateway slot. One <see cref="IGatewayHost"/> owns
/// exactly one Deno child process listening on exactly one port.
///
/// The interface exists so the side-by-side firmware swap can address
/// two hosts simultaneously: <c>active</c> serves live traffic while
/// <c>candidate</c> is booted, smoke-tested, and (if all goes well)
/// promoted to active. Pre-firmware deployments register a single
/// host registered as the active slot — all the same code paths
/// continue to work.
///
/// State is per-instance. Implementations MUST NOT use static state
/// for runtime flags; the dual-host scenario assumes two
/// independently observable lifecycles in the same process.
/// </summary>
public interface IGatewayHost
{
    /// <summary>"active" or "candidate". Used in log lines and metrics tags.</summary>
    string Label { get; }

    /// <summary>The configured listening port (e.g. 3100, 3101).</summary>
    int Port { get; }

    /// <summary>The configured listening host (loopback-resolved when bound to 0.0.0.0).</summary>
    string Host { get; }

    /// <summary>
    /// Latest known health-probe answer. Healthy hosts have completed
    /// their boot sequence and responded 200 from /health at least once.
    /// </summary>
    bool IsRunning { get; }

    /// <summary>http(s)://host:port — the YARP forward base.</summary>
    string DestinationBaseUrl { get; }

    /// <summary>
    /// Start the underlying Deno process and the health-probe loop.
    /// Idempotent — calling twice on a running host is a no-op. Returns
    /// only after the spawn has been initiated; the host is not
    /// guaranteed to be Healthy on return (use <see cref="ProbeHealthAsync"/>
    /// to await readiness).
    /// </summary>
    Task StartAsync(CancellationToken cancellationToken);

    /// <summary>
    /// Stop the underlying Deno process. Honours
    /// <see cref="OneTubeOptions.ShutdownGraceMs"/> if set so in-flight
    /// requests can drain.
    /// </summary>
    Task StopAsync(CancellationToken cancellationToken);

    /// <summary>
    /// One-shot health probe against the gateway's /health endpoint.
    /// Returns false on any error (timeout, non-200, connection
    /// refused) — callers can poll this for readiness checks during
    /// the smoke-test phase of a firmware swap.
    /// </summary>
    Task<bool> ProbeHealthAsync(CancellationToken cancellationToken);
}
