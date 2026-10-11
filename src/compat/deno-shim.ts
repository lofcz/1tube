/**
 * A `Deno` namespace for edge functions running under Bun.
 *
 * Supabase Edge Functions are written against Deno: `Deno.env.get(...)`,
 * `Deno.serve(handler)`, `Deno.readTextFile(...)`, `Deno.errors.NotFound`.
 * The function host gives every function its own instance (injected through
 * `Bun.ModuleGraph`'s `globals`), which buys two things the old Deno
 * backend needed extra machinery for:
 *
 *   - Per-function env scoping is just this object's `env` — no global
 *     `Deno.env` monkeypatch + AsyncLocalStorage lookup.
 *   - `Deno.serve(handler)` registers the handler with the gateway instead
 *     of binding a port, so a stock Supabase function (no 1tube shim) works.
 *
 * Coverage is the surface edge functions realistically touch: env, serve,
 * fs, Command, errors, process info, inspect. Process-wide operations that
 * would affect the gateway (`exit`, `chdir`, signal listeners, raw sockets)
 * are refused with a clear error rather than silently acting on the host.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function errorClass(name: string) {
  const C = class extends Error {
    constructor(message?: string, options?: ErrorOptions) {
      super(message, options);
      this.name = name;
    }
  };
  Object.defineProperty(C, "name", { value: name });
  return C;
}

/** Deno's error taxonomy, shared by every shim instance (instanceof works across functions). */
export const DenoErrors = {
  NotFound: errorClass("NotFound"),
  PermissionDenied: errorClass("PermissionDenied"),
  ConnectionRefused: errorClass("ConnectionRefused"),
  ConnectionReset: errorClass("ConnectionReset"),
  ConnectionAborted: errorClass("ConnectionAborted"),
  NotConnected: errorClass("NotConnected"),
  AddrInUse: errorClass("AddrInUse"),
  AddrNotAvailable: errorClass("AddrNotAvailable"),
  BrokenPipe: errorClass("BrokenPipe"),
  AlreadyExists: errorClass("AlreadyExists"),
  InvalidData: errorClass("InvalidData"),
  TimedOut: errorClass("TimedOut"),
  Interrupted: errorClass("Interrupted"),
  WriteZero: errorClass("WriteZero"),
  UnexpectedEof: errorClass("UnexpectedEof"),
  BadResource: errorClass("BadResource"),
  Http: errorClass("Http"),
  Busy: errorClass("Busy"),
  NotSupported: errorClass("NotSupported"),
  FilesystemLoop: errorClass("FilesystemLoop"),
  IsADirectory: errorClass("IsADirectory"),
  NetworkUnreachable: errorClass("NetworkUnreachable"),
  NotADirectory: errorClass("NotADirectory"),
  NotCapable: errorClass("NotCapable"),
};

const ERRNO_MAP: Record<string, keyof typeof DenoErrors> = {
  ENOENT: "NotFound",
  EACCES: "PermissionDenied",
  EPERM: "PermissionDenied",
  EEXIST: "AlreadyExists",
  EISDIR: "IsADirectory",
  ENOTDIR: "NotADirectory",
  ECONNREFUSED: "ConnectionRefused",
  ECONNRESET: "ConnectionReset",
  EADDRINUSE: "AddrInUse",
  EADDRNOTAVAIL: "AddrNotAvailable",
  EPIPE: "BrokenPipe",
  ETIMEDOUT: "TimedOut",
  EBUSY: "Busy",
  ELOOP: "FilesystemLoop",
  ENETUNREACH: "NetworkUnreachable",
};

/** Translate a Node errno error into the matching `Deno.errors.*` class. */
export function toDenoError(err: unknown): unknown {
  const code = (err as { code?: string })?.code;
  const kind = code ? ERRNO_MAP[code] : undefined;
  if (!kind) return err;
  const out = new DenoErrors[kind]((err as Error).message, { cause: err });
  return out;
}

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toDenoError(err);
  }
}

function wrapSync<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw toDenoError(err);
  }
}

// ---------------------------------------------------------------------------
// FileInfo / DirEntry
// ---------------------------------------------------------------------------

type PathLike = string | URL;

