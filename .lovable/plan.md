# ChecksOps Database Slimming — Analysis and Staged Removal Plan

Read-only inventory only. No tables, data, functions, or policies are changed in this step.

## What the inspection found

- 325 tables in the application schema; only ~104 hold any rows.
- Most CRM/AI domains are already empty here (Darwin, carrier_*, claim_intelligence_*, roof, outcome, knowledge, inspections, contractor CRM, tasks-adjacent analytics all report 0 rows). Removal is therefore low-risk on the data side; the risk is entirely in code and foreign keys.
- 144 foreign keys point at `claims`, `claim_files`, `claim_checks`, `clients`, `tasks`, `contractor_profiles`, `claim_photos`. `claims` is the hub the whole CRM hangs from — and `check_intake_items.claim_id` also points at it (112 of 181 checks are linked).
- Live check/payment data: check_intake_items 181, check_payees 490, check_endorsements 502, endorsement_requests 362, check_audit_log 1832, endorsement_audit_log 1257, deposit_batches 111, deposit_items 110, checkalt_deposits 54, disbursement_batches 101, disbursement_splits 100, stakeholder_accounts 58, homeowner_ledger_events 635, claim_folders 1253, claims 179, claim_checks 74, shared_checks 102.
- 13 storage buckets. Only `claim-files` (also the check-image bucket), `endorsement-packets`, `deposit-attachments`, `loss-draft-documents`, `homeowner-uploads`, `tenant-documents`, `tenant-logos`, `company-branding`, `email-assets` serve ChecksOps. `ai-knowledge-base`, `contractor-documents`, `document-templates`, `claim-files-backup` are CRM-side or backup-only.
- Views to retire with their domains: `claim_last_activity`, `claim_money_snapshot`, `contractor_directory_view`, `darwin_source_accuracy_stats`, `recovery_by_carrier`, `recovery_by_escalation`, `recovery_by_loss_type`. Views to keep: all `deposit_*`, `check_dashboard_counts`, `loss_draft_dashboard`, `stale_endorsements`, `tenant_safe`, `tenants_public`.
- The read-only role cannot list `cron.job`, so scheduled jobs must be enumerated with an elevated query before any drop stage runs.

## 1. KEEP — ChecksOps functional areas

- **Check intake & processing:** check_intake_items, check_files, check_payees, check_stakeholders, check_eligibility_results, check_review_decisions, check_status_audit, check_audit_log, check_deletion_log, check_messages, check_message_reads, check_reissue_requests, check_reconciliation_alerts, check_payment_directions, check_deposit_image_backfill_queue, shared_checks, shared_check_messages, outstanding_checks
- **Endorsements & signing:** check_endorsements, check_endorsement_events, endorsement_requests, endorsement_audit_log, endorsement_automated_reminders, signature_requests, signature_signers, signature_fields, signature_field_values, signature_field_templates, signature_document_presets, esign_event_logs
- **Mortgage / loss draft:** loss_draft_tracking, loss_draft_documents, loss_draft_audit_log, loss_draft_releases, loss_draft_mortgage_intake, mortgage_companies, mortgage_handling_requests, mortgage_releases, mortgage_desk_config, mortgage_request_library_documents, check_intake_mortgage_draws, claim_check_mortgage_draws
- **Deposits & reconciliation:** all `deposit_*` tables and `deposit_*` views, bank_balance, cash_flow_forecast
- **CheckAlt:** checkalt_config, checkalt_deposits, checkalt_tenant_accounts, checkalt_webhook_events
- **Moov / payments rail:** payment_provider_accounts, payment_provider_methods, payment_provider_files, payment_methods, payment_method_verifications, micro_deposit_verifications, payment_transfers, payment_transfer_groups, payment_event_log, payment_webhook_events, payment_idempotency_keys, payment_sweep_configs, payment_wallets, payment_wallet_ledger, payment_wallet_sub_ledgers, wallet_funding_queue, moov_invoices, moov_invoice_customers, ach_authorizations
- **Legacy rails still referenced:** actum_transactions, plaid_transfer_events, plaid_webhook_cursors, increase_settings (keep per the "never delete Actum" rule)
- **Disbursements & recipients:** disbursement_batches, disbursement_splits, external_payment_recipients, stakeholder_accounts, stakeholder_account_verification_log, stakeholder_limit_requests, recipient_tax_profiles
- **Homeowner ledger / uploads:** homeowner_ledger_events, homeowner_ledger_tokens, homeowner_ledger_check_uploads, homeowner_check_uploads, homeowner_bank_link_tokens
- **Billing, fees, usage:** check_billing_config, check_billing_events, platform_fee_schedules, platform_fee_occurrences, platform_fee_line_items, tenant_billing_accounts, tenant_credit_balances, tenant_credit_transactions, tenant_usage_logs, tenant_maintenance_payments
- **Tenancy, identity, access:** tenants, tenant_users, tenant_partnerships, tenant_partner_code_aliases, tenant_bank_accounts, tenant_email_settings, tenant_documents, profiles, user_roles, user_sessions, role_version_tracker, company_branding, orgs, org_members
- **Compliance & audit:** audit_logs, glba_security_events, pii_reveal_logs, privacy_notice_acknowledgments, encryption_keys, storage_backup_log
- **Notifications tied to payments:** notifications, notification_preferences, notification_delivery_logs, email_send_log, email_send_state, email_unsubscribe_tokens, suppressed_emails

