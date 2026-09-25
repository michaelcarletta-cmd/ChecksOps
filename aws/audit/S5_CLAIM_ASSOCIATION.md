# S5 wrong claim association — next Phase 1 item after S2

**Date:** 2026-09-25  
**S2:** CLOSED / PRODUCTION PASS. Production SHA unchanged: `hjz0G98YOSPT2vyE9+Qy+n8a7pr87e2+Dgodm4zzC2A=`.  
**Staging remediations:** PASS. See `S5_CLAIM_ASSOCIATION_REMEDIATIONS.md`. Production not promoted.

## Requirement

A check must not be able to move from Claim A to Claim B in a way that mis-attributes money or deposit eligibility. An admin correction that sets or clears `claim_id` before deposit must be explicit, audited (actor, timestamp, check id, prior claim, new claim), and impossible after `deposited_at`. Generic `/data/write` of `claim_id` must stay denied.

## Current status

**STAGING PASS.** Production remains frozen. Do not promote until explicitly approved.

Authorized admins can set, correct, or clear `claim_id` through `POST /data/rpc` `admin_set_check_claim`. The writer is `public.admin_set_check_claim` (SECURITY DEFINER). Generic `/data/write` of `claim_id` remains `403 column_not_allowlisted`.

## Smallest required fix (implemented on staging)

One audited admin RPC, `admin_set_check_claim`, that can set or clear `check_intake_items.claim_id` only when `deposited_at IS NULL`, the check is in the caller’s tenant, and the target claim (when non-null) is the same tenant. Identical prior/new values are a no-op. Do **not** add `claim_id` to the generic intake write allowlist.

## Not this item

S2 invalidation, SQL trigger rewrite, S11 partial disbursement, and S14 post-deposit `payee_line` lock remain out of scope here.
