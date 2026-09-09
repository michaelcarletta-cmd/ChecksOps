# Financial idempotency

Provider execution is idempotent by default. A repeated click, retry, timeout, or webhook must not create a second financial transaction.

## Stable operation key

```
sha256(tenant_id | operation_type | resource_id | amount_cents | USD)
```

Unique on `aws_financial_operations (tenant_id, idempotency_key)`.

Production Moov already uses `payment_transfers (tenant_id, idempotency_key)` plus `payment_idempotency_keys`. Production CheckAlt (dark path, this phase) uses `checkalt_deposits (tenant_id, idempotency_key)` with key `sha256(tenant_id|checkalt_deposit|check_id|amount_cents|USD)`. Before inserting a new row, submit also loads every `checkalt_deposits` row for `tenant_id + check_intake_item_id`. Legacy production rows (NULL `idempotency_key`) that already have a `checkalt_reference`, `provider_http_attempted_at`, or a submitted/pending/cleared/error state **block** a second `POST /fincapture/deposit/process`. The 58 restored production rows are not rewritten in this phase. The new-key row is committed **before** process HTTP. `provider_http_attempted_at` is claimed with a compare-and-set so simultaneous Lambda/browser retries cannot POST twice. If HTTP was attempted and RDS update failed, status stays `submitting` and poll reconciles by `checkalt_reference` only — never by amount, never a second process POST. History amount is not a transaction identifier; FinCapture process does not send a ChecksOps check id. SQL `65_checkalt_production_writer.sql` is **NOT APPLIED**. Webhooks use unique `(provider, external_event_id)`.

## Tested cases

| Case | Expected |
| --- | --- |
| Same prepare twice | `duplicate=true`, same operation id |
| Parallel identical submits | one row; second is replay |
| Client timeout + retry | replay of in-flight or confirmed row |
| Lambda retry | same idempotency key, no second insert |
| Provider timeout | `provider_failed` / retry uses same key |
| Duplicate webhook | `duplicate=true`, `applied=false` |
| Out-of-order webhook | ignored; state unchanged |

## Dangerous case

Provider accepted **and** internal update failed:

- Operation stays `submitting`
- `provider_reference` is stored when known
- `failure_class=db_after_provider`
- Recovery: `/financial/reconcile` reports `internal_pending_provider_succeeded`
- **Do not** create a second provider call
- **Do not** auto-correct the ledger

Future live execution must persist the idempotency key and any provider reference **before** the HTTP call, then reconcile. The dark production CheckAlt adapter does this in application code; live RDS unique enforcement waits for SQL 65.
