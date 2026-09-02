# 47 skipped `auth.users` FK retargeting plan

**Status: proposed only. Not applied.**

Original parent: `auth.users(id)` (Supabase Auth). AWS staging does not use `auth.users` as the application identity.

New parent: `public.identity_accounts(application_user_id)` — the preserved ChecksOps UUID.

Do not point these FKs at Cognito `sub`. Do not rewrite stored UUID values. Keep dump `ON DELETE` / `ON UPDATE`.

`profiles.id` is the same UUID when a profile exists. It is **not** sufficient as the sole parent today: UUID `dd24eea5-5d12-47d1-999e-d5930c278b7d` has `user_roles` and no `profiles` row. Attaching `user_roles.user_id` → `profiles.id` would fail until a same-id profile exists.

SQL: `aws/rls/sql/07_fk_retarget_plan.sql` (all statements commented). Mirror: `aws/identity/sql/06_retarget_auth_users_fks.sql`.

## Per-constraint map (47)

| # | Table | Column | Constraint (dump name) | ON DELETE | Data | Distinct UUIDs | Non-null rows | Group |
| ---: | --- | --- | --- | --- | --- | ---: | ---: | --- |
| 1 | `ach_authorizations` | `authorized_by` | `ach_authorizations_authorized_by_fkey` | NO ACTION | yes | 1 | 10 | audit_actor_has_data |
| 2 | `ach_authorizations` | `revoked_by` | `ach_authorizations_revoked_by_fkey` | NO ACTION | no | 0 | 0 | audit_actor_currently_empty |
| 3 | `audit_logs` | `user_id` | `audit_logs_user_id_fkey` | SET NULL | yes | 1 | 344 | audit_actor_has_data |
| 4 | `cash_job_attachments` | `uploaded_by` | `cash_job_attachments_uploaded_by_fkey` | NO ACTION | no | 0 | 0 | audit_actor_currently_empty |
| 5 | `cash_job_payments` | `created_by` | `cash_job_payments_created_by_fkey` | NO ACTION | no | 0 | 0 | audit_actor_currently_empty |
| 6 | `cash_jobs` | `created_by` | `cash_jobs_created_by_fkey` | NO ACTION | yes | 1 | 1 | audit_actor_has_data |
| 7 | `check_audit_log` | `actor_id` | `check_audit_log_actor_id_fkey` | SET NULL | yes | 3 | 960 | audit_actor_has_data |
| 8 | `check_eligibility_results` | `evaluated_by` | `check_eligibility_results_evaluated_by_fkey` | SET NULL | yes | 1 | 105 | audit_actor_has_data |
| 9 | `check_endorsement_events` | `actor_id` | `check_endorsement_events_actor_id_fkey` | SET NULL | no | 0 | 0 | audit_actor_currently_empty |
| 10 | `check_files` | `uploaded_by` | `check_files_uploaded_by_fkey` | SET NULL | yes | 2 | 7 | audit_actor_has_data |
| 11 | `check_intake_items` | `uploaded_by` | `check_intake_items_uploaded_by_fkey` | SET NULL | yes | 1 | 112 | audit_actor_has_data |
| 12 | `check_stakeholders` | `added_by` | `check_stakeholders_added_by_fkey` | NO ACTION | yes | 1 | 1 | audit_actor_has_data |
| 13 | `claim_check_payments` | `sender_user_id` | `claim_check_payments_sender_user_id_fkey` | NO ACTION | no | 0 | 0 | audit_actor_currently_empty |
| 14 | `claim_checks` | `created_by` | `claim_checks_created_by_fkey` | NO ACTION | yes | 1 | 11 | audit_actor_has_data |
| 15 | `claim_files` | `uploaded_by` | `claim_files_uploaded_by_fkey` | NO ACTION | no | 0 | 0 | audit_actor_currently_empty |
| 16 | `claim_folders` | `created_by` | `claim_folders_created_by_fkey` | NO ACTION | no | 0 | 0 | audit_actor_currently_empty |
| 17 | `claim_payments` | `created_by` | `claim_payments_created_by_fkey` | NO ACTION | no | 0 | 0 | audit_actor_currently_empty |
| 18 | `claim_settlements` | `created_by` | `claim_settlements_created_by_fkey` | NO ACTION | yes | 1 | 61 | audit_actor_has_data |
| 19 | `contractor_profiles` | `user_id` | `contractor_profiles_user_id_fkey` | CASCADE | yes | 2 | 2 | identity_membership_or_profile |
| 20 | `contractor_reviews` | `author_user_id` | `contractor_reviews_author_user_id_fkey` | SET NULL | no | 0 | 0 | identity_membership_or_profile |
| 21 | `deposit_batches` | `created_by` | `deposit_batches_created_by_fkey` | NO ACTION | yes | 1 | 115 | audit_actor_has_data |
| 22 | `disbursement_batches` | `created_by` | `disbursement_batches_created_by_fkey` | NO ACTION | yes | 1 | 109 | audit_actor_has_data |
| 23 | `document_templates` | `created_by` | `document_templates_created_by_fkey` | NO ACTION | no | 0 | 0 | audit_actor_currently_empty |
| 24 | `email_templates` | `created_by` | `email_templates_created_by_fkey` | NO ACTION | no | 0 | 0 | audit_actor_currently_empty |
| 25 | `emails` | `sent_by` | `emails_sent_by_fkey` | NO ACTION | no | 0 | 0 | audit_actor_currently_empty |
| 26 | `homeowner_bank_link_tokens` | `sent_by_user_id` | `homeowner_bank_link_tokens_sent_by_user_id_fkey` | NO ACTION | yes | 1 | 4 | audit_actor_has_data |
| 27 | `micro_deposit_verifications` | `initiated_by` | `micro_deposit_verifications_initiated_by_fkey` | NO ACTION | yes | 1 | 1 | audit_actor_has_data |
| 28 | `mortgage_handling_requests` | `assigned_employee_id` | `mortgage_handling_requests_assigned_employee_id_fkey` | SET NULL | yes | 2 | 2 | audit_actor_has_data |
| 29 | `mortgage_handling_requests` | `requested_by` | `mortgage_handling_requests_requested_by_fkey` | SET NULL | yes | 1 | 2 | audit_actor_has_data |
| 30 | `notification_preferences` | `user_id` | `notification_preferences_user_id_fkey` | CASCADE | no | 0 | 0 | identity_membership_or_profile |
| 31 | `payroll_runs` | `initiated_by` | `payroll_runs_initiated_by_fkey` | NO ACTION | no | 0 | 0 | audit_actor_currently_empty |
| 32 | `pii_reveal_logs` | `user_id` | `pii_reveal_logs_user_id_fkey` | SET NULL | no | 0 | 0 | audit_actor_currently_empty |
| 33 | `platform_announcements` | `created_by` | `platform_announcements_created_by_fkey` | SET NULL | no | 0 | 0 | audit_actor_currently_empty |
| 34 | `profiles` | `id` | `profiles_id_fkey` | CASCADE | yes | 8 | 8 | identity_primary_key |
| 35 | `referral_events` | `referred_user_id` | `referral_events_referred_user_id_fkey` | NO ACTION | yes | 2 | 2 | identity_membership_or_profile |
| 36 | `signature_document_presets` | `created_by` | `signature_document_presets_created_by_fkey` | NO ACTION | no | 0 | 0 | audit_actor_currently_empty |
| 37 | `signature_requests` | `created_by` | `signature_requests_created_by_fkey` | NO ACTION | no | 0 | 0 | audit_actor_currently_empty |
| 38 | `sms_messages` | `user_id` | `sms_messages_user_id_fkey` | NO ACTION | no | 0 | 0 | audit_actor_currently_empty |
| 39 | `stakeholder_account_verification_log` | `actor_user_id` | `stakeholder_account_verification_log_actor_user_id_fkey` | NO ACTION | yes | 1 | 20 | audit_actor_has_data |
| 40 | `stakeholder_accounts` | `created_by` | `stakeholder_accounts_created_by_fkey` | NO ACTION | yes | 2 | 67 | audit_actor_has_data |
| 41 | `stakeholder_limit_requests` | `requested_by` | `stakeholder_limit_requests_requested_by_fkey` | NO ACTION | no | 0 | 0 | audit_actor_currently_empty |
| 42 | `stakeholder_limit_requests` | `reviewed_by` | `stakeholder_limit_requests_reviewed_by_fkey` | NO ACTION | no | 0 | 0 | audit_actor_currently_empty |
| 43 | `tenant_billing_accounts` | `ach_authorized_by` | `tenant_billing_accounts_ach_authorized_by_fkey` | NO ACTION | no | 0 | 0 | audit_actor_currently_empty |
| 44 | `tenant_maintenance_payments` | `recorded_by` | `tenant_maintenance_payments_recorded_by_fkey` | NO ACTION | yes | 1 | 1 | audit_actor_has_data |
| 45 | `tenant_openai_credentials` | `created_by` | `tenant_openai_credentials_created_by_fkey` | SET NULL | yes | 1 | 1 | audit_actor_has_data |
| 46 | `tenant_users` | `user_id` | `tenant_users_user_id_fkey` | CASCADE | yes | 7 | 7 | identity_membership_or_profile |
| 47 | `user_roles` | `user_id` | `user_roles_user_id_fkey` | CASCADE | yes | 9 | 10 | identity_membership_or_profile |

## Apply order (later phase)

1. Confirm every non-null FK value exists in `identity_accounts` (including the 9th UUID).
2. `ADD CONSTRAINT … NOT VALID` in the order above (parent `identity_accounts` already populated).
3. `VALIDATE CONSTRAINT` per table in a maintenance window.
4. Optionally add `profiles` for the 9th UUID with the same id, then a second FK `identity_accounts.application_user_id` → `profiles.id` is still unnecessary; keep identity_accounts as the canonical parent.

Auth-schema FKs (`auth.identities`, sessions, MFA, …) stay unrestored. They are not part of the 47.
