# Financial state machine

Provider-confirmed states are not writable from the browser. T5 already forbids mutating `check_intake_items.status` to `deposited` or any provider destination.

This machine governs **provider operations** stored on `aws_financial_operations`. It uses ChecksOps-aligned names.

## States

| State | Meaning | CheckAlt analog | Moov analog |
| --- | --- | --- | --- |
| `ready_for_provider` | Server prepared; T5 check is `approved_for_deposit` when applicable | ready | `ready` |
| `submitting` | Server is (or would be) calling the provider | local only | local only |
| `provider_pending` | Provider accepted; not confirmed | `submitted` / `pending_approval` | `created` / `pending` |
| `provider_confirmed` | Provider confirmed via webhook | `cleared` / `approved` | `completed` |
| `settled` | Funds settled / available | `settled` | `settled` |
| `provider_failed` | Provider or simulated HTTP failure | `rejected` | `failed` |
| `returned` | Return after submit/clear | `returned` | `returned` |
| `reversed` | Reversal after confirm | n/a | `reversed` |
| `cancelled` | Cancelled before confirm | n/a | `canceled` |

## Allowed transitions

```
(none) → ready_for_provider          prepare
ready_for_provider → submitting      simulate-submit
submitting → provider_pending        provider accepted
provider_pending → provider_confirmed  webhook
provider_confirmed → settled         webhook
*inflight* → provider_failed         provider 4xx/5xx/timeout
provider_pending|confirmed|settled → returned
provider_confirmed|settled → reversed
ready|submitting|pending → cancelled
```

Illegal jumps (example: browser `ready_for_provider` → `provider_confirmed`) are rejected.

## Actors

| Action | Actor |
| --- | --- |
| prepare / submit / cancel | server, after financial gate |
| provider_confirmed / settled / returned / reversed | webhook (synthetic sandbox or future signed provider webhook) |
| fail | server (simulated HTTP) or webhook |

Production-style webhooks remain T4 dry-run (`applied=false` on financial ledgers). Sandbox synthetic webhooks may update **only** `aws_financial_operations` after:

- authenticated mapped user (synthetic route) or verified signature (T4 route)
- event mapped to a known staging operation / provider account
- idempotent `external_event_id`
- tenant derived from the operation row, never from payload `tenant_id`
- event expected by this machine
