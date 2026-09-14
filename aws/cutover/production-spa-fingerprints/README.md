# Production SPA fingerprints

`node scripts/deploy-production-spa.mjs` records:

Git commit → SPA bundle hashes → Cognito pool/client → API target → timestamp

`latest.json` is written locally by that script and is gitignored.

`--apply` is the only approved production upload path. It:

1. builds `production-aws`
2. refuses any artifact that fails `scripts/validate-production-spa-artifact.mjs`
3. syncs `dist/` to `s3://checksops-production-frontend-806168576068` with `--delete`
4. uploads `index.html` with `no-cache, no-store, must-revalidate`
5. invalidates CloudFront `E1B0ZWWO5559U5` `/*`
6. records a timestamped fingerprint under this directory

Do not use `npm run build` or raw `aws s3 sync`.