## 2. REMOVE — Freedom CRM domains (all currently empty here)

- **Darwin / AI copilot:** darwin_* (13 tables), ai_generated_tasks, ai_knowledge_chunks, ai_knowledge_documents, ai_response_cache, autopilot_action_feedback, autopilot_model_snapshot, clawdbot_config, clawdbot_message_log
- **Carrier strategy & argumentation:** carrier_argument_queue, carrier_argument_rebuttals, carrier_behavior_analytics, carrier_behavior_profiles, carrier_playbooks, carrier_scenario_playbooks, carrier_scenario_tactics, counter_arguments, rebuttal_playbook_cards, qualifying_language_templates, causation_rubric_weights, evidence_effectiveness
- **Claim intelligence & documents:** claim_document_chunks, claim_document_dismantlers, claim_document_intelligence, claim_document_meaning, claim_intelligence_cache, claim_intelligence_summary, claim_intelligence_version, claim_knowledge_library, claim_file_segments, document_analysis_results, document_intelligence_queue, document_meaning_queue, extracted_document_data
- **Estimating / roof / inventory:** claim_estimate_analysis, claim_line_item_justifications, claim_roof_measurements, claim_roof_outline_edits, claim_roof_validations, claim_home_inventory, inventory_scan_runs, photo_line_item_links, line_item_requirement_rules, manufacturer_specs, building_code_citations, building_footprints, building_footprint_ingestion_logs, zip_geocache
- **Outcome / prediction / learning:** claim_outcome_events, claim_outcome_learning, claim_outcome_predictions, claim_outcomes, claim_performance_attribution, claim_predictive_analysis, claim_scenario_simulations, claim_strategic_insights, claim_strategic_snapshots, claim_strategy_simulations, claim_thesis_objects, claim_violation_detections, claim_contradiction_detections, claim_causation_tests, claim_argument_map, claim_hidden_loss_checks, hidden_loss_checklist_items, prediction_accuracy_metrics, scenario_accuracy_metrics, strategic_weight_versions, strategy_outcome_tracking, smart_follow_up_recommendations, learned_rule_candidates, learned_rules_active, industry_notes_cache
- **Adjusting workflow:** adjusters, claim_adjusters, claim_carrier_deadlines, claim_deadlines, claim_communications_diary, claim_context_pipelines, claim_followup_log, claim_photo_findings, claim_policy_analysis, claim_warnings_log, claim_master_state, claim_events, claim_updates, claim_additional_contacts, claim_custom_field_values, custom_fields, claim_staff, claim_statuses, claim_sub_statuses, claim_partner_assignments, inspections, insurance_companies, loss_types, state_insurance_regulations, escalation_actions, escalation_artifact_templates, escalation_trigger_rules, status_urgency_rules, status_urgency_notifications_log, urgency_sms_recipients
- **CRM finances not tied to checks:** claim_expenses, claim_fees, claim_normal_bills, claim_loss_of_use_expenses, claim_settlements, expenses_categories, expenses_payees, reserve_config, payroll_runs, org_sales_commissions
- **Contractor / client CRM & marketing:** contractor_profiles, contractor_documents, contractor_reviews, contractor_claim_invites, homeowner_directory_leads, homeowner_intro_requests, referrers, referral_alerts, referral_events, referral_professionals, referral_recommendations
- **Workspaces / guided / collaboration:** workspaces, workspace_members, workspace_invites, workspace_messages, workspace_threads, linked_workspaces, linked_claims, guided_claim_access, guided_claim_map, guided_communications, client_portal_pins, user_notes, user_licenses, file_comments, generated_assets, document_templates, email_templates, email_connections, emails, sms_messages, sms_templates, sms_conversation_state, user_phone_links, docupost_contacts, onesx_orders, jobnimbus_sync_queue, claim_ai_conversations, claim_ai_pending_actions
- **Tasks & CRM automation:** tasks, task_activity_events, task_automations, claim_microtasks, claim_automations, automations, automation_executions, workflow_automation_rules, global_automation_settings, tenant_openai_credentials

