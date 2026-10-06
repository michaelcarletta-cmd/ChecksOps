# Invoice Recovery UAT resume — merchant-backed tenant access

**STOP.** No identity remap. No Cognito change. No Moov onboard. No SQL/env
change. No deployment. No production. Tests 1–6 were **not** re-run.

## Fresh-read (current live is authoritative)

Inspected `2026-10-05T15:03Z`. Did **not** restore `3JRN…` or `0tBb…`.

| Target | Current |
|---|---|
| Lambda CodeSha256 | `HFJ8AZHUqtGQ4am+dAx7jpYvb9WKzq1p0STomcEHIHw=` |
| RevisionId | `12d3a663-4f26-4ea4-b580-bf86515643ca` |
| LastModified | `2026-10-05T14:38:35.000+0000` |
| Members | **6487** (other workstream added `tenant-collection-v2-uat.mjs`) |
| SPA entry | `/assets/index-DR9wRQUG.js` (unchanged) |
| `index.html` SHA-256 | `2e71b6c40cdc6cb6c0fd9d3c0d00691cdbea201e748c2c9f9bc09088382c9337` |

Owned Invoice Recovery hashes still exact:

| Member | SHA-256 | Match |
|---|---|---|
| `invoice-provider.mjs` | `1b219a8a24ef8faf4b5db888dd6f772a9f04b3eb0ec2b869b76cd3b0b7d54e24` | yes |
| `invoice-actions.mjs` | `1786e2d84219379396311450532aa5963ff1ea52d4514c8d4766acc4c7f9c141` | yes |
| `providers/parity/moov-functions.mjs` | `a8e94a696a25ab0404f4763b21b53a2d7ffb1e21beedefb25da0e12646bd4a99` | yes |
| `providers/parity/db.mjs` | `f5947d9e19ca8bead3f5712b98c67f196eee3ab496afca028fd05fefbebe5f3e` | yes |

Flags unchanged: `AWS_PROVIDER_EXECUTION_ENABLED=false`,
`AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED=true`, `AWS_MOOV_ENABLED=false`,
`AWS_EMAIL_MODE=sink`.

## Eligible existing users vs merchant-backed tenant

Connected mailbox remains `claims@freedomadj.com`. Isolation/synthetic
plus-address users are the only linked CheckOps sessions this mailbox can
complete. Those tenants have `payment_provider=moov` but **zero**
`payment_provider_accounts` rows. Invoice preflight still fail-closes:
`Set up your payment account first.` / `environment=sandbox` /
`liveProviderCalled=false`. Spoofing Freedom `tenant_id` is ignored
(`Organization not found`).

| Email | Live-linked? | Tenant | Sandbox Moov merchant | EMAIL_OTP reachable here? |
|---|---|---|---|---|
| `claims+onboard59ff@freedomadj.com` | yes (`ca430f3f-…`, admin) | `onboard-iso-59ff` | **no** (0 account rows) | yes |
| `claims+stagelock59ff1790251205@freedomadj.com` | yes (`75d3da03-…`, admin) | `onboard-iso-59ff` | **no** | yes |
| `claims+mde2e@freedomadj.com` | yes (`97a1e063-…`, admin) | `synthetic-mortgage-ops-billing` | **no** | yes |
| `claims@freedomadj.com` | mortgage_agent / wrong portal | none | n/a | yes |
| `staging-master@checksops.invalid` | **`identity_not_linked`** | — | — | password path retired |
| `mcarletta@freedomadj.com` | live Cognito `CONFIRMED`; expected Freedom admin `7dbb3009-…` (dual-env staging sub `c4386408-…` matches this Cognito email) | Freedom `2eff5f1a-…` (source/expected) | expected merchant-backed sandbox tenant | **no** (not `claims@`) |
| `checksops-tester@freedomadj.com` | live Cognito `CONFIRMED` on **new** sub `04d85458-…` (not historical `c4386408-…`); live `identity_accounts` row **not proven** | Freedom staff expected historically | unknown until `/identity/me` | **no** |

Freedom tenant exists (`tenants_public`). Isolation RLS cannot read Freedom
`payment_provider_accounts` or Freedom `profiles`. This run therefore cannot
live-prove the Freedom merchant row without a Freedom-linked session.

No `claims+` Cognito user belongs to Freedom.

## Blocker

No existing merchant-backed sandbox tenant can be accessed with an
already-linked CheckOps user whose EMAIL_OTP this run can read.

Required operator login (normal passwordless UI, no identity mutation):

**`mcarletta@freedomadj.com`**

Open `https://staging.checksops.com/login`, request EMAIL_OTP for that
address, complete the code from that inbox, then continue Tests 1–6 on
Freedom. Do not use isolation `claims+` aliases. Do not remap
`staging-master`. Treat `checksops-tester@freedomadj.com` as secondary only;
its current Cognito sub may be unlinked.

Tests 1–6, hosted checkout, Paid/Sync, and Resend were **not** executed.
No invoice, merchant, ACH, transfer, wallet, or sweep was created.
