/**
 * Tests for the workerd capnp generator.
 *
 * The generator is a pure function — these tests exercise the contract
 * directly with no I/O. Coverage focuses on:
 *
 *   - Snapshot of the standard happy-path output (so any future change
 *     is visible in diff review).
 *   - Determinism: identical inputs always produce identical text.
 *   - Validation of every public knob (names, basenames, ports, dates,
 *     flags) so a misconfigured caller fails loudly at generation
 *     instead of cryptically at workerd boot.
 *   - Per-function overrides for compat date and extra flags.
 *
 * The actual workerd parse of the generated output is verified by the
 * end-to-end M1 test (booting workerd against the generated config); a
 * fast unit-level sanity check on the lexical shape is done here.
 */

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { generateCapnp } from "../src/backends/workerd/capnp.ts";

Deno.test("workerd-capnp: emits well-formed config for two functions", () => {
  const result = generateCapnp([
    { name: "hello", bundleBasename: "hello.js" },
    { name: "echo", bundleBasename: "echo.js" },
  ]);

  // Routes are predictable and stable.
  assertEquals(result.routes.length, 2);
  assertEquals(result.routes[0], {
    name: "hello",
    service: "hello",
    address: "127.0.0.1",
    port: 8800,
    origin: "http://127.0.0.1:8800",
  });
  assertEquals(result.routes[1].port, 8801);
  assertEquals(result.routes[1].origin, "http://127.0.0.1:8801");

  // Body should look like the documented workerd capnp dialect.
  assertStringIncludes(result.text, `using Workerd = import "/workerd/workerd.capnp";`);
  assertStringIncludes(result.text, `const config :Workerd.Config = (`);
  assertStringIncludes(result.text, `name = "hello"`);
  assertStringIncludes(result.text, `name = "echo"`);
  assertStringIncludes(result.text, `esModule = embed "hello.js"`);
  assertStringIncludes(result.text, `esModule = embed "echo.js"`);
  assertStringIncludes(result.text, `address = "127.0.0.1:8800"`);
  assertStringIncludes(result.text, `address = "127.0.0.1:8801"`);
  assertStringIncludes(result.text, `compatibilityDate = "2026-04-25"`);
  assertStringIncludes(result.text, `compatibilityFlags = ["nodejs_compat", "nodejs_compat_populate_process_env"]`);

  // The bracket structure should balance — a quick sanity check that
  // saves an entire class of "missing comma" regressions.
  const opens = (result.text.match(/\(/g) ?? []).length;
  const closes = (result.text.match(/\)/g) ?? []).length;
  assertEquals(opens, closes, "parens must balance in generated capnp");
  const lOpens = (result.text.match(/\[/g) ?? []).length;
  const lCloses = (result.text.match(/\]/g) ?? []).length;
  assertEquals(lOpens, lCloses, "brackets must balance in generated capnp");
});

Deno.test("workerd-capnp: identical inputs produce byte-identical output", () => {
  const inputs = [
    { name: "hello", bundleBasename: "hello.js" },
    { name: "echo", bundleBasename: "echo.js" },
  ];
  const a = generateCapnp(inputs);
  const b = generateCapnp(inputs);
  assertEquals(a.text, b.text);
  assertEquals(a.routes, b.routes);
});

Deno.test("workerd-capnp: respects custom bind address and base port", () => {
  const result = generateCapnp(
    [{ name: "hello", bundleBasename: "hello.js" }],
    { bindAddress: "127.0.0.2", basePort: 9100 },
  );
  assertEquals(result.routes[0].address, "127.0.0.2");
  assertEquals(result.routes[0].port, 9100);
  assertEquals(result.routes[0].origin, "http://127.0.0.2:9100");
  assertStringIncludes(result.text, `address = "127.0.0.2:9100"`);
});

Deno.test("workerd-capnp: per-function overrides win over global defaults", () => {
  const result = generateCapnp(
    [
      {
        name: "future",
        bundleBasename: "future.js",
        compatibilityDate: "2026-04-25",
        extraCompatibilityFlags: ["streaming_compression", "no_handle_cross_request_promise_resolution"],
      },
      // Second function uses the global defaults so we can verify both
      // paths in one assertion.
      { name: "vanilla", bundleBasename: "vanilla.js" },
    ],
    { compatibilityDate: "2024-09-23", compatibilityFlags: ["nodejs_compat"] },
  );
  // Override applied to "future"...
  assertStringIncludes(result.text, `compatibilityDate = "2026-04-25"`);
  // ...and global default still in effect for "vanilla".
  assertStringIncludes(result.text, `compatibilityDate = "2024-09-23"`);

  // Extra flags appended after the globals, preserving order; original
  // global "nodejs_compat" must still be present and not duplicated.
  assertStringIncludes(
    result.text,
    `compatibilityFlags = ["nodejs_compat", "streaming_compression", "no_handle_cross_request_promise_resolution"]`,
  );
});

