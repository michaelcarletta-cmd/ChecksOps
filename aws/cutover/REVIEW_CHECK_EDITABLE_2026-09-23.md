# Phase 1 — Review Check must be editable (inventory)

**Date:** 2026-09-23  
**Scope:** Staging acceptance blocker. No production deploy. No Phase 2. No provider-flag changes.  
**Fixture:** `a4188a08-4583-419a-9b58-b96d8ff1fcb5` (do not populate by raw DB edit).

## 1. Why Edit is unavailable / nonfunctional on Review now

The Review screen already has an inline editor (`ReviewDecisionPanel` in `CheckReviewConsole.tsx`) labeled **Edit Fields**, not **Edit Check**.

On AWS staging, save goes through generic `/data/write` after `pickAwsSafeIntakeUpdates()` strips `amount`, `routing_number`, and `account_number`. If those are the only changes, save throws:

> AWS staging cannot save amount, routing, or account fields

The admin dialog (`CheckAdminEditDialog`, used from Admin Check Tracker, not Review) does the same filter and throws:

> AWS staging cannot save status, amount, routing, account, or mortgage fields

`/data/write` (`INTAKE_PROHIBITED_COLUMNS`) correctly keeps amount / MICR / status off the generic write path. That protection is why Review cannot correct OCR amount on staging.

`CheckAdminEditDialog` is **not** mounted on the Review screen. The existing Review editor is the inline field list.

## 2. Historical operator-editable fields (production Review / Admin)

### ReviewDecisionPanel — **Edit Fields** (source of truth for Review)

| Field | Column | Class |
| --- | --- | --- |
| Carrier / insurer | `check_intake_items.carrier_name` | B OCR-correctable |
| Check number | `check_intake_items.check_number` | B |
| Amount | `check_intake_items.amount` | C financial-sensitive; historically operator-correctable before routing |
| Payee line (OCR text) | `check_intake_items.payee_line` | B |
| Issue / check date | `check_intake_items.issue_date` | B |
| Routing # | `check_intake_items.routing_number` | C MICR |
| Account # | `check_intake_items.account_number` | C MICR |
| Funds type | `check_intake_items.funds_type` | A ordinary metadata (always-visible, `persistMeta`) |
| Property / loss address | `check_intake_items.property_address` | A / B (`persistMeta`) |
| Canonical payees | `check_payees.payee_name`, `payee_type` | B via `PayeeReconciliation` |
| Front / back images | `front_image_path` / `back_image_path` | E system; reupload via Admin tools |
| Reviewer notes | decision payload, not a persist-on-edit field | D workflow |

Required to route a Review decision (`getMissingFields`): Check #, Amount (>0), Issue date, Carrier, Payee line, at least one `check_payees` row. **MICR is not required.**

### CheckAdminEditDialog — Admin tracker only

Adds: `status` (D), `mortgage_flag` / `mortgage_monitoring_type` (D), MICR (C). Status override is **not** a Review correction.

### Fields requested vs current model

| Requested | Current source of truth | Class | Review editor? |
| --- | --- | --- | --- |
| Carrier / insurer | `carrier_name` | B | Yes |
| Drawee bank / bank name | **No dedicated column.** Bank identity is MICR. | C | MICR only |
| Check number | `check_number` | B | Yes |
| Amount | `amount` | C | Yes (blocked on AWS generic write) |
| Issue / check date | `issue_date` | B | Yes |
| Payees | `payee_line` (OCR) **and** `check_payees` (canonical) | B | Line in Edit; rows in PayeeReconciliation |
| Insured / homeowner | `check_payees.payee_type='insured'` or parsed from `payee_line` | B | Via payees |
| Property / loss address | `property_address` | A | Classification block |
| Claim number | `detected_claim_number` (queue inline, not Review Edit) | B / D | Queue only; generic write **prohibits** it (auto-link trigger) |
| Mortgage company | `check_payees.payee_type='mortgage_company'` | B | PayeeReconciliation |
| Memo | **Not on `check_intake_items`** | — | No |
| Front / rear images | path columns + storage | E | View + admin reupload |
| Check type | `claim_checks.check_type` (not Review) | E | No |
| Settlement type | `ReviewSettlementTab` / claim settlement | D | Separate tab |
| Linked claim | `claim_id` | D / E | Not editable in Review Edit |
| Status / stage | `status`, `check_stage` | D | Decision RPC / transition only |

