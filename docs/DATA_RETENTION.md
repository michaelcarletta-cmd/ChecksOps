# ChecksOps Data Retention & Disposal Policy

**Effective:** 2026-01-01 • **Last reviewed:** 2026-11-06 (rewritten for production on AWS)  
**Owner:** Michael Carletta, CEO, Qualified Individual (security@checksops.com)

## 1. Purpose
Defines how long ChecksOps retains consumer financial information ("NPI") under the Gramm-Leach-Bliley Act, the FTC Safeguards Rule, and applicable state insurance / tax law, and how it is securely disposed of after the retention period. Production data lives in AWS: RDS `checksops-production` and the S3 bucket `checksops-production-privatefiles-806168576068`.

## 2. Default Retention Schedule
| Record class | Retention | Driver |
|---|---|---|
| Claim files (notes, documents, photos, communications) | **7 years after claim closure** | IRS recordkeeping, state insurance regs |
| Check images and endorsement packets | 7 years after deposit clears | Reg CC / state banking |
| ACH transactions, disbursements, audit trails | 7 years after transaction | NACHA / GLBA |
| 1099-NEC supporting payee records | 7 years after tax year filed | IRS §6501 |
| Application audit logs (`audit_logs`, `pii_reveal_logs`, `glba_security_events`, `financial_stepup_log`) | 7 years | GLBA Safeguards Rule |
| Cloud audit logs (CloudTrail, AWS Config) | 7 years | GLBA Safeguards Rule; SOC 2 |
| Email delivery logs | 2 years | Operational |
| Application logs (CloudWatch Logs) / OCR scratch | 90 days | Operational |
| Account verification micro-deposit logs | 7 years after account closed | NACHA |

Per-tenant override: `tenants.data_retention_years` (default 7; minimum 7 unless local law allows shorter).

**Applied 2026-11-06** (`ops/security/LOG_RETENTION_AND_DR_2026_11.md`): `checksops-production-security-logs-806168576068` keeps CloudTrail and AWS Config 2,557 days (Glacier after 90); application log groups keep 90 days; the CloudWatch copy of CloudTrail keeps 365 days for searching. New log groups start with no retention; the monthly review (evidence calendar row V-1) catches them.

## 3. Triggering Events
- **Claim closed** — when `claims.status` transitions to `closed`, `settled`, `denied`, or `archived`, the trigger `set_claim_retention_purge_after` computes `retention_purge_after = now() + tenant.data_retention_years`.
- **Account closed** — when `stakeholder_accounts.status = 'closed'`.
- **Tenant termination** — 30-day grace, then full export + purge.

## 4. Disposal Mechanism

**Status on AWS.** The Supabase-era nightly purge (the edge function `glba-retention-purge`) was not carried over to AWS (`aws/providers/EDGE_FUNCTION_INVENTORY.md`, section D). No automated purge runs today. ChecksOps data starts in late 2025, so under the 7-year default no closed claim reaches its `retention_purge_after` date before about 2032. A tenant termination or a shorter per-tenant period could make a purge due sooner.

**Until the AWS purge exists**, every purge is a one-off production change:
1. The Qualified Individual approves it in writing, naming the tenant or claims.
2. It runs through the guarded SQL path (`ops/production-sql-one-shot.md`); never by hand in psql or the console.
3. It is logged to `glba_security_events` and recorded in the evidence calendar (`docs/compliance/EVIDENCE_CALENDAR.md`, row D-1).

**The AWS purge, once built** (a separate change through the guarded path), will:
1. Select claims with `retention_purge_after < now()` that are not on legal hold.
2. Delete or overwrite PII fields in `claims`, `claim_files`, `claim_photos`, `claim_communications_diary`, `claim_check_payments`, related `check_intake_items` and `disbursement_splits`, and the matching S3 objects in the private-files bucket.
3. Keep aggregate, de-identified financial totals for audit (no NPI).
4. Log each run to `glba_security_events` with severity `info` and the counts as metadata.

Every purge, manual or automated, is logged to `glba_security_events` with severity `info` and metadata of counts.

## 5. Legal Hold
A claim flagged `claims.legal_hold = true` is excluded from purging until the hold is released by the Qualified Individual. Holds are logged.

## 6. Backups
- RDS automated backups with point-in-time restore, kept **35 days**, encrypted with KMS, deletion protection on
- Purged data may persist in backups for up to 35 days; backups expire on a rolling window
- No manual database snapshots are kept beyond that window unless the Qualified Individual approves one in writing

## 7. Verification
- Quarterly, once purges run: the Qualified Individual samples 5 purged claims and confirms no residual PII in primary tables or in the private-files bucket (row D-1).
- Annual: the third-party penetration tester or auditor reviews the retention controls.

## 8. Exceptions
Any extension beyond the schedule above requires written approval from the Qualified Individual and is recorded in `glba_security_events` with `event_type = 'retention_extension'`.
