# Live production API files reconciled onto main (2026-10-21)

The reviewed reconciliation that owner decision item 4 of
`ops/release-2026-10-17-lock-pin-deltas.md` required before any full ZIP rebuild of
`checksops-production-prep-api`. Nothing here deploys: it makes a Lambda built from main
carry every behaviour production runs today, so that the rebuilt ZIP (which Moov onboarding
needs for `@aws-sdk/client-kms`) drops nothing.

Evidence: read-only production inspect run 39577337627 (2026-10-21, main `3f64333ed`, package
`ephceZY0Zjg7Dscil3D2cdtZzzAWellnHprPDYZ/50w=`): 167 API files equal main, 21 differ. The 21 live
byte streams were recovered from git history (every live SHA-256 matches a blob reachable from the
2026-10-11 snapshot `f78e16d99` or a merged branch), so no production download was needed.

## Disposition per file

| File | Live vs main | What main now carries | Why |
|---|---|---|---|
| `providers/parity/moov-stakeholder-status.mjs` | absent from main | live bytes, verbatim | live-only module; nothing on main imports it, kept so the bundle stays byte-complete |
| `providers/parity/platform-finance.mjs` | absent from main | live bytes, verbatim | live-only read model; owner decision item 1 moved its routes to `moov-onboard.mjs`, the module itself is kept for the bundle |
| `providers/parity/tenant-receivables.mjs` | absent from main | live bytes, verbatim | live-only module; its imports from `tenant-collection-v2.mjs` all exist on main |
| `tenant-collection-contract-v2.mjs` | absent from main | live bytes, verbatim | live-only module; its imports from `tenant-collection-v2.mjs` all exist on main |
| `ocr.mjs` | live-only S14 payee-line lock (`resolveWritablePayeeLine`) | live bytes, verbatim | owner decision item 5: production keeps the S14 bytes; main now equals them, `keep_live` still holds |
| `ocr-parse.mjs` | live-only carrier/bank sanitising, payee-line cleaning, claim-token patterns, amount scoring | live bytes, verbatim | production OCR quality; main's older parser would regress carriers and payees |
| `check-ocr-provider.mjs` | live-only Azure/Textract carrier and payee merge using the `ocr-parse.mjs` exports | live bytes, verbatim | same OCR pipeline as above |
| `ocr-descriptive-persist.mjs` | live-only amount persistence through `public.ocr_persist_extracted_amount`, bad-carrier clearing, payee cleaning; main-only atomic `deposited_at IS NULL` guard on `payee_line` | live bytes plus main's atomic S14 guard in the same UPDATE | owner decision item 3 kept the live behaviour; the atomic guard only tightens the lock |
| `tenant-email-domain-handlers.mjs` | live-only tenant `primary_color` / `logo_url` save path in `runSaveEmailBranding` | live bytes, verbatim | the branding save feature production serves; its `email-branding.mjs` imports exist on main |
| `admin-override-check-status.mjs` | diverged: live calls the SECURITY DEFINER RPC and refuses deposited checks (#601); main writes the rows directly with the SQL 89 column grants | main bytes plus the #601 refusal | SQL 89 was granted for main's direct writes; the deposited-check refusal is the live rule and is ported with a test |
| `write.mjs` | diverged: live routes `claims` writes through `write-app-metadata.mjs`; main adds the staging-only reject log | main bytes plus the live `claims` branch | both behaviours kept |
| `provider-flags.mjs` | live-only `moovTransferPostEnabled`, `isProductionChecksOpsRuntime`, doc comment | main bytes (unchanged) | locked to main's bytes (fee-collection decision 2026-10-17); no live or main module imports the live-only exports |
| `scheduled.mjs` | live routes `moov-monthly-tenant-billing` to `handleMonthlyBillingScheduled` | main bytes (unchanged) | main refuses that job on purpose (no unattended charge, `tenant-fee-collection.test.mjs`); the live handler answers `manual_billing_only` anyway |
| `allowed-tables.json` | main adds `check_partner_stakeholder_removals`, reorders two deposit views | main bytes (unchanged) | main is a superset |
| `index.mjs` | main adds the db-validator access gate, `/public/invoice`, two staging-only diagnostics | main bytes (unchanged) | main is a superset; every module it imports exists on main |
| `email.mjs`, `db-readonly-validate.mjs`, `partner-share-lifecycle.mjs`, `providers/readiness.mjs`, `package.json`, `package-lock.json` | live is an earlier main version | main bytes (unchanged) | main is newer; nothing to port |

## Contracts and locks touched

- `aws/tests/fixtures/production-lambda-reconciliation-2026-10-08.json` and
  `aws/tests/fixtures/production-reconciliation-deployment-manifest-2026-10-08.json`: `ocr.mjs`
  `repo_sha256` is now the live hash `ecd3b253…` (repository equals production; `overlay` stays
  `keep_live`).
- `ops/release-locks/locked-components.json`: protected tree hashes advance for `ocr-azure`
  (ocr.mjs, ocr-parse.mjs, check-ocr-provider.mjs), `tenant-email` (tenant-email-domain-handlers.mjs)
  and `database-rls` (write.mjs). Each is computed from the tree with `treeHashForFiles`.
  Classifications are unchanged.
- The production overlay plan is untouched: none of these files is a plan member, and
  `do_not_overlay` still lists `ocr.mjs` and `index.mjs`.

## Not done here

- No deploy, no SQL, no ZIP build. The full rebuilt ZIP is a separate guarded step that still
  needs its own tooling and owner approval; `AWS_MOOV_ONBOARDING_PRODUCTION_ENABLED` stays `false`
  until then.
- `public.ocr_persist_extracted_amount` is called by the live (now main) bytes inside a savepoint
  with an `rpc_unavailable` fallback; its definition is not in the repository.

## Full-package rebuild applied (2026-10-21)

The rebuilt ZIP shipped through the guarded rebuild path (#1096 tooling, #1097 and #1098 plan
sections), with the owner's exact words per environment:

| Environment | Run | CodeSha256 before → after | RevisionId after | State |
|---|---|---|---|---|
| staging (`checksops-staging-api`) | [39587414391](https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/39587414391), main `4d37692d6` | `nKVEeB8B…` → `sxodWyRp…` | `8503779d-4d63-4448-b8d5-9ad258cd7475` | VERIFIED |
| production (`checksops-production-prep-api`) | [39588578627](https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/39588578627), main `2168be9a1` | `ephceZY0…` → `sxodWyRp…` | `e7d6c9ec-d4f8-4f93-bdff-fb51c3284497` | VERIFIED |

Both environments now run the same package bytes (candidate ZIP `b31a1d5b2469…`), which is the
deterministic build of `aws/functions/api` on main plus `@aws-sdk/client-kms` 3.1124.0. The 13
files the overlay path never carried and the 9 main-only modules are now live in production.
`AWS_MOOV_ONBOARDING_PRODUCTION_ENABLED` is still `false`; turning it on is a separate guarded
configuration change. The `production-spa` release lock still records the pre-rebuild API revision
`719ea3ae…` as the API state at that SPA release; the read-only inspect reports
`revision_matches_release_lock: false` until the next SPA release records the new revision.
