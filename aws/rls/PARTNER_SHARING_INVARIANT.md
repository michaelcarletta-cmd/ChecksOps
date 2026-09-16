# PARTNER SHARING INVARIANT

Check ownership and check visibility are separate concepts.

A partner-shared check MUST NOT require:
`check_intake_items.tenant_id = viewing_partner`

Partner access is granted through an active `shared_checks` relationship
and the approved partner RLS/read model.

Never "repair" partner visibility by transferring check ownership or
duplicating the parent check.

## Protected production contract

Condition One Commercial tenant:
`4f172140-f57a-4744-8050-95f4f07b13b4`

Freedom tenant:
`2eff5f1a-929d-4ce3-9a8b-cd96b98df42a`

A Freedom-owned check that is actively shared with C1C:

- remains Freedom-owned (`check_intake_items.tenant_id` stays Freedom)
- is readable by Freedom
- is readable by C1C
- appears in the C1C normal Checks query (`check_intake_items` SELECT / RLS)
- contributes once to C1C `get_check_stage_totals`
- exposes authorized partner-safe payees and endorsements
- survives refresh
- treats a duplicate share as idempotent
- loses C1C access on revoke
- restores C1C access on reshare

`0` C1C-owned historical rows is **not** equivalent to `0` C1C-accessible checks.

## Do not

- change `check_intake_items.tenant_id` to the viewing partner
- insert historical C1C-owned copies of Freedom checks
- backfill `check_payees.tenant_id` or `check_endorsements.tenant_id` to grant partner access
- treat isolation `c1c_owned = 0` as "C1C has no checks"

## Approved read model

| Concern | Source of truth |
|---|---|
| Ownership | `check_intake_items.tenant_id` |
| Partner visibility | active `shared_checks` (`revoked_at IS NULL`) |
| Parent-check SELECT | `aws_select_check_intake_items` via owner **or** `aws_is_active_shared_check_target` |
| Combined access helper | `aws_can_access_check` |
| Share / revoke | `aws_share_check_with_partner` / `aws_revoke_shared_check` |
| Partner-safe children | `aws_partner_check_payees` / `aws_partner_check_endorsements` |
| Stage / status badges | `get_check_stage_totals` (owned + active shared, counted once) |
| Isolation reporting | `OWNED` vs `SHARED ACCESSIBLE` in authorization probe |

Production SQL apply status for `31` / `32` / `33` / `34` is recorded in
`ops/release-locks/applied-migrations.ledger.json` and
`ops/release-locks/proof/c1c-partner-share-production-apply.md`.
Do not reapply those files merely to document them.
