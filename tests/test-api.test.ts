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

// ---------------------------------------------------------------------------
// expect / mocks / .each (portable implementations)
// ---------------------------------------------------------------------------

import { createMock, expect as portableExpect, restoreAllMocks, spyOn } from "../src/test/expect.ts";
import { formatTitle } from "../src/test/core.ts";

const failsWith = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AssertionError);
    return (err as Error).message;
  }
  throw new Error("expected an AssertionError");
};

describe("portable expect", () => {
  const e = portableExpect;

  test("toEqual ignores undefined props and types; toStrictEqual does not", () => {
    class Point {
      constructor(public x: number) {}
    }
    e({ a: 1, b: undefined }).toEqual({ a: 1 });
    e(new Point(1)).toEqual({ x: 1 });
    e([1, [2, { c: new Set([3]) }]]).toEqual([1, [2, { c: new Set([3]) }]]);
    expect(failsWith(() => e({ a: 1, b: undefined }).toStrictEqual({ a: 1 }))).toContain("toStrictEqual");
    expect(failsWith(() => e(new Point(1)).toStrictEqual({ x: 1 }))).toContain("toStrictEqual");
    e([1, 2]).not.toEqual([1, 2, undefined]);
    const msg = failsWith(() => e({ a: 1, b: [1, 2] }).toEqual({ a: 1, b: [1, 3] }));
    expect(msg).toContain("-       2,");
    expect(msg).toContain("+       3,");
  });

  test("toMatchObject and asymmetric matchers nest", () => {
    e({ a: 1, b: { c: 2, d: [1, { e: 3, f: 4 }] } }).toMatchObject({ b: { d: [1, { e: 3 }] } });
    e({ id: "x1", at: new Date(0), tags: ["a", "b"] }).toEqual({
      id: e.stringMatching(/^x\d$/),
      at: e.any(Date),
      tags: e.arrayContaining(["b"]),
    });
    e({ user: { name: "A", age: 3 } }).toEqual({ user: e.objectContaining({ name: "A" }) });
    e({ v: null }).not.toEqual({ v: e.anything() });
    e("abc").toEqual(e.stringContaining("b"));
    e({ a: 1 }).toEqual(e.not.objectContaining({ b: 1 }));
    expect(failsWith(() => e({ a: { b: 1 } }).toMatchObject({ a: { b: 2 } }))).toContain("toMatchObject");
  });

  test("scalar, string, collection matchers and .not", () => {
    e(1).toBe(1);
    e({}).not.toBe({});
    expect(failsWith(() => e({ a: 1 }).toBe({ a: 1 }))).toContain("same structure");
    e(null).toBeNull();
    e(undefined).toBeUndefined();
    e(0).toBeDefined();
    e("x").toBeTruthy();
    e(0).toBeFalsy();
    e(NaN).toBeNaN();
    e(3).toBeGreaterThan(2);
    e(3).toBeGreaterThanOrEqual(3);
    e(2).toBeLessThan(3);
    e(2).toBeLessThanOrEqual(2);
    e(0.1 + 0.2).toBeCloseTo(0.3, 5);
    e(0.5).not.toBeCloseTo(0.6);
    e("hello").toContain("ell");
    e([1, 2, 3]).toContain(2);
    e([{ a: 1 }]).not.toContain({ a: 1 });
    e([{ a: 1 }]).toContainEqual({ a: 1 });
    e(new Set(["k"])).toContain("k");
    e("prefix-body").toStartWith("prefix");
    e("body.ts").toEndWith(".ts");
    e("abc").toMatch(/b/);
    e("abc").toMatch("bc");
    e([1, 2]).toHaveLength(2);
    e({ a: { b: [{ c: 5 }] } }).toHaveProperty("a.b[0].c", 5);
    e({ a: 1 }).not.toHaveProperty("b");
    e(new TypeError("t")).toBeInstanceOf(Error);
    e("s").toBeTypeOf("string");
    e(2).toBeOneOf([1, 2]);
    e([]).toBeEmpty();
    expect(failsWith(() => e(1).toBe(2))).toContain("Expected: 2");
    expect(failsWith(() => e(1, "custom context").toBe(2))).toStartWith("custom context");
  });

  test("toThrow accepts string, RegExp, class, error and asymmetric", () => {
    const boom = () => {
      throw new RangeError("value out of range");
    };
    e(boom).toThrow();
    e(boom).toThrow("out of");
    e(boom).toThrow(/range$/);
    e(boom).toThrow(RangeError);
    e(boom).toThrow(new Error("value out of range"));
    e(boom).toThrow(e.objectContaining({ name: "RangeError" }));
    e(() => {}).not.toThrow();
    e(boom).not.toThrow(TypeError);
    expect(failsWith(() => e(() => {}).toThrow())).toContain("did not throw");
  });

  test("resolves / rejects", async () => {
    await e(Promise.resolve({ a: 1, b: 2 })).resolves.toMatchObject({ a: 1 });
    await e(Promise.resolve(undefined)).resolves.toBeUndefined();
    await e(Promise.reject(new Error("nope"))).rejects.toThrow("nope");
    await e(Promise.reject(new Error("nope"))).rejects.toMatchObject({ message: "nope" });
    await e(Promise.resolve(1)).resolves.not.toBe(2);
    await expect(e(Promise.resolve(1)).rejects.toThrow()).rejects.toThrow("resolved instead of rejected");
    await expect(e(Promise.reject(new Error("x"))).resolves.toBe(1)).rejects.toThrow("rejected instead of resolved");
  });

  test("mock functions and spies", async () => {
    const rpc = createMock(async (_name: string) => ({ ok: true }));
    await rpc("a");
    rpc.mockResolvedValueOnce({ ok: false });
    expect(await rpc("b")).toEqual({ ok: false });
    expect(await rpc("c")).toEqual({ ok: true });
    portableExpect(rpc).toHaveBeenCalledTimes(3);
    portableExpect(rpc).toHaveBeenCalledWith("b");
    portableExpect(rpc).toHaveBeenNthCalledWith(1, "a");
    portableExpect(rpc).toHaveBeenLastCalledWith("c");
    portableExpect(rpc).toHaveReturned();
    rpc.mockClear();
    portableExpect(rpc).not.toHaveBeenCalled();
    const thrower = createMock(() => {
      throw new Error("t");
    });
    expect(() => thrower()).toThrow("t");
    expect(thrower.mock.results[0].type).toBe("throw");

    const target = { greet: (n: string) => `hi ${n}` };
    const spy = spyOn(target, "greet");
    expect(target.greet("x")).toBe("hi x");
    spy.mockReturnValue("stub");
    expect(target.greet("y")).toBe("stub");
    portableExpect(spy).toHaveBeenCalledTimes(2);
    restoreAllMocks();
    expect(target.greet("z")).toBe("hi z");
    expect(failsWith(() => portableExpect(() => {}).toHaveBeenCalled())).toContain("must be a mock function");
  });

  test(".each title formatting", () => {
    expect(formatTitle("adds %d + %d = %s (#%#)", [1, 2, "3"], 4)).toBe("adds 1 + 2 = 3 (#4)");
    expect(formatTitle("obj %o / %j / 100%%", [{ a: 1 }, [1]], 0)).toBe('obj {\n  a: 1,\n} / [1] / 100%');
    expect(formatTitle("case $name has $meta.n", [{ name: "x", meta: { n: 2 } }], 0)).toBe("case x has 2");
  });
});

