# Invoice actions — guarded staging apply

Guarded **staging-only** apply of the reviewed Invoice actions candidate.
**STOP for manual Invoice UAT.** No production. No SQL. No Moov. No money movement.
No real invoice email.

## Authorized candidate

| Field | Value |
|---|---|
| Source branch | `cursor/payments-invoice-actions-4b16` |
| Base invoice correction | `d01cbfeb1b2b72a709ad6fc9d15e04e4c604cc57` |
| Reviewed follow-up | `5480d8ce334edf378016d1d9e093f928924785b4` |
| Apply workstream | `payments-invoice-actions-4b16` |
| Apply proof branch | `cursor/payments-invoice-actions-staging-apply-4b16` |
| Apply commit | `ecfaaf03767f4f8410311680fdfef9f4853fe466` |
| Operator | `cursor-cloud-agent` |
| Target | staging SPA + `checksops-staging-api` only |

Official writers:

- `node scripts/deployment-guard/preflight.mjs --acquire-lease --receipt`
- `CHECKSOPS_DEPLOYMENT_GUARD_APPLY=1 node scripts/deployment-guard/lambda-overlay-apply.mjs --apply`
- `node scripts/deployment-guard/staging-spa-upload.mjs`
- `node scripts/deployment-guard/verify-live.mjs`

Inherited env (`CHECKSOPS_WORKSTREAM_ID=payments-accounting-metadata-staging-apply-4b16`,
`CHECKSOPS_COMMIT=ca4b04fda…`, leftover overlay-read receipts) was **unset**.
Receipts were issued for this workstream/commit only. Hand-written receipts were not used.

## 1 — Fresh-read (before apply)

Read at `2026-10-05T02:17:17Z` and re-confirmed immediately before mutation
`2026-10-05T02:27:03Z` / `2026-10-05T02:27:20Z` (Lambda) and
`2026-10-05T02:28:19Z` (SPA). Staging had **not** moved from the last accepted
overlay-read composition. Those fingerprints were **observations, not restore authority**.

| Target | Fingerprint |
|---|---|
| Staging SPA entry | `/assets/index-ffqZq1Rc.js` |
| Staging `index.html` SHA-256 | `238a1232ae3f9b8c528ee72b78aa1d70d4a1321476bcf651995d8c538f73e060` |
| Staging `index.html` ETag | `ea6bf5e94f6e8c4aab68e4e85531a916` |
| Staging `index.html` last modified | `2026-10-05T01:29:11.000Z` |
| Staging Lambda | `checksops-staging-api` |
| Staging Lambda CodeSha256 | `JxM/0GaJ8kpGgwp/M5BscS3In2EBAUdhGJGQBS+/D/Q=` |
| Staging Lambda RevisionId | `a403d0da-e67e-42f6-adaf-5df639964ee3` |
| Staging Lambda last modified | `2026-10-05T01:27:12.000+0000` |
| Live ZIP members | 6482 |
| `AWS_WRITES_ENABLED` | `true` |
| `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED` | `true` |
| `AWS_MOOV_ENABLED` | `false` |
| `AWS_PROVIDER_EXECUTION_ENABLED` | `false` |
| `AWS_PROVIDER_WEBHOOK_DRY_RUN` | `true` |
| `CHECKSOPS_ENV` | `staging` |

Production (observe-only; **not a target**):

| Target | Fingerprint |
|---|---|
| Production SPA entry | `/assets/index-Bbftik1r.js` |
| Production `index.html` SHA-256 | `ac1dc285c0af1a6046d484bde94aff9b4e4238f52df5b4d24f5c8a9e3252820e` |
| Production `index.html` last modified | `2026-10-05T00:22:08.000Z` |
| Production Lambda | `checksops-production-prep-api` |
| Production Lambda CodeSha256 | `RUOC6wUAE9eCkhbhF8h8FAfUyegj9KCrvZt5vCojOlw=` |
| Production Lambda RevisionId | `48b8b0da-7448-435b-b9ea-d068a4497f1e` |

`origin/main` was fresh-read before compose. Invoice source members were
forward-composed onto the **current live** ZIP. `ffqZq1Rc` and its Lambda were
**not** restored wholesale.

