# Mortgage Agent Management + Compensation — Phase 1 Investigation

**Status:** design only. No schema applied. No staging write. No production write.

**Branch:** `cursor/mortgage-agent-compensation-ad99`  
**Base:** `origin/main` `7c64dae2dee6c78dd296c946c04ea6ccaa793aef`  
**Production Mortgage Ops:** accepted and frozen. This workstream must not regress it.

This document answers the 14 investigation items and proposes the architecture for review **before** any database or UI build.

---

## Guardrails (non-negotiable)

- Dedicated Mortgage Agent identity stays: Cognito → environment mapping table → application UUID → `profiles` + `user_roles.mortgage_agent`. No `tenant_users` requirement.
- Tenant receivable (`check_billing_events` `$10/$5`) and agent payable remain separate ledgers.
- Do not alter live Mortgage Ops Lambda/SPA, SQL 39, Cognito, provider flags, Moov/Stripe, or tenant billing accrual.
- Do not grant table-level `UPDATE` on `mortgage_handling_requests`. Production currently has **0** table-level `UPDATE` and **17** column-level `UPDATE` grants for `checksops`. Keep that model.
- No ACH / Moov / Stripe / wallet / bank movement for agents in this phase.
- Do not backfill production. Do not touch request `5b20db20-13e1-4919-9528-06388d8661d2`.

---

## 1. Current Mortgage Agent identity / data model

Mortgage Agents are **platform-scoped desk operators**, not tenant/company users.

| Layer | Object | Role |
|---|---|---|
| App role | `public.app_role` value `mortgage_agent` | Exclusive vs `staff`/`admin` via `prevent_mortgage_agent_role_conflict()` |
| Role row | `public.user_roles (user_id, role)` | Unique `(user_id, role)` |
| Profile | `public.profiles (id, email, full_name, created_at, updated_at)` | Application UUID |
| Staging Cognito map | `public.identity_accounts (application_user_id, cognito_sub, email, status)` | Staging pool `us-east-1_vPmQ7cL1F` |
| Production Cognito map | `public.identity_production_cognito_locks (application_user_id, cognito_sub)` | Production pool `us-east-1_h00WorYMT` |
| Assignment | `mortgage_handling_requests.assigned_employee_id` | FK to `identity_accounts.application_user_id` |
| Tenant membership | `tenant_users` | **Intentionally absent** for dedicated agents |

Canonical login chain:

```
Cognito JWT sub
  → identity_accounts (staging) OR identity_production_cognito_locks (production)
  → application_user_id
  → SET LOCAL request.app_user_id / auth.uid()
  → user_roles.mortgage_agent
```

Dedicated session isolation:

- AWS Mortgage Ops: `checksops.aws.staging.auth.mortgage-ops`
- Supabase Mortgage Ops: `sb-mortgage-ops-auth`
- CheckOps portal uses a different key and **signs `mortgage_agent`-only users out** of the company login.

Production accepted agent (do not treat as a tenant user):

- Email: `claims@freedomadj.com`
- Application UUID: `b100f05d-9e81-4a7b-b9cc-9baf173131d9`
- Roles: `['mortgage_agent']`
- `tenant_users`: `[]`
- Isolation proof: company/settings surface returns “Organization Not Found”

Hire paths:

- AWS: `runHireMortgageAgent` in `aws/functions/api/tenant-admin.mjs` — Cognito `AdminCreateUser` + `identity_accounts` + `profiles` + `user_roles`. **No `tenant_users` insert.**
- Legacy Supabase: `supabase/functions/hire-mortgage-agent/index.ts` — Auth user + profile + role only.

There is **no** active/inactive registry today. `AdminMortgageOps.removeAgent` **deletes the `user_roles` row**. That is revoke-by-erasure, not deactivate. Historical work remains on `mortgage_handling_requests`, but the person disappears from the agent roster.

Last activity is not a first-class agent field. Closest existing signals:

- `user_sessions.last_activity_at` when a session row exists
- `GREATEST` of assigned `mortgage_handling_requests.accepted_at / completed_at / updated_at`
- `identity_accounts.linked_at` / `profiles.created_at` for hire date

---

## 2. Current `mortgage_handling_requests` lifecycle

Statuses: `requested → in_progress → completed | cancelled`.

