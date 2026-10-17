# Production promotion preparation: #762 / #772

**Status: BLOCKED — preparation only. No production changes are authorized or
performed by this report.**

## Source and accepted baseline

- Fresh `origin/main`: `e753524baa3641d872697c5bc505f5053ce0717b`.
- Task head: `9386ff920f9e16485b76d3cba83deb5150f7499b` (parent is
  `origin/main`). The two trees are identical.
- Current accepted `production-spa` lock: PR #739, source
  `61432c236c26ecd56d2edc9103a4edc7ac426dbe`, entry
  `/assets/index-CBOwj-7W.js`, SHA-256
  `0b5fa51e11660cc9db224801b14edb3d80e662f0781ddce98d462448f66f3635`,
  CloudFront `E1B0ZWWO5559U5`.
- The accepted lock has `lambda_code_hash: null` and
  `database_evidence_record: null`. PR #762/#772 remain
  `unverified_no_accepted_production_code_hash`. The issue's reported live
  Lambda CodeSha256 is `DMcCoF3dpIiULPe530F8DJ8vC1wL1BP7ayqr+e8SCyI=`, but it
  is not an accepted candidate/package pin.

The pinned read-only production inspector was attempted and refused its
precondition (`status: refused`, exit 2), so this work did not obtain a fresh
live-state comparison. No production AWS writes, provider calls, database
connections, payment/ACH actions, or financial operations were made.

## Current-main surfaces inspected

| Surface | Current-main implementation and evidence |
| --- | --- |
| Claim Ledger and #772 gate | `aws/functions/api/workflow-rpc.mjs` dispatches `claim_ledger_link_or_create` and gates application-workflow RPCs through `AWS_APPLICATION_WORKFLOW_WRITES_ENABLED` in `workflow-flags.mjs`. Its SQL source is `aws/write-path/sql/44_claim_ledger_link_or_create.sql`. The gate is separate from `AWS_WRITES_ENABLED`; do not change the live flag. |
| #762 settlement RPC | `aws/functions/api/claim-settlement-rpc.mjs` calls `save_claim_settlement_breakdown`; `aws/workflows/sql/53_claim_settlement_breakdown.sql` defines the narrow RPC. Production status is not established by source markers or workflow flags. |
| Review → Endorsing | `src/lib/reviewDecisionMapping.ts` maps `endorsements_in_progress` to `check_stage: endorsing` and `deposit_recommendation: endorsements_pending`. SQL 43 preserves `claim_id` and rejects deposited/terminal checks; regression coverage is in `aws/tests/review-save-detected-claim-number-sql.test.mjs` and `aws/tests/endorsement-aws-parity.test.mjs`. |
| OCR/MICR | `aws/functions/api/check-ocr-provider.mjs` merges Azure-verified MICR with OCR; `aws/functions/api/ocr.mjs` persists routing/account only when the respective MICR state is `VERIFIED`. `aws/workflows/sql/52_verified_ocr_micr_column_grant.sql` grants only those column updates. `ocr-descriptive-persist.mjs` explicitly does not write MICR. |
| Frontend composition | `src/pages/CheckCommandCenter.tsx` mounts `ClaimLedgerCard`; the component uses the existing claim-link guard in `src/lib/checkClaimLinkGuard.ts`. In AWS mode, `src/integrations/supabase/client.ts` selects the Cognito/AWS adapter, whose RPC transport posts to `/data/rpc` in `src/integrations/aws/client.ts`. The built candidate was inspected for Supabase endpoint/config values and contains none. No source was copied from a stale branch or old build. |

## Candidate fingerprints

The SPA was built twice from the current-main tree using `npm run build:aws`,
AWS/Cognito mode, `https://checksops.com`, and same-origin `/prep` configuration.
Both builds produced the same result. The canonical tree fingerprint is SHA-256
over sorted `SHA256  relative/path\n` records for all 107 files under `dist/`.

| Candidate artifact | Identity | SHA-256 |
| --- | --- | --- |
| SPA entry bundle | `/assets/index-D4eeHiAq.js` | `05d324817c0a2011d3eaebcdd08a088c7f87da4b1fe8ddb23879645f642e751f` |
| SPA stylesheet | `/assets/index-DIDBao2l.css` | `655bd08edfa9f156f9457c554d43f56d4cacc73aca6675aae71fd2eafc7df2e3` |
| `index.html` | current-main AWS build | `a146e973de34616d35ec88f4d97dc124331df1b7e640837345f22717c64552d4` |
| Complete SPA build tree | 107 files, canonical method above | `c88eb62549569792aab35d47e39be79b50841c960f665efab075b954868bcfe3` |

This is a reproducible current-main build, **not** the locked live artifact. Its
entry bundle hash differs from the accepted PR #739 bundle hash. Promoting it
would require an explicit guarded forward supersession against freshly verified
live state; it is not a rollback or a pre-authorized upload.

No final Lambda ZIP/composed-package fingerprint was produced. The repository
and issue evidence provide a CodeSha256, not the current production ZIP/member
bytes. The read-only inspector allows `lambda:GetFunctionConfiguration`, not
`lambda:GetFunction`/code download. Building a standalone ZIP would fail to
prove preservation/reconciliation of unrelated live members and would not be
the exact forward-composed production candidate. Relevant current source
fingerprints (source files only, **not** a ZIP or accepted production hash):

