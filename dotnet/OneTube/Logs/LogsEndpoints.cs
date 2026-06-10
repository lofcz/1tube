using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;

namespace OneTube.Logs;

/// <summary>
/// Minimal-API endpoint mappings for the invocation log reader.
///
/// <para>Mirrors the gateway's own <c>/1tube/api/logs/*</c> surface but
/// is served by the .NET host directly from the SQLite file — no hop
/// through the Deno process. Like the secrets endpoints, no auth
/// policy is baked in: the returned <see cref="RouteGroupBuilder"/>
/// lets the consumer attach whatever filter fits (logs routinely
/// contain user data, so treat them as admin-only).</para>
///
/// <para>Wiring example:
/// <code>
/// app.MapOneTubeLogs()
///    .AddEndpointFilter(new AdminOnlyEndpointFilter());
/// </code></para>
/// </summary>
public static class LogsEndpoints
{
    public static RouteGroupBuilder MapOneTubeLogs(
        this IEndpointRouteBuilder endpoints,
        string prefix = "/1tube/api/logs")
    {
        var group = endpoints.MapGroup(prefix.TrimEnd('/'));

        // ── GET /invocations ──────────────────────────────────────
        group.MapGet("/invocations", async (
            HttpContext ctx,
            IOneTubeLogReader reader,
            CancellationToken ct) =>
        {
            var q = ctx.Request.Query;
            var query = new InvocationQuery
            {
                FunctionName = q["fn"].FirstOrDefault(),
                Method = q["method"].FirstOrDefault(),
                Status = TryInt(q["status"].FirstOrDefault()),
                StatusClass = TryInt(q["statusClass"].FirstOrDefault()),
                ErrorKind = q["errorKind"].FirstOrDefault(),
                ErrorsOnly = q["errorsOnly"].FirstOrDefault() is "1" or "true",
                FromMs = TryLong(q["from"].FirstOrDefault()),
                ToMs = TryLong(q["to"].FirstOrDefault()),
                Search = q["q"].FirstOrDefault(),
                Limit = TryInt(q["limit"].FirstOrDefault()) ?? 50,
            };
            var cursorTs = TryLong(q["cursorTs"].FirstOrDefault());
            var cursorId = q["cursorId"].FirstOrDefault();
            if (cursorTs is long ts && !string.IsNullOrEmpty(cursorId))
            {
                query.Cursor = new InvocationCursor(ts, cursorId);
            }
            return Results.Ok(await reader.QueryInvocationsAsync(query, ct));
        });

        // ── GET /invocations/{id} ─────────────────────────────────
        group.MapGet("/invocations/{id}", async (
            string id,
            IOneTubeLogReader reader,
            CancellationToken ct) =>
        {
            var detail = await reader.GetInvocationAsync(id, ct);
            return detail is null
                ? Results.NotFound(new { error = "Invocation not found" })
                : Results.Ok(detail);
        });

        // ── GET /search ───────────────────────────────────────────
        group.MapGet("/search", async (
            HttpContext ctx,
            IOneTubeLogReader reader,
            CancellationToken ct) =>
        {
            var q = ctx.Request.Query;
            var query = new LogSearchQuery
            {
                Search = q["q"].FirstOrDefault(),
                InvocationId = q["invocationId"].FirstOrDefault(),
                FunctionName = q["fn"].FirstOrDefault(),
                Level = q["level"].FirstOrDefault(),
                Source = q["source"].FirstOrDefault(),
                FromMs = TryLong(q["from"].FirstOrDefault()),
                ToMs = TryLong(q["to"].FirstOrDefault()),
                Limit = TryInt(q["limit"].FirstOrDefault()) ?? 50,
                BeforeId = TryLong(q["beforeId"].FirstOrDefault()),
            };
            return Results.Ok(await reader.SearchLogsAsync(query, ct));
        });

        // ── GET /tail ─────────────────────────────────────────────
        group.MapGet("/tail", async (
            HttpContext ctx,
            IOneTubeLogReader reader,
            CancellationToken ct) =>
        {
            var afterId = TryLong(ctx.Request.Query["afterId"].FirstOrDefault()) ?? 0;
            var limit = TryInt(ctx.Request.Query["limit"].FirstOrDefault()) ?? 200;
            var items = await reader.GetLogsSinceAsync(afterId, limit, ct);
            return Results.Ok(new
            {
                items,
                lastId = items.Count > 0 ? items[^1].Id : afterId,
            });
        });

        // ── GET /functions ────────────────────────────────────────
        group.MapGet("/functions", async (IOneTubeLogReader reader, CancellationToken ct) =>
            Results.Ok(new { functions = await reader.GetFunctionNamesAsync(ct) }));

        return group;
    }

    private static int? TryInt(string? v)
        => int.TryParse(v, out var n) ? n : null;

    private static long? TryLong(string? v)
        => long.TryParse(v, out var n) ? n : null;
}
