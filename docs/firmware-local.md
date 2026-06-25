# OneTube firmware — local end-to-end recipe

Quick path from "I edited an edge function" to "the production-shaped host is
now serving it via a signed, atomic, zero-downtime swap" on a single dev box.
The same flow runs in CI; the only difference is who holds the signing key and
where the curl call originates.

## Prereqs

| Tool                                                                                                                                   | Reason                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Deno on PATH (or absolute path in `OneTube.DenoBinary`)                                                                                | Builds the bundles + runs the gateway.                         |
| `workerd` binary on PATH (or absolute path in `OneTube.WorkerdBinary`)                                                                 | Runs the bundled functions when `OneTube.Backend = "Workerd"`. |
| `priprava` configured with `OneTube.Enabled = true`, `OneTube.Firmware.Enabled = true`, and `OneTube.Firmware.SharedSecret` populated. | Hosts the firmware endpoints.                                  |
| `sciobot-next` checked out at `C:/Users/lordo/Documents/GitHub/sciobot-next` (or wherever `OneTube.FunctionsPath` points).             | Source for the bundled functions.                              |

The shared secret can be any random hex/base64 string. A 32-byte key is fine; 16
bytes is the minimum we accept. Generate one with:

```powershell
[Convert]::ToHexString([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
```

Set it once for the dev session:

```powershell
$env:ONETUBE_FIRMWARE_KEY = "<the-hex-from-above>"
```

## 1. Build sciobot-next functions

```powershell
cd C:/Users/lordo/Documents/GitHub/sciobot-next
deno run -A ../1tube/src/cli.ts build `
  --functions supabase/functions `
  --out dist/
```

Result: `dist/manifest.json` + `dist/functions/<fn>.js`.

> **Deno config resolution.** The build auto-detects an import map from (in
> order): `cwd/deno.json[c]`, then `<functions-dir>/deno.json[c]` — the second
> covers the standard Supabase layout where the `deno.json` lives next to the
> edge functions, not at repo root. If neither exists the build still proceeds
> but with no import map (npm: / jsr: / bare specifiers must already be
> installed). Override with `--config <path>` or skip entirely with
> `--no-config`.

## 2. Package into a signed `.1tube` payload

```powershell
deno run -A ../1tube/src/cli.ts package `
  --in dist `
  --out fw.1tube `
  --sign-key=$env:ONETUBE_FIRMWARE_KEY
```

Result: a single `fw.1tube` zip containing the dist tree + a signed
`envelope.json`. Inspect it with `Expand-Archive -DestinationPath ./peek` if
you're curious — the inner layout is `dist/manifest.json`, `dist/functions/...`,
and a sibling `envelope.json` with the HMAC.

## 3. Start priprava

In the priprava repo:

```powershell
cd C:/Users/lordo/Documents/GitHub/priprava/src
dotnet run
```

Watch the boot log for these two lines (proves the supervisor is wired up and
respects `state.json` if present):

```
[1tube/firmware] supervisor ready · current=<none> · previous=<none> · dataRoot=...
[1tube/active] gateway started (PID <pid>, backend=workerd) on 127.0.0.1:3100
```

### A note on body size limits

ASP.NET Core caps request bodies at 30 MB by default at _two_ layers (Kestrel
server + per-endpoint). The supervisor lifts the per-endpoint cap to
`FirmwareOptions.MaxUploadBytes` (default 512 MB) automatically. The **Kestrel
server-wide limit** still applies — for fully-bundled sciobot-next deploys
(often 30–100+ MB) you'll need to bump it in your host startup:

```csharp
builder.WebHost.ConfigureKestrel(o => o.Limits.MaxRequestBodySize = 512L * 1024 * 1024);
```

Reverse-proxy limits (nginx `client_max_body_size`, IIS `uploadReadAheadSize`,
Cloudflare's plan-dependent cap) are outside our control; raise them in their
own config when uploads stall before reaching priprava.

## 4. Upload the payload

```powershell
curl -X POST http://localhost:5000/1tube/api/firmware/upload `
  -H "Authorization: Bearer $env:ONETUBE_FIRMWARE_KEY" `
  --data-binary @fw.1tube
```

Response: `202 { "jobId": "<32hex>" }`.

## 5. Poll the job

```powershell
curl -H "Authorization: Bearer $env:ONETUBE_FIRMWARE_KEY" `
  http://localhost:5000/1tube/api/firmware/jobs/<jobId>
