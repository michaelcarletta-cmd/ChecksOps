# Invoice provider recovery — manual staging UAT

**STOP after this UAT report.** No production. No SQL/RLS/grant. No
environment change. No Collection V2 change. No Platform Finance change.
No restore of historical Lambda `3JRN7MxdyL3FZ0EJ3LzZdRn9SJdGlI/XUkDVJbg8AXc=`
(6485 members). No real payment credentials or real money.

## Verdict

Invoice Recovery **survived** the subsequent Collection V2 Settlement + TDZ
overlay. Sandbox-only Invoice API eligibility is proven from **current
deployed code and live flags**, with master production execution still
disabled.

The recovered provider-backed workflow

`Create Draft → Send → customer email → public invoice → hosted checkout → provider payment → Sync/Refresh → Paid`

was **not completed**. Invoice Recovery is **not** STAGING ACCEPTED for that
workflow.

Exact blocker: this run could authenticate a linked CheckOps admin only on
isolation/synthetic tenants that have **no sandbox Moov merchant**. The
Freedom CheckOps principals that historically own the sandbox merchant are
not reachable from the connected inbox, and `staging-master@checksops.invalid`
is `identity_not_linked`. Isolation Create Draft fail-closed before any
provider invoice, ACH, transfer, wallet, or sweep.

## 1 — Fresh current staging fingerprints

Fresh-read `2026-10-05T14:04:26Z` and re-confirmed `2026-10-05T14:10:18Z`.
ZIP origin: `fresh-live-download`. Historical Invoice Recovery-only
`3JRN…` / 6485 is **not** live and was **not** restored.

| Target | Fresh value |
|---|---|
| Lambda | `checksops-staging-api` |
| CodeSha256 | `0tBbR2mP6sIMiH6c4zCRUzrSgI10efAWV+zW9NgW0tw=` |
| RevisionId | `30690ed8-f9b6-4bb4-ad93-d5b39b49efbe` |
| LastModified | `2026-10-05T13:47:23.000+0000` |
| LastUpdateStatus | Successful |
| ZIP members | **6486** |
| SPA host | `https://staging.checksops.com` |
| SPA entry | `/assets/index-DR9wRQUG.js` |
| `index.html` SHA-256 | `2e71b6c40cdc6cb6c0fd9d3c0d00691cdbea201e748c2c9f9bc09088382c9337` |
| `index.html` last-modified | `2026-10-05T13:36:46Z` |
| `index.html` ETag | `2a2e7d470ac65b14318ff8a118ed22eb` |

Flags (unchanged; no env write):

| Flag | Value |
|---|---|
| `AWS_PROVIDER_EXECUTION_ENABLED` | `false` |
| `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED` | `true` |
| `AWS_MOOV_ENABLED` | `false` |
| `AWS_EMAIL_MODE` | `sink` |
| `AWS_PROVIDER_WEBHOOK_DRY_RUN` | `true` |
| `AWS_PROVIDER_LIVE_READS_ENABLED` | `false` |
| `CHECKSOPS_ENV` | `staging` |

SPA did **not** move from the Invoice Recovery entry. No SPA reconcile required.

## 2 — Invoice Recovery survived Collection V2

Owned Invoice Recovery member hashes still match the accepted apply exactly:

| Member | SHA-256 | Match |
|---|---|---|
| `invoice-provider.mjs` | `1b219a8a24ef8faf4b5db888dd6f772a9f04b3eb0ec2b869b76cd3b0b7d54e24` | yes |
| `invoice-actions.mjs` | `1786e2d84219379396311450532aa5963ff1ea52d4514c8d4766acc4c7f9c141` | yes |
| `providers/parity/moov-functions.mjs` | `a8e94a696a25ab0404f4763b21b53a2d7ffb1e21beedefb25da0e12646bd4a99` | yes |
| `providers/parity/db.mjs` | `f5947d9e19ca8bead3f5712b98c67f196eee3ab496afca028fd05fefbebe5f3e` | yes |

Collection V2 members present in the same 6486-member package:

| Member | SHA-256 |
|---|---|
| `tenant-collection-v2.mjs` | `dfa85b8806ad69d10465d7e143d44c5f4078c98e099f0eb3c956314ad9466a88` |
| `tenant-collection-v2-settlement.mjs` | `075d96d0826beb55a36261a799b80aa4898486b6322949b705017769151d7b40` |
| `tenant-collection-contract-v2.mjs` | `9ec5ae45db34c0795570f401cc2b1c3fa78f04764870bf6b651c21278433ed5d` |

Protected contract members left untouched by this UAT:

