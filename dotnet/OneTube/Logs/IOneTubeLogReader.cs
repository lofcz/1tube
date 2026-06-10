namespace OneTube.Logs;

/// <summary>
/// Read-only access to the 1tube gateway's invocation log store.
///
/// <para>The gateway (Deno) is the single writer and owns the schema +
/// migrations; this reader opens the same SQLite file concurrently
/// (WAL mode) and only ever issues SELECTs. No HTTP hop — a Blazor
/// Server admin page can inject this directly and query at local-disk
/// latency, including FTS5 full-text search.</para>
///
/// <para>All methods degrade gracefully when the database doesn't
/// exist yet (gateway never started, logging disabled): they return
/// empty results rather than throwing.</para>
/// </summary>
public interface IOneTubeLogReader
{
    /// <summary>True when the log database file currently exists on disk.</summary>
    bool DatabaseExists { get; }

    /// <summary>Resolved path of the log database file.</summary>
    string DatabasePath { get; }

    /// <summary>Newest-first invocation listing with filters + keyset paging.</summary>
    Task<InvocationPage> QueryInvocationsAsync(InvocationQuery query, CancellationToken ct = default);

    /// <summary>Invocation detail + its captured console lines, or null when unknown.</summary>
    Task<InvocationDetail?> GetInvocationAsync(string id, CancellationToken ct = default);

    /// <summary>Newest-first console-line search (FTS5 when <see cref="LogSearchQuery.Search"/> is set).</summary>
    Task<LogSearchPage> SearchLogsAsync(LogSearchQuery query, CancellationToken ct = default);

    /// <summary>Ascending tail: rows with id &gt; <paramref name="afterId"/>. For live polling.</summary>
    Task<IReadOnlyList<OneTubeLogLine>> GetLogsSinceAsync(long afterId, int limit = 200, CancellationToken ct = default);

    /// <summary>Distinct function names seen in the store (filter dropdowns).</summary>
    Task<IReadOnlyList<string>> GetFunctionNamesAsync(CancellationToken ct = default);
}
