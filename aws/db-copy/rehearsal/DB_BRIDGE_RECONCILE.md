# DB bridge rehearsal recon — PR #127

**Generated:** 2026-09-05T10:41:31.340Z  
**Production cutover performed:** **NO**  
**Live staging DB `checksops` overwritten:** **NO**  
**Rehearsal database:** `checksops_rehearsal_20260905`

## Safety attestation

| Control | Result |
|---|---|
| Production Supabase modified | **NO** |
| DNS / webhooks / Auth changed | **NO** |
| Moov/CheckAlt/Plaid execution | **NO** |
| PR #125 touched | **NO** |
| PII/row contents/tokens in committed evidence | **NO** |
| Temporary DB + Storage bridges left deployed | **YES** |

## Phase 1 — Bridge validation

| Check | Result |
|---|---|
| HTTP health | PASS |
| mode=read_only | PASS |
| writes/deletes/rpc/rawSql all false | PASS |
| Approved tables | 161 |
| Excluded secret/token tables | email_unsubscribe_tokens, homeowner_bank_link_tokens, homeowner_ledger_tokens, payment_idempotency_keys, spatial_ref_sys, tenant_openai_credentials, user_passkeys, webauthn_challenges |
| Numeric count tables | 180 |
| Current production row sum (approved counted) | 12397 |

## Phase 2 — Production delta vs Sept. 1 baseline

Baseline dump: `Migration/checksops_260901(1).backup` (49100401 bytes, cutoff 2026-09-01T20:36:44.000Z).

| Totals | Inserted | Updated | Deleted | Unchanged |
|---|---:|---:|---:|---:|
| All approved business tables | 632 | 66 | 3 | 10914 |

Tables with any insert/update/delete:

| Table | Inserted | Updated | Deleted | Unchanged |
|---|---:|---:|---:|---:|
| audit_logs | 33 | 0 | 0 | 344 |
| check_audit_log | 83 | 0 | 0 | 1924 |
| check_billing_events | 11 | 0 | 0 | 115 |
| check_cases | 3 | 0 | 0 | 139 |
| check_eligibility_results | 12 | 0 | 0 | 113 |
| check_endorsement_events | 5 | 0 | 0 | 227 |
| check_endorsements | 32 | 3 | 1 | 498 |
| check_intake_items | 12 | 18 | 0 | 164 |
| check_payees | 32 | 0 | 0 | 493 |
| check_payment_directions | 3 | 0 | 0 | 62 |
| check_reconciliation_alerts | 3 | 0 | 0 | 98 |
| check_review_decisions | 8 | 0 | 0 | 166 |
| check_stakeholders | 7 | 0 | 0 | 1 |
| checkalt_config | 0 | 1 | 0 | 0 |
| checkalt_deposits | 11 | 0 | 0 | 58 |
| claim_checks | 8 | 7 | 0 | 68 |
| claim_folders | 21 | 0 | 0 | 1260 |
| claim_operational_state | 3 | 0 | 0 | 180 |
| claim_payments | 5 | 0 | 0 | 13 |
| claim_project_plans | 2 | 0 | 0 | 0 |
| claim_settlements | 3 | 0 | 0 | 61 |
| claims | 3 | 12 | 0 | 168 |
| deposit_audit_log | 22 | 0 | 0 | 318 |
| deposit_batches | 11 | 0 | 0 | 115 |
| deposit_items | 11 | 0 | 0 | 114 |
| disbursement_batches | 9 | 0 | 0 | 109 |
| disbursement_splits | 9 | 0 | 0 | 108 |
| email_send_log | 28 | 0 | 0 | 112 |
| endorsement_audit_log | 69 | 0 | 1 | 1330 |
| endorsement_requests | 11 | 0 | 0 | 389 |
| external_payment_recipients | 1 | 2 | 0 | 1 |
| financial_stepup_log | 2 | 0 | 0 | 0 |
| glba_security_events | 3 | 0 | 0 | 80 |
| homeowner_ledger_events | 59 | 0 | 0 | 657 |
| loss_draft_audit_log | 5 | 0 | 0 | 96 |
| loss_draft_documents | 1 | 0 | 0 | 217 |
| loss_draft_tracking | 2 | 0 | 0 | 34 |
| mortgage_companies | 2 | 0 | 0 | 2 |
| mortgage_desk_config | 1 | 0 | 1 | 0 |
| notification_preferences | 2 | 0 | 0 | 0 |
| payment_event_log | 23 | 0 | 0 | 243 |
| payment_provider_accounts | 0 | 2 | 0 | 1 |
| payment_provider_files | 0 | 6 | 0 | 0 |
| payment_provider_methods | 1 | 0 | 0 | 2 |
| payment_wallets | 0 | 1 | 0 | 0 |
| payment_webhook_events | 30 | 0 | 0 | 227 |
| profiles | 0 | 8 | 0 | 0 |
| shared_check_messages | 2 | 0 | 0 | 12 |
| shared_checks | 6 | 0 | 0 | 102 |
| stakeholder_account_verification_log | 3 | 0 | 0 | 20 |
| stakeholder_accounts | 2 | 3 | 0 | 64 |
| tenant_email_settings | 0 | 1 | 0 | 0 |
| tenant_usage_logs | 17 | 0 | 0 | 21 |
| tenants | 0 | 2 | 0 | 4 |

