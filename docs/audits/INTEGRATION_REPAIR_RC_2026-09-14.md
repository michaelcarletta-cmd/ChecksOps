# Integration repair release candidate — 2026-09-14

**Workstream:** sole ChecksOps Integration & Release  
**This turn:** consolidate undeployed Integration repairs onto the live Integration lineage  
**Deploy / merge / SQL apply / staging mutation:** NO  
**C1C / Cognito:** untouched  
**Functional Audit testing:** not re-run

Branch: `cursor/integration-repair-rc-ec26`  
Base live source: `320685542f070ba23ed8970d870f3eded590fd9a`  
Live Lambda pin: `OSiyHTQqSq5J3QRZCKdDrQ7PRW5qPWeJS71LZ46LIOE=`  
Live SPA: `index-a512Q1W0.js` / `index-67D8chGr.css`

This RC is a **true superset** of live Integration behavior (GET txn + SQL 72/73 + mortgage-library / notifications / cash jobs / portal upload) plus the surgical repairs below. It does **not** overlay historical Phase 2 trees.

---

## Incorporated from PR #304

- A7-024: `sign_dtp` calls `aws_public_homeowner_claim_sign_dtp` (SQL 42). Fail closed unless RPC returns `signed === true` and `dtp_signed_at`. SPA refuses success toast unless follow-up GET shows `lead.dtp_signed_at`.
- P8: unknown/missing endorsement token → `invalid_link`. GET of a still-present row with status `signed|rejected|waived|expired` remains `token_consumed`.
- SQL 72 GET read-only transaction from `320685542` is unchanged.
- SQL 73 payee persist + JS skip of the second public payee UPDATE remain.

Residual: SQL 72 returns NULL for both never-valid and rotated consumed tokens. P8 therefore maps both to `invalid_link`. GET of a still-present row with status `signed|rejected|waived|expired` remains `token_consumed`. Distinguishing rotated vs never-valid still needs token history (deferred). Not blocking this RC.

## Incorporated from PR #309

- `executeClaimSettlements` insert/update, no delete, no `claim_id` retarget
- Negative money rejected; client `created_by` ignored
- Tenant membership via `claims.org_id` **or** a linked `check_intake_items.tenant_id`
- SPA `AWS_WRITE_TABLES` includes `claim_settlements`
- SQL 40 Git artifact (GRANT file). **Not applied this turn.**

Current `write-app-metadata.mjs` mortgage-library, notifications, and cash-jobs executors are preserved. Settlement writes were added beside them, not by overlaying a Phase 2 copy of the file.

## P9 / P11 / PR #286

- **P9:** `canViewPlatformSettings = isAdmin || isPlatformOwner`. CheckAlt settings view/load uses that gate. `isAdmin` is unchanged for tenant-destructive actions. CheckAlt Test/Register/Poll still go through the AWS provider path and stay fail-closed while execution is off.
- **P11:** surgical className/placeholder edits on current `CheckCommandCenter.tsx` only. No Phase 2 file overlay.
- **#286:** insert-only `executeClaims` with server-assigned `org_id`. Spoofed org denied. No UPDATE/DELETE. No historical NULL `org_id` backfill. SQL 41 Git artifacts included; treated as already applied. `claims` added to SPA AWS write allowlist so `ClaimLedgerCard` create can reach the API. Oneshot inspect/repair helpers from #286 are **not** included.

## Portal 501 actions — deferred (own tranche)

`sign_document`, `submit_mortgage_intake`, and `complete_action` still return `501 action_not_ported`.

They are **not** in this RC. Porting them requires new public DEFINER writes (action-item files, e-sign document rows, mortgage intake including optional SSN last-4). That is a separate portal-porting tranche, not a surgical merge of existing undeployed repairs. Current portal `get` / `upload_check` / `sign_dtp` behavior is preserved.

---

## SQL files and staging status

| SQL | Git in this RC | Staging this turn | Future deploy |
|---|---|---|---|
| 29, 39, 52, 69, 71, 72, 73 | yes | applied (validated baseline) | verify only |
| 41 | yes | treat as **already applied** | verify; do not backfill `claims.org_id`; do not run SQL 23 |
| 42 | yes | treat as **already applied** | verify; do not re-apply if present |
| 40 | yes | **Git-only / unverified GRANT** | read-only `column_privileges` on `claim_settlements`; apply **only if** `checksops` lacks INSERT/UPDATE |
| 30 | source exists on coherent lineage | **KEEP UNAPPLIED** | do not run |
| 23 | not in this RC | do not run | do not run |

No SQL was applied in this turn.

---

## Proposed later deploy order (do not execute)

1. Read-only catalog: SQL 41/42 present; SQL 72/73 fingerprints still `445994fc…` / `d388bb4e…`; SQL 30 absent.
2. Read-only GRANT check for `claim_settlements`. Apply SQL 40 **only if missing**.
3. Deploy Lambda from this RC Git-built zip (`git archive` + `npm ci --omit=dev`). Guard on current CodeSha256 `OSiyHTQq…`.
4. Deploy SPA from this RC (`vite --mode aws`). Current live `index-a512Q1W0.js` / `index-67D8chGr.css` are superseded only after this SPA lands.
5. Keep `AWS_EMAIL_MODE=ses-identity`, lock recipient, provider execution false, CheckAlt/Moov disabled.
6. Do not touch C1C, Cognito, production, or production-prep.
7. Functional Audit may then retest A7-024, A8-035, A5-203.

---

## Tests (this turn)

`npm run test:aws-api`: **798 pass / 0 fail / 0 skipped**.  
`npx tsc -b`: **EXIT 0**.

No Functional Audit retest. No staging mutation.

Nothing was merged, deployed, or applied. Shared-staging freeze for non-Integration workstreams remains. C1C identity is unchanged.
