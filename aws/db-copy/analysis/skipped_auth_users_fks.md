# 47 skipped public foreign keys to `auth.users`

The approved backup is authoritative. Live inventory said 0 public FKs to `auth.users`; the dump has 47 on public tables (plus 8 more inside schema `auth`, which were never in scope).

These constraints were **not restored** (Auth users were not loaded). Do not restore them in this phase.

Occupancy and distinct user IDs come from dump `TABLE DATA` (row counts match the restored 166-table artifacts for all 44 involved tables). Union of distinct referenced IDs across all 47 columns: **9** (same as live `auth.users` count). No Auth password hashes or user rows were loaded.

## Cognito replacement categories (do not apply now)

| Category | Count | When Auth moves to Cognito |
| --- | ---: | --- |
| identity_primary_key | 1 | Must remap. `profiles.id` is `auth.users.id` (`ON DELETE CASCADE`). |
| identity_membership_or_profile | 6 | Must remap. Tenant membership, roles, contractor profile, notifications, reviews author, referral user. Several use `ON DELETE CASCADE`. |
| audit_actor_has_data | 20 | Replace with Cognito subject or `profiles.id` after identity map. Keep as UUID audit columns. |
| audit_actor_currently_empty | 20 | Same remap if the column is kept; no current values. |

All 47 `ON UPDATE` are `NO ACTION`. `ON DELETE`: 30 `NO ACTION`, 12 `SET NULL`, 5 `CASCADE` (`profiles_id_fkey`, `tenant_users_user_id_fkey`, `user_roles_user_id_fkey`, `contractor_profiles_user_id_fkey`, `notification_preferences_user_id_fkey`).

## Inventory

