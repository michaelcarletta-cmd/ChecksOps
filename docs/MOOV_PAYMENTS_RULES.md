# Moov payments: business rules

These are the owner's rules for how money moves through Moov in ChecksOps. Code
that moves money must follow them. Where a rule is not built yet, it says so.

## Who can do what

- There is no admin role for payments. Any member of a tenant can refresh
  balances, fund the wallet and send payments for that tenant.
- Platform roles never move a tenant's money. Only that tenant's members can.
- There are no amount limits. Tenants send money all day, every day.
- Money movement needs a financial two-factor code **once per login**. The user
  is not asked again until they sign out and back in.

## Where money comes from

- Checks are deposited through **CheckAlt** after signatures. CheckAlt deposits
  into the tenant's own bank account.
- **Moov and CheckAlt do not talk to each other.** The tenant links a bank to Moov
  and funds the Moov wallet from it. Whether it is the same bank CheckAlt
  deposits into is the tenant's choice.

## Funding the wallet (built)

- WalletOps → "Add funds from bank" pulls from the tenant's linked, verified
  bank (`ach-debit-fund`) into the tenant's Moov wallet.
- With more than one linked bank, the default one is used.
- ACH funding is **pending** for about 1–3 business days. Pending money cannot
  be spent. The balance shown is Moov's.
- Each click is one request. Retrying the same click never sends a second
  transfer. If the outcome is unknown (timeout, Moov error), the request is
  marked `unknown` and is **never retried automatically**. Check WalletOps
  before trying again.

## Sending (stakeholders and partners built; homeowners not built yet)

From the Funds tab (Disburse to Stakeholders), to:

- **Stakeholders** chosen in Stakeholder Settings: paid to their linked, verified
  bank by ACH credit (standard or same day).
- **Partners** the check was shared with (by this organization, and still shared):
  paid wallet to wallet. A partner with no production balance account is paid to
  their linked bank instead. Only the organization that owns the check sends.
- **Homeowners**: through a KYC link, after Moov approval. Not built yet; the link
  flow must be rebuilt for production.

**Top-up.** When the wallet's available balance is short, the send happens at
once as two transfers per recipient, wallet part first:

1. The available wallet amount: wallet → recipient.
2. The shortfall: linked bank (`ach-debit-fund`) → recipient directly.

The owner accepts the bank-return (NSF) risk on the second transfer. The
shortfall is not routed through the wallet first, because pending funds
cannot be spent. With several recipients, the balance is used in the order they
are listed.

**When part of a send does not go through.** Transfers go out one at a time. If
one is refused, the ones after it are canceled unsent, and the send shows
"partially sent, $X not sent"; the user sends the rest with a new payment. An
unclear result from Moov is marked `unknown`, stops the send and is never
retried automatically. Each click is one request, so a retry never pays twice.

Sends use the same two-factor confirmation as funding (once per login) and are
held while `AWS_MOOV_SEND_POST_ENABLED` is off (nothing is recorded or sent).

**When a payment bounces (built; needs SQL 109 in production).** Moov tells ChecksOps
when a funding or a send later fails, is returned by the bank (an ACH return such as R01
insufficient funds or R10 not authorized) or is reversed. The webhook marks that transfer
`failed` or `returned`, records the return code and reason, and flags it for follow-up;
WalletOps shows the reason, and a returned or failed send no longer counts as paid on the
check, so the amount can be sent again. A bank's notification of change (NOC, a C code) is
recorded for a person to update the bank details; ChecksOps never edits them itself.
Nothing is sent or reversed automatically and no email goes out (there is no payment email
yet). A late or repeated message from Moov never undoes a return.

- **Sweeps** in WalletOps keep the wallet funded.
- **Auto payouts are not used** at this time.

## Monthly billing (to be checked)

Each month, CheckOps Tenant Management pulls each tenant's fees (CheckAlt, Moov,
maintenance, Mortgage Ops). Approval already exists. Production posting is
currently off (`AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST=false`). The September
collection is still `submitted` and needs a status check.

## Database access

Payment tables only let platform admin/staff write by default. SQL 72
(`aws/workflows/sql/72_member_payment_writes.sql`) also lets a member of the
tenant write, but only while the server's funding or balance-refresh code is
running (it sets the financial execution GUCs, which browsers cannot set).
Until SQL 72 is applied, only admin/staff users can fund or refresh.

## Production switches

Production funding runs only when all of these are `true`:

- `AWS_PROVIDER_EXECUTION_ENABLED`
- `AWS_MOOV_ENABLED`
- `AWS_PROVIDER_LIVE_READS_ENABLED`
- `AWS_MOOV_TRANSFER_POST_ENABLED`

With `AWS_MOOV_TRANSFER_POST_ENABLED` off, a funding request is recorded but
nothing is sent to Moov. Sends additionally need `AWS_MOOV_SEND_POST_ENABLED`.