## 3. Current AWS support

| Field | `/data/write` | Dedicated path needed |
| --- | --- | --- |
| `carrier_name`, `check_number`, `issue_date`, `payee_line` | Allowed (T2) | Optional; included so one Review save is atomic |
| `funds_type`, `property_address`, `payee_address`, `review_notes` | Allowed (T2) | Same |
| `check_payees` name/type | Allowed (T2) | Keep existing PayeeReconciliation |
| `amount` | **Denied** (no column grant + not allowlisted) | **Yes** |
| `routing_number`, `account_number` | Denied | **No** (see §6) |
| `status`, `check_stage`, `claim_id`, `detected_claim_number` | Denied | **No** |
| `raw_ocr_front`, `raw_ocr_back` | Not writable | Must stay unread-only |

OCR evidence lives in `raw_ocr_front` / `raw_ocr_back`. Staging OCR persist writes descriptive columns only and never amount/MICR. Review correction must not UPDATE those JSON columns.

## 4. Dedicated correction design

`POST /workflow/checks/:id/review-correction`

- Cognito JWT → `identity_accounts` → `request.app_user_id` → `auth.uid()`
- Tenant isolation: actor must be a member of the check tenant (or platform `admin`/`staff`)
- Role: same as Review transition (`staff` / `admin` / `owner` / `manager` / tenant `member`)
- Allowlist only (see §2 Review fields minus MICR/status)
- Reject deposited / `deposited_at` / ready-for-deposit / released checks
- Amount only while status is a Review state (`uploaded`, `needs_review`, `ocr_complete`, `manual_review_required`) or `check_stage='review'`, and not financially locked
- Amount written via `SECURITY DEFINER` `public.aws_review_correction_set_amount` — **not** a generic `GRANT UPDATE (amount)` and **not** `/data/write`
- Never updates `status`, `check_stage`, `claim_id`, provider/account columns, or `raw_ocr_*`
- Audit: `check_audit_log.event_type='review_correction'` with actor, changed fields, old/new values
- Optional `payees[]` updates existing `check_payees` rows (name/type only). `payee_line` does not rewrite payee rows.

## 5. Amount correction — safe?

**Yes, while still in Review and not financially locked.**

Production Review already treats amount as a required, operator-correctable OCR field. Ledger triggers fire on INSERT / `claim_id` / `deposited_at` / `status`, not on `UPDATE OF amount`. Generic `/data/write` stays unable to write amount.

## 6. MICR — required during Review?

**No.** `getMissingFields()` does not include routing/account. MICR exists on the historical editor for failed extraction / manual upload and is used later at deposit. Do **not** enable raw MICR on this path.

## 7. Exact UI change

On the Review screen:

- Relabel **Edit Fields** → **Edit Check**
- Keep the existing inline editor (do not mount `CheckAdminEditDialog`; that dialog includes status override)
- On AWS, Save calls `POST /workflow/checks/:id/review-correction` instead of generic write for amount + OCR fields
- Hide MICR inputs on AWS Review (not required; not enabled)
- After Save: invalidate Review queries; status unchanged
- Review decision still uses existing `/workflow/transition` (unchanged state machine)

## 8. Files that change

- `aws/functions/api/review-correction.mjs` (new)
- `aws/functions/api/workflow.mjs` (route)
- `aws/workflows/sql/71_review_correction.sql` (amount DEFINER only)
- `aws/tests/api-review-correction.test.mjs` (new)
- `src/integrations/aws/workflow.ts`
- `src/components/check-review/CheckReviewConsole.tsx`
- `src/components/check-review/CheckAdminEditDialog.tsx` (AWS amount via same endpoint; no status)
- `aws/cutover/REVIEW_CHECK_EDITABLE_2026-09-23.md` (this file)