| Public table | Column | FK constraint | Referenced | ON DELETE | ON UPDATE | Has data | Distinct user IDs | Non-null rows | Cognito replacement |
| --- | --- | --- | --- | --- | --- | --- | ---: | ---: | --- |
| `ach_authorizations` | `authorized_by` | `ach_authorizations_authorized_by_fkey` | `auth.users.id` | NO ACTION | NO ACTION | yes | 1 | 10 | audit_actor_has_data |
| `ach_authorizations` | `revoked_by` | `ach_authorizations_revoked_by_fkey` | `auth.users.id` | NO ACTION | NO ACTION | no | 0 | 0 | audit_actor_currently_empty |
| `audit_logs` | `user_id` | `audit_logs_user_id_fkey` | `auth.users.id` | SET NULL | NO ACTION | yes | 1 | 344 | audit_actor_has_data |
| `cash_job_attachments` | `uploaded_by` | `cash_job_attachments_uploaded_by_fkey` | `auth.users.id` | NO ACTION | NO ACTION | no | 0 | 0 | audit_actor_currently_empty |
| `cash_job_payments` | `created_by` | `cash_job_payments_created_by_fkey` | `auth.users.id` | NO ACTION | NO ACTION | no | 0 | 0 | audit_actor_currently_empty |
| `cash_jobs` | `created_by` | `cash_jobs_created_by_fkey` | `auth.users.id` | NO ACTION | NO ACTION | yes | 1 | 1 | audit_actor_has_data |
| `check_audit_log` | `actor_id` | `check_audit_log_actor_id_fkey` | `auth.users.id` | SET NULL | NO ACTION | yes | 3 | 960 | audit_actor_has_data |
| `check_eligibility_results` | `evaluated_by` | `check_eligibility_results_evaluated_by_fkey` | `auth.users.id` | SET NULL | NO ACTION | yes | 1 | 105 | audit_actor_has_data |
| `check_endorsement_events` | `actor_id` | `check_endorsement_events_actor_id_fkey` | `auth.users.id` | SET NULL | NO ACTION | no | 0 | 0 | audit_actor_currently_empty |
| `check_files` | `uploaded_by` | `check_files_uploaded_by_fkey` | `auth.users.id` | SET NULL | NO ACTION | yes | 2 | 7 | audit_actor_has_data |
| `check_intake_items` | `uploaded_by` | `check_intake_items_uploaded_by_fkey` | `auth.users.id` | SET NULL | NO ACTION | yes | 1 | 112 | audit_actor_has_data |
| `check_stakeholders` | `added_by` | `check_stakeholders_added_by_fkey` | `auth.users.id` | NO ACTION | NO ACTION | yes | 1 | 1 | audit_actor_has_data |
| `claim_check_payments` | `sender_user_id` | `claim_check_payments_sender_user_id_fkey` | `auth.users.id` | NO ACTION | NO ACTION | no | 0 | 0 | audit_actor_currently_empty |
| `claim_checks` | `created_by` | `claim_checks_created_by_fkey` | `auth.users.id` | NO ACTION | NO ACTION | yes | 1 | 11 | audit_actor_has_data |
| `claim_files` | `uploaded_by` | `claim_files_uploaded_by_fkey` | `auth.users.id` | NO ACTION | NO ACTION | no | 0 | 0 | audit_actor_currently_empty |
| `claim_folders` | `created_by` | `claim_folders_created_by_fkey` | `auth.users.id` | NO ACTION | NO ACTION | no | 0 | 0 | audit_actor_currently_empty |
| `claim_payments` | `created_by` | `claim_payments_created_by_fkey` | `auth.users.id` | NO ACTION | NO ACTION | no | 0 | 0 | audit_actor_currently_empty |
| `claim_settlements` | `created_by` | `claim_settlements_created_by_fkey` | `auth.users.id` | NO ACTION | NO ACTION | yes | 1 | 61 | audit_actor_has_data |
| `contractor_profiles` | `user_id` | `contractor_profiles_user_id_fkey` | `auth.users.id` | CASCADE | NO ACTION | yes | 2 | 2 | identity_membership_or_profile |
| `contractor_reviews` | `author_user_id` | `contractor_reviews_author_user_id_fkey` | `auth.users.id` | SET NULL | NO ACTION | no | 0 | 0 | identity_membership_or_profile |
| `deposit_batches` | `created_by` | `deposit_batches_created_by_fkey` | `auth.users.id` | NO ACTION | NO ACTION | yes | 1 | 115 | audit_actor_has_data |
| `disbursement_batches` | `created_by` | `disbursement_batches_created_by_fkey` | `auth.users.id` | NO ACTION | NO ACTION | yes | 1 | 109 | audit_actor_has_data |
| `document_templates` | `created_by` | `document_templates_created_by_fkey` | `auth.users.id` | NO ACTION | NO ACTION | no | 0 | 0 | audit_actor_currently_empty |
| `email_templates` | `created_by` | `email_templates_created_by_fkey` | `auth.users.id` | NO ACTION | NO ACTION | no | 0 | 0 | audit_actor_currently_empty |
| `emails` | `sent_by` | `emails_sent_by_fkey` | `auth.users.id` | NO ACTION | NO ACTION | no | 0 | 0 | audit_actor_currently_empty |
| `homeowner_bank_link_tokens` | `sent_by_user_id` | `homeowner_bank_link_tokens_sent_by_user_id_fkey` | `auth.users.id` | NO ACTION | NO ACTION | yes | 1 | 4 | audit_actor_has_data |
| `micro_deposit_verifications` | `initiated_by` | `micro_deposit_verifications_initiated_by_fkey` | `auth.users.id` | NO ACTION | NO ACTION | yes | 1 | 1 | audit_actor_has_data |
| `mortgage_handling_requests` | `assigned_employee_id` | `mortgage_handling_requests_assigned_employee_id_fkey` | `auth.users.id` | SET NULL | NO ACTION | yes | 2 | 2 | audit_actor_has_data |
| `mortgage_handling_requests` | `requested_by` | `mortgage_handling_requests_requested_by_fkey` | `auth.users.id` | SET NULL | NO ACTION | yes | 1 | 2 | audit_actor_has_data |
| `notification_preferences` | `user_id` | `notification_preferences_user_id_fkey` | `auth.users.id` | CASCADE | NO ACTION | no | 0 | 0 | identity_membership_or_profile |
| `payroll_runs` | `initiated_by` | `payroll_runs_initiated_by_fkey` | `auth.users.id` | NO ACTION | NO ACTION | no | 0 | 0 | audit_actor_currently_empty |
| `pii_reveal_logs` | `user_id` | `pii_reveal_logs_user_id_fkey` | `auth.users.id` | SET NULL | NO ACTION | no | 0 | 0 | audit_actor_currently_empty |
| `platform_announcements` | `created_by` | `platform_announcements_created_by_fkey` | `auth.users.id` | SET NULL | NO ACTION | no | 0 | 0 | audit_actor_currently_empty |
| `profiles` | `id` | `profiles_id_fkey` | `auth.users.id` | CASCADE | NO ACTION | yes | 8 | 8 | identity_primary_key |
| `referral_events` | `referred_user_id` | `referral_events_referred_user_id_fkey` | `auth.users.id` | NO ACTION | NO ACTION | yes | 2 | 2 | identity_membership_or_profile |
| `signature_document_presets` | `created_by` | `signature_document_presets_created_by_fkey` | `auth.users.id` | NO ACTION | NO ACTION | no | 0 | 0 | audit_actor_currently_empty |
| `signature_requests` | `created_by` | `signature_requests_created_by_fkey` | `auth.users.id` | NO ACTION | NO ACTION | no | 0 | 0 | audit_actor_currently_empty |
| `sms_messages` | `user_id` | `sms_messages_user_id_fkey` | `auth.users.id` | NO ACTION | NO ACTION | no | 0 | 0 | audit_actor_currently_empty |
| `stakeholder_account_verification_log` | `actor_user_id` | `stakeholder_account_verification_log_actor_user_id_fkey` | `auth.users.id` | NO ACTION | NO ACTION | yes | 1 | 20 | audit_actor_has_data |
| `stakeholder_accounts` | `created_by` | `stakeholder_accounts_created_by_fkey` | `auth.users.id` | NO ACTION | NO ACTION | yes | 2 | 67 | audit_actor_has_data |
| `stakeholder_limit_requests` | `requested_by` | `stakeholder_limit_requests_requested_by_fkey` | `auth.users.id` | NO ACTION | NO ACTION | no | 0 | 0 | audit_actor_currently_empty |
| `stakeholder_limit_requests` | `reviewed_by` | `stakeholder_limit_requests_reviewed_by_fkey` | `auth.users.id` | NO ACTION | NO ACTION | no | 0 | 0 | audit_actor_currently_empty |
| `tenant_billing_accounts` | `ach_authorized_by` | `tenant_billing_accounts_ach_authorized_by_fkey` | `auth.users.id` | NO ACTION | NO ACTION | no | 0 | 0 | audit_actor_currently_empty |
| `tenant_maintenance_payments` | `recorded_by` | `tenant_maintenance_payments_recorded_by_fkey` | `auth.users.id` | NO ACTION | NO ACTION | yes | 1 | 1 | audit_actor_has_data |
| `tenant_openai_credentials` | `created_by` | `tenant_openai_credentials_created_by_fkey` | `auth.users.id` | SET NULL | NO ACTION | yes | 1 | 1 | audit_actor_has_data |
| `tenant_users` | `user_id` | `tenant_users_user_id_fkey` | `auth.users.id` | CASCADE | NO ACTION | yes | 7 | 7 | identity_membership_or_profile |
| `user_roles` | `user_id` | `user_roles_user_id_fkey` | `auth.users.id` | CASCADE | NO ACTION | yes | 9 | 10 | identity_membership_or_profile |
