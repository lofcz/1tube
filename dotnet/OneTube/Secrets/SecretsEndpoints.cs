using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace OneTube.Secrets;

/// <summary>
/// Minimal-API endpoint mappings for the live-secrets editor.
///
/// <para>Returns the underlying <see cref="RouteGroupBuilder"/> so
/// the consumer can attach their own auth/identity filters. The
/// OneTube package deliberately does NOT bake an auth policy into
/// the secrets routes — runtime secret editing is one of the most
/// sensitive surfaces a host can expose, and the consumer is in
/// the best position to decide whether it lives behind their admin
/// auth, an mTLS-only path, an internal-only network, or some
/// combination. The firmware endpoints take the opposite stance
/// (always-on bearer auth) because a CI runner is the typical
/// caller; secrets typically come from a human admin behind an
/// SSO flow.</para>
///
/// <para>Wiring example:
/// <code>
/// app.MapOneTubeSecrets()
///    .RequireAuthorization("AdminOnly");
/// </code></para>
/// </summary>
public static class SecretsEndpoints
{
    public static RouteGroupBuilder MapOneTubeSecrets(this IEndpointRouteBuilder endpoints)
    {
        var opts = endpoints.ServiceProvider.GetRequiredService<IOptions<SecretsOptions>>().Value;
        var prefix = opts.RoutePrefix.TrimEnd('/');
        var group = endpoints.MapGroup($"{prefix}/secrets");

        // ── GET /secrets ──────────────────────────────────────────
        // Lists keys only. Listing values would be the easiest path
        // to a credential-disclosure incident if the consumer's
        // auth policy ever has a regression — the per-key reveal
        // endpoint is the deliberate, audit-friendlier path.
        group.MapGet("/", (SecretsStore store) =>
            Results.Ok(new { keys = store.Keys() }));

        // ── GET /secrets/status ───────────────────────────────────
        // Shows whether the latest edit is merely persisted, queued
        // for a hot-swap, actively applying, or already live.
        group.MapGet("/status", (SecretsHotSwapWatcher watcher) =>
            Results.Ok(watcher.GetStatus().ToSnapshot()));

        // ── GET /secrets/{key} ────────────────────────────────────
        // Reveals the raw value. Consumers gating this with a
        // stricter policy than the list endpoint is encouraged but
        // not enforced — the package can't know what "stricter"
        // means in any given consumer's identity world.
        group.MapGet("/{key}", (string key, SecretsStore store) =>
        {
            var v = store.Get(key);
            return v is null
                ? Results.NotFound(new { error = "unknown key" })
                : Results.Ok(new { key, value = v });
        });

        // ── PUT /secrets/{key} ────────────────────────────────────
        // Body: {"value": "..."}. Returns 202 on change with the
        // current hot-swap status, 304 on no-op (same value already
        // present). The watcher updates /status until the new value
        // is live.
        group.MapPut("/{key}", async (string key, HttpContext ctx, SecretsStore store, SecretsHotSwapWatcher watcher) =>
        {
            SetSecretBody? body;
            try { body = await ctx.Request.ReadFromJsonAsync<SetSecretBody>(); }
            catch (System.Text.Json.JsonException ex)
            {
                return Results.BadRequest(new { error = "invalid JSON: " + ex.Message });
            }
            if (body is null || body.Value is null)
            {
                return Results.BadRequest(new { error = "body must be {\"value\": \"...\"}" });
            }
            try
            {
                var changed = store.Set(key, body.Value);
                return changed
                    ? Results.Accepted(value: new { changed = true, apply = watcher.GetStatus().ToSnapshot() })
                    : Results.StatusCode(StatusCodes.Status304NotModified);
            }
            catch (ArgumentException ex) { return Results.BadRequest(new { error = ex.Message }); }
        }).DisableAntiforgery();

        // ── DELETE /secrets/{key} ─────────────────────────────────
        group.MapDelete("/{key}", (string key, SecretsStore store, SecretsHotSwapWatcher watcher) =>
        {
            try
            {
                var existed = store.Delete(key);
                return existed
                    ? Results.Accepted(value: new { changed = true, apply = watcher.GetStatus().ToSnapshot() })
                    : Results.NotFound(new { error = "unknown key" });
            }
            catch (ArgumentException ex) { return Results.BadRequest(new { error = ex.Message }); }
        });

        // ── PUT /secrets ──────────────────────────────────────────
        // Bulk replace: body is the full new map. Validates every
        // entry before persisting — a single bad key (reserved or
        // non-POSIX) rejects the whole call so callers can't
        // accidentally do a partial update.
        group.MapPut("/", async (HttpContext ctx, SecretsStore store, SecretsHotSwapWatcher watcher) =>
        {
            Dictionary<string, string>? body;
            try { body = await ctx.Request.ReadFromJsonAsync<Dictionary<string, string>>(); }
            catch (System.Text.Json.JsonException ex)
            {
                return Results.BadRequest(new { error = "invalid JSON: " + ex.Message });
            }
            if (body is null)
            {
                return Results.BadRequest(new { error = "body must be a JSON object of {key: value}" });
            }
            try
            {
                var changed = store.ReplaceAll(body);
                return changed
                    ? Results.Accepted(value: new { changed = true, apply = watcher.GetStatus().ToSnapshot() })
                    : Results.StatusCode(StatusCodes.Status304NotModified);
            }
            catch (ArgumentException ex) { return Results.BadRequest(new { error = ex.Message }); }
        }).DisableAntiforgery();

        // ── POST /secrets/reload ──────────────────────────────────
        // Re-reads secrets.json from disk and triggers a gateway
        // reload. Useful when an operator hand-edits the file and
        // wants the change to take effect without restarting the
        // host. Idempotent: triggering it without any change still
        // works (the watcher fires; the supervisor's debounce
        // collapses overlapping reloads).
        group.MapPost("/reload", (SecretsStore store, SecretsHotSwapWatcher watcher) =>
        {
            store.Reload();
            return Results.Accepted(value: new { reloaded = true, apply = watcher.GetStatus().ToSnapshot() });
        });

        return group;
    }

    private sealed class SetSecretBody
    {
        public string? Value { get; set; }
    }
}