| Member | SHA-256 |
|---|---|
| `providers/parity/caller.mjs` | `1958eaa287ad2623d8cff9885c56cbb1948d069d2dd34093a56ac08e669c0470` |
| `sandbox-flags.mjs` | `28e98700e3875b2400440bf3e664e5b2197093c16ec5e01bc4ea34f1be29bcf7` |
| `provider-flags.mjs` | `29f5a7487fb6b911e6ca46780a3a991293efd19b1d1ee8b6199af8915196f622` |
| `public-invoice.mjs` | `e2d5ea84d231608775e34660051a5a5a6f119d331f4b3ae5fcd60e24fceff389` |

### Sandbox eligibility (before any provider action)

Live `requireParityEnabled` in `caller.mjs`:

- master `executionAllowed(provider)` **on** → `production_execution_blocked`
- sandbox flag **off** → `provider_disabled`
- otherwise sandbox credentials / `environment=sandbox`

Current flags are master **off** + sandbox **on**. Live
`moov-functions.mjs` is the recovered generic wrap (`fetchImpl = deps.fetchImpl || fetch`,
`moovParityContext`). Invoice therefore remains eligible for **sandbox HTTP
only**. Production execution was not enabled.

Contrast (same session, same flags): `POST /functions/v1/moov-account` and
`moov-account-status` return `provider_disabled` (`masterEnabled` false).
Invoice `preflight`/`create` do **not** take that path; they take the
sandbox `requireParityEnabled` contract and then fail closed on a missing
merchant (`Set up your payment account first.`, `liveProviderCalled: false`,
`environment: sandbox`).

`AWS_EMAIL_MODE=sink` was not changed. It sinks ChecksOps/SES mail. It does
**not** sink Cognito EMAIL_OTP (`no-reply@verificationemail.com`) and does
not, by itself, prove or disprove Moov customer invoice mail. A pre-existing
Moov sandbox message `Invoice INV-2 is overdue` from `noreply@moov.io` is
present in `claims@freedomadj.com` (historical, not this UAT).

## 3 — Test invoice identifiers

**None created.**

Attempted test-only draft (UI + API, isolation tenant):

| Field | Value |
|---|---|
| Tenant | `onboard-iso-59ff` / `db13cc17-547b-4ca8-806a-f3cf79eafe59` |
| Actor | `claims+onboard59ff@freedomadj.com` → app UUID `ca430f3f-9594-4d3f-bd51-8db4f0dd7f98` (admin, mapping `active`) |
| Customer name | `INVOICE RECOVERY UAT TEST ONLY` |
| Customer email | `claims+invoice-recovery-uat-20261005@freedomadj.com` |
| Amount | `$1.00` |
| Local invoice ID | **none** |
| `moov_invoice_id` | **none** |
| `payment_link_url` | **none** |
| `public_token` | **none** |

`GET/select moov_invoices` for that tenant after the attempt: **0 rows**.

## 4 — Create result

**FAIL-CLOSED. No persist. No provider invoice.**

- UI Save draft toast: `Invoice error — Set up your payment account first.`
- API `POST /functions/v1/moov-invoice` `action=create`: HTTP 409, same error,
  `environment=sandbox`, `liveProviderCalled=false`, `success=false`.
- `payment_provider_accounts` for the isolation tenant: **0 rows**.
- No ACH / transfer / wallet / sweep was created (create never reached Moov
  customer or invoice POST).

This is the recovered fail-closed missing-merchant contract, not the obsolete
5480 local persist path (`moov_account_id='local'`).

## 5 — Send / provider / email

**Not executed.** There is no persisted invoice to send.

| Question | Result |
|---|---|
| emailed | not claimed; send not run |
| liveProviderCalled | create returned `false`; send not run |
| provider status | none |
| sandbox Moov customer notification | not generated by this UAT |
| `AWS_EMAIL_MODE=sink` effect | unchanged; no ChecksOps invoice email was attempted |

UI copy on the New Invoice dialog still states the customer email is sent
only after the payment provider accepts the request. The recovered Send
contract (`PATCH unpaid` → `emailed:true` only after provider success) was
not live-exercised.

## 6 — Public invoice

No generated public token exists for this UAT.

Fail-closed checks on current SPA/API:

| Probe | Result |
|---|---|
| `https://staging.checksops.com/invoice/not-a-real-token` | `Invoice unavailable` / `Invoice not found` |
| `POST /public/invoice` missing token | 400 `Invoice token is required` |
| `POST /public/invoice` `token=not-a-uuid` | 404 `Invoice not found` |
| `POST /public/invoice` unknown UUID | 404 `Invoice not found` |
| `POST /public/invoice` `action=mark_paid` | 405 `public_invoice_read_only` |
| `POST /public/invoice` `action=send` | 405 `public_invoice_read_only` |
| `https://staging.checksops.com/public/invoice` | `Organization Not Found` (tenant route, not token page) |

