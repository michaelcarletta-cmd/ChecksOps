# Invoice provider recovery — guarded staging apply

Guarded **staging-only** apply of the reviewed Invoice Recovery composition
(`208bfb68c` members; apply proof commit on this branch).
**STOP after post-apply verification.** No production. No SQL. No env change.
No invoice create/send, email, payment, or Moov UAT.

## Authorized candidate

| Field | Value |
|---|---|
| Source recovery | `208bfb68c` |
| Apply workstream | `payments-invoice-provider-recovery-4b16` |
| Apply proof branch | `cursor/payments-invoice-provider-recovery-staging-apply-4b16` |
| Apply identity commit | `8f59757b0acf9ed1f34bb76ec16e5a0d309d82c5` |
| Operator | `cursor-cloud-agent` |
| Target | staging SPA + `checksops-staging-api` only |

Official writers:

- `node scripts/deployment-guard/preflight.mjs --acquire-lease --receipt`
- `CHECKSOPS_DEPLOYMENT_GUARD_APPLY=1 node scripts/deployment-guard/lambda-overlay-apply.mjs --apply --receipt <signed>`
- `node scripts/deployment-guard/staging-spa-upload.mjs`
- `node scripts/deployment-guard/verify-live.mjs`

Inherited leftover receipts/leases from `payments-invoice-actions-4b16` and
`payments-accounting-sql81-staging-apply-4b16` were expired and **not consumed**.
New signed receipts were issued for this workstream/commit only. Hand-written
receipts were not used. `CHECKSOPS_DEPLOYMENT_GUARD_APPLY=1` was not treated as
a bypass; the Lambda writer required the signed receipt path.

## 1 — Pre-write gate (fresh-read immediately before write)

Fresh-read at `2026-10-05T13:32:51Z` and re-confirmed immediately before
mutation `2026-10-05T13:33:31Z` (Lambda) and `2026-10-05T13:35:24Z` (SPA).
Staging had **not moved** from the reviewed baseline. Those fingerprints were
observations, not restore authority.

| Target | Fresh value |
|---|---|
| SPA entry | `/assets/index-DPuBbzLV.js` |
| `index.html` SHA-256 | `b57b498cf9169e5dbfa56d2705cde620422c636beb72cb1ccd6885888b99a638` |
| `index.html` ETag | `446d14aaa8c7844f94b5305a66bf6a05` |
| `index.html` last-modified | `2026-10-05T02:29:43Z` |
| Lambda | `checksops-staging-api` |
| CodeSha256 | `IZW76Y5q5hFtmGAlR5iokrV8slQisiHEb74ATKjlpJk=` |
| RevisionId | `a95596bf-20b2-47c0-8026-be2340d8ac5d` |
| LastModified | `2026-10-05T02:27:51.000+0000` |
| ZIP members | **6484** (`fresh-live-download`) |

Owned live-member fingerprints (reviewed baseline, still matched):

| Member | Live SHA-256 |
|---|---|
| `invoice-provider.mjs` | **absent** |
| `invoice-actions.mjs` | `a60b363510b6cb681db9f45a410d885d5816edc5b3af6818f0aeab85279d066c` |
| `providers/parity/moov-functions.mjs` | `497681a3510d938cbd977a1a7ce487b03b81fbe734a212b127a64cbbd2e83f87` |
| `providers/parity/db.mjs` | `db24ae19e5cfff9cc418da99c4f0a81a7426385c450ecfee1ecc41b9f9148e3b` |

No `DEPLOYMENT_COLLISION`. No reclaim.

## 2 — SQL / env / Moov / money — NOT TOUCHED

| Check | Result |
|---|---|
| `sql-apply` / `sql-executor-invoke` | **not invoked** |
| SQL 43 | **not applied** |
| Leftover `staging::staging-sql` receipt | prior workstream; not consumed |
| Lambda configuration / env | unchanged (writer CAS on configuration fingerprint) |
| Moov HTTP / ACH / wallet / transfer / sweep | not initiated |
| Invoice create / send / email / payment | not initiated |

Flags after apply are identical to pre-write.

## 3 — Lambda overlay

