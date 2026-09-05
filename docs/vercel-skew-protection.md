# Vercel Skew Protection with `1tube build --target vercel`

[Skew Protection](https://vercel.com/docs/skew-protection) pins a client to the
deployment it was loaded from, so a tab that has been open for hours keeps
talking to functions that understand its request shapes even after you ship a
new production deployment. Vercel does this automatically for Next.js & co. For
a static SPA + 1tube functions shipped with `vercel deploy --prebuilt` you have
to wire two things yourself; 1tube covers the function side.

## What 1tube does

| Piece                                                 | Where                           | Behaviour                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--deployment-id <id>` / `1TUBE_VERCEL_DEPLOYMENT_ID` | `1tube build --target vercel`   | Validated (≤ 32 chars, `[A-Za-z0-9_-]`, same rules `vercel build` enforces) and written as the top-level `deploymentId` of `.vercel/output/config.json`. Vercel uses it as the deployment's id, so the id you baked into the frontend matches. Omitting the flag leaves an existing `deploymentId` untouched (safe for `--only` passes). |
| `x-deployment-id` response header                     | Vercel bundle wrapper (runtime) | Every response carries `VERCEL_DEPLOYMENT_ID` (when Vercel provides it) unless the function already set the header. Clients compare it with their own id to detect skew — e.g. the pinned deployment aged out and the request fell through to the latest one.                                                                            |
| CORS defaults                                         | gateway `cors.ts`               | `x-deployment-id` is in the default `Access-Control-Allow-Headers` (so a cross-origin pin survives preflight) and in `Access-Control-Expose-Headers` (so JS can read the echo).                                                                                                                                                          |

Nothing changes for the Deno / workerd targets.

## Consumer checklist

1. **Enable it in Vercel.** Project → Settings → Advanced → Skew Protection.
   Requires _Enable access to System Environment Variables_. Set the maximum age
   at least as long as your longest realistic session (dashboards, generation
   pipelines, exams).

2. **Mint one id per deploy and use it everywhere.** In CI:

   ```bash
   # ≤ 32 chars, [A-Za-z0-9_-]. Unique per deploy: sha alone collides on redeploys.
   export DEPLOYMENT_ID="${GITHUB_SHA::12}-$(date +%s | tail -c 7)"
   export 1TUBE_VERCEL_DEPLOYMENT_ID="$DEPLOYMENT_ID"   # or pass --deployment-id
   ```

   Bake `DEPLOYMENT_ID` into the frontend build too (a `define`,
   `import.meta.env`, …). If the two ids differ the pin points at a deployment
   that never existed and Vercel answers 404.

3. **Build & deploy prebuilt.**

   ```bash
   vercel build --prod                                  # frontend → .vercel/output
   1tube build --target vercel --deployment-id "$DEPLOYMENT_ID"
   vercel deploy --prebuilt --prod
   ```

   Use a Vercel CLI released after January 2026 (when Skew Protection gained
   prebuilt support); older CLIs silently ignore `deploymentId`.

4. **Pin your own `fetch()` calls.** Vercel only pins framework-managed
   requests; a hand-rolled API client must send the id itself:

   ```ts
   const DEPLOYMENT_ID = import.meta.env.VITE_DEPLOYMENT_ID; // baked at build time

   const res = await fetch(url, {
     headers: DEPLOYMENT_ID ? { "x-deployment-id": DEPLOYMENT_ID } : {},
   });
   const served = res.headers.get("x-deployment-id");
   if (DEPLOYMENT_ID && served && served !== DEPLOYMENT_ID) {
     // pinned deployment is gone (aged out / deleted) — offer a reload
   }
   ```

   `?dpl=<id>` works as an alternative to the header (handy for `EventSource` or
   `<img>` URLs that can't carry headers).

5. **Cross-origin?** If the SPA and the functions live on different origins, add
   the SPA's host under _Allowed Domains for Cross-Site Fetch_ in the same
   Vercel settings panel, otherwise the pin is ignored for those requests.

## Long-lived sessions

Document navigations (hard refresh, new tab) always go to the latest deployment;
Vercel then triggers a reload when the client detects a version mismatch. If
even that is disruptive, set the `__vdpl=<id>` cookie
(`HttpOnly; SameSite=Strict; Path=/`) from a function or a routing rule to pin
navigations too — see the Vercel docs. 1tube deliberately does not set that
cookie: it pins users to an old deployment until it is cleared, which is a
product decision, not a build-tool default.

## Gotchas

- The id is _not_ the `dpl_…` Vercel generates — that one is only known after
  upload, too late to bake into the frontend. Always use your own.
- You own the id lifecycle: Vercel accepts the same id on several deploys, but
  then the pin no longer identifies one build. Include a timestamp or run
  number, not just the commit sha, so a redeploy of the same commit is still
  distinguishable.
- `1tube build --target vercel` merges into whatever `vercel build` produced;
  run it _after_ the frontend build so its `config.json` is the one that gets
  the `deploymentId`.
