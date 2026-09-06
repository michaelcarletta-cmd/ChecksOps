# Post-parity RDS overlay and final cutover readiness

**STOP FOR REVIEW.** This is an audit after PR **#135** and the targeted live `checksops` trigger overlay. It is **not** authorization to select T0 or cut over.

Leave **PR #125** open/unmerged.

**FINAL CUTOVER READINESS: PASS**

Prepared to select T0 only after the remaining human cutover decisions listed below. This agent did **not** select T0.

## Scope completed

1. Applied **only** `aws/write-path/sql/39_parity_payee_mirror_trigger_only.sql` to AWS production-target RDS `checksops`.
2. Re-ran targeted schema / trigger / RLS / stage-status reconciliation.
3. Verified a read-only historical check-image sample on AWS S3, then compared source hashes via the storage bridge.
4. Reconfirmed the full readiness matrix from current `main` after #135.

## Explicitly not done

- T0 / production write freeze
- DNS / auth switch
- Cognito user import
- Webhook redirect
- Moov / CheckAlt / Stripe enablement
- `64_financial_activation_grants.sql`
- Lovable/Supabase production writes
- Bridge teardown
- Recreate `checksops_rehearsal_20260906`
- Apply `38_parity_payee_mirror_and_returns.sql` to live `checksops` (columns + GRANTs)

## 1. Targeted production-RDS trigger parity

Pre-apply (live `checksops`):

| Gate | Result |
|---|---|
| Current function SHA-256 | `9d14a2de9291b8a74e4e659eb85fb41d30c42c497b5879b4da489b230b43079e` (1984 bytes) |
| `triggerHasRenameDelete` | **false** (upsert only; rename created a duplicate unsigned row) |
| Required `returned_*` / `return_*` columns | **all present** |
| `check_stage` includes `returned` | **true** |
| Proposed 39 SQL | function-only; matches 38 function body; no `ALTER TABLE` / `GRANT` / orphan-row `DELETE` |
| `apply_parity_ddl` on `checksops` | **refused** (`use an isolated rehearsal database`) |

Apply: oneshot `apply_trigger_parity` with `confirmChecksopsTriggerParity=true` and `ddlOnly=true`.

| After apply | Result |
|---|---|
| Function SHA-256 | `61e1018ab81ea7b4464a1176e4f0b0d0623b3587c6648f542b809f15d6c27f5e` (2407 bytes) |
| `triggerHasRenameDelete` | **true** |
| `preferred_auth_method` / `user_passkeys` | **absent** |
| Row counts | unchanged: intake **187**, payees **493**, endorsements **502** |
| Stage / status histograms | unchanged |

Transactional probe (`BEGIN` / `ROLLBACK`, leftover **0** / **0**):

- Before overlay: rename left `old_unsigned=1`, `new_unsigned=1`, `total=2` (duplicate).
- After overlay: rename left `old_unsigned=0`, `new_unsigned=1`, `total=1` (update in place).
- No customer rows committed.

## 2. Targeted DB reconciliation

| Check | Result |
|---|---|
| Schema parity for affected tables | **PASS** — required return columns present; no extra overlay DDL |
| Trigger / function parity | **PASS** — Sept 3 rename-delete body live |
| Tenant isolation / RLS | **PASS** — RLS enabled on intake, payees, endorsements, deposits, tenants, check_files |
| Check stages / statuses | **PASS** — histograms unchanged |
| Financial / provider execution | **PASS** — `aws_financial_%` EXECUTE grants **0**; Lambda flags **false** |
| Customer records changed | **NO** |

## 3. Historical check-image verification

Read-only sample of **8** older deposited/completed checks (eligible older set **15**; ages **86–96** days). IDs reported as SHA-256 only.

| Check | Result |
|---|---|
| AWS DB record present | **8 / 8** |
| Front image in AWS S3 | **8 / 8** |
| Rear image in AWS S3 | **8 / 8** |
| Associated stored documents | **1 / 1** extra `check_files` object present |
| Source SHA-256 vs AWS S3 | **16 / 16** front+rear compared, **16 matched**, **0 mismatched**, **0 missing at source** |
| App/storage refs | dest keys are `files/claim-files/{path}`; fingerprints matched source inventory names via `s3KeyFor` |

Live S3 `files/` prefix: **1,439** objects / **2,566,275,762** bytes. Lovable approved inventory still **1,411**. Final T0 storage delta is **still required** for any production objects created or changed after the rehearsal (and for this post-rehearsal S3 drift).

No customer images, paths, or bank data are in this report.

## 4. Final readiness audit

| Check | Result |
|---|---|
| LOVABLE → AWS APPLICATION PARITY | **PASS** |
| DATABASE PARITY | **PASS** |
| HISTORICAL STORAGE / CHECK IMAGE PARITY | **PASS** |
| Cognito / SES | Production pool `us-east-1_h00WorYMT`, **0 users**, MFA **OFF**; staging RP still `staging.checksops.com`; SES From still operator prep |
| Tenant isolation | **PASS** |
| Production / provider / financial flags | **OFF** (`AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED=true`, webhook dry-run **true** — allowed) |
| CheckAlt Architecture A | **unchanged** |
| Moov / CheckAlt execution | **OFF** |
| Both migration bridges | **up** — DB `read_only` / writes false; storage `sign_only` / deletes false |
| DNS | apex + `www` → `185.158.133.1` (Lovable) |
| Users imported | **NO** |
| Webhook ownership changed | **NO** |
| Financial grants applied | **NO** |
| Timed rehearsal | **valid** — `checksops_rehearsal_20260906` not recreated |
| PR #125 | **OPEN** (draft) |

Staging API `https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging` `/health` 200, `/db-health` `currentDatabase=checksops`. Prep API `/health` 200 `environment=production-prep`.

## Remaining before T0 can be selected

These are human cutover decisions / operator prep, not more agent overlay work:

1. Human authorization to select T0 and freeze Lovable writes.
2. Final DB + storage delta at T0 (bridges stay up until then).
3. ACM DNS validation still operator-owned (`PENDING_VALIDATION` unless already completed separately).
4. Production Cognito SES From (DEVELOPER / branded) is operator prep; MFA must stay OFF; do not import users until T0.
5. DNS / auth switch, webhook redirect, Moov / CheckAlt enablement, and `64_financial_activation_grants.sql` remain cutover-night decisions.
6. Leave PR #125 open until that review is done.

Do **not** treat this PASS as permission to cut over.
