using Microsoft.Data.Sqlite;
using OneTube.Logs;
using Xunit;

namespace OneTube.Tests;

/// <summary>
/// Builds a fixture database by executing the real drizzle migration
/// SQL (copied into the test output by the csproj), seeds it, and
/// exercises <see cref="SqliteOneTubeLogReader"/> against it.
/// </summary>
public sealed class LogDbFixture : IDisposable
{
    public string DbPath { get; }
    private readonly string _dir;

    public LogDbFixture()
    {
        _dir = Path.Combine(Path.GetTempPath(), "onetube-logs-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_dir);
        DbPath = Path.Combine(_dir, "logs.db");

        using var conn = new SqliteConnection($"Data Source={DbPath}");
        conn.Open();
        Exec(conn, "PRAGMA journal_mode=WAL");

        // Apply migrations in folder order — same order drizzle's
        // migrator uses (folders are timestamp-prefixed).
        var migrationsRoot = Path.Combine(AppContext.BaseDirectory, "drizzle");
        Assert.True(Directory.Exists(migrationsRoot), $"missing migrations at {migrationsRoot}");
        foreach (var folder in Directory.GetDirectories(migrationsRoot).OrderBy(f => f, StringComparer.Ordinal))
        {
            var sql = File.ReadAllText(Path.Combine(folder, "migration.sql"));
            foreach (var statement in sql.Split("--> statement-breakpoint"))
            {
                if (!string.IsNullOrWhiteSpace(statement)) Exec(conn, statement);
            }
        }

        Seed(conn);
    }

    private static void Exec(SqliteConnection conn, string sql)
    {
        using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        cmd.ExecuteNonQuery();
    }

    private static void Seed(SqliteConnection conn)
    {
        using var inv = conn.CreateCommand();
        inv.CommandText =
            "INSERT INTO invocations (id, ts_ms, function_name, method, path, status, duration_ms, user_id, backend, error_kind, error_message) " +
            "VALUES ($id, $ts, $fn, $method, $path, $status, $dur, $user, 'deno', $kind, $msg)";
        var pId = inv.Parameters.Add("$id", SqliteType.Text);
        var pTs = inv.Parameters.Add("$ts", SqliteType.Integer);
        var pFn = inv.Parameters.Add("$fn", SqliteType.Text);
        var pMethod = inv.Parameters.Add("$method", SqliteType.Text);
        var pPath = inv.Parameters.Add("$path", SqliteType.Text);
        var pStatus = inv.Parameters.Add("$status", SqliteType.Integer);
        var pDur = inv.Parameters.Add("$dur", SqliteType.Integer);
        var pUser = inv.Parameters.Add("$user", SqliteType.Text);
        var pKind = inv.Parameters.Add("$kind", SqliteType.Text);
        var pMsg = inv.Parameters.Add("$msg", SqliteType.Text);

        // 40 invocations, alternating functions, every 8th a 504 timeout.
        for (var i = 0; i < 40; i++)
        {
            pId.Value = $"inv-{i:D2}";
            pTs.Value = BaseTs + i * 1000;
            pFn.Value = i % 2 == 0 ? "alpha" : "beta";
            pMethod.Value = "POST";
            pPath.Value = $"/functions/v1/{(i % 2 == 0 ? "alpha" : "beta")}";
            var timeout = i % 8 == 0;
            pStatus.Value = timeout ? 504 : 200;
            pDur.Value = 10 + i;
            pUser.Value = i % 3 == 0 ? "user-123" : DBNull.Value;
            pKind.Value = timeout ? "timeout" : DBNull.Value;
            pMsg.Value = timeout ? "Function execution timed out after 150ms" : DBNull.Value;
            inv.ExecuteNonQuery();
        }

        using var log = conn.CreateCommand();
        log.CommandText =
            "INSERT INTO logs (invocation_id, ts_ms, level, function_name, source, message) " +
            "VALUES ($inv, $ts, $level, $fn, $source, $message)";
        var lInv = log.Parameters.Add("$inv", SqliteType.Text);
        var lTs = log.Parameters.Add("$ts", SqliteType.Integer);
        var lLevel = log.Parameters.Add("$level", SqliteType.Text);
        var lFn = log.Parameters.Add("$fn", SqliteType.Text);
        var lSource = log.Parameters.Add("$source", SqliteType.Text);
        var lMessage = log.Parameters.Add("$message", SqliteType.Text);

        void AddLog(string? invId, string level, string source, string message, long ts)
        {
            lInv.Value = (object?)invId ?? DBNull.Value;
            lTs.Value = ts;
            lLevel.Value = level;
            lFn.Value = invId is null ? DBNull.Value : "alpha";
            lSource.Value = source;
            lMessage.Value = message;
            log.ExecuteNonQuery();
        }

        AddLog("inv-00", "log", "function", "payment captured for order 42", BaseTs);
        AddLog("inv-00", "warn", "function", "retrying upstream call", BaseTs + 5);
        AddLog("inv-02", "error", "function", "payment declined by issuer", BaseTs + 2000);
        AddLog(null, "info", "boot", "module loaded in 120ms", BaseTs - 1000);
        AddLog(null, "info", "gateway", "workerd ready", BaseTs - 2000);
    }

    public const long BaseTs = 1_750_000_000_000;

    public void Dispose()
    {
        SqliteConnection.ClearAllPools();
        try { Directory.Delete(_dir, recursive: true); } catch { /* best effort */ }
    }
}

public class LogReaderTests : IClassFixture<LogDbFixture>
{
    private readonly SqliteOneTubeLogReader _reader;

