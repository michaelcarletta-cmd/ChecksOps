# Tranche 5 plan — application workflow completeness

Base: current `main` `2f69698d5e0092b1fdb0289598331aaf592652fa`. Branch `cursor/aws-workflow-tranche-5-c48b`. PR targets `main`. **Do not merge.**

This is **not** approval for money movement. All T4 provider flags stay false.

## Goal

AWS staging can run the remaining **normal ChecksOps application workflows** from new check intake through **READY FOR PROVIDER EXECUTION**, then stop.

## Kill switch

`AWS_APPLICATION_WORKFLOW_WRITES_ENABLED` — only the string `true` enables T5.

Independently disableable. When false:

- T1 reads/writes, T2/T3 check workflow, T3 storage, T4 provider guards continue
- `POST /workflow/*` returns `application_workflow_writes_disabled`
- T5 columns/tables on `/data/write` are denied
- Production and provider flags are unchanged

## Routes

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/workflow/status` | Flag snapshot (no secrets) |
| POST | `/workflow/checks` | Create internal check |
| POST | `/workflow/transition` | Explicit state-machine action |
| DELETE | `/workflow/checks/:id` | Cleanup of unlinked, non-deposited, non-partner checks |

Review RPC `submit_check_review_decision_safe` is intercepted in the AWS client and mapped to `/workflow/transition`. `admin_override_check_status` stays `rpc_disabled`.

## Create-check contract

Server derives:

- `id` (generated UUID)
- `tenant_id` from `tenant_users` membership (browser tenant ignored unless it matches a membership)
- `uploaded_by` = mapped ChecksOps UUID
- `status=uploaded`, `check_stage=review`, `ocr_status=pending`
- placeholder `front_image_path=checks/{id}/pending_front.jpg`

Never persisted from the browser: `user_id`, `tenant_id` (untrusted), `claim_id`, `detected_claim_number`, `external_origin`, `deposited_at`, `status`/`check_stage` overrides, `uploaded_by`.

Optional descriptive fields reuse T2 coercion. Optional `amount` is allowed only because `claim_id` is null (ledger triggers no-op). E2E uses null amount.

Does **not** invoke OCR or CheckAlt.

Frontend AWS path (`CheckUploadForm`): create → upload front/back to `checks/{checkId}/` via existing T3 presign → UPDATE image paths → skip OCR.

## State machine

See `aws/functions/api/workflow-transitions.mjs`. Each action defines from-states, destination, role, financial/provider flags.

Additional server guards:

- `claim_id IS NULL` (ledger)
- not partner-linked (`external_origin.source_app ≠ freedom_crm`)
- not deposited / released
- role: tenant member for create; staff/admin/owner/manager for transitions

## Mortgage / loss-draft

Allowlisted `/data/write` (T5 flag):

- intake UPDATE: `mortgage_monitoring_type`, `mortgage_sent_at`, `mortgage_tracking_number`, `mortgage_received_at`
- `loss_draft_tracking` INSERT/UPDATE of internal metadata
- `mortgage_handling_requests` INSERT/UPDATE of request metadata
- `loss_draft_audit_log` INSERT of notes

Denied: `mortgage_final_released_at`, billing/stripe, amount-released, document-bucket writes, notify/bill edge functions.

## Endorsement boundary

Unchanged from T2/T3: `status` / `signed_at` denied. Packet/email/provider completion stays disabled. Ready-for-deposit is reached via the review machine (`needs_review` or `loss_draft_required` → `approved_for_deposit`), which is existing production semantics when endorsements are not auto-advanced.

## Financial / provider boundary

Still prohibited (T4 unchanged): CheckAlt deposit, Moov transfer, wallet funding, ACH/RTP/wire, disbursement, Actum, QuickBooks, Plaid money, KYC mutation, bank linking, production webhooks.

## Database grants

`aws/workflows/sql/50_tranche5_write_grants.sql` — column-scoped INSERT/UPDATE/DELETE only. No GRANT on financial tables. No generic SQL. RLS remains the authorization boundary.

## Tests

- Unit: `aws/tests/api-workflow.test.mjs` plus existing T1–T4 suites
- Live: `scripts/aws-workflow-tranche5-validate.mjs` (synthetic Freedom check E2E, isolation, spoof, invalid transition, provider deny, cleanup, financials)
- Regression: T3 27-case and T4 20-case live scripts

## Stop condition

Stop when AWS staging can take a synthetic check from intake through READY FOR PROVIDER EXECUTION with **zero** external financial/provider calls. Do not begin provider execution, webhook cutover, DNS, or production cutover.
