# Claims org_id ownership (planning only)

**Backfill applied for 83 Freedom claims only.** The remaining **97** restored `claims.org_id` values are still NULL. `workspace_id`, `client_id`, and `referrer_id` are also NULL.

`claims.org_id` is the tenant key (`is_tenant_member(user, cl.org_id)`).

## Groups

| Group | Count | Proposed `org_id` |
| ---: | ---: | --- |
| Deterministically assignable | **83** | Freedom `2eff5f1a-929d-4ce3-9a8b-cd96b98df42a` |
| Ambiguous (conflicting tenants) | **0** | — |
| No evidence of ownership | **97** | leave NULL |

Live oneshot (restricted to rows in `public.claims`) confirmed the same counts. Intake+ledger alone cover 81 Freedom claims; the remaining 2 assignable claims use the other tenant-keyed signals.

JSON: `aws/rls/classification/claims_ownership.json`.

## Deterministic evidence (used)

Exactly one tenant from tenant-keyed children:

- `check_intake_items.claim_id` → `tenant_id` (81 claims)
- `check_intake_items.freedom_claim_id`
- exact `claims.claim_number` = `detected_claim_number` or `freedom_claim_number`
- `homeowner_ledger_events.claim_id` → `tenant_id`
- `deposit_items.claim_id` → `check_intake_items.tenant_id`
- `claim_payments.check_intake_item_id` → intake tenant

Every assignable claim points only at Freedom. No C1C-owned restored claim was found.

## Not used (would be inference, not ownership)

- `created_by` / `uploaded_by` (forbidden: admin/staff inference)
- One `claim_settlements` row on an otherwise-unlinked claim created by the master-owner UUID
- Predefined `claim_folders` named "Freedom Adjustment Documents" on **all 180** claims (`created_by` NULL, `is_predefined` true) — product template, not tenant proof
- `emails.claim_id` (469 ids, **zero** overlap with the 180 restored claims)

## After a future backfill (not this phase)

Tenant staff still cannot write the 97 unassigned claims (`aws_can_write_tenant(NULL)` is false). Master owner can read them via SELECT `aws_is_cross_tenant_reader()`. Do not invent C1C ownership.
