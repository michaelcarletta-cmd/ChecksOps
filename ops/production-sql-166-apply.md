# Production SQL 166 (the Mortgage Desk agent switches the loss draft between Monitored and Not Monitored)

| key | file | what it does |
|---|---|---|
| `sql166` | `aws/workflows/sql/166_mortgage_desk_set_monitoring.sql` (sha256 `632a258a90742fc6f30c206533624e72b295c5d0d87ad8d85d1a5a920d3e71d5`, authored by `864d41dc6`) | Refuses without its prerequisites (`55000 sql166_prerequisite_missing`) or unless the applying login can reach `check_messages`, `loss_draft_audit_log`, `loss_draft_tracking` and `mortgage_handling_requests` past RLS (`55000 sql166_definer_cannot_reach`); then one new SECURITY DEFINER function, EXECUTE `checksops` and the owner only. |

**Why.** Owner 2026-11-14: "Mortgage agent needs to be able to change the claim from monitor to not monitored, so the
tenants see that type of update." Owner answers the same day: only while the request is in progress; switching to Not
Monitored when escrow or draws are recorded is allowed with a warning (the function must not refuse it, it returns a
flag so the Desk page can warn); the tenant sees a check-thread message; a check with no loss-draft file is refused.

- `loss_draft_tracking.monitoring_type` (`monitored` / `not_monitored`, default `monitored`; one row per check through
  the unique `idx_loss_draft_check_id`) is the field. Tenants set it with `loss_draft_action set_monitoring_type`
  (`aws/functions/api/workflow-rpc.mjs`), which also writes a `loss_draft_audit_log` row.
- A mortgage agent cannot: the write policy `aws_write_loss_draft_tracking` is `aws_can_write_check` (tenant members
  only; `aws/rls/sql/24_complete_write_policies.sql`), and `check_messages` and `loss_draft_audit_log` are member-scoped
  too. As in SQL 122, no policy or table grant changes; a SECURITY DEFINER function checks the caller itself.

**What it does.** `public.aws_mortgage_desk_set_monitoring(_request_id uuid, _monitoring_type text) RETURNS jsonb`,
plpgsql, VOLATILE, SECURITY DEFINER, `SET search_path = public, pg_temp` (no `row_security` setting, as SQL 122):
- the gate is SQL 122's `aws_mortgage_desk_working_request(_request_id, ARRAY['in_progress'])` (the assigned mortgage
  agent holding `mortgage_agent`, or the platform owner; the request `in_progress` with a check, locked FOR UPDATE;
  `42501 not_authorized` / `not_assigned_to_you` / `request_not_in_status` or `22023 request_has_no_check` otherwise);
- the type is `monitored` or `not_monitored` (trimmed, lower-cased), else `22023 invalid_monitoring_type`;
- the check is the request's `check_intake_item_id`; its `loss_draft_tracking` row is locked FOR UPDATE; none:
  `22023 request_has_no_loss_draft`; `escrow_status` `endorsing` or `final_release_complete` (the closed statuses,
  `CLOSED_LOSS_DRAFT_STATUSES` in `workflow-rpc.mjs`): `42501 loss_draft_closed`;
- `escrow_or_draws_recorded`: `total_escrowed`, `draw_amount_requested`, `draw_amount_released` or `holdback_amount`
  above 0, `draw_stage` above 0, or `escrow_status` `escrowed`, `first_draw_requested` or `partial_release` (what
  `mark_escrowed`, `request_draw`, `record_release` and `record_holdback` write). It never refuses the switch;
- unchanged type: nothing written; `{ok: true, changed: false, monitoring_type, request_id, loss_draft_id,
  escrow_or_draws_recorded}`;
