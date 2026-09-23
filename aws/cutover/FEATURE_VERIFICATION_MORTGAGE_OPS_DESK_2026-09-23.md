# Feature Verification — Mortgage Ops authenticated desk (Morgan / claims@)

**Recorded:** 2026-09-23T21:42Z  
**Environment:** AWS staging only (`CHECKSOPS_ENV=staging`)  
**Identity:** existing `mortgage_agent` Morgan Carletta / `claims@freedomadj.com`  
**Production:** not modified  
**Cognito pool config / SES / password auth / CheckAlt / Moov:** not changed  

OTP `74572267` completed EMAIL_OTP verify. This record is the desk walk after that session.

## Verdict

**MORTGAGE OPS DESK — PARTIAL PASS (staging).**

Login, role mapping, queue, accept, in-progress notes, persistence, and permission isolation all work on the existing account. Assigned check images and documents could not be demonstrated: the only active staging requests point at `check_intake_item_id` values that are not visible (embed `check` is null; `GET /functions/v1/get-check-image-urls` returns `404 not_found`). That is fixture/orphan data, not a Cognito or hire defect. Complete / cancel / billing were not invoked.

## A. Identity after OTP

`GET https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging/identity/me` **200**

| Field | Value |
|---|---|
| `applicationUserId` | `b100f05d-9e81-4a7b-b9cc-9baf173131d9` |
| `cognitoSub` | `047824f8-b0b1-7018-c5e3-c0350a6c8a40` |
| `sub = applicationUserId` | **false** |
| email / name | `claims@freedomadj.com` / Morgan Carletta |
| `roles` | `["mortgage_agent"]` only |
| `tenants` | `[]` |
| `identityEnv` / `environment` | `staging` / `staging` |
| `isMasterOwner` / `privileged` | false / false |

`user_roles`: one row `5ce3f34f-7404-455c-b2c4-f6d39845547e` (`mortgage_agent`).  
`tenant_users`: empty.

## B. EMAIL_OTP verify

| Step | Result |
|---|---|
| Prior start | real Cognito `EMAIL_OTP` to `c***@f***` (`COGNITO_DEFAULT`) |
| `42161060` | session expired |
| `9103830` | invalid / stale (7-digit) |
| `74572267` | **200** `completed=true` `passwordUsed=false` |
| App `POST /auth/login` | still **410** `password_auth_disabled` |

Tokens used only for this staging desk session. Not logged.

## C. Login / role recognition

Authenticated session maps Cognito sub → existing application UUID → `mortgage_agent`. Desk session key remains `checksops.aws.staging.auth.mortgage-ops`. No staff/admin. No tenant membership. Portal would accept this role (`mortgage_agent` or `admin`).

## D. Queue

`POST /data/query` `mortgage_handling_requests` with UI embed `*, tenants:tenant_id(name), check:check_intake_item_id(amount)` **200**.

Three rows visible (desk-wide, as designed for `mortgage_agent`):

| id | status (before) | assigned | tenant | company |
|---|---|---|---|---|
| `d42ba6fb-…` | requested | none | Condition One Commercial | C046-AUDIT-NO-CONTACT |
| `7f549fcb-…` | requested | none | Condition One Commercial | C046-AUDIT-NO-CONTACT |
| `aa3d85f9-…` | completed | Morgan | Freedom Adjustment | Spencer Savings Bank-Sla |

Completed history is visible only because `assigned_employee_id` is Morgan. Other agents’ in-progress work was not present.

## E. Assigned work (accept)

`POST /data/rpc` `accept_mortgage_handling_request` `{ _request_id: d42ba6fb-… }` **200**.

- status → `in_progress`
- `assigned_employee_id` → `b100f05d-…`
- `accepted_at` → `2026-09-23T21:40:41Z`
- sibling `7f549fcb-…` remained `requested` / unassigned

## F. Images

`POST /functions/v1/get-check-image-urls` `{ checkId: d8cf4555-… }` **404** `not_found`.

Request embed `check:check_intake_item_id(id,amount,front_image_path,status)` is **null**.  
`check_intake_items` count visible to this agent: **0**.

The completed Freedom request’s check is hidden by design (`mortgage_agent_can_view_check` is only `requested` / `in_progress`). It was not used for image proof.

**Classification:** staging fixture / orphan `check_intake_item_id`, not a desk-code or auth-mapping defect. No repair in this run.

## G. Documents

Same visibility: `check_files`, `mortgage_request_library_documents`, `loss_draft_tracking` / `loss_draft_documents`, `check_messages` all **200** with **0** rows for the accepted request. No document binary was fetched.

## H. Notes / actions

`POST /data/rpc` `update_mortgage_handling_request_status`

```
_request_id = d42ba6fb-…
_status     = in_progress
_notes      = STAGING ACCEPTANCE 2026-09-23 — Morgan desk note (in_progress only; do not complete)
```

**200**. `completed` / `cancelled` / `bill-mortgage-handling` were **not** called.

## I. Status persistence

Re-read of `d42ba6fb-…`:

| Field | Value |
|---|---|
| status | `in_progress` |
| assigned | Morgan |
| work_notes | contains the staging note |
| completed_at | null |
| billing_status | `unbilled` |

## J. Tenant-side synchronization

No second (tenant) OTP session was available. The persisted row is the tenant-visible mortgage request (`tenant_id` Condition One Commercial `4f172140-…`, status `in_progress`, work notes stored). Tenant `user_roles` / membership were not used. This agent’s `tenant_users` query for that tenant returns **0** rows (agent is not a tenant member).

## K. Tenant isolation

| Probe | Result |
|---|---|
| `tenant_users` for self | empty |
| `tenant_users` by queue tenant ids | empty (RLS) |
| unscoped `check_intake_items` | 0 |
| `user_roles` where `role=admin` | 0 |
| Queue spans two tenants | intended desk-wide read of `mortgage_handling_requests` |
| Accept did not take the sibling request | sibling still unassigned |

## L. Permission isolation

| Probe | Result |
|---|---|
| `hire-mortgage-agent` | **403** `Admin access required` |
| `is_master_owner` / `is_platform_owner` | **false** / **false** |
| `checkalt-submit` / `checkalt-preflight` | **403** `provider_disabled` |
| `moov-payout` | **403** `provider_disabled` |
| `save_checkalt_settings` | **403** `not_authorized` |
| `bill-mortgage-handling` (no id) | **400** `request_id required` — not retried with a live id |
| password login | **410** `password_auth_disabled` |

`bill-mortgage-handling` is role-gated to `mortgage_agent` but fail-closed (`production_execution_blocked` / Stripe not called) when a request id is present. This run did not send the live request id.

## M. Defects found

| Observation | Class | Repair? |
|---|---|---|
| Active C046-AUDIT-NO-CONTACT requests have no visible `check_intake_items` row | staging fixture / orphan FK | **not repaired** — data, not auth |
| Completed Freedom check hidden from image API | intended `mortgage_agent_can_view_check` scope | no change |
| First queue select that requested a non-existent `notes` column returned 503 | client column typo in this probe; UI selects `*` | no product change |

No Cognito / SES / production / money-path defect was shown after OTP.

## N. Frozen surfaces

- Production pool `us-east-1_h00WorYMT` not written
- Staging pool config / SES / CustomEmailSender not changed
- `identity_production_cognito_locks` unchanged (`34c8a478-…`)
- Password auth remains 410
- No CheckAlt deposit, no Moov, no complete/bill
- Temporary inspect Lambda not reused this phase