## 3. REVIEW / REFACTOR — mixed-purpose tables

| Table | Finding | Recommendation |
|---|---|---|
| `claims` (179 rows) | Hub for 130+ CRM FKs, but `check_intake_items.claim_id` (112 rows) and loss-draft/homeowner-ledger flows depend on it | Replace with `check_cases` (see section 5); migrate the 112 referenced rows only |
| `claim_checks` (74) | Legacy check table; `check_payment_directions`, `claim_disbursements`, `mortgage_releases`, `claim_check_mortgage_draws` still FK to it | Audit whether all 74 have a `check_intake_items` counterpart; keep read-only until confirmed, then fold into check_intake_items |
| `claim_check_payments` (0), `claim_disbursements` (0) | Superseded by disbursement_batches/splits and payment_transfers | Remove after confirming no edge function writes |
| `claim_files` (3) + `claim_folders` (1253) | Same bucket as check images; folders volume is CRM document library | Keep the minimum needed for loss-draft/tenant documents; retire the CRM folder tree |
| `claim_photos` (0) | No rows, but referenced in check-upload code paths | Confirm check uploads write to `check_files`, then remove |
| `claim_payments` (9), `claim_settlements` (60), `claim_operational_state` (41) | CRM accounting/state with real rows | Export to archive before dropping; not referenced by payment rails |
| `clients` (0), `claim_contractors` (0) | Empty; payment recipients live in `stakeholder_accounts` / `external_payment_recipients` | Remove |
| `tasks` (6) | Referenced 125x in code, all CRM surfaces | Remove with the CRM UI removal |
| Email/SMS stack | `email_send_log` (44) is payment-notification traffic; `emails`, `sms_*` are CRM | Keep send log/state/unsubscribe/suppression; remove the CRM messaging tables |
| `loss_draft_*`, `mortgage_*` | Check-tied | Keep; only re-point `claim_id` to `check_cases` |
| `signature_*`, `esign_event_logs` | Shared between endorsement packets and CRM contracts | Keep; drop the CRM contract templates only |
| `cash_job*` (0 rows) | ChecksOps cash-job check source per workspace rules | Keep |

## 4. Dependency surface for the removal set

- **Foreign keys:** 130 FKs into `claims`, 12 into `claim_files`, 4 into `claim_checks`, plus `clients`, `tasks`, `contractor_profiles`, `claim_photos` parents. Every one must be dropped or re-pointed before `claims` can go.
- **Views:** claim_last_activity, claim_money_snapshot, contractor_directory_view, darwin_source_accuracy_stats, recovery_by_carrier, recovery_by_escalation, recovery_by_loss_type.
- **Functions/triggers:** the schema carries ~985 functions and ~261 triggers; the claim-side ones (bump_claim_last_activity, bump_claim_activity_on_status_change, bump_claim_intelligence_version, capture_claim_outcome, auto_generate_claim_microtasks, auto_sync_claim_to_contractor_instance, contractor tier triggers, rule-learning helpers) go with their tables. Check/deposit triggers (advance_check_*, submit_check_review_decision, admin_override_check_status, log_usage_event, billing triggers) stay untouched.
- **Edge functions:** Darwin/AI/dismantler/rule-learning/estimate/roof/SMS-copilot functions become dead — roughly the `darwin-*`, `claim-*intelligence*`, `document-*`, `rule-learning-*`, `carrier-*`, `clawdbot-*` families. Check, endorsement, deposit, CheckAlt, Moov, mortgage, ledger, billing functions stay.
- **Frontend:** heaviest references are `claims` (209), `tasks` (70), `claim_files` (63), `profiles` (48), `claim_checks` (41), `darwin_analysis_results` (36). The CRM pages (Claims, Tasks, Networking, Darwin, Workspaces, Clients, ContractorPortal, GuidedPortal, Templates) are Freedom-only and get deleted alongside.
- **Generated types:** `src/integrations/supabase/types.ts` regenerates after each migration stage; every stage needs a compile pass.
- **RLS:** each dropped table takes its policies with it. No shared policy helper depends on CRM tables except `has_role`, which stays.
- **Cron:** must be listed with an elevated query first — the read-only role is denied on `cron.job`. Any claim/Darwin/AI job gets unscheduled before its tables drop.
- **Storage:** retire `ai-knowledge-base`, `contractor-documents`, `document-templates` (and decide on `claim-files-backup`). `claim-files` stays — it is the check-image bucket.

