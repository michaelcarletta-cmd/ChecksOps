# Micro-Deposit Verification for Stakeholder Accounts

Verify every stakeholder bank account before it can receive ACH disbursements by sending two small random credits, then requiring the stakeholder to confirm the exact amounts.

## What you and your team see

- **Adding a stakeholder account** runs a free routing-number checksum first (catches typos instantly), then auto-initiates the two micro-deposits through Actum. The account immediately shows a yellow "Awaiting confirmation" badge.
- **Stakeholder receives an email** with a secure link to a branded confirmation page. They enter the two amounts that landed in their bank account (1–2 business days later). 3 wrong tries locks the account and notifies an admin.
- **Once confirmed**, the badge flips green to "Verified" and the account becomes eligible for real payments.
- **Disbursement Console**: the Send Payment button is disabled for unverified accounts with a tooltip explaining why, plus a "Resend confirmation link" action. Admins get a "Send anyway (accept return risk)" override that writes to the audit log.
- **Auto-verification for shared partners**: when a partner is added as a stakeholder via check-sharing, the same flow runs against their stored banking info.

## Cost & timing

- ~$0.50–$1.00 per account verified (two ACH credits totaling ~15¢, plus Actum per-transaction fees).
- 1–2 business days for deposits to land, then user-paced confirmation.
- One-time per account — re-used for all future payments to that stakeholder.

## Technical scope

**Database** (new migration)
- `stakeholder_accounts` adds: `verification_status` (`unverified` | `pending` | `verified` | `failed` | `locked`), `verification_initiated_at`, `verification_completed_at`, `verification_amount_1_cents` and `_2_cents` (admin-only RLS, never selectable by stakeholder), `verification_attempts`, `verification_token` (uuid), `verification_token_expires_at`, `verification_failure_reason`.
- New `stakeholder_account_verification_log` table for audit trail (init, attempt, success, failure, admin override).
- RLS: only admins and service_role can read the secret amounts; stakeholders authenticate via token only.

**Edge functions**
- `stakeholder-init-microdeposits` — runs routing checksum, generates two random 1–25¢ amounts, submits 2 Actum credit transactions, stores hashed amounts + token, enqueues confirmation email.
- `stakeholder-verify-microdeposits` — public endpoint; takes `{ token, amount1, amount2 }`, validates token + expiry + attempt count, marks verified or increments attempts, logs result.
- `stakeholder-resend-verification` — admin-triggered, rotates token + resends email.
- `actum-send-payment` — updated to reject if `verification_status !== 'verified'` unless `admin_override: true` is passed (audit-logged).

**Email template** (`stakeholder-verify-account.tsx`) — branded React Email with confirmation link `/verify-account/:token`.

**Frontend**
- New route `/verify-account/:token` — public page; 2 currency inputs, validates via edge function, shows success/lock/expired states.
- `StakeholderAccountSettings` + `CheckStakeholdersManager` — verification badge, "Resend link" button, status copy.
- `DisbursementConsole` — disabled Send button for unverified accounts with tooltip + admin override checkbox.
- `FundsTab` — shows verification status next to each stakeholder.

**Routing checksum utility** (`src/lib/banking.ts`) — ABA mod-10 checksum, reused on form input and in edge function.

## Out of scope (for now)

- FedACH directory name-match lookup (can add later if useful).
- Prenote layer in addition to micro-deposits (we discussed it — sticking with micro-deposits only since they're stronger).
- Re-verification on account-info edit (treat any edit as a new account → re-verify).

## Order of execution

1. Migration: schema + RLS + audit log table.
2. Routing checksum util.
3. Three edge functions (init, verify, resend) + update `actum-send-payment` gate.
4. Email template + scaffold email infra if not already set up.
5. `/verify-account/:token` page.
6. UI updates to stakeholder manager, disbursement console, funds tab.
7. Manual test with a sandbox account.
