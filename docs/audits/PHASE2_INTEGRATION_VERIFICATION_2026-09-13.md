# Phase 2 Integration verification — SQL 41/42

**Date:** 2026-09-13  
**Workstream:** Integration & Release  
**Do not begin Phase 3 from this handoff.**

## Identity

- Agent: `bc-c48d261b-22b3-481c-a28f-ddf0189e3bce`
- App PR: #288 `cursor/phase2-integration-deploy-3bce`
- Inventory PR branch: `cursor/phase2-integration-inventory-3bce` (stacked on #285)

## Heads

| Item | SHA |
|---|---|
| Starting HEAD | `fd82b5f6a` (`cursor/integration-awaiting-deploy-3bce`) |
| Integrated HEAD | `8ee90ac7b` |
| #286 | `dd7ef0214` |
| #287 | `3dd9bb6c4` |
| Merge conflicts | none (ort auto-merge) |

GitHub PRs #286/#287/#285 were **not** merged to `main`. This workstream git-merged #286+#287 onto the Integration stack only.

## Staging deploy

| Item | Value |
|---|---|
| AWS account | `806168576068` |
| Region | `us-east-1` |
| API | `checksops-staging-api` |
| Starting live SHA (this overlay) | `Wk5V+GVPry6FUpty7Jn21YZeQ62TMBXo4oDM0bj2IBI=` |
| Integrated CodeSha256 | `W3oWlWtMhILouJRPezrrsJOQJQP8VnWDZYo1Ljy/tqE=` |
| API LastModified | `2026-09-13T10:57:00.000+0000` |
| SPA bucket | `checksops-staging-frontend-c48b` |
| CloudFront | `E1CG52WRQZI7X1` invalidation `I8YBW3IBD94M8LJGPV9N50NLP7` |
| SPA assets | `index-Bo0IO5sc.js`, `HomeownerClaimPortal-CXLKApYq.js`, `index-C98vfs9s.css` |
| Provider execution | `false` |
| Application writes | `true` |

Documented prior Integration SHA `oCIMSmHLoNDGI3ia4OnJPeZt0cb5+8otJK4SHV0vccw=` was not the live SHA immediately before this overlay. Live SHA was already `Wk5V+GVP…`. Recorded as a cross-workstream handoff. Not reverted.

## SQL

| Migration | Status |
|---|---|
| `41_claims_org_id_insert_grant.sql` | applied |
| `41_create_claim_for_staff_org_id.sql` | applied (function packed/executed with SQL 41) |
| `42_public_homeowner_claim_sign_dtp.sql` | applied |
| `23_claims_org_backfill.sql` | **not run** |

Post-apply: `claimsOrgIdInsertGranted=true`, `dtpSignGranted=true`, intake `claim_id` still denied, payments/wallets still denied. `org_id` NULL count remained **184**. C1C fixture `AWS-PR235-LEDGER-TEST-B` org_id remained C1C `4f172140-f57a-4744-8050-95f4f07b13b4`.

## #286 authorization

- Correct tenant insert assigned C1C `org_id`, then admin-deleted leftover.
- Freedom spoof of C1C org: RLS denied.
- Ninth UUID: RLS denied.
- Existing NULL rows unchanged (184).
- Settlement probe on repaired C1C fixture still authorized for C1C and denied for Freedom/ninth.

## #287 DTP

Lead `05360374-b28a-481b-954e-59a15f99d1ad` (SES-free mint; email not sent).

| Check | Result |
|---|---|
| UI success | toast `Direction to Pay signed`; Signed badge |
| API GET | `dtp_signed_at=2026-09-13T11:13:05.404Z`, name `Pat Homeowner` |
| DB | `dtp_signed=true` |
| Hard refresh | remained signed |
| Short name | UI reject; API 400 `missing_signature_name`; `dtp_signed_at` stayed null |
| Pending lead | API 403 `contractor has not accepted this request yet`; no signed |
| Invalid token | API 400 `invalid body`; no signed |

## A7-027

PASS. UI `Check sent securely` → DB upload `a4b894ae-…` status `uploaded` → S3 HeadObject 460 bytes `image/png` → refresh still listed.

## A5-201–A5-204

Unchanged **BLOCKED** (`c1c_authenticated_session_unavailable`). No physical settlement UI. Cognito was not modified.

## C1C staging identity (read-only)

- `payments@condition1commercial.com` exists, **enabled**, **CONFIRMED**, mapped to C1C admin UUID `fd857564-…` / sub `e418f488-…`.
- App client still has `ALLOW_USER_PASSWORD_AUTH`.
- `/auth/login` returns HTTP **400** `Incorrect username or password`.
- Root cause: credential no longer matches (not missing user, not disabled, not missing auth flow).
- Other C1C users (`asukanick@`, `lhogan@`) exist, CONFIRMED, mapped; no supported password in this workstream.
- Master UAT is not a C1C identity (`identity_not_linked` on `/data/*` previously).
- Proposed change, **not applied**: staging-only `AdminSetUserPassword Permanent=true` on `payments@condition1commercial.com`, then verify `/auth/login` and `/identity/me`. Do not touch Freedom A8-035 or production.

## Inventory

Starting: PASS 712, FAIL 1, INTERNAL BLOCKED 248, EXTERNAL BLOCKED 173, AWAITING 2.  
Ending: PASS **714**, FAIL **1**, INTERNAL BLOCKED **248**, EXTERNAL BLOCKED **173**, AWAITING **0**.  
Operational PASS: **714 / 1,136 = 62.9%**.

## Safety

Production unchanged. Provider execution OFF. SES unchanged. Freedom identity unchanged. No unrelated PRs merged. No unrelated migrations applied. No other workstream branches overwritten.