## 5. Recommended canonical model

Yes — replace the `claims` dependency with a slim link table rather than keeping a 74-column CRM record.

```text
check_cases
  id                    uuid pk
  tenant_id             uuid not null           -- org scope for RLS
  external_system       text                    -- 'freedom_crm' | 'jobnimbus' | 'manual'
  external_claim_id     uuid                    -- original claims.id
  claim_number          text
  insured_name          text
  property_address      text
  carrier_name          text
  loan_number           text                    -- loss-draft workflows need it
  mortgage_company_id   uuid null
  status                text                    -- check-pipeline status only
  created_at / updated_at
```

Everything currently pointing at `claims` from a payment flow (`check_intake_items`, `loss_draft_tracking`, `homeowner_ledger_*`, `mortgage_releases`, `claim_check_mortgage_draws`, `signature_requests`) re-points to `check_cases.id`. Keep `claim_id` as a nullable legacy column for one release, then drop it.

The going-forward core is roughly 90 tables: check pipeline, endorsements, mortgage/loss draft, deposits, CheckAlt, Moov/rails, disbursements/recipients, billing/usage, tenancy/identity, compliance/audit, notifications.

## 6. Staged migration order (no downtime, no data loss)

1. **Freeze & snapshot.** Full backup plus CSV export of every table holding rows that will be dropped (claim_payments 9, claim_settlements 60, claim_operational_state 41, claim_updates 8, tasks 6, claim_folders 1253, claim_files 3, claims 179).
2. **Enumerate cron & triggers with elevated access**; unschedule CRM/AI jobs.
3. **Frontend removal only.** Delete CRM routes, pages, hooks. Ship and verify the check flows are untouched. No schema change yet.
4. **Edge function removal.** Delete the dead AI/CRM functions, redeploy.
5. **Create `check_cases`** and backfill from the 112 claims actually referenced by checks. Add nullable `case_id` columns beside existing `claim_id`.
6. **Dual-write / read-switch.** Point check, loss-draft, ledger, mortgage, and signature code at `case_id`; keep `claim_id` populated. Verify in production for one cycle.
7. **Drop leaf CRM tables** (all zero-row AI/strategy/estimating/carrier groups) — no FK children, safest bulk drop.
8. **Drop mid-tier CRM tables** (tasks, automations, messaging, contractor/client, workspaces, guided) after their leaves are gone.
9. **Drop CRM views, functions, triggers** left orphaned.
10. **Drop `claim_id` columns**, then `claim_files`/`claim_folders`/`claim_photos`/`claim_checks`, then `claims`, then `clients`.
11. **Storage cleanup** — remove retired buckets after object export.
12. **Post-cleanup:** regenerate types, rerun the security linter, confirm every remaining public table still has RLS plus grants.

## 7. Looks like CRM, actually required

- **`claim-files` bucket** — this is the check-image bucket (`CHECK_IMAGES_BUCKET`). Never remove.
- **`claims`** — cannot be dropped before `check_cases` exists and 112 check links are migrated.
- **`claim_checks` / `check_payment_directions` / `claim_check_mortgage_draws` / `mortgage_releases`** — carry live check and mortgage-release data.
- **`claim_folders`** — 1253 rows; some hold loss-draft and endorsement documents.
- **`loss_draft_*` and `mortgage_*`** — core ChecksOps despite claim-flavoured names.
- **`homeowner_ledger_*`, `homeowner_check_uploads`, `homeowner_bank_link_tokens`** — payment-tracking, not CRM.
- **`signature_*` and `esign_event_logs`** — drive endorsement packets.
- **`actum_transactions`, `plaid_*`, `increase_settings`** — hidden behind rail flags, not dead.
- **`cash_job*`** — ChecksOps check source, empty only because unused so far.
- **`claim_operational_state` (41 rows)** — verify nothing in the deposit dashboards reads it before dropping.
