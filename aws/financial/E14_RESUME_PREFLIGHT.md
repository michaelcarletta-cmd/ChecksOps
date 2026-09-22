# E14 resume — final preflight STOP

Recorded 2026-09-22T22:55Z. **Money flags were not reopened.** No FinCapture. No deposit row. Selected check was not mutated.

## Verdict

**NOT READY FOR OPERATOR DEPOSIT.**

Every operator-listed image/ownership/amount/mapping/drift gate passed. Production submit eligibility still fails: `endorsement_render_meta` has **no** `checkalt_rear_fingerprint`. `evaluateProductionDepositEligibility` / `evaluateRearImageFreshness` return `provider_rear_image_stale` / `rear_fingerprint_missing`. Deposit would be refused **before** HTTP.

## Selected check (unchanged)

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
| Rear | `checks/reupload/…/endorsed_deposit_9ffq.checkalt.jpg` | 268,289 | 1920×1080 JPEG | **PASS** |

Both objects exist on `checksops-production-privatefiles-806168576068` (`files/claim-files/…`), AES256, readable. Source front/back JPEGs also present. `endorsement_render_status=completed`.

## Failed gate

`endorsement_render_meta` keys: `bytes`, `width`, `height`, `override`, `mime_type`, `request_id`, `renderer_version`. No `checkalt_rear_fingerprint` (len 0). This is the browser adjuster meta, not the AWS compositor stamp (`engine` / `sha256` / fingerprint).

Live submit (`checkalt-submit.mjs`) calls `evaluateProductionDepositEligibility`. Missing fingerprint is a hard refuse. This revision did **not** stamp the row.

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

## Flags left closed

`checksops-production-prep-api` CodeSha `xt/R8za4uuGndEDN0g82S4wIhR+eBO0sO/RR92u5P/E=` LastModified `2026-09-22T22:15:46Z` (unchanged this turn):

- `AWS_FINANCIAL_PERMISSIONS_ACTIVATED=false`
- `AWS_CHECKALT_ENABLED=false`
- `AWS_PROVIDER_EXECUTION_ENABLED=false`
- `AWS_PROVIDER_WEBHOOK_DRY_RUN=true`
- `AWS_CHECKALT_STATUS_RECONCILE_ENABLED=false`
- `AWS_MOOV_ENABLED=false`
- `AWS_MOOV_TRANSFER_POST_ENABLED=false`
- `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED=false`

Inspect oneshot restored to staging RDS.

## Operator next

1. Do **not** click Deposit.
2. Open the check → **Adjust Received Endorsement** again so the AWS compositor writes `checkalt_rear_fingerprint` onto the official rear (do not drop a one-off S3 file).
3. Ask to resume this preflight. Flags stay off until that stamp exists.
