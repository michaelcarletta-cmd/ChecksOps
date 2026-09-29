# E14B — Deposit image check after Admin Tools re-upload

Recorded 2026-09-22T22:45Z. CheckAlt money flags stayed **OFF**. No FinCapture. No Moov.

## Post-upload production row

`check_intake_items` `a3a4a153-46e1-4c28-a273-79a9bd04f3a6` / `#0121319295` / `$1,546.72` / Freedom / `approved_for_deposit`.

Production schema has **no** `front_image_original_path` or `front_image_deposit_path`.

| Field | Value |
| --- | --- |
| `front_image_path` | `checks/reupload/a3a4a153-46e1-4c28-a273-79a9bd04f3a6/front-1790116385272.jpg` |
| `back_image_path` | old `checks/shared/…/back-1784138087917_endorsed_1788181569614.svg` |
| `back_image_original_path` | old `checks/shared/…/back-1784138087917.jpg` |
| `back_image_deposit_path` | `null` |
| `endorsement_render_status` | `idle` |
| `endorsement_render_meta` | `null` |
| `checkalt_deposits` for this check | 0 |

S3 `files/claim-files/checks/reupload/{id}/` contains **only** the new front JPEG (388,937 bytes, `2026-09-22T22:33:07Z`). No rear re-upload object. No `front-….checkalt.jpg`.

Conclusion: Admin Tools **did persist** the new front path. Rear was not uploaded (no S3 object). Deposit image check was not reading a stale `front_image_deposit_path` column.

## front_missing

`CheckAltImageComplianceCard` downloaded `toCheckAltPath(front_image_path)` = `….front-1790116385272.checkalt.jpg`. That official sibling did not exist, so `emptySide("front")` reported `front_missing` even though the authoritative `front_image_path` JPEG exists.

Server eligibility (`officialCheckAltFrontPath`) already uses `front_image_path`. `prepareCheckAltDeposit` already requires a raster `front_image_path`. The card treated “official sibling absent” as “front missing”.

## rear_missing

The card inspected `back_image_deposit_path` only. That pointer is **correctly null** until Adjust Received Endorsement writes the endorsed deposit JPEG. `toCheckAltPath(null)` → `rear_missing`.

No new rear was stored. Old endorsed SVG remains on `back_image_path`; old original JPEG remains on `back_image_original_path`.

## Workflow fix (every check)

1. Deposit image check: official `.checkalt.jpg` first; if missing but the source exists, reason is `*_unprepared`, not `*_missing`. Rear presence can use original/back so a cleared deposit path is not “missing”.
2. After Admin Tools **front** re-upload, generate the official front sibling from `front_image_path`.
3. On Deposit view, generate official siblings from `front_image_path` and, when present, `back_image_deposit_path`. Never invent a front deposit column. Never build official rear from the raw/unendorsed back.

SPA must be deployed for the operator to see this. This revision does **not** rewrite this check’s paths and does **not** drop a one-off official JPEG into S3.

## Operator clicks (required for rear)

No new rear photo was uploaded. After the SPA is live:

1. Reload the check (official front sibling prepares from the new `front_image_path`).
2. If the new rear photo still needs to land: Admin Tools → **Replace Back**.
3. **Adjust Received Endorsement** → generate the endorsed rear (`back_image_deposit_path`) → close.
4. Reload. Official rear sibling prepares from the deposit JPEG. Deposit image check should no longer show `front_missing` / `rear_missing`.
5. Do **not** click Deposit. Flags stay off.

## Unchanged

Flags: `EXECUTION/CHECKALT/FINANCIAL=false`, dry-run `true`, Moov `false`. CodeSha `xt/R8za4uuGndEDN0g82S4wIhR+eBO0sO/RR92u5P/E=`. Historical CheckAlt 69 / 453990.48 / `2026-09-04`. Inspect oneshot restored to staging.
