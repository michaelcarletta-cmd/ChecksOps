# Moov Compliance Response — ChecksOps

No code changes. This is the factual answer to Moov's two questions, grounded in what the app actually captures today, plus a short gap list.

## What ChecksOps is

ChecksOps is B2B SaaS for property-claim professionals: restoration contractors, public adjusters, and related firms. Customers are the businesses named as payees on insurance claim checks. ChecksOps has no commercial relationship, contract, referral arrangement, or data feed with any insurance carrier or mortgage servicer, and does not represent otherwise anywhere in the product or marketing.

ChecksOps is not a payments facilitator, not a carrier, not a lender, and does not take custody of claim funds outside of accounts held in the customer's own name at our regulated partners.

## Answer 1 — How funds are sourced and how origin is verified

Money flow (single direction, no third-party origination):

```text
Carrier / mortgage servicer issues a paper claim check
   -> payable to homeowner + contractor/PA (+ mortgagee) 
   -> customer physically receives and endorses the check
   -> deposited via CheckAlt RDC into the customer's own deposit account
   -> customer disburses from their own verified funds to their own payees
      (subs, vendors, sales reps, homeowner) via Moov
```

ChecksOps never receives funds from an insurer or mortgage company. The funding source for every Moov transfer is the ChecksOps customer's own verified bank account or their own Moov balance, funded by a check they were legally a named payee on.

Origin evidence captured today, per check:

- Front and back check images stored in object storage, plus an OCR pass that extracts drawer/carrier name, check number, amount, issue date, payee line, multi-payee flag, property address, and the routing/account numbers printed on the instrument (`check_intake_items`).
- Raw OCR payloads for both sides retained alongside the extracted fields, so the extracted data can be re-verified against the image.
- Claim linkage: detected claim number, linked claim record, property address, and the tenant (customer) that owns the item.
- Payee roster per check with payee type (homeowner, contractor/PA, mortgagee) and per-payee endorsement state (`check_payees`, `check_endorsements`).
- Endorsement/authorization evidence: signature method, signature image, signed-at timestamp, IP address, user agent, and the consent text presented, or an explicit "endorsed on check" record where the signature is physically on the instrument.
- Loss-draft / mortgagee path is tracked separately when the mortgage company must countersign, including sent, tracking number, received, and final-release timestamps.
- Deposit rail record from CheckAlt: reference, amount, submitted/cleared/returned timestamps, return reason, and approval actor (`checkalt_deposits`). A returned or NSF item is visible against the same check.
- Full per-check audit log of every state change with actor and timestamp (`check_audit_log`), plus an immutable check lifecycle stage.

Account-ownership and counterparty evidence:

- Tenant KYB: legal business name, EIN, business address and phone, beneficial owner name and DOB, beneficial owner ID document, KYC status, completion actor and timestamp (`tenants`).
- Bank account ownership: accounts are verified before use via Plaid instant verification or micro-deposits, with verification status, source, timestamps, and failure reasons recorded (`stakeholder_accounts`). Plaid-linked accounts can be bridged to Moov as a processor token.
- ACH authorization records for debits: authorizing user, name, IP, user agent, exact form text, active/revoked state (`ach_authorizations`).
- Downstream recipients are onboarded as distinct records with type and relationship to the customer, their own bank link, and Moov account/onboarding status (`external_payment_recipients`, `disbursement_splits`), so every payout leg names a known counterparty rather than a free-form address.
- Disbursements are constrained by the check ledger: batches reference the source check and its amount, with reserve/available tracking, so payouts cannot exceed the deposited instrument.

Net position for Moov: for any Moov transfer, ChecksOps can produce the source instrument image, the OCR-extracted drawer and payee data, the endorsement chain with signer identity metadata, the deposit confirmation into the customer's own account, the verified funding account, and the verified recipient — as a single linked chain.

## Answer 2 — How customers are sourced without carrier or lender relationships

Acquisition is direct-to-contractor and direct-to-adjuster:

- Direct outbound and inbound sales to restoration companies, public adjusting firms, and roofing/mitigation contractors.
- Industry channels: restoration and adjusting trade associations, conferences and trade shows, industry publications and podcasts.
- Content and search marketing aimed at the operational pain (manual check handling, chasing endorsements, mortgage loss-draft delays).
- Referral from existing customers, tracked in-product via referral codes and partner codes.
- Partner-code sharing between existing ChecksOps tenants (for example a PA and a contractor working the same claim), which is a customer-to-customer relationship, not a carrier or lender relationship.

No lead, list, endorsement, or co-marketing arrangement comes from an insurance carrier or a mortgage servicer. Every customer is onboarded through ChecksOps' own KYB flow before any money movement is enabled.

## Current controls vs. gaps

Current:
- Check image capture, OCR extraction of drawer/payee/amount/check number, retained raw OCR.
- Payee roster with roles, per-payee endorsement with signature image, IP, user agent, consent text, timestamps.
- Loss-draft / mortgagee tracking.
- CheckAlt deposit record with clear/return status back-linked to the check.
- Tenant KYB with beneficial owner and ID document; KYC status gate.
- Bank ownership verification via Plaid or micro-deposits; ACH authorization capture with IP/UA/form text.
- Recipient onboarding with bank link and Moov readiness state; per-check disbursement ledger with reserve/available limits.
- Immutable per-check audit log and stage machine.

Still to implement (state these as roadmap, not as existing controls):
- Automated payee-name-to-tenant-legal-name match scoring at OCR time (today it is reviewed by staff).
- Systematic duplicate-instrument detection across tenants (same check number + drawer + amount).
- Formalized transaction monitoring thresholds and SAR-style escalation workflow.
- Automated reconciliation assertion that total disbursed never exceeds cleared deposits, enforced at the database level rather than at the batch level.
- Documented retention schedule for check images and OCR payloads tied to the tenant retention setting.

## Two-paragraph version to send

ChecksOps is a workflow and payment-operations platform for restoration contractors and public adjusters. We have no relationship with insurance carriers or mortgage servicers. Funds originate as paper insurance claim checks that our customer is a named payee on; the customer endorses and deposits that check through our check-deposit rail into a deposit account held in their own name. Moov is used only downstream, to disburse the customer's own settled funds to their own subcontractors, vendors, sales reps, or the homeowner. For every transaction we retain the check images, OCR-extracted drawer/carrier, check number, amount and payee line, the linked claim and property, the per-payee endorsement record with signature image, IP, user agent and consent text, the deposit clearing record, the verified funding account (Plaid or micro-deposit verified) and the ACH authorization, and a full audit trail — so the origin of funds can be evidenced end to end.

We acquire customers directly: outbound and inbound sales to restoration and public adjusting firms, trade associations, conferences, industry publications, content and search marketing, and customer referrals. No carrier or lender refers, endorses, or supplies customers to us. Every customer completes ChecksOps KYB — legal entity name, EIN, business address, beneficial owner identity and ID document — before any money movement is enabled.