Secret columns were not copied (`[redacted]` omitted; null preserved).

## Preferred auth method (not added)

Production `profiles.preferred_auth_method` is present. AWS login uses Cognito WebAuthn / EMAIL_OTP; the write allowlist ignores this column. It was **not** added to staging schema.

## Phase 3 — Isolated rehearsal restore/sync

Isolated rehearsal was created without overwriting live `checksops`, then migratable business tables were replaced with current production rows from the DB bridge. Secret columns with value `[redacted]` were omitted; generated columns were skipped.

| Step | Result |
|---|---|
| Isolated rehearsal DB | `checksops_rehearsal_20260905` |
| Restore mode | existing_rehearsal_plus_stepup_ddl |
| Overlay apply | PASS (188 rows upserted; 0 table(s) skipped) |
| Live `checksops` data overwritten | **NO** |
| checksops schema-only DDL | **PASS** (empty `financial_stepup_log`, 0 production rows copied) |
| Production Supabase mutated | **NO** |

## Phase 4 — Rehearsal vs live production

| Gate | Result |
|---|---|
| Table row counts | PASS |
| Primary-key sets (fingerprints) | PASS |
| Tenant ownership | PASS |
| Financial aggregates (report-only) | PASS |
| Application-user UUIDs / identity_map | PASS |
| Membership/role relationships | PASS |
| FK integrity | PASS |
| Duplicates / required-null regressions | PASS |

Count mismatches: []  
Financial mismatches: []

## Phase 5 — Storage (already completed; not rerun)

| Item | Result |
|---|---|
| Approved production objects | **1,411** |
| Bytes | **2,565,912,220** |
| Storage migration | **PASS** |
| Staging-only UAT objects | **21** (left in place) |

## Discrepancies & remediation

- TEMPLATE clone copied staging-only identity_accounts onto rehearsal. That table is not production migratable data; live checksops identity_accounts was not modified.

## Repeatable final cutover delta procedure

1. Leave both temporary Lovable bridges deployed.
2. Enter production write-freeze.
3. `health` must remain `mode:read_only` with writes/deletes/rpc/rawSql false.
4. Page `keysOnly` for approved business tables; classify vs the frozen baseline (or vs the prior rehearsal snapshot).
5. Fetch full rows only for reconstruct keys; omit `[redacted]` secret columns.
6. Restore Sept. 1 dump (or last rehearsal snapshot) into a new `checksops_rehearsal_YYYYMMDD`.
7. Apply insert/update/delete delta. Do not overwrite live `checksops`.
8. Reconcile counts, PK fingerprints, financial aggregates (report-only), identity UUID fingerprints, FKs.
9. Storage: inventory delta only; COPY new objects; do not overwrite hash-verified keys.
10. **STOP FOR REVIEW.** Do not switch DNS, auth, webhooks, or provider flags.

## Expected write-freeze window

Still estimated **45–110 minutes** for a final freeze (dump or bridge delta + restore + recon + storage delta). This rehearsal did **not** freeze production.

## Rollback

Production Supabase remains system of record until a future cutover PR.

1. Keep DNS/webhooks on Lovable.
2. Drop `checksops_rehearsal_*` only (`DROP DATABASE` that name). Never drop `postgres` or live `checksops`.
3. Leave S3 production copies in place (append-only).
4. Leave staging Cognito/`identity_accounts` on live `checksops`.

## Verdict

**Bridge validation:** **PASS**  
**DB rehearsal recon:** **PASS**  
**Storage:** **PASS**  
**Overall data-migration readiness:** **PASS**  
**GO/NO-GO for data migration readiness:** **GO for data migration readiness**  
**Production cutover:** **STOP FOR REVIEW — production cutover not performed**

STOP FOR REVIEW. Production cutover was not performed.
