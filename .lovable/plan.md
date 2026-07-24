# Payroll Tab — Off-Claim ACH Payments

Adds a **Payroll** tab next to **Tax & 1099** in `src/pages/Payments.tsx` so admins can send ACH payments to people who aren't tied to a specific claim check. Reuses the existing Actum debit→credit rail, `consumer_code` tokenization, and the **Stakeholders** tab flow for bank linking.

## Confirmed scope
- Additive only — claim-check stakeholder flow untouched.
- One shared **recipient directory per tenant**, **admin-only** access.
- No second-admin approval, but sending requires a **confirm dialog** ("Are you sure? $X to Y via ACH") before the API call fires.
- **Bank linking reuses the existing Stakeholders tab.** No new "send bank link" UI in Payroll. Payroll only picks from stakeholders that already exist for the tenant.
- **No payee is tracked until they're selected and paid.** Stakeholders that are never chosen in a payroll run stay invisible to payroll history/reporting.

## Data model

One new table only:

**`payroll_runs`** — one row per send attempt
- `tenant_id`, `stakeholder_account_id` FK → existing `stakeholder_accounts`
- `amount`, `speed` (next_day / same_day / instant), `memo`
- `initiated_by`, `status`, `actum_batch_id`, `error`
- created_at / updated_at

RLS: admin-only, tenant-scoped via `has_role(auth.uid(), 'admin')` and `tenant_users`. GRANTs + `updated_at` trigger included.

No `payroll_recipients` table — the stakeholder record IS the recipient. First payment to a stakeholder implicitly onboards them into payroll history.

## Backend

**`run-payroll`** edge function:
1. Verify caller is admin for the tenant.
2. Look up the chosen `stakeholder_account` — must belong to tenant, be `verified`, and have a `consumer_code`.
3. Create a `disbursement_batch` + single `disbursement_split` pointing at that stakeholder account.
4. Call the same debit → credit path `actum-disburse` already uses (sends `consumer_code`).
5. Write result to `payroll_runs`.

No changes to `homeowner-bank-link-send`, `actum-disburse`, or the Stakeholders tab.

## UI

New files:
- `src/pages/payments/PayrollTab.tsx` — hosts Run Payroll + History (admin-only gate)
- `src/components/payroll/RunPayrollDialog.tsx`
  - **Payee dropdown** = all `stakeholder_accounts` for the tenant that are verified + have a `consumer_code` (searchable by name/email)
  - Amount, speed (Next Day $0.95 / Same Day $1.15 / Instant $1.65), memo
  - **Confirm step** showing payee, amount, fee, total → final "Send Payment" button
  - Empty-state hint: "No eligible payees? Add them in the Stakeholders tab and send them a bank-link."
- `src/components/payroll/PayrollHistoryTable.tsx` — shows only stakeholders that have at least one `payroll_run` (status, amount, speed, Actum order, date)

Edit `src/pages/Payments.tsx` — add tab, gated by `useUserRole() === 'admin'`.

## Out of scope
- Tax withholding / W-2 payroll
- Recurring/scheduled runs
- Bulk multi-payee runs
- Any new bank-link entry point (Stakeholders tab remains the single source)

Say go and I'll build it.
