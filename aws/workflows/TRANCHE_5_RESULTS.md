# Tranche 5 results

Branch `cursor/aws-workflow-tranche-5-c48b` from current `main` `2f69698d5e0092b1fdb0289598331aaf592652fa`. **PR #98** targets `main`. Do not merge.

Production ChecksOps, production DNS, production frontend, production Supabase, and production provider webhooks were **not** touched.

Live staging API: `https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging`  
Lambda `checksops-staging-api` updated in place (`UpdateFunctionCode` + env). Thin `aws/template.yaml` was **not** SAM-deployed.

Temporary admin oneshot `checksops-staging-tranche5-grants-c48b` applied `50_tranche5_write_grants.sql`, captured financials, then the function and IAM role were **deleted**.

## Implementation

| Layer | Location |
| --- | --- |
| Flag | `AWS_APPLICATION_WORKFLOW_WRITES_ENABLED` (`workflow-flags.mjs`). Only the string `true` enables. Independent of T1–T4. |
| State machine | `workflow-transitions.mjs` |
| Routes | `GET /workflow/status`, `POST /workflow/checks`, `POST /workflow/transition`, `DELETE /workflow/checks/:id` |
| Mortgage / loss-draft DML | T5 allowlist in `write-allowlist.mjs` + `write-check-workflow.mjs` |
| Grants | `aws/workflows/sql/50_tranche5_write_grants.sql` |
| Frontend | AWS create-first upload in `CheckCommandCenter`; review RPC → `/workflow/transition` |

## Flags on live Lambda

`AWS_APPLICATION_WORKFLOW_WRITES_ENABLED=true`  
`AWS_WRITES_ENABLED=true`  
`AWS_CHECK_WORKFLOW_WRITES_ENABLED=true`  
`AWS_STORAGE_WRITES_ENABLED=true`  
`AWS_PROVIDER_EXECUTION_ENABLED=false`  
`AWS_MOOV_ENABLED=false`  
`AWS_CHECKALT_ENABLED=false`  
`AWS_PLAID_ENABLED=false`  
`AWS_ACTUM_ENABLED=false`  
`AWS_QUICKBOOKS_ENABLED=false`  
`AWS_PROVIDER_LIVE_READS_ENABLED=false`  
`AWS_PROVIDER_WEBHOOK_DRY_RUN=true`

Deployed `CodeSha256`: `oTq77l8FTM+Thh9fx8aPLTmt5EWoucEJL7cco3zkTCI=`

## Unit tests

`node --test aws/tests/*.test.mjs`: **120/120 PASS** (T1–T4 suite plus 11 new T5 cases).

## Live validation

`scripts/aws-workflow-tranche5-validate.mjs`: **26/26 PASS**

Synthetic Freedom check `6220efe6-8172-4825-bd51-62f626423204` walked create → image → payee → note → review → endorsing → return → mortgage metadata → loss-draft → **approved_for_deposit / ready_for_deposit**, then deleted.

See `END_TO_END_STAGING_RESULTS.md`.

## Regression

| Suite | Result |
| --- | --- |
| T3 live `aws-write-tranche3-validate.mjs` | **27/27** |
| T4 live `aws-provider-tranche4-validate.mjs` | **20/20** |
| T2 live `aws-write-tranche2-validate.mjs` | 29/30 — the single fail is **pre-existing vs T3**: the T2 script still asserts `check_messages` INSERT is denied; T3 enabled that insert. Not a T5 change. |
| Combined unit | **120/120** |

## Financial reconciliation

`28_financial_aggregates.sql` before grants, after grants, and after E2E cleanup — **identical** to the T2/T4 baseline:

| Metric | Value |
| --- | --- |
| `homeowner_ledger_amount` | **2977337.23** |
| `check_intake_amount` | **1317000.53** |
| `checkalt_deposits_amount` | **380333.17** |
| `payment_transfers_amount_cents` | **0** |
| `claim_payments_amount` | **66003.92** |
| `deposit_items_amount` | **963972.98** |
| `deposit_batches_total_amount` | **964752.98** |

Ninth UUID insert via oneshot was RLS-denied. No financial/provider table received INSERT/UPDATE/DELETE grants.

## Provider / production

No real Moov, CheckAlt, Plaid, Actum, or QuickBooks HTTP call.  
`productionWebhooksRedirected=false`.  
Production was not touched.

## Remaining on Supabase / later

Claim linkage on create (ledger amounts), partner-mirrored status (Freedom HTTP), signature completion/email, OCR, cash-job/shared-check intake, `loss-draft-documents` bucket writes, `check_intake_mortgage_draws` amounts, tenant admin, branding, production cutover.
