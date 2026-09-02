# Tranche 5 results

Branch `cursor/aws-workflow-tranche-5-c48b`. PR targets `main`. **Do not merge.**

Production ChecksOps, production DNS, production frontend, production Supabase, and production provider webhooks were **not** touched.

Live staging API: `https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging`

Results of unit tests, live E2E, financial reconciliation, and T1–T4 regression will be filled after deploy and validation.

## Implementation (pre-live)

| Layer | Location |
| --- | --- |
| Flag | `AWS_APPLICATION_WORKFLOW_WRITES_ENABLED` in `workflow-flags.mjs` |
| State machine | `workflow-transitions.mjs` |
| Routes | `POST /workflow/checks`, `POST /workflow/transition`, `DELETE /workflow/checks/:id`, `GET /workflow/status` |
| Mortgage / loss-draft DML | T5 allowlist in `write-allowlist.mjs` |
| Grants | `aws/workflows/sql/50_tranche5_write_grants.sql` |
| Frontend | AWS create-first upload; review RPC → `/workflow/transition` |

Provider flags remain **false**. `AWS_PROVIDER_WEBHOOK_DRY_RUN=true`.