| Column | Meaning |
|---|---|
| `status` | Lifecycle |
| `assigned_employee_id` | Handling agent application UUID |
| `accepted_at` | First successful Accept |
| `completed_at` | Set only when status becomes `completed` |
| `cancelled_at` | Column exists; **no current handler writes it** |
| `requested_by` | Tenant requester |
| Billing columns | Tenant invoice leftovers; not agent pay |

Open-request uniqueness: one open row (`requested` or `in_progress`) per `check_intake_item_id`.

Production-accepted write model (SQL 39 + 17-column grant):

- Tenant create: `INSERT`
- Agent Accept / Complete / Cancel: column-scoped `UPDATE` only
- **0** `checksops` table-level `UPDATE`
- Agent SELECT via `aws_select_mortgage_ops_agent_queue`
- Agent UPDATE via `aws_update_mortgage_ops_accept_complete`
- Usage INSERT via `aws_insert_mortgage_ops_usage_events` (tenant ledger only)

`handleMortgageOpsAcceptComplete` does **not** exist as a named function. Accept/Complete are:

- SQL RPCs: `accept_mortgage_handling_request`, `update_mortgage_handling_request_status`
- AWS: `executeAcceptMortgage`, `executeUpdateMortgageStatus` in `workflow-rpc.mjs`
- SPA: `MortgageOpsQueue.handleAccept` / `handleStatus`

---

## 3. Exact point `assigned_employee_id` is established

**Accept.** Fail-closed.

```sql
UPDATE mortgage_handling_requests
   SET assigned_employee_id = <application_user_id>,
       status = 'in_progress',
       accepted_at = COALESCE(accepted_at, now())
 WHERE id = $request
   AND assigned_employee_id IS NULL
   AND status = 'requested'
```

Rules:

- Caller must be `mortgage_agent` or `admin`.
- Duplicate Accept → `already_taken`. Assignee does not change.
- Re-Accept cannot steal another agent's row.
- Production SQL 39 `WITH CHECK` requires `assigned_employee_id = auth.uid()` after the update.

Reassignment today:

- `AdminMortgageOps.unassignRequest` tries a direct UPDATE: `{ assigned_employee_id: null, status: 'requested', accepted_at: null }`.
- On AWS that path is **not a working `/data/write` allowlist path** (`assigned_employee_id` is `clientIgnored`). SQL 39 `WITH CHECK` would also reject a null assignee.
- There is **no** “reassign to agent B” RPC. The only intended reassignment is unassign → new Accept.

Implication for compensation: the agent who **completes** the row is the current `assigned_employee_id`. Do not pay the first accepter if the assignment later moved.

---

## 4. Exact point work becomes completed

**Complete RPC / `executeUpdateMortgageStatus`.**

```sql
UPDATE mortgage_handling_requests
   SET status = $status,
       completed_at = CASE WHEN $status = 'completed' THEN now() ELSE completed_at END,
       work_notes = ...
 WHERE id = $request
   AND (assigned_employee_id = $caller OR admin)
```

Rules:

- Only the assigned agent, or an admin, may Complete/Cancel.
- Another agent cannot complete someone else's file.
- Admin Complete does **not** rewrite `assigned_employee_id`. The assigned agent remains the handler of record.
- Duplicate Complete is effectively idempotent on the request row (status stays `completed`; `completed_at` is not cleared).
- Cancel sets `status='cancelled'` and does **not** set `cancelled_at`.
- Complete does **not** create a tenant billing event on the accepted production path.

`origin/main` SPA still *invokes* `bill-mortgage-handling` after Complete. That is a leftover. Production AWS `bill-mortgage-handling.mjs` is **fail-closed** and writes nothing. Live tenant `$10/$5` is Accept-time, not Complete-time. Do not revive Complete-time tenant billing.

---

## 5. Current `$10/$5` tenant billing creation / idempotency

Accepted production model (do not change):

| Item | Value |
|---|---|
| Milestone | **Accept** (`accepted_at` set, status `in_progress` or `completed`) |
| Durable path | Trigger `tr_accrue_mortgage_ops_billing` → `accrue_mortgage_ops_billing(uuid)` |
| JS mirror | `accrueMortgageOpsAcceptedRequest` in `mortgage-ops-usage.mjs` (SAVEPOINT so a failed insert cannot abort Accept) |
| Ledger | `check_billing_events` |
| Event types | `mortgage_ops_initial` ($10 / 1000¢) and `mortgage_ops_additional_check` ($5 / 500¢) |
| Rate source | `tenants.mortgage_ops_initial_rate_cents` / `mortgage_ops_additional_rate_cents` (explicit `0` is free) |
| Classification | First non-voided Mortgage Ops event on `(tenant_id, claim_id)` is initial; later checks on that claim are additional |