Deno.test("workerd-capnp: de-duplicates compatibility flags in stable order", () => {
  const result = generateCapnp(
    [{
      name: "fn",
      bundleBasename: "fn.js",
      extraCompatibilityFlags: ["nodejs_compat", "streaming_compression"],
    }],
    { compatibilityFlags: ["nodejs_compat"] },
  );
  // "nodejs_compat" should appear once even though it's in both lists.
  const occurrences = result.text.split(`"nodejs_compat"`).length - 1;
  assertEquals(occurrences, 1);
});

Deno.test("workerd-capnp: local outbound network still supports public HTTPS", () => {
  const result = generateCapnp(
    [{ name: "fn", bundleBasename: "fn.js" }],
    { allowLocalOutbound: true },
  );

  assertStringIncludes(result.text, `name = "internet"`);
  assertStringIncludes(result.text, `allow = ["public", "local"]`);
  assertStringIncludes(result.text, `tlsOptions = (trustBrowserCas = true)`);
});

Deno.test("workerd-capnp: emits entry and shared chunk modules for prebuilt functions", () => {
  const result = generateCapnp([{
    name: "fn",
    bundleBasename: "functions/fn.js",
    moduleFiles: ["functions/fn.js", "chunks/shared-ABC123.js"],
  }]);

  assertStringIncludes(result.text, `(name = "functions/fn.js", esModule = embed "functions/fn.js")`);
  assertStringIncludes(result.text, `(name = "chunks/shared-ABC123.js", esModule = embed "chunks/shared-ABC123.js")`);
});

Deno.test("workerd-capnp: rejects empty input", () => {
  assertThrows(() => generateCapnp([]), Error, "at least one function");
});

Deno.test("workerd-capnp: rejects duplicate function names", () => {
  assertThrows(
    () =>
      generateCapnp([
        { name: "hello", bundleBasename: "hello.js" },
        { name: "hello", bundleBasename: "hello-2.js" },
      ]),
    Error,
    "duplicate function name",
  );
});

Deno.test("workerd-capnp: rejects unsafe service names", () => {
  for (const bad of ["", "1bad", "has space", "has/slash", "has-quote\"", "has\\back"]) {
    assertThrows(
      () => generateCapnp([{ name: bad, bundleBasename: "x.js" }]),
      Error,
      "service name",
      `expected rejection for ${JSON.stringify(bad)}`,
    );
  }
  // Sanity: known-good names accepted.
  for (const ok of ["hello", "echo-1", "auth_me", "A2"]) {
    const r = generateCapnp([{ name: ok, bundleBasename: "x.js" }]);
    assert(r.text.length > 0);
  }
});

Deno.test("workerd-capnp: accepts safe relative bundle paths", () => {
  const r = generateCapnp([{ name: "fn", bundleBasename: "functions/fn.js" }]);
  assert(r.text.includes('embed "functions/fn.js"'));
});

Deno.test("workerd-capnp: rejects unsafe bundle embed paths", () => {
  for (const bad of ["", "../escape.js", "/abs.js", "./fn.js", "sub//dir.js", "back\\slash.js", `quote".js`, ".", ".."]) {
    assertThrows(
      () => generateCapnp([{ name: "fn", bundleBasename: bad }]),
      Error,
      "bundle embed path",
      `expected rejection for ${JSON.stringify(bad)}`,
    );
  }
});

Deno.test("workerd-capnp: rejects malformed dates and flags", () => {
  assertThrows(
    () =>
      generateCapnp(
        [{ name: "fn", bundleBasename: "fn.js" }],
        { compatibilityDate: "yesterday" },
      ),
    Error,
    "compatibilityDate",
  );

  assertThrows(
    () =>
      generateCapnp(
        [{ name: "fn", bundleBasename: "fn.js" }],
        { compatibilityFlags: ["Bad-Flag-Name"] },
      ),
    Error,
    "compatibility flag",
  );
});

