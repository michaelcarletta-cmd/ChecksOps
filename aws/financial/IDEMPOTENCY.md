# Financial idempotency

Provider execution is idempotent by default. A repeated click, retry, timeout, or webhook must not create a second financial transaction.

## Stable operation key

```
sha256(tenant_id | operation_type | resource_id | amount_cents | USD)
```

Unique on `aws_financial_operations (tenant_id, idempotency_key)`.

Production Moov already uses `payment_transfers (tenant_id, idempotency_key)` plus `payment_idempotency_keys`. Production CheckAlt uses check + integer-cents amount + reference. Webhooks use unique `(provider, external_event_id)`.

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

Future live execution must persist the idempotency key and any provider reference **before** the HTTP call, then reconcile.