function p(path: PathLike): string {
  return path instanceof URL ? Bun.fileURLToPath(path) : path;
}

function fileInfo(st: fs.Stats) {
  return {
    isFile: st.isFile(),
    isDirectory: st.isDirectory(),
    isSymlink: st.isSymbolicLink(),
    size: st.size,
    mtime: st.mtime,
    atime: st.atime,
    birthtime: st.birthtime,
    ctime: st.ctime,
    dev: st.dev,
    ino: st.ino,
    mode: st.mode,
    nlink: st.nlink,
    uid: st.uid,
    gid: st.gid,
    rdev: st.rdev,
    blksize: st.blksize,
    blocks: st.blocks,
    isBlockDevice: st.isBlockDevice(),
    isCharDevice: st.isCharacterDevice(),
    isFifo: st.isFIFO(),
    isSocket: st.isSocket(),
  };
}

function dirEntry(d: fs.Dirent) {
  return {
    name: d.name,
    isFile: d.isFile(),
    isDirectory: d.isDirectory(),
    isSymlink: d.isSymbolicLink(),
  };
}

interface WriteOptions {
  append?: boolean;
  create?: boolean;
  createNew?: boolean;
  mode?: number;
  signal?: AbortSignal;
}

function writeFlag(o?: WriteOptions): string {
  if (o?.createNew) return o.append ? "ax" : "wx";
  return o?.append ? "a" : "w";
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

type Stdio = "piped" | "inherit" | "null";

interface CommandOptions {
  args?: string[];
  cwd?: PathLike;
  env?: Record<string, string>;
  clearEnv?: boolean;
  stdin?: Stdio;
  stdout?: Stdio;
  stderr?: Stdio;
  signal?: AbortSignal;
}

function nodeStdio(v: Stdio | undefined, dflt: Stdio): "pipe" | "inherit" | "ignore" {
  const s = v ?? dflt;
  return s === "piped" ? "pipe" : s === "inherit" ? "inherit" : "ignore";
}

async function drain(stream: Readable | null): Promise<Uint8Array> {
  if (!stream) return new Uint8Array();
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  return new Uint8Array(Buffer.concat(chunks));
}

function makeCommandClass(baseEnv: () => Record<string, string>) {
  return class Command {
    #cmd: string;
    #opts: CommandOptions;
    constructor(command: PathLike, options: CommandOptions = {}) {
      this.#cmd = p(command);
      this.#opts = options;
    }
    #start(defaultOut: Stdio) {
      const o = this.#opts;
      const env = o.clearEnv ? { ...(o.env ?? {}) } : { ...baseEnv(), ...(o.env ?? {}) };
      return spawn(this.#cmd, o.args ?? [], {
        cwd: o.cwd ? p(o.cwd) : undefined,
        env,
        signal: o.signal,
        stdio: [
          nodeStdio(o.stdin, "inherit"),
          nodeStdio(o.stdout, defaultOut),
          nodeStdio(o.stderr, defaultOut),
        ],
      });
    }
    spawn() {
      const child = this.#start("inherit");
      const status = new Promise<{ success: boolean; code: number; signal: string | null }>(
        (resolve, reject) => {
          child.once("error", (e) => reject(toDenoError(e)));
          child.once("close", (code, signal) =>
            resolve({ success: code === 0, code: code ?? 1, signal }));
        },
      );
      const toWeb = (s: Readable | null) =>
        s ? (Readable.toWeb(s) as unknown as ReadableStream<Uint8Array>) : null;
      return {
        pid: child.pid,
        status,
        stdin: child.stdin ? Writable.toWeb(child.stdin) : null,
        stdout: toWeb(child.stdout),
        stderr: toWeb(child.stderr),
        kill(sig: NodeJS.Signals = "SIGTERM") {
          child.kill(sig);
        },
        ref() {
          child.ref();
        },
        unref() {
          child.unref();
        },
        async output() {
          const [stdout, stderr, st] = await Promise.all([
            drain(child.stdout),
            drain(child.stderr),
            status,
          ]);
          return { ...st, stdout, stderr };
        },
      };
    }
    async output() {
      const child = this.#start("piped");
      const status = new Promise<{ code: number; signal: string | null }>((resolve, reject) => {
        child.once("error", (e) => reject(toDenoError(e)));
        child.once("close", (code, signal) => resolve({ code: code ?? 1, signal }));
      });
      const [stdout, stderr, st] = await Promise.all([
        drain(child.stdout),
        drain(child.stderr),
        status,
      ]);
      return { success: st.code === 0, code: st.code, signal: st.signal, stdout, stderr };
    }
    outputSync() {
      const o = this.#opts;
      const env = o.clearEnv ? { ...(o.env ?? {}) } : { ...baseEnv(), ...(o.env ?? {}) };
      const res = Bun.spawnSync([this.#cmd, ...(o.args ?? [])], {
        cwd: o.cwd ? p(o.cwd) : undefined,
        env,
        stdout: o.stdout === "inherit" ? "inherit" : o.stdout === "null" ? "ignore" : "pipe",
        stderr: o.stderr === "inherit" ? "inherit" : o.stderr === "null" ? "ignore" : "pipe",
      });
      return {
        success: res.exitCode === 0,
        code: res.exitCode ?? 1,
        signal: res.signalCode ?? null,
        stdout: new Uint8Array(res.stdout ?? []),
        stderr: new Uint8Array(res.stderr ?? []),
      };
    }
  };
}

