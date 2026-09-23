# E15 — Enablement/recovery STOP (second preflight)

Recorded 2026-09-23T02:05Z. **No production mutation.** Flag not enabled. Brenda not synced. Official rear not generated. No CheckAlt. `workflow-rpc.mjs` was not restored or overwritten.

## Failed precondition

Re-approval required live `checksops-production-prep-api` CodeSha:

`DSB/GxsyKXm3JklAi/iwdt0mqON5TYqV6cypJWi8gNY=` (2026-09-23T01:45:06Z)

Immediate preflight found a newer overlay:

| Item | Expected | Live |
| --- | --- | --- |
| CodeSha256 | `DSB/GxsyKXm3JklAi/iwdt0mqON5TYqV6cypJWi8gNY=` | `Bnx0Ks+InwyfDAAqdx6megMgLa3oCbG+ZlKISmP5K2A=` |
| LastModified | `2026-09-23T01:45:06.000+0000` | `2026-09-23T02:03:02.000+0000` |
| RevisionId | (DSB artifact) | `a27abcff-f120-4374-845d-869715807ae1` |
| Env count | 41 | 41 (identical key/value set) |
| `AWS_ENDORSEMENT_AUTO_ADVANCE` | `false` | `false` |

## What changed vs the DSB artifact

`#432` endorsement files still byte/hash match the staging-tested pack:

- `check-endorsement.mjs`
- `endorsement-payee-sync.mjs`
- `write-check-workflow.mjs`
- `write.mjs`
- `documents.mjs`
- `endorsement-composite.mjs`

The previously known delta (`workflow-rpc.mjs` only) is **no longer the only difference**. Three unexpected files changed after the DSB artifact:

| File | Change |
| --- | --- |
| `auth-financial-totp.mjs` | CheckAlt step-up accepts `deposit.approve` in addition to `deposit.submit`; log `operation` uses bound `actionKey` |
| `providers/production/checkalt-authz.mjs` | Adds `CHECKALT_APPROVE_ACTION` / `FINANCIAL_CHECKALT_STEPUP_ACTIONS`; `authorizeCheckAltProduction` takes `actionKey` |
| `providers/production/checkalt-approve.mjs` | Approve now `requireStepUp: true` with `CHECKALT_APPROVE_ACTION`; any failed authz returns immediately |

This is a Manager-approval TOTP gate, not the endorsement Ready path, but it is an intervening production overlay after the re-approved CodeSha. Fresh-preflight rule: **STOP**.

## Brenda (read-only)

`f618a3ea-e995-449f-b53f-329c81a6dcbc` `#1070668` `$9,952.47` still:

- `endorsements_in_progress` / `endorsing` / `endorsements_pending`
- `updated_at=2026-09-22T22:23:04.988Z`
- 2/2 genuine endorsements signed
- Brenda payee still `pending` / `endorsed_at=null`
- official rear missing (`back_image_deposit_path=null`)
- `deposited_at=null`
- no `checkalt_deposits` row visible for this intake id

Inspect still: 22 endorsing, 1 stuck (Brenda), 0 Ready in that set.

## Not performed

A payee sync, B `AWS_ENDORSEMENT_AUTO_ADVANCE=true`, C official-rear recovery, auto-advance retry, Manager approval, CheckAlt/Moov/provider execution.

## Next

Re-approve enablement/recovery against live CodeSha `Bnx0Ks+InwyfDAAqdx6megMgLa3oCbG+ZlKISmP5K2A=` (or restore a reviewed artifact) before any flag change or Brenda write.
