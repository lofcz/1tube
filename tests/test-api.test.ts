/**
 * `1tube/test`: the runtime-agnostic assertions, the `1tube test` command
 * (gateway resolution for function tests), and the node:test binding.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assert,
  AssertionError,
  assertArrayIncludes,
  assertEquals,
  assertExists,
  assertFalse,
  assertInstanceOf,
  assertMatch,
  assertNotEquals,
  assertNotMatch,
  assertObjectMatch,
  assertRejects,
  assertStrictEquals,
  assertStringIncludes,
  assertThrows,
  equal,
} from "../src/test/assert.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LAUNCH = join(ROOT, "src", "launch.ts");

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function project(files: Record<string, string>): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "1tube-test-api-")));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), text);
  }
  return dir;
}

const fails = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AssertionError);
    return (err as Error).message;
  }
  throw new Error("expected an AssertionError");
};

describe("assertions", () => {
  test("equal: structural, prototype-aware, order-insensitive collections", () => {
    expect(equal({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(equal(NaN, NaN)).toBe(true);
    expect(equal(0, -0)).toBe(false);
    expect(equal({ a: undefined }, {})).toBe(false);
    expect(equal(new Set([1, { x: 1 }]), new Set([{ x: 1 }, 1]))).toBe(true);
    expect(equal(new Map([[{ k: 1 }, "v"]]), new Map([[{ k: 1 }, "v"]]))).toBe(true);
    expect(equal(new Date(5), new Date(5))).toBe(true);
    expect(equal(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(equal(new Uint8Array([1, 2]), [1, 2])).toBe(false);
    expect(equal(/a/g, /a/g)).toBe(true);
    expect(equal(new Error("x"), new Error("y"))).toBe(false);
    class P {
      constructor(public v: number) {}
    }
    expect(equal(new P(1), { v: 1 })).toBe(false);
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    const cyc2: Record<string, unknown> = {};
    cyc2.self = cyc2;
    expect(equal(cyc, cyc2)).toBe(true);
  });

  test("assertEquals reports a line diff with the message", () => {
    const msg = fails(() => assertEquals({ a: 1, b: [1, 2] }, { a: 1, b: [1, 3] }, "ctx"));
    expect(msg).toContain("Values are not equal: ctx");
    expect(msg).toContain("-       2,");
    expect(msg).toContain("+       3,");
  });

  test("truthiness, strictness, strings, types", () => {
    assert(1);
    assertFalse(0);
    assertExists(0);
    assertNotEquals({ a: 1 }, { a: 2 });
    assertStrictEquals(1, 1);
    expect(fails(() => assertStrictEquals({ a: 1 }, { a: 1 }))).toContain("not reference-equal");
    assertStringIncludes("hello world", "lo w");
    assertMatch("abc", /b/);
    assertNotMatch("abc", /z/);
    assertInstanceOf(new TypeError("t"), Error);
    assertArrayIncludes([1, { a: 1 }, 3], [{ a: 1 }, 3]);
    assertObjectMatch({ a: 1, b: { c: 2, d: 3 } }, { b: { c: 2 } });
    expect(fails(() => assert(false, "custom"))).toBe("custom");
    expect(fails(() => assertExists(null))).toContain("not be null or undefined");
  });

  test("assertThrows / assertRejects return the error and check class + message", async () => {
    const err = assertThrows(() => {
      throw new TypeError("bad input");
    }, TypeError, "bad");
    expect(err.message).toBe("bad input");
    expect(fails(() => assertThrows(() => {}))).toContain("Expected function to throw");
    expect(fails(() => assertThrows(() => {
      throw new Error("x");
    }, TypeError))).toContain('instance of "TypeError"');

    const rej = await assertRejects(async () => {
      throw new RangeError("out of range");
    }, RangeError, "range");
    expect(rej).toBeInstanceOf(RangeError);
    await assertRejects(Promise.reject(new Error("p")));
    await expect(assertRejects(async () => {})).rejects.toThrow("Expected function to reject");
    await expect(assertRejects((() => {
      throw new Error("sync");
    }) as () => Promise<void>)).rejects.toThrow("throws when expected to reject");
  });
});

describe("1tube test", () => {
  const BUN_BINDING = join(ROOT, "src", "test", "bun.ts");

  test("runs function tests with the project's import map applied", async () => {
    const dir = await project({
      "functions/import_map.json": JSON.stringify({
        imports: { "@lib/greet": "./_shared/greet.ts", "1tube/test": BUN_BINDING },
      }),
      "functions/_shared/greet.ts": `export const greet = (n: string) => "hi " + n;\n`,
      "functions/hello/index.ts": `import { greet } from "@lib/greet";\nexport const handler = () => greet("bun");\n`,
      "functions/hello/hello.test.ts": `import { assertEquals, describe, runtime, test } from "1tube/test";
import { handler } from "./index.ts";
describe("hello", () => {
  test("mapped import resolves", () => assertEquals(handler(), "hi bun"));
  test("bun binding", () => assertEquals(runtime, "bun"));
  test.skip("skipped", () => { throw new Error("must not run"); });
});
`,
    });
    const run = spawnSync(process.execPath, [LAUNCH, "test", "--functions", "functions"], {
      cwd: dir,
      encoding: "utf8",
    });
    const out = run.stdout + run.stderr;
    expect(out).toContain("2 pass");
    expect(out).toContain("1 skip");
    expect(run.status).toBe(0);
  });

  test("a failing assertion fails the run; explicit paths narrow it", async () => {
    const dir = await project({
      "functions/import_map.json": JSON.stringify({ imports: { "1tube/test": BUN_BINDING } }),
      "functions/a/a.test.ts": `import { assertEquals, test } from "1tube/test";\ntest("a", () => assertEquals(1, 2));\n`,
      "functions/b/b.test.ts": `import { test } from "1tube/test";\ntest("b", () => {});\n`,
    });
    const all = spawnSync(process.execPath, [LAUNCH, "test", "-f", "functions"], { cwd: dir, encoding: "utf8" });
    expect(all.status).not.toBe(0);
    expect(all.stdout + all.stderr).toContain("Values are not equal");
    const one = spawnSync(process.execPath, [LAUNCH, "test", "-f", "functions", "--timeout", "5000", "./functions/b"], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(one.stdout + one.stderr).toContain("1 pass");
    expect(one.status).toBe(0);
  });
});

// node:test binding, run by Node itself (type stripping: Node >= 22.18).
const nodeMajorMinor = (() => {
  const r = spawnSync("node", ["--version"], { encoding: "utf8" });
  const m = r.status === 0 ? /^v(\d+)\.(\d+)/.exec(r.stdout.trim()) : null;
  return m ? Number(m[1]) * 100 + Number(m[2]) : 0;
})();

test.skipIf(nodeMajorMinor < 2218)("node binding runs under node --test", async () => {
  const dir = await project({
    "a.test.ts": `import { describe, test, assertEquals, assertRejects, runtime } from ${
      JSON.stringify(join(ROOT, "src", "test", "node.ts"))
    };
describe("node", () => {
  test("deep", () => assertEquals({ a: new Map([[1, [2]]]) }, { a: new Map([[1, [2]]]) }));
  test("rejects", async () => { await assertRejects(async () => { throw new Error("x"); }, Error, "x"); });
  test("runtime", () => assertEquals(runtime, "node"));
  test.skip("skipped", () => { throw new Error("must not run"); });
});
`,
  });
  const run = spawnSync("node", ["--test", join(dir, "a.test.ts")], { encoding: "utf8" });
  expect(run.stdout).toContain("pass 3");
  expect(run.stdout).toContain("skipped 1");
  expect(run.status).toBe(0);
});
