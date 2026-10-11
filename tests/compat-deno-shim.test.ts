/**
 * The `Deno` namespace edge functions get under Bun (`compat/deno-shim.ts`)
 * and the per-function env/process views (`compat/globals.ts`).
 *
 * Covers: env scoping, Deno.errors mapping, Deno.serve registration, the
 * refusal of process-wide operations, the fs helpers, and Deno.Command.
 */

import { afterEach, describe, test } from "bun:test";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "./_assert.ts";
import {
  createDenoNamespace,
  createEdgeRuntime,
  type DenoEnv,
  DenoErrors,
  type ServeHandler,
  toDenoError,
} from "../src/compat/deno-shim.ts";
import { createDenoEnv, createScopedEnvObject, createScopedProcess } from "../src/compat/globals.ts";

const KEY_OK = "ONETUBE_SHIM_ALLOWED";
const KEY_NO = "ONETUBE_SHIM_SECRET";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
  delete process.env[KEY_OK];
  delete process.env[KEY_NO];
});

async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "1tube-deno-shim-")));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function shim(opts: { env?: DenoEnv; onServe?: (h: ServeHandler) => void; onWaitUntil?: (p: Promise<unknown>) => void } = {}) {
  return createDenoNamespace({
    functionName: "probe",
    env: opts.env ?? createDenoEnv("probe", null, DenoErrors.PermissionDenied),
    onServe: opts.onServe ?? (() => {}),
    onWaitUntil: opts.onWaitUntil,
  });
}

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