Correct invoice/customer/amount, Branding, and Pay Now →
`payment_link_url` were **not** proven on a real token URL.

## 7 — Hosted checkout

**Not reached.** No `payment_link_url`. No Moov hosted checkout opened. No
bank/card data entered.

## 8 — Payment / Sync

**Not executed.** Exact blocker is the same missing-merchant / missing-invoice
blocker as Create. Provider GET paid-truth and local Paid-from-provider were
not live-proven.

## 9 — Resend / idempotency

**Not executed.** No existing provider invoice.

## 10 — Authenticated Payments regression

Authenticated session: isolation admin on `onboard-iso-59ff` via Cognito
EMAIL_OTP (plus-address delivered to the connected `claims@` mailbox).
Password login UI is absent. Financial rows were **not edited**.

| Surface | Result |
|---|---|
| Payment History | Loads. Search + Type filter (`All types`) + status filter present. Empty: `No payments found for the selected filters`. Settled $0 / recipients 0 / payments 0. |
| Revenue & Profit | Total Received $0, Total Paid $0, Net Profit $0 render. |
| By Recipient | Type buckets and Type filter render. Empty: no settled payments / no recipients. |
| Recipient overlays | `list_recipient_overlays` HTTP 200, `overlays=[]`. No overlay write. |
| Invoices tab | Empty. Banner: finish payment account setup. Footer note `otp-spotcheck-ok` shown in the create dialog (tenant data, not hidden). |

Freedom tenant (`2eff5f1a-929d-4ce3-9a8b-cd96b98df42a`) Payment History rows
and tenant recipient overlays were **not** opened. This run could not
establish a linked Freedom CheckOps session.

Login inventory (read-only; no identity remap, no `AdminSetUserPassword`):

| Principal | Cognito sub | `/identity/me` | Usable for Invoice UAT |
|---|---|---|---|
| `staging-master@checksops.invalid` | `54a8b4c8-60d1-7028-cfbb-0eb2baee5592` | `identity_not_linked` | no |
| `checksops-tester@freedomadj.com` | `04d85458-1041-7017-a8e8-b2f3f0a5b75b` | EMAIL_OTP started; inbox not readable here | not completed |
| `mcarletta@freedomadj.com` | `c4386408-60e1-70e2-abb6-e6194e8e635f` | EMAIL_OTP started; inbox not readable here | not completed |
| `claims@freedomadj.com` | `047824f8-b0b1-7018-c5e3-c0350a6c8a40` | mortgage_agent / wrong portal | no |
| `claims+onboard59ff@…` | `64d8d428-…` | admin / `onboard-iso-59ff` | linked, **no Moov merchant** |
| `claims+mde2e@…` | `94f8b498-…` | admin / `synthetic-mortgage-ops-billing` | linked, **no Moov merchant** |
| `claims+stagelock59ff…@…` | `44a814a8-…` | admin / `onboard-iso-59ff` | linked, **no Moov merchant** |

## 11 — Synthetic / test records created

| Record | Created? |
|---|---|
| `moov_invoices` row | no |
| `moov_invoice_customers` row | no |
| Moov sandbox customer / invoice | no |
| ACH / transfer / wallet / sweep | no |
| Identity / SQL / env / Collection V2 / SPA / Lambda | no |
| Cognito EMAIL_OTP messages to `claims@` plus-addresses | yes (login only) |

## 12 — Recommended cleanup

- Delete the Cognito `Your authentication code` messages sent to
  `claims@` / `claims+…` during this UAT.
- Do **not** remap `staging-master` or grant identity in this workstream.
- Do **not** onboard a new Moov merchant on isolation tenants to “make UAT
  work.”
- Next Invoice UAT needs a linked Freedom (or other merchant-backed sandbox)
  CheckOps session: complete EMAIL_OTP for `checksops-tester@` or
  `mcarletta@`, or a separately authorized identity repair for
  `staging-master` **only if** that mapping is intended.
- Reuse this current 6486-member Lambda + `/assets/index-DR9wRQUG.js` SPA.
  Do not restore `3JRN…`.

## 13 — STAGING ACCEPTED?

**No.** Invoice Recovery composition is still live and uncorrupted after
Collection V2, and sandbox eligibility is proven. The provider-backed
Create → Paid path is **not** staging-accepted until a merchant-backed
sandbox tenant completes Tests 1–6.

## STOP

No production deployment. No SQL/RLS/grant. No environment change. No
Collection V2 change. No Platform Finance change. No real money.
