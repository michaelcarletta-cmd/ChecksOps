# Payments accounting metadata — guarded staging apply

Guarded **staging-only** apply of accepted Class A `tenant-payment-accounting`.
STOP for manual Payments UAT. No production. No Moov. No money movement.
SQL 81 reviewed and **not applied**.

## Accepted source

| Field | Value |
|---|---|
| Branch | `cursor/payments-accounting-metadata-writes-4b16` |
| Commit | `ca4b04fda934e3310d19393bb63f49b0dc2255cb` |
| Tree | `04fbe3898494ff38e2519573532bbf0c65fcfe9e` |
| Apply workstream | `payments-accounting-metadata-staging-apply-4b16` |
| Operator | `cursor-cloud-agent` |

## 1 — Fresh-read (before apply)

Staging was unchanged from the Payments accuracy compose. Historical
`DxJGUt9C` / `/0Wyipd6…` were observed, not treated as restore authority.

| Target | Fingerprint |
|---|---|
| Staging SPA entry | `/assets/index-DxJGUt9C.js` |
| Staging `index.html` SHA-256 | `29a7fa5a6948ebf2e20136cfead50ae4c978d2ded986f2e98487b702446a1606` |
| Staging `index.html` ETag | `186a3d96ac532329cc0d46fb7c693460` |
| Staging `index.html` last modified | `2026-10-05T00:08:03+00:00` |
| Staging Lambda | `checksops-staging-api` |
| Staging Lambda CodeSha256 | `/0Wyipd63VyUCg97uzp4ppFHAnC9RLHeqBNOJCZZth8=` |
| Staging Lambda RevisionId | `a7ace3ea-006c-423e-a26d-87857c1e696a` |
| Staging Lambda last modified | `2026-10-04T20:34:40.000+0000` |
| `AWS_WRITES_ENABLED` | `true` |
| `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED` | `true` |
| `AWS_MOOV_ENABLED` | `false` |
| `AWS_PROVIDER_EXECUTION_ENABLED` | `false` |

Production (observe-only; not a target):

| Target | Fingerprint |
|---|---|
| Production SPA entry | `/assets/index-Bbftik1r.js` |
| Production `index.html` last modified | `2026-10-05T00:22:08+00:00` |
| Production Lambda | `checksops-production-prep-api` |
| Production Lambda CodeSha256 | `RUOC6wUAE9eCkhbhF8h8FAfUyegj9KCrvZt5vCojOlw=` |
| Production Lambda RevisionId | `48b8b0da-7448-435b-b9ea-d068a4497f1e` |
| Production Lambda last modified | `2026-10-05T00:15:53.000+0000` |

No competing workstream owned `payment-accounting.mjs` or the Payments
metadata SPA files. Live Lambda `app-services.mjs` was ahead of the
accepted branch (Homeowner endorse/document-sign + `mortgage-agent-compensation`).
Forward-reconciled from the fresh live ZIP. Did not overlay the thinner
branch `app-services.mjs`.

## 2 — SQL 81 inspection — NOT APPLIED

Prepared file:
`aws/payments/sql/unapplied-do-not-run/NOT_APPLIED_81_tenant_payment_recipient_overrides.sql`

| Check | Result |
|---|---|
| SHA-256 | `089dfd67a193cd57c0608e09a443332f5d76f6fa9d35e29e00bf24065fdcaf9e` |
| Table name in runner globs | **absent** (`aws/write-path/sql`, `aws/rls/sql`, `aws/financial/sql`, `supabase/migrations`) |
| Numbering collision | none — highest write-path is `44_claim_ledger_link_or_create`; rls `38`; financial `71` |
| Isolation | payer `tenant_id` PK + `REFERENCES tenants(id)` |
| Key constraint | `CHECK (aggregate_key ~ '^tenant:[0-9a-f-]{36}$')` |
| Display-only columns | `display_name`, `display_type` (enum), `updated_by`, timestamps |
| Read policy | `aws_can_access_tenant(tenant_id)` |
| Write policy | `aws_can_write_tenant(tenant_id)` |
| FORCE RLS | yes |
| Public access | `REVOKE ALL … FROM PUBLIC` |
| Runtime grants | `SELECT, INSERT, UPDATE` to `checksops`, `authenticated` |
| Existing financial tables / RLS | not altered |