## 2 — SQL / Moov / money — NOT TOUCHED

| Check | Result |
|---|---|
| `sql-apply` / `sql-executor-invoke` | **not invoked** |
| SQL 81 file | `aws/payments/sql/unapplied-do-not-run/NOT_APPLIED_81_tenant_payment_recipient_overrides.sql` unchanged |
| Leftover `staging::staging-sql` receipt | prior workstream; not consumed here |
| Moov HTTP / ACH / wallet / transfer / sweep / fee | not initiated |
| Real invoice email | not sent (`AWS_EMAIL_MODE=sink`; Issue sets `emailed: false`) |
| Fabricated paid / settlement | Issue and Sync do not mark paid |

Flags after apply are identical to fresh-read.

## 3 — Lambda overlay

Official writer: `scripts/deployment-guard/lambda-overlay-apply.mjs`
with a signed receipt. Fresh live ZIP origin. RevisionId CAS against
`a403d0da-e67e-42f6-adaf-5df639964ee3`.

Package origin: `fresh-live-download` at apply time. No saved ZIP restore.

| Member | Op | SHA-256 |
|---|---|---|
| `index.mjs` | **REPLACE** | before `24f13aa5ff4f3d72e7f5ff4dc45dd194796aa4e75958de5bc39c8c1dce3eb4da` → after `8c2f9d459ed4f5fdd78255c018707a961855b8738e706bbc6903c2b823315117` |
| `write-allowlist.mjs` | **REPLACE** | before `0fdc95bd7be8137d87f581ba3468d04c9581edf20933fec39dc4872076d4fea0` → after `3541377290b62013f0c82608fe35bf8b24c0fe827046358e55d8d5ad6c0e76b5` |
| `providers/parity/moov-functions.mjs` | **REPLACE** | before `2dff151e470aabf74f905d4f6af51c9ac7dd1d13696eeffa585ca43cf00302ee` → after `497681a3510d938cbd977a1a7ce487b03b81fbe734a212b127a64cbbd2e83f87` |
| `providers/parity/moov-onboard.mjs` | **REPLACE** | before `86127db01e4918ed72e8ca3ed56a378a53a000a9c046dde986aa2afc525f2f89` → after `1ada0ff1b45df89a7c21e331d8c9dcc2d5e8d3fab0433a591e728739bd24d9c9` |
| `invoice-actions.mjs` | **ADD** | `a60b363510b6cb681db9f45a410d885d5816edc5b3af6818f0aeab85279d066c` |
| `public-invoice.mjs` | **ADD** | `e2d5ea84d231608775e34660051a5a5a6f119d331f4b3ae5fcd60e24fceff389` |
| `payment-accounting.mjs` | preserved | `d596598ed9a064f67838f23c26389a101522389d73316964f22b8e9b53d7b2cb` |
| `app-services.mjs` | preserved | `404d8fcd3427d07e26a1f2a3d3a49e202e0c6cf89da864a87517b83015bb1822` |
| `allowed-tables.json` | preserved | `a1772c723bc07fbc0d02bda2fd02a4915b1a41944ca2f7b368602117634868cb` |
| `providers/parity/platform-finance.mjs` | preserved | live member kept; copied locally only so compose tests can import it |
| `storage.mjs` | preserved | live member kept |

| Count | Value |
|---|---|
| Members before | 6482 |
| Members after | 6484 |
| Added | `invoice-actions.mjs`, `public-invoice.mjs` |
| Removed | none |
| Replaced | 4 owned members |
| Official post-overlay preserved | 6478 |

Compose notes (source-only, already on this apply branch):

- Live `index.mjs` already had branding-logo. Forward-composed `/public/invoice` POST plus a guarded optional `storageApi.handleBrandingLogo` bind so live ZIP keeps branding and local tests still load.
- Live `write-allowlist.mjs` already listed `moov_invoices` / `moov_invoice_customers` in `FINANCIAL_OR_PROVIDER_TABLES`; compose kept that denial.
- Live `moov-functions.mjs` already wrapped Platform Finance + branding. Forward-composed public-invoice (no Cognito) and moov-invoice (no Moov HTTP).
- Live `moov-onboard.mjs` still had the old Moov HTTP invoice.create path; replaced with reviewed `runInvoiceAction` / `loadPublicInvoiceByToken`.

