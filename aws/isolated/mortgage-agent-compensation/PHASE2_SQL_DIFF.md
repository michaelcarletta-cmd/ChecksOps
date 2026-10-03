# Phase 2 proposed staging SQL / RLS diff

**Applied to staging** via dedicated oneshot `checksops-staging-macomp47-oneshot` after TOCTOU inspect `62f4d94afd3f2cb403f25a5eb5945d4ff8af52fd26c5032fffa11691260af11d`. The shared `checksops-staging-guarded-sql-executor` was not mutated. Production was not applied.

## File

`aws/isolated/mortgage-agent-compensation/sql/47_mortgage_agent_compensation.sql`

## Objects added

| Object | Kind |
|---|---|
| `mortgage_agent_accounts` | table + RLS SELECT for platform owner/admin only |
| `mortgage_agent_compensation_rates` | singleton 1000/500, no UI |
| `mortgage_agent_compensation_exclusions` | includes `5b20db20-…` and synthetic acceptance request IDs |
| `mortgage_agent_compensation_entries` | payable ledger |
| `mortgage_agent_compensation_batches` | approve/pay bookkeeping |
| `mortgage_agent_compensation_audit` | append-only |
| `aws_is_active_mortgage_agent(uuid)` | inactive Accept block; missing roster row = active |
| `earn_mortgage_agent_compensation(uuid)` | Complete-time, idempotent |
| `tr_reject_inactive_mortgage_agent_accept` | BEFORE UPDATE on MHR Accept only |
| `tr_earn_mortgage_agent_compensation` | AFTER UPDATE OF status, completed_at |
| `set_mortgage_agent_account_status` | deactivate without deleting `user_roles` |
| `approve_mortgage_agent_compensation` | earned → approved |
| `mark_mortgage_agent_compensation_paid` | earned/approved → paid |
| `mortgage_agent_compensation_reconciliation` | flag-only; tenant $0 is not amount_mismatch |

## Explicit non-changes

- No `ALTER` / table-level `UPDATE` on `mortgage_handling_requests`
- No `ALTER` / INSERT on `check_billing_events`
- No SQL 39 / `aws_is_mortgage_ops_agent` edit
- No Moov / Stripe / ACH / wallet
- No production apply
- No historical payable backfill

## Concurrent SQL workstreams

| Workstream | Number | Collision? |
|---|---|---|
| Mortgage Ops Accept/Complete | 39 | No. 47 does not replace or re-grant SQL 39. |
| Claim Ledger | 44 | No shared objects. |
| Tenant Mortgage Ops billing | 45/46 | 47 reads CBE; does not alter it. |
| Branding / Homeowner | none | No SQL. |

Reserved number **47** is unused on `origin/main` and `mortgage-ops-repair-ad99`.