Official executor `checksops-staging-guarded-sql-executor` allowlists only:

- `44_claim_ledger_link_or_create`
- `20261001231500_tenant_users_same_check_permissions`

SQL 81 is a `CREATE TABLE` and is **not** on that allowlist. Expanding the
executor would deploy/change the guard and is out of scope.

`tenant:` Save remains fail-closed `409 overlay_table_not_applied`.
`acct:` / `ext:` persist without this table (Jean Lindner UAT path).

No `sql-apply`. No executor invoke. No generic allowlist of
`disbursement_splits` or `stakeholder_accounts`.

## 3 — Lambda overlay

Official writer: `node scripts/deployment-guard/lambda-overlay-apply.mjs`
with signed receipt. Fresh live ZIP origin. RevisionId CAS against
`a7ace3ea-006c-423e-a26d-87857c1e696a`.

| Member | Op | SHA-256 |
|---|---|---|
| `payment-accounting.mjs` | **ADD** | `716aef9cb4d9b54ea91148e4c10d9ff86fb85a34261e3a674ee9aaa01eefcbaa` |
| `app-services.mjs` | **REPLACE** (live + register only) | before `a82cbbd9fee129d78400ec3f715f18441f964c08c9f6e55d283622e8d43362bf` → after `404d8fcd3427d07e26a1f2a3d3a49e202e0c6cf89da864a87517b83015bb1822` |

| Count | Value |
|---|---|
| Members before | 6481 |
| Members after | 6482 |
| Removed | none |

Preserved from live ZIP: `mortgage-agent-compensation.mjs`, Homeowner
endorse / document-sign routes, and every unrelated member.

`payment-accounting.mjs` contains no `moovFetch`, `moov-disburse`,
`createTransfer`, ACH, sweep, fee pull, invoice send, or payroll path.

## 4 — SPA forward-compose

Official writer: `node scripts/deployment-guard/staging-spa-upload.mjs`
(put-object per file; no `s3 sync` / delete). Built from accepted tree
`04fbe3898494ff38e2519573532bbf0c65fcfe9e` with `vite --mode aws`.

Accepted metadata overlay only:

- `src/lib/payments/paymentAccounting.ts` (new)
- `src/components/ledger/RecipientReport.tsx`
- `src/components/ledger/PaymentLedger.tsx`

No separate overlay-read module exists in the accepted source. `tenant:`
display remains an overlay write; it does not rename `tenants`.

Preserved composition base: Payments accuracy (`cf4a4a781`) on Platform
Finance / Branding / SR / MAC / Homeowner / Mortgage Desk / Claim Ledger /
WalletOps (`2193ea9c` / `361318c88` / `6597a462e`).

| Artifact | Value |
|---|---|
| Bucket | `checksops-staging-frontend-c48b` |
| Uploaded objects | 106 |
| CloudFront invalidation | `I56WU1CDW4ZI6JIHX7QZUHFP8F` |
| Candidate / live entry | `/assets/index-D7Zq697i.js` |
| Payments chunk | `/assets/Payments-DI03AGsE.js` |
| `production_untouched` | `true` |

Built Payments chunk contains `tenant-payment-accounting`,
`update_recipient_display`, `update_split_type`. Splits access is
`.select` only — no `disbursement_splits.update`. No `moovFetch` /
`createTransfer`. No `VITE_SUPABASE` embed in the index bundle.

## 5 — After (verify-live + re-read)

Confirming live read after apply still matches. Production unchanged.

