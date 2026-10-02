# S2 material endorsement invalidation — staging remediations

**Date:** 2026-09-25  
**Scope:** Narrow Phase 1 S2 remediations only. Staging Lambda overlay. No Phase 2 audit. No production deploy.  
**API:** `https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging`  
**Function:** `checksops-staging-api` (in-place `UpdateFunctionCode`, not SAM)

## Root cause

`public.tg_mirror_payee_to_endorsement` keeps `signed` / `waived` endorsement rows when a payee is renamed and inserts another row for the new name. If the payee’s `endorsement_status` is still `signed` at rename time, the inserted row is also `signed`.

`evaluateEndorsementEligibility` treats any `signed` / `waived` row as complete and fingerprints ids / types / statuses / `signed_at` only — never payee names. Ready was previously blocked only when two rows for one `payee_id` produced `endorsement_state_ambiguous`. Removing the extra row would have left the stale signature eligible.

## Exact files changed

- `aws/functions/api/endorsement-material-invalidation.mjs`
- `aws/functions/api/write-check-workflow.mjs` (`lookupPayee` + `executePayees` update path)
- `aws/tests/endorsement-material-invalidation.test.mjs`
- `scripts/aws-phase1-adversarial-money-path.mjs`
- `scripts/aws-overlay-staging-api.mjs`
- `aws/audit/S2_MATERIAL_ENDORSEMENT_INVALIDATION.md`

## Exact invalidation behavior

On `POST /data/write` `check_payees` update, after the payee row is written, if `payee_name` or `payee_type` changed:

1. Select every matching endorsement (same `payee_id`, or `payee_id IS NULL` with the previous name).
2. Snapshot prior status, `signed_at`, signature image path, names, and types.
3. Write `endorsement_invalidated_material_edit` to `check_audit_log` with actor, timestamp, check id, reason `material_payee_change`, category `payee_identity`, material fields, and prior endorsement/signature state. Also attempt `endorsement_audit_log` and `check_endorsement_events`.
4. Delete extra / mirrored rows after the snapshot so only one current row remains.
5. Set the kept row to `pending`, clear live `signed_at` and `signature_image_url`, attach the current payee id/name, and note that prior signed state is in audit.
6. Reset `check_payees.endorsement_status` to `pending` and clear `endorsed_at` / `endorsement_image_path`.
7. Clear `back_image_deposit_path` and `checkalt_rear_fingerprint` on undeposited checks; increment render version.

Non-material edits (notes, address, carrier, contact) do not call this path. Ready after a material rename fails as `endorsements_incomplete` / `required_payee_unsigned`, not `endorsement_state_ambiguous`.

## Staging Lambda SHA

| | Value |
| --- | --- |
| Before | `Le4MOGvUUwhDurdOECbJB89bMJ5s+AQYBmtAoZZPDC4=` |
| After | `mybLtCmFjsfK7tfSSo7GPIqQRvjjjQwNewVyUCHLM3M=` |
| Last modified | `2026-09-25T01:44:43.000+0000` |
| Overlay | `endorsement-material-invalidation.mjs`, `write-check-workflow.mjs` only |

Live `write-check-workflow.mjs` differed from this branch only by the remediations hunks. No other live write-path behavior was overwritten.

## S2 rerun (from scratch)

Check `d6c7aa38-d78d-4646-a24a-5fcb3c31929d` (Freedom). Flow: Review → Endorsing → sign → Return to Review → rename payee to `CHANGED PAYEE LLC` → Endorsing → Ready without a new signature → re-sign → Ready.

| Assertion | Result |
| --- | --- |
| Prior signature no longer `signed` | PASS — one `pending` row |
| Single current endorsement | PASS — `fb0fa232-63a0-47b1-bf5a-bc4fd639542e` |
| Invalidation audit present | PASS — see below |
| Official rear path / fingerprint cleared | PASS |
| Ready without new signature | PASS — `403 endorsements_incomplete` / `required_payee_unsigned` |
| Fresh re-sign | PASS |
| Ready after re-sign | PASS — `approved_for_deposit` |
| Exactly one current signed endorsement | PASS — same id, new `signed_at` `2026-09-25T01:45:11.925Z` |
| Stale signature did not reactivate | PASS — historical id `5fbdca2a-…` remains audit-only |

