/** Exercise cancellation through the real HTTP gateway, not just the function host. */
import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { devGatewayEnv } from "./_helpers.ts";

for (const cause of ["disconnect", "timeout"] as const) {
  test(`gateway propagates ${cause} after the request body has been consumed`, async () => {
    const root = await mkdtemp(join(tmpdir(), "1tube-cancellation-"));
    const events = new Set<string>();
    const observer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
      events.add(new URL(req.url).pathname.slice(1));
      return new Response("ok");
    } });
    const reservation = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
    const port = reservation.port!;
    reservation.stop(true);
    const functions = join(root, "functions");
    await mkdir(join(functions, "wait"), { recursive: true });
    await writeFile(join(functions, "wait", "index.ts"), `
      (globalThis as any).__edgeFunctionRegistry.register(async (req: Request) => {
        if (req.method === "GET") return new Response("ready");
        await req.text();
        return new Promise<Response>((resolve) => {
          const aborted = async () => {
            await fetch("http://127.0.0.1:${observer.port}/aborted");
            resolve(new Response("cancelled"));
          };
          req.signal.addEventListener("abort", aborted, { once: true });
          if (req.signal.aborted) void aborted();
          void fetch("http://127.0.0.1:${observer.port}/started");
        });
      }, { public: true });
    `);
    const child = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "../src/server.ts"),
      "--dev", "--functions", functions, "--host", "127.0.0.1", "--port", String(port),
      "--timeout", cause === "timeout" ? "500" : "30000"], {
      cwd: root,
      env: { ...process.env, ...devGatewayEnv({ "1TUBE_DISABLE_RATE_LIMIT": "1", "1TUBE_INVOCATION_LOGS": "0" }) },
      stdout: "pipe", stderr: "pipe",
    });
    const logs = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const url = `http://127.0.0.1:${port}/functions/v1/wait`;
    const controller = new AbortController();
    async function until(check: () => boolean | Promise<boolean>) {
      const end = Date.now() + 10_000;
      while (Date.now() < end) {
        if (await check()) return;
        await Bun.sleep(20);
      }
      throw new Error(`Timed out waiting for ${cause}: ${Array.from(events)}`);
    }
    try {
      await until(async () => {
        try { return (await fetch(url, { signal: AbortSignal.timeout(500) })).ok; }
        catch { return false; }
      });
      const result = fetch(url, { method: "POST", body: "fully uploaded", signal: controller.signal })
        .catch(() => null);
      await until(() => events.has("started"));
      if (cause === "disconnect") controller.abort();
      await until(() => events.has("aborted"));
      if (cause === "timeout") expect((await result)?.status).toBe(504);
      else expect(await result).toBeNull();
    } finally {
      controller.abort();
      child.kill("SIGKILL");
      await child.exited;
      await logs;
      observer.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);
}
