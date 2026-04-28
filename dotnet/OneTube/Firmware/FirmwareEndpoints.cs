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
using OneTube.Diagnostics;

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
            var force = IsTruthy(ctx.Request.Query["force"].ToString());
            try
            {
                var contentSha = ctx.Request.Headers["X-1Tube-Content-Sha256"].ToString();
                var packageSha = ctx.Request.Headers["X-1Tube-Package-Sha256"].ToString();
                if (!force && (!string.IsNullOrWhiteSpace(contentSha) || !string.IsNullOrWhiteSpace(packageSha)))
                {
                    var skippedJobId = supervisor.CreateSkippedDuplicateJob(actor, contentSha, packageSha);
                    if (skippedJobId is not null)
                    {
                        ctx.Response.StatusCode = StatusCodes.Status202Accepted;
                        await ctx.Response.WriteAsJsonAsync(new { jobId = skippedJobId, skipped = true });
                        return;
                    }
                }

                var jobId = await supervisor.StageAsync(
                    ctx.Request.Body,
                    actor,
                    ctx.RequestAborted,
                    ctx.Request.ContentLength,
                    force,
                    contentSha);
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

        group.MapGet("/diagnostics", async (
            IGatewayDestinationProvider destinationProvider,
            DenoHostService activeHost,
            CancellationToken ct) =>
        {
            var host = ResolveActiveDenoHost(destinationProvider, activeHost);
            var snapshot = host.GetProcessSnapshot();
            return Results.Ok(new
            {
                gateway = GatewaySnapshot(host, snapshot),
                binaries = await host.GetBinaryDiagnosticsAsync(ct),
            });
        });

        // Run the configured workerd binary directly under the host's
        // identity, against either a minimal "hello world" capnp or a
        // caller-supplied path (e.g. the candidate's generated
        // config.gen-0.capnp). This is a debugging tool for
        // environments where the operator can hit the bearer-protected
        // firmware API but cannot open Event Viewer to see why workerd
        // std::terminate's during gateway startup.
        // List the experiment catalog: built-ins + whatever the
        // operator dropped into <DataRoot>/onetube/experiments/*.json.
        // The list is recomputed on every call so editing a JSON file
        // doesn't require restarting the host.
        group.MapGet("/diagnostics/experiments", (
            IGatewayDestinationProvider destinationProvider,
            DenoHostService activeHost,
            ExperimentRunner runner,
            FirmwareSupervisor? supervisor) =>
        {
            var host = ResolveActiveDenoHost(destinationProvider, activeHost);
            var ctx = host.BuildExperimentContext(ResolveActiveCapnp(host, supervisor));
            runner.EnsureStarterFiles(ctx);
            return Results.Ok(new
            {
                experiments = runner.Discover(ctx),
                tokens = runner.BuildTokens(ctx),
            });
        });

        group.MapPost("/diagnostics/experiments/{id}/run", async (
            string id,
            IGatewayDestinationProvider destinationProvider,
            DenoHostService activeHost,
            ExperimentRunner runner,
            FirmwareSupervisor? supervisor,
            CancellationToken ct) =>
        {
            var host = ResolveActiveDenoHost(destinationProvider, activeHost);
            var ctx = host.BuildExperimentContext(ResolveActiveCapnp(host, supervisor));
            var spec = runner.Discover(ctx).FirstOrDefault(x => string.Equals(x.Id, id, StringComparison.OrdinalIgnoreCase));
            if (spec is null)
            {
                return Results.NotFound(new { error = $"unknown experiment '{id}'" });
            }
            var result = await runner.RunAsync(spec, ctx, ct);
            return Results.Ok(result);
        }).DisableAntiforgery();

        group.MapGet("/diagnostics/event-log", (
            HttpContext ctx,
            WindowsEventLogReader reader) =>
        {
            int windowMin = int.TryParse(ctx.Request.Query["windowMinutes"].ToString(), out var m) && m is > 0 and <= 1440
                ? m
                : 30;
            int max = int.TryParse(ctx.Request.Query["max"].ToString(), out var n) && n is > 0 and <= 1000
                ? n
                : 200;
            string filter = ctx.Request.Query["filter"].ToString();
            string[]? tokens = string.IsNullOrWhiteSpace(filter)
                ? null
                : filter.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            var result = reader.Query(TimeSpan.FromMinutes(windowMin), tokens, max);
            return Results.Ok(result);
        });

        group.MapPost("/diagnostics/workerd-probe", async (
            HttpContext ctx,
            IGatewayDestinationProvider destinationProvider,
            DenoHostService activeHost,
            CancellationToken ct) =>
        {
            var host = ResolveActiveDenoHost(destinationProvider, activeHost);
            var capnp = ctx.Request.Query["capnp"].ToString();
            var timeoutSec = int.TryParse(ctx.Request.Query["timeoutSec"].ToString(), out var t) && t is > 0 and <= 30
                ? t
                : 5;
            var result = await host.ProbeWorkerdAsync(
                string.IsNullOrWhiteSpace(capnp) ? null : capnp,
                TimeSpan.FromSeconds(timeoutSec),
                ct);
            return Results.Ok(result);
        }).DisableAntiforgery();

        group.MapPost("/gateway/start", async (
            IGatewayDestinationProvider destinationProvider,
            DenoHostService activeHost,
            CancellationToken ct) =>
        {
            var host = ResolveActiveDenoHost(destinationProvider, activeHost);
            await host.StartAsync(ct);
            return Results.Ok(new
            {
                gateway = GatewaySnapshot(host, host.GetProcessSnapshot()),
            });
        });

        group.MapPost("/gateway/stop", async (
            IGatewayDestinationProvider destinationProvider,
            DenoHostService activeHost,
            CancellationToken ct) =>
        {
            var host = ResolveActiveDenoHost(destinationProvider, activeHost);
            await host.StopAsync(ct);
            return Results.Ok(new
            {
                gateway = GatewaySnapshot(host, host.GetProcessSnapshot()),
            });
        });

        group.MapPost("/gateway/recycle", async (
            IGatewayDestinationProvider destinationProvider,
            DenoHostService activeHost,
            CancellationToken ct) =>
        {
            var host = ResolveActiveDenoHost(destinationProvider, activeHost);
            if (!host.IsRunning)
            {
                return Results.Conflict(new { error = "gateway is not running" });
            }

            if (!await host.ProbeHealthAsync(ct))
            {
                return Results.Conflict(new { error = "gateway is not healthy" });
            }

            await host.RecycleAsync(ct);
            return Results.Ok(new
            {
                gateway = GatewaySnapshot(host, host.GetProcessSnapshot()),
            });
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

    private static bool IsTruthy(string? value)
        => string.Equals(value, "true", StringComparison.OrdinalIgnoreCase) ||
           string.Equals(value, "1", StringComparison.OrdinalIgnoreCase) ||
           string.Equals(value, "yes", StringComparison.OrdinalIgnoreCase);

    private static DenoHostService ResolveActiveDenoHost(
        IGatewayDestinationProvider destinationProvider,
        DenoHostService fallback)
        => destinationProvider.GetActive() as DenoHostService ?? fallback;

    private static string? ResolveActiveCapnp(DenoHostService host, FirmwareSupervisor? supervisor)
    {
        // Mirrors the page's helper but lives here so HTTP callers
        // (curl, the deploy CI, etc.) get the same default. Picks the
        // highest-numbered config.gen-*.capnp because the workerd
        // backend bumps that suffix on every reload.
        try
        {
            var ctx = host.BuildExperimentContext();
            var state = supervisor?.GetState();
            if (state?.Current is null or "") return null;
            var layout = new FirmwareLayout(ctx.DataRoot);
            var distDir = layout.VersionDistDir(state.Current);
            if (!Directory.Exists(distDir)) return null;
            return Directory.EnumerateFiles(distDir, "config.gen-*.capnp")
                .OrderByDescending(p => p, StringComparer.Ordinal)
                .FirstOrDefault();
        }
        catch
        {
            return null;
        }
    }

    private static object GatewaySnapshot(DenoHostService host, GatewayProcessSnapshot? snapshot)
        => new
        {
            label = host.Label,
            host.Port,
            host.Host,
            host.DestinationBaseUrl,
            host.IsRunning,
            host.StartedAt,
            host.RestartCount,
            host.IsPermanentlyUnavailable,
            process = snapshot is null
                ? null
                : new
                {
                    snapshot.Pid,
                    snapshot.Name,
                    snapshot.WorkingSetBytes,
                    snapshot.PrivateMemoryBytes,
                    totalProcessorTimeMs = snapshot.TotalProcessorTime.TotalMilliseconds,
                    snapshot.SampledAtUtc,
                },
        };

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