| Source member | SHA-256 |
| --- | --- |
| `aws/functions/api/claim-settlement-rpc.mjs` | `4d0b312cadaeffb7bff2d96eea9c4815a1f23815c9c9dcbdbceea4e4d3203d64` |
| `aws/functions/api/workflow-flags.mjs` | `a5c05d84ca847dc09c8f35e143a033f9af881e5f4491cf278810bb45857f1892` |
| `aws/functions/api/workflow-rpc.mjs` | `112c6a784e850559d01fc7474e0f54847a3ae5f7819dd76b65b48a3688bcc4a7` |
| `aws/functions/api/check-ocr-provider.mjs` | `b119d48ab660d2ace130e7700cd32f65e6e2cadeb8667994e20628281ae1926f` |
| `aws/functions/api/ocr.mjs` | `2e69e2eace4c555036606565c35f4e76d3169ab5a36110269389f7387979cac8` |

## SQL candidates and persistence-target blocker

These are source candidates for the described behaviors; this list does not
assert that every function is absent from the live database or authorize an
apply. Their target and live definitions must be proven before any SQL action.

| SQL source | Purpose | Source SHA-256 |
| --- | --- | --- |
| `aws/write-path/sql/41_ocr_detected_claim_number.sql` | OCR claim-number discovery/persistence helpers | `6716c370698b575bbca40fa095774a2f8c4ef517fc044dd5dcea17c0d1b2c2e1` |
| `aws/write-path/sql/43_review_save_detected_claim_number.sql` | Review save while preserving claim links and deposited locks | `0844238c8ebcda1e7bccaa94b3c8d633c3d17e44dd150986d153e073d2dd3208` |
| `aws/write-path/sql/44_claim_ledger_link_or_create.sql` | Narrow tenant-scoped Claim Ledger RPC | `059f10e936f27439b9fddae7030b76fe594d6538087de389ab07950fefdf8763` |
| `aws/workflows/sql/52_verified_ocr_micr_column_grant.sql` | Verified MICR routing/account column grant | `7bc17fac816724ce7f1231b205686c6ac4cf5ef877a566ad7e66081e92750273` |
| `aws/workflows/sql/53_claim_settlement_breakdown.sql` | Claim settlement breakdown RPC | `5a8f8bc35c69f2b339c78f3637d6bb1c606117967e3ab9d83b5dec1d37561197` |

**Fail-closed blocker:** current accepted AWS production infrastructure/config/
deployment metadata does not identify an authoritative production database
target. The read-only inspector reports
`refused_unproven_aws_production_target`; the production release lock has no
database evidence record; and the production API metadata does not prove a
database attachment/connection. `aws/template.yaml` is staging-only. A staging
secret, historical docs, or Supabase metadata cannot establish the production
target and were not used. Required provenance is an accepted, current AWS
resource/config/deployment record binding the production API to the exact
production persistence resource, plus a fresh guarded catalog/definition
comparison for that same resource. Until then, **no SQL candidate has a
provable apply target**.

The existing post-deployment provenance mechanism is sufficient: the
`production-spa` lock has a `lambda_code_hash` field and the read-only inspector
reports the live hash against that accepted pin. Do not fill the currently null
pin from the issue's unaccepted live hash. After an explicitly authorized and
verified deployment, append/update accepted provenance from independent
read-only evidence without weakening either guard.

## Minimal conditional promotion plan and writes

1. Obtain accepted AWS production persistence-target provenance and resolve the
   inspector's precondition; refresh the exact live SPA, Lambda CodeSha256 /
   RevisionId, API integration, and production flag evidence.
2. Obtain the current production Lambda package/member snapshot through an
   authorized guarded process. Reconcile same-file ownership and compose only
   the reviewed current-main members; preserve all unrelated members and live
   configuration. Run staging acceptance for this exact composition.
3. Against that proven database only, compare the required SQL definitions and
   hashes. Apply only missing reviewed definitions through the official SQL
   guard, if separately authorized. Do not infer a database target or reapply
   matching SQL.
4. Use the official Lambda overlay writer for a single
   `UpdateFunctionCode` with immediately fresh `CodeSha256` and `RevisionId`
   compare-and-swap. Do not change Lambda configuration or provider/financial
   flags.
5. Use the official production SPA writer to upload only the candidate's
   content-addressed objects and `index.html`, then invalidate the pinned
   CloudFront distribution. Require explicit production approval and the
   forward-composition/lease/receipt gates; never restore a stale bundle.
6. Verify the exact post-deploy artifacts read-only, then record accepted Lambda
   CodeSha256 and SPA provenance. Stop on any drift or source-composition
   collision.

These are conditional future operations only. **None is performed or
authorized here.** At present the required future production writes cannot be
fully enumerated for SQL because the target is unproven. Do not invoke providers,
payments, ACH, or financial operations, and do not change any live provider or
financial flags.

## Validation performed

- `node scripts/validate-release-locks.mjs` — passed.
- `node --test ops/release-locks/tests/*.test.mjs` — 65 passed.
- `node scripts/production-deploy-guard.mjs` — passed, evaluate-only.
- `node scripts/deployment-guard/scan-bypass.mjs` — passed; 17 registered
  writer findings.
- `npm run test:deployment-guard` — 243 passed, 1 skipped.
- `npm run test:aws-api` — 1,609 passed, 4 skipped.
- Focused promotion regressions — 64 passed.
- `npm run check:publish-keys` and AWS migration/financial-safety static guards
  — passed.
- AWS SPA production bootstrap test passed; candidate contains no baked
  Supabase endpoint or `VITE_SUPABASE_*` configuration.
- Root `npm ci` reported 57 dependency advisories (4 low, 15 moderate, 35 high,
  3 critical); no dependency files were changed. The AWS API lockfile install
  reported zero vulnerabilities.

No production deployment, Lambda update, SPA upload, CloudFront invalidation,
SQL execution, provider call, payment, ACH, or financial execution was
performed.
