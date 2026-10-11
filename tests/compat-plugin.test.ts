/**
 * The Deno-compat runtime plugin (`compat/plugin.ts`) end to end: real
 * function graphs importing `npm:` / `jsr:` / `https:` specifiers, deno.json
 * import-map aliases, shared modules, and shared dependency instances.
 *
 * Everything runs offline:
 *   - host packages come from a fabricated `node_modules` in the temp project
 *     (plus a symlink to this repo's real `hono`);
 *   - the managed dependency store installs through a fake `bun` whose
 *     `install` materializes stub packages from the generated package.json;
 *   - `https:` modules come from a fake `fetch` injected into the cache.
 *
 * `Bun.plugin` is process-global and `bun test` shares one process across
 * files, so every test resets the compat state it touched.
 */

import { afterEach, describe, setDefaultTimeout, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "./_assert.ts";
import { FunctionRegistry } from "../src/registry.ts";
import { FunctionSupervisor } from "../src/supervisor.ts";
import { createFunctionHost, type FunctionHostOptions } from "../src/backends/bun/function-host.ts";
import { configureCompat, rewriteImports } from "../src/compat/plugin.ts";
import { createDependencyManager, parseReleaseAge } from "../src/compat/deps.ts";
import { absolutizeImports, createRemoteModuleCache } from "../src/compat/remote.ts";
import { createSharedDependencies, type SharedDependencies } from "../src/compat/shared-deps.ts";
import type { ImportMap } from "../src/compat/import-map.ts";
import type { SharedModuleProvider } from "../src/compat/plugin.ts";

setDefaultTimeout(30_000);

const REPO_HONO = join(import.meta.dir, "..", "node_modules", "hono");

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await Promise.resolve(cleanups.pop()!()).catch(() => {});
  configureCompat({ deps: null, remote: null, importMap: undefined, shared: null, sharedDeps: null });
});

async function write(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

interface Project {
  root: string;
  functions: string;
  store: string;
  installLog: string;
}

/**
 * A temp project with host packages and a fake `bun` for managed installs.
 * Every function root is distinct, so the plugin's (accumulating) rewrite
 * roots never overlap between tests.
 */
async function makeProject(): Promise<Project> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "1tube-compat-plugin-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const functions = join(root, "functions");
  const store = join(root, "store");
  const installLog = join(root, "installs.log");
  await mkdir(functions, { recursive: true });
  await writeFile(installLog, "");

  // Host package: version 2.1.0, with a subpath export and module state.
  const host = join(root, "node_modules", "hostpkg");
  await write(
    join(host, "package.json"),
    JSON.stringify({
      name: "hostpkg",
      version: "2.1.0",
      type: "module",
      exports: { ".": "./index.js", "./sub": "./sub.js" },
    }),
  );
  await write(
    join(host, "index.js"),
    `export const id = crypto.randomUUID();
export const from = "host";
let n = 0;
export function bump() { return ++n; }
export default { kind: "default-export" };
`,
  );
  await write(join(host, "sub.js"), `export const sub = "host-sub";\n`);
  await symlink(REPO_HONO, join(root, "node_modules", "hono"));

  // Fake `bun install`: materialize every aliased dependency as a stub
  // package, recording each run. Names containing "fail-me" fail the run.
  const installer = join(root, "fake-install.ts");
  await write(
    installer,
    `import { mkdirSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const deps = Object.entries(pkg.dependencies ?? {});
appendFileSync(${JSON.stringify(installLog)}, process.argv.slice(2).join(" ") + "|" + deps.map(([a]) => a).sort().join(",") + "\\n");
for (const [alias, target] of deps) {
  const m = /^npm:(@?[^@]+)@(.*)$/.exec(target);
  if (m[1].includes("fail-me")) { console.error("404 Not Found: " + m[1]); process.exit(1); }
  const dir = "node_modules/" + alias;
  mkdirSync(dir, { recursive: true });
  writeFileSync(dir + "/package.json", JSON.stringify({ name: m[1], version: "9.9.9", type: "module", exports: { ".": "./index.js", "./sub": "./sub.js" } }));
  writeFileSync(dir + "/index.js", "export const from = 'managed'; export const name = " + JSON.stringify(m[1]) + "; export const range = " + JSON.stringify(m[2]) + "; export const id = crypto.randomUUID();\\n");
  writeFileSync(dir + "/sub.js", "export const sub = 'managed-sub';\\n");
}
`,
  );
  const fakeBun = join(root, "fake-bun");
  await writeFile(fakeBun, `#!/bin/sh\nexec "${process.execPath}" "${installer}" "$@"\n`);
  await chmod(fakeBun, 0o755);
  return { root, functions, store, installLog };
}

