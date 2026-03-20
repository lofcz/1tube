using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.DependencyInjection;
using Yarp.ReverseProxy.Forwarder;

namespace OneTube;

public static class OneTubeExtensions
{
    /// <summary>
    /// Registers DenoHostService and configures options.
    /// </summary>
    public static IServiceCollection AddOneTube(
        this IServiceCollection services,
        Action<OneTubeOptions> configure)
    {
        services.Configure(configure);
        services.AddHostedService<DenoHostService>();
        services.AddHttpForwarder();
        return services;
    }

    /// <summary>
    /// Maps /functions/v1/{**catch-all} to the 1tube Deno gateway via YARP direct forwarding.
    /// Zero-copy proxying at the Kestrel level.
    /// </summary>
    public static WebApplication MapOneTube(
        this WebApplication app,
        int port = 3100,
        string pathPrefix = "/functions/v1")
    {
        var forwarder = app.Services.GetRequiredService<IHttpForwarder>();
        var httpClient = new HttpMessageInvoker(new SocketsHttpHandler
        {
            UseProxy = false,
            AllowAutoRedirect = false,
            EnableMultipleHttp2Connections = true,
            ConnectTimeout = TimeSpan.FromSeconds(5),
        });

        var destinationBase = $"http://localhost:{port}";

        app.Map($"{pathPrefix}/{{**catch-all}}", async (HttpContext context) =>
        {
            var error = await forwarder.SendAsync(
                context,
                destinationBase,
                httpClient);

            if (error != ForwarderError.None)
            {
                var errorFeature = context.GetForwarderErrorFeature();
                var ex = errorFeature?.Exception;

                if (!context.Response.HasStarted)
                {
                    context.Response.StatusCode = DenoHostService.IsRunning ? 502 : 503;
                    await context.Response.WriteAsJsonAsync(new
                    {
                        error = DenoHostService.IsRunning
                            ? "Gateway proxy error"
                            : "Edge functions gateway is starting up",
                    });
                }
            }
        });

        return app;
    }
}
