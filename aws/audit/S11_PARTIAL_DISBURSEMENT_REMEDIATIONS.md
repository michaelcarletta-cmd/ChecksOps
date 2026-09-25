# S11 partial disbursement — staging remediations

**Date:** 2026-09-25  
**Scope:** Staging Lambda overlay only. No production deploy.  
**S2/S3/S4/S5:** CLOSED, not reopened. **S14:** not started.

## Requirement

`Money In − successful Money Out = Remaining Available Balance`, with authorized partials and remainder draws that cannot over-disburse, duplicate, trust browser amounts, or lose history.

## Authoritative remaining-balance formula

```
confirmed_in  = sum(amount_cents) where operation_type = checkalt_deposit
                and status in (provider_confirmed, settled)
confirmed_out = sum(amount_cents) where operation_type in
                (disbursement, pay_homeowner, pay_contractor, pay_vendor, ach, rtp, wire)
                and status in (provider_confirmed, settled)
remaining     = max(0, confirmed_in - confirmed_out)
reserved_out  = sum of the same money-out types in
                ready_for_provider | submitting | provider_pending
available     = max(0, remaining - reserved_out)
fully_disbursed = confirmed_in > 0 AND remaining = 0
```

Failed, cancelled, rejected, returned, and reversed money-out rows contribute **$0** to `confirmed_out`. Remaining never goes negative.

`check_intake_items.amount` is not remaining after the first successful disbursement.

## Partial request

`requested_partial_cents` is a request, not financial state. `rejectUntrustedAmountFields` is unchanged; `amount_cents` / `amount` remain `400 untrusted_amount`.

Server requires `0 < requested_partial_cents <= remaining` and `<= available`.

## Idempotency

Money-out key is `sha256(tenant|operation_type|check_id|seq:N|USD)`.  
Two legitimate $50 partials use sequences 1 and 2. Retry of sequence 1 replays the original row.

An omitted request (remainder draw) without a sequence replays an in-flight remainder draw of that operation type, otherwise creates the next sequence for `available`.

## Concurrency

`pg_advisory_xact_lock(hashtext(check_id))` inside the existing write transaction, then remaining/available is computed and the row is inserted. Unique `(tenant_id, idempotency_key)` treats a same-sequence race as replay.

## Schema

None. Sequence and draw kind live in `aws_financial_operations.metadata`.

## Files

- `aws/functions/api/financial-remaining.mjs`
- `aws/functions/api/financial.mjs`
- `aws/functions/api/financial-idempotency.mjs`
- `aws/tests/financial-remaining.test.mjs`
- `aws/tests/api-financial.test.mjs`
- `scripts/aws-s11-partial-disbursement-accept.mjs`
- `scripts/aws-overlay-staging-api.mjs`
- `aws/audit/S11_PARTIAL_DISBURSEMENT.md`
- `aws/audit/S11_PARTIAL_DISBURSEMENT_REMEDIATIONS.md`

## Staging Lambda SHA

| | Value |
| --- | --- |
| Before | `P8eTuIEr7GNEiwLC5og1ba8Ajp06kTPUvlSstBCYfzI=` |
| After | `jSjcGOr9efEuixUEKSU3WSdHsc+Nmd7P21cRaRi0zBk=` |
| LastUpdateStatus | Successful |
| Overlay | `financial.mjs`, `financial-remaining.mjs`, `financial-idempotency.mjs` |

## Staging acceptance

`scripts/aws-s11-partial-disbursement-accept.mjs` — 18/18 PASS. Synthetic checks `d9602621-…` and race check deleted. 7 sandbox ops cleaned.

| # | Case | Result |
| --- | --- | --- |
| 1 | Confirmed Money In = $200 | PASS |
| 2 | First partial = $50 | PASS `872d2676-…` |
| 3 | Remaining = $150 | PASS |
| 4 | Retry same sequence no duplicate | PASS |
| 5 | Second $50 leaves $100 | PASS `0618a012-…` |
| 6 | Failed pay_homeowner does not reduce $100 | PASS |
| 7 | $100 remainder leaves $0 | PASS `924e2198-…` |
| 8 | All three successful partials in history | PASS |
| 9 | fully_disbursed only at remaining 0 | PASS |
| 10 | $100.01 denied | PASS `409 exceeds_remaining` |
| 11 | Zero/negative/malformed denied | PASS |
| 12 | Concurrent $50 vs $50: one created, one 409 | PASS |
| 13 | `/data/write` splits/batches denied | PASS |
| 14 | `amount_cents` still untrusted | PASS |
| 15 | Sandbox/non-live flags | PASS |

## Regressions

- S2/S3/S4 harness `PHASE1_SCENARIOS=2,3,4`: 26/26 PASS. Three Ready/billing leftovers retained (`7dc2e538`, `037fd0e8`, `a4f00f74`), not force-deleted.
- S5 smoke: generic `claim_id` write still `403 column_not_allowlisted`; `admin_set_check_claim` noop still works; C1C denied. Synthetic check deleted.

## Production

**Promoted 2026-09-25.** See `S11_PRODUCTION_PROMOTION.md`.

| | Value |
| --- | --- |
| Production SHA before | `4nRr0xh9SelxDuMAzNmgbbpWAaiWmPOgtiN14DkDXgM=` |
| Production SHA after | `dplSPx8YJoYbkolr2c6mKersDAV7OCzHt5y3UyIOdoc=` |

## Promotion

Promoted by overlaying the three accepted financial files onto live `checksops-production-prep-api`. Staging zip was not deployed. No SQL. S14 not started.

## S11 PARTIAL DISBURSEMENT STAGING REMEDIATIONS: PASS
