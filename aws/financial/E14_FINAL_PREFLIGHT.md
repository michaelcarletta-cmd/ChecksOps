# E14 final preflight — READY FOR OPERATOR DEPOSIT

Recorded 2026-09-22T23:53Z after the operator reran Adjust Received Endorsement on the E14C write path. **No FinCapture. No deposit row. This agent did not click Deposit.**

## Verdict

**READY FOR OPERATOR DEPOSIT.**

Every listed gate passed. Production eligibility is PASS. The one-deposit CheckAlt window is open with webhook dry-run still ON and every other rail closed.

## Selected check

| Field | Value | Gate |
| --- | --- | --- |
| ID | `a3a4a153-46e1-4c28-a273-79a9bd04f3a6` | Freedom `2eff5f1a-929d-4ce3-9a8b-cd96b98df42a` **PASS** |
| Number | `#0121319295` | **PASS** |
| Amount | `$1,546.72` / `154672` cents | **PASS** |
| Status / stage / reco | `approved_for_deposit` / `ready_for_deposit` / `ready_for_deposit` | **PASS** |
| Payees | Freedom Adjustment (public_adjuster, signed); Miranda Shollenberger (insured, signed) | **PASS** |
| Endorsements | both `signed` | **PASS** |
| `checkalt_deposits` | 0 | **PASS** |
| FinCapture / sandbox ops | none | **PASS** |

## Deposit images

| Side | Official path | Bytes | Canvas | Gate |
| --- | --- | --- | --- | --- |
| Front | `checks/reupload/…/front-1790116385272.checkalt.jpg` | 252,447 | 1920×1080 JPEG | **PASS** |
| Rear | `checks/reupload/…/endorsed_deposit_kp9u.checkalt.jpg` | 268,289 | 1920×1080 JPEG | **PASS** |

Both objects exist on `checksops-production-privatefiles-806168576068` (`files/claim-files/…`), AES256, readable. `endorsement_render_status=completed`. Rear is the new Adjust artifact (`kp9u`), not the prior `9ffq`.

## Fingerprint / eligibility

`endorsement_render_meta.checkalt_rear_fingerprint` is present (64-hex) and **matches** `endorsementStateFingerprint` of the current payees/endorsements (ids, types, statuses, `signed_at` / `endorsed_at`).

`evaluateProductionDepositEligibility` returns **PASS**. No `rear_fingerprint_missing`, `rear_fingerprint_mismatch`, stale image, or other blocker.

## Mapping / host / secrets / drift

| Gate | Result |
| --- | --- |
| Freedom CheckAlt mapping | enabled; SSO + deposit account present; no other tenant enabled |
| `checkalt_config` host | `api2.checkalt.com` (not UAT) |
| `CHECKALT_BASE_URL` | `https://api2.checkalt.com` |
| `CHECKALT_WEBHOOK_SECRET` | configured |
| HTTP names | username / password / fi_key / base_url configured |
| `CHECKALT_UAT_*` / `CHECKALT_SANDBOX_*` | absent |
| Historical CheckAlt | 69 / 58 referenced / `453990.48` / `2026-09-04T15:58:10.843Z` — **no drift** |

## Flags reopened (this turn)

`checksops-production-prep-api` CodeSha `fG/MT+D3Zolft+W94i/eW/uf1uEWIF3YaM4KtuorRCQ=` (E14C write-path overlay; unchanged). Env count 41.

| Step | Flag | After |
| --- | --- | --- |
| 1 | `AWS_FINANCIAL_PERMISSIONS_ACTIVATED` | `true` (23:52:41Z) |
| 2 | `AWS_CHECKALT_ENABLED` | `true` (23:52:50Z) |
| 3 | `AWS_PROVIDER_EXECUTION_ENABLED` | `true` last (23:52:59Z) |

Held unchanged:

- `AWS_PROVIDER_WEBHOOK_DRY_RUN=true`
- `AWS_CHECKALT_STATUS_RECONCILE_ENABLED=false`
- `AWS_MOOV_ENABLED=false`
- `AWS_MOOV_TRANSFER_POST_ENABLED=false`
- `AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED=false`
- `AWS_PLAID_ENABLED=false`
- `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED=false`

Inspect oneshot restored to staging RDS.

## Operator

One Deposit on `#0121319295` / `$1,546.72` only. Do not raw-call FinCapture. Do not start a second process POST if the first HTTP outcome is ambiguous.
