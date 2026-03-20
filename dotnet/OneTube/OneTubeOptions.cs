namespace OneTube;

public sealed class OneTubeOptions
{
    /// <summary>
    /// Absolute path to the 1tube project root (containing src/server.ts).
    /// </summary>
    public required string ProjectPath { get; set; }

    /// <summary>
    /// Absolute path to the edge functions directory (supabase/functions/).
    /// </summary>
    public required string FunctionsPath { get; set; }

    /// <summary>
    /// Port the Deno gateway listens on. Default: 3100.
    /// </summary>
    public int Port { get; set; } = 3100;

    /// <summary>
    /// Path to the deno binary. Defaults to "deno" (resolved from PATH).
    /// </summary>
    public string DenoBinary { get; set; } = "deno";

    /// <summary>
    /// Environment variables forwarded to the Deno process.
    /// Keys like SUPABASE_URL, JWT_SECRET, etc.
    /// </summary>
    public Dictionary<string, string> EnvVars { get; set; } = new();

    /// <summary>
    /// Health check interval in milliseconds. Default: 10000.
    /// </summary>
    public int HealthCheckIntervalMs { get; set; } = 10_000;

    /// <summary>
    /// Maximum consecutive health check failures before restarting. Default: 3.
    /// </summary>
    public int MaxConsecutiveFailures { get; set; } = 3;
}
