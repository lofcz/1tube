/**
 * `https:` / `http:` module loading (deno.land/x, esm.sh, raw GitHub, …).
 *
 * Bun has no URL imports, so the compat plugin routes them here. Each
 * module is fetched once, cached on disk (default `<cwd>/.1tube/remote`)
 * and reused across restarts — the same "download once, then offline"
 * behaviour Deno's `DENO_DIR` gave.
 *
 * Module bodies are rewritten before Bun sees them: relative and
 * root-relative specifiers (`./util.ts`, `/v135/zod@3/es2022/zod.mjs`) are
 * made absolute against the module's final (post-redirect) URL. Bun does
 * not consult plugins for path-like specifiers inside plugin-loaded
 * modules, so leaving them relative would make it look on the local disk.
 * TypeScript sources (deno.land/x) are transpiled to JS first.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { init as initLexer, parse as parseImports } from "es-module-lexer";

export interface RemoteModuleCacheOptions {
  dir: string;
  /** Re-download even when cached (`--reload`). */
  reload?: boolean;
  fetch?: typeof fetch;
}

export interface RemoteModule {
  /** Final URL after redirects — the base for relative imports. */
  url: string;
  /** JavaScript source with absolute import specifiers. */
  code: string;
}

export interface RemoteModuleCache {
  load(url: string): Promise<RemoteModule>;
}

interface CacheMeta {
  url: string;
  finalUrl: string;
  fetchedAt: string;
}

const tsTranspiler = new Bun.Transpiler({ loader: "ts" });
const tsxTranspiler = new Bun.Transpiler({ loader: "tsx" });
const jsxTranspiler = new Bun.Transpiler({ loader: "jsx" });

function pickTranspiler(url: string, contentType: string): Bun.Transpiler | null {
  const path = new URL(url).pathname.toLowerCase();
  if (path.endsWith(".tsx")) return tsxTranspiler;
  if (path.endsWith(".jsx")) return jsxTranspiler;
  if (path.endsWith(".ts") || path.endsWith(".mts") || /typescript/i.test(contentType)) {
    return tsTranspiler;
  }
  return null;
}

/** Make every path-like specifier absolute against `base`. */
export async function absolutizeImports(code: string, base: string): Promise<string> {
  await initLexer;
  const [imports] = parseImports(code);
  let out = "";
  let last = 0;
  for (const imp of imports) {
    // `n` is the resolved specifier string; undefined for computed dynamic imports.
    const spec = imp.n;
    if (!spec) continue;
    if (!(spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("/"))) {
      continue;
    }
    const abs = new URL(spec, base).href;
    // For static imports `s..e` spans the bare text; for dynamic ones it
    // spans the quoted literal, so re-quote there.
    const isDynamic = imp.d > -1;
    out += code.slice(last, imp.s);
    out += isDynamic ? JSON.stringify(abs) : abs;
    last = imp.e;
  }
  return out + code.slice(last);
}

export function createRemoteModuleCache(
  opts: RemoteModuleCacheOptions,
): RemoteModuleCache {
  const doFetch = opts.fetch ?? fetch;
  const inflight = new Map<string, Promise<RemoteModule>>();

  function paths(url: string) {
    const key = createHash("sha256").update(url).digest("hex");
    return {
      code: join(opts.dir, `${key}.js`),
      meta: join(opts.dir, `${key}.json`),
    };
  }

  function readCached(url: string): RemoteModule | null {
    if (opts.reload) return null;
    const p = paths(url);
    try {
      const meta = JSON.parse(readFileSync(p.meta, "utf8")) as CacheMeta;
      return { url: meta.finalUrl, code: readFileSync(p.code, "utf8") };
    } catch {
      return null;
    }
  }

  async function download(url: string): Promise<RemoteModule> {
    const res = await doFetch(url, { redirect: "follow" });
    if (!res.ok) {
      throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);
    }
    const finalUrl = res.url || url;
    let code = await res.text();
    const transpiler = pickTranspiler(finalUrl, res.headers.get("content-type") ?? "");
    if (transpiler) code = transpiler.transformSync(code);
    code = await absolutizeImports(code, finalUrl);
    const p = paths(url);
    try {
      mkdirSync(opts.dir, { recursive: true });
      writeFileSync(p.code, code);
      writeFileSync(
        p.meta,
        JSON.stringify({ url, finalUrl, fetchedAt: new Date().toISOString() } satisfies CacheMeta),
      );
    } catch {
      // An unwritable cache only costs a re-download next boot.
    }
    return { url: finalUrl, code };
  }

  return {
    load(url) {
      const cached = readCached(url);
      if (cached) return Promise.resolve(cached);
      let p = inflight.get(url);
      if (!p) {
        p = download(url).finally(() => inflight.delete(url));
        inflight.set(url, p);
      }
      return p;
    },
  };
}
