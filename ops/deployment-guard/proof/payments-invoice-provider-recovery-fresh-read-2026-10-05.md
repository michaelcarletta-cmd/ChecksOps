# Invoice provider recovery — read-only staging pre-deploy inspect

**Inspected at:** `2026-10-05T13:13:39.677Z`  
**Source:** `208bfb68c` on `cursor/payments-invoice-provider-recovery-4b16`  
**Authorization:** validate only. No overlay, SQL apply, env change, Moov call, invoice, email, payment, or AWS mutation.

Official reads used:

- `createLiveAwsAdapter` with `writesAuthorized=false` (`getFunctionConfiguration`, `getFunction`, `downloadFunctionCode`, `headObject`, `getObject`)
- HTTPS GET `https://staging.checksops.com/index.html` and entry/chunks
- Official staging catalog route `GET /db-readonly-validate`

Adapter write calls: **0**. `authorizeWrites` was not called.

## 1. Live SQL 43-equivalent status

**Classification: NOT PROVABLE for the exact named policy + `WITH CHECK`; INSERT-only command coverage is PRESENT.**

Official catalog route does not return policy names or `WITH CHECK` text. `readSqlDefinition` on the live adapter refuses (VPC executor only). The guarded SQL executor is authorized only for SQL 44 / tenant-users helpers, not `payment_event_log`. Direct DB/VPC catalog hashing is not available from this environment.

`GET /db-readonly-validate` `rlsAudit.matrix` (live):

| Table | RLS | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|---|
| `payment_event_log` | enabled | true | true | false | false |
| `moov_invoices` | enabled | true | true | true | true |
| `moov_invoice_customers` | enabled | true | true | true | true |

So an INSERT-only command exists for `payment_event_log` (not `FOR ALL`). Policy name `aws_write_payment_event_log` and `WITH CHECK (aws_can_write_tenant(tenant_id))` are **not visible**. Historical source hash `4bd59028566b504e041dbfa311eee8fb77dd998cc6660047c7ca2c27cdd89aff` is **not** a live proof.

**Do not apply SQL 43** from this workstream. SAVEPOINT remains the defense if `WITH CHECK` later denies the insert.

## 2. Fresh staging fingerprints

Staging has **not moved** from the last invoice-actions apply after-state. These are a new live read, not reused memory.

| Target | Fresh value |
|---|---|
| SPA entry | `/assets/index-DPuBbzLV.js` |
| `index.html` SHA-256 | `b57b498cf9169e5dbfa56d2705cde620422c636beb72cb1ccd6885888b99a638` |
| `index.html` ETag | `446d14aaa8c7844f94b5305a66bf6a05` |
| `index.html` last-modified | `2026-10-05T02:29:43Z` |
| Entry SHA-256 | `ea1a458de97e06bf853d6cf22c97202afb566bf585fc05fba4bb8b08013b50d1` |
| Payments chunk | `/assets/Payments-CX-jbDT3.js` `fbd21e11a9d1a14f8713b4b06d67d2816a3b03bbb9f7117a68d99a2b2aecc467` |
| Public invoice chunk | `/assets/PublicInvoicePage-CfxxGejx.js` `6c1e606fc4c781a1a024ced88577742092fd110aed9b5262b78638b74279f7b1` |
| Lambda | `checksops-staging-api` |
| CodeSha256 | `IZW76Y5q5hFtmGAlR5iokrV8slQisiHEb74ATKjlpJk=` |
| RevisionId | `a95596bf-20b2-47c0-8026-be2340d8ac5d` |
| LastModified | `2026-10-05T02:27:51.000+0000` |
| LastUpdateStatus | Successful |
| ZIP members | **6484** |
| ZIP origin | `fresh-live-download` |
| `AWS_PROVIDER_EXECUTION_ENABLED` | `false` |
| `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED` | `true` |
| `AWS_MOOV_ENABLED` | `false` |
| `AWS_WRITES_ENABLED` | `true` |
| `AWS_PROVIDER_WEBHOOK_DRY_RUN` | `true` |
| `AWS_PROVIDER_LIVE_READS_ENABLED` | `false` |
| `CHECKSOPS_ENV` | `staging` |
| `AWS_EMAIL_MODE` | `sink` |

## 3. Exact minimal member overlay

Live vs `208bfb68c` for proposed invoice members:

