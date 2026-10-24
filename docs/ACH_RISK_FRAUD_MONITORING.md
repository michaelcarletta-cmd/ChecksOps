# ACH Risk and Fraud Monitoring Policy

**Effective date:** 2026-06-22
**Owner / Qualified Individual:** [Name, Title] — security@checksops.com
**Last reviewed:** 2026-10-21 (payment providers: Moov for ACH, CheckAlt for check deposit)
**Review cadence:** Annually, or after any material change in payment volume, rails, or risk profile.

This policy satisfies the NACHA Risk Management and Assessment requirements (effective June 22, 2026) that require every ACH Originator to maintain a risk-based fraud monitoring framework proportionate to its payment volume.

---

## 1. Scope

ChecksOps moves ACH payments through **Moov** and deposits checks through **CheckAlt** (FinCapture remote deposit capture). Moov and CheckAlt do not exchange data with each other (`docs/MOOV_PAYMENTS_RULES.md`).

Through Moov, ChecksOps creates these ACH transfers from its Moov platform (facilitator) account on behalf of each tenant's own Moov account (`aws/functions/api/providers/production/moov-wallet-fund.mjs`, `moov-send.mjs`):

- **Wallet funding (ACH debit):** the tenant's linked, verified bank → the tenant's Moov wallet (`ach-debit-fund`).
- **Disbursements (ACH credit):** the tenant's Moov wallet → a stakeholder's linked, verified bank, standard or same-day (`ach-credit-standard`, `ach-credit-same-day`); partners are paid wallet to wallet, or to their linked bank when they have no production wallet.
- **Top-up disbursements (ACH debit and credit):** when the wallet balance is short, the shortfall goes straight from the tenant's linked bank to the recipient (`ach-debit-fund` → recipient).
- **Tenant fee collection (ACH debit):** the platform owner pulls a tenant's ChecksOps fees from the bank the tenant authorized into the ChecksOps platform Moov wallet (`aws/workflows/sql/98_tenant_fee_collection.sql`, `aws/functions/api/tenant-billing-handlers.mjs`, `tenant-billing-destination.mjs`).

> **OWNER TO CONFIRM:** Under the Moov agreement, who is the NACHA Originator of record for these transfers (ChecksOps, the tenant, or Moov), which ODFI originates them, and which SEC codes Moov uses for each transfer type?

This policy covers:

- Account validation prior to first credit or debit
- Real-time and post-settlement transaction monitoring
- Return and unauthorized-return tracking against NACHA thresholds
- Response procedures when Moov reports a return, NOC, or suspicious pattern

