# M6.4F.1 — Post-initiation read-only verification

**STOP FOR REVIEW.** Do not submit an MV code. Do not initiate another
microdeposit. Do not POST `/verify`. Do not enable money flags. Do not move money.

Michael clicked **Send verification deposit** once. This phase is GET-only
proof that the claim, Moov `/verify`, session, and money holds are correct for
a later human MV confirmation.

## Live reads (no provider POST)

`action=preflight_target` remains GET-only: Dynamo `GetItem` of
`CLAIM#{recipient}#{account}#{bank}` / `STATE` plus Moov GET account / banks /
bank / `/verify` / payment-methods. Probe overlay after this phase only added
report fields from that same `GetItem` (idempotency / binding). No Put/Update/
Delete. Never POST `/verify`.

CodeSha256 after the report-field overlay:
`ZJsY9c2HBHmBLsri4U8Yq0mbUg/j/eupd0YlbBJ1AmM=`. Env keys still 32.
`AWS_PROVIDER_RECIPIENT_BANK_VERIFY_WRITES_ENABLED=true`. Money flags **false**.

## DynamoDB real-target claim

| Field | Value |
|---|---|
| pk | `CLAIM#62a858ff-ee6a-49d7-9898-1c8e4a44227b#ee8c608e-dc2d-45d3-95e9-3c992f3dfc5f#72eb66c1-d9a9-4f85-ab50-8871db9ceeea` |
| exists | **true** (exactly one item for this pk+sk) |
| state | `verification_pending` |
| claimant_id | `2a4931a2-02ca-4c6a-9d1d-cf8f346b4631` (one) |
| claimed_at | `1789322986616` (2026-09-13T18:09:46Z) |
| recipient_id / account_id / bank_id | exact target |
| idempotency_key | `checksops-recipient-bank-verify:62a858ff-ee6a-49d7-9898-1c8e4a44227b:72eb66c1-d9a9-4f85-ab50-8871db9ceeea` |
| matches formula | **true** |
| token_fp | `9acf164e4c0a69d6` (same pay-setup token as M6.4C/F, sha12 `9acf164e4c0a`) |

## Moov

| Check | Result |
|---|---|
| Bank | same id, Chase ••••1506, **status `pending`** (was `new`) |
| Banks on account | 1 |
| `/verify` | HTTP **200** (was 404) |
| verification status | `sent-credit` |
| verification method | `instant` |
| initiated | **true** |
| should_initiate | **false** |
| can_confirm | **true** |
| verified | false |

## Duplicate initiation

CloudFront logs 2026-09-13 16h–18h UTC:

- 2× POST initiate from this agent’s dummy/money proofs: **404** and **403** (Python-urllib; not the real token)
- **1×** POST initiate **200** at `18:09:48Z` from the live pay-setup URL (Michael)
- **0×** POST confirm

CAS on the single claim pk cannot insert a second real-target claim.

## Session / DB / flags

Session HTTP 200, `token_consumed=false`:
`bank_verify_available=true`, `bank_micro_deposits_initiated=true`,
`bank_can_confirm=true`, `bank_should_initiate=false`, `complete=false`.
UI should show Confirm / MV code, not Send.

db-bridge still `read_only`. `payment_transfers=0`. Target
`awaiting_bank`, `token_used_at=null`. Binding unchanged.

Bank-verify flag stays **true** for the later human MV confirmation.

## Holds

Do not submit or request the MV code.
Do not click Confirm.
Do not initiate again.
Do not enable Moov / CheckAlt / provider execution / financial-permissions /
sandbox-execution.