// ---------------------------------------------------------------------------
// Namespace
// ---------------------------------------------------------------------------

export interface DenoEnv {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
  has(key: string): boolean;
  toObject(): Record<string, string>;
}

export type ServeHandler = (
  req: Request,
  info?: unknown,
) => Response | Promise<Response>;

export interface DenoShimOptions {
  functionName: string;
  env: DenoEnv;
  /** Called by `Deno.serve()`; the host captures the handler. */
  onServe: (handler: ServeHandler) => void;
  /** Called when a function registers a background task. */
  onWaitUntil?: (p: Promise<unknown>) => void;
}

function refuse(what: string, functionName: string): never {
  throw new DenoErrors.NotSupported(
    `${what} is not available to edge functions hosted by 1tube (function "${functionName}")`,
  );
}

/** Build the `Deno` object for one function. */
export function createDenoNamespace(opts: DenoShimOptions) {
  const { functionName, env } = opts;
  const Command = makeCommandClass(() => env.toObject());

  const serve = (a: unknown, b?: unknown) => {
    const handler = (typeof a === "function" ? a : typeof b === "function" ? b : (a as { handler?: unknown })?.handler) as
      | ServeHandler
      | undefined;
    if (typeof handler !== "function") {
      throw new TypeError("Deno.serve() requires a handler function");
    }
    opts.onServe(handler);
    const finished = new Promise<void>(() => {});
    return {
      finished,
      addr: { transport: "tcp", hostname: "0.0.0.0", port: 0 },
      shutdown: () => Promise.resolve(),
      ref() {},
      unref() {},
      [Symbol.asyncDispose]: () => Promise.resolve(),
    };
  };

  const stdStream = (fd: 1 | 2) => {
    const target = fd === 1 ? process.stdout : process.stderr;
    return {
      rid: fd,
      write: (data: Uint8Array) => {
        target.write(data);
        return Promise.resolve(data.byteLength);
      },
      writeSync: (data: Uint8Array) => {
        target.write(data);
        return data.byteLength;
      },
      isTerminal: () => Boolean(target.isTTY),
      // Lazy: each conversion attaches listeners to the shared process
      // stream, so only pay for it when a function actually asks.
      get writable() {
        return Writable.toWeb(target);
      },
      close() {},
    };
  };

  return {
    // --- environment / process -------------------------------------------
    env,
    args: [] as string[],
    get pid() {
      return process.pid;
    },
    get ppid() {
      return process.ppid;
    },
    noColor: Boolean(process.env.NO_COLOR),
    build: {
      os: process.platform === "win32" ? "windows" : process.platform,
      arch: process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : process.arch,
      target: `${process.arch}-${process.platform}`,
      vendor: "unknown",
      env: undefined,
    },
    version: { deno: `2.0.0-bun.${Bun.version}`, v8: "javascriptcore", typescript: "5.x" },
    mainModule: undefined as string | undefined,
    execPath: () => process.execPath,
    cwd: () => process.cwd(),
    chdir: () => refuse("Deno.chdir()", functionName),
    exit: (code?: number) =>
      refuse(`Deno.exit(${code ?? ""})`, functionName),
    hostname: () => os.hostname(),
    osRelease: () => os.release(),
    osUptime: () => os.uptime(),
    loadavg: () => os.loadavg(),
    networkInterfaces: () =>
      Object.entries(os.networkInterfaces()).flatMap(([name, list]) =>
        (list ?? []).map((i) => ({ name, ...i }))
      ),
    systemMemoryInfo: () => ({
      total: os.totalmem(),
      free: os.freemem(),
      available: os.freemem(),
      buffers: 0,
      cached: 0,
      swapTotal: 0,
      swapFree: 0,
    }),
    memoryUsage: () => {
      const m = process.memoryUsage();
      return { rss: m.rss, heapTotal: m.heapTotal, heapUsed: m.heapUsed, external: m.external };
    },
    inspect: (value: unknown, o?: { depth?: number; colors?: boolean }) =>
      Bun.inspect(value, { depth: o?.depth, colors: o?.colors }),
    addSignalListener: () => {},
    removeSignalListener: () => {},
    permissions: {
      query: () => Promise.resolve({ state: "granted", onchange: null }),
      querySync: () => ({ state: "granted", onchange: null }),
      request: () => Promise.resolve({ state: "granted", onchange: null }),
      revoke: () => Promise.resolve({ state: "granted", onchange: null }),
    },
    errors: DenoErrors,
    stdout: stdStream(1),
    stderr: stdStream(2),
    stdin: {
      rid: 0,
      get readable() {
        return Readable.toWeb(process.stdin);
      },
      isTerminal: () => Boolean(process.stdin.isTTY),
      setRaw() {},
      close() {},
    },

    // --- HTTP -------------------------------------------------------------
    serve,
    upgradeWebSocket: () => refuse("Deno.upgradeWebSocket()", functionName),
    listen: () => refuse("Deno.listen()", functionName),
    listenTls: () => refuse("Deno.listenTls()", functionName),
    connect: () => refuse("Deno.connect()", functionName),
    connectTls: () => refuse("Deno.connectTls()", functionName),
    openKv: () => refuse("Deno.openKv()", functionName),
    cron: () => refuse("Deno.cron()", functionName),

    // --- subprocess -------------------------------------------------------
    Command,

    // --- filesystem -------------------------------------------------------
    readTextFile: (path: PathLike) => wrap(() => fsp.readFile(p(path), "utf8")),
    readTextFileSync: (path: PathLike) => wrapSync(() => fs.readFileSync(p(path), "utf8")),
    readFile: (path: PathLike) =>
      wrap(async () => new Uint8Array(await fsp.readFile(p(path)))),
    readFileSync: (path: PathLike) =>
      wrapSync(() => new Uint8Array(fs.readFileSync(p(path)))),
    writeTextFile: (path: PathLike, data: string, o?: WriteOptions) =>
      wrap(() => fsp.writeFile(p(path), data, { flag: writeFlag(o), mode: o?.mode })),
    writeTextFileSync: (path: PathLike, data: string, o?: WriteOptions) =>
      wrapSync(() => fs.writeFileSync(p(path), data, { flag: writeFlag(o), mode: o?.mode })),
    writeFile: (path: PathLike, data: Uint8Array, o?: WriteOptions) =>
      wrap(() => fsp.writeFile(p(path), data, { flag: writeFlag(o), mode: o?.mode })),
    writeFileSync: (path: PathLike, data: Uint8Array, o?: WriteOptions) =>
      wrapSync(() => fs.writeFileSync(p(path), data, { flag: writeFlag(o), mode: o?.mode })),
    stat: (path: PathLike) => wrap(async () => fileInfo(await fsp.stat(p(path)))),
    statSync: (path: PathLike) => wrapSync(() => fileInfo(fs.statSync(p(path)))),
    lstat: (path: PathLike) => wrap(async () => fileInfo(await fsp.lstat(p(path)))),
    lstatSync: (path: PathLike) => wrapSync(() => fileInfo(fs.lstatSync(p(path)))),
    realPath: (path: PathLike) => wrap(() => fsp.realpath(p(path))),
    realPathSync: (path: PathLike) => wrapSync(() => fs.realpathSync(p(path))),
    readDir: (path: PathLike) => ({
      async *[Symbol.asyncIterator]() {
        const entries = await wrap(() => fsp.readdir(p(path), { withFileTypes: true }));
        for (const d of entries) yield dirEntry(d);
      },
    }),
    readDirSync: (path: PathLike) =>
      wrapSync(() => fs.readdirSync(p(path), { withFileTypes: true })).map(dirEntry),
    mkdir: (path: PathLike, o?: { recursive?: boolean; mode?: number }) =>
      wrap(async () => {
        await fsp.mkdir(p(path), o);
      }),
    mkdirSync: (path: PathLike, o?: { recursive?: boolean; mode?: number }) =>
      wrapSync(() => {
        fs.mkdirSync(p(path), o);
      }),
    // Like Deno, a non-recursive remove deletes an empty directory (and
    // fails on a non-empty one); node's `rm` refuses directories outright.
    remove: (path: PathLike, o?: { recursive?: boolean }) =>
      wrap(async () => {
        const st = await fsp.lstat(p(path));
        if (!st.isDirectory()) await fsp.unlink(p(path));
        else if (o?.recursive) await fsp.rm(p(path), { recursive: true });
        else await fsp.rmdir(p(path));
      }),
    removeSync: (path: PathLike, o?: { recursive?: boolean }) =>
      wrapSync(() => {
        const st = fs.lstatSync(p(path));
        if (!st.isDirectory()) fs.unlinkSync(p(path));
        else if (o?.recursive) fs.rmSync(p(path), { recursive: true });
        else fs.rmdirSync(p(path));
      }),
    rename: (from: PathLike, to: PathLike) => wrap(() => fsp.rename(p(from), p(to))),
    renameSync: (from: PathLike, to: PathLike) => wrapSync(() => fs.renameSync(p(from), p(to))),
    copyFile: (from: PathLike, to: PathLike) => wrap(() => fsp.copyFile(p(from), p(to))),
    copyFileSync: (from: PathLike, to: PathLike) =>
      wrapSync(() => fs.copyFileSync(p(from), p(to))),
    symlink: (target: PathLike, path: PathLike) => wrap(() => fsp.symlink(p(target), p(path))),
    readLink: (path: PathLike) => wrap(() => fsp.readlink(p(path))),
    truncate: (path: PathLike, len?: number) => wrap(() => fsp.truncate(p(path), len)),
    chmod: (path: PathLike, mode: number) => wrap(() => fsp.chmod(p(path), mode)),
    makeTempDir: (o?: { prefix?: string; dir?: string }) =>
      wrap(() => fsp.mkdtemp(join(o?.dir ?? os.tmpdir(), o?.prefix ?? "deno-"))),
    makeTempDirSync: (o?: { prefix?: string; dir?: string }) =>
      wrapSync(() => fs.mkdtempSync(join(o?.dir ?? os.tmpdir(), o?.prefix ?? "deno-"))),
    makeTempFile: (o?: { prefix?: string; suffix?: string; dir?: string }) =>
      wrap(async () => {
        const dir = await fsp.mkdtemp(join(o?.dir ?? os.tmpdir(), "deno-"));
        const file = join(dir, `${o?.prefix ?? ""}${crypto.randomUUID()}${o?.suffix ?? ""}`);
        await fsp.writeFile(file, "");
        return file;
      }),
    watchFs: () => refuse("Deno.watchFs()", functionName),
  };
}

export type DenoNamespace = ReturnType<typeof createDenoNamespace>;

/** Supabase's `EdgeRuntime` global (waitUntil for background work). */
export function createEdgeRuntime(opts: Pick<DenoShimOptions, "onWaitUntil">) {
  return {
    waitUntil(promise: Promise<unknown>) {
      const p = Promise.resolve(promise);
      opts.onWaitUntil?.(p);
      return p;
    },
  };
}
