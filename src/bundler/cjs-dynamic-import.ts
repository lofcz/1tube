/**
 * Named exports for `import()` of a CommonJS module in code-split bundles.
 *
 * With `splitting: true`, esbuild emits a dynamically imported CommonJS module
 * as its own chunk whose only export is `export default require_x()`. The
 * namespace returned by `await import("undici")` then has `default` and nothing
 * else, so `const { Agent } = await import("undici")` yields `undefined` —
 * while Bun, Node and esbuild without splitting all expose `Agent`. In a
 * minified Vercel bundle this surfaces as "m is not a constructor".
 *
 * Node's ESM↔CJS bridge detects the export names statically with
 * `cjs-module-lexer` and snapshots them from `module.exports`. This plugin
 * does the same at build time: a dynamic import that resolves to a CommonJS
 * file is routed through a small ESM wrapper that re-exports `module.exports`
 * as `default` plus one named export per detected name.
 */

import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { init as initCjsLexer, parse as parseCjs } from "cjs-module-lexer";
import { init as initEsmLexer, parse as parseEsm } from "es-module-lexer";
import type * as esbuild from "esbuild";

const NAMESPACE = "1tube-cjs-dynamic";
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const RESERVED = new Set([
  "await", "break", "case", "catch", "class", "const", "continue", "debugger", "default",
  "delete", "do", "else", "enum", "export", "extends", "false", "finally", "for", "function",
  "if", "implements", "import", "in", "instanceof", "interface", "let", "new", "null",
  "package", "private", "protected", "public", "return", "static", "super", "switch", "this",
  "throw", "true", "try", "typeof", "var", "void", "while", "with", "yield",
]);

type ProbeData = { cjsDynamicProbe?: boolean; probe?: boolean; builtinProbe?: boolean };

async function isCommonJs(path: string, source: string): Promise<boolean> {
  if (path.endsWith(".cjs")) return true;
  if (!path.endsWith(".js")) return false;
  // esbuild picks the module format from syntax, not `package.json#type`, so
  // decide the same way it does.
  await initEsmLexer;
  try {
    return !parseEsm(source)[3];
  } catch {
    return false;
  }
}

/** Export names of a CommonJS module, following `module.exports = require(…)`. */
async function commonJsExportNames(
  build: esbuild.PluginBuild,
  path: string,
  seen = new Set<string>(),
): Promise<Set<string>> {
  const names = new Set<string>();
  if (seen.has(path)) return names;
  seen.add(path);
  await initCjsLexer();
  const { exports, reexports } = parseCjs(await readFile(path, "utf8"));
  for (const name of exports) names.add(name);
  for (const specifier of reexports) {
    const target = await build.resolve(specifier, {
      kind: "require-call",
      resolveDir: dirname(path),
      importer: path,
      pluginData: { cjsDynamicProbe: true },
    });
    if (target.errors.length > 0 || target.external || target.namespace !== "file") continue;
    for (const name of await commonJsExportNames(build, target.path, seen)) names.add(name);
  }
  names.delete("default");
  names.delete("__esModule");
  return names;
}

function wrapperSource(path: string, names: Iterable<string>): string {
  const lines = [
    `const __cjs = require(${JSON.stringify(path)});`,
    "export default __cjs;",
  ];
  let index = 0;
  for (const name of names) {
    if (IDENTIFIER.test(name) && !RESERVED.has(name)) {
      lines.push(`export const ${name} = __cjs[${JSON.stringify(name)}];`);
    } else {
      const local = `__cjs_${index++}`;
      lines.push(`const ${local} = __cjs[${JSON.stringify(name)}];`);
      lines.push(`export { ${local} as ${JSON.stringify(name)} };`);
    }
  }
  return lines.join("\n") + "\n";
}

export function cjsDynamicImportPlugin(): esbuild.Plugin {
  return {
    name: "1tube-cjs-dynamic-import",
    setup(build) {
      build.onResolve({ filter: /.*/ }, async (args) => {
        if (args.kind !== "dynamic-import") return undefined;
        const data = args.pluginData as ProbeData | undefined;
        if (data?.cjsDynamicProbe || data?.probe || data?.builtinProbe) return undefined;
        // Resolve as a static import so this plugin does not see its own probe.
        const resolved = await build.resolve(args.path, {
          kind: "import-statement",
          importer: args.importer,
          resolveDir: args.resolveDir,
          namespace: args.namespace,
          pluginData: { cjsDynamicProbe: true },
        });
        if (resolved.errors.length > 0 || resolved.external || resolved.namespace !== "file") {
          return undefined;
        }
        let source: string;
        try {
          source = await readFile(resolved.path, "utf8");
        } catch {
          return undefined;
        }
        if (!(await isCommonJs(resolved.path, source))) return undefined;
        return { path: resolved.path, namespace: NAMESPACE };
      });

      build.onLoad({ filter: /.*/, namespace: NAMESPACE }, async (args) => ({
        contents: wrapperSource(args.path, await commonJsExportNames(build, args.path)),
        loader: "js",
        resolveDir: dirname(args.path),
      }));
    },
  };
}
