# ChecksOps Data Retention & Disposal Policy

**Effective:** 2026-01-01 • **Owner:** Qualified Individual (security@checksops.com)

## 1. Purpose
Defines how long ChecksOps retains consumer financial information ("NPI") under the Gramm-Leach-Bliley Act, the FTC Safeguards Rule, and applicable state insurance / tax law, and how it is securely disposed of after the retention period.

## 2. Default Retention Schedule
| Record class | Retention | Driver |
|---|---|---|
| Claim files (notes, documents, photos, communications) | **7 years after claim closure** | IRS recordkeeping, state insurance regs |
| Check images and endorsement packets | 7 years after deposit clears | Reg CC / state banking |
| ACH transactions, disbursements, audit trails | 7 years after transaction | NACHA / GLBA |
| 1099-NEC supporting payee records | 7 years after tax year filed | IRS §6501 |
| Authentication audit logs (`audit_logs`, `pii_reveal_logs`, `glba_security_events`) | 7 years | GLBA Safeguards Rule |
| Email delivery logs | 2 years | Operational |
| Application logs / OCR scratch | 90 days | Operational |
| Account verification micro-deposit logs | 7 years after account closed | NACHA |

Per-tenant override: `tenants.data_retention_years` (minimum 7 unless local law allows shorter).

## 3. Triggering Events
- **Claim closed** — when `claims.status` transitions to `closed`, `settled`, `denied`, or `archived`, the trigger `set_claim_retention_purge_after` computes `retention_purge_after = now() + tenant.data_retention_years`.
- **Account closed** — when `stakeholder_accounts.status = 'closed'`.
- **Tenant termination** — 30-day grace, then full export + purge.

## 4. Disposal Mechanism
Nightly cron invokes edge function `glba-retention-purge`:
1. Selects claims with `retention_purge_after < now()` that are not on legal hold.
2. Deletes / overwrites PII fields in: `claims`, `claim_files`, `claim_photos`, `claim_communications_diary`, `claim_check_payments`, related `check_intake_items`, `disbursement_splits`, and storage objects in `claim-files`, `check-files`, `endorsement-packets`.
3. Retains aggregate, de-identified financial totals for audit (no NPI).
4. Logs each purge to `glba_security_events` with severity `info` and metadata of counts.

## 5. Legal Hold
A claim flagged `claims.legal_hold = true` is excluded from automated purging until the hold is released by the Qualified Individual. Holds are logged.

## 6. Backups
- Daily database backups retained 30 days
- Backups encrypted at rest
- Purged data may persist in backup snapshots for up to 30 days; backups expire on rolling window

## 7. Verification
- Quarterly: Qualified Individual samples 5 purged claims and confirms no residual PII in primary tables or storage.
- Annual: third-party reviewer verifies retention controls during pen test.

## 8. Exceptions
Any extension beyond the schedule above requires written approval from the Qualified Individual and is recorded in `glba_security_events` with `event_type = 'retention_extension'`.
