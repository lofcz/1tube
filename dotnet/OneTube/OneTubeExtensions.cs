using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Console;
using Microsoft.Extensions.Options;
using OneTube.Firmware;
using OneTube.Secrets;
using Yarp.ReverseProxy.Forwarder;

namespace OneTube;

public static class OneTubeExtensions
{
    /// <summary>
    /// Registers the embedded 1tube gateway as a hosted service and
    /// wires up YARP for zero-copy proxying. Call this on
    /// <see cref="IServiceCollection"/> at app startup; pair with
    /// <see cref="MapOneTube"/> on the <see cref="WebApplication"/>.
    ///
    /// Single-host mode by default — registers one
    /// <see cref="IGatewayHost"/> (the "active" slot) plus a
    /// <see cref="SingleHostDestinationProvider"/>. The firmware
    /// supervisor (Phase 4) replaces the destination provider with
    /// a swappable implementation when it's enabled.
    /// </summary>
    public static IServiceCollection AddOneTube(
        this IServiceCollection services,
        Action<OneTubeOptions> configure)
    {
        services.Configure(configure);

        // The active-slot DenoHostService is registered three ways:
        //   1. As a singleton concrete type so the supervisor can
        //      reach for it directly when it needs to drive
        //      lifecycle on the active host.
        //   2. As IGatewayHost so the destination provider has a
        //      stable surface to talk to.
        //   3. As IHostedService so the .NET host boots/shuts it
        //      with the rest of the app.
        services.AddSingleton<DenoHostService>();
        services.AddSingleton<IGatewayHost>(sp => sp.GetRequiredService<DenoHostService>());
        services.AddHostedService(sp => sp.GetRequiredService<DenoHostService>());

        // Diagnostic surfaces — singleton, no per-request state.
        services.AddSingleton<OneTube.Diagnostics.ExperimentRunner>();
        services.AddSingleton<OneTube.Diagnostics.WindowsEventLogReader>();

        // TryAdd so a Phase-4 supervisor can pre-register a swappable
        // destination provider before AddOneTube runs (or replace it
        // afterwards via Replace). The single-host fallback is the
        // safe default for any deployment that doesn't use firmware.
        services.TryAddSingleton<IGatewayDestinationProvider>(sp =>
            new SingleHostDestinationProvider(sp.GetRequiredService<IGatewayHost>()));

        // YARP's direct forwarder logs every proxied request/response
        // at Information. OneTube emits a shorter operator-facing
        // request line below, so keep YARP internals quiet unless
        // something is actually wrong.
        services.TryAddEnumerable(ServiceDescriptor.Singleton<ILoggerProvider, OneTubeConsoleLoggerProvider>());
        services.AddLogging(builder =>
        {
            builder.AddFilter("Yarp.ReverseProxy.Forwarder.HttpForwarder", LogLevel.Warning);
            builder.AddFilter<ConsoleLoggerProvider>(typeof(DenoHostService).FullName!, LogLevel.None);
            builder.AddFilter<ConsoleLoggerProvider>("OneTube.Proxy", LogLevel.None);
        });
        services.Configure<SimpleConsoleFormatterOptions>(options =>
        {
            options.SingleLine = true;
            options.TimestampFormat = "";
        });

        services.AddHttpForwarder();
        return services;
    }