Official writer: `scripts/deployment-guard/lambda-overlay-apply.mjs`
with signed receipt MAC `3b3d0b56f725f74117982eca70c199bba16a9711e457dc8183357a569b79fe42`.
Package origin: `fresh-live-download` at apply time. RevisionId CAS against
`a95596bf-20b2-47c0-8026-be2340d8ac5d`. No saved ZIP restore.

| Member | Op | After SHA-256 |
|---|---|---|
| `invoice-provider.mjs` | **ADD** | `1b219a8a24ef8faf4b5db888dd6f772a9f04b3eb0ec2b869b76cd3b0b7d54e24` |
| `invoice-actions.mjs` | **REPLACE** | `1786e2d84219379396311450532aa5963ff1ea52d4514c8d4766acc4c7f9c141` |
| `providers/parity/moov-functions.mjs` | **REPLACE** | `a8e94a696a25ab0404f4763b21b53a2d7ffb1e21beedefb25da0e12646bd4a99` |
| `providers/parity/db.mjs` | **REPLACE** | `f5947d9e19ca8bead3f5712b98c67f196eee3ab496afca028fd05fefbebe5f3e` |
| `providers/parity/moov-onboard.mjs` | **not replaced** | live `1ada0ff1b45df89a7c21e331d8c9dcc2d5e8d3fab0433a591e728739bd24d9c9` |

| Count | Value |
|---|---|
| Members before | 6484 |
| Members after | **6485** |
| Added | `invoice-provider.mjs` |
| Removed | none |
| Replaced | 3 owned members |
| Official post-overlay preserved | 6481 |

Writer-reported CodeSha256 `3JRN7MxdyL3FZ0EJ3LzZdRn9SJdGlI/XUkDVJbg8AXc=`
with RevisionId `0928584a-7093-4681-a683-5bf82e6931a6` (`LastUpdateStatus=InProgress`);
subsequent observe-only `get-function-configuration` settled to
`06f2f26c-dae0-44b1-9a85-3b6b5e7afb67` with the **same** CodeSha256 and
`LastModified` `2026-10-05T13:34:03.000+0000`. Treated as Lambda settle,
not a second overlay.

Receipt consumed: `.deployment-guard/consumed-receipts/3b3d0b56f725f74117982eca70c199bba16a9711e457dc8183357a569b79fe42.json`.

Official apply-time `verify-live.mjs` (`kind=lambda-overlay`): **ok**.
CAS matched `IZW76Y5q5hFtmGAlR5iokrV8slQisiHEb74ATKjlpJk=` /
`a95596bf-20b2-47c0-8026-be2340d8ac5d`.

## 4 — SPA forward-compose

Official writer: `scripts/deployment-guard/staging-spa-upload.mjs`
(put-object per file; no `s3 sync` / delete). Fresh `vite --mode aws` from
current composition plus Invoice Recovery UI only. Local `.env` was hidden
during the build so Supabase identifiers were not embedded.

| Artifact | Value |
|---|---|
| Bucket | `checksops-staging-frontend-c48b` |
| Uploaded objects | 106 |
| CloudFront invalidation | `I31C046KE39MLIOE5VT33JMQLZ` |
| Candidate / live entry | `/assets/index-DR9wRQUG.js` |
| Payments chunk | `/assets/Payments-CLII7bum.js` `b3a595096595de4ac43bd231b8e7a59519d084f6de73e31e407715f6c0646009` |
| Public invoice chunk | `/assets/PublicInvoicePage-C88zuuBX.js` `0c42a73a502133a15ebde577233995962d42d1dd842533db813bea0a49b41719` |
| After `index.html` SHA-256 | `2e71b6c40cdc6cb6c0fd9d3c0d00691cdbea201e748c2c9f9bc09088382c9337` |
| After ETag | `2a2e7d470ac65b14318ff8a118ed22eb` |
| After last modified | `2026-10-05T13:36:46Z` |
| `production_untouched` | `true` |

Built Payments chunk contains `Send invoice`, `Resend invoice`,
`list_recipient_overlays`, `update_recipient_display`, `update_split_type`,
`get_tenant_funds_received`, `acct:` / `ext:` / `tenant:`, `Payment History`,
`Received`, `Profit`, `invoice_footer_note`, `public_token`. It does **not**
contain `moovFetch`, `createTransfer`, or `VITE_SUPABASE`.
Public chunk contains `Issued on`, `Pay now`, `invoice_footer_note`.

