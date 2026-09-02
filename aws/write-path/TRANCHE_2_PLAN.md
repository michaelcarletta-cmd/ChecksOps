# AWS write path — Tranche 2 plan

## Goal

Migrate the **non-money-moving operational check workflow** onto the existing Tranche 1 controlled AWS write path for Cognito staging.

Do **not** migrate deposits, CheckAlt, Moov, Plaid, Actum, QuickBooks, ACH/RTP/wire, disbursements, webhooks, email/SMS, KYC, or storage uploads.

Production ChecksOps (Lovable/Supabase) is unchanged.

## Re-scan of current `main` (after PR #94)

Authoritative frontend DML is still ~298 sites / 73 tables. Check-workflow DML that a normal user hits from Check Command Center:

| User action | Frontend | Existing Supabase op | Tranche 2 |
| --- | --- | --- | --- |
| 1. Open a check | `CheckCommandCenter` queue + detail `select` | SELECT `check_intake_items` + embeds | Already AWS reads |
| 2. Edit safe check information | `EditableField` (check #, carrier, issue date, payee line, property, expiration, multi-payee), `FundsTypeField`, `persistMeta` (funds_type / property_address), admin dialog OCR fields | UPDATE `check_intake_items` | **Yes**, column-scoped |
| 3. Manage payee records | `PayeeManager`, `PayeeReconciliation`, `EndorsementChecklist` add/edit/remove | INSERT/UPDATE/DELETE `check_payees`; DELETE `check_endorsements` / `check_endorsement_events` | **Yes**, record management only |
| 4. Record non-financial workflow notes | `check_audit_log` inserts; `review_notes` | INSERT audit; UPDATE notes | **Yes** |
| 5. Endorsement metadata | contact/name on endorsement rows; payee remove | UPDATE/DELETE `check_endorsements` | **Yes**, not `status`/`signed_at` |
| 6. Add/read check messages | `CheckMessageThread` SELECT + INSERT + soft-delete; read receipts already T1 | INSERT fires ledger trigger | **Read** already; **soft-delete** yes; **INSERT no** (option B) |
| 7. Navigate/save check workflow | queue filters are reads; status/stage/deposit buttons | UPDATE `status`/`check_stage`; RPCs; `functions.invoke` | **No** — ledger, billing, partner HTTP, deposits |

## Money / provider boundary (excluded)

These stay denied even when the same screen also edits safe fields:

- UPDATE `amount`, `pa_fee_*`, `routing_number`, `account_number`
- UPDATE `status` (ledger `sync_homeowner_ledger_from_check` on `UPDATE OF status`)
- UPDATE `check_stage` (mortgage handling billing)
- INSERT `check_intake_items` (ledger `check_received`)
- DELETE check (destroys financial parent)
- Deposit CTAs / `deposit_action` RPC / CheckAlt
- `send_endorsement_request` / generate packet / email/SMS
- Force-complete endorsements (`status=signed` → `advance_check_on_endorsement_complete` → `check_stage=ready_for_deposit` → possible `net.http_post` to Freedom for mirrored checks)
- Image upload path columns / storage writes
- `claim_checks` amount/mortgage mirrors
- Mortgage monitoring timestamps
- `check_messages` INSERT / `shared_check_messages` INSERT
- Homeowner ledger cards

If a save mixes safe + financial columns, AWS staging persists only allowlisted columns (`pickAwsSafeIntakeUpdates`). Production still sends the full payload to Supabase.

## `check_messages` decision: **B**

`mirror_check_message_to_homeowner_ledger()` inserts `homeowner_ledger_events` on INSERT when the check has `claim_id` and `tenant_id`. Enabling INSERT would change `homeowner_ledger_amount`. A parallel “notes-only” table would change product semantics. Soft-delete is INSERT-trigger-free and is enabled.

## Payee vs provider

| Payee record management (T2) | Payee payment / provider (later) |
| --- | --- |
| name, type, contact email/phone | `check-endorsement` invoke send request |
| INSERT creates pending endorsement via existing `tg_mirror_payee_to_endorsement` (metadata only; status stays pending) | Moov stakeholder onboarding |
| DELETE unsigned endorsement rows (DELETE does **not** fire `trg_advance_on_endorsement_complete`) | KYC / payment account creation |
| Client `endorsement_status` / `endorsed_at` ignored | endorsement `status=signed` |

## Endorsement boundary

Allowed: contact, payee_name, payee_type, notes, DELETE.

Denied: `status`, `signed_at`, `signature_method`, tokens, `request_sent_at`, signature image, reminders. No packet, no email, no external signature provider.

Storage downloads already work. Uploads stay for the Storage Write tranche.

## Architecture

Same as Tranche 1:

```
React/Vite (VITE_AUTH_PROVIDER=cognito only)
  -> API Gateway POST /data/write
  -> Lambda checksops-staging-api
  -> write connection as checksops
  -> BEGIN; SET TRANSACTION READ WRITE;
  -> Cognito sub -> identity_accounts.application_user_id -> request.app_user_id -> auth.uid()
  -> allowlisted DML + RLS
  -> COMMIT / ROLLBACK
```

Read pool keeps `-c default_transaction_read_only=on`. No generic SQL. No browser RDS.

Kill switches:

- `AWS_WRITES_ENABLED=true` required (all writes)
- `AWS_CHECK_WORKFLOW_WRITES_ENABLED` — unset inherits the first flag; `false` disables T2 tables only (T1 prefs/read-receipts stay)

Identity: never trust `user_id` / `tenant_id` / `x-user-id` / `x-tenant-id`. Parent `tenant_id` for payees/audit is copied from the RLS-visible `check_intake_items` row.

## Grants

`aws/write-path/sql/33_tranche2_write_grants.sql`

Column-level `UPDATE` on `check_intake_items` **excludes** amount/status/routing/deposit. **No INSERT** on `check_messages`. RLS remains final (Freedom ↛ C1C, NULL-org fail-closed, ninth UUID fail-closed).

## Tests

Freedom CRUD + readback; C1C ↛ Freedom; Freedom ↛ C1C; NULL-org deny; unauth 401; spoof ignored; Cognito sub ignored; ninth fail-closed; unapproved table/column 403; financial field 403; provider invoke still `provider_disabled`; malformed 400; rollback; T2 flag; kill switch; financial aggregates before/after identical; cleanup test payees/audit rows.

Staging restore still has Freedom checks and **0 C1C intake rows** — C1C isolation is “cannot write Freedom check_id”.

Payee INSERT still runs `tg_mirror_payee_to_endorsement`, which creates a pending endorsement. Live staging required `GRANT INSERT` on `check_endorsements` for that trigger (`permission denied for table check_endorsements` without it). The HTTP allowlist still has no endorsement insert op and still denies `status`.

- `check_messages` INSERT (needs a ledger-safe product decision)
- endorsement `status` without partner HTTP / stage side effects
- check `status` / `check_stage` without ledger/billing
- storage uploads (back image, endorsement render)
- `claim_checks` mirrors
- deposits / disbursements / providers
- production cutover
