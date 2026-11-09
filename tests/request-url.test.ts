import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { devGatewayEnv } from "./_helpers.ts";

test("Bun gateway preserves request URLs despite forged forwarding headers", async () => {
  const root = await mkdtemp(join(tmpdir(), "1tube-request-url-"));
  const reservation = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = reservation.port!;
  reservation.stop(true);
  const functions = join(root, "functions");
  await mkdir(join(functions, "probe"), { recursive: true });
  await writeFile(join(functions, "probe", "index.ts"), `
    globalThis.__edgeFunctionRegistry.register(async req => Response.json({
      url: req.url, method: req.method, body: await req.text(),
    }), { public: true });
  `);
  const child = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "../src/server.ts"),
    "--dev", "--functions", functions, "--host", "127.0.0.1", "--port", String(port)], {
    cwd: root,
    env: { ...process.env, ...devGatewayEnv({ "1TUBE_DISABLE_RATE_LIMIT": "1", "1TUBE_INVOCATION_LOGS": "0" }) },
    stdout: "pipe", stderr: "pipe",
  });
  const logs = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const origin = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + 30_000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${origin}/functions/v1/probe`, { signal: AbortSignal.timeout(500) });
        ready = response.ok;
        await response.body?.cancel();
        if (ready) break;
      } catch { /* gateway is still starting */ }
      await Bun.sleep(50);
    }
    expect(ready).toBe(true);
    const response = await fetch(`${origin}/functions/v1/probe?x=1`, {
      method: "POST", body: "streamed payload",
      headers: {
        "x-forwarded-host": "169.254.169.254",
        "x-forwarded-proto": "https",
        "x-1tube-request-url": "https://attacker.invalid/forged",
      },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      url: `${origin}/probe?x=1`, method: "POST", body: "streamed payload",
    });
  } finally {
    child.kill("SIGTERM");
    await child.exited;
    await logs;
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