Idempotency (SQL 45, live in production):

- Unique one Mortgage Ops event per `check_intake_item_id`
- Unique one `mortgage_ops_initial` per `(tenant_id, claim_id)`
- Advisory lock per tenant+claim
- Duplicate Accept / Complete cannot insert a second usage row
- Launch cutoff table `mortgage_ops_billing_launch` skips pre-launch accepts

A tenant charge **does not record which agent is owed**. `check_billing_events` has `mortgage_request_id` but **no agent column**. That is why it cannot be the payable ledger.

Known production usage from 2026-10-03 acceptance (read-only capture; not a live query in this phase):

| Request | Tenant | Status | Event | Amount | Notes |
|---|---|---|---|---|---|
| `7a7ec1ce-…` | Synthetic `6f2c1a90-…` | completed | `3df0c417-…` initial | $10 | Controlled acceptance |
| `71ea6822-…` | Synthetic `6f2c1a90-…` | completed | `e68193b5-…` additional | $5 | Controlled acceptance |
| `5b20db20-…` | Freedom `2eff5f1a-…` | **in_progress** | `6c661cc3-…` initial | $10 | Accidental Accept; **not completed** |

`platform_fee_line_items` count for those tests: 0. No Stripe customer. No money movement.

Older `origin/main` paths that must not be reused for agent pay:

- `bill-mortgage-handling` → `platform_fee_line_items` (`fee_code='mortgage_handling'`)
- Trigger `tr_record_mortgage_handling_billing` on `check_stage` → `event_type='mortgage_handling'`

Those are tenant-side leftovers / alternate meters. Agent compensation must not write them.

---

## 6. Existing tables vs dedicated compensation table

**A dedicated payable ledger is required.**

| Candidate | Why it is insufficient |
|---|---|
| `check_billing_events` | Tenant receivable. No agent FK. Unique on check/event-type. Mixing payable status (`approved`/`paid`) into usage would corrupt tenant invoicing. |
| `platform_fee_line_items` | Tenant platform fees. No agent. Moov fee rollup. |
| `tenant_maintenance_payments` / allocations | Tenant invoice occurrence. SQL 45 already snapshots Mortgage Ops **tenant** subtotals. |
| `payroll_runs` | Tenant → stakeholder ACH. Wrong actor class. Money rail. |
| `mortgage_handling_requests` | Assignment audit only. No amount, period, pay status, payment reference. |
| UI-only aggregation | Forbidden. No historical accounting record. |

`check_billing_events` remains the **tenant-side pointer** (`tenant_billing_event_id`) on each payable row. It is not the payable itself.

---

## 7. Proposed compensation schema

New tables only. No columns added to `mortgage_handling_requests`. No change to `check_billing_events` shape.

### 7.1 `mortgage_agent_accounts`

Roster / active flag. Does **not** replace `user_roles.mortgage_agent`.

| Column | Type | Notes |
|---|---|---|
| `application_user_id` | uuid PK | Same UUID as profile / assignment |
| `status` | `active` \| `inactive` | Deactivate ≠ delete |
| `hired_at` | timestamptz | Default now() |
| `deactivated_at` | timestamptz | Null while active |
| `deactivated_by` | uuid | Admin actor |
| `deactivate_note` | text | Optional |
| `created_at` / `updated_at` | timestamptz | |

Deactivate:

1. Set `status='inactive'`.
2. Remove or suspend login (`user_roles.mortgage_agent` delete **or** Cognito disable). Prefer keeping a historical role-audit row; the registry is the source of “was/is an agent.”
3. **Do not** unassign in-progress work.
4. **Do not** alter compensation rows.

Hire must upsert this registry in addition to today's identity writes.

### 7.2 `mortgage_agent_compensation_rates`

Separate from tenant rates. Tenant free promo (`0`) must not zero agent pay.

| Column | Default |
|---|---|
| `singleton` | true |
| `initial_cents` | 1000 |
| `additional_cents` | 500 |

