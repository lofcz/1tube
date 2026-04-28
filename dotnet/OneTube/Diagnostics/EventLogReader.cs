using System.Diagnostics.Eventing.Reader;
using System.Runtime.Versioning;
using System.Text;
using Microsoft.Extensions.Logging;

namespace OneTube.Diagnostics;

public sealed record EventLogEntry(
    DateTime TimeUtc,
    string Channel,
    string Source,
    string Level,
    int? EventId,
    string Message);

public sealed record EventLogQueryResult(
    bool Supported,
    string? Error,
    IReadOnlyList<EventLogEntry> Entries);

/// <summary>
/// Pulls recent Application/System log entries that mention any of
/// our process names. The Windows Event Log is where workerd's
/// <c>std::terminate</c> ends up as a "Faulting application
/// workerd.exe" record from <c>Application Error</c> when nothing
/// else captures it — so this is the missing piece for operators
/// who can't open Event Viewer on the production host.
/// </summary>
public sealed class WindowsEventLogReader
{
    private readonly ILogger<WindowsEventLogReader> _logger;

    public WindowsEventLogReader(ILogger<WindowsEventLogReader> logger)
    {
        _logger = logger;
    }

    public EventLogQueryResult Query(TimeSpan window, IEnumerable<string>? matchTokens = null, int max = 200)
    {
        if (!OperatingSystem.IsWindows())
        {
            return new EventLogQueryResult(false, "Event Log is a Windows-only API.", []);
        }

        try
        {
            return QueryWindows(window, matchTokens, max);
        }
        catch (UnauthorizedAccessException ex)
        {
            // The process identity needs SeAuditPrivilege or membership
            // in the "Event Log Readers" group to read the Security log.
            // Application/System are readable by ordinary users on a
            // default install, but a hardened IIS app pool may be denied
            // even those — we surface that explicitly so the operator
            // knows what to grant rather than guessing.
            return new EventLogQueryResult(true, $"Access denied reading Event Log: {ex.Message}. Grant the app pool identity membership in 'Event Log Readers'.", []);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[1tube] event log query failed");
            return new EventLogQueryResult(true, $"Event Log query failed: {ex.Message}", []);
        }
    }

    [SupportedOSPlatform("windows")]
    private static EventLogQueryResult QueryWindows(TimeSpan window, IEnumerable<string>? matchTokens, int max)
    {
        // ISO-8601 in EventLog XPath is local-time; we pass UTC and
        // let the platform do the conversion via TimeCreated[@SystemTime > ...].
        // Using milliseconds accuracy avoids missing events near second boundaries.
        var since = DateTime.UtcNow - window;
        var sinceIso = since.ToString("yyyy-MM-ddTHH:mm:ss.fffZ");

        var entries = new List<EventLogEntry>();
        var tokens = (matchTokens ?? DefaultMatchTokens).Where(t => !string.IsNullOrWhiteSpace(t)).ToArray();

        foreach (var channel in new[] { "Application", "System" })
        {
            // Level <= 3 keeps Critical(1)/Error(2)/Warning(3); skips
            // Information/Verbose noise. The system log under IIS gets
            // a lot of those.
            var xpath = $"*[System[TimeCreated[@SystemTime>'{sinceIso}'] and (Level=1 or Level=2 or Level=3)]]";
            var query = new EventLogQuery(channel, PathType.LogName, xpath) { ReverseDirection = true };
            using var reader = new System.Diagnostics.Eventing.Reader.EventLogReader(query);

            for (EventRecord? record = SafeRead(reader); record is not null && entries.Count < max; record = SafeRead(reader))
            {
                using (record)
                {
                    string source = record.ProviderName ?? "?";
                    string message = SafeMessage(record);
                    if (tokens.Length > 0 && !MatchesAny(source, message, tokens)) continue;

                    entries.Add(new EventLogEntry(
                        TimeUtc: (record.TimeCreated ?? DateTime.UtcNow).ToUniversalTime(),
                        Channel: channel,
                        Source: source,
                        Level: LevelName(record.Level),
                        EventId: record.Id,
                        Message: Truncate(message, 4096)));
                }
            }
        }

        // Newest first; the channel-order we inserted in is per-channel.
        entries.Sort((a, b) => b.TimeUtc.CompareTo(a.TimeUtc));
        return new EventLogQueryResult(true, null, entries);
    }

    [SupportedOSPlatform("windows")]
    private static EventRecord? SafeRead(System.Diagnostics.Eventing.Reader.EventLogReader reader)
    {
        try { return reader.ReadEvent(); }
        catch { return null; }
    }

    [SupportedOSPlatform("windows")]
    private static string SafeMessage(EventRecord record)
    {
        try { return record.FormatDescription() ?? ""; }
        catch { /* missing message DLL — not unusual for third-party providers */ }
        try
        {
            var sb = new StringBuilder();
            foreach (var p in record.Properties)
            {
                if (p?.Value is { } v) { sb.Append(v).Append(' '); }
            }
            return sb.ToString().Trim();
        }
        catch { return ""; }
    }

    private static string LevelName(byte? level) => level switch
    {
        1 => "Critical",
        2 => "Error",
        3 => "Warning",
        4 => "Information",
        5 => "Verbose",
        _ => $"Level {level}",
    };

    private static bool MatchesAny(string source, string message, string[] tokens)
    {
        foreach (var t in tokens)
        {
            if (source.Contains(t, StringComparison.OrdinalIgnoreCase)) return true;
            if (!string.IsNullOrEmpty(message) && message.Contains(t, StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }

    private static string Truncate(string s, int max)
        => string.IsNullOrEmpty(s) || s.Length <= max ? s : s[..max] + "…";

    private static readonly string[] DefaultMatchTokens =
    [
        "workerd",
        "deno",
        "OneTube",
        ".NET Runtime",
        "Application Error",
        "Windows Error Reporting",
    ];
}
