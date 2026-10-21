# ChecksOps AML / BSA Program Summary

**Effective date:** 2026-06-22
**AML Officer:** Qualified Individual named in `docs/WISP.md` — security@checksops.com

This document summarizes ChecksOps' Anti-Money-Laundering program. Detailed procedures live in `docs/ACH_RISK_FRAUD_MONITORING.md`.

## Pillars

1. **Designated AML Officer** — single accountable owner; reports to the CEO.
2. **Customer Identification Program (KYC)** — legal name, EIN, beneficial owner and controller identity (name, date of birth, SSN, home address), business address, phone and compliance documents are collected at tenant onboarding (Compliance & Docs) and sent to Moov, which performs the KYC/KYB verification. Documents are stored in a private, KMS-encrypted S3 prefix (`files/verification-docs/`) and forwarded to Moov. See ACH policy §5.
3. **Ongoing transaction monitoring** — financial two-factor step-up, verified-account requirements, idempotent one-request-per-click transfers, CheckAlt risk screening, and return-rate review against NACHA thresholds. ChecksOps sets no amount limits. See ACH policy §3.
4. **SAR filing capability** — AML Officer files Suspicious Activity Reports with FinCEN within 30 days of detection (60 days if no suspect identified). SAR records retained 5 years and treated as strictly confidential.
5. **Recordkeeping** — KYC, transaction, and monitoring records retained ≥ 5 years.
6. **Training** — annual AML training for all employees touching payment workflows; phishing simulation at least twice per year.
7. **Independent review** — AML program audited by an independent party at least every 18 months.

## Risk-Based Approach

ChecksOps is a non-custodial payments platform serving licensed insurance restoration contractors and public adjusters. ACH payments move through Moov; checks are deposited through CheckAlt into each tenant's own bank account (ACH policy §1, §7). Inherent risk is moderate due to:
- Multi-party payees on insurance checks (insured, mortgagee, contractor)
- High average ticket size relative to retail ACH
- Velocity spikes after catastrophe events

> **OWNER TO CONFIRM:** Is "non-custodial payments platform" the correct description of ChecksOps' role under the Moov agreement (see ACH policy §1 and §7 on the Originator of record and who holds funds in tenant Moov wallets)?

Controls (Moov KYC/KYB and bank verification, financial two-factor step-up, verified-recipient requirements, CheckAlt risk screening and auto-approval ceilings, return-rate review) are calibrated to this profile and reviewed annually.

## Coordination With Vendors

- **Moov** verifies each tenant's business and representatives (KYC/KYB), verifies bank accounts, and carries every ACH transfer. ChecksOps receives Moov's events by signed webhook; ACH policy §4 lists what is recorded automatically and the response procedure for returns.
- **CheckAlt FinCapture** is asked for its risk assessment on every deposit. ChecksOps auto-approves a deposit only when CheckAlt rates it "Low Risk", raises no duplicate, fraud or other flag, and the amount is within the tenant's auto-approval ceiling; anything else waits for manual approval. The outcome is recorded on the `checkalt_deposits` row.
- Vendor reliance does **not** relieve ChecksOps of its independent AML obligations.

> **OWNER TO CONFIRM:** Does Moov perform OFAC/sanctions screening and return management for ChecksOps tenants and their payees under the agreement, and does CheckAlt perform its own duplicate-item and OFAC screening on deposits?

Actum Processing, Plaid and QuickBooks were retired in October 2026 and are no longer vendors (ACH policy §1).

## Escalation

Any employee who suspects money laundering, structuring, fraud, identity theft, or sanctions evasion must escalate to the AML Officer within 24 hours. Retaliation against good-faith reporters is prohibited.
