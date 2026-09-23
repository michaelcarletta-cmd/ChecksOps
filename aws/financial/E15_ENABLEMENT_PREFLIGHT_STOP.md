# E15 — Enablement/recovery STOP

Recorded 2026-09-23T01:59Z. **No production mutation.** Flag not enabled. Brenda not synced. Official rear not generated. No CheckAlt.

## Failed precondition

Approved overlay CodeSha was `mFOs4IbAzVHVwLsaG3PR6iHJhsI3FkbaviPMJMnmvmU=` (2026-09-23T01:35:48Z).

Live `checksops-production-prep-api` is now:

| Item | Value |
| --- | --- |
| CodeSha256 | `DSB/GxsyKXm3JklAi/iwdt0mqON5TYqV6cypJWi8gNY=` |
| LastModified | `2026-09-23T01:45:06.000+0000` |
| Env count | 41 |
| `AWS_ENDORSEMENT_AUTO_ADVANCE` | `false` |

## What changed

One file differs from the approved overlay zip: `workflow-rpc.mjs`.

`#432` endorsement files still hash-match the staging-tested artifact (`retryAutoAdvanceAfterOfficialRear`, payee-sync, savepoint Ready write).

The `workflow-rpc.mjs` delta is CheckAlt Settings RPC gating (`save_checkalt_settings` / `save_checkalt_tenant_auto_deposit` behind `AWS_WRITES_ENABLED` instead of the T5 workflow flag). It is not the endorsement Ready path, but it is an intervening production overlay after the approved CodeSha.

## Brenda (read-only)

`f618a3ea-e995-449f-b53f-329c81a6dcbc` `#1070668` still `endorsements_in_progress` / `endorsing`, `updated_at=2026-09-22T22:23:04.988Z`, 2/2 endorsements signed, Brenda payee still `pending`, official rear missing, `deposited_at` null.

## Next

Re-approve enablement/recovery against live CodeSha `DSB/GxsyKXm3JklAi/iwdt0mqON5TYqV6cypJWi8gNY=` (or restore the approved overlay) before any flag change or Brenda write.
