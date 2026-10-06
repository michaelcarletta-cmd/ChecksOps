# Invoice Recovery UAT resume — authenticated-operator follow-up

**STOP.** Staging UAT only. No deploy, restore, reconcile, or overwrite.
Tests 1–6 were **not** executed. Invoice Recovery is **not** STAGING ACCEPTED.

The operator reported being authenticated in staging as
`mcarletta@freedomadj.com`. This Cloud Agent browser does **not** have that
session. `localStorage['checksops.aws.staging.auth']` is absent.
`GET /identity/me` was not called (no token). EMAIL_OTP was not started.

## Fresh-read (current live is authoritative)

Inspected `2026-10-06T18:48Z`. Adapter `writesAuthorized=false`. Write calls:
none. Historical `3JRN…` / `0tBb…` / `HFJ8…` / `DR9wRQUG` were not restored.

| Target | Current | vs 15:17Z inspect |
|---|---|---|
| `origin/main` | `fa8f12c52091f80236ff1014583b3a80f615d3ab` (PR #733) | moved from `8ed7cb1dc` |
| Lambda CodeSha256 | `YEYAGPRlupCVeMQZ2hLZ5V2VknnKDo+22g4TaGvWTQI=` | unchanged |
| RevisionId | `aadb9f6f-979b-49a6-a6b7-d14c41bdd0c9` | unchanged |
| LastModified | `2026-10-06T01:08:51.000+0000` | unchanged |
| Members | **6488** | unchanged |
| SPA entry | `/assets/index-Dq1xEBa5.js` | unchanged |
| `index.html` SHA-256 | `ea92cb1ae60bc1411b190ccfbfa51fb9af0f41f61f7a1cfca317821c2f2843b6` | unchanged |

Owned Invoice Recovery hashes still exact. Flags unchanged:
`AWS_PROVIDER_EXECUTION_ENABLED=false`,
`AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED=true`, `AWS_MOOV_ENABLED=false`,
`AWS_EMAIL_MODE=sink`.

Security Hardening continued merging to main (#727–#733, latest
`security/staging-overlay-receipt-wiring`). That movement did **not** change
the Invoice Recovery Lambda/SPA runtime. It was not rolled back.

## Identity / merchant

| Check | Result |
|---|---|
| Cloud Agent browser session | **none** (login page; key missing) |
| `/identity/me` | **not called** (no token; would be unauthenticated) |
| Freedom tenant | **unproven this run** |
| Sandbox merchant/provider rows | **unproven this run** |
| Outlook mailbox | still `claims@freedomadj.com` |
| EMAIL_OTP started | **no** |

## Tests 1–6

| Test | Result |
|---|---|
| 1 Create Draft | **BLOCKED** |
| 2 Send | **BLOCKED** |
| 3 Public invoice open | **BLOCKED** |
| 4 Hosted checkout / pay | **BLOCKED** |
| 5 Sync/Refresh → Paid | **BLOCKED** |
| 6 Duplicate / idempotency / failure | **BLOCKED** |

No invoice or money movement.

## STAGING ACCEPTED?

**No.**

## Smallest forward-compatible repair (not applied)

Authenticate as `mcarletta@freedomadj.com` **in this Cloud Agent browser**
(normal EMAIL_OTP / passkey), then resume Tests 1–6 against current live
`YEYA…` / `Dq1xEBa5`. A session in the operator’s own browser is not visible
here. Do not restore historical packages. Do not remap identity.
