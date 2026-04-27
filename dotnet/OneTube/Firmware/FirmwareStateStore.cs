using System.Text.Json;

namespace OneTube.Firmware;

/// <summary>
/// Thin wrapper around the on-disk <c>state.json</c>. The file is the
/// authoritative answer to "what version is currently active" — every
/// promotion goes through {@link Write} and every boot reads the result.
///
/// Atomicity: writes go to a sibling <c>state.json.tmp</c>, then a
/// rename. On NTFS and on every POSIX filesystem we care about, a
/// rename within the same directory is atomic; readers either see the
/// old file in full or the new file in full, never a half-written one.
/// </summary>
public static class FirmwareStateStore
{
    private static readonly JsonSerializerOptions s_opts = new()
    {
        WriteIndented = true,
    };

    /// <summary>
    /// Read state.json, returning null when the file doesn't exist
    /// (i.e. cold install, no firmware ever staged). Any other I/O
    /// failure throws — a corrupt state.json is a deployment-level
    /// problem that should surface loudly, not be silently treated
    /// as a fresh install.
    /// </summary>
    public static FirmwareState? TryRead(FirmwareLayout layout)
    {
        if (!File.Exists(layout.StateJsonPath)) return null;
        var bytes = File.ReadAllBytes(layout.StateJsonPath);
        return JsonSerializer.Deserialize<FirmwareState>(bytes, s_opts)
            ?? throw new InvalidOperationException("state.json deserialised to null");
    }

    /// <summary>
    /// Write state.json atomically. The fsync-then-rename dance
    /// matters because the supervisor only updates state AFTER the
    /// candidate is confirmed healthy; if a power-loss event
    /// happens during the write we want to either keep the old
    /// state (next boot serves <c>previous</c>) or have the new
    /// state already durable, never a torn middle.
    /// </summary>
    public static void Write(FirmwareLayout layout, FirmwareState state)
    {
        Directory.CreateDirectory(layout.Root);
        var tmp = layout.StateJsonPath + ".tmp";
        var bytes = JsonSerializer.SerializeToUtf8Bytes(state, s_opts);
        using (var fs = new FileStream(tmp, FileMode.Create, FileAccess.Write, FileShare.None))
        {
            fs.Write(bytes);
            fs.Flush(flushToDisk: true);
        }
        // File.Move with overwrite is atomic on Windows (.NET 5+ uses
        // ReplaceFile semantics) and on POSIX (rename(2)).
        File.Move(tmp, layout.StateJsonPath, overwrite: true);
    }
}
