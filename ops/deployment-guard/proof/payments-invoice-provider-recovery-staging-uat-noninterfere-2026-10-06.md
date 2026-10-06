# Invoice Recovery staging UAT — non-interference resume

**STOP.** Staging UAT only. No deployment. No restore. No identity remap.
No Security Hardening interference. Tests 1–6 were **not** executed.
Invoice Recovery is **not** STAGING ACCEPTED.

## Authority

This run owns Invoice Recovery staging UAT only. Current live state is
authoritative. Historical Lambda ZIPs, commits, branches, fingerprints, and
previous Cursor reports are evidence only and were not used as restore
authority.

## 1 — Fresh origin/main

Fetched `2026-10-06T15:12Z`.

| Field | Value |
|---|---|
| `origin/main` | `8ed7cb1dcd00f41b0cc4d1fb036c5e628573e5cb` |
| Committed | `2026-10-06 11:07:07 -0400` |
| Subject | Merge pull request #722 from `security/sh2-forward-compose-artifact` |
| Previous local `origin/main` | `c1e4f537838f550ca5599f47c5fb69321d952dcf` (SH-2 CORS allowlist) |

Main moved through Security Hardening and Branding merges since the last
Invoice Recovery inspect. Latest #722 is CI-only (reviewed compose artifact)
and claims no AWS/Lambda/SQL/production mutation. Main movement alone was
not treated as rollback authority.

## 2 — Fresh staging SPA fingerprint

| Field | Current | Previous (2026-10-05T15:03Z, historical) |
|---|---|---|
| Entry | `/assets/index-Dq1xEBa5.js` | `/assets/index-DR9wRQUG.js` |
| `index.html` SHA-256 | `ea92cb1ae60bc1411b190ccfbfa51fb9af0f41f61f7a1cfca317821c2f2843b6` | `2e71b6c40cdc6cb6c0fd9d3c0d00691cdbea201e748c2c9f9bc09088382c9337` |
| Last-Modified | `2026-10-06T01:15:47Z` | `2026-10-05T13:36:46Z` |
| ETag | `a88f4f5e081ef33131fb647f378cff2a` | `2a2e7d470ac65b14318ff8a118ed22eb` |
| Payments chunk | `/assets/Payments-BdJrY1Om.js` (`6f96a4c1…`) | `/assets/Payments-CX-jbDT3.js` |
| Public invoice chunk | `/assets/PublicInvoicePage-BeIxGtT-.js` (`7ddfb3df…`) | `/assets/PublicInvoicePage-CfxxGejx.js` |

Current Payments/public chunks still contain Invoice Recovery UI:
`Send invoice`, `Resend invoice`, `Save draft`, `public_token`,
`Payment History`, `Pay now`, `Sent on`, `invoice_footer_note`. Prior
`DR9wRQUG` assets still exist as immutable leftovers and were **not**
restored or promoted.

## 3 — Fresh Lambda

| Field | Current | Previous (2026-10-05T15:03Z, historical) |
|---|---|---|
| CodeSha256 | `YEYAGPRlupCVeMQZ2hLZ5V2VknnKDo+22g4TaGvWTQI=` | `HFJ8AZHUqtGQ4am+dAx7jpYvb9WKzq1p0STomcEHIHw=` |
| RevisionId | `aadb9f6f-979b-49a6-a6b7-d14c41bdd0c9` | `12d3a663-4f26-4ea4-b580-bf86515643ca` |
| LastModified | `2026-10-06T01:08:51.000+0000` | `2026-10-05T14:38:35.000+0000` |
| Members | **6488** | **6487** |
| LastUpdateStatus | Successful | Successful |

Historical `3JRN…` / `0tBb…` / `HFJ8…` were **not** restored. Reconfirm at
`2026-10-06T15:17Z` matched the same CodeSha256 and RevisionId. ZIP origin:
`fresh-live-download`. Adapter `writesAuthorized=false`. Write calls: none.

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

## 4 — Invoice Recovery member hashes

All four owned members still exact against the accepted overlay:

| Member | SHA-256 | Match |
|---|---|---|
| `invoice-provider.mjs` | `1b219a8a24ef8faf4b5db888dd6f772a9f04b3eb0ec2b869b76cd3b0b7d54e24` | yes |
| `invoice-actions.mjs` | `1786e2d84219379396311450532aa5963ff1ea52d4514c8d4766acc4c7f9c141` | yes |
| `providers/parity/moov-functions.mjs` | `a8e94a696a25ab0404f4763b21b53a2d7ffb1e21beedefb25da0e12646bd4a99` | yes |
| `providers/parity/db.mjs` | `f5947d9e19ca8bead3f5712b98c67f196eee3ab496afca028fd05fefbebe5f3e` | yes |

Protected members also unchanged:
`caller.mjs` `1958eaa2…`, `sandbox-flags.mjs` `28e98700…`,
`provider-flags.mjs` `29f5a748…`, `public-invoice.mjs` `e2d5ea84…`.

Collection V2 members remain present with previously observed hashes
(`tenant-collection-v2.mjs` `dfa85b88…`, settlement `075d96d0…`,
contract `9ec5ae45…`, uat `adf8f250…`).

## 5 — Authenticated user / tenant

