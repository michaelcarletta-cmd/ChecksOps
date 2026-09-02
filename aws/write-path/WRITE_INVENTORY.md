# ChecksOps frontend write inventory (current `main`)

Rescan of `src/` `*.ts` / `*.tsx` on the unified codebase after PR #93 (`aws-migration` merged into `main`). Production ChecksOps still uses these call sites through the Supabase browser client. AWS mode (`VITE_AUTH_PROVIDER=cognito`) intercepts them via `src/integrations/aws/client.ts`.

This replaces counts in `aws/frontend/SUPABASE_FRONTEND_INVENTORY.md` (293 DML / 125 tables at the original adapter scan). Additional ChecksOps work has landed since then; table uniqueness dropped because the adapter inventory counted every `.from()` including reads.

## Totals

| Kind | Count | Notes |
| --- | ---: | --- |
| DML `.insert` / `.update` / `.upsert` / `.delete` | **298** | insert 101, update 134, upsert 5, delete 58 |
| Unique DML tables | **73** (+ 15 unresolved builder/generic sites) | Unresolved: `CrudDropdown`, `useListViewState` (URL only), AWS client builder, toast, platform banner |
| `.rpc()` | 87 | 61 unique functions |
| `functions.invoke()` | 127 | 79 unique edge functions |
| `storage.from()` buckets | 5 named | claim-files, company-branding, tenant-logos, deposit-attachments, loss-draft-documents |

Highest-volume DML tables: `check_intake_items` (32), `tenants` (18), `check_audit_log` (13), `profiles` (12), `check_payees` (11), `mortgage_handling_requests` (11).

## Risk classification

### 1. Low-risk application CRUD

Non-financial notes/settings/read-receipts. No money movement, no provider calls, no auth changes.

| Table | DML | Live UI on current `main`? | Tranche |
| --- | --- | --- | --- |
| `check_message_reads` | 1 upsert | **Yes.** `CheckMessageThread` (Messages tab, check-detail Partners tab, loss-draft thread) | **Tranche 1** |
| `notification_preferences` | 1 update + RPC `get_or_create_notification_preferences` | Component existed; mounted on white-label Settings → Profile in this phase so the existing card is reachable | **Tranche 1** |
| `deposit_notification_prefs` | insert/update | Only `DepositManagerCommandCenter`, which is not routed | later |
| `signature_document_presets` | insert/update/delete | Component not routed | later |
| `contractor_profiles` | insert/update | White-label Find-a-Pro settings | later |
| `privacy_notice_acknowledgments` | insert | Public `/privacy-notice` (not Cognito-authenticated) | later / public API |
| `referral_alerts` | update | Referral settings | later |

### 2. Claim/check workflow writes

Do **not** migrate in Tranche 1. Includes check stage changes, payees, endorsements, messages (INSERT mirrors `homeowner_ledger_events`), audit log, files, stakeholders, shared checks, claims, mortgage handling, loss draft, signatures, homeowner ledger tokens/uploads.

| Table | Total DML |
| --- | ---: |
| `check_intake_items` | 32 |
| `check_audit_log` | 13 |
| `check_payees` | 11 |
| `mortgage_handling_requests` | 11 |
| `claim_checks` | 9 |
| `check_endorsements` | 8 |
| `check_messages` | 7 |
| `signature_requests` | 7 |
| `claims` | 5 |
| `check_stakeholders` | 5 |
| `loss_draft_documents` / `loss_draft_tracking` / `loss_draft_audit_log` | 14 combined |
| `shared_checks` / `shared_check_messages` | 4 |
| `homeowner_ledger_events` | 3 |
| `check_files`, `check_endorsement_events`, `check_payment_directions`, `check_intake_mortgage_draws` | remaining |

`check_messages` INSERT is blocked for AWS writes: trigger `trg_mirror_check_message_to_homeowner_ledger` writes `homeowner_ledger_events` on INSERT and would change ledger aggregates.

### 3. Storage writes

Uploads/deletes remain `uploads_disabled` on AWS staging. Reads/sign/list already use S3. Buckets: `claim-files`, `deposit-attachments`, `loss-draft-documents`, `company-branding`, `tenant-logos`.

### 4. Authentication / account writes

`profiles`, `user_roles`, `tenant_users`, `user_passkeys`, `user_sessions`, Cognito `auth.*`. Out of scope. Identity mapping stays `Cognito sub → identity_accounts.application_user_id → ChecksOps UUID → request.app_user_id → auth.uid()`.

### 5. Financial / payment / disbursement writes

`disbursement_splits`, `disbursement_batches`, `deposit_items`, `deposit_attachments`, `deposit_exceptions`, `deposit_automation_settings`, `deposit_escalation_*`, `claim_check_payments`, `claim_disbursements`, `claim_settlements`, `cash_jobs` / `cash_job_*`, `payment_wallet_sub_ledgers`, `tenant_billing_accounts`, `tenant_bank_accounts`, `tenant_wallet_funding_settings`, `tenant_maintenance_payments`, `payroll_runs`, `ach_authorizations`, `stakeholder_accounts`, `stakeholder_limit_requests`, `recipient_tax_profiles`, `homeowner_ledger_events`.

Denied by the Tranche 1 allowlist with `reason: financial_or_provider`.

### 6. Provider-dependent writes

| Provider | Frontend evidence | AWS staging |
| --- | --- | --- |
| Moov | `functions.invoke` payment/disburse/wallet; `src/lib/payments/providers/moovProvider.ts` | `provider_disabled` |
| CheckAlt | `checkalt_config`, `checkalt_tenant_accounts`, CheckAlt settings | `provider_disabled` |
| Plaid | invoke + `plaid_*` tables | `provider_disabled` |
| Actum | `actum_transactions` (read allowlist only) | denied |
| QuickBooks | `quickbooks-auth`, `quickbooks-payment` invokes | `provider_disabled` |
| email/SMS | `send-transactional-email`, `sms_messages`, Resend invokes, `tenant_email_settings` | `provider_disabled` / not allowlisted |

Write RPCs still disabled on `POST /data/rpc` except the Tranche 1 client intercept of `get_or_create_notification_preferences` (implemented as allowlisted INSERT/SELECT, **not** GRANT EXECUTE on the SECURITY DEFINER RPC, which accepts client `p_user_id`).

### 7. Administrative / platform-owner writes

`tenants` (18), `AdminTenants`, platform announcements, tenant partner/branding/domain, KYC `glba_security_events` + tenant KYC columns. Out of scope.

## Upserts on current `main`

`check_message_reads`, `mortgage_handling_requests`, `recipient_tax_profiles`, `tenant_wallet_funding_settings`, `tenants`. Only `check_message_reads` is Tranche 1.

## Intentionally not migrated

Every other DML table, all provider invokes, storage uploads, write RPCs, generic `POST /data/*` (still `writes_disabled`), and production Supabase.