function depsFor(p: Project, extra: { isolated?: boolean } = {}) {
  return createDependencyManager({
    dir: p.store,
    bunBin: join(p.root, "fake-bun"),
    log: () => {},
    ...extra,
  });
}

async function installRuns(p: Project): Promise<string[]> {
  return (await readFile(p.installLog, "utf8")).split("\n").filter(Boolean);
}

async function bootHost(p: Project, extra: Partial<FunctionHostOptions> = {}) {
  const registry = new FunctionRegistry();
  const host = createFunctionHost({
    functionsDir: p.functions,
    registry,
    supervisor: new FunctionSupervisor(),
    reloadDrainMs: 0,
    ...extra,
  });
  cleanups.push(() => host.stop());
  const result = await host.start();
  const json = async (name: string) => {
    const handle = registry.workerHandle(name);
    assert(handle, `no handle for ${name}; boot errors: ${JSON.stringify(result.errors)}`);
    const resp = await handle.dispatch(new Request("http://localhost/x"), null, new AbortController().signal);
    return await resp.json();
  };
  return { registry, host, ...result, json };
}

/** A function that returns `expr` (evaluated per request) as JSON. */
const fn = (imports: string, expr: string) =>
  `${imports}\n(globalThis as any).__edgeFunctionRegistry.register(async () => Response.json(${expr}), { public: true });\n`;

// ---------------------------------------------------------------------------
// npm: / jsr: through the dependency manager
// ---------------------------------------------------------------------------