### 7.3 `mortgage_agent_compensation_entries`

One live obligation per completed qualifying request.

| Column | Purpose |
|---|---|
| `id` | uuid PK |
| `agent_user_id` | Completing/handling agent (`assigned_employee_id` at earn time) |
| `mortgage_request_id` | MHR id |
| `check_intake_item_id` | Check |
| `claim_id` | Claim used for initial vs additional |
| `tenant_id` | Customer |
| `classification` | `initial` \| `additional` |
| `amount_cents` | Snapshotted agent rate (not tenant rate) |
| `tenant_billing_event_id` | Nullable pointer to CBE |
| `accepted_at` | Copied from request |
| `completed_at` | Copied from request |
| `earned_at` | When status became `earned` |
| `pay_period` | `YYYY-MM` from `earned_at` UTC |
| `status` | `earned` \| `approved` \| `paid` \| `voided` \| `excluded` |
| `payment_batch_id` | Nullable |
| `payment_date` | Date admin recorded |
| `payment_reference` | External check/ACH/ref (manual) |
| `payment_note` | Optional |
| `exclusion_reason` | For synthetic / test / correction |
| `created_at` / `updated_at` | |

Lifecycle for this phase:

```
(no row)
   → earned          # Complete of qualifying assigned work
   → approved        # Admin review
   → paid            # Admin recorded an outside payment
```

`pending` is **not** persisted. In-progress / accepted-but-unfinished work is visible from `mortgage_handling_requests`, not as a payable. That avoids paying accidental Accepts and simplifies reassignment.

`voided` = administrative cancel of an unpaid obligation.  
`excluded` = keep the row for audit but omit from monthly owed (test artifacts, synthetic, known bad Accepts that somehow completed).

Paid amounts are immutable. Corrections are **new adjustment rows** (`parent_entry_id`, signed `amount_cents`), never an UPDATE of a paid amount.

### 7.4 `mortgage_agent_compensation_batches`

Manual payment / approval groups.

| Column | Purpose |
|---|---|
| `id` | uuid PK |
| `pay_period` | `YYYY-MM` |
| `agent_user_id` | Null = multi-agent period batch |
| `action` | `approve` \| `pay` |
| `payment_date` | |
| `payment_reference` | |
| `note` | |
| `created_by` / `created_at` | Audit |

### 7.5 `mortgage_agent_compensation_audit`

Append-only: actor, action, entry/batch, from_status, to_status, payload jsonb.

---

## 8. Proposed unique / idempotency constraints

| Constraint | Rule |
|---|---|
| `mortgage_agent_compensation_entries_request_live_uidx` | `UNIQUE (mortgage_request_id) WHERE status NOT IN ('voided','excluded')` |
| `mortgage_agent_compensation_entries_check_live_uidx` | `UNIQUE (check_intake_item_id) WHERE status NOT IN ('voided','excluded') AND check_intake_item_id IS NOT NULL` |
| Accrue function | `SECURITY DEFINER`, `FOR UPDATE` on the request, advisory lock on request id |
| Earn predicate | `status='completed' AND completed_at IS NOT NULL AND assigned_employee_id IS NOT NULL` |
| Cancel / in_progress / requested | No insert |
| Duplicate Complete | Existing row returned; no second insert |
| Re-Accept after unassign | New request identity is the same row; earn happens once at first successful Complete |
| Reopen (future) | If a paid/earned row exists, do not insert a second live obligation |
| Tenant CBE | **Never inserted** by this workstream |

Classification at earn time:

1. If a non-voided `check_billing_events` Mortgage Ops row exists for the check/request, copy its `event_type` → `initial` / `additional`.
2. Else classify among **completed** sibling requests on the same `(tenant_id, claim_id)` using the same first/additional rule, and leave `tenant_billing_event_id` null (reconciliation flag).
3. Amount comes from `mortgage_agent_compensation_rates`, **not** tenant cents.

---

## 9. Proposed RLS / permissions

Least privilege. Do not touch SQL 39 grants.