| Member | Live SHA-256 | Source SHA-256 | Overlay |
|---|---|---|---|
| `invoice-provider.mjs` | absent | `1b219a8a24ef8faf4b5db888dd6f772a9f04b3eb0ec2b869b76cd3b0b7d54e24` | **ADD** |
| `invoice-actions.mjs` | `a60b363510b6cb681db9f45a410d885d5816edc5b3af6818f0aeab85279d066c` | `1786e2d84219379396311450532aa5963ff1ea52d4514c8d4766acc4c7f9c141` | **REPLACE** — live is 5480 local persist |
| `providers/parity/moov-functions.mjs` | `497681a3510d938cbd977a1a7ce487b03b81fbe734a212b127a64cbbd2e83f87` | `a8e94a696a25ab0404f4763b21b53a2d7ffb1e21beedefb25da0e12646bd4a99` | **REPLACE** — live wrap forces `fetchImpl: null` and `liveProviderCalled: false` |
| `providers/parity/db.mjs` | `db24ae19e5cfff9cc418da99c4f0a81a7426385c450ecfee1ecc41b9f9148e3b` | `f5947d9e19ca8bead3f5712b98c67f196eee3ab496afca028fd05fefbebe5f3e` | **REPLACE** — only `logPaymentEvent` SAVEPOINT; remainder identical |
| `providers/parity/moov-onboard.mjs` | `1ada0ff1b45df89a7c21e331d8c9dcc2d5e8d3fab0433a591e728739bd24d9c9` | `3dfb105c366366d11206d12141d78ebbf01644481bdc13ca35a2a955ddabf393` | **DO NOT REPLACE** |

### Why each replacement is necessary

- `invoice-provider.mjs`: new INV3/INV6 runner. Absent live.
- `invoice-actions.mjs`: live still has `LOCAL_MERCHANT` / null provider ids. Must be replaced so create/send persist provider identity.
- `moov-functions.mjs`: live special-case wrap is the 5480 dry-run. Removing it is the only way invoice uses `moovParityContext` + real `fetchImpl`. Diff is that wrap only (40 lines). Other handlers unchanged.
- `db.mjs`: live `logPaymentEvent` is try/catch without SAVEPOINT. Overlay is isolated to that function. Needed while SQL 43 `WITH CHECK` is unproven. No other live `db.mjs` drift.

### Why `moov-onboard.mjs` is dropped from the overlay

Live `invoice.run` already delegates to `runInvoiceAction`. After `invoice-actions.mjs` is replaced, that stub calls the provider runner. Restored wrap supplies `withMoovContext` / `fetchImpl` even though live `invoice.run` does not pass `fetchImpl`. The source onboard change is only a direct import plus test re-exports. Replacing this shared file is **not** required.

Do not overlay `index.mjs`, `write-allowlist.mjs`, `public-invoice.mjs`, `payment-accounting.mjs`, `caller.mjs`, `provider-flags.mjs`, `sandbox-flags.mjs`, money/wallet/sweep, branding, SR, Homeowner, Mortgage, OCR.

### SPA collision check (fresh live chunks vs recovered source)

Live Payments chunk `/assets/Payments-CX-jbDT3.js` still contains the accepted work this recovery must keep: `list_recipient_overlays`, `update_recipient_display`, `update_split_type`, `get_tenant_funds_received`, `acct:` / `ext:` / `tenant:`, `Payment History`, `Received`, `Profit`, `invoice_footer_note`, `public_token`, `Issue invoice`. Live does **not** yet contain `Send invoice` / `Resend invoice` (expected until a later SPA apply).

Live public chunk `/assets/PublicInvoicePage-CfxxGejx.js` still has token-page `Issued on`, `Pay now`, and `invoice_footer_note`. Live public-token lookup stays in `public-invoice.mjs` (`e2d5ea84…`, identical to `208bfb68c`).

Recovered source does **not** restore a historical SPA. A later apply must run a fresh `vite --mode aws` from the current composition. Source still has `src/lib/payments/paymentAccounting.ts` overlay/type writers and `get_tenant_funds_received` reads. Invoice UI only adds Send/Resend and claims email only when `emailed === true && liveProviderCalled === true`. Public page remains token-only/read-only; it may show `Sent on` when `sent_at` exists. Branding footer is still `tenants.invoice_footer_note` (correct via Settings, not a tenant-row mutation here).

## 4. Protected-member comparison (keep live)