describe("compat-plugin: npm: and jsr:", () => {
  test("npm: binds to the host node_modules when the installed version satisfies the range", async () => {
    const p = await makeProject();
    const deps = depsFor(p);
    configureCompat({ deps, functionRoots: [p.functions] });
    await write(
      join(p.functions, "host-pkg", "index.ts"),
      fn(
        `import def, { from } from "npm:hostpkg@^2";\nimport { sub } from "npm:hostpkg@2.1/sub";\nimport { Hono } from "npm:hono@4";\n` +
          `const app = new Hono().get("/x", (c) => c.text("hono-ok"));`,
        `{ from, sub, def, hono: await (await app.fetch(new Request("http://h/x"))).text() }`,
      ),
    );
    const b = await bootHost(p, { deps });
    assertEquals(b.errors, []);
    assertEquals(await b.json("host-pkg"), {
      from: "host",
      sub: "host-sub",
      def: { kind: "default-export" },
      hono: "hono-ok",
    });
    // Nothing needed installing.
    assertEquals(await installRuns(p), []);
  });

  test("unsatisfied ranges and jsr: install into the managed store in ONE batched run", async () => {
    const p = await makeProject();
    const deps = depsFor(p);
    configureCompat({ deps, functionRoots: [p.functions] });
    await write(
      join(p.functions, "a", "index.ts"),
      fn(`import { from, range } from "npm:hostpkg@^3";\nimport { sub } from "npm:hostpkg@^3/sub";`, `{ from, range, sub }`),
    );
    await write(
      join(p.functions, "b", "index.ts"),
      fn(`import { name, range } from "jsr:@std/fakepath@^1";\nimport * as lp from "npm:@scope/leftpad@1.2";`, `{ name, range, lp: lp.name }`),
    );
    const b = await bootHost(p, { deps });
    assertEquals(b.errors, []);
    assertEquals(await b.json("a"), { from: "managed", range: "^3", sub: "managed-sub" });
    assertEquals(await b.json("b"), { name: "@jsr/std__fakepath", range: "^1", lp: "@scope/leftpad" });

    const runs = await installRuns(p);
    assertEquals(runs.length, 1, `expected one batched install, got ${JSON.stringify(runs)}`);
    assertStringIncludes(runs[0], "install --no-progress --no-summary|");
    assertEquals(runs[0].split("|")[1].split(",").length, 3);
    // The generated project routes jsr through npm.jsr.io.
    assertStringIncludes(await readFile(join(p.store, "bunfig.toml"), "utf8"), `jsr = "https://npm.jsr.io"`);

    // A restart with the store already populated installs nothing.
    const again = depsFor(p);
    await again.ensure([{ name: "hostpkg", range: "^3", subpath: "", registry: "npm" }]);
    assertEquals((await installRuns(p)).length, 1);
  });

  test("isolated mode ignores host node_modules", async () => {
    const p = await makeProject();
    const deps = depsFor(p, { isolated: true });
    configureCompat({ deps, functionRoots: [p.functions] });
    await write(join(p.functions, "iso", "index.ts"), fn(`import { from } from "npm:hostpkg@^2";`, `{ from }`));
    const b = await bootHost(p, { deps });
    assertEquals(b.errors, []);
    assertEquals(await b.json("iso"), { from: "managed" });
  });

  test("a computed npm: import the pre-scan missed installs on demand", async () => {
    const p = await makeProject();
    const deps = depsFor(p);
    configureCompat({ deps, functionRoots: [p.functions] });
    await write(
      join(p.functions, "lazy", "index.ts"),
      fn(`const spec = ["npm:late-pkg", "5"].join("@");`, `{ from: (await import(spec)).from }`),
    );
    const b = await bootHost(p, { deps });
    assertEquals(b.errors, []);
    assertEquals(await installRuns(p), []);
    assertEquals(await b.json("lazy"), { from: "managed" });
    assertEquals((await installRuns(p)).length, 1);
  });

  test("a failed install is a boot error for its importer only", async () => {
    const p = await makeProject();
    const deps = depsFor(p);
    configureCompat({ deps, functionRoots: [p.functions] });
    await write(join(p.functions, "broken", "index.ts"), fn(`import "npm:fail-me@1";`, `{}`));
    await write(join(p.functions, "fine", "index.ts"), fn(`import { from } from "npm:hostpkg@^2";`, `{ from }`));
    const errLog = console.error;
    console.error = () => {};
    let b;
    try {
      b = await bootHost(p, { deps });
    } finally {
      console.error = errLog;
    }
    assertEquals(b.loaded, ["fine"]);
    assertEquals(b.errors.length, 1);
    assertEquals(b.errors[0].name, "broken");
    assertStringIncludes(b.errors[0].error, "fail-me");
    await assertRejects(
      () => deps.ensure([{ name: "fail-me", range: "1", subpath: "", registry: "npm" }]),
      "Failed to install npm:fail-me@1",
    );
  });

  test("npm: without a configured dependency manager fails with a clear error", async () => {
    const p = await makeProject();
    configureCompat({ deps: null, functionRoots: [p.functions] });
    await write(join(p.functions, "nodeps", "index.ts"), fn(`import "npm:hostpkg@^2";`, `{}`));
    const b = await bootHost(p);
    assertEquals(b.errors.length, 1);
    assertStringIncludes(b.errors[0].error, "dependency manager");
  });

  test("parseReleaseAge accepts seconds and unit suffixes", () => {
    assertEquals(parseReleaseAge(undefined), undefined);
    assertEquals(parseReleaseAge("90"), 90);
    assertEquals(parseReleaseAge("30m"), 1800);
    assertEquals(parseReleaseAge("24h"), 86400);
    assertEquals(parseReleaseAge("1.5d"), 129600);
    assertEquals(parseReleaseAge("soon"), undefined);
  });
});

// ---------------------------------------------------------------------------
// https: remote modules
// ---------------------------------------------------------------------------

interface FakeRes {
  ok: boolean;
  status: number;
  url: string;
  headers: Headers;
  text(): Promise<string>;
}

function fakeFetch(routes: Record<string, { body: string; type?: string; finalUrl?: string; status?: number }>) {
  const calls: string[] = [];
  const f = (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const r = routes[url];
    const res: FakeRes = r
      ? {
        ok: (r.status ?? 200) < 400,
        status: r.status ?? 200,
        url: r.finalUrl ?? url,
        headers: new Headers({ "content-type": r.type ?? "application/javascript" }),
        text: () => Promise.resolve(r.body),
      }
      : { ok: false, status: 404, url, headers: new Headers(), text: () => Promise.resolve("") };
    return Promise.resolve(res as unknown as Response);
  };
  return { fetch: f as unknown as typeof fetch, calls };
}