Deno.test("workerd-capnp: rejects out-of-range or overflowing ports", () => {
  assertThrows(
    () => generateCapnp([{ name: "fn", bundleBasename: "fn.js" }], { basePort: 80 }),
    Error,
    "basePort",
  );
  assertThrows(
    () => generateCapnp([{ name: "fn", bundleBasename: "fn.js" }], { basePort: 70000 }),
    Error,
    "basePort",
  );
  assertThrows(
    () => generateCapnp([{ name: "fn", bundleBasename: "fn.js" }], { basePort: 0 }),
    Error,
    "basePort",
  );
  assertThrows(
    () =>
      generateCapnp(
        Array.from({ length: 5 }, (_, i) => ({
          name: `fn${i}`,
          bundleBasename: `fn${i}.js`,
        })),
        { basePort: 65533 },
      ),
    Error,
    "overflows",
  );
});

Deno.test("workerd-capnp: omits bindings field when no env vars are forwarded", () => {
  const result = generateCapnp([{ name: "fn", bundleBasename: "fn.js" }]);
  // Operator can grep for "bindings" to find anything env-related; the
  // common case (no forwarding) must NOT mention the field at all so
  // the diff against M1 stays minimal.
  assert(!result.text.includes("bindings"), "should omit bindings field when empty");
});

Deno.test("workerd-capnp: emits fromEnvironment bindings without leaking values", () => {
  // The literal value `super-secret-shhh` is intentionally not passed
  // anywhere into the generator — we only ever supply the *name*. This
  // test guards the security property that `config.capnp` on disk
  // contains zero secret material.
  const result = generateCapnp([{
    name: "fn",
    bundleBasename: "fn.js",
    envBindings: ["OPENAI_API_KEY", "POSTHOG_HOST"],
  }]);
  assertStringIncludes(
    result.text,
    `(name = "OPENAI_API_KEY", fromEnvironment = "OPENAI_API_KEY")`,
  );
  assertStringIncludes(
    result.text,
    `(name = "POSTHOG_HOST", fromEnvironment = "POSTHOG_HOST")`,
  );
  assert(
    !result.text.includes("super-secret-shhh"),
    "capnp output must never embed env values",
  );
});

Deno.test("workerd-capnp: de-duplicates env binding names in stable order", () => {
  const result = generateCapnp([{
    name: "fn",
    bundleBasename: "fn.js",
    envBindings: ["FOO", "BAR", "FOO", "BAZ", "BAR"],
  }]);
  const order = ["FOO", "BAR", "BAZ"];
  // The first occurrence of each name must appear before any later one,
  // and each must appear exactly once across the full output.
  for (const name of order) {
    const occurrences = result.text.split(`fromEnvironment = "${name}"`).length - 1;
    assertEquals(occurrences, 1, `${name} must appear exactly once`);
  }
  const fooAt = result.text.indexOf(`fromEnvironment = "FOO"`);
  const barAt = result.text.indexOf(`fromEnvironment = "BAR"`);
  const bazAt = result.text.indexOf(`fromEnvironment = "BAZ"`);
  assert(fooAt < barAt && barAt < bazAt, "stable insertion order must be preserved");
});

Deno.test("workerd-capnp: rejects malformed env binding names", () => {
  for (const bad of ["", "1FOO", "has-dash", "has space", "has=eq", "has.dot"]) {
    assertThrows(
      () =>
        generateCapnp([{
          name: "fn",
          bundleBasename: "fn.js",
          envBindings: [bad],
        }]),
      Error,
      "env var name",
      `expected rejection for ${JSON.stringify(bad)}`,
    );
  }
});

Deno.test("workerd-capnp: socket and service names line up by index", () => {
  const result = generateCapnp([
    { name: "alpha", bundleBasename: "alpha.js" },
    { name: "beta", bundleBasename: "beta.js" },
    { name: "gamma", bundleBasename: "gamma.js" },
  ]);
  // Routes are in input order with monotonically increasing ports.
  assertEquals(result.routes.map((r) => r.name), ["alpha", "beta", "gamma"]);
  assertEquals(result.routes.map((r) => r.port), [8800, 8801, 8802]);

  // Each service has a corresponding socket whose `service` reference
  // matches by name. Lift the socket->service mapping out of the text
  // and assert it matches what we promised in the routes table.
  const socketRx = /name = "([\w-]+)-sock",\s+address = "([^"]+)",\s+http = \(\),\s+service = "([\w-]+)"/g;
  const found = [...result.text.matchAll(socketRx)].map((m) => ({
    socketName: m[1],
    address: m[2],
    service: m[3],
  }));
  assertEquals(found.length, 3);
  for (let i = 0; i < found.length; i++) {
    const route = result.routes[i];
    assertEquals(found[i].socketName, route.service);
    assertEquals(found[i].service, route.service);
    assertEquals(found[i].address, `${route.address}:${route.port}`);
  }
});