| Object | `checksops` / authenticated | Notes |
|---|---|---|
| New tables | `SELECT` for platform owner / `is_master_owner()` / `user_roles.admin` | Mortgage agents: optional later `SELECT` of **own** entries only. Not required for Phase 2. |
| New tables | **No** direct `INSERT/UPDATE/DELETE` for login roles | Writes only via `SECURITY DEFINER` RPCs |
| RPCs | `earn_mortgage_agent_compensation(request_id)` | Called by Complete trigger |
| RPCs | `approve_mortgage_agent_compensation(...)` | Admin/owner |
| RPCs | `mark_mortgage_agent_compensation_paid(...)` | Admin/owner; refuses paid-amount mutation |
| RPCs | `exclude_mortgage_agent_compensation(...)` | Admin/owner; unpaid only unless creating an adjustment |
| `mortgage_handling_requests` | unchanged | No new column grants, no table UPDATE |
| `check_billing_events` | unchanged | Compensation never INSERTs usage events |
| Money tables | untouched | invoices, moov, stripe, wallet, ach, payroll |

Trigger (preferred over Lambda edit):

```
AFTER UPDATE OF status, completed_at ON mortgage_handling_requests
  WHEN NEW.status = 'completed' AND NEW.completed_at IS NOT NULL
  EXECUTE earn trigger → earn_mortgage_agent_compensation(NEW.id)
```

This keeps production Mortgage Ops Lambda (`executeUpdateMortgageStatus`) unchanged. Complete already writes `status` + `completed_at`. The trigger is additive and cannot widen MHR UPDATE grants.

SQL 39 apply guard must remain forbidden from this file: no `GRANT UPDATE ON TABLE mortgage_handling_requests`, no Moov/Stripe, no `FORCE RLS`, no `#601` helpers.

---

## 10. Proposed Tenant Management UI composition

Live Tenant Management is **`src/pages/admin/AdminTenants.tsx`** at `/admin/tenants`, gated by `isPlatformOwner()` (`checksopsadmin@gmail.com`).

`src/components/settings/TenantManagement.tsx` is **not routed**. Do not build there.

`/admin/mortgage-ops` (`AdminMortgageOps.tsx`) already lists agents and request counts. It is a header button, not a tab. It has no compensation, no active flag (only revoke), no monthly view.

**Composition:** add a platform-level tab `Mortgage Agents` beside Tenants / Platform Finance / CheckAlt / Referrals / Announcements.

Do **not** put agents in per-tenant `Users` (`tenant_users`). That would collapse the dedicated identity model.

Tab contents:

1. **Roster** — refactor `AdminMortgageOps` into `MortgageAgentsPanel`
   - Name, email, active/inactive, application UUID, created, last activity
   - Current assigned / in-progress / completed
   - Monthly files + earned / paid / unpaid
   - Hire (existing function)
   - Deactivate (new; no auto-unassign)
2. **Monthly compensation** — period selector + table:
   - Agent | Initial $10 | Additional $5 | Files Worked | Amount Owed | Paid | Balance
   - Totals row
   - Filters: month, agent, earned/approved/paid/unpaid
   - Click agent → file-level drill-in
3. **Payment recording** — approve / mark paid (single + batch)
4. **Reconciliation** — tenant CBE ↔ agent entry, anomalies only (no auto-fix)

Keep `/admin/mortgage-ops` as a redirect/alias so existing bookmarks work.

A Mortgage Agent viewing `/admin/tenants` remains unauthorized. Managing them from Tenant Management does not grant them Tenant Management.

---

## 11. Proposed monthly reporting / query design

Pay period = UTC `YYYY-MM` of `earned_at` (completion month). That matches “files they actually worked on,” not Accept month.

```sql
SELECT
  e.agent_user_id,
  p.full_name,
  p.email,
  count(*) FILTER (WHERE e.classification = 'initial')                              AS initial_count,
  count(*) FILTER (WHERE e.classification = 'additional')                           AS additional_count,
  count(*)                                                                          AS files_worked,
  coalesce(sum(e.amount_cents), 0)                                                  AS amount_owed_cents,
  coalesce(sum(e.amount_cents) FILTER (WHERE e.status = 'paid'), 0)                 AS paid_cents,
  coalesce(sum(e.amount_cents) FILTER (WHERE e.status IN ('earned','approved')), 0) AS balance_cents
FROM public.mortgage_agent_compensation_entries e
JOIN public.profiles p ON p.id = e.agent_user_id
WHERE e.pay_period = $month
  AND e.status NOT IN ('voided', 'excluded')
GROUP BY 1, 2, 3
ORDER BY 2, 3;
```

