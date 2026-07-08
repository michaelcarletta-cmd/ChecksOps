# ACH Risk and Fraud Monitoring Policy

**Effective date:** 2026-06-22
**Owner / Qualified Individual:** [Name, Title] — security@checksops.com
**Last reviewed:** 2026-06-13
**Review cadence:** Annually, or after any material change in payment volume, rails, or risk profile.

This policy satisfies the NACHA Risk Management and Assessment requirements (effective June 22, 2026) that require every ACH Originator to maintain a risk-based fraud monitoring framework proportionate to its payment volume.

---

## 1. Scope

ChecksOps originates ACH credits (disbursements) and ACH debits (consumer/business funding) through **Actum Processing**. This policy covers:

- Account validation prior to first credit or debit
- Real-time and post-settlement transaction monitoring
- Return and unauthorized-return tracking against NACHA thresholds
- Response procedures when Actum flags a return, NOC, or suspicious pattern

## 2. Account Validation (NACHA WEB Debit Rule)

Every consumer or business bank account is validated **before the first debit or credit** using one of the following methods:

| Method | Implementation | Code reference |
|---|---|---|
| Authentecheck (Plaid) instant verification | User logs into their bank via Plaid through Actum's Authentecheck session; routing/account number and account-holder identity are pulled directly from the financial institution rather than self-reported. This is the primary/active validation method. | `supabase/functions/actum-authentecheck-init/index.ts`, `supabase/functions/actum-authentecheck-postback/index.ts`, `AuthentecheckVerification.tsx` |
| Micro-deposit verification | Two random sub-dollar credits, user confirms exact amounts within 7 days, max 3 attempts before lockout. **Dormant** — the `micro_deposit_verifications` table remains in the schema, but the verification UI and initiating edge function referenced here have been superseded by Authentecheck and are no longer present in the codebase. | `micro_deposit_verifications` table (schema only) |
| Admin override | Documented business reason logged to `glba_security_events`; admin role only. | `stakeholder_accounts.verification_status = 'admin_override'` |

Accounts in `unverified`, `pending`, `failed`, or `locked` state are **blocked from disbursement** at the database layer.

**This is ChecksOps' documented WEB Debit Rule compliance mechanism.**

## 3. Transaction Monitoring

### 3.1 Volume Limits (per tenant)
- Per-transaction cap: configurable on `tenants.ach_per_transaction_limit` (default $50,000)
- Daily aggregate cap: `tenants.ach_daily_limit` (default $250,000)
- New-tenant cool-down: first 30 days capped at $25,000/day unless explicitly raised by Qualified Individual.

### 3.2 Behavioral Flags
The following patterns are flagged for human review before release:
- First disbursement from a tenant exceeding $10,000
- Disbursement to a stakeholder account verified within the previous 24 hours
- Three or more disbursements to the same new account within 7 days
- Any disbursement initiated outside business hours by a non-admin

Flags are written to `glba_security_events` with event type `ach.suspicious_pattern`.

### 3.3 Return Rate Tracking
ChecksOps tracks rolling 60-day return rates per NACHA thresholds:
| Metric | NACHA threshold | Internal alert |
|---|---|---|
| Unauthorized return rate | 0.5% | 0.3% |
| Administrative return rate | 3.0% | 2.0% |
| Overall return rate | 15.0% | 10.0% |

Approaching any internal alert triggers a review by the Qualified Individual and pauses new originations until cleared.

## 4. Response to Returns and NOCs

When Actum posts a return or Notification of Change:
1. The return is recorded in `actum_transactions` with the R-code and reason.
2. The originating user and tenant admin are notified.
3. **R10 / R11 (unauthorized):** account is immediately set to `locked`, disbursements blocked, and a `glba_security_events` entry of type `ach.unauthorized_return` is created. SAR review is triggered (see §6).
4. **R01 / R09 (insufficient funds):** retry once per NACHA rules; second failure locks the account pending re-verification.
5. **NOC (COR):** account record is updated and the tenant is notified; next origination uses corrected data.

## 5. KYC (Know Your Customer)

Every contracting tenant onboarded to ChecksOps provides:
- Legal business name and DBA
- EIN (verified format; cross-checked against IRS TIN match where available)
- Beneficial owner full name, DOB, and government ID upload (stored in private `tenant-documents` bucket)
- Business address and phone
- Acknowledgment of the ChecksOps Terms of Service and this policy

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
- Insurance check images are captured and deposited directly into the contractor's bank account via CheckAlt FinCapture.
- ACH disbursements move funds from the contractor's operating account directly to the payee's account via Actum.
- ChecksOps never holds, pools, settles into, or routes funds through a ChecksOps-owned account.

This non-custodial architecture is the basis for ChecksOps' position that state money transmitter licensing does not apply. This model is documented in the Terms of Service and must be preserved in any new payment feature. Any proposal to hold, pool, or settle customer funds requires Qualified Individual + legal review **before** implementation.

## 8. CFPB Awareness

ChecksOps monitors CFPB guidance on platform liability for consumer-facing financial activity. Because the insured homeowner appears as a payee on insurance checks routed through the platform, the AML Officer reviews CFPB enforcement trends quarterly and adjusts disclosures, consent flows, and dispute handling as needed.

## 9. PCI DSS

ChecksOps does not store, process, or transmit payment card data. If card acceptance is added in the future, the platform must complete a PCI DSS scope assessment **before** the first card transaction.

## 10. Recordkeeping and Reporting

| Record | Location | Retention |
|---|---|---|
| ACH transactions | `actum_transactions` | 7 years |
| Account verifications | `micro_deposit_verifications` | 7 years |
| Suspicious-pattern flags | `glba_security_events` | 7 years |
| KYC documents | `tenant-documents` bucket | Life of relationship + 5 years |
| SAR filings | Offline secure storage (AML Officer) | 5 years |
| Annual policy review | git history of this file | Permanent |

## 11. Annual Review

The AML Officer / Qualified Individual reviews this policy at least annually and after any of:
- Material change in transaction volume (>2x prior year)
- New payment rail or product
- Material change in NACHA, FinCEN, or CFPB rules
- Any unauthorized-return rate breach or SAR filing

Updates are tracked in git history. Version acknowledgment is recorded in `tenants.ach_policy_acknowledged_at` / `ach_policy_acknowledged_by`.
