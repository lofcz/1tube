using Xunit;

namespace OneTube.Tests;

/// <summary>
/// The argv/env contract between the .NET host and the Bun gateway
/// (<c>src/server.ts</c> parseArgs).
/// </summary>
public class GatewayCommandTests
{
    private static OneTubeOptions Options() => new()
    {
        FunctionsPath = "functions",
        DataRoot = Path.Combine(Path.GetTempPath(), "onetube-data"),
    };

    [Fact]
    public void BuildArgs_StartsWithServerScriptAndHasNoDenoFlags()
    {
        var args = GatewayCommand.BuildArgs(Options(), new GatewaySlot("active", 3100, null), "/gw/src/server.ts", null);

        // Bun must not auto-load a stray .env from the gateway dir.
        Assert.Equal("--no-env-file", args[0]);
        Assert.Equal("/gw/src/server.ts", args[1]);
        Assert.DoesNotContain("run", args);
        Assert.DoesNotContain("--allow-all", args);
        Assert.DoesNotContain("--lock", args);
        Assert.Equal("bun", args[args.IndexOf("--backend") + 1]);
    }

    [Fact]
    public void BuildArgs_WorkerdBackend()
    {
        var opts = Options();
        opts.Backend = OneTubeBackend.Workerd;
        var args = GatewayCommand.BuildArgs(opts, new GatewaySlot("active", 3100, null), "server.ts", "/usr/bin/workerd");

        Assert.Equal("workerd", args[args.IndexOf("--backend") + 1]);
        Assert.Equal("/usr/bin/workerd", args[args.IndexOf("--workerd-bin") + 1]);
    }

    [Fact]
    public void BuildArgs_DepsDirIsAbsoluteUnderDataRoot()
    {
        var opts = Options();
        var args = GatewayCommand.BuildArgs(opts, new GatewaySlot("active", 3100, null), "server.ts", null);

        var depsDir = args[args.IndexOf("--deps-dir") + 1];
        Assert.True(Path.IsPathRooted(depsDir));
        Assert.Equal(Path.Combine(opts.DataRoot!, "onetube", "deps"), depsDir);
        // The workerd bundler reads the store location from env, so both
        // channels must agree.
        Assert.Equal(depsDir, GatewayCommand.BuildEnvironment(opts, new GatewaySlot("active", 3100, null))["1TUBE_DEPS_DIR"]);
    }

    [Fact]
    public void ResolveDepsDir_WithoutDataRootSitsNextToLogDb()
    {
        var opts = new OneTubeOptions { FunctionsPath = "functions" };
        var logDir = Path.GetDirectoryName(GatewayCommand.ResolveLogDbPath(opts))!;
        Assert.Equal(Path.Combine(logDir, "deps"), GatewayCommand.ResolveDepsDir(opts));
    }

    [Fact]
    public void BuildEnvironment_DropsDenoEraVariables()
    {
        var env = GatewayCommand.BuildEnvironment(Options(), new GatewaySlot("active", 3100, null));
        Assert.False(env.ContainsKey("ONETUBE_LOCK"));
        Assert.False(env.ContainsKey("NPM_CONFIG_MIN_RELEASE_AGE"));
    }

    [Fact]
    public void Backend_DefaultsToBun_AndLegacyDenoAliasesIt()
    {
        Assert.Equal(OneTubeBackend.Bun, new OneTubeOptions { FunctionsPath = "f" }.Backend);
#pragma warning disable CS0618
        Assert.Equal(OneTubeBackend.Bun, OneTubeBackend.Deno);
#pragma warning restore CS0618
        Assert.Equal(OneTubeBackend.Bun, Enum.Parse<OneTubeBackend>("Deno"));
        Assert.Equal("bun", GatewayCommand.BackendName(Enum.Parse<OneTubeBackend>("Deno")));
    }

    [Theory]
    [InlineData(null, null, null, null)]
    [InlineData("/opt/bun/bin/bun", "/usr/bin/deno", "/opt/bun/bin/bun", null)]
    [InlineData(null, "/opt/bun/bin/bun", "/opt/bun/bin/bun", null)]
    [InlineData(null, "C:\\tools\\bun.exe", "C:\\tools\\bun.exe", null)]
    [InlineData(null, "bun", "bun", null)]
    [InlineData(null, "/usr/bin/deno", null, "/usr/bin/deno")]
    [InlineData(null, "deno/deno.exe", null, "deno/deno.exe")]
    public void SelectBunBinary_HonoursLegacyDenoBinaryOnlyWhenItIsBun(
        string? bunBinary, string? denoBinary, string? expected, string? expectedIgnored)
    {
#pragma warning disable CS0618
        var opts = new OneTubeOptions { FunctionsPath = "f", BunBinary = bunBinary, DenoBinary = denoBinary };
#pragma warning restore CS0618
        Assert.Equal(expected, GatewayCommand.SelectBunBinary(opts, out var ignored));
        Assert.Equal(expectedIgnored, ignored);
    }
}
