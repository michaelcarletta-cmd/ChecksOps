# DB bridge rehearsal recon — PR #127

**Generated:** 2026-09-06T12:02:23.895Z  
**Production cutover performed:** **NO**  
**Live staging DB `checksops` overwritten:** **NO**  
**Rehearsal database:** `checksops_rehearsal_20260906b`

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
| Current production row sum (approved counted) | 12401 |

## Phase 2 — Production delta vs Sept. 1 baseline

Baseline dump: `Migration/checksops_260901(1).backup` (49100401 bytes, cutoff 2026-09-01T20:36:44.000Z).

| Totals | Inserted | Updated | Deleted | Unchanged |
|---|---:|---:|---:|---:|
| All approved business tables | 11616 | 0 | 0 | 0 |

Tables with any insert/update/delete:

| Table | Inserted | Updated | Deleted | Unchanged |
|---|---:|---:|---:|---:|
| ach_authorizations | 10 | 0 | 0 | 0 |
| actum_transactions | 6 | 0 | 0 | 0 |
| audit_logs | 377 | 0 | 0 | 0 |
| cash_jobs | 1 | 0 | 0 | 0 |
| check_audit_log | 2007 | 0 | 0 | 0 |
| check_billing_config | 1 | 0 | 0 | 0 |
| check_billing_events | 126 | 0 | 0 | 0 |
| check_cases | 142 | 0 | 0 | 0 |
| check_deletion_log | 16 | 0 | 0 | 0 |
| check_deposit_image_backfill_queue | 102 | 0 | 0 | 0 |
| check_eligibility_results | 125 | 0 | 0 | 0 |
| check_endorsement_events | 232 | 0 | 0 | 0 |
| check_endorsements | 533 | 0 | 0 | 0 |
| check_files | 11 | 0 | 0 | 0 |
| check_intake_items | 194 | 0 | 0 | 0 |
| check_message_reads | 19 | 0 | 0 | 0 |
| check_messages | 7 | 0 | 0 | 0 |
| check_payees | 525 | 0 | 0 | 0 |
| check_payment_directions | 65 | 0 | 0 | 0 |
| check_reconciliation_alerts | 103 | 0 | 0 | 0 |
| check_reissue_requests | 1 | 0 | 0 | 0 |
| check_review_decisions | 174 | 0 | 0 | 0 |
| check_stakeholders | 8 | 0 | 0 | 0 |
| checkalt_config | 1 | 0 | 0 | 0 |
| checkalt_deposits | 69 | 0 | 0 | 0 |
| checkalt_tenant_accounts | 1 | 0 | 0 | 0 |
| checkalt_webhook_events | 2 | 0 | 0 | 0 |
| claim_checks | 83 | 0 | 0 | 0 |
| claim_files | 3 | 0 | 0 | 0 |
| claim_folders | 1281 | 0 | 0 | 0 |
| claim_operational_state | 183 | 0 | 0 | 0 |
| claim_payments | 18 | 0 | 0 | 0 |
| claim_project_plans | 2 | 0 | 0 | 0 |
| claim_settlements | 64 | 0 | 0 | 0 |
| claims | 183 | 0 | 0 | 0 |
| contractor_profiles | 2 | 0 | 0 | 0 |
| deposit_audit_log | 340 | 0 | 0 | 0 |
| deposit_automation_settings | 3 | 0 | 0 | 0 |
| deposit_batches | 126 | 0 | 0 | 0 |
| deposit_items | 125 | 0 | 0 | 0 |
| deposit_provider_config | 5 | 0 | 0 | 0 |
| disbursement_batches | 118 | 0 | 0 | 0 |
| disbursement_splits | 117 | 0 | 0 | 0 |
| email_send_log | 140 | 0 | 0 | 0 |
| email_send_state | 1 | 0 | 0 | 0 |
| endorsement_audit_log | 1399 | 0 | 0 | 0 |
| endorsement_requests | 400 | 0 | 0 | 0 |
| esign_event_logs | 72 | 0 | 0 | 0 |
| external_payment_recipients | 4 | 0 | 0 | 0 |
| financial_stepup_log | 2 | 0 | 0 | 0 |
| glba_security_events | 85 | 0 | 0 | 0 |
| homeowner_directory_leads | 45 | 0 | 0 | 0 |
| homeowner_intro_requests | 3 | 0 | 0 | 0 |
| homeowner_ledger_check_uploads | 4 | 0 | 0 | 0 |
| homeowner_ledger_events | 716 | 0 | 0 | 0 |
| loss_draft_audit_log | 101 | 0 | 0 | 0 |
| loss_draft_documents | 218 | 0 | 0 | 0 |
| loss_draft_tracking | 36 | 0 | 0 | 0 |
| micro_deposit_verifications | 1 | 0 | 0 | 0 |
| mortgage_companies | 4 | 0 | 0 | 0 |
| mortgage_desk_config | 1 | 0 | 0 | 0 |
| mortgage_handling_requests | 2 | 0 | 0 | 0 |
| notification_preferences | 2 | 0 | 0 | 0 |
| payment_event_log | 266 | 0 | 0 | 0 |
| payment_provider_accounts | 3 | 0 | 0 | 0 |
| payment_provider_files | 6 | 0 | 0 | 0 |
| payment_provider_methods | 3 | 0 | 0 | 0 |
| payment_wallets | 1 | 0 | 0 | 0 |
| payment_webhook_events | 257 | 0 | 0 | 0 |
| plaid_transfer_events | 1 | 0 | 0 | 0 |
| plaid_webhook_cursors | 1 | 0 | 0 | 0 |
| platform_fee_line_items | 1 | 0 | 0 | 0 |
| profiles | 8 | 0 | 0 | 0 |
| referral_events | 2 | 0 | 0 | 0 |
| role_version_tracker | 9 | 0 | 0 | 0 |
| shared_check_messages | 14 | 0 | 0 | 0 |
| shared_checks | 108 | 0 | 0 | 0 |
| signature_field_values | 2 | 0 | 0 | 0 |
| signature_fields | 2 | 0 | 0 | 0 |
| signature_requests | 6 | 0 | 0 | 0 |
| signature_signers | 6 | 0 | 0 | 0 |
| stakeholder_account_verification_log | 23 | 0 | 0 | 0 |
| stakeholder_accounts | 69 | 0 | 0 | 0 |
| tenant_bank_accounts | 1 | 0 | 0 | 0 |
| tenant_credit_balances | 6 | 0 | 0 | 0 |
| tenant_documents | 1 | 0 | 0 | 0 |
| tenant_email_settings | 1 | 0 | 0 | 0 |
| tenant_maintenance_payments | 1 | 0 | 0 | 0 |
| tenant_partner_code_aliases | 1 | 0 | 0 | 0 |
| tenant_partnerships | 3 | 0 | 0 | 0 |
| tenant_usage_logs | 38 | 0 | 0 | 0 |
| tenant_users | 7 | 0 | 0 | 0 |
| tenant_vetting_documents | 3 | 0 | 0 | 0 |
| tenant_wallet_funding_settings | 1 | 0 | 0 | 0 |
| tenants | 6 | 0 | 0 | 0 |
| user_roles | 10 | 0 | 0 | 0 |
| zip_geocache | 2 | 0 | 0 | 0 |

Secret columns were not copied (`[redacted]` omitted; null preserved).

## Preferred auth method (not added)

Production `profiles.preferred_auth_method` is present. AWS login uses Cognito WebAuthn / EMAIL_OTP; the write allowlist ignores this column. It was **not** added to staging schema.

## Phase 3 — Isolated rehearsal restore/sync

Isolated rehearsal was created without overwriting live `checksops`, then migratable business tables were replaced with current production rows from the DB bridge. Secret columns with value `[redacted]` were omitted; generated columns were skipped.

| Step | Result |
|---|---|
| Isolated rehearsal DB | `checksops_rehearsal_20260906b` |
| Restore mode | template_clone_then_overlay |
| Overlay apply | PASS (11616 rows upserted; 0 table(s) skipped) |
| Live `checksops` data overwritten | **NO** |
| checksops schema-only DDL | n/a |
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
