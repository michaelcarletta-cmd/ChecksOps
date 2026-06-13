# ChecksOps AML / BSA Program Summary

**Effective date:** 2026-06-22
**AML Officer:** Qualified Individual named in `docs/WISP.md` — security@checksops.com

This document summarizes ChecksOps' Anti-Money-Laundering program. Detailed procedures live in `docs/ACH_RISK_FRAUD_MONITORING.md`.

## Pillars

1. **Designated AML Officer** — single accountable owner; reports to the CEO.
2. **Customer Identification Program (KYC)** — legal name, EIN, beneficial owner ID, address, phone collected and verified at tenant onboarding. Documents stored in the private `tenant-documents` bucket.
3. **Ongoing transaction monitoring** — volume limits, behavioral flags, and rolling return-rate tracking against NACHA thresholds. See ACH policy §3.
4. **SAR filing capability** — AML Officer files Suspicious Activity Reports with FinCEN within 30 days of detection (60 days if no suspect identified). SAR records retained 5 years and treated as strictly confidential.
5. **Recordkeeping** — KYC, transaction, and monitoring records retained ≥ 5 years.
6. **Training** — annual AML training for all employees touching payment workflows; phishing simulation at least twice per year.
7. **Independent review** — AML program audited by an independent party at least every 18 months.

## Risk-Based Approach

ChecksOps is a non-custodial ACH originator serving licensed insurance restoration contractors and public adjusters. Inherent risk is moderate due to:
- Multi-party payees on insurance checks (insured, mortgagee, contractor)
- High average ticket size relative to retail ACH
- Velocity spikes after catastrophe events

Controls (limits, micro-deposit validation, behavioral flags, return-rate ceilings) are calibrated to this profile and reviewed annually.

## Coordination With Vendors

- **Actum Processing** performs its own OFAC screening and return management. ChecksOps consumes Actum return codes and acts on them per ACH policy §4.
- **CheckAlt FinCapture** performs duplicate-check detection and image fraud screening on deposit. ChecksOps logs CheckAlt fraud signals to `glba_security_events`.
- Vendor reliance does **not** relieve ChecksOps of its independent AML obligations.

## Escalation

Any employee who suspects money laundering, structuring, fraud, identity theft, or sanctions evasion must escalate to the AML Officer within 24 hours. Retaliation against good-faith reporters is prohibited.
