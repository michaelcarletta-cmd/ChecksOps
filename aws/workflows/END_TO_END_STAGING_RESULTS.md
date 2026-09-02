# End-to-end AWS staging results (Tranche 5)

Live API: `https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging`  
Script: `scripts/aws-workflow-tranche5-validate.mjs`  
Marker: `AWS T5 TEST 1788392329105`  
Check: `6220efe6-8172-4825-bd51-62f626423204` (Freedom tenant `2eff5f1a-929d-4ce3-9a8b-cd96b98df42a`)  
Result: **26/26 PASS**. Check deleted after the run.

## Path taken

| Step | Result |
| --- | --- |
| `GET /workflow/status` | T5 true; all provider flags false; webhooks not redirected |
| Unauthenticated `POST /workflow/checks` | **401** `missing_cognito_token` |
| Freedom create with spoofed `tenant_id`/`user_id`/`claim_id`/`x-tenant-id` | **200**; tenant = Freedom; `claim_id` null; `uploaded`; OCR not invoked; provider not submitted |
| `mark_ready_for_deposit` from `uploaded` | **403** `invalid_transition` (skip denied) |
| C1C `GET` that check | empty (cannot read Freedom row) |
| C1C `start_review` on that check | **403** `rls_denied` |
| `POST /storage/upload-url` `checks/{id}/aws-t5-test-front.jpg` | **200** |
| Presigned PUT | **200** |
| Intake image path + descriptive UPDATE | **200** |
| Payee INSERT (`insured`) | **200** |
| Note INSERT | **200** |
| `start_review` | `needs_review` / `review` |
| `start_endorsing` | `endorsements_in_progress` / `endorsing` |
| `return_to_review` | `needs_review` |
| Mortgage monitoring `monitored` | **200** |
| `mortgage_handling_requests` insert | **200**; `requested_by` = mapped Freedom UUID |
| `route_loss_draft` | `loss_draft_required` / `loss_draft`; tracking row auto-created |
| Loss-draft notes / loan | **200** |
| Browser `status=signed` / `signed_at` | **403** `column_not_allowlisted` |
| `mark_ready_for_deposit` | `approved_for_deposit` / `ready_for_deposit`; `readyForProviderExecution=true`; `providerExecution=false` |
| `mark_deposited` | **403** `financial_or_provider` |
| `POST /functions/v1/checkalt-submit-deposit` | **403** `provider_disabled` |
| `DELETE /workflow/checks/:id` | **200** `cleanedUp=true` |
| Subsequent read | not visible |

## Isolation

- Freedom workflow succeeded on a Freedom-owned synthetic check.
- C1C could not read or transition that check.
- Spoofed C1C tenant / user headers and body fields were ignored; ownership came from Cognito → `identity_accounts` → Freedom membership.
- Ninth UUID was not used as an actor. Oneshot ninth INSERT was RLS-denied.

## Financial

Create used **null amount** and **null claim_id**, so `check_intake_amount` and `homeowner_ledger_amount` never moved. After cleanup, aggregates matched the T4 baseline exactly (see `TRANCHE_5_RESULTS.md`).

## Provider

Zero live provider calls. CheckAlt submit and deposited transition were denied. Production webhooks were not redirected.

## Intentionally not executed

OCR, claim linkage, partner-mirrored Freedom HTTP, signature completion/email, CheckAlt deposit, Moov/ACH/RTP/wire, disbursement.
