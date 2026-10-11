/**
 * Function-host integration tests for the Bun backend.
 *
 * Spins up a real {@link createFunctionHost} against a temp functions dir:
 * every function is imported into its own `Bun.ModuleGraph`, so these tests
 * cover the properties the graph-per-function model is supposed to deliver —
 * dispatch, HMR that actually observes edits (fresh module state per graph),
 * graceful drain of in-flight requests, `Deno.serve` registration, error
 * attribution, and isolation between functions and from the gateway itself.
 */

import { afterEach, describe, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "./_assert.ts";
import { FunctionRegistry } from "../src/registry.ts";
import { FunctionSupervisor } from "../src/supervisor.ts";
import {
  createFunctionHost,
  type FunctionConsoleEvent,
  type FunctionHost,
  type FunctionHostOptions,
  type SpawnProgress,
} from "../src/backends/bun/function-host.ts";

async function write(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

async function tempDir(prefix: string): Promise<string> {
  return await realpath(await mkdtemp(join(tmpdir(), prefix)));
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!().catch(() => {});
});

interface Booted {
  dir: string;
  registry: FunctionRegistry;
  supervisor: FunctionSupervisor;
  host: FunctionHost;
  events: FunctionConsoleEvent[];
}

/** Write `files` (relative paths) into a temp dir and boot a host on it. */
async function boot(
  files: Record<string, string>,
  extra: Partial<FunctionHostOptions> = {},
): Promise<Booted & { loaded: string[]; errors: Array<{ name: string; error: string }> }> {
  const dir = await tempDir("1tube-function-host-");
  for (const [rel, text] of Object.entries(files)) await write(join(dir, rel), text);
  const registry = new FunctionRegistry();
  const supervisor = new FunctionSupervisor();
  const events: FunctionConsoleEvent[] = [];
  const host = createFunctionHost({
    functionsDir: dir,
    registry,
    supervisor,
    reloadDrainMs: 50,
    onConsole: (e) => events.push(e),
    ...extra,
  });
  cleanups.push(async () => {
    await host.stop();
    await rm(dir, { recursive: true, force: true });
  });
  const { loaded, errors } = await host.start();
  return { dir, registry, supervisor, host, events, loaded, errors };
}

async function call(
  registry: FunctionRegistry,
  name: string,
  init: { path?: string; headers?: Record<string, string>; auth?: unknown } = {},
): Promise<Response> {
  const handle = registry.workerHandle(name);
  assert(handle, `expected a handle for "${name}"`);
  return await handle.dispatch(
    new Request(`http://localhost${init.path ?? "/"}`, { headers: init.headers }),
    (init.auth ?? null) as never,
    new AbortController().signal,
  );
}

async function text(registry: FunctionRegistry, name: string): Promise<string> {
  return await (await call(registry, name)).text();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A function body built on the legacy 1tube registry stub. */
const legacy = (body: string) =>
  `(globalThis as any).__edgeFunctionRegistry.register(${body}, { public: true });\n`;

// ---------------------------------------------------------------------------
// Dispatch + reload
// ---------------------------------------------------------------------------

describe("function-host: dispatch and reload", () => {
  test("dispatches a request and returns the function's response", async () => {
    const progress: SpawnProgress[] = [];
    const dir = await tempDir("1tube-function-host-progress-");
    await write(
      join(dir, "hello", "index.ts"),
      legacy(`() => new Response("hello, world", { headers: { "x-fn": "hello" } })`),
    );
    const registry = new FunctionRegistry();
    const host = createFunctionHost({ functionsDir: dir, registry, supervisor: new FunctionSupervisor() });
    cleanups.push(async () => {
      await host.stop();
      await rm(dir, { recursive: true, force: true });
    });
    const { loaded, errors } = await host.start({ onSpawnFinish: (p) => progress.push(p) });
    assertEquals(errors, []);
    assertEquals(loaded, ["hello"]);
    assertEquals(host.list(), ["hello"]);
    assertEquals(progress.length, 1);
    assert(progress[0].ok);
    assert(progress[0].durationMs >= 0);
    assert(progress[0].importMs >= 0);
    // Boot prepares the whole batch up front; per-spawn graph/install is 0.
    assertEquals(progress[0].graphMs, 0);
    assertEquals(progress[0].installMs, 0);

    const handle = registry.workerHandle("hello");
    assert(handle, "expected hello to register a handle");
    assertEquals(handle.isPublic, true);
    const resp = await call(registry, "hello");
    assertEquals(resp.status, 200);
    assertEquals(resp.headers.get("x-fn"), "hello");
    assertEquals(await resp.text(), "hello, world");
  });

  test("edit to a relative dep is observable after reload (fresh module state)", async () => {
    const b = await boot({
      "fn/dep.ts": `export const value = "before";\n`,
      "fn/index.ts": `import { value } from "./dep.ts";\n${legacy(`() => new Response(value)`)}`,
    });
    const before = b.registry.workerHandle("fn")!;
    assertEquals(await text(b.registry, "fn"), "before");

    await write(join(b.dir, "fn", "dep.ts"), `export const value = "after";\n`);
    const summary = await b.host.reload(new Set(["fn"]), "test");
    assertEquals(summary.errors, []);
    assertEquals(summary.reloaded, ["fn"]);
    assertEquals(summary.reason, "test");

    assert(b.registry.workerHandle("fn") !== before, "expected a fresh handle after reload");
    assertEquals(await text(b.registry, "fn"), "after");
  });

  test("a request in flight during a reload still completes (graceful drain)", async () => {
    const slow = (body: string) =>
      legacy(`async () => {
  await new Promise((r) => setTimeout(r, 300));
  return new Response(${JSON.stringify(body)});
}`);
    const b = await boot({ "fn/index.ts": slow("slow-v1") }, { reloadDrainMs: 2000 });
    const before = b.registry.workerHandle("fn")!;
    const inflight = before.dispatch(
      new Request("http://localhost/"),
      null,
      new AbortController().signal,
    );
    await sleep(50);

    await write(join(b.dir, "fn", "index.ts"), slow("fast-v2"));
    const summary = await b.host.reload(new Set(["fn"]), "test");
    assertEquals(summary.reloaded, ["fn"]);
    const after = b.registry.workerHandle("fn")!;
    assert(after !== before);

    // The superseded graph keeps its timers alive until the request drains.
    const resp = await inflight;
    assertEquals(resp.status, 200);
    assertEquals(await resp.text(), "slow-v1");
    assertEquals(await text(b.registry, "fn"), "fast-v2");
  });

  test("a streaming body that finishes inside the drain linger is delivered in full", async () => {
    const b = await boot({
      "s/index.ts": legacy(`() => {
  let i = 0;
  return new Response(new ReadableStream({
    async pull(c) {
      await new Promise((r) => setTimeout(r, 40));
      c.enqueue(new TextEncoder().encode("c" + i));
      if (++i >= 4) c.close();
    },
  }));
}`),
    }, { reloadDrainMs: 5000 });
    const resp = await call(b.registry, "s");
    const body = resp.text();
    await b.host.reload(new Set(["s"]), "test");
    assertEquals(await body, "c0c1c2c3");
  });

  // Disposing a graph cancels its timers and I/O; with `trackStreams` (on
  // under HMR) an open response body keeps the superseded graph alive.
  test("a long streaming body survives the drain of its graph (trackStreams)", async () => {
    const b = await boot({
      "s/index.ts": legacy(`() => {
  let i = 0;
  return new Response(new ReadableStream({
    async pull(c) {
      await new Promise((r) => setTimeout(r, 200));
      c.enqueue(new TextEncoder().encode("c" + i));
      if (++i >= 5) c.close();
    },
  }));
}`),
    }, { reloadDrainMs: 5000, trackStreams: true });
    const resp = await call(b.registry, "s");
    const body = resp.text();
    await b.host.reload(new Set(["s"]), "test");
    const outcome = await Promise.race([body, sleep(3000).then(() => "STALLED")]);
    assertEquals(outcome, "c0c1c2c3c4");
  });

  test("a stream outliving the drain cap is ended, not left hanging (trackStreams)", async () => {
    const b = await boot({
      "s/index.ts": legacy(`() => new Response(new ReadableStream({
  async pull(c) {
    await new Promise((r) => setTimeout(r, 100));
    c.enqueue(new TextEncoder().encode("x"));
  },
}))`),
    }, { reloadDrainMs: 300, trackStreams: true });
    const resp = await call(b.registry, "s");
    const body = resp.text().then(() => "COMPLETED", () => "ERRORED");
    await b.host.reload(new Set(["s"]), "test");
    const outcome = await Promise.race([body, sleep(3000).then(() => "STALLED")]);
    assertEquals(outcome, "ERRORED");
  });

  test("EdgeRuntime.waitUntil work keeps a superseded graph alive until it settles", async () => {
    const marker = join(tmpdir(), `1tube-waituntil-${crypto.randomUUID()}`);
    cleanups.push(() => rm(marker, { force: true }));
    const src = (v: string) =>
      legacy(`() => {
  EdgeRuntime.waitUntil(new Promise((r) => setTimeout(r, 250)).then(() =>
    Deno.writeTextFile(${JSON.stringify(marker)}, ${JSON.stringify(v)})));
  return new Response("queued");
}`);
    const b = await boot({ "fn/index.ts": src("v1") }, { reloadDrainMs: 3000 });
    assertEquals(await text(b.registry, "fn"), "queued");
    await write(join(b.dir, "fn", "index.ts"), src("v2"));
    await b.host.reload(new Set(["fn"]), "test");
    await sleep(500);
    assertEquals(await Bun.file(marker).text(), "v1");
  });

  test("reload removes a function whose index.ts was deleted", async () => {
    const b = await boot({ "ghost/index.ts": legacy(`() => new Response("ok")`) });
    assert(b.registry.workerHandle("ghost"));
    await rm(join(b.dir, "ghost"), { recursive: true });
    const summary = await b.host.reload(new Set(["ghost"]), "test-delete");
    assertEquals(summary.removed, ["ghost"]);
    assertEquals(b.registry.workerHandle("ghost"), undefined);
    assertEquals(b.registry.has("ghost"), false);
    assertEquals(b.host.bootState("ghost"), undefined);
    assertEquals(b.host.list(), []);
  });

  test("reload('all') discovers additions and removals", async () => {
    const b = await boot({
      "keep/index.ts": legacy(`() => new Response("keep")`),
      "drop/index.ts": legacy(`() => new Response("drop")`),
    });
    await rm(join(b.dir, "drop"), { recursive: true });
    await write(join(b.dir, "fresh", "index.ts"), legacy(`() => new Response("fresh")`));
    const summary = await b.host.reload("all", "full");
    assertEquals(summary.added, ["fresh"]);
    assertEquals(summary.removed, ["drop"]);
    assertEquals(summary.reloaded, ["keep"]);
    assertEquals(b.host.list(), ["fresh", "keep"]);
    assertEquals(await text(b.registry, "fresh"), "fresh");
  });

  test("a dispatch whose signal aborts rejects with AbortError", async () => {
    const b = await boot({
      "hang/index.ts": legacy(`() => new Promise(() => {})`),
    });
    const ac = new AbortController();
    const p = b.registry.workerHandle("hang")!.dispatch(
      new Request("http://localhost/"),
      null,
      ac.signal,
    );
    ac.abort();
    const err = await assertRejects(() => p);
    assertEquals(err.name, "AbortError");
  });

  test("import-time failures and missing serve() are boot errors, not crashes", async () => {
    const b = await boot({
      "throws/index.ts": `throw new Error("boom at import time");\n`,
      "silent/index.ts": `export const x = 1;\n`,
      "syntax/index.ts": `export const = ;\n`,
      "fine/index.ts": legacy(`() => new Response("ok")`),
    });
    assertEquals(b.loaded, ["fine"]);
    const byName = new Map(b.errors.map((e) => [e.name, e.error]));
    assertStringIncludes(byName.get("throws")!, "boom at import time");
    assertStringIncludes(byName.get("silent")!, "without calling serve()");
    assert(byName.has("syntax"));
    assertEquals(b.host.bootState("throws"), "failed");
    assertEquals(await text(b.registry, "fine"), "ok");
  });
});

// ---------------------------------------------------------------------------
// Deno.serve registration
// ---------------------------------------------------------------------------

describe("function-host: Deno.serve", () => {
  test("Deno.serve(handler) registers an authenticated handler", async () => {
    const b = await boot({
      "plain/index.ts": `Deno.serve((req) => new Response("served " + new URL(req.url).pathname));\n`,
      "opts/index.ts":
        `Deno.serve({ port: 8000 }, () => new Response("with options"));\n`,
      "obj/index.ts": `Deno.serve({ handler: () => new Response("handler object") });\n`,
    });
    assertEquals(b.errors, []);
    const handle = b.registry.workerHandle("plain")!;
    // Supabase's gateway verifies JWTs by default (verify_jwt = true).
    assertEquals(handle.isPublic, false);
    assertEquals(await (await call(b.registry, "plain", { path: "/x" })).text(), "served /x");
    assertEquals(await text(b.registry, "opts"), "with options");
    assertEquals(await text(b.registry, "obj"), "handler object");
  });

  test("the handler's second argument is Deno's ServeHandlerInfo, not the auth context", async () => {
    const b = await boot({
      "info/index.ts": `Deno.serve((_req, info) => Response.json({
  keys: Object.keys(info).sort(),
  hostname: info.remoteAddr.hostname,
  transport: info.remoteAddr.transport,
}));\n`,
    });
    const resp = await call(b.registry, "info", {
      headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" },
      auth: { userId: "u1", email: "u@x", rawToken: "t", payload: {} },
    });
    assertEquals(await resp.json(), {
      keys: ["completed", "remoteAddr"],
      hostname: "203.0.113.7",
      transport: "tcp",
    });
  });

  test("the returned server object is inert and serving twice keeps the last handler", async () => {
    const b = await boot({
      "twice/index.ts": `
const s = Deno.serve(() => new Response("first"));
if (typeof s.shutdown !== "function" || !(s.finished instanceof Promise)) throw new Error("bad server shape");
await s.shutdown();
Deno.serve(() => new Response("second"));
`,
    });
    assertEquals(b.errors, []);
    assertEquals(await text(b.registry, "twice"), "second");
  });

  test("Deno.serve without a handler fails the import", async () => {
    const b = await boot({ "bad/index.ts": `Deno.serve({ port: 1 });\n` });
    assertEquals(b.errors.length, 1);
    assertStringIncludes(b.errors[0].error, "requires a handler");
  });
});

// ---------------------------------------------------------------------------
// Isolation between functions and from the gateway
// ---------------------------------------------------------------------------

describe("function-host: isolation", () => {
  const counter = `
import { bump } from "../_shared/state.ts";
${legacy(`() => Response.json({ n: bump(), x: (globalThis as any).x ?? null })`)}`;

  test("module state of a shared import is per function", async () => {
    const b = await boot({
      "_shared/state.ts": `let n = 0;\nexport function bump() { return ++n; }\n`,
      "a/index.ts": counter,
      "b/index.ts": counter,
    });
    assertEquals((await (await call(b.registry, "a")).json()).n, 1);
    assertEquals((await (await call(b.registry, "a")).json()).n, 2);
    // b imported the same file into its own graph: its counter starts over.
    assertEquals((await (await call(b.registry, "b")).json()).n, 1);
  });

  test("globalThis writes stay in the function that made them", async () => {
    const b = await boot({
      "writer/index.ts": `
(globalThis as any).x = "from-writer";
globalThis.__leak = 1;
self.y = "via-self";
${legacy(`() => Response.json({ x: (globalThis as any).x, y: (globalThis as any).y, same: globalThis === self })`)}`,
      "reader/index.ts": legacy(
        `() => Response.json({ x: (globalThis as any).x ?? null, y: (globalThis as any).y ?? null, has: "x" in globalThis })`,
      ),
    });
    assertEquals(await (await call(b.registry, "writer")).json(), {
      x: "from-writer",
      y: "via-self",
      same: true,
    });
    assertEquals(await (await call(b.registry, "reader")).json(), { x: null, y: null, has: false });
    // The gateway's own global object is never touched.
    const g = globalThis as Record<string, unknown>;
    assertEquals(g.x, undefined);
    assertEquals(g.__leak, undefined);
    assertEquals(g.y, undefined);
  });

  test("each function sees its own Deno / EdgeRuntime / registry through globalThis", async () => {
    const probe = legacy(`() => Response.json({
  bare: typeof Deno,
  viaGlobal: globalThis.Deno === Deno,
  edge: typeof (globalThis as any).EdgeRuntime?.waitUntil,
  reg: typeof (globalThis as any).__edgeFunctionRegistry?.register,
})`);
    const b = await boot({ "a/index.ts": probe });
    assertEquals(await (await call(b.registry, "a")).json(), {
      bare: "object",
      viaGlobal: true,
      edge: "function",
      reg: "function",
    });
    const g = globalThis as Record<string, unknown>;
    assertEquals(g.Deno, undefined);
    assertEquals(g.EdgeRuntime, undefined);
    assertEquals(g.__edgeFunctionRegistry, undefined);
  });

  test("non-configurable globalThis definitions work and stay local", async () => {
    const b = await boot({
      "pinned/index.ts": `
Object.defineProperty(globalThis, "PINNED", { value: 41, configurable: false, writable: false, enumerable: true });
let threw = false;
try { (globalThis as any).PINNED = 1; } catch { threw = true; }
let deleted = true;
try { deleted = delete (globalThis as any).PINNED; } catch { deleted = false; }
${legacy(`() => Response.json({
  value: (globalThis as any).PINNED + 1,
  threw,
  deleted,
  desc: Object.getOwnPropertyDescriptor(globalThis, "PINNED")?.configurable,
  listed: Object.keys(globalThis).includes("PINNED"),
  undef: Object.getOwnPropertyDescriptor(globalThis, "undefined")?.configurable,
})`)}`,
      "other/index.ts": legacy(`() => Response.json({ has: "PINNED" in globalThis })`),
    });
    assertEquals(b.errors, []);
    assertEquals(await (await call(b.registry, "pinned")).json(), {
      value: 42,
      threw: true,
      deleted: false,
      desc: false,
      listed: true,
      undef: false,
    });
    assertEquals(await (await call(b.registry, "other")).json(), { has: false });
    assertEquals((globalThis as Record<string, unknown>).PINNED, undefined);
  });

  test("addEventListener is scoped to the function", async () => {
    const b = await boot({
      "listener/index.ts": `
let hits = 0;
addEventListener("ping", () => hits++);
${legacy(`() => { dispatchEvent(new Event("ping")); return new Response(String(hits)); }`)}`,
      "emitter/index.ts": legacy(
        `() => { globalThis.dispatchEvent(new Event("ping")); return new Response("sent"); }`,
      ),
    });
    assertEquals(await text(b.registry, "emitter"), "sent");
    globalThis.dispatchEvent(new Event("ping"));
    // Only the function's own dispatch reached its listener.
    assertEquals(await text(b.registry, "listener"), "1");
  });

  test("timers of a disposed graph are cancelled", async () => {
    const ticks = join(tmpdir(), `1tube-ticks-${crypto.randomUUID()}`);
    cleanups.push(() => rm(ticks, { force: true }));
    const b = await boot({
      "ticker/index.ts": `
setInterval(() => Deno.writeTextFileSync(${JSON.stringify(ticks)}, "x", { append: true }), 20);
${legacy(`() => new Response("ok")`)}`,
    }, { reloadDrainMs: 0 });
    await sleep(120);
    await b.host.reload(new Set(["ticker"]), "swap");
    await b.host.stop();
    const atStop = (await Bun.file(ticks).text()).length;
    assert(atStop > 0, "the interval should have run before stop");
    await sleep(150);
    assertEquals((await Bun.file(ticks).text()).length, atStop, "no ticks after dispose");
  });

  test("beforeunload is delivered on reload and stop; throwing listeners are attributed", async () => {
    const log = join(tmpdir(), `1tube-unload-${crypto.randomUUID()}`);
    cleanups.push(() => rm(log, { force: true }));
    const src = (v: string) => `
addEventListener("beforeunload", (ev) => {
  Deno.writeTextFileSync(${JSON.stringify(log)}, ${JSON.stringify(v)} + ":" + ev.detail?.reason + ";", { append: true });
  throw new Error("listener boom ${v}");
});
${legacy(`() => new Response(${JSON.stringify(v)})`)}`;
    const b = await boot({ "fn/index.ts": src("v1") }, { reloadDrainMs: 0 });
    await write(join(b.dir, "fn", "index.ts"), src("v2"));
    await b.host.reload(new Set(["fn"]), "test");
    assertEquals(await Bun.file(log).text(), "v1:termination;");
    await b.host.stop();
    assertEquals(await Bun.file(log).text(), "v1:termination;v2:termination;");
    const errs = b.events.filter((e) => e.level === "error" && e.message.includes("listener boom"));
    assertEquals(errs.length, 2);
    assertEquals(errs[0].functionName, "fn");
  });

  test("uncaught errors from function timers are attributed via onError", async () => {
    const b = await boot({
      "leaky/index.ts": legacy(`() => {
  setTimeout(() => { throw new Error("timer boom"); }, 0);
  Promise.reject(new Error("orphan rejection"));
  return new Response("ok");
}`),
    });
    assertEquals(await text(b.registry, "leaky"), "ok");
    await sleep(50);
    const msgs = b.events.filter((e) => e.functionName === "leaky" && e.level === "error")
      .map((e) => e.message);
    assert(msgs.some((m) => m.startsWith("Uncaught error: timer boom")), JSON.stringify(msgs));
    assert(msgs.some((m) => m.startsWith("Unhandled rejection: orphan rejection")), JSON.stringify(msgs));
    assertEquals(b.supervisor.stats("leaky").errors, 2);
  });
});

// ---------------------------------------------------------------------------
// Env scoping
// ---------------------------------------------------------------------------

describe("function-host: env scoping", () => {
  const KEY_OK = "ONETUBE_TEST_ALLOWED";
  const KEY_NO = "ONETUBE_TEST_SECRET";
  const probe = legacy(`() => {
  let setErr = null;
  try { Deno.env.set("${KEY_OK}", "mutated"); } catch (e) { setErr = e.name; }
  let procErr = false;
  try { process.env.${KEY_OK} = "mutated"; } catch { procErr = true; }
  return Response.json({
    denoOk: Deno.env.get("${KEY_OK}") ?? null,
    denoNo: Deno.env.get("${KEY_NO}") ?? null,
    procOk: process.env.${KEY_OK} ?? null,
    procNo: process.env.${KEY_NO} ?? null,
    hasNo: Deno.env.has("${KEY_NO}"),
    keys: Object.keys(Deno.env.toObject()).filter((k) => k.startsWith("ONETUBE_TEST_")),
    setErr,
    procErr,
  });
}`);

  afterEach(() => {
    delete process.env[KEY_OK];
    delete process.env[KEY_NO];
  });

  test("enforceEnv filters reads by the manifest and refuses writes", async () => {
    process.env[KEY_OK] = "ok";
    process.env[KEY_NO] = "secret";
    const b = await boot({
      "scoped/index.ts": probe,
      "scoped/1tube.json": JSON.stringify({ permissions: { env: [KEY_OK] } }),
    }, { enforceEnv: true });
    assertEquals(b.errors, []);
    assertEquals(await (await call(b.registry, "scoped")).json(), {
      denoOk: "ok",
      denoNo: null,
      procOk: "ok",
      procNo: null,
      hasNo: false,
      keys: [KEY_OK],
      setErr: "PermissionDenied",
      procErr: true,
    });
    assertEquals(process.env[KEY_OK], "ok");
  });

  test("without enforcement env is a passthrough", async () => {
    process.env[KEY_NO] = "secret";
    const b = await boot({
      "open/index.ts": legacy(`() => Response.json({ v: Deno.env.get("${KEY_NO}"), p: process.env.${KEY_NO} })`),
    });
    assertEquals(await (await call(b.registry, "open")).json(), { v: "secret", p: "secret" });
  });
});
