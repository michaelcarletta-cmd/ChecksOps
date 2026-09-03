# Provider sandbox validation results

Branch `cursor/provider-sandbox-validation-c48b` from current `main` `8b53297672aec5ee80617675b702ab8c617dbc95` (PR #99 merge).

**Production was not touched. No production provider transaction occurred.**

Master guard remains `AWS_PROVIDER_EXECUTION_ENABLED=false`. All production provider flags remain false. Financial permissions remain deactivated. Sandbox HTTP uses `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED` only.

Live results will be recorded after staging overlay + T1–T6 regression.

## Capability (pre-live)

| Provider | AWS sandbox available | Real HTTP |
| --- | --- | --- |
| Moov | No `MOOV_SANDBOX_*` in `checksops/staging/providers` | Fail-closed |
| CheckAlt | No FinCapture sandbox URL/credentials | Fail-closed; no negotiable check |
| Plaid | No sandbox keys; not on money path | Fail-closed |

## Cutover

**NO-GO.** See `PRODUCTION_ACTIVATION_RUNBOOK.md`.