Actum Processing, Plaid (including Actum's Plaid-based Authentecheck) and QuickBooks were retired by owner decision in October 2026 ("We only keep Moov and Check Alt"). The AWS application never originated ACH through Actum (`aws/functions/api/providers/actum.mjs` is an interface-only stub), and the remaining Plaid, Actum and QuickBooks application code is being removed (PR #1109). Their historical tables (`actum_transactions`, `plaid_transfer_events`, `plaid_webhook_cursors`) stay in the database as history (PR #1109 changes no table, and no migration drops them); once PR #1109 is merged, no application code writes them.

## 2. Account Validation (NACHA WEB Debit Rule)

Every bank account used for an ACH debit or credit is a Moov bank account, and ChecksOps only moves money to or from one that is verified:

| Method | Implementation | Code reference |
|---|---|---|
| Moov micro-deposit verification (tenant banks) | The tenant enters the routing and account number (sent to Moov; ChecksOps keeps the bank name, last four and routing last four), or links the bank through Moov's hosted bank-link component. ChecksOps then asks Moov to verify the bank (`POST /accounts/{id}/bank-accounts/{id}/verify`); the user enters the 4-digit code from the $0.01 deposit descriptor. At most 3 attempts per verification (`max_attempts`, attempt reserved before Moov is called); after that the verification must be restarted. Each attempt is recorded in `payment_method_verifications` and the bank's status in `payment_provider_methods.verification_status`. Every bank change (add, link, verify) needs the financial two-factor step-up (§3.2). | `aws/functions/api/providers/onboarding/handlers.mjs` (`moov-bank-account-add`, `moov-bank-link-token`, `moov-micro-deposit-initiate`, `moov-micro-deposit-confirm`) |
| Moov verified-bank requirement for debits | Funding and top-up debits use only Moov's `ach-debit-fund` payment method, which Moov issues only for verified banks. With more than one linked bank, the tenant's default bank is used. | `aws/functions/api/providers/production/moov-wallet-fund.mjs` (`selectDebitMethod`) |
| Stakeholder bank verification | A stakeholder is paid only when its `stakeholder_accounts` row is a Moov account with a Moov bank and `verification_status` is `verified` or `admin_override`. The Moov recipient flow in the code verifies recipient banks by Moov instant micro-deposit. | `aws/functions/api/providers/production/moov-send.mjs` (`resolveDestinations`), `aws/functions/api/providers/moov-recipient-tos-policy.mjs` |
| Admin override | `stakeholder_accounts.verification_status = 'admin_override'` is accepted by the send path in place of `verified`. | `stakeholder_accounts.verification_status = 'admin_override'` |

> **OWNER TO CONFIRM:** How are production stakeholder banks linked and verified today (the homeowner/recipient bank-link flow is not yet ported to production), who may set `admin_override`, and where is the business reason for an override recorded? The AWS application does not write `glba_security_events` for overrides.

The `micro_deposit_verifications` table is dormant: it remains in the schema (and on the data-API read allowlist), but no application code uses it. Moov verifications are recorded in `payment_method_verifications`.

Accounts that are not verified are **blocked from disbursement** by the send path (`recipient_not_verified`) and from funding by Moov (no `ach-debit-fund` method).

**This is ChecksOps' documented WEB Debit Rule compliance mechanism.**

> **OWNER TO CONFIRM:** Does Moov's bank verification satisfy the WEB Debit account-validation requirement for ChecksOps under the Moov agreement, or does Moov perform additional validation of its own?

## 3. Transaction Monitoring

### 3.1 Volume Limits (per tenant)
- ChecksOps sets **no** per-transaction or daily amount limit on Moov funding or disbursements. This is the owner's rule ("There are no amount limits", `docs/MOOV_PAYMENTS_RULES.md`) and the code enforces only that an amount is a positive whole number of cents (`parseFundAmountCents`). The `tenants.ach_per_transaction_limit` and `tenants.ach_daily_limit` columns and the new-tenant cool-down named in earlier versions of this policy do not exist.
- A send has at most 10 recipients (`MAX_RECIPIENTS`).
- A same-day disbursement goes out only when Moov offers an `ach-credit-same-day` payment method for the recipient's bank; otherwise the send is refused (`selectCreditMethod`).
- CheckAlt deposits are auto-approved only up to a per-tenant ceiling (`checkalt_tenant_accounts.auto_approve_max_cents`); a blank ceiling means no auto-approval, not unlimited (§3.2).

> **OWNER TO CONFIRM:** Does Moov apply its own transaction or daily limits to tenant accounts, and does the owner want ChecksOps to keep any internal per-tenant ACH limit?

### 3.2 Behavioral Flags
These controls run on every money movement in the code today:
- **Two-factor step-up:** funding, disbursements, bank changes and CheckAlt submit/approve need a financial TOTP code once per login, recorded in `financial_stepup_log`. Only the server can write a step-up row that authorizes money movement (SQL 97, `aws/workflows/sql/97_financial_stepup_log_server_writer.sql`; `aws/functions/api/providers/production/moov-fund-authz.mjs`, `checkalt-authz.mjs`).
- **Who may move money:** only members of the tenant; platform roles never move a tenant's money (`docs/MOOV_PAYMENTS_RULES.md`).
- **Recipients:** stakeholders must be verified (§2); partners must have the check shared with them or an active partnership that has not been revoked since (`moov-send.mjs`).
- **One request per click:** every transfer has an idempotency key; a result that does not prove Moov refused the transfer is marked `unknown` and is never retried automatically; after a refused leg, the remaining legs of a send are canceled unsent.
- **CheckAlt risk screening:** every deposit asks CheckAlt for its risk assessment (`performRiskAssessment: true`). Auto-approval is always on for every organization with no amount ceiling (owner decisions 2026-10-22 and 2026-10-24): a deposit CheckAlt parks for approval (status 40) is auto-approved unless CheckAlt flagged it, that is a duplicate (`duplicateStatus`), an amount mismatch (`ocrAmountStatus` false or `amountDiscrepancyDetected`), a `Decline` or `Warning` risk rating, any errors, exceptions, warnings or risk factors, or a duplicate, fraud, risk, exception, warning, hold, suspect, mismatch or unreadable status text. A flagged deposit stays `pending_approval` and is reviewed in the Check Alt portal. The reason is recorded on the `checkalt_deposits` row (`aws/functions/api/providers/production/checkalt-submit.mjs`, `checkalt-idempotency.mjs`).

The pattern flags named in earlier versions of this policy (first disbursement over $10,000, disbursement to an account verified in the last 24 hours, three or more disbursements to the same new account in 7 days, after-hours disbursement by a non-admin, written to `glba_security_events` as `ach.suspicious_pattern`) are **not implemented** in the code.

> **OWNER TO CONFIRM:** Should those pattern flags be built, reviewed manually (by whom, how often, from which report), or retired from this policy?

### 3.3 Return Rate Tracking
NACHA return-rate thresholds:
| Metric | NACHA threshold | Internal alert |
|---|---|---|
| Unauthorized return rate | 0.5% | 0.3% |
| Administrative return rate | 3.0% | 2.0% |
| Overall return rate | 15.0% | 10.0% |

ChecksOps code does not compute rolling return rates. Return information is held by Moov; inside ChecksOps, returns are recorded only where §4 says.

> **OWNER TO CONFIRM:** Who monitors return rates against these thresholds (Moov under its agreement, or ChecksOps from Moov's reports), how often, and are the internal alert levels and the "pause new originations" response still the owner's policy?

Approaching any internal alert triggers a review by the Qualified Individual and pauses new originations until cleared.

## 4. Response to Returns and NOCs

What the code records when Moov reports a transfer outcome:
1. Every Moov webhook is signature-verified and receipted once in `aws_provider_webhook_receipts` (provider, event id, type, payload hash, mapped tenant) (`aws/functions/api/providers/webhooks.mjs`).
2. In production, webhooks update onboarding status (only while `AWS_MOOV_ONBOARDING_PRODUCTION_ENABLED` is on) (account, capability, verification, representative) and **tenant fee collection** outcomes: a returned fee pull sets `tenant_maintenance_payments.returned_at` and `return_reason` and the collection leg's `payment_transfers` row (`aws/functions/api/tenant-collection-v2-settlement.mjs`, `providers/onboarding/webhook-status.mjs`).
3. Wallet-funding and disbursement transfers are recorded at submission in `payment_transfers` and `payment_event_log`. Their later status changes, including returns, are **not** yet written back to ChecksOps in production; the wallet balance shown is Moov's.
4. CheckAlt deposit status (including returned items, `checkalt_deposits.returned_at`) is refreshed by polling CheckAlt (`aws/functions/api/providers/production/checkalt-poll.mjs`, `checkalt-status-reconcile.mjs`).

Required response (manual; none of these steps is automated in the code today):
1. The originating user and tenant admin are notified.
2. **R10 / R11 (unauthorized):** the account is blocked from further disbursement and the event is recorded. SAR review is triggered (see §6).
3. **R01 / R09 (insufficient funds):** retry at most once per NACHA rules; a second failure blocks the account pending re-verification. The owner accepts the NSF risk on top-up debits (`docs/MOOV_PAYMENTS_RULES.md`).
4. **NOC (COR):** the bank account record is corrected and the tenant is notified; the next origination uses corrected data.

> **OWNER TO CONFIRM:** Who receives Moov return and NOC notices today (Moov dashboard, email, webhook), who performs each response step above, where the action is recorded, and whether Moov applies NOC corrections itself. Are Moov's production webhooks delivered to the AWS API endpoint today?

## 5. KYC (Know Your Customer)

Every tenant that uses Moov completes Compliance & Docs, which sends this information to Moov for verification (`aws/functions/api/providers/onboarding/store.mjs`, `moov-sync.mjs`, `documents.mjs`):
- Legal business name, DBA, business type
- EIN (required unless sole proprietorship; validated as 9 digits; stored KMS-encrypted, last four shown)
- Business address, phone, email, and website or business description
- Each representative (controller and owners): full name, email, phone, home address, date of birth (stored KMS-encrypted), SSN (sent to Moov; ChecksOps keeps only the last four), ownership percentage and title
- Compliance documents (business, identity, representative verification, W-9, bank statement, license, insurance and others) uploaded to a private S3 prefix (`files/verification-docs/`, SSE-KMS) and forwarded to Moov's files API
- Acceptance of Moov's terms of service by a member of the tenant: the server passes the member's IP address and user agent to Moov and records `payment_provider_accounts.tos_accepted_at` / `tos_accepted_by` (`handlers.mjs`, `moov-tos-accept`)
- Acknowledgment of the ChecksOps Terms of Service and this policy

Moov performs the KYC/KYB verification. Its result is copied from Moov into `payment_provider_accounts` (`onboarding_status`, `verification_status`, capabilities) and gates payments: funding and disbursements are refused unless the tenant's Moov account is `active` (`moov-wallet-fund.mjs`, `moov-send.mjs`). The tenant sees the verification and ACH-capability checks in its readiness view (`aws/functions/api/providers/readiness.mjs`).

> **OWNER TO CONFIRM:** Exactly which checks Moov performs for ChecksOps tenants under the agreement (identity, EIN/TIN match, OFAC/sanctions, beneficial ownership), and whether ChecksOps relies on Moov's CIP or runs its own.

CheckAlt depositor registration is done by the platform owner and sends CheckAlt the depositor's first and last name, email and deposit account number (`aws/functions/api/providers/production/checkalt-register.mjs`).

KYC artifacts are retained for the life of the relationship plus 5 years, per BSA recordkeeping rules.

## 6. AML Program and SAR Filing

ChecksOps maintains a risk-based AML program aligned with FinCEN guidance for money services:

- **Designated AML Officer:** the Qualified Individual identified in `docs/WISP.md`.
- **Customer Identification Program (CIP):** §5 above.
- **Ongoing monitoring:** §3 above.
- **Recordkeeping:** all transaction, KYC, and monitoring records retained 5 years minimum.
- **SAR filing:** when a transaction or pattern is suspected to involve money laundering, fraud, or other illegal activity, the AML Officer files a Suspicious Activity Report with FinCEN within 30 calendar days of detection (60 days if no suspect is identified). SAR filings and supporting documentation are kept strictly confidential and retained 5 years.
- **Annual training** for all employees with access to payment workflows.
- **Independent review** of the AML program at least every 18 months.

## 7. Non-Custodial Model (Money Transmission)

ChecksOps **does not take custody** of consumer or business funds at any point:
- Insurance check images are captured and deposited directly into the tenant's own bank account via CheckAlt FinCapture (the deposit account registered for that tenant in `checkalt_tenant_accounts`).
- Tenant money moved through Moov stays in the tenant's own Moov account: the tenant funds its own Moov wallet from its own linked bank, and disbursements go from that wallet, or straight from the tenant's linked bank, to the payee's bank or the partner's wallet.
- The only money that reaches a ChecksOps-owned account is ChecksOps' own fees, pulled from the tenant's authorized bank into the ChecksOps platform Moov wallet (§1).
- ChecksOps never holds, pools, settles into, or routes customer funds through a ChecksOps-owned account.

> **OWNER TO CONFIRM:** Under the Moov agreement, who holds the funds in tenant Moov wallets (Moov's partner bank, for the tenant), and does counsel confirm the money-transmitter position with Moov wallets and the platform (facilitator) account in place?

This non-custodial architecture is the basis for ChecksOps' position that state money transmitter licensing does not apply. This model is documented in the Terms of Service and must be preserved in any new payment feature. Any proposal to hold, pool, or settle customer funds requires Qualified Individual + legal review **before** implementation.

## 8. CFPB Awareness

ChecksOps monitors CFPB guidance on platform liability for consumer-facing financial activity. Because the insured homeowner appears as a payee on insurance checks routed through the platform, the AML Officer reviews CFPB enforcement trends quarterly and adjusts disclosures, consent flows, and dispute handling as needed.

## 9. PCI DSS

ChecksOps does not store, process, or transmit payment card data. If card acceptance is added in the future, the platform must complete a PCI DSS scope assessment **before** the first card transaction.

## 10. Recordkeeping and Reporting

| Record | Location | Retention |
|---|---|---|
| ACH transfers (funding, disbursements, fee collection) | `payment_transfers`, `payment_event_log` | 7 years |
| Tenant fee collections and returns | `tenant_maintenance_payments` | 7 years |
| Moov webhook receipts | `aws_provider_webhook_receipts` | 7 years |
| Account verifications | `payment_method_verifications`, `payment_provider_methods` | 7 years |
| Financial two-factor step-ups | `financial_stepup_log` | 7 years |
| Check deposits (CheckAlt) | `checkalt_deposits` | 7 years |
| Historical Actum / Plaid records (retired providers, §1) | `actum_transactions`, `plaid_transfer_events` | 7 years |
| Suspicious-pattern flags (when recorded; see §3.2) | `glba_security_events` | 7 years |
| KYC documents | S3 `files/verification-docs/` (forwarded to Moov) | Life of relationship + 5 years |
| SAR filings | Offline secure storage (AML Officer) | 5 years |
| Annual policy review | git history of this file | Permanent |

> **OWNER TO CONFIRM:** Do the Moov or CheckAlt agreements require retention periods different from those above?

## 11. Annual Review

The AML Officer / Qualified Individual reviews this policy at least annually and after any of:
- Material change in transaction volume (>2x prior year)
- New payment rail or product
- Material change in NACHA, FinCEN, or CFPB rules
- Any unauthorized-return rate breach or SAR filing

Updates are tracked in git history. Version acknowledgment is recorded in `tenants.ach_policy_acknowledged_at` / `ach_policy_acknowledged_by`.
