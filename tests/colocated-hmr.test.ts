/**
 * HMR soundness + parity tests for BOTH execution models:
 *   - isolate-per-function (`colocate: false`) ù one Worker per function.
 *   - colocated (`colocate: true`)             ù one isolate hosts all
 *     functions; HMR peels only the touched ones into a fresh isolate.
 *
 * Every scenario runs against both modes via {@link forBothModes}, so the
 * colocated path is held to the exact same correctness bar as the model
 * 1tube has always shipped. The emphasis is the things a dev relies on
 * without ever thinking about HMR:
 *
 *   - an edit is observable after reload (entry, sidecar, AND shared dep);
 *   - reloading ONE function never disturbs the others (locality ù this is
 *     also what keeps colocated HMR from being slower than isolated: a
 *     reload re-imports only the affected set, never the whole project);
 *   - rapid back-to-back edits converge on the last version;
 *   - concurrent reloads of different functions don't corrupt routing;
 *   - a request in flight across a reload still completes;
 *   - add / remove of a function takes effect.
 */

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { FunctionRegistry } from "../src/registry.ts";
import { FunctionSupervisor } from "../src/supervisor.ts";
import { createDenoWorkerHost } from "../src/backends/deno/worker-host.ts";

type Mode = { name: string; colocate: boolean };
const MODES: Mode[] = [
  { name: "isolated", colocate: false },
  { name: "colocated", colocate: true },
];

async function writeFile(path: string, text: string): Promise<void> {
  await Deno.mkdir(join(path, ".."), { recursive: true });
  await Deno.writeTextFile(path, text);
}

/**
 * A function whose response carries three signals:
 *   load  ù a per-MODULE-EVALUATION uuid (changes iff the module was
 *           re-imported; the locality probe);
 *   dep   ù value from the function's own sidecar `dep.ts`;
 *   shared ù value from `_shared/util.ts`.
 */
function fnSource(mark = ""): string {
  return `
import { shared } from "../_shared/util.ts";
import { dep } from "./dep.ts";
const LOAD = crypto.randomUUID();
const MARK = ${JSON.stringify(mark)};
const reg = (globalThis as any).__edgeFunctionRegistry;
reg.register(
  () => new Response(JSON.stringify({ load: LOAD, dep, shared, mark: MARK })),
  { public: true },
);
`;
}

async function scaffold(
  tmp: string,
  names: string[],
  shared = "S1",
): Promise<void> {
  await writeFile(
    join(tmp, "_shared", "util.ts"),
    `export const shared = ${JSON.stringify(shared)};\n`,
  );
  for (const n of names) {
    await writeFile(join(tmp, n, "dep.ts"), `export const dep = "${n}1";\n`);
    await writeFile(join(tmp, n, "index.ts"), fnSource());
  }
}

function makeHost(tmp: string, colocate: boolean, reloadDrainMs = 50) {
  const registry = new FunctionRegistry();
  const supervisor = new FunctionSupervisor();
  const host = createDenoWorkerHost({
    functionsDir: tmp,
    registry,
    supervisor,
    colocate,
    // Short drain keeps retired-worker cleanup quick in tests; the
    // graceful-drain test overrides it to outlast its slow handler.
    reloadDrainMs,
  });
  return { registry, supervisor, host };
}

async function call(
  registry: FunctionRegistry,
  name: string,
): Promise<{ load: string; dep: string; shared: string }> {
  const handle = registry.workerHandle(name);
  assert(handle, `expected a worker handle for "${name}"`);
  const ac = new AbortController();
  const resp = await handle.dispatch(
    new Request("http://localhost/"),
    null,
    ac.signal,
  );
  assertEquals(resp.status, 200, `dispatch ${name} should be 200`);
  return await resp.json();
}

/** Register one Deno.test per mode. */
function forBothModes(
  title: string,
  body: (mode: Mode) => Promise<void>,
): void {
  for (const mode of MODES) {
    Deno.test(`[${mode.name}] ${title}`, () => body(mode));
  }
}

