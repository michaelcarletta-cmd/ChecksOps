# Staging demo compensation cleanup — PREPARED, NOT EXECUTED

Date: 2026-10-04T20:30Z
Authorization: prepare only. Do not execute. Do not deploy.
Environment: staging only. Production unauthorized.

## Safest existing mechanism

The live monthly formula already ignores `status IN ('voided','excluded')`. That is the correct off-switch. There is **no existing writer** that can set those statuses.

`set_status` is agent-account active/inactive only.  
`approve` / `mark_paid` cannot unpay.  
`adjust` would add more children and would **not** remove Files Worked.  
`mortgage_agent_compensation_exclusions` blocks **future earn** and recon completed-work, but `handleMonthly` does **not** consult it. Adding that join would change the compensation formula and is out of scope.

`tg_protect_mortgage_agent_compensation_facts` currently forbids `paid → anything`. Three of the four demo roots are `paid` (`MACOMP-STAGING-15`, `MACOMP48`). They cannot be excluded without a narrow trigger carve-out: allow `paid → excluded|voided` only, and still forbid fact rewrites and paid deletes.

Prepared path (SQL 50 + gated oneshot, not applied):

1. `exclude_mortgage_agent_compensation(uuid[], reason)` sets `status='excluded'` and `exclusion_reason`, writes `mortgage_agent_compensation_audit`, inserts `mortgage_agent_compensation_exclusions` for those request IDs (`ON CONFLICT DO NOTHING`).
2. Oneshot apply also inserts exclusions for every allowlisted request, including `a47cad99-…023` (cancel-before-complete, no payable today), so it cannot earn later.
3. Rows stay in place. `amount_cents`, classification, earned/completed timestamps, and payment refs stay intact.
4. Tenant `check_billing_events` and Mortgage Desk requests are not touched. No Moov/ACH.
5. Allowlist is the `a47cad99-…` / `a48cad99-…` family on tenant `a2c0fbfe-e8c5-42dc-bc32-2c4edf8f2074` only.

Do **not** DELETE. Do **not** reverse with new adjustments. Do **not** deactivate agents. Do **not** tenant-wipe SYNTHETIC Consolidated Monthly Billing.

## Affected IDs

### Fail-closed allowlist

| Kind | IDs |
| --- | --- |
| Tenant | `a2c0fbfe-e8c5-42dc-bc32-2c4edf8f2074` |
| Requests | `a47cad99-…021`, `…022`, `…023`; `a48cad99-…021`, `…024` |
| Checks | `a47cad99-…011`, `…012`, `…013`; `a48cad99-…011`, `…013` |
| Agents | Morgan `b100f05d-…131d9`, Mo `4584ac20-…5376` |

Refuse if any selected row is Freedom `5b20db20-…`, production fixtures `7a7ec1ce-…` / `71ea6822-…`, GATE4 `c4f1b55b-…`, another tenant, or another agent.

### Known roots (from accepted audit)

| Entry ID | Request | Class | Amount | Status | Payment |
| --- | --- | --- | --- | --- | --- |
| `50509ac0-f3c3-4051-acf6-69fc9988be74` | `a47cad99-…021` | initial | $10.00 | paid | `MACOMP-STAGING-15` |
| `60745413-ce5e-4c65-8992-b0fd401bfa42` | `a47cad99-…022` | additional | $5.00 | paid | `MACOMP-STAGING-15` |
| `144e5657-f0c9-4fab-9bb8-eea28ad41136` | `a48cad99-…021` | initial | $10.00 | paid | `MACOMP48` |
| promo root (ID not captured; inspect must lock it) | `a48cad99-…024` | additional | $5.00 | earned | none |

### Children of `144e5657-…` (IDs not captured; inspect must lock them)

| Reason | Agent | Amount | Status |
| --- | --- | --- | --- |
| underpayment | Mo | +$2.50 | earned |
| overpayment | Mo | −$1.00 | earned |
| wrong-agent debit | Mo | −$10.00 | earned |
| wrong-agent credit | Morgan | +$10.00 | earned |

Execute-time inspect selects by allowlisted request/check/root IDs, including children via `parent_entry_id`. Apply is CAS-gated on `expected_ids_fingerprint`.

`a47cad99-…023` has no payable (cancel-before-complete). Still add it to exclusions if a request row exists, so it cannot earn later.

## Before / after expected totals (UTC `2026-10`)

Family contribution (current displayed cards):

| | Initial | Additional | Files | Adjustments | Gross | Paid | Balance |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **Before family** | 2 | 2 | 4 | +$1.50 | $31.50 | $25.00 | $6.50 |
| **After family** | 0 | 0 | 0 | $0.00 | $0.00 | $0.00 | $0.00 |

Per agent before:

| Agent | Files | Adjustments | Gross | Paid | Balance |
| --- | ---: | ---: | ---: | ---: | ---: |
| Morgan | 2 | +$10.00 | $25.00 | $15.00 | $10.00 |
| Mo | 2 | −$8.50 | $6.50 | $10.00 | −$3.50 |

If inspect finds **no other** `2026-10` live rows, period totals become all zeros.  
If other live rows exist, `after_period = current_period − family`. Apply must not proceed unless `rejected=[]` and the fingerprint matches inspect.

Payment refs remain on the excluded paid rows. History/audit remain. Recon will not flag the four demo requests as `completed_without_compensation` because exclusions are inserted.

## UI delta (not deployed)

Narrowest change: show **Adjustments** next to the existing six totals **only when** `adjustment_cents !== 0`.

- API: one extra monthly column  
  `sum(amount_cents) FILTER (WHERE parent_entry_id IS NOT NULL)`  
  Gross / Paid / Balance formulas unchanged.
- UI: seventh Summary card + matching table column, hidden at zero.
- No page redesign. No $10/$5 rate change. Files drilldown already lists children.

Visual identity stays:

`Gross Owed = Initial×$10 + Additional×$5 + Adjustments`

Today: `$20 + $10 + $1.50 = $31.50`. After cleanup the card disappears.

## Execute gate (later authorization only)

1. Deploy **only** dedicated `checksops-staging-macomp50-oneshot`. Never the shared executor or `checksops-staging-api`.
2. `action=inspect` (no confirm) → print exact child/promo IDs and fingerprints.
3. Human review of `entry_ids`.
4. `action=apply` with `confirm=STAGING_EXCLUDE_MACOMP_DEMO_A47_A48` and `expected_ids_fingerprint`.
5. `action=verify` → family totals zero; tenant billing unchanged; production untouched.

This turn did **not** create that Lambda, did **not** apply SQL 50, did **not** overlay SPA/API, and did **not** exclude any row.

## STOP

Cleanup is prepared and gated. Not executed.
