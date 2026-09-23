# Moov production activation readiness — 2026-09-23

Readiness only. No architecture. No Moov rebuild. No CheckAlt
change. No money movement. Execution flags were not enabled.

Verdict:

**MOOV PRODUCTION ACTIVATION — PENDING EXTERNAL/REAL INPUT**

That is not a failure. Payment method and capability snapshots
were stale and are now reconciled. The Freedom production wallet
is still `$0.00` at the provider.

## A. Current production baseline

Live read-only confirm:

| Item | Live value |
|---|---|
| Lambda | `checksops-production-prep-api` |
| CodeSha256 | `zQzfz1Use78/jI/+t2FWpcCguCEK9uF/oMPejSAuDbY=` |
| LastModified | `2026-09-23T17:11:26.000+0000` |
| SPA | `index-BR49bZTp.js` |
| `/prep/health` | 200 `ok` |

Matches the accepted Moov execution baseline. Production was
not rolled backward. Inspect Lambda restored to
`yYb/cXdUXkVh6JIesDAXwPcLmPwyTy86WwWvf4+xyso=`.

## B. Current Moov flags

Unread after this task. Not mutated.

- `AWS_MOOV_ENABLED=false`
- `AWS_MOOV_TRANSFER_POST_ENABLED=false`
- `AWS_ENDORSEMENT_AUTO_ADVANCE=false`
- `AWS_CHECKALT_ENABLED=true` (unchanged)
- `AWS_PROVIDER_LIVE_READS_ENABLED=false`

## C. Freedom production Moov account status

Provider GET `/accounts/60922058-7eca-4889-81dd-5720d7b9de96`:

- `mode=production`
- `verification=verified`
- `disabledOn=null`
- onboarding `active`
- local row `26c2dbb1-360e-4631-84f5-24aa934c4005` remains
  Freedom tenant `2eff5f1a-929d-4ce3-9a8b-cd96b98df42a`

## D. Provider-side production payment methods found

Existing verified bank `61062c38-a79e-4f62-bb64-32ddecf3d37c`
Wells Fargo checking `*4573` (matches the local connected row).
No new bank connection was created.

| Type | paymentMethodID |
|---|---|
| `ach-credit-standard` | `7a78a544-340d-46fd-a4a4-228661374da7` |
| `ach-credit-same-day` | `248ef2ec-aa69-4b24-9b39-2981dad01dc7` |
| `ach-debit-fund` | `a02c1c81-9ca6-434d-accc-ea4471a70ef2` |
| `ach-debit-collect` | `128977bb-5034-4e8b-89ed-b10982105aa3` |
| `moov-wallet` | `744ea734-f5e3-4b31-bb92-38f85fd29b91` |

## E. provider_payment_method_id resolution

Local row `8eb5b26e-6f66-435c-a578-880fb7fc14dd` already had
the bank id and rail map. Only
`provider_payment_method_id` was null.

Reconciled to the existing production
`ach-credit-standard` method
`7a78a544-340d-46fd-a4a4-228661374da7`.
Rails refreshed from the same provider list. No duplicate
method. No sandbox method.

## F. Current provider collect-funds capability

Provider GET `/accounts/.../capabilities`:

- `collect-funds` **enabled** (updated 2026-09-01)
- `send-funds` enabled
- `transfers` enabled
- `wallet` enabled
- `currentlyDue=[]`

`can_ach_debit` is therefore true at the provider.

## G. Whether local capability snapshot was stale

**Yes.** Local snapshot still had `collect-funds=in-review`
and `can_ach_debit=false` from 2026-08-28. Reconciled to the
current provider enabled state using the existing
`payment_provider_accounts` columns. Status was not faked.

## H. Current provider wallet balance

Provider GET `/accounts/.../wallets`:

- wallet `3e6286ca-a19c-45f6-aad9-f73dac5f0358`
- name `Freedom Adjustment Wallet`
- status `active`
- `available=0` / `pending=0`

## I. Whether local wallet snapshot was stale

**No.** Local `available_cents=0` / `pending_cents=0` matches
the provider. `last_synced_at` was advanced only. Balance was
not manufactured.

## J. Existing legitimate wallet funding mechanism

The current ChecksOps/Moov implementation funds the operating
wallet by ACH-debiting the connected production bank
(`ach-debit-fund` `a02c1c81-9ca6-434d-accc-ea4471a70ef2`)
into the wallet payment method
`744ea734-f5e3-4b31-bb92-38f85fd29b91`
(`moov-wallet-fund` / `initiate-wallet-funding`).

That path now has the required `collect-funds` capability.
It was **not** executed. No debit, sweep, or test fund.

A normal business event is an operator-authorized wallet
funding from the verified Wells Fargo `*4573` after
activation is explicitly approved, or an inbound credit that
the existing collect/send path already supports.

## K. Any provider-side action still required

No further Moov capability or payment-method action is
required for this account. A legitimate funding event is
still required before a real disbursement can succeed.

## L. Any safe reconciliation performed

1. `payment_provider_methods.provider_payment_method_id`
   set to `7a78a544-340d-46fd-a4a4-228661374da7`
2. `payment_provider_accounts` capability flags/snapshot
   updated from the live provider GET
3. `payment_wallets.last_synced_at` updated; cents remain 0

No transfer created. Production Lambda SHA unchanged.

## M. MOOV PAYMENT METHOD READINESS

**READY**

## N. MOOV CAPABILITY READINESS

**READY**

## O. MOOV FUNDING READINESS

**PENDING** — provider wallet is `$0.00`

## P. MOOV PRODUCTION ACTIVATION READINESS

**PENDING**

## Q. Exact remaining blocker(s)

Freedom production wallet `available_cents=0`. Activation
flags stay false until a legitimate funding event exists and
an operator authorizes a specific real transfer.

## R. Production components now frozen

Unchanged CLOSED set plus the already-frozen Moov production
execution implementation. CheckAlt untouched. Pending real
input items remain pending, not failed.

## S. SINGLE NEXT MASTER AWS CUTOVER ITEM

**MOOV / PRODUCTION ACTIVATION** — only after a legitimate
funding event and explicit operator authorization of one
real unused disbursement. Do not enable Moov now.

**MOOV PRODUCTION ACTIVATION — PENDING EXTERNAL/REAL INPUT**