describe("1tube test: portable surface end to end", () => {
  const BUN_BINDING = join(ROOT, "src", "test", "bun.ts");

  test("each / skipIf / it / expect / mock.module run under bun", async () => {
    const dir = await project({
      "functions/import_map.json": JSON.stringify({ imports: { "1tube/test": BUN_BINDING } }),
      "functions/_shared/config.ts": `export const configured = () => false;\n`,
      "functions/_shared/feature.ts": `import { configured } from "./config.ts";\nexport const status = () => (configured() ? "on" : "off");\n`,
      "functions/f/f.test.ts": `import { describe, expect, it, mock, test } from "1tube/test";
mock.module(import.meta.resolve("../_shared/config.ts"), () => ({ configured: () => true }));
const { status } = await import("../_shared/feature.ts");
describe("portable", () => {
  it("module mock applies", () => expect(status()).toBe("on"));
  test.each([[1, 2, 3], [2, 3, 5]])("add %d + %d", (a, b, sum) => expect(a + b).toBe(sum));
  test.skipIf(true)("skipped", () => { throw new Error("must not run"); });
  test("relative mock.module is rejected", () =>
    expect(() => mock.module("./x.ts", () => ({}))).toThrow("import.meta.resolve"));
});
describe.skipIf(true)("skipped suite", () => { test("never", () => { throw new Error("no"); }); });
`,
    });
    const run = spawnSync(process.execPath, [LAUNCH, "test", "-f", "functions"], { cwd: dir, encoding: "utf8" });
    const out = run.stdout + run.stderr;
    expect(out).toContain("4 pass");
    expect(out).toContain("2 skip");
    expect(run.status).toBe(0);
  });
});

test.skipIf(nodeMajorMinor < 2218)("node binding: expect, each, mocks under node --test", async () => {
  const dir = await project({
    "b.test.ts": `import { describe, expect, it, mock, test } from ${JSON.stringify(join(ROOT, "src", "test", "node.ts"))};
describe("node portable", () => {
  test.each([[1, 1], [2, 2]])("same %d", (a, b) => expect(a).toBe(b));
  it("mock fn", () => { const f = mock((x: number) => x * 2); f(2); expect(f).toHaveBeenCalledWith(2); });
  it("rejects", async () => { await expect(Promise.reject(new Error("e"))).rejects.toThrow("e"); });
});
`,
  });
  const run = spawnSync("node", ["--test", join(dir, "b.test.ts")], { encoding: "utf8" });
  expect(run.stdout).toContain("pass 4");
  expect(run.status).toBe(0);
});

test("1tube test isolates files by default: mock.module cannot leak", async () => {
  const BUN_BINDING = join(ROOT, "src", "test", "bun.ts");
  const dir = await project({
    "functions/import_map.json": JSON.stringify({ imports: { "1tube/test": BUN_BINDING } }),
    "functions/_shared/flag.ts": `export const flag = () => "real";\n`,
    "functions/a/a.test.ts": `import { expect, mock, test } from "1tube/test";
mock.module(import.meta.resolve("../_shared/flag.ts"), () => ({ flag: () => "mocked" }));
const { flag } = await import("../_shared/flag.ts");
test("a sees the mock", () => expect(flag()).toBe("mocked"));
`,
    "functions/b/b.test.ts": `import { expect, test } from "1tube/test";
import { flag } from "../_shared/flag.ts";
test("b sees the real module", () => expect(flag()).toBe("real"));
`,
  });
  const run = (...extra: string[]) =>
    spawnSync(process.execPath, [LAUNCH, "test", "-f", "functions", ...extra], { cwd: dir, encoding: "utf8" });
  for (const mode of [[], ["--no-parallel"]]) {
    const r = run(...mode);
    expect(r.stdout + r.stderr).toContain("2 pass");
    expect(r.status).toBe(0);
  }
  // Opting out of isolation shows what the default prevents.
  const leaky = run("--no-isolate", "./functions/a", "./functions/b");
  expect(leaky.stdout + leaky.stderr).toContain("1 fail");
});