    public LogReaderTests(LogDbFixture fixture)
    {
        _reader = new SqliteOneTubeLogReader(fixture.DbPath);
    }

    [Fact]
    public async Task QueryInvocations_NewestFirst_WithKeysetPaging()
    {
        var page1 = await _reader.QueryInvocationsAsync(new InvocationQuery { Limit = 15 });
        Assert.Equal(15, page1.Items.Count);
        Assert.Equal("inv-39", page1.Items[0].Id);
        Assert.NotNull(page1.NextCursor);

        var page2 = await _reader.QueryInvocationsAsync(new InvocationQuery
        {
            Limit = 15,
            Cursor = page1.NextCursor,
        });
        Assert.Equal("inv-24", page2.Items[0].Id);
        var ids = page1.Items.Concat(page2.Items).Select(i => i.Id).ToHashSet();
        Assert.Equal(30, ids.Count); // no overlaps, no gaps
    }

    [Fact]
    public async Task QueryInvocations_Filters()
    {
        var alphas = await _reader.QueryInvocationsAsync(new InvocationQuery { FunctionName = "alpha", Limit = 200 });
        Assert.Equal(20, alphas.Items.Count);
        Assert.All(alphas.Items, i => Assert.Equal("alpha", i.FunctionName));

        var errors = await _reader.QueryInvocationsAsync(new InvocationQuery { StatusClass = 5, Limit = 200 });
        Assert.Equal(5, errors.Items.Count);
        Assert.All(errors.Items, i => Assert.Equal(504, i.Status));

        var byKind = await _reader.QueryInvocationsAsync(new InvocationQuery { ErrorKind = "timeout", Limit = 200 });
        Assert.Equal(5, byKind.Items.Count);

        var errorsOnly = await _reader.QueryInvocationsAsync(new InvocationQuery { ErrorsOnly = true, Limit = 200 });
        Assert.Equal(5, errorsOnly.Items.Count);

        var windowed = await _reader.QueryInvocationsAsync(new InvocationQuery
        {
            FromMs = LogDbFixture.BaseTs + 35_000,
            ToMs = LogDbFixture.BaseTs + 39_000,
            Limit = 200,
        });
        Assert.Equal(5, windowed.Items.Count);
    }

    [Fact]
    public async Task QueryInvocations_FullTextSearchOverLogLines()
    {
        var page = await _reader.QueryInvocationsAsync(new InvocationQuery { Search = "payment" });
        Assert.Equal(2, page.Items.Count); // inv-00 + inv-02 both logged "payment …"
        Assert.Contains(page.Items, i => i.Id == "inv-00");
        Assert.Contains(page.Items, i => i.Id == "inv-02");

        // Error-message fallback: "timed out" only appears on error rows.
        var timeouts = await _reader.QueryInvocationsAsync(new InvocationQuery { Search = "timed out", Limit = 200 });
        Assert.Equal(5, timeouts.Items.Count);
    }

    [Fact]
    public async Task GetInvocation_ReturnsDetailWithLogs()
    {
        var detail = await _reader.GetInvocationAsync("inv-00");
        Assert.NotNull(detail);
        Assert.Equal(2, detail.Invocation.LogCount);
        Assert.Equal(2, detail.Logs.Count);
        Assert.Equal("payment captured for order 42", detail.Logs[0].Message);
        Assert.Equal("warn", detail.Logs[1].Level);

        Assert.Null(await _reader.GetInvocationAsync("missing"));
    }

    [Fact]
    public async Task SearchLogs_FtsAndFilters()
    {
        var hits = await _reader.SearchLogsAsync(new LogSearchQuery { Search = "payment" });
        Assert.Equal(2, hits.Items.Count);

        var errorsOnly = await _reader.SearchLogsAsync(new LogSearchQuery { Search = "payment", Level = "error" });
        Assert.Single(errorsOnly.Items);
        Assert.Equal("payment declined by issuer", errorsOnly.Items[0].Message);

        var bySource = await _reader.SearchLogsAsync(new LogSearchQuery { Source = "boot" });
        Assert.Single(bySource.Items);

        // Prefix query.
        var prefix = await _reader.SearchLogsAsync(new LogSearchQuery { Search = "pay*" });
        Assert.Equal(2, prefix.Items.Count);
    }