Example: `30 initial × $10 + 12 additional × $5 = $360`.

Drill-in: same filters, one row per request (loan, tenant, check, claim, classification, tenant event id, timestamps, status, payment ref).

Dashboard work-in-progress counts continue to come from `mortgage_handling_requests`, not from the payable table.

---

## 12. Historical / backfill strategy (propose only — do not run)

### 12.1 How existing CBE relate to requests

Live tenant Mortgage Ops events (`mortgage_ops_initial` / `mortgage_ops_additional_check`) are created at **Accept** and store `mortgage_request_id` + `check_intake_item_id` + `claim_id`.

That means:

- A CBE can exist for work that was **never completed** (exactly the `5b20db20` case).
- A completed request should normally have a CBE if it was accepted after the billing launch cutoff.
- Pre-launch completed work may have **no** CBE. Backfill must not invent tenant charges.
- Older `event_type='mortgage_handling'` rows (check-stage trigger / leftover) are a different meter. Do not treat them as the accepted `$10/$5` authority without a separate review.

Authorized later **read-only** inventory (not run in this phase):

```sql
SELECT
  r.id, r.status, r.assigned_employee_id, r.accepted_at, r.completed_at,
  r.tenant_id, r.claim_id, r.check_intake_item_id,
  e.id AS billing_event_id, e.event_type, e.unit_price_cents, e.status AS billing_status
FROM mortgage_handling_requests r
LEFT JOIN check_billing_events e
  ON e.mortgage_request_id = r.id
 AND e.event_type IN ('mortgage_ops_initial','mortgage_ops_additional_check')
ORDER BY r.accepted_at NULLS LAST;
```

Plus unmatched CBE (event with no completed request) and unmatched completed requests (completed with no CBE).

### 12.2 Proposed backfill rules (future authorization)

Include as `earned` only when **all** are true:

- `status = 'completed'` and `completed_at` present
- `assigned_employee_id` present
- Request is not on the exclusion list

Exclude / `excluded`:

- Request `5b20db20-13e1-4919-9528-06388d8661d2` (Freedom accidental Accept; in_progress; has $10 CBE; **never completed**)
- Synthetic acceptance tenant `6f2c1a90-0ad9-4c3e-9b71-2c8e6d4f1a20` and its two completed test files
- Any other labeled `SYNTHETIC` / `PROD-MOPS-` / `PROD E2E TEST` rows found by the inventory

For included completed rows:

- Copy classification from matching CBE when present
- Else classify among completed siblings; leave `tenant_billing_event_id` null
- Amount from agent rate table
- **Never INSERT or UPDATE `check_billing_events`**
- Idempotent on `mortgage_request_id`

### 12.3 Separate handling of `5b20db20-13e1-4919-9528-06388d8661d2`

Do **not** use this row to infer legitimate agent compensation.

Recommended separate ops ticket (not this workstream):

1. Leave the request `in_progress` and the $10 CBE `recorded`. Do not delete, unassign, requeue, complete, or void from this workstream.
2. Exclude from any future agent backfill (`excluded` or omit).
3. Tenant-side: Freedom was charged a recorded usage event with no Stripe/Moov movement. Decide later whether to void that **tenant** event, leave it, or complete the real file under a different agent. That is a tenant-billing decision, not agent pay.
4. Completing it later would currently earn the assigned agent (`b100f05d-…`) unless it is first unassigned. Do not complete it as a way to “clean up.”

---

## 13. Exact files / migrations expected to change (after authorization)

**New (isolated until review):**

- `aws/isolated/mortgage-agent-compensation/sql/47_mortgage_agent_compensation.sql` (number reserved; 39/44/45/46 stay untouched)
- `aws/functions/api/mortgage-agent-compensation.mjs` (admin approve/pay/list; no money rails)
- `src/components/admin/MortgageAgentsPanel.tsx`
- `src/components/admin/MortgageAgentCompensationDashboard.tsx`
- `src/components/admin/MortgageAgentReconciliation.tsx`
- Tests under `aws/tests/mortgage-agent-compensation*.test.mjs`

**Modify (narrow):**

