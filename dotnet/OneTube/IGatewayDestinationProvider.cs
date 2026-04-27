namespace OneTube;

/// <summary>
/// Per-request lookup for the gateway destination YARP should
/// forward to. The single-host (Phase 1) deployment registers an
/// implementation that always returns the only host it knows about;
/// the firmware supervisor (Phase 4) will register a swappable
/// implementation that atomically flips between two hosts.
///
/// This interface is the seam between MapOneTube and the supervisor.
/// MapOneTube reads the current destination on every request, so
/// flipping the provider's internal pointer is sufficient to redirect
/// new traffic to a different gateway — no Kestrel reconfigure, no
/// restart, no race against in-flight requests (those finish on the
/// host they started on because YARP holds a reference for the life
/// of the forwarded call).
/// </summary>
public interface IGatewayDestinationProvider
{
    /// <summary>
    /// The host that should receive the next inbound request.
    /// Returns null when no host is currently considered ready
    /// (e.g. cold start, all hosts unhealthy) — caller renders 503.
    /// </summary>
    IGatewayHost? GetActive();
}

/// <summary>
/// Trivial single-host implementation. Hands back whatever
/// <see cref="IGatewayHost"/> was registered at AddOneTube time;
/// the host's own IsRunning flag governs the 502 / 503 distinction
/// in MapOneTube.
/// </summary>
public sealed class SingleHostDestinationProvider : IGatewayDestinationProvider
{
    private readonly IGatewayHost _host;
    public SingleHostDestinationProvider(IGatewayHost host) => _host = host;
    public IGatewayHost? GetActive() => _host;
}
