# Failure recovery

All classes below are **simulated**. No live provider HTTP is issued.

| Class | Internal result | Recovery |
| --- | --- | --- |
| provider 400 | `provider_failed` | fix request; new logical op only if key fields change |
| provider 401 | `provider_failed` | secrets/config; do not retry blindly |
| provider 409 | `provider_failed` or replay | treat as possible duplicate; lookup by idempotency |
| provider 429 | `provider_failed` | backoff, same key |
| provider 500 | `provider_failed` | retry same key after probe |
| provider timeout | `provider_failed` or pending + reconcile | assume the call may have been accepted |
| Lambda timeout | same as provider timeout | Lambda retry must be idempotent |
| DB failure **before** provider | 503, no provider reference | safe retry |
| DB failure **after** provider | `submitting` + `provider_reference` + `reconciliation_needed` | reconcile; never second submit |
| Webhook delay | stay `provider_pending` | wait / poll later (poll still disabled) |
| Duplicate webhook | ignored | none |
| Return | `returned` | notify; do not auto-re-disburse |
| Reversal | `reversed` | notify; recon report |

## Provider accepted / DB update failed

Deterministic recovery:

1. Persist idempotency key before any future live HTTP.
2. If HTTP returns a provider id, write `provider_reference` even if later columns fail.
3. Reconciliation compares internal vs provider snapshot (sandbox: `metadata.simulated_provider`).
4. Finding `internal_pending_provider_succeeded` is reported, not auto-corrected.
5. A human later confirms the provider object and applies a single state transition.

This phase does not auto-correct production or staging money ledgers.
