# Reconciliation

`POST /financial/reconcile` compares internal operations to an observed provider snapshot and **reports** findings.

It never updates `checkalt_deposits`, `payment_transfers`, wallets, or disbursement tables. `auto_corrected` is constrained `false`.

## Finding types

| Type | Meaning |
| --- | --- |
| `internal_pending_provider_succeeded` | internal `submitting`/`provider_pending`, provider completed |
| `internal_succeeded_provider_missing` | internal confirmed, provider row missing |
| `amount_mismatch` | integer-cents differ |
| `duplicate_provider_transaction` | same provider reference observed twice |
| `unknown_provider_transaction` | provider row with no internal operation |
| `stale_pending` | pending longer than 15 minutes |

## Sources in this phase

- Internal: `aws_financial_operations`
- Provider: simulated snapshot on the operation metadata, plus optional `extra_provider_txns` for fixture tests
- Live Moov/CheckAlt list APIs are **not** called

## Production (not executed)

A later activation would add read-only provider GETs behind `AWS_PROVIDER_LIVE_READS_ENABLED` and still report-only until a separate correction phase is approved.
