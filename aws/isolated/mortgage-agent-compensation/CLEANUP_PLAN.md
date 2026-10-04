# Staging demo compensation cleanup — PREPARED, NOT EXECUTED

Date: 2026-10-04T21:40Z
Authorization: prepare / safety review only. Do not execute. Do not deploy.
Environment: staging only. Production unauthorized.

## Recommendation

Use option 2: a staging/demo-specific, tightly allowlisted administrative cleanup.

Do **not** apply the previously prepared permanent `paid → excluded|voided` trigger carve-out.

SQL 50 is **not a permanent catalog migration**. It is oneshot-owned, transaction-scoped DDL/DML that must restore the original SQL 47 paid-immutability trigger before COMMIT.

## Comparison

### 1. Permanent `paid → excluded|voided` (rejected)

The first SQL 50 draft replaced `tg_protect_mortgage_agent_compensation_facts` so any paid row could later be excluded or voided, and added a durable `exclude_mortgage_agent_compensation` RPC granted to `authenticated`.

That works for totals, but it permanently weakens the ledger invariant. SQL 47/48/49 were later applied to production. A general SQL 50 would be the next tempting production apply. There is no product need to unpay real Mortgage Agent rows.

### 2. Staging/demo allowlisted cleanup (recommended)

Inside one PostgreSQL transaction:

1. Install a temporary facts-trigger body that allows `paid → excluded` **only** when tenant/request/check/agent match the hardcoded A47/A48 allowlist. Facts and paid DELETE stay blocked. `paid → voided` stays forbidden.
2. `UPDATE` only inspect-locked IDs that also match that allowlist. Set `status='excluded'` and `exclusion_reason` only. Do not write `amount_cents`, `payment_reference`, `paid_at`, Desk, or tenant billing.
3. Write `mortgage_agent_compensation_audit` (`action=exclude`, `payment_reference_preserved=true`).
4. Insert `mortgage_agent_compensation_exclusions` for every allowlisted request, including `a47cad99-…023`.
5. Restore the exact SQL 47 trigger (`paid → anything` forbidden).
6. COMMIT. ROLLBACK leaves the original trigger unchanged.

Existing monthly already ignores `status IN ('voided','excluded')`, so roots and children drop from totals without changing the $10/$5 formula.

### 3. Existing mechanism that keeps paid immutability (incomplete)

There is **no** supported writer that both preserves `paid → anything` and removes paid rows from monthly totals.

- `set_status` is agent-account only.
- `approve` / `mark_paid` cannot unpay.
- `adjust` adds children and does not clear Files Worked.
- `mortgage_agent_compensation_exclusions` blocks future earn and recon `completed_without_compensation`, but `handleMonthly` does **not** join it. Paid `$25` would remain.
- Joining exclusions into monthly would change the compensation formula and would make `Paid` no longer equal `sum(status='paid')`.
- `exclusion_reason` can be set on a paid row (it is not a protected fact), but status would stay `paid` and totals would not move.

## Payment-reference confirmation

Exclusion of a previously paid synthetic row is **bookkeeping exclusion of staging test data only**.

It does **not** reverse, refund, unpay, or alter `MACOMP-STAGING-15` / `MACOMP48`. Those columns stay on the row. `paid_at` stays. Amounts stay. No Moov/ACH/Stripe/wallet movement. No `check_billing_events` change.

## Affected IDs

### Fail-closed allowlist

| Kind | IDs |
| --- | --- |
| Tenant | `a2c0fbfe-e8c5-42dc-bc32-2c4edf8f2074` |
| Requests | `a47cad99-…021`, `…022`, `…023`; `a48cad99-…021`, `…024` |
| Checks | `a47cad99-…011`, `…012`, `…013`; `a48cad99-…011`, `…013` |
| Agents | Morgan `b100f05d-…131d9`, Mo `4584ac20-…5376` |

Refuse Freedom `5b20db20-…`, production fixtures `7a7ec1ce-…` / `71ea6822-…`, GATE4 `c4f1b55b-…`, another tenant, or another agent.

### Known roots

| Entry ID | Request | Class | Amount | Status | Payment |
| --- | --- | --- | --- | --- | --- |
| `50509ac0-f3c3-4051-acf6-69fc9988be74` | `a47cad99-…021` | initial | $10.00 | paid | `MACOMP-STAGING-15` |
| `60745413-ce5e-4c65-8992-b0fd401bfa42` | `a47cad99-…022` | additional | $5.00 | paid | `MACOMP-STAGING-15` |
| `144e5657-f0c9-4fab-9bb8-eea28ad41136` | `a48cad99-…021` | initial | $10.00 | paid | `MACOMP48` |
| promo root (inspect must lock) | `a48cad99-…024` | additional | $5.00 | earned | none |

Children of `144e5657-…` (+$2.50 / −$1.00 / −$10.00 / +$10.00) are inspect-locked. Apply is CAS-gated on `expected_ids_fingerprint`.

## Before / after expected totals (UTC `2026-10`)

| | Initial | Additional | Files | Adjustments | Gross | Paid | Balance |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **Before family** | 2 | 2 | 4 | +$1.50 | $31.50 | $25.00 | $6.50 |
| **After family** | 0 | 0 | 0 | $0.00 | $0.00 | $0.00 | $0.00 |

Per agent before: Morgan 2 files, +$10 adj, Gross $25, Paid $15, Balance $10. Mo 2 files, −$8.50 adj, Gross $6.50, Paid $10, Balance −$3.50.

## UI delta (retained, not deployed)

`Gross Owed = Initial×$10 + Additional×$5 + Adjustments`

Show **Adjustments** only when `adjustment_cents !== 0`. Gross / Paid / Balance formulas unchanged. No Mortgage Agents redesign.

## Execute gate (later authorization only)

1. Deploy only `checksops-staging-macomp50-oneshot`. Never staging-api, shared executor, or production.
2. `action=inspect` → exact child/promo IDs and fingerprint. Confirm live trigger is still SQL 47.
3. Human review of `entry_ids`.
4. `action=apply` with `confirm=STAGING_EXCLUDE_MACOMP_DEMO_A47_A48` and `expected_ids_fingerprint`.
5. `action=verify` → family totals zero; payment refs unchanged; trigger restored; tenant billing unchanged; production untouched.

This turn did **not** create that Lambda, did **not** apply SQL, did **not** overlay SPA/API, and did **not** exclude any row.

## STOP

Cleanup remains prepared and gated. Not executed.
