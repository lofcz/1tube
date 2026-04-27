# npm Trusted Publishing

The `1tube` npm package is published by `.github/workflows/release.yml` using
npm provenance and GitHub OIDC.

Repository-side requirements are already in the workflow:

- `permissions.id-token: write`
- `npm publish --provenance --access public`
- no `NODE_AUTH_TOKEN` is required for npm publishing

npm-side setup must be done once in the npm package settings:

1. Open `https://www.npmjs.com/package/1tube/access`.
2. Add a trusted publisher for GitHub Actions.
3. Use owner `lofcz`, repository `1tube`, workflow `release.yml`.
4. Leave environment empty unless the release job is later moved into a GitHub
   Environment.

After that, run the `Release` workflow with `Publish npm package` checked.
Downstream projects can then use the published CLI:

```bash
npx 1tube package --functions supabase/functions --out fw.1tube --sign-key "$1TUBE_PACKAGE_SIGN_KEY"
```

The npm binary is a Node shim that invokes Deno, so downstream CI must install
Deno before running `npx 1tube`.
