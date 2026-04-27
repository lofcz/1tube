using System.Buffers;
using System.Net.ServerSentEvents;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace OneTube.Firmware;

public static class FirmwareEndpoints
{
    public static IEndpointRouteBuilder MapOneTubeFirmware(this IEndpointRouteBuilder endpoints)
    {
        var fwOpts = endpoints.ServiceProvider.GetRequiredService<IOptions<FirmwareOptions>>().Value;
        if (!fwOpts.Enabled) return endpoints;

        var prefix = fwOpts.RoutePrefix.TrimEnd('/');
        var group = endpoints
            .MapGroup($"{prefix}/firmware")
            .AddEndpointFilter(new BearerKeyFilter(fwOpts.SharedSecret ?? ""));
        
        group.MapPost("/upload", async (HttpContext ctx, FirmwareSupervisor supervisor) =>
        {
            var sizeFeature = ctx.Features.Get<IHttpMaxRequestBodySizeFeature>();
            if (sizeFeature is { IsReadOnly: false })
            {
                // Null = unlimited per the feature's contract.
                sizeFeature.MaxRequestBodySize = fwOpts.MaxUploadBytes;
            }

            var actor = ctx.User?.Identity?.Name ?? "anon";
            try
            {
                var jobId = await supervisor.StageAsync(
                    ctx.Request.Body,
                    actor,
                    ctx.RequestAborted,
                    ctx.Request.ContentLength);
                ctx.Response.StatusCode = StatusCodes.Status202Accepted;
                await ctx.Response.WriteAsJsonAsync(new { jobId });
            }
            catch (FirmwareSupervisor.PreemptionRefusedException ex)
            {
                ctx.Response.StatusCode = StatusCodes.Status409Conflict;
                ctx.Response.Headers["Retry-After"] = "2";
                await ctx.Response.WriteAsJsonAsync(new
                {
                    error = ex.Message,
                    conflictingJobId = ex.ConflictingJobId,
                    conflictingState = ex.ConflictingState.ToString(),
                });
            }
        }).DisableAntiforgery(); // bearer-auth endpoint, no cookie / form / antiforgery interaction

        // ── GET jobs/{id} ──────────────────────────────────────────
        group.MapGet("/jobs/{id}", (string id, FirmwareSupervisor supervisor) =>
        {
            var job = supervisor.GetJob(id);
            return job is null ? Results.NotFound(new { error = "unknown jobId" }) : Results.Ok(job.ToSnapshot());
        });
        
        group.MapGet("/jobs/{id}/stream", async (string id, HttpContext ctx, FirmwareSupervisor supervisor) =>
        {
            if (supervisor.GetJob(id) is null)
            {
                ctx.Response.StatusCode = StatusCodes.Status404NotFound;
                await ctx.Response.WriteAsJsonAsync(new { error = "unknown jobId" });
                return;
            }

            ctx.Response.Headers.ContentType = "text/event-stream";
            ctx.Response.Headers.CacheControl = "no-cache, no-transform";
            ctx.Response.Headers["X-Accel-Buffering"] = "no";
            ctx.Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();

            await SseFormatter.WriteAsync(
                StreamJobAsync(id, supervisor, ctx.RequestAborted),
                ctx.Response.Body,
                FormatSnapshotItem,
                ctx.RequestAborted);
        });
        
        group.MapGet("/active", (FirmwareSupervisor supervisor) =>
        {
            var job = supervisor.GetActiveJob();
            return job is null
                ? Results.NotFound(new { idle = true })
                : Results.Ok(job.ToSnapshot());
        });

        // ── GET current ───────────────────────────────────────────
        group.MapGet("/current", (FirmwareSupervisor supervisor) =>
        {
            var state = supervisor.GetState();
            return state is null ? Results.Ok(new { current = (string?)null, previous = (string?)null, history = Array.Empty<object>() }) : Results.Ok(state);
        });

        // ── POST rollback ─────────────────────────────────────────
        group.MapPost("/rollback", async (HttpContext ctx, FirmwareSupervisor supervisor) =>
        {
            try
            {
                var actor = ctx.User?.Identity?.Name ?? "anon";
                var jobId = await supervisor.RollbackAsync(actor);
                return Results.Accepted($"{ctx.Request.Path.Value}/../jobs/{jobId}", new { jobId });
            }
            catch (FirmwareSupervisor.PreemptionRefusedException ex)
            {
                ctx.Response.Headers["Retry-After"] = "2";
                return Results.Json(new
                {
                    error = ex.Message,
                    conflictingJobId = ex.ConflictingJobId,
                    conflictingState = ex.ConflictingState.ToString(),
                }, statusCode: StatusCodes.Status409Conflict);
            }
            catch (InvalidOperationException ex)
            {
                return Results.Conflict(new { error = ex.Message });
            }
        });

        return endpoints;
    }

    private static async IAsyncEnumerable<SseItem<object>> StreamJobAsync(
        string jobId,
        FirmwareSupervisor supervisor,
        [EnumeratorCancellation] CancellationToken ct)
    {
        var heartbeat = TimeSpan.FromSeconds(15);
        string lastSerialized = "";
        DateTime lastEmit = DateTime.UtcNow;

        while (!ct.IsCancellationRequested)
        {
            var job = supervisor.GetJob(jobId);
            if (job is null)
            {
                yield return new SseItem<object>(new { error = "job vanished" }, eventType: "error");
                yield break;
            }

            var snapshot = job.ToSnapshot();
            var serialised = JsonSerializer.Serialize(snapshot);
            if (serialised != lastSerialized)
            {
                yield return new SseItem<object>(snapshot, eventType: "state");
                lastSerialized = serialised;
                lastEmit = DateTime.UtcNow;
            }
            else if (DateTime.UtcNow - lastEmit >= heartbeat)
            {
                yield return new SseItem<object>(null!, eventType: "heartbeat");
                lastEmit = DateTime.UtcNow;
            }

            if (job.State.IsTerminal())
            {
                yield return new SseItem<object>(snapshot, eventType: "done");
                yield break;
            }

            Task delay = Task.Delay(250, ct);
            try { await delay; }
            catch (OperationCanceledException) { yield break; }
        }
    }
    
    private static void FormatSnapshotItem(SseItem<object> item, IBufferWriter<byte> writer)
    {
        if (item.Data is null)
        {
            return;
        }
        using var jw = new Utf8JsonWriter(writer);
        JsonSerializer.Serialize(jw, item.Data);
    }
    
    private sealed class BearerKeyFilter : IEndpointFilter
    {
        private readonly byte[] _expected;

        public BearerKeyFilter(string sharedSecret)
        {
            _expected = Encoding.UTF8.GetBytes(sharedSecret);
        }

        public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext ctx, EndpointFilterDelegate next)
        {
            var http = ctx.HttpContext;
            var auth = http.Request.Headers.Authorization.ToString();
            const string prefix = "Bearer ";
            if (!auth.StartsWith(prefix, StringComparison.Ordinal))
            {
                http.Response.StatusCode = StatusCodes.Status401Unauthorized;
                return null;
            }

            var presented = Encoding.UTF8.GetBytes(auth.AsSpan(prefix.Length).ToString());

            if (presented.Length != _expected.Length ||
                !CryptographicOperations.FixedTimeEquals(presented, _expected))
            {
                http.Response.StatusCode = StatusCodes.Status401Unauthorized;
                return null;
            }

            return await next(ctx);
        }
    }
}
