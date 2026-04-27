namespace OneTube;

/// <summary>
/// Per-slot tuple injected into <see cref="DenoHostService"/> so a
/// single concrete class can drive multiple gateway lifecycles in
/// the same process.
///
/// <para>
/// All other configuration (binaries, project paths, env vars, etc.)
/// still comes from <see cref="OneTubeOptions"/> — those fields are
/// process-global by design, since every slot uses the same Deno
/// binary, the same workerd binary, and runs over the same source
/// tree. The slot is responsible only for the things that genuinely
/// differ between gateway processes: which TCP port to bind, what role
/// label to use in logs, and which prebuilt artifact dir to read from.
/// Firmware swaps alternate which configured outer port is active, so
/// "candidate" is a temporary role label, not a fixed port identity.
/// </para>
/// </summary>
public sealed record GatewaySlot(
    /// <summary>Role label for logs + IGatewayHost.Label (for example "active" or "candidate").</summary>
    string Label,
    /// <summary>Port this slot binds. Firmware candidates use whichever configured outer port is currently inactive.</summary>
    int Port,
    /// <summary>
    /// When non-null, this slot serves the firmware version staged at this directory
    /// instead of <see cref="OneTubeOptions.PrebuiltDir"/>. Used by the firmware
    /// supervisor to spin up a candidate gateway against a freshly extracted version
    /// without touching the active slot's config.
    /// </summary>
    string? PrebuiltDirOverride = null);
