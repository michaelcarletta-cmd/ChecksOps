# C1C partner-share SQL — APPLIED IN PRODUCTION

This file is repository apply-evidence. It does **not** apply SQL.
Do **not** reapply these files on production merely because this proof exists.

## Production-tested implementation

| Field | Value |
|---|---|
| Repair PR | https://github.com/michaelcarletta-cmd/ChecksOps/pull/350 |
| Repair branch | `cursor/c1c-partner-share-repair-46ac` |
| Production-tested HEAD | `9aac7bb5b1ed0a8d03e305552797a9acfacc7f64` |
| Main at lockdown | `dfe241b5e98c01f6ceb5eda435dbfe93126a6237` |
| Repair merged to main? | **NO** — STOP BEFORE MERGE of #350 |

`31_partner_safe_read.sql` and `32_partner_share_lifecycle.sql` source already
landed on main via PR #302 (`faf9b82e728bd7ef42009e4c96ace05c7bd7232f`).
`33_partner_stage_totals.sql` and `34_c1c_partner_visibility.sql` exist only on
the unmerged repair HEAD.

## SQL applied in production (do not reapply)

| File | source_sha256 | Production status |
|---|---|---|
| `aws/rls/sql/31_partner_safe_read.sql` | `a85a29698e3cfa65ec29b0a834d24c74b2a7cac9c83c72d8ba9f4bb88949dd0f` | APPLIED IN PRODUCTION |
| `aws/rls/sql/32_partner_share_lifecycle.sql` | `3e2e12811c8795fed6e139aca60d4b1b43d1c5223b132e34a767fada99331af8` | APPLIED IN PRODUCTION |
| `aws/rls/sql/33_partner_stage_totals.sql` | `d4e12f1b6a35fcf37730f57fbfa116e24bf8f6ab69a7001182a9f2687ff7ab17` | APPLIED IN PRODUCTION |
| `aws/rls/sql/34_c1c_partner_visibility.sql` | `131792eef8cfca02d4cf837b3afc8f4e4bda76b281d9db8c4e825c428d65f0bd` | APPLIED IN PRODUCTION |

`34` is the live overlay that restored `aws_is_active_shared_check_target` and
the share-target OR on `aws_select_check_intake_items`. Repository files
`11_access_helpers.sql` and `12_final_select_policies.sql` already contain that
contract on main; production RDS did not until `34` was applied.

## Accepted production baseline (C1C)

Tenant: `4f172140-f57a-4744-8050-95f4f07b13b4`

- 94 / 94 historical Freedom → C1C shared checks visible
- 37 C1C-owned checks
- 131 total accessible checks
- Freedom remains owner of the 94 historical checks
- 0 ownership changes
- 0 historical bulk inserts
- Share button, partner selector, create share, duplicate protection: PASS
- Partner queue / detail / payee / endorsement / stage / search / refresh: PASS
- Revoke / reshare / Freedom ownership preserved: PASS

`0` C1C-owned historical rows is not equivalent to `0` C1C-accessible checks.

## What this proof does not claim

- It does not merge #350.
- It does not mark the partner-sharing component `PRODUCTION_LOCKED`.
- Application/API/UI source for the repair is still unmerged.
- It does not authorize a second apply of 31/32/33/34.
- It does not change production data.

Ledger `apply_evidence` rows link here. Future audits must treat those four
SQL files as already applied in production unless a later reviewed
`apply_evidence` row records a different hash.