    /// <summary>
    /// Enable the firmware update protocol. Registers the
    /// <see cref="FirmwareSupervisor"/>, replaces the destination
    /// provider with a swappable variant, and rewires the active
    /// <see cref="DenoHostService"/> to consult <c>state.json</c>
    /// for its prebuilt directory at boot.
    ///
    /// <para>
    /// Must be called AFTER <see cref="AddOneTube"/>. The two are
    /// separated so deployments that don't want the update protocol
    /// pay zero cost (no extra hosted service, no extra disk reads,
    /// no extra HTTP routes) for it.
    /// </para>
    /// </summary>
    public static IServiceCollection AddOneTubeFirmware(
        this IServiceCollection services,
        Action<FirmwareOptions> configure)
    {
        services.Configure(configure);
        services.AddSingleton<FirmwareSupervisor>();
        services.AddHostedService(sp => sp.GetRequiredService<FirmwareSupervisor>());

        // Replace the default single-host destination provider with
        // the swappable one the supervisor needs to drive promotions.
        // The first IGatewayHost requested at startup is the active
        // slot; the supervisor swaps it for a candidate during a
        // promote.
        services.Replace(ServiceDescriptor.Singleton<IGatewayDestinationProvider>(sp =>
            new SwappableDestinationProvider(sp.GetRequiredService<IGatewayHost>())));

        // Replace the active DenoHostService factory so it consults
        // state.json (via the supervisor) for the boot prebuilt
        // directory. The supervisor must construct first — which it
        // does, because this factory pulls FirmwareSupervisor as a
        // dependency before constructing the DenoHostService.
        services.Replace(ServiceDescriptor.Singleton<DenoHostService>(sp =>
        {
            var oneTubeOpts = sp.GetRequiredService<IOptions<OneTubeOptions>>().Value;
            var supervisor = sp.GetRequiredService<FirmwareSupervisor>();
            var logger = sp.GetRequiredService<ILogger<DenoHostService>>();

            // SecretsStore is registered iff AddOneTubeSecrets was
            // called. Resolve via GetService (not Required) so the
            // firmware feature works whether or not secrets are
            // enabled. The provider delegate captures the store by
            // reference so each spawn picks up the latest snapshot.
            var secretsStore = sp.GetService<SecretsStore>();
            Func<IReadOnlyDictionary<string, string>?>? secretsProvider = secretsStore is null
                ? null
                : () => secretsStore.Snapshot();

            // Boot prebuilt dir order of precedence:
            //   1. state.json.current (managed by supervisor)
            //   2. OneTubeOptions.PrebuiltDir (cold install / dev)
            //   3. null (gateway runs without a prebuilt — esbuild on boot)
            var bootPrebuilt = supervisor.BootPrebuiltDir ?? oneTubeOpts.PrebuiltDir;
            var slot = new GatewaySlot("active", oneTubeOpts.Port, bootPrebuilt);
            return new DenoHostService(oneTubeOpts, slot, logger, secretsProvider);
        }));

        return services;
    }

    /// <summary>
    /// Enable the runtime-secrets editor. Layers a JSON-backed
    /// key/value store on top of <see cref="OneTubeOptions.EnvVars"/>
    /// (secrets win on collision) and wires a watcher that reboots
    /// the active gateway via the firmware side-by-side swap on every
    /// change, so the next request observes new values without
    /// dropping any in-flight ones.
    ///
    /// <para>Requires <see cref="AddOneTubeFirmware"/> — the swap
    /// machinery lives in the supervisor. Without firmware enabled,
    /// secrets edits would have no zero-downtime apply path; rather
    /// than fork the codebase to support a degraded restart-based
    /// path, we couple the two features.</para>
    ///
    /// <para>The endpoints are NOT auto-mapped — call
    /// <see cref="SecretsEndpoints.MapOneTubeSecrets"/> from the
    /// consumer's request pipeline and attach whatever auth/identity
    /// policy fits the operator's threat model.</para>
    /// </summary>
    public static IServiceCollection AddOneTubeSecrets(
        this IServiceCollection services,
        Action<SecretsOptions>? configure = null)
    {
        if (configure is not null) services.Configure(configure);
        else services.AddOptions<SecretsOptions>();

        services.AddSingleton<SecretsStore>();

        // The watcher must run as a hosted service so it gets
        // StartAsync (subscribe) + StopAsync (unsubscribe + dispose
        // timer). It depends on FirmwareSupervisor which is itself
        // a hosted service; .NET starts hosted services in
        // registration order, so AddOneTubeFirmware must come first.
        services.AddSingleton<SecretsHotSwapWatcher>();
        services.AddHostedService(sp => sp.GetRequiredService<SecretsHotSwapWatcher>());

        return services;
    }