| Member | Live SHA-256 | vs 208bfb68c |
|---|---|---|
| `payment-accounting.mjs` | `d596598ed9a064f67838f23c26389a101522389d73316964f22b8e9b53d7b2cb` | identical |
| `write-allowlist.mjs` | `3541377290b62013f0c82608fe35bf8b24c0fe827046358e55d8d5ad6c0e76b5` | identical |
| `public-invoice.mjs` | `e2d5ea84d231608775e34660051a5a5a6f119d331f4b3ae5fcd60e24fceff389` | identical |
| `providers/parity/platform-finance.mjs` | `a807950467f15d603dbf181c10464961cc52e5d5f96588f83fbd89f0feacc306` | identical |
| `sandbox-flags.mjs` | `28e98700e3875b2400440bf3e664e5b2197093c16ec5e01bc4ea34f1be29bcf7` | identical |
| `index.mjs` | `8c2f9d459ed4f5fdd78255c018707a961855b8738e706bbc6903c2b823315117` | keep live |
| `esign.mjs` | `7c60b6462f7e0caa21800481a68735a44fc38bde19d74f78c64bc5ca97956b74` | keep live |
| `write-signature.mjs` | `dee6b7d507d25853cc95a3de104c0c2b60bd0a87595c0976beb7fa23bc52db26` | keep live |
| `homeowner.mjs` | `e770bbca94c31096443a96b03aed6a0e36e780ef79b17e1e73423647ede3e302` | keep live |
| `email-branding.mjs` | `8b23eb8893377bad1c11d9a02522c789d222053b084d4ba53107eae7d374bb4b` | keep live |
| `providers/parity/moov-money.mjs` | `1cd405caec4982369c6a858efec8168b3f98cff8fb881fe888c3994217e93726` | keep live |
| `providers/parity/moov-wallet.mjs` | `4f6f548960cfdadd524402d953cfa903594a672448a561cc4f223d2fe56f4144` | keep live |
| `providers/parity/sweep-read.mjs` | `4da8e0c0e1b3bb6c78248cde67738f953044b065dde75cfc4885d6fac2bae02f` | keep live |
| `ocr.mjs` | `ecd3b253c111921ee62f21bab214bd346ab19819a9c764cdef33b07524c6221f` | keep live |
| `app-services.mjs` | `404d8fcd3427d07e26a1f2a3d3a49e202e0c6cf89da864a87517b83015bb1822` | local source differs; **do not overlay** |
| `financial.mjs` | `3fcb5f3731b9ec64c49da211ec659e7bceeb5062f0c128f0f647c14bc9c77ebd` | local source differs; **do not overlay** |
| `provider-flags.mjs` | `29f5a7487fb6b911e6ca46780a3a991293efd19b1d1ee8b6199af8915196f622` | local source differs; **do not overlay** |

## 5. Provider-sandbox safety

Live `caller.mjs` `requireParityEnabled('moov')`:

- `AWS_PROVIDER_EXECUTION_ENABLED=true` → `production_execution_blocked`
- sandbox flag false → `provider_disabled`
- otherwise sandbox credentials only (`effectiveMoovEnvironment` stays `sandbox` while master is off)

Restoring the generic wrap makes **invoice** use that existing contract. It does not turn on master flags and does not add transfer/ACH/wallet/sweep members.

`invoice-provider.mjs` only uses Moov `/accounts` and `/accounts/{merchant}/invoices` (GET/POST/PATCH/DELETE invoice). No `/transfers`, wallet, sweep-config, or ACH create.

Keep env unchanged:

- `AWS_PROVIDER_EXECUTION_ENABLED=false`
- `AWS_MOOV_ENABLED=false`
- `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED=true` (already live)

## 6. Tests

Source recovery tests already passed **61/61** (`invoice-actions`, INV3, INV6, payment-accounting-metadata). No apply this turn. No Moov/email/payment.

## 7. Guarded staging apply sequence (not executed)

Evaluate-only until a later reviewed apply workstream is authorized.

1. Re-fresh-read immediately before write. Stop on `DEPLOYMENT_COLLISION` if CodeSha256/RevisionId/`index.html` moved.
2. `preflight.mjs --acquire-lease --receipt` for workstream `payments-invoice-provider-recovery-4b16`, commit `208bfb68c`, component `checksops-staging-api`.
3. `lambda-overlay-apply.mjs --apply` from `fresh-live-download` only. Owned ops:
   - add: `invoice-provider.mjs`
   - replace: `invoice-actions.mjs`, `providers/parity/moov-functions.mjs`, `providers/parity/db.mjs`
4. Fresh `vite --mode aws` from current composition (not a historical SPA). Upload via `staging-spa-upload.mjs` (put-object, no sync-delete).
5. `verify-live.mjs` for lambda-overlay and spa-promote.
6. Do **not** apply SQL 43. Do **not** change Lambda env. Do **not** touch production.

## 8. Expected post-apply fingerprints

Deterministic member hashes after overlay (Lambda CodeSha256 is **not** deterministic until the live ZIP is rebuilt):

| Member | After |
|---|---|
| `invoice-provider.mjs` | `1b219a8a24ef8faf4b5db888dd6f772a9f04b3eb0ec2b869b76cd3b0b7d54e24` (added) |
| `invoice-actions.mjs` | `1786e2d84219379396311450532aa5963ff1ea52d4514c8d4766acc4c7f9c141` |
| `providers/parity/moov-functions.mjs` | `a8e94a696a25ab0404f4763b21b53a2d7ffb1e21beedefb25da0e12646bd4a99` |
| `providers/parity/db.mjs` | `f5947d9e19ca8bead3f5712b98c67f196eee3ab496afca028fd05fefbebe5f3e` |
| `providers/parity/moov-onboard.mjs` | unchanged `1ada0ff1b45df89a7c21e331d8c9dcc2d5e8d3fab0433a591e728739bd24d9c9` |
| `payment-accounting.mjs` | unchanged `d596598e…` |
| `public-invoice.mjs` | unchanged `e2d5ea84…` |
| Member count | **6485** (6484 + 1 add, 0 deletes) |
| Lambda CodeSha256 / RevisionId | unknown until apply |
| SPA entry / `index.html` SHA | unknown until fresh Vite build |

**STOP.** No write performed.
