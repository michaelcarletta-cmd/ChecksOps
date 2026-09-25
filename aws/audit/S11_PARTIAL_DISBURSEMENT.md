# S11 Partial Disbursement — Phase 1 determination

**Date:** 2026-09-25  
**S2/S3/S4/S5:** CLOSED / PRODUCTION PASS. Not reopened.  
**S14:** later unresolved item. Not started.  
**Production:** frozen at `4nRr0xh9SelxDuMAzNmgbbpWAaiWmPOgtiN14DkDXgM=`. Not modified.  
**Target:** AWS staging `https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging`  
**No remediation implemented.**

## Requirement

A check that has taken money in must allow an authorized operator to disburse **part** of the available balance, then disburse the **remainder**, with:

`Money In − successful Money Out = remaining`

The adversarial scenario (Phase 1 harness `scenario11` + remainder math) is:

1. Sandbox-confirm a $200 deposit.
2. Attempt a $50 browser/client amount.
3. Perform a first successful partial out.
4. Perform a second successful out of the remainder.
5. Prove failed/cancelled ops do not reduce remaining.
6. Prove retry does not create a second provider effect or erase the first.

A partial must not cause over-disbursement, duplicate disbursement, an incorrect remaining balance, premature fully-disbursed completion, loss of prior disbursement history, or a retry/idempotency hole.

## Exact code paths

Current AWS staging money path for this scenario is the **sandbox financial API**, not live Moov/CheckAlt and not generic `/data/write`.

| Path | Role |
| --- | --- |
| `POST /financial/prepare` → `handlePrepare` in `aws/functions/api/financial.mjs` | Rejects browser amounts, resolves server amount, inserts `aws_financial_operations` |
| `rejectUntrustedAmountFields` in `aws/functions/api/providers/amounts.mjs` | `400 untrusted_amount` if `amount`, `amount_cents`, `amountCents`, `userAmount`, `value`, `valueDecimal`, or `net_amount_cents` is present |
| `resolveServerAmount` in `financial.mjs` | Always `check_intake_items.amount` (or $123.45 fixture). No remaining-balance source |
| `stableIdempotencyKey` in `aws/functions/api/financial-idempotency.mjs` | `sha256(tenant\|operation_type\|check_id\|amount_cents\|USD)` — no disbursement sequence |
| `POST /financial/simulate-submit` / `simulate-webhook` / `simulate-failure` | Sandbox state only. `liveProviderCalled=false` |
| `FINANCIAL_OR_PROVIDER_TABLES` in `aws/functions/api/write-allowlist.mjs` | `disbursement_batches` / `disbursement_splits` / `claim_disbursements` are `403 table_not_allowlisted` / `financial_or_provider` |
| `POST /functions/v1/checkalt-submit-deposit` | `403 checkalt_mutation_blocked` |
| `POST /functions/v1/moov-transfer-create` | Current-request validation; `AWS_MOOV_TRANSFER_POST_ENABLED=false` |

`moov-disburse` / batch-split execution is out of this S11 determination. It was not invoked and would be a live-provider path.

## Staging test scenario

Synthetic Freedom check `033da586-d764-4852-a0ba-a39c8473ef52`, amount `$200`, marker `AWS S11 IDENTIFY S11ID-1790340169279`. Official harness `PHASE1_SCENARIOS=11` was also re-run. Both cleaned up.

Staging flags: `AWS_PROVIDER_EXECUTION_ENABLED=false`, `AWS_MOOV_ENABLED=false`, `AWS_CHECKALT_ENABLED=false`, `AWS_MOOV_TRANSFER_POST_ENABLED=false`, `AWS_FINANCIAL_SANDBOX_SIMULATION_ENABLED=true`, `liveProviderTransactions=false`.

## Observed behavior

Protections **fail closed**. The required two-partial remainder path **does not exist**.

| Question | Observed |
| --- | --- |
| Over-disbursement via two partials? | **Cannot express.** Client amounts rejected. Omitted amount is always 20000 cents. Second `disbursement` prepare replays op `c08de4df-252d-4cef-a96e-43d2c9ddf440`. |
| Duplicate disbursement? | **No.** Replay `duplicate=true`, same id, same cents, including after `transfer.completed`. |
| Incorrect remaining balance? | **Not computed.** There is no remaining-balance field or API. Failed `pay_homeowner` stayed `provider_failed` and did not confirm money out. |
| Premature fully-disbursed? | **No.** Check stayed `status=uploaded`, `deposited_at=null`, amount `200`. Confirming the sandbox disbursement did not rewrite check stage. |
| Loss of prior history? | **No.** Confirmed op row is reused; amount/status preserved. |
| Retry / idempotency hole? | **No on this path.** Key is full-check amount, so retries cannot open a second `disbursement` row. |

A `pay_homeowner` prepare is a **different** `operation_type`, so it gets a different idempotency key and a second full-amount row (`fd0bf6ea-…`, 20000 cents). That is not a partial; it was failed (`provider_failed`) and cleaned up. It is noted only to show there is still no remaining-balance subtraction across operation types.

## Evidence

Identify run 24/24. Official harness S11 7/7 with finding `S11-NO-PARTIAL-AMOUNT-API` (WORKFLOW-RISK). Synthetic check and 3 sandbox ops deleted. No leftover.

- Browser `amount_cents=5000` → `400 untrusted_amount`
- Generic `/data/write` `disbursement_splits` / `disbursement_batches` → `403 table_not_allowlisted`
- Full prepare → 20000, `amount_source=check_intake_items.amount`
- Replay before and after confirm → same operation id
- CheckAlt → `403 checkalt_mutation_blocked`
- Moov create without recipient → `400 A recipient is required.`, `liveProviderCalled=false`

## S11 status: FAIL

**FAIL** as a Phase 1 acceptance item (WORKFLOW-RISK). Not a demonstrated BLOCKER or MONEY-RISK. Not BLOCKED — the gap is determined.

The original audit called this “PASS with gap” because no incorrect money movement was shown. The required S11 remainder scenario still cannot be performed on current staging.

## Smallest required remediation (not implemented)

Do **not** accept browser amounts. Do **not** allowlist `disbursement_splits` on `/data/write`. Do **not** reopen S2–S5.

Add a server-derived remaining-balance amount source for disbursement-family prepares:

`remaining = confirmed money in − confirmed money out` for that check (failed/cancelled/replayed rows count as 0 out).

Use that remaining amount (or a server-capped requested partial that cannot exceed remaining) as `amount_cents`, and include a disbursement sequence (or remaining snapshot) in `stableIdempotencyKey` so a second remainder prepare is a new operation instead of a replay of the first full-amount row.

## Production

Untouched. SHA still `4nRr0xh9SelxDuMAzNmgbbpWAaiWmPOgtiN14DkDXgM=`, LastModified `2026-09-25T12:25:20.000+0000`.

## S11 PARTIAL DISBURSEMENT: FAIL