    [Theory]
    [InlineData("\" OR 1=1 --")]
    [InlineData("NOT (")]
    [InlineData("a AND")]
    [InlineData("col:val")]
    [InlineData("*")]
    [InlineData("\"\" \"\"")]
    public async Task SearchLogs_HostileInput_NeverThrows(string evil)
    {
        // Must not surface an FTS5/SQL syntax error.
        await _reader.SearchLogsAsync(new LogSearchQuery { Search = evil });
        await _reader.QueryInvocationsAsync(new InvocationQuery { Search = evil });
    }

    [Fact]
    public async Task GetLogsSince_AscendingTail()
    {
        var all = await _reader.GetLogsSinceAsync(0);
        Assert.Equal(5, all.Count);
        Assert.True(all[0].Id < all[^1].Id);

        var rest = await _reader.GetLogsSinceAsync(all[2].Id);
        Assert.Equal(2, rest.Count);
    }

    [Fact]
    public async Task GetFunctionNames_Distinct()
    {
        var names = await _reader.GetFunctionNamesAsync();
        Assert.Equal(["alpha", "beta"], names);
    }

    [Fact]
    public async Task MissingDatabase_DegradesToEmptyResults()
    {
        var reader = new SqliteOneTubeLogReader(
            Path.Combine(Path.GetTempPath(), "definitely-missing-" + Guid.NewGuid().ToString("N"), "logs.db"));
        Assert.False(reader.DatabaseExists);
        Assert.Empty((await reader.QueryInvocationsAsync(new InvocationQuery())).Items);
        Assert.Null(await reader.GetInvocationAsync("x"));
        Assert.Empty((await reader.SearchLogsAsync(new LogSearchQuery { Search = "x" })).Items);
        Assert.Empty(await reader.GetLogsSinceAsync(0));
        Assert.Empty(await reader.GetFunctionNamesAsync());
    }

    [Theory]
    [InlineData("hello world", "\"hello\" \"world\"")]
    [InlineData("pre*", "\"pre\"*")]
    [InlineData("a OR b", "\"a\" \"OR\" \"b\"")]
    [InlineData("say \"hi\"", "\"say\" \"\"\"hi\"\"\"")]
    [InlineData("   ", null)]
    [InlineData("\"", null)]
    public void BuildFtsMatch_SanitizesLikeTheGateway(string input, string? expected)
    {
        Assert.Equal(expected, SqliteOneTubeLogReader.BuildFtsMatch(input));
    }
}

public class GatewayCommandLogArgsTests
{
    private static OneTubeOptions Options() => new()
    {
        FunctionsPath = "functions",
        DataRoot = Path.Combine(Path.GetTempPath(), "onetube-data"),
    };

    [Fact]
    public void BuildArgs_PassesLogDbAndKnobs()
    {
        var opts = Options();
        opts.LogRetentionDays = 14;
        opts.LogMaxRows = 250_000;
        var args = GatewayCommand.BuildArgs(opts, new GatewaySlot("active", 3100, null), "server.ts", null);

        var logDbIndex = args.IndexOf("--log-db");
        Assert.True(logDbIndex >= 0, "--log-db must be passed");
        var dbPath = args[logDbIndex + 1];
        Assert.EndsWith(Path.Combine("onetube", "logs", "1tube-logs.db"), dbPath);
        Assert.True(Path.IsPathRooted(dbPath));
        Assert.Contains("--log-retention-days=14", args);
        Assert.Contains("--log-max-rows=250000", args);

        // Reader and writer must agree on the file.
        Assert.Equal(dbPath, GatewayCommand.ResolveLogDbPath(opts));
    }

    [Fact]
    public void BuildArgs_DisabledLogsPassesOptOutFlag()
    {
        var opts = Options();
        opts.InvocationLogs = false;
        var args = GatewayCommand.BuildArgs(opts, new GatewaySlot("active", 3100, null), "server.ts", null);
        Assert.Contains("--no-invocation-logs", args);
        Assert.DoesNotContain("--log-db", args);
    }

    [Fact]
    public void BuildEnvironment_ConsoleCaptureOptOut()
    {
        var opts = Options();
        var slot = new GatewaySlot("active", 3100, null);
        Assert.False(GatewayCommand.BuildEnvironment(opts, slot).ContainsKey("1TUBE_LOG_CONSOLE"));

        opts.LogConsoleCapture = false;
        Assert.Equal("0", GatewayCommand.BuildEnvironment(opts, slot)["1TUBE_LOG_CONSOLE"]);
    }
}