- `src/pages/admin/AdminTenants.tsx` — add tab only; do not touch Branding / EmailSenderSettings / `showSendingDomain`
- `src/pages/admin/AdminMortgageOps.tsx` — extract panel; keep route as alias
- `aws/functions/api/tenant-admin.mjs` `runHireMortgageAgent` — also upsert `mortgage_agent_accounts`
- `supabase/functions/hire-mortgage-agent/index.ts` — same registry upsert (legacy path)

**Do not modify:**

- `aws/rls/sql/39_mortgage_ops_agent_accept_complete.sql`
- `aws/functions/api/mortgage-ops-usage.mjs`
- `aws/functions/api/workflow-rpc.mjs` Accept/Complete (trigger is sufficient)
- `aws/functions/api/bill-mortgage-handling.mjs`
- `src/pages/mortgage-ops/MortgageOpsQueue.tsx` / Login / Auth
- Cognito, provider flags, Moov/Stripe, Branding, Homeowner ledger routes

---

## 14. Collision analysis — Branding and Homeowner Ops

Open composed candidate: **PR 635** `cursor/homeowner-branding-compose-6f10` (Branding `3fe039772` + Homeowner `c6f15a10c`). Source-only. Same `origin/main` base as this branch.

| Workstream | Files | Collision with this design? |
|---|---|---|
| Branding (#634 / #635) | `CompanyBrandingSettings`, `EmailSenderSettings`, `TenantLogo`, `email-branding.mjs`, **`AdminTenants.tsx`** (`showSendingDomain={true}`), invoices/public branding | **Yes — `AdminTenants.tsx` only.** Add a new tab; do not edit branding/email blocks. Rebase/merge later with care on that one file. |
| Homeowner (#632 / #633 / #635) | `App.tsx` route order `/h/ledger/:token`, `publicTokenRoutes.ts`, homeowner ledger tests | **No file overlap** if we do not add routes. Keep `/admin/mortgage-ops` alias; do not touch `App.tsx` unless required. |
| Mortgage Ops production (#631) | Isolated repair, SQL 39, usage accrual, production SPA/Lambda | **Must not merge into or edit.** Compensation trigger is additive SQL on Complete; it does not change Accept billing or SQL 39. |
| Tenant Management command-center branches | Older `/admin/tenants` experiments | Dead-end relative to live `AdminTenants`. Ignore. |

SQL number `47` is unused on `origin/main` and on `mortgage-ops-repair-ad99`. 39/44/45/46 are reserved for Mortgage Ops / Claim Ledger / tenant billing.

---

## Recommended earn point (item 4 business outcome)

**Earn at Complete, not Accept.**

We pay agents for files they **actually worked and closed**. Tenant usage is already recorded at Accept. Those are different facts:

| Event | Tenant receivable | Agent payable |
|---|---|---|
| Accept | Yes (`check_billing_events`) | No row |
| Accept + never complete | Tenant charged | Nothing owed |
| Accidental Accept (`5b20db20`) | Tenant usage recorded | Nothing owed |
| Unassign / re-Accept | Existing CBE stays (idempotent on check) | Still nothing until Complete |
| Complete by assigned agent | No second CBE | **Earn once** to `assigned_employee_id` |
| Admin Complete | No second CBE | Earn to assigned agent (admin is not paid) |
| Cancel | No reversal in this phase | No earn |
| Duplicate Complete | No second CBE | No second payable |

This is the safest idempotent point given the current workflow.

---

## Implementation plan (after this review)

Do not start until authorized.

1. **Staging SQL 47 only** — registry, rates, entries, batches, audit, earn trigger, admin RPCs. No production apply.
2. **Hire/deactivate** — registry upsert; deactivate without unassign or history rewrite.
3. **Tenant Management tab** — roster + monthly dashboard + drill-in. Source/staging SPA only.
4. **Payment recording + audit** — approve/pay single and monthly batch. No rails.
5. **Reconciliation view** — flag-only anomalies.
6. **Staging tests** — earn idempotency, reassignment, cancel, duplicate complete, deactivate, paid immutability, no CBE insert, no MHR grant widening, Mortgage Ops isolation still pass.
7. **Backfill** — only after a dedicated read-only production inventory and a separate authorization. Exclude `5b20db20` and synthetic acceptance rows.

---

## What this phase did not do

- No production AWS, SQL, Cognito, SPA, or Lambda writes
- No staging schema apply
- No live Mortgage Ops overlay edit
- No tenant billing change
- No production backfill
- No money movement
