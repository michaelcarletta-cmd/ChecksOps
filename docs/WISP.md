# ChecksOps Written Information Security Program (WISP)

**Effective date:** 2026-01-01  
**Owner / Qualified Individual:** [Name, Title] — security@checksops.com  
**Last reviewed:** 2026-06-13  
**Review cadence:** Annually, or after any material change

This document satisfies the FTC Safeguards Rule (16 CFR Part 314) and Gramm-Leach-Bliley Act (15 U.S.C. §§ 6801–6809) obligations for ChecksOps.

---

## 1. Designation of Qualified Individual

A single Qualified Individual is responsible for overseeing, implementing, and enforcing this WISP. The Qualified Individual reports to the CEO and provides a written compliance report at least annually.

## 2. Risk Assessment

A written risk assessment is performed at least annually and after any material change. The assessment covers:

- Customer information collected, processed, stored, and transmitted
- Foreseeable internal and external threats (unauthorized access, insider misuse, vendor breach, ransomware, phishing, credential theft)
- Sufficiency of safeguards in place to control identified risks
- Re-evaluation of vendor risk

## 3. Safeguards in Place

### 3.1 Access Controls
- Role-based access (`admin`, `staff`, `client`) enforced by Postgres RLS scoped to `tenant_id`
- Multi-factor authentication required for `admin` and `staff` roles
- Quarterly access reviews — admin and staff lists exported and reviewed by the Qualified Individual
- Sessions secured by `useSessionSecurity` (idle timeout + revocation)
- 4-digit PINs for client portal are rate-limited and scoped to a single claim

### 3.2 Data Inventory and Classification
- All consumer PII fields enumerated in `src/hooks/useEncryption.tsx` (`PII_FIELDS`)
- Sensitive fields masked by default via `MaskedField`; reveals logged to `pii_reveal_logs`
- Bank account numbers stored only via pgsodium-encrypted `stakeholder_accounts`

### 3.3 Encryption
- **In transit:** TLS 1.2+ enforced by Supabase Edge and Lovable CDN
- **At rest:** AES-256 (Postgres), pgsodium for field-level PII via `encrypt_pii` / `decrypt_pii`
- **Storage buckets:** All PII-bearing buckets (`claim-files`, `check-files`, `endorsement-packets`, `deposit-attachments`, `loss-draft-documents`, `tenant-documents`, `contractor-documents`, `ai-knowledge-base`) are private; files served via signed URLs only

### 3.4 Multi-Factor Authentication
- HIBP leaked-password protection: **enabled**
- TOTP MFA available for all users; required by policy for admin and staff
- SAML SSO available for enterprise tenants

### 3.5 Secure Development
- Code review required before merge
- Automated dependency scans via `code--dependency_scan`
- Secrets stored in Supabase Vault / Edge Function secrets — never in source

### 3.6 Vendor Management
Written addenda and annual security review on file for each:
| Vendor | Purpose | Data |
|---|---|---|
| Supabase / Lovable | Database, auth, storage, edge | All PII |
| CheckAlt (FinCapture) | Remote check deposit | Check images, amounts, account fragments |
| Actum Processing | ACH disbursement | Recipient bank info |
| OpenAI | AI inference | Redacted claim text |
| Tavily | Web search | Non-PII queries |
| Resend / Mailgun | Email delivery | Recipient email + content |

### 3.7 Logging and Monitoring
- `audit_logs` — all privileged actions
- `pii_reveal_logs` — every masked-field reveal
- `glba_security_events` — admin overrides, exports, retention purges, incidents
- `check_audit_log`, `check_status_audit`, `deposit_audit_log` — financial workflow
- Logs retained 7 years

### 3.8 Secure Disposal
- Automated retention purge runs nightly via the `glba-retention-purge` edge function
- Default retention: **7 years** after claim closure; configurable per tenant via `tenants.data_retention_years`
- Purge events logged to `glba_security_events`

### 3.9 Change Management
- Schema changes via reviewed migrations (`supabase/migrations/`)
- Production deploys via Lovable; rollbacks available

### 3.10 Incident Response
See `docs/INCIDENT_RESPONSE.md` (Tabletop exercise annually.)

- Detection → Containment → Eradication → Recovery → Post-mortem
- **Notification:** FTC notified within 30 days for breaches involving ≥ 500 consumers; affected consumers notified per applicable state law (often 30–60 days)
- Contact: security@checksops.com

### 3.11 Employee Training
- Security and privacy training required at onboarding and annually
- Phishing simulation at least twice per year
- Training records kept by HR

## 4. Continuous Monitoring or Penetration Testing
- **Continuous monitoring:** Supabase linter, dependency scanner, audit log review
- **Penetration test:** Annual third-party engagement
- **Vulnerability assessments:** At minimum every 6 months and after material changes

## 5. Service Provider Oversight
- Each provider listed in §3.6 reviewed annually
- New providers gated by security questionnaire before contract signature
- Provider access revoked within 24 hours of contract termination

## 6. Plan Evaluation and Adjustment
This WISP is reviewed at least annually and whenever the risk assessment changes materially. Updates are tracked in git history.

## 7. Reporting
The Qualified Individual delivers a written report to the CEO at least annually covering:
- Overall status of the information security program
- Material matters: risk assessment, risk management, testing results, security events, vendor arrangements, recommendations for change

## 8. Privacy Notices
- Initial privacy notice presented at customer onboarding (via `/privacy-notice` page)
- Annual privacy notice delivered via email each January
- Acknowledgments tracked in `privacy_notice_acknowledgments`

## 9. Payments Compliance (ACH / AML / WEB Debit)

ChecksOps originates ACH transactions through Actum Processing under a documented risk-based framework:

- **ACH Risk and Fraud Monitoring Policy** — `docs/ACH_RISK_FRAUD_MONITORING.md` (satisfies the NACHA rule effective 2026-06-22).
- **AML / BSA Program** — `docs/AML_PROGRAM.md` (KYC, monitoring, SAR filing, training, independent review).
- **WEB Debit Rule compliance** — micro-deposit account validation via the `actum-verify-account` edge function and `micro_deposit_verifications` table. Documented in ACH policy §2.
- **Non-custodial model** — ChecksOps never holds, pools, or routes funds through a ChecksOps-owned account; this is the basis for the current money-transmitter-license position and must be preserved.

---

**Acknowledgment of this WISP** is tracked per tenant in `tenants.wisp_acknowledged_at` / `wisp_acknowledged_by`.
