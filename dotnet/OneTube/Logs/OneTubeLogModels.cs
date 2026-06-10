namespace OneTube.Logs;

/// <summary>
/// One persisted function invocation, as written by the 1tube gateway
/// into the SQLite log store. Mirrors `src/logs/schema.ts` (snake_case
/// on disk, PascalCase here).
/// </summary>
public sealed record OneTubeInvocation(
    string Id,
    long TsMs,
    string FunctionName,
    string Method,
    string Path,
    int Status,
    int DurationMs,
    string? UserId,
    string Backend,
    string? ErrorKind,
    string? ErrorMessage,
    string? ErrorStack,
    int LogCount)
{
    public DateTimeOffset Timestamp => DateTimeOffset.FromUnixTimeMilliseconds(TsMs);
}

/// <summary>A captured console line (or runtime error) from the log store.</summary>
public sealed record OneTubeLogLine(
    long Id,
    string? InvocationId,
    long TsMs,
    string Level,
    string? FunctionName,
    string Source,
    string Message)
{
    public DateTimeOffset Timestamp => DateTimeOffset.FromUnixTimeMilliseconds(TsMs);
}

/// <summary>Keyset cursor for invocation paging (newest-first).</summary>
public sealed record InvocationCursor(long TsMs, string Id);

/// <summary>Filter + paging for <see cref="IOneTubeLogReader.QueryInvocationsAsync"/>.</summary>
public sealed class InvocationQuery
{
    public string? FunctionName { get; set; }
    public string? Method { get; set; }
    /// <summary>Exact status match; takes precedence over <see cref="StatusClass"/>.</summary>
    public int? Status { get; set; }
    /// <summary>2, 3, 4 or 5 — matches the whole status class.</summary>
    public int? StatusClass { get; set; }
    /// <summary>timeout | body_timeout | breaker | unhandled | boot.</summary>
    public string? ErrorKind { get; set; }
    /// <summary>Only invocations with status >= 400.</summary>
    public bool ErrorsOnly { get; set; }
    public long? FromMs { get; set; }
    public long? ToMs { get; set; }
    /// <summary>Full-text query matched against the invocation's captured log lines.</summary>
    public string? Search { get; set; }
    public int Limit { get; set; } = 50;
    public InvocationCursor? Cursor { get; set; }
}

public sealed record InvocationPage(
    IReadOnlyList<OneTubeInvocation> Items,
    InvocationCursor? NextCursor);

public sealed record InvocationDetail(
    OneTubeInvocation Invocation,
    IReadOnlyList<OneTubeLogLine> Logs);

/// <summary>Filter + paging for <see cref="IOneTubeLogReader.SearchLogsAsync"/>.</summary>
public sealed class LogSearchQuery
{
    /// <summary>Full-text query (FTS5). When null, a plain filtered listing.</summary>
    public string? Search { get; set; }
    public string? InvocationId { get; set; }
    public string? FunctionName { get; set; }
    /// <summary>debug | log | info | warn | error.</summary>
    public string? Level { get; set; }
    /// <summary>function | boot | gateway.</summary>
    public string? Source { get; set; }
    public long? FromMs { get; set; }
    public long? ToMs { get; set; }
    public int Limit { get; set; } = 50;
    /// <summary>Keyset: only rows with id &lt; BeforeId (newest-first paging).</summary>
    public long? BeforeId { get; set; }
}

public sealed record LogSearchPage(
    IReadOnlyList<OneTubeLogLine> Items,
    long? NextBeforeId);