forBothModes("boot loads every function and dispatch returns its data", async (mode) => {
  const tmp = await Deno.makeTempDir({ prefix: "1tube-colo-boot-" });
  try {
    await scaffold(tmp, ["alpha", "beta", "gamma"]);
    const { registry, host } = makeHost(tmp, mode.colocate);
    const { loaded, errors } = await host.start();
    try {
      assertEquals(errors, []);
      assertEquals(loaded.sort(), ["alpha", "beta", "gamma"]);
      const a = await call(registry, "alpha");
      assertEquals(a.dep, "alpha1");
      assertEquals(a.shared, "S1");
      const b = await call(registry, "beta");
      assertEquals(b.dep, "beta1");
    } finally {
      await host.stop();
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

forBothModes("entry edit is observable and does NOT re-import other functions", async (mode) => {
  const tmp = await Deno.makeTempDir({ prefix: "1tube-colo-entry-" });
  try {
    await scaffold(tmp, ["alpha", "beta", "gamma"]);
    const { registry, host } = makeHost(tmp, mode.colocate);
    await host.start();
    try {
      const aBefore = await call(registry, "alpha");
      const bBefore = await call(registry, "beta");
      const cBefore = await call(registry, "gamma");

      // Edit alpha's ENTRY only: a marker constant flows into the response
      // so we can see the new code ran.
      await writeFile(join(tmp, "alpha", "index.ts"), fnSource("edited"));
      const summary = await host.reload(new Set(["alpha"]), "entry edit", {
        changedPaths: [join(tmp, "alpha", "index.ts")],
      });
      assertEquals(summary.errors, []);
      assertEquals(summary.reloaded, ["alpha"]);

      const aAfter = await call(registry, "alpha") as unknown as {
        load: string;
        mark?: string;
      };
      assertEquals(aAfter.mark, "edited", "new entry code must run");
      assert(aAfter.load !== aBefore.load, "alpha must have re-imported");

      // Locality: the other functions were NOT re-imported (same LOAD id).
      const bAfter = await call(registry, "beta");
      const cAfter = await call(registry, "gamma");
      assertEquals(bAfter.load, bBefore.load, "beta must NOT re-import");
      assertEquals(cAfter.load, cBefore.load, "gamma must NOT re-import");
    } finally {
      await host.stop();
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

forBothModes("sidecar (relative dep) edit is observable after reload", async (mode) => {
  const tmp = await Deno.makeTempDir({ prefix: "1tube-colo-sidecar-" });
  try {
    await scaffold(tmp, ["alpha", "beta"]);
    const { registry, host } = makeHost(tmp, mode.colocate);
    await host.start();
    try {
      const aBefore = await call(registry, "alpha");
      const bBefore = await call(registry, "beta");
      assertEquals(aBefore.dep, "alpha1");

      // Edit alpha's SIDECAR. This is the case the colocated fast path
      // must NOT take (cache-busting the entry alone would miss it) ù it
      // has to peel alpha into a fresh isolate.
      await writeFile(
        join(tmp, "alpha", "dep.ts"),
        `export const dep = "alpha2";\n`,
      );
      const summary = await host.reload(new Set(["alpha"]), "sidecar edit", {
        changedPaths: [join(tmp, "alpha", "dep.ts")],
      });
      assertEquals(summary.errors, []);
      assertEquals(summary.reloaded, ["alpha"]);

      const aAfter = await call(registry, "alpha");
      assertEquals(aAfter.dep, "alpha2", "edited sidecar must be visible");
      assert(aAfter.load !== aBefore.load, "alpha must have re-imported");

      // Locality holds for the fresh path too.
      const bAfter = await call(registry, "beta");
      assertEquals(bAfter.load, bBefore.load, "beta must NOT re-import");
      assertEquals(bAfter.dep, "beta1");
    } finally {
      await host.stop();
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

forBothModes("shared-module edit reloads every dependent", async (mode) => {
  const tmp = await Deno.makeTempDir({ prefix: "1tube-colo-shared-" });
  try {
    await scaffold(tmp, ["alpha", "beta"], "S1");
    const { registry, host } = makeHost(tmp, mode.colocate);
    await host.start();
    try {
      assertEquals((await call(registry, "alpha")).shared, "S1");
      assertEquals((await call(registry, "beta")).shared, "S1");

      await writeFile(
        join(tmp, "_shared", "util.ts"),
        `export const shared = "S2";\n`,
      );
      // The reloader passes the dependent set (computed from the dep-graph)
      // plus the changed shared path.
      const summary = await host.reload(new Set(["alpha", "beta"]), "shared", {
        changedPaths: [join(tmp, "_shared", "util.ts")],
      });
      assertEquals(summary.errors, []);
      assertEquals(summary.reloaded.sort(), ["alpha", "beta"]);

      assertEquals((await call(registry, "alpha")).shared, "S2");
      assertEquals((await call(registry, "beta")).shared, "S2");
    } finally {
      await host.stop();
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

forBothModes("rapid back-to-back edits converge on the last version", async (mode) => {
  const tmp = await Deno.makeTempDir({ prefix: "1tube-colo-rapid-" });
  try {
    await scaffold(tmp, ["alpha", "beta"]);
    const { registry, host } = makeHost(tmp, mode.colocate);
    await host.start();
    try {
      // Five quick sidecar edits, each awaited like the debouncer would
      // serialize them. The final dispatch must reflect the last write and
      // no reload may error.
      for (let i = 0; i < 5; i++) {
        await writeFile(
          join(tmp, "alpha", "dep.ts"),
          `export const dep = "v${i}";\n`,
        );
        const s = await host.reload(new Set(["alpha"]), `rapid ${i}`, {
          changedPaths: [join(tmp, "alpha", "dep.ts")],
        });
        assertEquals(s.errors, [], `reload ${i} should not error`);
      }
      assertEquals((await call(registry, "alpha")).dep, "v4");
      // beta untouched and still serving.
      assertEquals((await call(registry, "beta")).dep, "beta1");
    } finally {
      await host.stop();
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

forBothModes("concurrent reloads of different functions don't corrupt routing", async (mode) => {
  const tmp = await Deno.makeTempDir({ prefix: "1tube-colo-concurrent-" });
  try {
    await scaffold(tmp, ["alpha", "beta", "gamma"]);
    const { registry, host } = makeHost(tmp, mode.colocate);
    await host.start();
    try {
      await writeFile(join(tmp, "alpha", "dep.ts"), `export const dep = "A!";\n`);
      await writeFile(join(tmp, "beta", "dep.ts"), `export const dep = "B!";\n`);
      // Fire both WITHOUT awaiting between them (multi-agent style).
      const [sa, sb] = await Promise.all([
        host.reload(new Set(["alpha"]), "concurrent a", {
          changedPaths: [join(tmp, "alpha", "dep.ts")],
        }),
        host.reload(new Set(["beta"]), "concurrent b", {
          changedPaths: [join(tmp, "beta", "dep.ts")],
        }),
      ]);
      assertEquals(sa.errors, []);
      assertEquals(sb.errors, []);

      assertEquals((await call(registry, "alpha")).dep, "A!");
      assertEquals((await call(registry, "beta")).dep, "B!");
      assertEquals((await call(registry, "gamma")).dep, "gamma1");
    } finally {
      await host.stop();
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

forBothModes("a request in flight during a reload still completes", async (mode) => {
  const tmp = await Deno.makeTempDir({ prefix: "1tube-colo-drain-" });
  const slow = (body: string) => `
const reg = (globalThis as any).__edgeFunctionRegistry;
reg.register(async () => {
  await new Promise((r) => setTimeout(r, 300));
  return new Response(${JSON.stringify(body)});
}, { public: true });
`;
  try {
    await writeFile(join(tmp, "slowfn", "index.ts"), slow("v1"));
    // Drain must outlast the 300ms in-flight handler so the superseded
    // worker isn't killed out from under it.
    const { registry, host } = makeHost(tmp, mode.colocate, 2000);
    await host.start();
    try {
      const before = registry.workerHandle("slowfn")!;
      const ac = new AbortController();
      const inflight = before.dispatch(
        new Request("http://localhost/"),
        null,
        ac.signal,
      );
      // Let the request reach the worker before reloading.
      await new Promise((r) => setTimeout(r, 60));

      await writeFile(join(tmp, "slowfn", "index.ts"), slow("v2"));
      const summary = await host.reload(new Set(["slowfn"]), "drain", {
        changedPaths: [join(tmp, "slowfn", "index.ts")],
      });
      assertEquals(summary.errors, []);

      // The in-flight request finishes against the old code, not dropped.
      const resp = await inflight;
      assertEquals(resp.status, 200);
      assertEquals(await resp.text(), "v1");

      // New traffic sees the new code.
      const after = registry.workerHandle("slowfn")!;
      const ac2 = new AbortController();
      const r2 = await after.dispatch(
        new Request("http://localhost/"),
        null,
        ac2.signal,
      );
      assertEquals(await r2.text(), "v2");
    } finally {
      await host.stop();
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

forBothModes("adding a new function makes it dispatchable", async (mode) => {
  const tmp = await Deno.makeTempDir({ prefix: "1tube-colo-add-" });
  try {
    await scaffold(tmp, ["alpha"]);
    const { registry, host } = makeHost(tmp, mode.colocate);
    await host.start();
    try {
      assertEquals(registry.workerHandle("delta"), undefined);
      await writeFile(join(tmp, "delta", "dep.ts"), `export const dep = "d1";\n`);
      await writeFile(join(tmp, "delta", "index.ts"), fnSource());
      const summary = await host.reload(new Set(["delta"]), "add", {
        changedPaths: [join(tmp, "delta", "index.ts")],
      });
      assertEquals(summary.errors, []);
      assertEquals(summary.added, ["delta"]);
      assertEquals((await call(registry, "delta")).dep, "d1");
    } finally {
      await host.stop();
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("colocated HMR re-imports ONLY the edited function regardless of project size", async () => {
  // The structural "not slower than isolated" guarantee: a reload's cost is
  // a function of the EDITED set, not the project size. We boot a wide set,
  // edit one function's sidecar, and assert every other function keeps its
  // module-load identity (i.e. was never re-imported) ó which is exactly
  // what a full-isolate recycle would violate.
  const tmp = await Deno.makeTempDir({ prefix: "1tube-colo-scale-" });
  const wide = Array.from({ length: 8 }, (_, i) => `fn${i}`);
  try {
    await scaffold(tmp, wide);
    const { registry, host } = makeHost(tmp, true);
    await host.start();
    try {
      const before = new Map<string, string>();
      for (const n of wide) before.set(n, (await call(registry, n)).load);

      await writeFile(join(tmp, "fn3", "dep.ts"), `export const dep = "edited";\n`);
      const t0 = performance.now();
      const summary = await host.reload(new Set(["fn3"]), "scale", {
        changedPaths: [join(tmp, "fn3", "dep.ts")],
      });
      const ms = performance.now() - t0;
      assertEquals(summary.errors, []);
      assertEquals(summary.reloaded, ["fn3"]);
      console.log(
        `[colocated] sidecar reload of 1/${wide.length} functions took ${
          ms.toFixed(0)
        }ms`,
      );

      assertEquals((await call(registry, "fn3")).dep, "edited");
      assert(
        (await call(registry, "fn3")).load !== before.get("fn3"),
        "edited function must re-import",
      );
      // Every OTHER function untouched ó proves no full recycle happened.
      for (const n of wide) {
        if (n === "fn3") continue;
        assertEquals(
          (await call(registry, n)).load,
          before.get(n),
          `${n} must NOT have been re-imported`,
        );
      }
    } finally {
      await host.stop();
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

forBothModes("removing a function clears it from the registry", async (mode) => {
  const tmp = await Deno.makeTempDir({ prefix: "1tube-colo-rm-" });
  try {
    await scaffold(tmp, ["alpha", "beta"]);
    const { registry, host } = makeHost(tmp, mode.colocate);
    await host.start();
    try {
      assert(registry.workerHandle("alpha"));
      await Deno.remove(join(tmp, "alpha"), { recursive: true });
      const summary = await host.reload(new Set(["alpha"]), "rm", {
        changedPaths: [join(tmp, "alpha", "index.ts")],
      });
      assertEquals(summary.removed, ["alpha"]);
      assertEquals(registry.workerHandle("alpha"), undefined);
      assertEquals(registry.has("alpha"), false);
      // beta still works.
      assertEquals((await call(registry, "beta")).dep, "beta1");
    } finally {
      await host.stop();
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
