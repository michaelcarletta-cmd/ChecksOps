# Production MHR table-level UPDATE — read-only investigation

Production remains unauthorized. This document does not revoke, grant, apply SQL 39, deploy Lambda/SPA, modify the inspect function, or change #601 / Claim Ledger. It does not teach the SQL 39 guard to accept leftover table UPDATE.

Inspect source: existing `checksops-prod-mops-sql39-inspect-ad99` receipt (`inspect-only`, `mutated=false`) at hash `9b428140630157a29f7f96f1f368d8eeb264aceaa764c0a214b5a3aa58538ee0`.

## What production has today

`checksops` has **table-level UPDATE** on `public.mortgage_handling_requests`. That is why `information_schema.column_privileges` lists UPDATE on all 54 columns for `checksops`, including billing, invoice, SSN, shipping, `tenant_id`, and Stripe ids.

`authenticated` has **no** MHR table grants.

`checksops` also has `DELETE` on `check_billing_events`. Staging Gate 4 does not.

Historical policy `aws_update_mortgage_handling_requests` is present. SQL 39 policies are absent. FORCE RLS is false. #601 hashes remain exact.

## Provenance

No current repo migration or AWS SQL file grants `UPDATE ON TABLE public.mortgage_handling_requests TO checksops`.

Repo history that *does* exist:

1. `supabase/migrations/20260715110727` created the table and granted `SELECT, INSERT, UPDATE` to **`authenticated`**, plus `ALL` to `service_role`. Not `checksops`.
2. `aws/workflows/sql/50_tranche5_write_grants.sql` granted `SELECT, INSERT, DELETE` plus **column-scoped** UPDATE of 13 metadata columns to `checksops, authenticated`. Not table-level UPDATE.
3. `aws/workflows/sql/51_tranche5_revoke_write_grants.sql` revoked all MHR DML and left `SELECT` only.
4. Pinned SQL 39 grants only `UPDATE (assigned_employee_id, accepted_at, completed_at)` and forbids table-level UPDATE. The apply guard fails closed if a login-role table UPDATE remains.

The split policies `aws_insert_mortgage_handling_requests` / `aws_update_mortgage_handling_requests` / `aws_delete_mortgage_handling_requests` exist in production and staging but have **no CREATE POLICY source in repo**. They were applied by an out-of-repo overlay. The live production `USING` / `WITH CHECK` on the UPDATE policy is byte-identical to the staging capture in the Mortgage Desk E2E harness.

`checksops-prod-mortgage-ops-sql-2d41` applied SQL 45/46 billing launch only. It does not grant MHR UPDATE. `checksops-production-workflow-grants-83c9` (2026-09-24) states the later production rule: **GRANT `checksops` only; never `authenticated`**. That matches live MHR grants (`checksops` SELECT/INSERT/UPDATE/DELETE, no `authenticated`) and does not match the tranche 5 file as written.

Most likely entry: a production write-path overlay granted `checksops` full table DML instead of the column-scoped tranche 5 grant, and never granted `authenticated`. Apply timestamp is not recoverable from repo or the inspected oneshots.

## Staging SQL 39 model that passed Gate 4

Before and after SQL 39, staging login roles had **no table-level UPDATE**.

Staging `checksops` and `authenticated` both had table `SELECT, INSERT, DELETE` plus column UPDATE on exactly these 17 columns:

`assigned_employee_id`, `accepted_at`, `completed_at`, `cancelled_at`, `status`, `updated_at`, `work_notes`, `mortgage_company`, `mortgage_servicer`, `loan_number`, `note`, `property_address`, `claim_number`, `insurance_company`, `homeowner_name`, `homeowner_email`, `homeowner_phone`

SQL 39 then dropped `aws_update_mortgage_handling_requests` and added the agent queue / accept-complete / usage-insert overlay. It did not add table UPDATE. Gate 4 Accept / $10 / $5 / Complete ran on that model.