| Target | Before | After |
|---|---|---|
| Staging SPA entry | `/assets/index-DxJGUt9C.js` | `/assets/index-D7Zq697i.js` |
| Staging `index.html` SHA-256 | `29a7fa5a6948ebf2e20136cfead50ae4c978d2ded986f2e98487b702446a1606` | `cc1f1bdbe1851273ef19075594b04df1cf17a07e5db7a0e351a21431f1c70160` |
| Staging `index.html` ETag | `186a3d96ac532329cc0d46fb7c693460` | `f3a660625aba04292153f0d884159d3a` |
| Staging `index.html` last modified | `2026-10-05T00:08:03+00:00` | `2026-10-05T00:50:28+00:00` |
| Staging Lambda CodeSha256 | `/0Wyipd63VyUCg97uzp4ppFHAnC9RLHeqBNOJCZZth8=` | `1eHQOkfWcbP31MB0hgMldpLSAmW/IMfTWpQONwcKjaw=` |
| Staging Lambda RevisionId | `a7ace3ea-006c-423e-a26d-87857c1e696a` | `c3690123-a961-49b2-9b6a-7194f72d2128` |
| Staging Lambda last modified | `2026-10-04T20:34:40` | `2026-10-05T00:48:02` |
| Production SPA | `/assets/index-Bbftik1r.js` | **unchanged** |
| Production Lambda CodeSha256 | `RUOC6wUAE9eCkhbhF8h8FAfUyegj9KCrvZt5vCojOlw=` | **unchanged** |
| Production Lambda RevisionId | `48b8b0da-7448-435b-b9ea-d068a4497f1e` | **unchanged** |

`VERIFY_OK` for this workstream. No reclaim. No restore.

## 6 — No money movement

| Path | Evidence |
|---|---|
| Moov / provider execution | staging flags `AWS_MOOV_ENABLED=false`, `AWS_PROVIDER_EXECUTION_ENABLED=false` unchanged |
| Handler money APIs | `payment-accounting.mjs` has no `moovFetch` / transfer / ACH / sweep / fee / invoice / payroll |
| SPA money APIs | Payments chunk has no `moovFetch` / `createTransfer` |
| SQL | no apply; no financial-table RLS change |
| Generic writes | `disbursement_splits` / `stakeholder_accounts` remain `table_not_allowlisted` / `financial_or_provider` |

## 7 — Regression

| Suite | Result |
|---|---|
| Payments accuracy + proposed settlement + metadata totals | 19/19 PASS |
| payment-accounting + Class A registry/contracts | 36/36 PASS |
| Generic `/data/write` financial deny (`api-write`) | 25/25 PASS |
| Tax containment | 33/33 PASS |
| Tenant isolation | 6/6 PASS |
| Deployment guard / release locks | 32/32 PASS |
| Wave1 review patches | 15/15 PASS |
| Claim Ledger accepted + discovery + SQL 44 | 4+9+2 (1 skipped, no fail) PASS |
| Signature Requests accepted | 5/5 PASS |
| e-sign SR invariants | 5/5 PASS |
| Parity signature submit | 5/5 PASS |
| Email branding SR | 3/3 PASS |
| Check image | 2/2 PASS |
| CheckAlt deposit preflight | 7/7 PASS |
| OCR Azure | 5/5 PASS |
| Moov file rules | 1/1 PASS |
| WalletOps | 15/15 PASS |
| AWS SPA bootstrap | 2/2 PASS |
| Signature stamp rasterize | 8/10 — 2 fail `pdftoppm failed` (env flake; logic tests passed) |
| ledger-safety-pg | FAIL — local PostgreSQL 16 not present (env, not this change) |

Generic financial-table writes remain denied. Explicit proof:
`generic /data/write against disbursement_splits remains denied` →
`table_not_allowlisted` / `financial_or_provider`.
`disbursement_splits` is not in `AWS_WRITE_TABLES` / `WRITE_ALLOWLIST`.

## 8 — STOP for manual UAT

Manual staging UAT is required. Do not treat this apply as product
acceptance.

UAT notes:

- `acct:` / `ext:` Recipient Edit Save should persist through Class A.
- Payment History type Select should persist through Class A.
- `tenant:` Save is expected `409 overlay_table_not_applied` until a later
  reviewed SQL 81 apply.
- Amount, Received/Paid/Profit, status, settlement, provider/Moov IDs,
  payer tenant, destination IDs, and bank fields must not change.
- Invoice Save/Send/Resend/Cancel/Delete/Sync, Payroll send, and tax-form
  generation remain outside this authorization.

**NO PRODUCTION.**
