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

## Sending (not built yet)

From the Funds tab, to:

- **Partners** the check was shared with: wallet to wallet.
- **Homeowners**: through a KYC link, after Moov approval.
- **Stakeholders**: chosen from Stakeholder Settings in a dropdown.

**Top-up.** When the wallet's available balance is short, the send happens at
once as two transfers:

1. The available wallet amount: wallet → recipient.
2. The shortfall: linked bank (`ach-debit-fund`) → recipient directly.

The owner accepts the bank-return (NSF) risk on the second transfer. The
shortfall is not routed through the wallet first, because pending funds
cannot be spent.

- **Sweeps** in WalletOps keep the wallet funded.
- **Auto payouts are not used** at this time.

## Monthly billing (to be checked)

Each month, CheckOps Tenant Management pulls each tenant's fees (CheckAlt, Moov,
maintenance, Mortgage Ops). Approval already exists. Production posting is
currently off (`AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST=false`). The September
collection is still `submitted` and needs a status check.

## Production switches

Production funding runs only when all of these are `true`:

- `AWS_PROVIDER_EXECUTION_ENABLED`
- `AWS_MOOV_ENABLED`
- `AWS_PROVIDER_LIVE_READS_ENABLED`
- `AWS_MOOV_TRANSFER_POST_ENABLED`

With `AWS_MOOV_TRANSFER_POST_ENABLED` off, a funding request is recorded but
nothing is sent to Moov.