## Audit record evidence

`check_audit_log.id` `d273642e-2d9b-4961-a987-155dc0bd5339`

- actor: `e3b2f5e6-0e25-4bb6-9f4e-6c2dfba5fb87`
- timestamp: `2026-09-25T01:45:09.036Z` (`event_data.invalidated_at` `2026-09-25T01:45:09.014Z`)
- check id: `d6c7aa38-d78d-4646-a24a-5fcb3c31929d`
- reason: `material_payee_change`
- category: `payee_identity`
- material fields: `payee_name`
- prior names: `Original Payee` → `CHANGED PAYEE LLC`
- prior signature state: two `signed` rows (`fb0fa232-…` trigger-copied new name, `5fbdca2a-…` original in-person sign)

## Generated-artifact invalidation

`back_image_deposit_path` is null. `endorsement_render_meta.checkalt_rear_fingerprint` is absent. The old rear artifact cannot be the current official artifact.

## Regressions (after S2)

`PHASE1_SCENARIOS=1,3,4,6,7,12` — 31 pass / 0 fail / no findings.

| Scenario | Result |
| --- | --- |
| S1 normal workflow + Ready-to-Deposit | PASS — Ready `approved_for_deposit`; `mark_deposited` and live CheckAlt still denied |
| S3 non-material edit | PASS — notes/address/carrier save; signature remains signed |
| S4 partial endorsement rollback | PASS — Ready `403 endorsements_incomplete` / `required_payee_unsigned` |
| S6 late mortgage discovery | PASS — Ready blocked after adding mortgage payee |
| S7 duplicate action / idempotency | PASS — second `start_review` invalid; prepare/submit/disbursement idempotent |
| S12 tenant isolation | PASS — C1C cannot read/transition/prepare/write Freedom checks |
| Ready-to-Deposit eligibility | PASS — S1 succeeds; S2 blocked until re-sign, then succeeds |

No production money movement. Provider execution flags stayed off.

## Synthetic leftovers

The original four `check_billing_events`-protected Phase 1 records were not force-deleted. Three remain readable on Freedom (`b887bd62-…`, `710c9494-…`, `ed194599-…`). `1068ac20-…` is not returned by Freedom SELECT (left untouched). S2 remediations check `d6c7aa38-…` is retained because Ready created financial-protection rows. Additional regression leftovers with `cleanup_denied` were also left in place.

## Production promotion plan (DO NOT EXECUTE YET)

The staging overlay is safe to promote **unchanged** to production if and only if the live production `write-check-workflow.mjs` still differs from this branch only by these remediations hunks.

Exact steps after approval:

1. Assume the production operator role. Do not change `AWS_PROVIDER_EXECUTION_ENABLED`, `AWS_MOOV_ENABLED`, `AWS_CHECKALT_ENABLED`, or `AWS_MOOV_TRANSFER_POST_ENABLED`.
2. Record production SHA:
   `aws --region us-east-1 lambda get-function --function-name <production-api-function> --query Configuration.CodeSha256`
3. Download the live production zip. Diff `write-check-workflow.mjs` against this branch. Abort if any non-S2 hunks exist and patch surgically instead.
4. Overlay only:
   - `endorsement-material-invalidation.mjs`
   - `write-check-workflow.mjs`
   using the same `UpdateFunctionCode` method as staging (`scripts/aws-overlay-staging-api.mjs` with `STAGING_API_FUNCTION` pointed at production, or an equivalent production copy). Do **not** SAM-deploy `aws/template.yaml`.
5. Wait for `LastUpdateStatus=Successful`. Record after SHA.
6. Run a single non-prod-money canary on production only if a dedicated production-safe fixture exists. Prefer repeating S2 on staging again if production fixtures are live-money adjacent.
7. Do not change `tg_mirror_payee_to_endorsement` in production SQL in this promotion.
8. Rollback: `UpdateFunctionCode` with the zip taken in step 2.

**Stop for approval. This remediations did not deploy to production.**

## Promote unchanged?

**Yes, with the live production file-diff gate above.** The remediations is confined to the AWS payee write path, preserves historical evidence in `check_audit_log`, and does not alter provider, Cognito, or tenant controls.