Staging `check_billing_events` for `checksops` is `INSERT, SELECT, UPDATE` only. No DELETE.

## Historical policy + table UPDATE is broader than the intended model

Live policy:

- USING: cross-tenant reader OR tenant writer OR (mortgage_agent AND (requested+unassigned OR assigned-to-self))
- WITH CHECK: cross-tenant reader OR (mortgage_agent AND (requested+unassigned OR assigned-to-self)) OR (tenant writer AND still requested+unassigned)

Privilege today: every column.

Together that allows:

- A mortgage agent or platform owner to write billing, invoice, SSN, shipping, `tenant_id`, Stripe ids
- A tenant writer to rewrite any column on a still-requested unassigned row

Intended Mortgage Ops model: agents Accept/Complete only (`assigned_employee_id`, `status`, `accepted_at`, `completed_at`, `work_notes`, `updated_at`); tenant create uses INSERT; metadata UPDATE is the tranche 5 column list, and after SQL 39 the remaining UPDATE policy is agent-only (staging Gate 4).

## Every current production writer

Live production ZIP is `checksops-production-prep-api` (`workflow-rpc.mjs` `afd8ac23…`).

| Writer | Live path | Columns | Needs table UPDATE? |
| --- | --- | --- | --- |
| Request create | `executeMortgageRequests` INSERT | `tenant_id`, `check_intake_item_id`, `mortgage_company`, `loan_number`, `note`, `requested_by`, `status` | No. Needs INSERT. |
| Queue | SELECT | none | No |
| Tenant metadata UPDATE | `executeMortgageRequests` UPDATE | 11 metadata cols + `status` | No. Needs those column grants. After SQL 39, RLS is agent-only (same as staging). |
| Accept | `executeAcceptMortgage` | `assigned_employee_id`, `status`, `accepted_at`, `updated_at` | No |
| Complete / cancel | `executeUpdateMortgageStatus` | `status`, `completed_at`, `work_notes`, `updated_at` | No |
| Usage billing | JS accrue + `tr_accrue_mortgage_ops_billing` | INSERT `check_billing_events` | No MHR UPDATE. Needs CBE INSERT (already present). |
| `bill-mortgage-handling` | SELECT then fail-closed | none | No |
| Delete Check | `handleDeleteCheck` | SELECT CBE as **blocker**; does not DELETE MHR or CBE | No |
| Admin unassign | `AdminMortgageOps` | `assigned_employee_id`, `status`, `accepted_at` | Not a live AWS writer: those assignment columns are `clientIgnored` on `/data/write`. SQL 39 WITH CHECK would also reject `assigned_employee_id IS NULL`. |
| Detail shipping / invoice / dates / 2nd-mortgagee order | SPA `.update()` | shipping, invoice, `check_sent_date`, `endorsement_order` | Not a live AWS writer: columns are outside `write-allowlist`. |

Nothing outside Mortgage Ops Accept/Complete legitimately requires **table-level** UPDATE. Accept/Complete need four columns plus `status` / `updated_at` / `work_notes`. Create needs INSERT. Queue needs SELECT. Delete Check does not UPDATE or DELETE MHR in the live ZIP.

Source `workflow.mjs` still has `DELETE FROM mortgage_handling_requests` in `deleteChildren`. That member is **not** what production runs. Live delete uses financial blockers and `admin_delete_check` (SECURITY DEFINER) as fallback.

## Would revoke + narrow grants break existing paths?

Revoking table UPDATE and replacing it with the 17 staging columns:

- Create: no
- Queue: no
- Accept: no
- Complete: no
- Billing usage: no
- Delete Check: no
- Admin/support unassign on AWS: already not a working `/data/write` path
- Shipping/invoice/date SPA updates on AWS: already rejected by the allowlist
- Tenant metadata UPDATE privilege: preserved; after SQL 39 the **policy** (not the grant) makes it agent-only, matching staging