- otherwise `monitoring_type` and `updated_at = now()`; one `loss_draft_audit_log` row (action `set_monitoring_type`,
  actor the caller, no amount, notes the message, old and new `{escrow_status, monitoring_type, total_escrowed,
  draw_amount_released, holdback_amount}` with the amounts as text, the shape `loss_draft_action` writes); one
  `check_messages` row on the check from the caller (the columns SQL 122's `aws_mortgage_desk_post_message` writes):
  "ChecksOps Mortgage Desk changed this loss draft to Not Monitored." or "ChecksOps Mortgage Desk changed this loss
  draft to Monitored."; returns `{ok: true, changed: true, monitoring_type, previous_monitoring_type, request_id,
  loss_draft_id, message_id, escrow_or_draws_recorded}`.

Not changed: no existing function is replaced (SQL 122's gate keeps its body and ACL); no table, column, policy, table
grant, trigger or row is changed by the apply. The db-readonly-validate trigger count is not affected. The tenant's own
`set_monitoring_type` and every escrow and draw action are unchanged. No API, Lambda or SPA change is part of this pin:
the Desk API action and the Desk page's switch and warning ship afterwards through their own guarded paths.

**Status:** staging pin execute-authorized (wave 58); not applied anywhere. The production pin is pending.

**Staging read-live (2026-11-14).** Run 43623201872 (main `3239508c`, after executor inspect run 43622613027 and executor deploy
run 43622915623 (executor CodeSha256 `BGu9krtX…` -> `4gH9sgaz…`)), under the owner's words "apply SQL 166 and SQL 167 in
staging": `already_applied` false, `precondition_failures` `[]`, `prerequisites_missing` `[]`; the function absent. Live
`11a10b33e6a5a46ea98934487cd9e941ddfe6b232ca6c7d4debad8c2f033f608`, equal to the derived pre-state; intended `5c8e030f…`. Recorded in the staging pin
(`expected_live_definition_sha256`, `execute: true`, wave 58). The staging apply is a separate run after this pin is merged and
the executor is redeployed carrying it, on the owner's words for that run. The production pin stays pending.

Production authorization phrase (pin `authorization_phrase`): `LET_MORTGAGE_DESK_SWITCH_LOSS_DRAFT_MONITORING`.

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec `sql166` in
`release-sql-specs.mjs`). Intended `5c8e030f32fdfbaf892a7496a5b5c71c02aca0b6494cf04b9e62ab71e3534e9e`:

```
release sql166 v1
function public.aws_mortgage_desk_set_monitoring(uuid, text): lang=plpgsql vol=v parallel=u secdef=true result=jsonb config=search_path=public, pg_temp prosrc=d30abdb6fc8b72300e57ec227d976ab6127ab3632f68a57402b8575ca05fa52b acl=checksops EXECUTE;owner EXECUTE
```

**Expected pre-state (both environments).** The function absent:

```
release sql166 v1
function public.aws_mortgage_desk_set_monitoring(uuid, text): absent
```

That is `11a10b33e6a5a46ea98934487cd9e941ddfe6b232ca6c7d4debad8c2f033f608` (`releaseStateHash('sql166', {})`). Each pin records its own environment's read; neither value is written
into a pin before a run reads it. A pre-state other than this one is a stop.

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present`; `function_acl_replaceable`, `functions_owned_by_login` and `function_results_match` (where
present); `definer_can_write_relations` on `check_messages`, `loss_draft_audit_log`, `loss_draft_tracking` and
`mortgage_handling_requests` (the DEFINER function must reach them past RLS as their owner; filtered by RLS it would
find no loss draft and write nothing).

Post-conditions: the intended fingerprint; everything else in schema `public` unchanged. The tools roll back otherwise.

## Steps (each its own reviewed PR or owner-approved run)

1. Staging read-live (`guarded-staging-sql-executor.yml`, choice `sql166-mortgage-desk-set-monitoring`), then the staging pin PR and the staging apply.
2. Production read-only inspect: `production-sql-one-shot.mjs --migration sql166 --phase inspect` (`ops/production-sql-one-shot.md`).
3. Production pin PR: record `production_inspect` and `staging_acceptance`, set `execute: true`; the owner merges it.
4. Production apply: `--phase apply` with the owner's exact words.
5. Record PR: the `applied` block, `execute: false`.
