# AWS production cutover lock

Successful cutover is locked. Do not deploy a new SPA unless a human explicitly
releases this lock and restores from a previously validated AWS/Cognito
fingerprint.

## Known good

| Item | Value |
|---|---|
| Git commit | `868e69387d63af511f4c185775b611dea2c8fc47` |
| SPA | `index-CiOVNYWh.js` |
| Cognito pool | `us-east-1_h00WorYMT` |
| Cognito client | `3ja9fqaq2fjkv3i6up2varcqpe` |
| API | `/prep` |
| S3 | `checksops-production-frontend-806168576068` |
| CloudFront | `E1B0ZWWO5559U5` default origin `ProductionSpaS3` |
| Fingerprint | `aws/cutover/production-spa-fingerprints/production-spa-868e69387d63-2026-09-14T15-13-43-687Z.json` |

## Closed accidental paths

- `node scripts/deploy-production-spa.mjs --apply` → `production_spa_cutover_locked`
- `npm run build` / `vite build` / `bun run build` do not upload
- CI (`aws-migration-ci.yml`) is `contents: read` and never `aws s3 sync`
- Staging/Cursor/rehearsal principals are denied object writes by the production frontend bucket policy except `ChecksOpsProductionSpaDeploy` (not created; template `DeployRole=false`) and account root
- Rollback refuses Supabase-mode artifacts
- `aws/cloudfront/apply-step1.mjs` refuses `UpdateDistribution` after cutover
- Production Cognito mapping locks remain in `aws/functions/api/production-cognito-locks.mjs`
- AWS Moov `https://checksops.com/prep/webhooks/moov` remains the only enabled production Moov webhook; do not re-enable the Supabase hook

## Remaining privileged-only paths (not accidental CI/dev)

These require account-root or an AWS/DNS administrator. They are not opened by `npm run build`, CI, Cursor staging, or Lovable Publish:

- AWS account root can still write the bucket or replace the bucket policy
- Creating and assuming `ChecksOpsProductionSpaDeploy` (template stays `DeployRole=false`; intended Cursor OIDC trust is `aws/production/production-spa-deploy-role-trust.json`. `ChecksOpsCursorCloudStaging` cannot `iam:UpdateAssumeRolePolicy` / `iam:CreateRole` on that role.)
- An IAM principal that already has `cloudfront:UpdateDistribution` on `E1B0ZWWO5559U5` (Cursor staging does not; `apply-step1.mjs` is locked)
- Changing Cloudflare/DNS away from CloudFront

## Human unlock (do not do this accidentally)

1. Create/assume `ChecksOpsProductionSpaDeploy` (or use account root).
2. `CHECKSOPS_PRODUCTION_SPA_UNLOCK=RELEASE_CUTOVER_LOCK`
3. `node scripts/rollback-production-spa.mjs --from-fingerprint aws/cutover/production-spa-fingerprints/production-spa-868e69387d63-2026-09-14T15-13-43-687Z.json --apply`

Any other artifact, including a fresh `production-aws` build that is not that fingerprint, is refused.