describe("compat-plugin: https: modules", () => {
  test("absolutizeImports rewrites relative and root-relative specifiers only", async () => {
    const code = `import a from "./a.js";
import { b } from '../b.js';
export * from "/v1/c.js";
import "npm:x";
import d from "https://other.dev/d.js";
const e = await import("./e.js");
const f = await import(name);
`;
    const out = await absolutizeImports(code, "https://esm.test/pkg/v2/mod.js");
    assertEquals(
      out,
      `import a from "https://esm.test/pkg/v2/a.js";
import { b } from 'https://esm.test/pkg/b.js';
export * from "https://esm.test/v1/c.js";
import "npm:x";
import d from "https://other.dev/d.js";
const e = await import("https://esm.test/pkg/v2/e.js");
const f = await import(name);
`,
    );
  });

  test("functions import remote modules (relative, root-relative, redirects, TypeScript, dynamic)", async () => {
    const p = await makeProject();
    const { fetch, calls } = fakeFetch({
      "https://esm.test/lib.js": {
        body: `import { helper } from "./util.js";
import { root } from "/root.js";
export const lib = helper() + root;
export const lazy = async () => (await import("./dyn.js")).default;
`,
      },
      "https://esm.test/util.js": { body: `export const helper = () => "h";` },
      "https://esm.test/root.js": { body: `export const root = "r";` },
      "https://esm.test/dyn.js": { body: `export default "d";` },
      "https://esm.test/latest": { body: `export { sib } from "./sib.js";`, finalUrl: "https://esm.test/v9/real.js" },
      "https://esm.test/v9/sib.js": { body: `export const sib = "redirected";` },
      "https://deno.test/x/mod.ts": {
        body: `export const typed: string = "ts"; export enum E { A = 1 }`,
        type: "application/typescript",
      },
    });
    const cacheDir = join(p.root, "remote-cache");
    configureCompat({ remote: createRemoteModuleCache({ dir: cacheDir, fetch }), functionRoots: [p.functions] });
    await write(
      join(p.functions, "remote", "index.ts"),
      fn(
        `import { lib, lazy } from "https://esm.test/lib.js";
import { sib } from "https://esm.test/latest";
import { typed, E } from "https://deno.test/x/mod.ts";`,
        `{ lib, dyn: await lazy(), sib, typed, e: E.A }`,
      ),
    );
    await write(
      join(p.functions, "remote2", "index.ts"),
      fn(`import { lib } from "https://esm.test/lib.js";`, `{ lib }`),
    );
    const b = await bootHost(p);
    assertEquals(b.errors, []);
    assertEquals(await b.json("remote"), { lib: "hr", dyn: "d", sib: "redirected", typed: "ts", e: 1 });
    assertEquals(await b.json("remote2"), { lib: "hr" });
    // Each URL is downloaded once, however many graphs import it.
    assertEquals(calls.length, new Set(calls).size, `duplicate fetches: ${JSON.stringify(calls)}`);

    // A fresh cache over the same directory works offline…
    const offline = createRemoteModuleCache({
      dir: cacheDir,
      fetch: (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch,
    });
    const cached = await offline.load("https://esm.test/latest");
    assertEquals(cached.url, "https://esm.test/v9/real.js");
    assertStringIncludes(cached.code, "https://esm.test/v9/sib.js");
    // …and `reload` forces a re-download.
    const forced = fakeFetch({ "https://esm.test/util.js": { body: `export const helper = () => "fresh";` } });
    const reloading = createRemoteModuleCache({ dir: cacheDir, fetch: forced.fetch, reload: true });
    assertStringIncludes((await reloading.load("https://esm.test/util.js")).code, "fresh");
    assertEquals(forced.calls, ["https://esm.test/util.js"]);
  });

  test("an HTTP error or a missing remote cache is an import error", async () => {
    const p = await makeProject();
    const { fetch } = fakeFetch({});
    configureCompat({ remote: createRemoteModuleCache({ dir: join(p.root, "rc"), fetch }), functionRoots: [p.functions] });
    await write(join(p.functions, "gone", "index.ts"), fn(`import "https://esm.test/missing.js";`, `{}`));
    const b = await bootHost(p);
    assertEquals(b.errors.length, 1);
    assertStringIncludes(b.errors[0].error, "HTTP 404");

    configureCompat({ remote: null });
    await write(join(p.functions, "gone", "index.ts"), fn(`import "https://esm.test/other.js";`, `{}`));
    const r = await b.host.reload(new Set(["gone"]), "no remote");
    assertStringIncludes(r.errors[0].error, "remote imports are not configured");
  });
});

// ---------------------------------------------------------------------------
// Import maps, shared modules, rewriting
// ---------------------------------------------------------------------------

function projectMap(p: Project): ImportMap {
  return {
    imports: {
      "@lib": "./_vendor/lib.ts",
      "@shared/": "./_shared/",
      "pkg-alias": "npm:hostpkg@^2",
      "pkg-alias/": "npm:hostpkg@^2/",
      "remote-alias": "https://esm.test/util.js",
    },
    scopes: { "./scoped/": { "@lib": "./_vendor/scoped-lib.ts" } },
    base: join(p.functions, "deno.json"),
  };
}

describe("compat-plugin: import maps and rewriting", () => {
  test("rewriteImports changes only the quoted specifiers and keeps line numbers", async () => {
    const p = await makeProject();
    configureCompat({ importMap: projectMap(p) });
    const file = join(p.functions, "fn", "index.ts");
    const code = `import { a } from "@lib";
import {
  b,
} from '@shared/b.ts';
export * from "@shared/c.ts";
const d = await import("@lib");
import fs from "node:fs";
import rel from "./rel.ts";
import other from "not-mapped";
`;
    const out = rewriteImports(code, file);
    assertEquals(out.split("\n").length, code.split("\n").length);
    assertEquals(
      out,
      `import { a } from "${p.functions}/_vendor/lib.ts";
import {
  b,
} from '${p.functions}/_shared/b.ts';
export * from "${p.functions}/_shared/c.ts";
const d = await import("${p.functions}/_vendor/lib.ts");
import fs from "node:fs";
import rel from "./rel.ts";
import other from "not-mapped";
`,
    );
    // Scopes apply by importer location.
    assertStringIncludes(
      rewriteImports(`import x from "@lib";`, join(p.functions, "scoped", "index.ts")),
      "/_vendor/scoped-lib.ts",
    );
    // Syntax errors are left for Bun to report against the original.
    assertEquals(rewriteImports(`import { from "@lib"`, file), `import { from "@lib"`);
  });

  test("functions resolve deno.json aliases: files, prefixes, scopes, npm: and https: targets", async () => {
    const p = await makeProject();
    const { fetch } = fakeFetch({ "https://esm.test/util.js": { body: `export const helper = () => "remote";` } });
    configureCompat({
      importMap: projectMap(p),
      deps: depsFor(p),
      remote: createRemoteModuleCache({ dir: join(p.root, "rc"), fetch }),
      functionRoots: [p.functions],
    });
    await write(join(p.functions, "_vendor", "lib.ts"), `export const lib = "global-lib";\n`);
    await write(join(p.functions, "_vendor", "scoped-lib.ts"), `export const lib = "scoped-lib";\n`);
    await write(join(p.functions, "_shared", "cors.ts"), `export const cors = { "x-cors": "1" };\n`);
    await write(
      join(p.functions, "mapped", "index.ts"),
      fn(
        `import { lib } from "@lib";
import { cors } from "@shared/cors.ts";
import { from } from "pkg-alias";
import { sub } from "pkg-alias/sub";
import { helper } from "remote-alias";`,
        `{ lib, cors, from, sub, remote: helper() }`,
      ),
    );
    await write(join(p.functions, "scoped", "index.ts"), fn(`import { lib } from "@lib";`, `{ lib }`));
    const b = await bootHost(p, { importMap: projectMap(p) });
    assertEquals(b.errors, []);
    assertEquals(await b.json("mapped"), {
      lib: "global-lib",
      cors: { "x-cors": "1" },
      from: "host",
      sub: "host-sub",
      remote: "remote",
    });
    assertEquals(await b.json("scoped"), { lib: "scoped-lib" });
    // The dep-graph sees through the same aliases (HMR precision).
    assertEquals([...b.host.depGraph.affected([join(p.functions, "_vendor", "lib.ts")])], ["mapped"]);
    assertEquals([...b.host.depGraph.affected([join(p.functions, "_vendor", "scoped-lib.ts")])], ["scoped"]);
  });

  test("imports of a shared module (direct or aliased) load the gateway singleton stub", async () => {
    const p = await makeProject();
    const sharedPath = join(p.functions, "_shared", "profile-cache.ts");
    await write(sharedPath, `export const real = true;\n`);
    // A fake provider: the stub reads the process-global registry.
    const registryKey = Symbol.for("1tube.sharedModules");
    const g = globalThis as unknown as Record<symbol, Map<string, Record<string, unknown>> | undefined>;
    const reg = g[registryKey] ??= new Map();
    const singleton = { token: "singleton-token", default: "dflt", "not-an-ident": 1 };
    reg.set("pc-test", singleton);
    cleanups.push(() => {
      reg.delete("pc-test");
    });
    const provider: SharedModuleProvider = {
      idForPath: (abs) => (abs === sharedPath ? "pc-test" : undefined),
      exportNames: () => Object.keys(singleton),
    };
    configureCompat({
      shared: provider,
      importMap: { imports: { "@pc": "./_shared/profile-cache.ts" }, base: join(p.functions, "deno.json") },
      functionRoots: [p.functions],
    });
    assertEquals(
      rewriteImports(`import { token } from "../_shared/profile-cache.ts";`, join(p.functions, "a", "index.ts")),
      `import { token } from "1tube-shared:${sharedPath}";`,
    );
    // The shared module's own imports are never redirected to itself.
    assertEquals(rewriteImports(`import "./profile-cache.ts";`, sharedPath), `import "./profile-cache.ts";`);

    await write(
      join(p.functions, "direct", "index.ts"),
      fn(`import dflt, { token } from "../_shared/profile-cache.ts";`, `{ token, dflt }`),
    );
    await write(
      join(p.functions, "aliased", "index.ts"),
      fn(`import * as pc from "@pc";`, `{ token: pc.token, odd: (pc as any)["not-an-ident"], real: (pc as any).real ?? null }`),
    );
    const b = await bootHost(p);
    assertEquals(b.errors, []);
    assertEquals(await b.json("direct"), { token: "singleton-token", dflt: "dflt" });
    assertEquals(await b.json("aliased"), { token: "singleton-token", odd: 1, real: null });
  });
});

// ---------------------------------------------------------------------------
// Shared dependencies
// ---------------------------------------------------------------------------

describe("compat-plugin: shared dependencies", () => {
  const probe = (spec: string) =>
    fn(`import dflt, { id, bump } from "${spec}";\nimport { sub } from "${spec}/sub";`, `{ id, n: bump(), sub, dflt }`);

  async function twoFunctions(p: Project) {
    // Same package via a bare specifier and via npm:, resolving to one file.
    await write(join(p.functions, "bare", "index.ts"), probe("hostpkg"));
    await write(join(p.functions, "npm", "index.ts"), probe("npm:hostpkg@^2"));
  }

  test("with sharing on, function graphs get the identical package instance", async () => {
    const p = await makeProject();
    const sharedDeps: SharedDependencies = createSharedDependencies();
    cleanups.push(() => sharedDeps.dispose());
    const deps = depsFor(p);
    configureCompat({ deps, sharedDeps, functionRoots: [p.functions] });
    await twoFunctions(p);
    assertStringIncludes(
      rewriteImports(`import x from "hostpkg";\nimport fs from "node:fs";\nimport r from "./r.ts";`, join(p.functions, "bare", "index.ts")),
      `from "1tube-dep:hostpkg";\nimport fs from "node:fs";\nimport r from "./r.ts";`,
    );

    const b = await bootHost(p, { deps });
    assertEquals(b.errors, []);
    const a = await b.json("bare");
    const c = await b.json("npm");
    assertEquals(a.id, c.id, "one instance shared by both graphs");
    assertEquals([a.n, c.n], [1, 2], "module state is shared too");
    assertEquals(a.sub, "host-sub");
    assertEquals(a.dflt, { kind: "default-export" });

    // HMR of a function keeps the shared instance (no re-evaluation).
    const r = await b.host.reload(new Set(["bare"]), "edit");
    assertEquals(r.errors, []);
    const again = await b.json("bare");
    assertEquals(again.id, a.id);
    assertEquals(again.n, 3);
  });

  test("with sharing off, each function graph evaluates its own instance", async () => {
    const p = await makeProject();
    const deps = depsFor(p);
    configureCompat({ deps, sharedDeps: null, functionRoots: [p.functions] });
    await twoFunctions(p);
    const b = await bootHost(p, { deps });
    assertEquals(b.errors, []);
    const a = await b.json("bare");
    const c = await b.json("npm");
    assert(a.id !== c.id, "isolated instances");
    assertEquals([a.n, c.n], [1, 1]);
  });
});