```

Expected progression:
`Received → Verifying → Staging → SmokeTesting → Promoting → Done`, with
`timings.totalMs` filled in at the end.

## 6. Confirm zero downtime across the swap

In a second terminal:

```powershell
while ($true) {
  try {
    (Invoke-WebRequest http://localhost:5000/functions/v1/hello -UseBasicParsing).StatusCode
  } catch { $_.Exception.Response.StatusCode.value__ }
  Start-Sleep -Milliseconds 100
}
```

Across the swap window every line should be `200`. A short burst of `502/503`
indicates the candidate didn't come up cleanly — investigate via
`GET /1tube/api/firmware/jobs/<id>` for the recorded error.

## 7. Failure-injection drills

These are manual once; codify in CI as you stabilise:

| Drill              | Tampered byte                                                                                            | Expected outcome                                                                           |
| ------------------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Bundle byte        | flip a single byte inside `dist/functions/<fn>.js` of an extracted `fw.1tube`, re-zip without re-signing | Job fails at **Verifying**, no state change. `current` continues serving old code.         |
| Envelope signature | flip a hex char in `envelope.json#signature.value` and re-zip                                            | Job fails at **Verifying**, no state change.                                               |
| Smoke failure      | `console.error('boom'); throw new Error('boom')` at module-top of one function, rebuild + repackage      | Job fails at **SmokeTesting**, no state change. `versions/<ver>/` retained for inspection. |
| Rollback           | `POST /1tube/api/firmware/rollback` after a successful swap                                              | `previous` becomes `current`, traffic continues uninterrupted.                             |

## 7a. Concurrency drills (pre-emption)

The supervisor pre-empts a cancellable predecessor and refuses to interrupt a
mid-promote. Both behaviours are observable from `curl`.

**Watch the active slot** in a side terminal:

```powershell
while ($true) {
  curl -s -H "Authorization: Bearer $env:ONETUBE_FIRMWARE_KEY" `
    http://localhost:5000/1tube/api/firmware/active
  Start-Sleep -Milliseconds 250
}
```

| Drill                       | How                                                                                                                                                                                                                                      | Expected                                                                                                                                                                            |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pre-empt a slow upload      | Build a payload with a function that `await new Promise(r=>setTimeout(r,20000))` at module-top so smoke takes ~its full timeout. Upload it, then upload a healthy `fw.1tube` while the first is in `SmokeTesting`.                       | Job A: `Cancelled` with `error: "pre-empted by a later upload or rollback"`. Job B: `Done`. `/active` shows A briefly, then flips to B, then 404. No 502s on `/functions/v1/hello`. |
| Refuse during promote       | Hard one to hit by hand because `Promoting` is fast (<1 s). Set `OneTube.Firmware.SmokeTimeoutMs = 1` to widen the window if needed, or fire two uploads back-to-back in a tight loop until the second lands during the first's promote. | Second upload returns **HTTP 409** with `Retry-After: 2` and `{ conflictingJobId, conflictingState: "Promoting" }`. First job still completes as `Done`.                            |
| Client aborts upload        | Start a large upload, kill the curl process mid-stream (Ctrl-C).                                                                                                                                                                         | Job appears in `/jobs/{id}` (if you captured it from a prior `/active` poll) as `Cancelled` with `error: "upload aborted by client"`. No `incoming/<jobId>/` left on disk.          |
| Rollback during a stuck job | Start a slow upload; while it's in `SmokeTesting`, `POST /rollback`.                                                                                                                                                                     | Upload job: `Cancelled`. Rollback job: `RolledBack`. `current` is the previous version.                                                                                             |

## 8. Inspect the on-disk state

```powershell
cat (Join-Path $env:DATA_ROOT "onetube/state.json")
```

Schema:

```json
{
  "schemaVersion": 1,
  "current": "2026-04-26T19-30-00Z-abc12345",
  "previous": "2026-04-26T19-15-00Z-deadbeef",
  "history": [
    { "version": "...", "promotedAt": "...", "envelopeManifestSha256": "..." }
  ]
}
```

GC retains `RetainVersions` newest plus current+previous, so the historical
floor is `max(2, RetainVersions)` directories under `versions/`.

## CI integration (later)

Once this works locally, the GitHub Actions step is a straight two-line shell
call to `1tube build && 1tube package` followed by

```bash
curl -X POST "$PRIPRAVA_URL/1tube/api/firmware/upload" \
  -H "Authorization: Bearer $ONETUBE_FIRMWARE_KEY" \
  --data-binary @fw.1tube
```

Poll the resulting jobId until `Done` (or fail the workflow on `Failed`).