Applying **current SQL 39 alone** would still fail closed: leftover `checksops` table UPDATE is `UNRELATED_MUTATION`. Do not change that guard.

## `check_billing_events` DELETE

Production `checksops` has DELETE. Staging Gate 4 does not. No repo `GRANT DELETE ON check_billing_events TO checksops` was found. Live Lambda never deletes CBE; Delete Check treats CBE as a reason to **refuse** deletion. Not required to apply Mortgage Ops. Leave it unchanged.

## Proposed production SQL transition

Do this as two guarded steps. Do not apply either now.

### Before (live production)

Policies on MHR: `aws_select_mortgage_handling_requests`, `aws_insert_mortgage_handling_requests`, `aws_update_mortgage_handling_requests`, `aws_delete_mortgage_handling_requests`.

`checksops` MHR: `SELECT, INSERT, DELETE, UPDATE` (table-level).

`authenticated` MHR: none.

`checksops` CBE: `SELECT, INSERT, UPDATE, DELETE`.

`authenticated` CBE: `SELECT, INSERT, UPDATE`.

No `aws_is_mortgage_ops_agent` / queue / accept-complete / usage-insert policies.

### Step A — privilege narrowing (new, required before SQL 39)

```sql
REVOKE UPDATE ON TABLE public.mortgage_handling_requests FROM checksops;

GRANT UPDATE (
  assigned_employee_id,
  accepted_at,
  completed_at,
  cancelled_at,
  status,
  updated_at,
  work_notes,
  mortgage_company,
  mortgage_servicer,
  loan_number,
  note,
  property_address,
  claim_number,
  insurance_company,
  homeowner_name,
  homeowner_email,
  homeowner_phone
) ON TABLE public.mortgage_handling_requests TO checksops;
```

Keep `checksops` `SELECT, INSERT, DELETE` on MHR. Do not revoke `checksops_admin`. Do not grant `authenticated` table DML (production never had it; Lambda uses `checksops`). Do not touch CBE DELETE.

`REVOKE UPDATE ON TABLE` removes every column UPDATE. The GRANT must follow immediately.

### Step B — pinned SQL 39 (`c59845e439cfdfd48be955d8ab78128de4ba39211b136616fc23799215145e3f`)

Unchanged file:

- `DROP POLICY IF EXISTS aws_update_mortgage_handling_requests`
- create `aws_is_mortgage_ops_agent()`
- create `aws_select_mortgage_ops_agent_queue`
- create `aws_update_mortgage_ops_accept_complete`
- `GRANT UPDATE (assigned_employee_id, accepted_at, completed_at) TO checksops, authenticated`
- create `aws_insert_mortgage_ops_usage_events`
- `GRANT INSERT ON check_billing_events TO checksops, authenticated` (already present)

After Step A, `login_role_mhr_table_update` is empty, so the existing apply guard can accept Step B without being taught to ignore table UPDATE.

### After

| Privilege | Before | After |
| --- | --- | --- |
| `checksops` MHR table UPDATE | yes (all 54 cols) | no |
| `checksops` MHR column UPDATE | all 54 | the 17 staging columns |
| `authenticated` MHR column UPDATE | none | the 3 SQL 39 columns only |
| `checksops` MHR SELECT/INSERT/DELETE | yes | yes |
| historical UPDATE policy | present | dropped |
| SQL 39 agent policies | absent | present |
| CBE DELETE `checksops` | yes | yes (unchanged) |

The after snapshot hash will **not** equal staging `4adc182c…` because production still lacks `authenticated` MHR `INSERT/DELETE/SELECT`. Do not add those grants just to match the hash. The Mortgage Ops behavior that passed Gate 4 is the policy overlay plus the 17-column `checksops` grant.

## Recommendation

Production SQL 39 cannot be applied until Step A exists. The least-privilege target is the staging Gate 4 grant/policy model for `checksops`, not the current table UPDATE. Production stays unauthorized until that revised plan is accepted.
