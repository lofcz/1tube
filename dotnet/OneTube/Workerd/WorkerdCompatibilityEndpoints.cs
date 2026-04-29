using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace OneTube.Workerd;

public static class WorkerdCompatibilityEndpoints
{
    public static RouteGroupBuilder MapOneTubeWorkerdCompatibility(this IEndpointRouteBuilder endpoints)
    {
        var opts = endpoints.ServiceProvider.GetRequiredService<IOptions<WorkerdCompatibilityOptions>>().Value;
        var prefix = opts.RoutePrefix.TrimEnd('/');
        var group = endpoints.MapGroup($"{prefix}/workerd/compatibility");

        group.MapGet("/", (WorkerdCompatibilityStore store) =>
            Results.Ok(store.Snapshot()));

        group.MapGet("/status", (WorkerdCompatibilityHotSwapWatcher watcher) =>
            Results.Ok(watcher.GetStatus()));

        group.MapPut("/", async (HttpContext ctx, WorkerdCompatibilityStore store, WorkerdCompatibilityHotSwapWatcher watcher) =>
        {
            WorkerdCompatibilitySettings? body;
            try { body = await ctx.Request.ReadFromJsonAsync<WorkerdCompatibilitySettings>(); }
            catch (System.Text.Json.JsonException ex)
            {
                return Results.BadRequest(new { error = "invalid JSON: " + ex.Message });
            }
            if (body is null)
            {
                return Results.BadRequest(new { error = "body must contain compatibilityDate, compatibilityFlags, experimental" });
            }

            try
            {
                var changed = store.Replace(body);
                return changed
                    ? Results.Accepted(value: new { changed = true, apply = watcher.GetStatus() })
                    : Results.StatusCode(StatusCodes.Status304NotModified);
            }
            catch (ArgumentException ex) { return Results.BadRequest(new { error = ex.Message }); }
        }).DisableAntiforgery();

        group.MapPost("/reload", (WorkerdCompatibilityStore store, WorkerdCompatibilityHotSwapWatcher watcher) =>
        {
            store.Reload();
            return Results.Accepted(value: new { reloaded = true, apply = watcher.GetStatus() });
        });

        return group;
    }
}