`payment-accounting.mjs` was **not** overlaid (accepted overlay-read member).
Generic `/data/query` still does not expose `tenant_payment_recipient_overrides`.

Apply result CodeSha256 `IZW76Y5q5hFtmGAlR5iokrV8slQisiHEb74ATKjlpJk=`.
Writer-reported RevisionId `6693ba5c-6767-4ec6-a8c0-94c5f67a6fe1` (`LastUpdateStatus=InProgress`);
subsequent observe-only `get-function-configuration` settled to
`a95596bf-20b2-47c0-8026-be2340d8ac5d` with the **same** CodeSha256 and
`LastModified` `2026-10-05T02:27:51.000+0000`. Treated as Lambda settle,
not a second overlay. Configuration / env flags unchanged.

Official apply-time `verify-live.mjs` (`kind=lambda-overlay`): **ok**.
CAS matched `JxM/0GaJ8…` / `a403d0da-e67e-42f6-adaf-5df639964ee3`.

Receipt consumed: `.deployment-guard/consumed-receipts/82253adfcf685f095c8c575462b6bf411e0ae08905bab4fb6aa4c51e669aa05f.json`.

## 4 — SPA forward-compose

Official writer: `scripts/deployment-guard/staging-spa-upload.mjs`
(put-object per file; no `s3 sync` / delete). Fresh `vite --mode aws` build
from the composed invoice source with local `.env` hidden so no Supabase embed.

Authorized Invoice UI only, on top of the accepted overlay-read Payments
composition:

- `src/pages/payments/InvoicesTab.tsx` — Issue invoice; Resend hidden
- `src/hooks/useMoovInvoices.ts` — Issue toasts do not claim email
- `src/pages/PublicInvoicePage.tsx` — token page; Issued-on copy

Preserved Payments work in the same composed SPA: `acct:` / `ext:` editing,
`tenant:` overlay display, Payment History Type, Received/Paid/Profit.

| Artifact | Value |
|---|---|
| Bucket | `checksops-staging-frontend-c48b` |
| Uploaded objects | 106 |
| CloudFront invalidation | `IF2IGSYGYB3GD5CHO2U9KZ610J` |
| Candidate / live entry | `/assets/index-DPuBbzLV.js` |
| Payments chunk | `/assets/Payments-CX-jbDT3.js` |
| Public invoice chunk | `/assets/PublicInvoicePage-CfxxGejx.js` |
| After `index.html` SHA-256 | `b57b498cf9169e5dbfa56d2705cde620422c636beb72cb1ccd6885888b99a638` |
| After ETag | `446d14aaa8c7844f94b5305a66bf6a05` |
| After last modified | `2026-10-05T02:29:43.000Z` |
| `production_untouched` | `true` |

Built Payments chunk contains `Issue invoice`, `list_recipient_overlays`,
`update_recipient_display`. It does **not** contain `Resend invoice`,
`Send invoice`, `moovFetch`, `createTransfer`, or `VITE_SUPABASE`.
Public chunk contains `Issued on`.

Official apply-time `verify-live.mjs` (`kind=spa-promote`): **ok**.
TOCTOU matched `238a1232ae3f9b8c…` / `/assets/index-ffqZq1Rc.js`.

## 5 — After (observe-only re-read `2026-10-05T02:29:52Z`)

Live matches the applied composition. Production unchanged.

