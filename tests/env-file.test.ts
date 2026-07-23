/**
 * Dotenv parse / apply / path-resolution for HMR secret reloads.
 */

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  applyEnvFiles,
  isEnvFileEvent,
  parseEnvFile,
  resetEnvFileOwnership,
  resolveWatchedEnvFiles,
} from "../src/env-file.ts";
import {
  createEnvHotReloader,
  type EnvHotReloader,
} from "../src/backends/env-hot-reloader.ts";
import type { FsEventStream } from "../src/backends/deno/hot-reloader.ts";

Deno.test("parseEnvFile: basic keys, quotes, comments, export", () => {
  const m = parseEnvFile(`
# comment
FOO=bar
export BAR=baz
QUOTED="hello world"
SINGLE='x=y'
ESCAPED="a\\nb"
FIRST=one
FIRST=two
INLINE=val # trailing
BAD NAME=nope
`);
  assertEquals(m.get("FOO"), "bar");
  assertEquals(m.get("BAR"), "baz");
  assertEquals(m.get("QUOTED"), "hello world");
  assertEquals(m.get("SINGLE"), "x=y");
  assertEquals(m.get("ESCAPED"), "a\nb");
  assertEquals(m.get("FIRST"), "one");
  assertEquals(m.get("INLINE"), "val");
  assertEquals(m.has("BAD NAME"), false);
});

Deno.test("applyEnvFiles: adds, updates, removes owned keys", () => {
  resetEnvFileOwnership();
  const store = new Map<string, string>([["KEEP", "os"]]);
  const env = {
    get: (k: string) => store.get(k),
    set: (k: string, v: string) => {
      store.set(k, v);
    },
    delete: (k: string) => {
      store.delete(k);
    },
  };

  const dir = Deno.makeTempDirSync({ prefix: "1tube-env-" });
  const path = join(dir, ".env");
  try {
    Deno.writeTextFileSync(path, "A=1\nB=2\nKEEP=override\n");
    const d1 = applyEnvFiles([path], env);
    assertEquals(d1.changed, true);
    assertEquals(d1.added, ["A", "B"]);
    assertEquals(d1.updated, ["KEEP"]);
    assertEquals(store.get("A"), "1");
    assertEquals(store.get("KEEP"), "override");

    Deno.writeTextFileSync(path, "A=1\nC=3\n");
    const d2 = applyEnvFiles([path], env);
    assertEquals(d2.updated, []);
    assertEquals(d2.added, ["C"]);
    assertEquals(d2.removed, ["B", "KEEP"]);
    assertEquals(store.has("B"), false);
    assertEquals(store.has("KEEP"), false);
    assertEquals(store.get("A"), "1");
    assertEquals(store.get("C"), "3");

    // No-op rewrite
    const d3 = applyEnvFiles([path], env);
    assertEquals(d3.changed, false);
  } finally {
    resetEnvFileOwnership();
    try {
      Deno.removeSync(dir, { recursive: true });
    } catch { /* */ }
  }
});

Deno.test("resolveWatchedEnvFiles: 1TUBE_ENV_FILES wins over convention", () => {
  const dir = Deno.makeTempDirSync({ prefix: "1tube-env-resolve-" });
  try {
    Deno.writeTextFileSync(join(dir, ".env"), "X=1\n");
    const explicit = resolveWatchedEnvFiles({
      cwd: dir,
      envFilesEnv: join(dir, "custom.env"),
    });
    assertEquals(explicit, [join(dir, "custom.env")]);

    const convention = resolveWatchedEnvFiles({
      cwd: dir,
      envFilesEnv: "",
    });
    assertEquals(convention, [join(dir, ".env")]);
  } finally {
    try {
      Deno.removeSync(dir, { recursive: true });
    } catch { /* */ }
  }
});

Deno.test("isEnvFileEvent: matches target path and sibling dir events", () => {
  const envFile = join("/proj", ".env");
  assert(isEnvFileEvent([envFile], [envFile]));
  assert(isEnvFileEvent([join("/proj", ".env.tmp")], [envFile]));
  assertEquals(isEnvFileEvent([join("/other", "x")], [envFile]), false);
});

class FakeClock {
  private timers = new Map<number, () => void>();
  private next = 1;
  get pending(): number {
    return this.timers.size;
  }
  setTimer = (cb: () => void, _ms: number): number => {
    const id = this.next++;
    this.timers.set(id, cb);
    return id;
  };
  clearTimer = (id: number): void => {
    this.timers.delete(id);
  };
  async fireAll(): Promise<void> {
    const cbs = [...this.timers.values()];
    this.timers.clear();
    for (const cb of cbs) await cb();
  }
}

function makePushableWatcher(): {
  stream: FsEventStream;
  push: (paths: string[]) => void;
  close: () => void;
} {
  const queue: Array<{ paths: string[] } | null> = [];
  let wake: (() => void) | null = null;
  const wait = () =>
    new Promise<void>((r) => {
      wake = r;
    });
  const stream: FsEventStream = {
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (queue.length === 0) await wait();
        const next = queue.shift()!;
        if (next === null) return;
        yield next;
      }
    },
    close() {
      queue.push(null);
      wake?.();
      wake = null;
    },
  };
  return {
    stream,
    push(paths) {
      queue.push({ paths });
      wake?.();
      wake = null;
    },
    close() {
      stream.close();
    },
  };
}

Deno.test("env hot reloader: applies diff and fires onChanged", async () => {
  resetEnvFileOwnership();
  const dir = Deno.makeTempDirSync({ prefix: "1tube-env-hmr-" });
  const envPath = join(dir, ".env");
  Deno.writeTextFileSync(envPath, "SECRET=old\n");

  const store = new Map<string, string>();
  const env = {
    get: (k: string) => store.get(k),
    set: (k: string, v: string) => {
      store.set(k, v);
    },
    delete: (k: string) => {
      store.delete(k);
    },
  };

  const clock = new FakeClock();
  const fake = makePushableWatcher();
  const diffs: string[] = [];
  let reloader: EnvHotReloader | null = null;
  try {
    reloader = createEnvHotReloader({
      envFiles: [envPath],
      env,
      debounceMs: 100,
      leadingMs: 10,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      watch: () => fake.stream,
      log: () => {},
      onChanged: (diff) => {
        diffs.push(`u=${diff.updated.join(",")};a=${diff.added.join(",")}`);
      },
    });
    await reloader.start();
    // Seed apply put SECRET=old into store + ownership.
    assertEquals(store.get("SECRET"), "old");

    Deno.writeTextFileSync(envPath, "SECRET=new\n");
    fake.push([envPath]);
    // Wait until the consume loop has scheduled the leading-edge timer.
    for (let i = 0; i < 20 && clock.pending === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert(clock.pending > 0, "expected env watcher to arm a flush timer");
    await clock.fireAll();
    assertEquals(store.get("SECRET"), "new");
    assertEquals(diffs.length, 1);
    assertEquals(diffs[0], "u=SECRET;a=");
  } finally {
    await reloader?.stop();
    fake.close();
    resetEnvFileOwnership();
    try {
      Deno.removeSync(dir, { recursive: true });
    } catch { /* */ }
  }
});
