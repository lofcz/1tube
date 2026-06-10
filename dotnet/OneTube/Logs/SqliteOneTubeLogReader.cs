using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Data.Sqlite;

namespace OneTube.Logs;

/// <summary>
/// <see cref="IOneTubeLogReader"/> backed by Microsoft.Data.Sqlite.
///
/// <para>Deliberately NOT EF Core: the schema and its migrations are
/// owned by the gateway's drizzle setup, and the interesting query
/// (FTS5 <c>MATCH</c>) needs raw SQL anyway. This is a thin, fast,
/// hand-mapped reader.</para>
///
/// <para>Connections are opened per call (Microsoft.Data.Sqlite pools
/// them) with <c>Mode=ReadWrite</c> + <c>PRAGMA query_only=ON</c>.
/// ReadWrite rather than ReadOnly because a read-only connection
/// cannot create the WAL side files (<c>-shm</c>/<c>-wal</c>) and
/// would fail to open a WAL database after a clean gateway shutdown
/// removed them; <c>query_only</c> still hard-blocks every write at
/// the SQLite level.</para>
/// </summary>
public sealed class SqliteOneTubeLogReader : IOneTubeLogReader
{
    private const int MaxLimit = 200;

    private readonly string _connectionString;

    public SqliteOneTubeLogReader(string dbPath)
    {
        DatabasePath = Path.GetFullPath(dbPath);
        _connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = DatabasePath,
            Mode = SqliteOpenMode.ReadWrite,
            Pooling = true,
            DefaultTimeout = 5,
        }.ToString();
    }

    public string DatabasePath { get; }

    public bool DatabaseExists => File.Exists(DatabasePath);

    public Task<InvocationPage> QueryInvocationsAsync(InvocationQuery query, CancellationToken ct = default)
        => Task.Run(() => QueryInvocations(query), ct);

    public Task<InvocationDetail?> GetInvocationAsync(string id, CancellationToken ct = default)
        => Task.Run(() => GetInvocation(id), ct);

    public Task<LogSearchPage> SearchLogsAsync(LogSearchQuery query, CancellationToken ct = default)
        => Task.Run(() => SearchLogs(query), ct);

    public Task<IReadOnlyList<OneTubeLogLine>> GetLogsSinceAsync(long afterId, int limit = 200, CancellationToken ct = default)
        => Task.Run<IReadOnlyList<OneTubeLogLine>>(() => GetLogsSince(afterId, limit), ct);

    public Task<IReadOnlyList<string>> GetFunctionNamesAsync(CancellationToken ct = default)
        => Task.Run<IReadOnlyList<string>>(() => GetFunctionNames(), ct);

    // ── Implementation ────────────────────────────────────────────────

    private SqliteConnection? TryOpen()
    {
        if (!DatabaseExists) return null;
        try
        {
            var conn = new SqliteConnection(_connectionString);
            conn.Open();
            using var pragma = conn.CreateCommand();
            // Defence in depth: the reader must never mutate the store,
            // even via a bug. busy_timeout covers checkpoint collisions
            // with the writing gateway. mmap + in-memory temp store make
            // large FTS scans cheap; connections are pooled so the mmap
            // region survives across queries.
            pragma.CommandText =
                "PRAGMA query_only=ON; PRAGMA busy_timeout=2000; " +
                "PRAGMA mmap_size=268435456; PRAGMA temp_store=MEMORY;";
            pragma.ExecuteNonQuery();
            return conn;
        }
        catch (SqliteException)
        {
            // File vanished between the exists-check and the open, or it
            // isn't a SQLite database (partial copy). Treat as absent.
            return null;
        }
    }

    private static int ClampLimit(int limit)
        => limit <= 0 ? 50 : Math.Min(limit, MaxLimit);

    /// <summary>
    /// Convert free-form user input into a safe FTS5 MATCH expression.
    /// Mirrors `buildFtsMatch` in the gateway's `src/logs/query.ts` —
    /// terms are double-quoted (quotes doubled), a trailing `*` becomes
    /// a prefix query, punctuation-only terms are dropped.
    /// </summary>
    internal static string? BuildFtsMatch(string input)
    {
        var parts = new List<string>();
        foreach (var rawTerm in input.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries))
        {
            var term = rawTerm.Trim();
            if (term.Length == 0) continue;
            var prefix = false;
            if (term.EndsWith('*'))
            {
                prefix = true;
                term = term[..^1];
            }
            if (!Regex.IsMatch(term, @"[\p{L}\p{N}]")) continue;
            term = term.Replace("\"", "\"\"");
            parts.Add($"\"{term}\"{(prefix ? "*" : "")}");
        }
        return parts.Count > 0 ? string.Join(' ', parts) : null;
    }

    private const string InvocationColumns =
        "i.id, i.ts_ms, i.function_name, i.method, i.path, i.status, i.duration_ms, " +
        "i.user_id, i.backend, i.error_kind, i.error_message, i.error_stack, " +
        "(SELECT COUNT(*) FROM logs l WHERE l.invocation_id = i.id) AS log_count";

    private static OneTubeInvocation ReadInvocation(SqliteDataReader r) => new(
        Id: r.GetString(0),
        TsMs: r.GetInt64(1),
        FunctionName: r.GetString(2),
        Method: r.GetString(3),
        Path: r.GetString(4),
        Status: r.GetInt32(5),
        DurationMs: r.GetInt32(6),
        UserId: r.IsDBNull(7) ? null : r.GetString(7),
        Backend: r.GetString(8),
        ErrorKind: r.IsDBNull(9) ? null : r.GetString(9),
        ErrorMessage: r.IsDBNull(10) ? null : r.GetString(10),
        ErrorStack: r.IsDBNull(11) ? null : r.GetString(11),
        LogCount: r.GetInt32(12));

    private static OneTubeLogLine ReadLogLine(SqliteDataReader r) => new(
        Id: r.GetInt64(0),
        InvocationId: r.IsDBNull(1) ? null : r.GetString(1),
        TsMs: r.GetInt64(2),
        Level: r.GetString(3),
        FunctionName: r.IsDBNull(4) ? null : r.GetString(4),
        Source: r.GetString(5),
        Message: r.GetString(6));

    private InvocationPage QueryInvocations(InvocationQuery query)
    {
        using var conn = TryOpen();
        if (conn is null) return new InvocationPage([], null);

        var where = new List<string>();
        using var cmd = conn.CreateCommand();

        if (!string.IsNullOrEmpty(query.FunctionName))
        {
            where.Add("i.function_name = $fn");
            cmd.Parameters.AddWithValue("$fn", query.FunctionName);
        }
        if (!string.IsNullOrEmpty(query.Method))
        {
            where.Add("i.method = $method");
            cmd.Parameters.AddWithValue("$method", query.Method.ToUpperInvariant());
        }
        if (query.Status is int status)
        {
            where.Add("i.status = $status");
            cmd.Parameters.AddWithValue("$status", status);
        }
        else if (query.StatusClass is int statusClass)
        {
            where.Add("i.status >= $statusLo AND i.status < $statusHi");
            cmd.Parameters.AddWithValue("$statusLo", statusClass * 100);
            cmd.Parameters.AddWithValue("$statusHi", (statusClass + 1) * 100);
        }
        if (!string.IsNullOrEmpty(query.ErrorKind))
        {
            where.Add("i.error_kind = $errorKind");
            cmd.Parameters.AddWithValue("$errorKind", query.ErrorKind);
        }
        if (query.ErrorsOnly)
        {
            where.Add("i.status >= 400");
        }
        if (query.FromMs is long fromMs)
        {
            where.Add("i.ts_ms >= $fromMs");
            cmd.Parameters.AddWithValue("$fromMs", fromMs);
        }
        if (query.ToMs is long toMs)
        {
            where.Add("i.ts_ms <= $toMs");
            cmd.Parameters.AddWithValue("$toMs", toMs);
        }
        if (!string.IsNullOrWhiteSpace(query.Search) && BuildFtsMatch(query.Search) is string match)
        {
            // No DISTINCT: IN builds its own ephemeral dedup index,
            // DISTINCT would add a redundant sort over the match set.
            where.Add(
                "(i.id IN (SELECT l.invocation_id FROM logs_fts f " +
                "JOIN logs l ON l.id = f.rowid WHERE logs_fts MATCH $match AND l.invocation_id IS NOT NULL) " +
                "OR i.error_message LIKE '%' || $searchRaw || '%')");
            cmd.Parameters.AddWithValue("$match", match);
            cmd.Parameters.AddWithValue("$searchRaw", query.Search.Trim());
        }
        if (query.Cursor is { } cursor)
        {
            where.Add("(i.ts_ms < $curTs OR (i.ts_ms = $curTs AND i.id < $curId))");
            cmd.Parameters.AddWithValue("$curTs", cursor.TsMs);
            cmd.Parameters.AddWithValue("$curId", cursor.Id);
        }

        var limit = ClampLimit(query.Limit);
        cmd.Parameters.AddWithValue("$limit", limit + 1);

        var sql = new StringBuilder("SELECT ").Append(InvocationColumns).Append(" FROM invocations i");
        if (where.Count > 0) sql.Append(" WHERE ").Append(string.Join(" AND ", where));
        sql.Append(" ORDER BY i.ts_ms DESC, i.id DESC LIMIT $limit");
        cmd.CommandText = sql.ToString();

        var items = new List<OneTubeInvocation>(limit);
        using var reader = cmd.ExecuteReader();
        while (reader.Read()) items.Add(ReadInvocation(reader));

        var hasMore = items.Count > limit;
        if (hasMore) items.RemoveAt(items.Count - 1);
        var last = items.Count > 0 ? items[^1] : null;
        return new InvocationPage(
            items,
            hasMore && last is not null ? new InvocationCursor(last.TsMs, last.Id) : null);
    }

    private InvocationDetail? GetInvocation(string id)
    {
        using var conn = TryOpen();
        if (conn is null) return null;

        using var cmd = conn.CreateCommand();
        cmd.CommandText = $"SELECT {InvocationColumns} FROM invocations i WHERE i.id = $id";
        cmd.Parameters.AddWithValue("$id", id);
        OneTubeInvocation? invocation = null;
        using (var reader = cmd.ExecuteReader())
        {
            if (reader.Read()) invocation = ReadInvocation(reader);
        }
        if (invocation is null) return null;

        using var logsCmd = conn.CreateCommand();
        logsCmd.CommandText =
            "SELECT id, invocation_id, ts_ms, level, function_name, source, message " +
            "FROM logs WHERE invocation_id = $id ORDER BY id ASC LIMIT 1000";
        logsCmd.Parameters.AddWithValue("$id", id);
        var logs = new List<OneTubeLogLine>();
        using (var reader = logsCmd.ExecuteReader())
        {
            while (reader.Read()) logs.Add(ReadLogLine(reader));
        }
        return new InvocationDetail(invocation, logs);
    }

    private LogSearchPage SearchLogs(LogSearchQuery query)
    {
        using var conn = TryOpen();
        if (conn is null) return new LogSearchPage([], null);

        using var cmd = conn.CreateCommand();
        var where = new List<string>();
        var match = string.IsNullOrWhiteSpace(query.Search) ? null : BuildFtsMatch(query.Search);

        if (!string.IsNullOrEmpty(query.InvocationId))
        {
            where.Add("l.invocation_id = $inv");
            cmd.Parameters.AddWithValue("$inv", query.InvocationId);
        }
        if (!string.IsNullOrEmpty(query.FunctionName))
        {
            where.Add("l.function_name = $fn");
            cmd.Parameters.AddWithValue("$fn", query.FunctionName);
        }
        if (!string.IsNullOrEmpty(query.Level))
        {
            where.Add("l.level = $level");
            cmd.Parameters.AddWithValue("$level", query.Level);
        }
        if (!string.IsNullOrEmpty(query.Source))
        {
            where.Add("l.source = $source");
            cmd.Parameters.AddWithValue("$source", query.Source);
        }
        if (query.FromMs is long fromMs)
        {
            where.Add("l.ts_ms >= $fromMs");
            cmd.Parameters.AddWithValue("$fromMs", fromMs);
        }
        if (query.ToMs is long toMs)
        {
            where.Add("l.ts_ms <= $toMs");
            cmd.Parameters.AddWithValue("$toMs", toMs);
        }
        if (query.BeforeId is long beforeId)
        {
            where.Add("l.id < $beforeId");
            cmd.Parameters.AddWithValue("$beforeId", beforeId);
        }

        var limit = ClampLimit(query.Limit);
        cmd.Parameters.AddWithValue("$limit", limit + 1);

        string sql;
        const string cols = "l.id, l.invocation_id, l.ts_ms, l.level, l.function_name, l.source, l.message";
        if (match is not null)
        {
            where.Insert(0, "logs_fts MATCH $match");
            cmd.Parameters.AddWithValue("$match", match);
            sql = $"SELECT {cols} FROM logs_fts f JOIN logs l ON l.id = f.rowid " +
                  $"WHERE {string.Join(" AND ", where)} ORDER BY l.id DESC LIMIT $limit";
        }
        else
        {
            sql = $"SELECT {cols} FROM logs l" +
                  (where.Count > 0 ? $" WHERE {string.Join(" AND ", where)}" : "") +
                  " ORDER BY l.id DESC LIMIT $limit";
        }
        cmd.CommandText = sql;

        var items = new List<OneTubeLogLine>(limit);
        using var reader = cmd.ExecuteReader();
        while (reader.Read()) items.Add(ReadLogLine(reader));

        var hasMore = items.Count > limit;
        if (hasMore) items.RemoveAt(items.Count - 1);
        var last = items.Count > 0 ? items[^1] : null;
        return new LogSearchPage(items, hasMore && last is not null ? last.Id : null);
    }

    private List<OneTubeLogLine> GetLogsSince(long afterId, int limit)
    {
        using var conn = TryOpen();
        if (conn is null) return [];

        using var cmd = conn.CreateCommand();
        cmd.CommandText =
            "SELECT id, invocation_id, ts_ms, level, function_name, source, message " +
            "FROM logs WHERE id > $afterId ORDER BY id ASC LIMIT $limit";
        cmd.Parameters.AddWithValue("$afterId", afterId);
        cmd.Parameters.AddWithValue("$limit", ClampLimit(limit));
        var items = new List<OneTubeLogLine>();
        using var reader = cmd.ExecuteReader();
        while (reader.Read()) items.Add(ReadLogLine(reader));
        return items;
    }

    private List<string> GetFunctionNames()
    {
        using var conn = TryOpen();
        if (conn is null) return [];

        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT DISTINCT function_name FROM invocations ORDER BY function_name";
        var names = new List<string>();
        using var reader = cmd.ExecuteReader();
        while (reader.Read()) names.Add(reader.GetString(0));
        return names;
    }
}