| Target | Before | After |
|---|---|---|
| Staging SPA entry | `/assets/index-ffqZq1Rc.js` | `/assets/index-DPuBbzLV.js` |
| Staging `index.html` SHA-256 | `238a1232ae3f9b8c528ee72b78aa1d70d4a1321476bcf651995d8c538f73e060` | `b57b498cf9169e5dbfa56d2705cde620422c636beb72cb1ccd6885888b99a638` |
| Staging `index.html` ETag | `ea6bf5e94f6e8c4aab68e4e85531a916` | `446d14aaa8c7844f94b5305a66bf6a05` |
| Staging `index.html` last modified | `2026-10-05T01:29:11+00:00` | `2026-10-05T02:29:43+00:00` |
| Staging Lambda CodeSha256 | `JxM/0GaJ8kpGgwp/M5BscS3In2EBAUdhGJGQBS+/D/Q=` | `IZW76Y5q5hFtmGAlR5iokrV8slQisiHEb74ATKjlpJk=` |
| Staging Lambda RevisionId | `a403d0da-e67e-42f6-adaf-5df639964ee3` | `a95596bf-20b2-47c0-8026-be2340d8ac5d` |
| Staging Lambda last modified | `2026-10-05T01:27:12` | `2026-10-05T02:27:51` |
| Production SPA | `/assets/index-Bbftik1r.js` | **unchanged** |
| Production Lambda CodeSha256 | `RUOC6wUAE9eCkhbhF8h8FAfUyegj9KCrvZt5vCojOlw=` | **unchanged** |
| Production Lambda RevisionId | `48b8b0da-7448-435b-b9ea-d068a4497f1e` | **unchanged** |

No reclaim. No restore.

## 6 — State / public-invoice contracts applied

Reviewed `5480d8ce3` behavior is what staging now runs:

- Draft → Unpaid through **Issue invoice** (`emailed: false`; not paid)
- Unpaid → Canceled
- Draft / Canceled → Delete
- Paid protected
- Issue does not mark paid, claim email, start provider payment, or change Received/Paid/Profit
- Refresh/Sync does not manufacture settlement
- `/public/invoice` is POST read-only; exact UUID-v4 token only; fail closed
- No lookup by invoice / tenant / customer / claim / check identifiers
- Minimum public fields; no tenant IDs, provider metadata, bank/routing/wallet/transfer/internal accounting
- Deleted token → 404; canceled → canceled presentation; paid historical → paid presentation

Resend remains hidden in the SPA.

## 7 — Regression

| Suite | Result |
|---|---|
| Invoice actions (`aws/tests/invoice-actions.test.mjs` plus compose write/isolation/metadata) | **106/106 PASS** |
| Payments accuracy (`tests/tenant-payment-accuracy.test.ts`) | **22/22 PASS** |
| Compose suite after live-forward (invoice + overlay-read + write-deny) | **68/68 PASS** |
| Extra accepted contracts (CheckAlt, Claim Ledger, SR pins, tenant isolation) | **24/24 PASS** |
| Protected cross-feature (review save, claim-ledger, check images, SPA bootstrap, CheckAlt, SR, OCR) | **40/40 PASS** |
| WalletOps layout | **15/15 PASS** |
| Moov file rules | **21/21 PASS** |
| Official `npm run test:deployment-guard` | **210 pass / 1 skip / 1 fail** — fail is `sql-executor-auth.test.mjs` fixture omitting accepted `signature-requests` from `contract_results`; not this overlay. Official preflight used `passingContractResults()` for the full registry and succeeded. |
| Release-lock hardening / SPA baseline / origin-main validate | **4 pre-existing fails** — `components.database-rls` tree hash drift (`22152a19…` recorded vs `1452258d…` actual). **No SQL/RLS files changed** on this apply branch vs `5480d8ce3`. Not introduced by invoice compose. |

## 8 — STOP

**Manual Invoice UAT is required before any further staging or production work.**

UAT checklist:

1. Payments → Invoices → New invoice → Save Draft → row remains Draft after refresh.
2. Issue invoice (dialog and draft-row Issue) → status Unpaid; not Paid; no emailed claim; Received/Paid/Profit unchanged.
3. Copy Payment Link + Open public invoice page → `/invoice/{uuid}` loads; malformed/unknown token fails closed.
4. Cancel unpaid → Canceled presentation on public page.
5. Delete Draft and Delete Canceled succeed; Delete Paid is refused.
6. Refresh/Sync does not mark paid.
7. Resend is not shown.
8. Payments recipient overlay (`acct:` / `ext:` / `tenant:`) and Payment History Type still edit; SQL 81 behavior unchanged.

Production is **not authorized**.