**Not confirmed.** This Cloud Agent browser has no existing Freedom session.

- Settled URL: `https://staging.checksops.com/login`
- Login prompt visible (EMAIL_OTP / passkey). No app shell, tenant, or
  Payments chrome.
- EMAIL_OTP was **not** started.
- Connected Outlook mailbox remains `claims@freedomadj.com`.
- Leftover `/tmp` tokens from 2026-10-05 are isolation/master identities,
  not Freedom, and were not reused.

Expected (unproven this run) Freedom principal:

| Field | Expected |
|---|---|
| Email | `mcarletta@freedomadj.com` |
| Application user | `7dbb3009-f059-4767-b5dc-1c5c72379330` |
| Staging Cognito sub | `c4386408-60e1-70e2-abb6-e6194e8e635f` |
| Tenant | Freedom `2eff5f1a-929d-4ce3-9a8b-cd96b98df42a` |

## 6 — Sandbox merchant / provider

**Not live-proven this run.** Isolation RLS cannot read Freedom
`payment_provider_accounts`. No Freedom `/identity/me` was obtained.

From **current live flags + unchanged deployed code** (not from a session):

- Provider execution remains sandbox-only
  (`AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED=true`,
  `AWS_PROVIDER_EXECUTION_ENABLED=false`).
- Production financial execution remains disabled.
- `AWS_MOOV_ENABLED=false` (invoice path remains separately
  sandbox-eligible under existing `requireParityEnabled`; this was **not**
  enabled).
- `AWS_EMAIL_MODE=sink`.

## 7 — Tests 1–6

| Test | Result | Evidence |
|---|---|---|
| 1 Create Draft (provider persist) | **BLOCKED** | No Freedom session |
| 2 Send (`PATCH unpaid`) | **BLOCKED** | No Freedom session |
| 3 Public invoice open | **BLOCKED** | No Freedom session / no new token |
| 4 Hosted checkout / pay | **BLOCKED** | No Freedom session; would require sandbox checkout only |
| 5 Sync/Refresh → Paid | **BLOCKED** | No Freedom session |
| 6 Duplicate / idempotency / failure | **BLOCKED** | No Freedom session |

Safeguard honored: EMAIL_OTP for `mcarletta@freedomadj.com` was not started
because this run cannot read that inbox. Isolation tenants were not reused
to force a pass. No safeguard was bypassed.

## 8 — Provider transaction IDs / local state

None. No invoice, send, checkout, sync, resend, ACH, transfer, wallet, or
sweep was attempted.

## 9 — Concurrent Security Hardening / main / staging movement

Observed, not reclaimed:

- `origin/main` advanced `c1e4f5378` → `8ed7cb1dc` (SH-2 + Branding merges;
  latest #722 at `2026-10-06T15:07:08Z`).
- Staging Lambda moved `HFJ8…` / 6487 → `YEYA…` / 6488 at
  `2026-10-06T01:08:51Z` (before #722 merge). Owned Invoice Recovery
  hashes did **not** change.
- Staging SPA moved `DR9wRQUG` → `Dq1xEBa5` at `2026-10-06T01:15:47Z`.
  Invoice Recovery Send/Resend UI is still in the new Payments chunk.
- No RUNNING Security Hardening deploy agent at inspect time. SH-2
  orchestrator / reviewer agents were IDLE.
- Leftover Deployment Guard leases/receipts for this workstream expired
  `2026-10-05T13:48Z` / `13:50Z` and were **not** reused or modified.
- Release Locks: `production-spa` is `PRODUCTION_LOCKED`. No
  invoice-specific lock. `identity-cognito` remains `UNVERIFIED`.

Movement does **not** justify restoring `DR9wRQUG` or `HFJ8`. It does
invalidate those fingerprints as current acceptance evidence. Current live
still carries Invoice Recovery API + UI, so UAT can continue later against
`YEYA` / `Dq1xEBa5` once a Freedom session exists.

## 10 — No mutations this run

No Lambda update, SPA upload, SQL/migration/grant/RLS, env-var, IAM/Cognito,
S3 deploy, CloudFront invalidation, provider config, Release Lock change,
Deployment Guard change, GitHub merge, production action, user/tenant/merchant
create or remap. Official live AWS adapter stayed `writesAuthorized=false`.

A local VM DNS workaround (`198.18.0.53` timed out; `8.8.8.8` used for
fresh-fetch/fresh-read) is not a ChecksOps staging or production change.

## 11 — STAGING ACCEPTED?

**No.** Create → Send → email → public invoice → hosted checkout → pay →
Sync → Paid was not executed on a merchant-backed tenant.

## Smallest forward-compatible repair (not applied)

1. Authenticate as `mcarletta@freedomadj.com` in a session this Cloud Agent
   browser can use (normal EMAIL_OTP / passkey; no identity remap).
2. Resume Tests 1–6 against **current** live (`YEYA…` / `Dq1xEBa5`), after
   a fresh-read.
3. Do not restore historical Lambda or SPA.
4. Do not enable `AWS_PROVIDER_EXECUTION_ENABLED` or `AWS_MOOV_ENABLED`.
5. If a later workstream drops `Send invoice` / `Resend invoice` from the
   live SPA, compose forward onto that then-current SPA. Do not roll back
   Branding or Security Hardening.
