namespace OneTube.Firmware;

/// <summary>
/// <see cref="IGatewayDestinationProvider"/> implementation backed
/// by a single mutable reference that the supervisor flips during a
/// promote. The flip is a single interlocked write, so even under
/// load every concurrent <c>GetActive()</c> call sees either the old
/// host or the new host but never a torn pointer.
///
/// The thing that makes this safe under MapOneTube's per-request
/// lookup: each individual request resolves the destination once at
/// the top of the handler and uses that single host for the entire
/// proxy lifetime. Flipping mid-request is therefore impossible —
/// the request finishes on whichever host it started on.
/// </summary>
public sealed class SwappableDestinationProvider : IGatewayDestinationProvider
{
    private IGatewayHost? _active;

    public SwappableDestinationProvider(IGatewayHost? initial)
    {
        _active = initial;
    }

    public IGatewayHost? GetActive() => Volatile.Read(ref _active);

    /// <summary>
    /// Atomically replace the active host. Returns the old reference
    /// so the supervisor can drain + stop it after the flip.
    /// </summary>
    public IGatewayHost? Swap(IGatewayHost? next)
    {
        return Interlocked.Exchange(ref _active, next);
    }
}