describe("deno-shim: env", () => {
  test("an allowlist filters reads and refuses writes", () => {
    process.env[KEY_OK] = "ok";
    process.env[KEY_NO] = "secret";
    const env = createDenoEnv("scoped-fn", new Set([KEY_OK, "ONETUBE_SHIM_UNSET"]), DenoErrors.PermissionDenied);
    assertEquals(env.get(KEY_OK), "ok");
    assertEquals(env.get(KEY_NO), undefined);
    assertEquals(env.has(KEY_OK), true);
    assertEquals(env.has(KEY_NO), false);
    assertEquals(env.has("ONETUBE_SHIM_UNSET"), false);
    assertEquals(
      Object.keys(env.toObject()).filter((k) => k.startsWith("ONETUBE_SHIM_")),
      [KEY_OK],
    );
    const err = assertThrows(() => env.set(KEY_OK, "x"), DenoErrors.PermissionDenied);
    assertStringIncludes(err.message, `"scoped-fn"`);
    assertStringIncludes(err.message, `Deno.env.set("${KEY_OK}")`);
    assertThrows(() => env.delete(KEY_OK), DenoErrors.PermissionDenied, "Deno.env.delete");
    assertEquals(process.env[KEY_OK], "ok");
  });

  test("without an allowlist env is a read/write passthrough", () => {
    const env = createDenoEnv("open-fn", null, DenoErrors.PermissionDenied);
    env.set(KEY_OK, "written");
    assertEquals(process.env[KEY_OK], "written");
    assertEquals(env.get(KEY_OK), "written");
    assertEquals(env.toObject()[KEY_OK], "written");
    env.delete(KEY_OK);
    assertEquals(process.env[KEY_OK], undefined);
  });

  test("scoped process.env / process views", () => {
    process.env[KEY_OK] = "ok";
    process.env[KEY_NO] = "secret";
    const envObj = createScopedEnvObject(new Set([KEY_OK]));
    assertEquals(envObj[KEY_OK], "ok");
    assertEquals(envObj[KEY_NO], undefined);
    assertEquals(KEY_OK in envObj, true);
    assertEquals(KEY_NO in envObj, false);
    assertEquals(Object.keys(envObj), [KEY_OK]);
    assertEquals({ ...envObj }, { [KEY_OK]: "ok" });
    // Writes are refused (strict-mode code throws).
    assertThrows(() => {
      envObj[KEY_OK] = "x";
    }, TypeError);
    assertEquals(Reflect.deleteProperty(envObj, KEY_OK), false);

    const proc = createScopedProcess(envObj);
    assertEquals(proc.env, envObj);
    assertEquals(proc.cwd(), process.cwd());
    assertEquals(proc.pid, process.pid);
    assertEquals(typeof proc.nextTick, "function");
    assertEquals(proc.platform, process.platform);
  });
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

describe("deno-shim: errors", () => {
  test("errno codes map onto Deno.errors classes", () => {
    const cases: Array<[string, keyof typeof DenoErrors]> = [
      ["ENOENT", "NotFound"],
      ["EACCES", "PermissionDenied"],
      ["EPERM", "PermissionDenied"],
      ["EEXIST", "AlreadyExists"],
      ["EISDIR", "IsADirectory"],
      ["ENOTDIR", "NotADirectory"],
      ["ECONNREFUSED", "ConnectionRefused"],
      ["EADDRINUSE", "AddrInUse"],
      ["ETIMEDOUT", "TimedOut"],
    ];
    for (const [code, kind] of cases) {
      const src = Object.assign(new Error(`${code}: boom`), { code });
      const mapped = toDenoError(src) as Error;
      assertInstanceOf(mapped, DenoErrors[kind]);
      assertInstanceOf(mapped, Error);
      assertEquals(mapped.name, kind);
      assertEquals(mapped.message, `${code}: boom`);
      assertEquals(mapped.cause, src);
    }
    const plain = new Error("no code");
    assertEquals(toDenoError(plain), plain);
    const odd = Object.assign(new Error("odd"), { code: "EWHATEVER" });
    assertEquals(toDenoError(odd), odd);
    assertEquals(DenoErrors.NotFound.name, "NotFound");
  });

  test("one error taxonomy shared by every function's shim", () => {
    const a = shim();
    const b = shim();
    assertEquals(a.errors, b.errors);
    assertEquals(a.errors, DenoErrors);
  });
});

// ---------------------------------------------------------------------------
// serve / refusals / misc
// ---------------------------------------------------------------------------

describe("deno-shim: serve and process-wide operations", () => {
  test("Deno.serve captures the handler in every call shape", async () => {
    const captured: ServeHandler[] = [];
    const deno = shim({ onServe: (h) => captured.push(h) });
    const h1: ServeHandler = () => new Response("1");
    const h2: ServeHandler = () => new Response("2");
    const h3: ServeHandler = () => new Response("3");
    const server = deno.serve(h1);
    deno.serve({ port: 9999, hostname: "0.0.0.0" }, h2);
    deno.serve({ handler: h3 });
    assertEquals(captured, [h1, h2, h3]);
    // The server object is inert: the gateway owns the socket.
    assertEquals(server.addr.port, 0);
    await server.shutdown();
    server.ref();
    server.unref();
    assertInstanceOf(server.finished, Promise);
    assertThrows(() => deno.serve({ port: 1 }), TypeError, "requires a handler");
    assertThrows(() => (deno.serve as (...a: unknown[]) => unknown)(), TypeError);
  });

  test("process-wide operations are refused with NotSupported", () => {
    const deno = shim();
    const refused: Array<[string, () => unknown]> = [
      ["Deno.exit(", () => deno.exit(1)],
      ["Deno.chdir()", () => deno.chdir()],
      ["Deno.listen()", () => deno.listen()],
      ["Deno.listenTls()", () => deno.listenTls()],
      ["Deno.connect()", () => deno.connect()],
      ["Deno.connectTls()", () => deno.connectTls()],
      ["Deno.upgradeWebSocket()", () => deno.upgradeWebSocket()],
      ["Deno.openKv()", () => deno.openKv()],
      ["Deno.cron()", () => deno.cron()],
      ["Deno.watchFs()", () => deno.watchFs()],
    ];
    for (const [what, fn] of refused) {
      const err = assertThrows(fn, DenoErrors.NotSupported, what);
      assertStringIncludes(err.message, `function "probe"`);
    }
    // Signal listeners are accepted but never touch the gateway's signals.
    const before = process.listenerCount("SIGTERM");
    deno.addSignalListener();
    deno.removeSignalListener();
    assertEquals(process.listenerCount("SIGTERM"), before);
    assertEquals(process.cwd(), deno.cwd());
  });

  test("process info, permissions and inspect", async () => {
    const deno = shim();
    assertEquals(deno.args, []);
    assertEquals(deno.pid, process.pid);
    assertEquals(deno.execPath(), process.execPath);
    assertEquals(deno.build.os, process.platform === "win32" ? "windows" : process.platform);
    assertStringIncludes(deno.version.deno, `bun.${Bun.version}`);
    assertEquals((await deno.permissions.query()).state, "granted");
    assertEquals(deno.permissions.querySync().state, "granted");
    assertEquals(deno.inspect({ a: [1] }), Bun.inspect({ a: [1] }));
    assert(deno.memoryUsage().rss > 0);
    assert(deno.systemMemoryInfo().total > 0);
    assertEquals(typeof deno.hostname(), "string");
    assertEquals(deno.stdout.rid, 1);
    assertEquals(deno.stdout.writeSync(new Uint8Array()), 0);
  });

  test("EdgeRuntime.waitUntil reports the task and hands it back", async () => {
    const seen: Promise<unknown>[] = [];
    const rt = createEdgeRuntime({ onWaitUntil: (p) => seen.push(p) });
    const p = rt.waitUntil(Promise.resolve(42));
    assertEquals(seen.length, 1);
    assertEquals(await p, 42);
    // Non-promise values are tolerated.
    assertEquals(await rt.waitUntil(7 as unknown as Promise<number>), 7);
    // Without a sink it is just a passthrough.
    assertEquals(await createEdgeRuntime({}).waitUntil(Promise.resolve("x")), "x");
  });
});

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

describe("deno-shim: fs helpers", () => {
  test("read/write text and bytes, append, createNew, URL paths", async () => {
    const dir = await tempDir();
    const deno = shim();
    const file = join(dir, "a.txt");
    await deno.writeTextFile(file, "hello");
    await deno.writeTextFile(file, " world", { append: true });
    assertEquals(await deno.readTextFile(file), "hello world");
    assertEquals(deno.readTextFileSync(pathToFileURL(file)), "hello world");
    await assertRejects(() => deno.writeTextFile(file, "x", { createNew: true }), DenoErrors.AlreadyExists);
    assertThrows(() => deno.writeTextFileSync(file, "x", { createNew: true }), DenoErrors.AlreadyExists);

    const bin = join(dir, "b.bin");
    await deno.writeFile(bin, new Uint8Array([1, 2, 3]));
    deno.writeFileSync(bin, new Uint8Array([4]), { append: true });
    const bytes = await deno.readFile(bin);
    assertInstanceOf(bytes, Uint8Array);
    assertEquals([...bytes], [1, 2, 3, 4]);
    assertEquals([...deno.readFileSync(bin)], [1, 2, 3, 4]);
    await deno.truncate(bin, 2);
    assertEquals((await deno.stat(bin)).size, 2);
  });

  test("missing paths raise Deno.errors.NotFound (async and sync)", async () => {
    const dir = await tempDir();
    const deno = shim();
    const missing = join(dir, "nope.txt");
    await assertRejects(() => deno.readTextFile(missing), DenoErrors.NotFound);
    await assertRejects(() => deno.stat(missing), DenoErrors.NotFound);
    await assertRejects(() => deno.remove(missing), DenoErrors.NotFound);
    assertThrows(() => deno.readTextFileSync(missing), DenoErrors.NotFound);
    assertThrows(() => deno.statSync(missing), DenoErrors.NotFound);
    // The classic Supabase idiom.
    let notFound = false;
    try {
      await deno.readTextFile(missing);
    } catch (e) {
      notFound = e instanceof deno.errors.NotFound;
    }
    assert(notFound);
  });

  test("directories: mkdir, readDir, stat, remove, rename, copy, symlinks, temp", async () => {
    const dir = await tempDir();
    const deno = shim();
    await deno.mkdir(join(dir, "a", "b"), { recursive: true });
    await assertRejects(() => deno.mkdir(join(dir, "a")), DenoErrors.AlreadyExists);
    deno.mkdirSync(join(dir, "c"));
    await writeFile(join(dir, "a", "f.txt"), "f");

    const names: string[] = [];
    for await (const e of deno.readDir(join(dir, "a"))) names.push(`${e.name}:${e.isFile ? "f" : "d"}`);
    assertEquals(names.sort(), ["b:d", "f.txt:f"]);
    assertEquals(deno.readDirSync(dir).map((e) => e.name).sort(), ["a", "c"]);

    const st = await deno.stat(join(dir, "a"));
    assertEquals([st.isDirectory, st.isFile, st.isSymlink], [true, false, false]);
    assertInstanceOf(st.mtime, Date);

    await symlink(join(dir, "a", "f.txt"), join(dir, "link"));
    assertEquals((await deno.lstat(join(dir, "link"))).isSymlink, true);
    assertEquals((await deno.stat(join(dir, "link"))).isFile, true);
    assertEquals(await deno.readLink(join(dir, "link")), join(dir, "a", "f.txt"));
    assertEquals(await deno.realPath(join(dir, "link")), join(dir, "a", "f.txt"));

    await deno.copyFile(join(dir, "a", "f.txt"), join(dir, "copy.txt"));
    await deno.rename(join(dir, "copy.txt"), join(dir, "moved.txt"));
    assertEquals(await deno.readTextFile(join(dir, "moved.txt")), "f");

    // Non-recursive removal of a non-empty directory fails; of an empty
    // one it succeeds (Deno semantics); recursive removes trees.
    await assertRejects(() => deno.remove(join(dir, "a")));
    assertThrows(() => deno.removeSync(join(dir, "a")));
    await deno.remove(join(dir, "a"), { recursive: true });
    deno.removeSync(join(dir, "c"));
    await deno.mkdir(join(dir, "e"));
    await deno.remove(join(dir, "e"));
    await deno.remove(join(dir, "moved.txt"));
    assertEquals(deno.readDirSync(dir).map((e) => e.name), ["link"]);

    const tmp = await deno.makeTempDir({ prefix: "shim-", dir });
    assert(tmp.startsWith(join(dir, "shim-")));
    const tmpFile = await deno.makeTempFile({ dir, prefix: "p-", suffix: ".json" });
    assert(tmpFile.endsWith(".json"));
    assertEquals(await deno.readTextFile(tmpFile), "");
  });
});

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

describe("deno-shim: Command", () => {
  const bun = process.execPath;
  const decode = (b: Uint8Array) => new TextDecoder().decode(b);

  test("output() collects stdout/stderr and the exit status", async () => {
    const deno = shim();
    const out = await new deno.Command(bun, {
      args: ["-e", `console.log("out"); console.error("err"); process.exit(3)`],
    }).output();
    assertEquals(out.success, false);
    assertEquals(out.code, 3);
    assertEquals(decode(out.stdout).trim(), "out");
    assertEquals(decode(out.stderr).trim(), "err");

    const ok = await new deno.Command(bun, { args: ["-e", "console.log(process.cwd())"], cwd: tmpdir() }).output();
    assertEquals(ok.success, true);
    assertEquals(decode(ok.stdout).trim(), await realpath(tmpdir()));
  });

  test("the child's env comes from the function's (scoped) Deno.env", async () => {
    process.env[KEY_OK] = "ok";
    process.env[KEY_NO] = "secret";
    const allow = new Set([KEY_OK, "PATH"]);
    const deno = shim({ env: createDenoEnv("scoped", allow, DenoErrors.PermissionDenied) });
    const script = `console.log(JSON.stringify([process.env.${KEY_OK} ?? null, process.env.${KEY_NO} ?? null, process.env.EXTRA ?? null]))`;
    const out = await new deno.Command(bun, { args: ["-e", script], env: { EXTRA: "e" } }).output();
    assertEquals(JSON.parse(decode(out.stdout)), ["ok", null, "e"]);

    const cleared = await new deno.Command(bun, { args: ["-e", script], clearEnv: true, env: { EXTRA: "only" } })
      .output();
    assertEquals(JSON.parse(decode(cleared.stdout)), [null, null, "only"]);
  });

  test("spawn() streams and outputSync() blocks", async () => {
    const deno = shim();
    const child = new deno.Command(bun, {
      args: ["-e", `process.stdin.on("data", (d) => process.stdout.write(String(d).toUpperCase()))`],
      stdin: "piped",
      stdout: "piped",
    }).spawn();
    assert(typeof child.pid === "number");
    const writer = child.stdin!.getWriter();
    await writer.write(new TextEncoder().encode("shout"));
    await writer.close();
    const out = await child.output();
    assertEquals(out.success, true);
    assertEquals(decode(out.stdout), "SHOUT");

    const sync = new deno.Command(bun, { args: ["-e", `console.log("sync")`] }).outputSync();
    assertEquals(sync.success, true);
    assertEquals(decode(sync.stdout).trim(), "sync");
  });

  test("a missing executable rejects with Deno.errors.NotFound", async () => {
    const deno = shim();
    await assertRejects(
      () => new deno.Command("/definitely/not/a/binary-1tube").output(),
      DenoErrors.NotFound,
    );
  });

  test("kill() terminates a spawned child", async () => {
    const deno = shim();
    const child = new deno.Command(bun, { args: ["-e", "setInterval(() => {}, 1000)"], stdout: "null" }).spawn();
    child.kill("SIGKILL");
    const status = await child.status;
    assertEquals(status.success, false);
    assertEquals(status.signal, "SIGKILL");
  });
});