    /// <summary>
    /// Map the live-secrets editor endpoints. Returns the underlying
    /// route group so the consumer can attach their own auth filter
    /// (<c>RequireAuthorization</c>, a custom <c>EndpointFilter</c>,
    /// etc.).
    /// </summary>
    public static RouteGroupBuilder MapOneTubeSecrets(this IEndpointRouteBuilder endpoints)
        => SecretsEndpoints.MapOneTubeSecrets(endpoints);

    /// <summary>
    /// Map the firmware admin endpoints under the configured
    /// <see cref="FirmwareOptions.RoutePrefix"/>. No-op when the
    /// firmware supervisor is disabled, so it's safe to call
    /// unconditionally from the consumer.
    /// </summary>
    public static IEndpointRouteBuilder MapOneTubeFirmware(this IEndpointRouteBuilder endpoints)
        => FirmwareEndpoints.MapOneTubeFirmware(endpoints);

    /// <summary>
    /// Maps <c>{pathPrefix}/{**catch-all}</c> to the embedded gateway
    /// via YARP direct forwarding. The destination is read from the
    /// registered <see cref="IGatewayDestinationProvider"/> on every
    /// request, so a firmware swap (Phase 4) just flips the provider's
    /// internal pointer — no Kestrel reconfigure, no restart, and no
    /// race against in-flight requests (those finish on the host they
    /// started on).
    /// </summary>
    /// <param name="app">The web app.</param>
    /// <param name="pathPrefix">Public path prefix to expose. Default <c>/functions/v1</c> matches Supabase's URL shape.</param>
    public static WebApplication MapOneTube(
        this WebApplication app,
        string pathPrefix = "/functions/v1")
    {
        var forwarder = app.Services.GetRequiredService<IHttpForwarder>();
        var destinationProvider = app.Services.GetRequiredService<IGatewayDestinationProvider>();
        var logger = app.Services.GetRequiredService<ILoggerFactory>().CreateLogger("OneTube.Proxy");

        var httpClient = new HttpMessageInvoker(new SocketsHttpHandler
        {
            UseProxy = false,
            AllowAutoRedirect = false,
            EnableMultipleHttp2Connections = true,
            // 5 s is enough for a healthy gateway on the same box; if
            // the connect itself is slow we'd rather fail fast and let
            // the caller retry than buffer requests against a wedged
            // backend.
            ConnectTimeout = TimeSpan.FromSeconds(5),
        });

        app.Map($"{pathPrefix}/{{**catch-all}}", async (HttpContext context) =>
        {
            var host = destinationProvider.GetActive();
            if (host is null)
            {
                // No active host means we're in cold start, the
                // firmware supervisor is mid-promote, or every
                // registered slot is unhealthy. 503 is the right
                // signal for "try again, this isn't a permanent
                // failure".
                context.Response.StatusCode = 503;
                await context.Response.WriteAsJsonAsync(new
                {
                    error = "Edge functions gateway has no active slot",
                });
                return;
            }

            logger.LogInformation(
                "[1tube] {Method} {Path}{QueryString}",
                context.Request.Method,
                context.Request.Path,
                context.Request.QueryString);

            var error = await forwarder.SendAsync(
                context,
                host.DestinationBaseUrl,
                httpClient);

            if (error != ForwarderError.None)
            {
                if (!context.Response.HasStarted)
                {
                    // 502 = gateway is up but the upstream call
                    // failed. 503 = we've decided the host isn't
                    // ready (cold start, mid-restart). Decision
                    // hinges on the host's per-instance IsRunning
                    // flag — no global IsRunning state any more.
                    context.Response.StatusCode = host.IsRunning ? 502 : 503;
                    await context.Response.WriteAsJsonAsync(new
                    {
                        error = host.IsRunning
                            ? "Gateway proxy error"
                            : "Edge functions gateway is starting up",
                    });
                }
            }
        });

        return app;
    }
}
