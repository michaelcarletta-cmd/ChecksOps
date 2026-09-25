# S5 wrong claim association — next Phase 1 item after S2

**Date:** 2026-09-25  
**S2:** CLOSED / PRODUCTION PASS. Production SHA unchanged: `hjz0G98YOSPT2vyE9+Qy+n8a7pr87e2+Dgodm4zzC2A=`.  
**This step:** Identify and evidence only. No production change. No S2 reopen.

## Requirement

A check must not be able to move from Claim A to Claim B in a way that mis-attributes money or deposit eligibility. An admin correction that sets or clears `claim_id` before deposit must be explicit, audited (actor, timestamp, check id, prior claim, new claim), and impossible after `deposited_at`. Generic `/data/write` of `claim_id` must stay denied.

## Current status

**FAIL**

The generic write lock still prevents the adversarial silent reassignment. There is still no audited AWS path to attach, correct, or clear `claim_id` on a pre-deposit check. The S5 association scenario therefore cannot be completed, and a live mis-association cannot be repaired on AWS.

## Evidence (staging, 2026-09-25)

Freedom check `b819705f-f4a5-45cd-a805-700f85d2fb75` created with `claim_id=null`, moved to `needs_review`.

| Action | Result |
| --- | --- |
| `POST /data/write` `check_intake_items.claim_id` | `403 column_not_allowlisted` `columns=[claim_id]` |
| `POST /data/write` `claim_checks.claim_id` | `400 missing_required_field` (column not writable) |
| `admin_override_check_status` | `403 rpc_disabled` |
| `admin_set_check_claim` / `set_check_claim` / `assign_check_claim` / `link_check_to_claim` / `admin_link_claim` | `403 rpc_disabled` |
| Re-read | `claim_id` still `null`, amount still `150` |
| Cleanup DELETE | `200` |

`GET /data/query claims` returned `503 data_query_failed` (same non-fatal claims-list gap as the original Phase 1 run). Production Lambda SHA, Moov, CheckAlt, provider, and financial flags were read-only and unchanged.

## Smallest required fix

Add one audited admin RPC, for example `admin_set_check_claim`, that can set or clear `check_intake_items.claim_id` only when `deposited_at IS NULL`, the check is in the caller’s tenant, and the target claim (when non-null) is the same tenant. Write `check_audit_log` with actor, timestamp, check id, prior `claim_id`, and new `claim_id`. Do **not** add `claim_id` to the generic intake write allowlist. Do **not** change production until that RPC is accepted on staging.

## Not this item

S2 invalidation, SQL trigger rewrite, S11 partial disbursement, and S14 post-deposit `payee_line` lock remain out of scope here.
