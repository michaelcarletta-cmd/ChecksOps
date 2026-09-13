# M6.4F.2 — Final post-verification read-only proof

**STOP FOR REVIEW.** Do not submit another MV code. Do not initiate again.
Do not enable Moov transfers / provider execution / financial-permissions /
CheckAlt. Do not change Cognito/TOTP. **Do not change any flags in this phase.**

Michael entered the MV code and clicked Confirm bank once. The UI showed
“Setup is complete. You can close this page.”

This phase is GET-only: Dynamo `GetItem` of the real claim key, Moov GETs,
session load, db-bridge, CloudFront access logs. No Put/Update/Delete. No POST
`/verify`. No flag change.

## Moov + Dynamo

| Check | Result |
|---|---|
| KYC | `verified` |
| ToS | accepted `2026-09-12T17:37:31.697535Z` on account `ee8c608e-…` |
| Bank | same id, Chase ••••1506, **status `verified`** |
| Banks on account | 1 |
| `/verify` | HTTP 200, status `successful`, method `instant` |
| DDB pk | `CLAIM#{recipient}#{account}#{bank}` exists |
| DDB state | **`verified`** |
| DDB ttl | **`null`** (no expiry on verified) |
| claimant_id | same as initiation (`2a4931a2-…`) |
| claimed_at | 2026-09-13T18:09:46Z (Send) |
| updated_at | 2026-09-13T18:25:14Z (Confirm) |
| idempotency_key | matches `checksops-recipient-bank-verify:{recipient}:{bank}` |
| payment_method_count | 5 (Moov methods on the bank, **not** transfers) |

## Counts

CloudFront 2026-09-13 17h–19h UTC:

- Initiate: one real **200** (Michael Send); plus this agent’s dummy 404/403
- Confirm: **one 200** at 18:25:15Z from iPhone, live pay-setup referer
- No second real initiate or confirm

## Session / DB / flags

Session HTTP 200, `token_consumed=false`, recipient status **`ready`**:
`complete=true`, `bank_verified=true`, `bank_status=verified`,
`bank_verification_status=successful`, `bank_can_confirm=false`.

db-bridge `read_only`. Target `onboarding_status=ready`, `token_used_at=null`.
`payment_transfers=0`. Binding unchanged.

Live Lambda env (32 keys, **not mutated this phase**):
`AWS_PROVIDER_RECIPIENT_BANK_VERIFY_WRITES_ENABLED=true`.
Moov / execution / financial-permissions / sandbox-execution / CheckAlt
**false**. `liveProviderTransactions=false`.

## Flag recommendation (not applied)

Onboarding is complete. The narrow bank-verify writes flag **should now be
returned to false** so a later stray Send/Confirm cannot POST `/verify` again.
Do **not** flip it in this phase. Do **not** enable transfer flags.

Recipient onboarding is complete. Controlled Moov transfer is a **later**
reviewed phase. Money execution flags stay false.

## Holds

Do not change any flags here.
Do not submit an MV code or initiate.
Do not move money.