Official apply-time `verify-live.mjs` (`kind=spa-promote`): **ok**.
TOCTOU matched `b57b498cf9169e5dbfa56d2705cde620422c636beb72cb1ccd6885888b99a638`
/ `/assets/index-DPuBbzLV.js`.

## 5 — After (observe-only re-read)

Live matches the applied composition. Production unchanged.

| Target | Before | After |
|---|---|---|
| Staging SPA entry | `/assets/index-DPuBbzLV.js` | `/assets/index-DR9wRQUG.js` |
| Staging `index.html` SHA-256 | `b57b498cf9169e5dbfa56d2705cde620422c636beb72cb1ccd6885888b99a638` | `2e71b6c40cdc6cb6c0fd9d3c0d00691cdbea201e748c2c9f9bc09088382c9337` |
| Staging `index.html` ETag | `446d14aaa8c7844f94b5305a66bf6a05` | `2a2e7d470ac65b14318ff8a118ed22eb` |
| Staging Lambda CodeSha256 | `IZW76Y5q5hFtmGAlR5iokrV8slQisiHEb74ATKjlpJk=` | `3JRN7MxdyL3FZ0EJ3LzZdRn9SJdGlI/XUkDVJbg8AXc=` |
| Staging Lambda RevisionId | `a95596bf-20b2-47c0-8026-be2340d8ac5d` | `06f2f26c-dae0-44b1-9a85-3b6b5e7afb67` |
| Staging Lambda last modified | `2026-10-05T02:27:51` | `2026-10-05T13:34:03` |
| Staging ZIP members | 6484 | **6485** |
| Production SPA | `/assets/index-Bbftik1r.js` last-modified `2026-10-05T00:22:08Z` | **unchanged** |
| Production Lambda CodeSha256 | `RUOC6wUAE9eCkhbhF8h8FAfUyegj9KCrvZt5vCojOlw=` | **unchanged** |
| Production Lambda RevisionId | `48b8b0da-7448-435b-b9ea-d068a4497f1e` | **unchanged** |

Protected members remain byte-for-byte unchanged, including
`payment-accounting.mjs`, `public-invoice.mjs`, `write-allowlist.mjs`,
`index.mjs`, `app-services.mjs`, `financial.mjs`, `provider-flags.mjs`,
`sandbox-flags.mjs`, `moov-onboard.mjs`, Branding, Signature/Homeowner,
Mortgage, Platform Finance, money/wallet/sweep, OCR.

Environment flags unchanged:

- `AWS_PROVIDER_EXECUTION_ENABLED=false`
- `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED=true`
- `AWS_MOOV_ENABLED=false`
- `AWS_PROVIDER_WEBHOOK_DRY_RUN=true`
- `AWS_PROVIDER_LIVE_READS_ENABLED=false`
- `AWS_EMAIL_MODE=sink`

## 6 — Smoke / regression

| Suite | Result |
|---|---|
| Invoice recovery (`invoice-actions`, INV3, INV6, payment-accounting-metadata) | **61/61 PASS** |
| Payments accuracy (`tests/tenant-payment-accuracy.test.ts`) | **22/22 PASS** |
| Official `verify-live` lambda-overlay | **ok** |
| Official `verify-live` spa-promote | **ok** |

Read/navigation smoke (no login, no invoice, no Moov):

- Staging landing loads.
- `/payments` without a tenant/session is fail-closed (`Organization Not Found`); authenticated Payments UI was not exercised.
- Live Payments chunk still contains recipient overlay / type / Received-Paid-Profit / SQL81-facing writers.
- `/invoice/{unknown-uuid}` shows `Invoice unavailable` / `Invoice not found`.
- `POST /public/invoice` with a malformed token or unknown UUID returns 404 `Invoice not found`, `liveProviderCalled: false`, `productionExecution: false`.

## 7 — STOP

**Manual Invoice UAT is not authorized by this apply.** Do not create, send,
email, pay, or call Moov until a separate UAT authorization exists.

Production is **not authorized**.
