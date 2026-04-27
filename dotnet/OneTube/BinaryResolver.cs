using System.Diagnostics;
using Microsoft.Extensions.Logging;

namespace OneTube;

/// <summary>
/// Resolves an executable path with explicit-path-first semantics.
///
/// The two backends 1tube depends on (<c>deno</c> and <c>workerd</c>)
/// don't ship inside this NuGet package — operators install them out
/// of band. We give them three ways to point at a binary:
///
/// <list type="number">
///   <item>
///     <description>
///       <b>Absolute or relative path</b> (anything that contains a
///       directory separator or a file extension). Resolved via
///       <see cref="File.Exists(string)"/>; if the file isn't there,
///       resolution fails immediately. This is the recommended mode
///       on servers where PATH is opinionated and we don't want to
///       silently fall back to whatever a sibling tool has installed.
///     </description>
///   </item>
///   <item>
///     <description>
///       <b>Bare command name</b> (e.g. <c>"deno"</c>). The resolver
///       calls <c>where</c> on Windows or <c>which</c> on Unix and
///       captures the first hit. Useful on developer machines.
///     </description>
///   </item>
///   <item>
///     <description>
///       <b>Null/empty</b>. Same as the bare-name path using a default
///       command name supplied by the caller.
///     </description>
///   </item>
/// </list>
///
/// In all cases the resolver returns the absolute path it actually
/// verified, so the caller can pass that to <see cref="Process.Start"/>
/// and not depend on PATH a second time during spawn.
/// </summary>
internal static class BinaryResolver
{
    /// <summary>
    /// Resolve a binary, returning the absolute path or <c>null</c> if
    /// nothing was found. Logs a clear error on failure — callers are
    /// expected to surface that and refuse to start.
    /// </summary>
    public static string? Resolve(
        string? configured,
        string defaultCommandName,
        string humanLabel,
        ILogger logger)
    {
        var candidate = string.IsNullOrWhiteSpace(configured) ? defaultCommandName : configured.Trim();

        // If the value looks like a path (has a separator or an
        // extension), trust the operator: either it exists or we fail.
        // We deliberately don't fall through to PATH here — a typo'd
        // config path silently resolving to whatever's first on PATH
        // is exactly the surprise we want to avoid on servers.
        //
        // Relative paths are resolved against AppContext.BaseDirectory
        // (the host's bin/ at runtime) rather than
        // Environment.CurrentDirectory. This keeps the meaning of a
        // relative path stable across launch contexts (IIS service,
        // dotnet run from src/, dotnet run from repo root, …) — all
        // of which can leave cwd in surprising places.
        if (LooksLikePath(candidate))
        {
            string absolute = Path.IsPathRooted(candidate)
                ? candidate
                : Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, candidate));

            if (File.Exists(absolute))
            {
                return absolute;
            }

            logger.LogError(
                "{Label} binary not found at configured path: {Path} (resolved to {Absolute})",
                humanLabel, candidate, absolute);
            return null;
        }

        // Bare command — try PATH. We capture the *resolved* path
        // rather than passing the bare name through to Process.Start
        // so the spawn log shows what we actually picked.
        var resolved = LocateOnPath(candidate, logger);
        if (resolved is not null) return resolved;

        logger.LogError(
            "{Label} binary '{Name}' not found on PATH and no explicit path was configured. " +
            "Pass an absolute path via OneTubeOptions, or install it on the host.",
            humanLabel, candidate);
        return null;
    }

    private static bool LooksLikePath(string s)
        => s.Contains(Path.DirectorySeparatorChar)
        || s.Contains(Path.AltDirectorySeparatorChar)
        || Path.HasExtension(s);

    private static string? LocateOnPath(string commandName, ILogger logger)
    {
        // `where` (Windows) and `which` (Unix) both print one match
        // per line on stdout and exit 0 on success. We take the first
        // line — that's what the shell would have run anyway.
        var lookup = OperatingSystem.IsWindows() ? "where" : "which";

        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = lookup,
                Arguments = commandName,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
            };

            using var proc = Process.Start(psi);
            if (proc is null) return null;

            string stdout = proc.StandardOutput.ReadToEnd();
            // 5 s is generous — `where`/`which` are filesystem ops.
            // We bound this so a wedged `where` (rare, but seen on
            // Windows when a network share is on PATH) can't stall
            // the host startup forever.
            if (!proc.WaitForExit(5_000))
            {
                try { proc.Kill(entireProcessTree: true); } catch { /* best effort */ }
                logger.LogWarning(
                    "{Lookup} timed out resolving {Cmd}; treating as not-found",
                    lookup, commandName);
                return null;
            }
            if (proc.ExitCode != 0) return null;

            using var reader = new StringReader(stdout);
            string? first = reader.ReadLine()?.Trim();
            return string.IsNullOrEmpty(first) ? null : first;
        }
        catch (Exception ex)
        {
            // `where`/`which` themselves missing is theoretically
            // possible on a stripped-down container. Don't crash —
            // just report unfound and let the caller surface the
            // explicit-path requirement.
            logger.LogWarning(ex, "Failed to invoke {Lookup} for {Cmd}", lookup, commandName);
            return null;
        }
    }
}
