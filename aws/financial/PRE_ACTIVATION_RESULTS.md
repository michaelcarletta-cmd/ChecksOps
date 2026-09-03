# Financial pre-activation results

Branch `cursor/aws-financial-preactivation-c48b` from current `main` `2645d9c54a539ed6981597b3f575428553550b6b` (PR #98 / T5).

**Production was not touched. No production provider transaction occurred.**

Master guard remains `AWS_PROVIDER_EXECUTION_ENABLED=false`. All production provider flags remain false. Financial permissions remain deactivated.

Staging simulation flag (staging Lambda only): `AWS_FINANCIAL_SANDBOX_SIMULATION_ENABLED=true`.

## Implementation

| Layer | Location |
| --- | --- |
| Flags | `aws/functions/api/financial-flags.mjs` |
| Auth gate | `aws/functions/api/financial-authz.mjs` |
| Amounts | `aws/functions/api/providers/amounts.mjs` |
| State machine | `aws/functions/api/financial-state.mjs` |
| Idempotency | `aws/functions/api/financial-idempotency.mjs` |
| Ownership | `aws/functions/api/financial-ownership.mjs` |
| Audit | `aws/functions/api/financial-audit.mjs` |
| Reconciliation | `aws/functions/api/financial-reconciliation.mjs` |
| Router | `aws/functions/api/financial.mjs` |
| SQL | `aws/financial/sql/60_financial_preactivation.sql` |

## Historical regression update

`scripts/aws-write-tranche2-validate.mjs` now expects T3-approved `check_messages` INSERT (zero-amount `ops_note` ledger mirror) instead of the obsolete T2 403. Financial table denials, spoof denials, and provider guards are unchanged.

## Unit tests

Pending live recording in this file after `node --test aws/tests/api-financial.test.mjs` and T1–T5 suites.

## Live staging

Pending after Lambda overlay + oneshot grants.

## Production activation

Runbook written. **Not executed.**
