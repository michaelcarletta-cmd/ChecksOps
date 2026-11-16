# Production SQL 168 (a new check on a claim the Mortgage Desk handles goes to the same agent)

| key | file | what it does |
|---|---|---|
| `sql168` | `aws/workflows/sql/168_mortgage_desk_same_agent_new_check.sql` (sha256 `5d0d8e9de8df9b90089618d799cca835580c1aaf59f1140ee07ba5de1b577d15`, authored by `5bdff4117`) | Refuses without its prerequisites (`55000 sql168_prerequisite_missing`) or unless the applying login can reach `check_intake_items`, `loss_draft_tracking`, `mortgage_handling_requests`, `mortgage_ops_request_audit`, `mortgage_agent_accounts`, `check_messages` and `profiles` past RLS (`55000 sql168_definer_cannot_reach`); then two new SECURITY DEFINER functions, EXECUTE for the owner only, and two new triggers. |

**Why.** Today every check needs its own Send to Mortgage Desk (`SendToMortgageDeskButton`; the API inserts the request
as `requested`, unassigned, SQL 100's tenant rule) and any agent may accept it from the shared queue, so a second check
on a claim the Desk already handles can go to another agent. Owner 2026-11-16: "We need to make sure once a mortgage
agent handles a check, if another check comes in they handle each one for that check file." Decisions the same day:
1. auto-assign: the system creates the request for the new check and assigns it to the same agent; the tenant does
   nothing;
2. the same file is the same linked claim, `check_intake_items.claim_id` (the claim billing uses);
3. the agent who handled a check on that claim, on a request `in_progress` or `completed`, while still an active Mortgage
   Desk agent; with none, nothing happens: the tenant sends as today and the request goes to the shared queue;
4. the details are copied from that earlier request; the agent can edit them.

**What it does.**
- `aws_mortgage_desk_route_same_agent(_check_id uuid, _fired_by text)` (plpgsql, VOLATILE, RETURNS uuid: the new
  request, or NULL when nothing was done). It acts only when all hold:
  - the check has a tenant and a `claim_id`;
  - the check is not locked: `deposited_at` NULL and `check_stage` not `deposited`, `voided` or `returned` (SQL 167's
    rule, which is SQL 43's);
  - the check has a loss draft file (`loss_draft_tracking.check_intake_item_id`);
  - the check has no request that is `requested`, `in_progress` or `completed` (any endorsement order; a `cancelled` one
    does not count);
  - a source exists: a request of the same tenant on another check whose current `claim_id` is this claim, `in_progress`
    or `completed`, the 1st mortgagee (`COALESCE(endorsement_order, 1) = 1`), whose agent is still active as SQL 158's
    `aws_mortgage_desk_assign_agent` defines it (`has_role(agent, 'mortgage_agent')` and no `mortgage_agent_accounts`
    row for the agent with a status other than `active`). The most recent `in_progress` one (by `accepted_at`), else the
    most recent `completed` one (by `completed_at`).

  Then, in this order: one INSERT of the request as the tenant's own send writes it (`requested`, unassigned,
  `claim_id` = the check's, `endorsement_order` 1, `total_mortgagees`, `predecessor_request_id`, `requested_by`,
  `note` and `work_notes` empty) with the source's `mortgage_company`, `mortgage_servicer`, `loan_number`,
  `policy_number`, `claim_number`, `insurance_company`, `loss_type`, `date_of_loss`, `homeowner_name`,
  `homeowner_email`, `homeowner_phone`, `property_address` and `homeowner_ssn_last_four`; the agent's accept, the row
  change of `accept_mortgage_handling_request` and SQL 158's assign (`assigned_employee_id`, `in_progress`,
  `accepted_at = COALESCE(accepted_at, now())`, `updated_at`), guarded on still `requested` and unassigned; one
  `check_messages` row on the new check so the tenant sees it (owner 2026-11-16: a short automatic message, no email to
  the agent), in the columns SQL 166's Desk message writes (`check_id`, `sender_id` the agent, `body`, `is_deleted`
  false, `created_at` `clock_timestamp()`): "ChecksOps Mortgage Desk added this check to <name>'s file automatically
  (same claim)." with the agent's `profiles.full_name` (trimmed, as SQL 158 shows it), or "the agent already handling
  this claim" when there is none; one `mortgage_ops_request_audit` row (`action` `auto_route_same_agent`, `actor_id`
  NULL, `requested` to `in_progress`, `payload` with the agent, the source request and check, the claim, the message and
  what fired it). Idempotent: once it has run the
  check has an open request, so a second call does nothing.
- `aws_mortgage_desk_route_same_agent_trigger()` (RETURNS trigger) runs it for the row's check inside its own
  subtransaction: any error rolls back only the routing (the request, its accept, the message and the audit row) and is reported as a WARNING carrying the SQLSTATE only; the
  tenant's write goes through and the tenant can send as today.
- Trigger `aws_loss_draft_route_same_agent`, AFTER INSERT ON `loss_draft_tracking` FOR EACH ROW (the API's loss draft
  insert, and `trg_auto_create_loss_draft` when the check becomes `loss_draft_required`).
- Trigger `aws_check_claim_route_same_agent`, AFTER UPDATE ON `check_intake_items` FOR EACH ROW WHEN `claim_id` is set
  from NULL or changed (SQL 41's auto-link, SQL 43's Review save, SQL 44's link, SQL 167's relink). AFTER UPDATE with
  WHEN, not UPDATE OF `claim_id`: the auto-link sets `claim_id` in a BEFORE trigger, which UPDATE OF would not see.
- Both functions: SECURITY DEFINER, `SET search_path = public, pg_temp`, `SET row_security = on` (SQL 167's relink runs
  with `row_security = off`, which would otherwise carry into the triggers the routing's writes fire and fail the
  library-share trigger; the PostgreSQL test shows both). EXECUTE: REVOKE from PUBLIC, `anon`, `authenticated`,
  `service_role` and `checksops`; the owner keeps its own. A trigger runs its function without an EXECUTE check, and
  nothing calls them directly.

The message fires the live `check_messages` triggers unchanged, as SQL 166's and SQL 122's Desk messages do.

Never: an email to the agent; a 2nd-mortgagee request; any change to an existing request; a deposited, voided or returned check; a check with
no claim or no loss draft; another tenant's request or agent; an inactive agent. There is no per-tenant Mortgage Ops
access flag in the schema; a tenant reaches this only through a request it sent itself on an earlier check of the claim.
Existing checks are not back-filled: the triggers act on new events only.

**Billing.** The INSERT fires the live INSERT triggers on `mortgage_handling_requests`
(`trg_share_library_docs_to_mortgage_request`) and the accept fires the live accept triggers
(`tr_accrue_mortgage_ops_billing`, `tr_reject_inactive_mortgage_agent_accept`, `trg_mirror_mortgage_dates`, the
`updated_at` trigger), unchanged, as a tenant's send and an agent's accept do. Under SQL 160's
`accrue_mortgage_ops_billing` the routed request records **no charge** when the tenant already has a
`mortgage_ops_initial` or `mortgage_ops_additional_check` event that is not voided on the claim
(`check_billing_events.claim_id`), the normal case for an additional check. It records `mortgage_ops_initial` at the
tenant's initial rate (1000 by default) only when there is none: the earlier request was accepted before
`mortgage_ops_billing_launch`, its charge was voided, or it was recorded under another claim id (a check relinked by SQL
167 after it was charged). Agent pay (SQL 160's `earn_mortgage_agent_compensation`, at completion): nothing when, with
no billing event on its check, the tenant already has another completed request on the claim
(`mortgage_handling_requests.claim_id`); the initial amount when it has the `mortgage_ops_initial` event above, or when
it completes before any other request on the claim is completed (the source still in progress). The API's own accrual
(`mortgage-ops-usage.mjs`, after `executeAcceptMortgage`) does not run for a routed request: the trigger is the durable
path. `tr_accrue_mortgage_ops_billing` has no repository CREATE; the PostgreSQL test uses SQL 160's test stand-in.

Not changed: no table, column, policy, table grant or row; no other function or trigger (SQL 158's assign, SQL 160's
billing, SQL 167's relink keep their bodies). Two public triggers are added: the db-readonly-validate justified set and
expected trigger count follow after the apply, in their own change (as SQL 121). No API, Lambda or SPA change is part of
this pin: the API calls nothing new.

**Status:** applied in staging (wave 60, 2026-11-16, apply run 43882991880); staging acceptance: the staging apply under the owner's run approval ("apply SQL 168 in staging"; no separate acceptance statement); applied to production (2026-11-16); the production pin is retired (`execute: false`). Production `/db-readonly-validate` now counts 192 public triggers (SQL 168's two) while the production validator still expects 190, so it reports unhealthy until the `db-readonly-validate.mjs` production REPLACE (`096aae7a…` -> `bdb818b5…`, planned by #1954, no longer held by SQL 168), which needs the owner's words "DEPLOY db-readonly-validate.mjs TO PRODUCTION".

**Staging read-live (2026-11-16).** Run 43878936321 (main `5e2d6fe4e`, after executor inspect run 43871619672 and executor deploy
run 43872142937 (executor CodeSha256 `0KNPXGrb…` -> `Ul6WPHdS…`)), under the owner's words "apply SQL 168 in staging":
`already_applied` false, `precondition_failures` `[]`, `prerequisites_missing` `[]`; the functions and triggers absent. Live
`a364af9a300c5e617db353e67e3f37a18691a27f10d9349d506471067a31ef33`, equal to the derived pre-state; intended `60326558…`. Recorded in the staging pin
(`expected_live_definition_sha256`, `execute: true`, wave 60). An earlier read-live attempt (run 43878762111) was refused at the
workflow's input check (`approved_commit` missing) before reaching the database. The staging apply is a separate run after this
pin is merged and the executor is redeployed carrying it, on the owner's words for that run. The production pin stays pending.

**Staging executor refreshed and staging apply (2026-11-16).** The staging pin for SQL 168 (wave 60, PR #1937, owner's words
"merge the SQL 168 staging pin PR") merged as `bc52a5889195d3412ec2f31e5e843fd54c9919fa`. Executor inspect run 43881814016 read `Ul6WPHdS…` (not current);
deploy run 43882354934 updated the staging guarded SQL executor (CodeSha256 `Ul6WPHdS…` -> `aU0HiKBL…`). Apply run 43882991880
(main `bc52a5889`) under the owner's words "apply SQL 168 in staging": `before_hash` `a364af9a300c5e617db353e67e3f37a18691a27f10d9349d506471067a31ef33`, `after_hash`
`6032655886f96d76f95434ded6d947284eb0bf6e7cfa7aab11c4b21d1fd41166` (the intended hash), `result` applied. Read-live run 43883462531: `already_applied` true. The owner gave the run
approval "apply SQL 168 in staging"; no separate staging acceptance statement was given. There is no separate staging record
PR for SQL 168: these staging runs are recorded here and in the production pin's `staging_acceptance` by the production pin PR.

**Production inspect (2026-11-16).** Read-only `--inspect` through SSM `64f2c1ff-e883-47b9-b50b-cf2a11b0a7f2` on
`i-0c35557c4e5385406` (under the owner's words "run the SQL 168 production inspect"; runner started from stopped with no SSM
command in progress, command 14:18:04Z to 14:18:13Z, AWS-RunShellScript, Success, runner stopped again afterwards, all by
`user/claude-code`), main `bc52a5889` (tarball sha256 `96eb31fc6d7998854c58069d75e1422042f0ce14f4e66bf25e5f9c0dc2b459df`, checked by `sha256sum -c` on the
runner, `SOURCE_COMMIT` matched, staged by `sql53-temporary-transfer.yml` run 43883906810; sha256 of the printed sql168 output,
computed on the runner, `2ca492ab7ce4087eee57778173189956093d26bdd60c73605ff4bd176e93dc0d`, 2951 bytes), exit 0, `ok` true, `read_only` true, `current_user`
`checksops_admin`, `missing_dependencies` `[]`: live `a364af9a300c5e617db353e67e3f37a18691a27f10d9349d506471067a31ef33` (the two functions and the two triggers
absent: the derived pre-state, equal to staging's before its apply), no predecessor, `prerequisites_missing` `[]`,
`successors_applied` `[]`, `definer_writes` ok on `check_intake_items`, `loss_draft_tracking`, `mortgage_handling_requests`,
`mortgage_ops_request_audit`, `mortgage_agent_accounts`, `check_messages` and `profiles`, `already_applied` false,
`precondition_failures` `[]`, `apply_preconditions_met` false (no pre-state recorded yet). Production's pre-state equals
staging's (read-live run 43878936321 and the staging apply's `before_hash`), so the staging apply took the path production will.
Recorded in the production pin with the staging apply (run 43882991880) as its staging acceptance and `execute: true` under the
owner's words "open the SQL 168 production pin PR". The owner merges the pin change; the apply runs only after that merge is on
main and staged, under the owner's words for that run (phrase `ROUTE_NEW_CHECK_TO_SAME_MORTGAGE_AGENT`).

**Not verified by the inspect** (it reads only SQL 168's own objects): the live-only billing trigger
`tr_accrue_mortgage_ops_billing` (no CREATE in the repo; the routed accept fires it like any agent accept), whether
`trg_auto_create_loss_draft` is live on production (the route also fires on `claim_id` updates), and whether the two "active
agent" rules (SQL 158: no `mortgage_agent_accounts` row other than `active`; SQL 47/100: not `inactive`) agree on production's
roster.

**Production apply (2026-11-16).** After the pin change (#1939, merged to main as `bab01e726` on the owner's words "merge the SQL 168
production pin PR"), transfer run 43958936335 (`sql53-temporary-transfer.yml`) staged main `e81328645` (tarball sha256
`15a529ae0b2c1997b9cf7483130f61d9a258ae156e037aa6df504e7f6394ef7d`, checked by `sha256sum -c` on the runner; `SOURCE_COMMIT`
matched). The runner was started from stopped with no SSM command in progress. Under the owner's words "apply SQL 168 in production
ROUTE_NEW_CHECK_TO_SAME_MORTGAGE_AGENT" (passed verbatim to this run), on `i-0c35557c4e5385406` (root volume 39% used): one-shot
`--phase inspect` (SSM `22669a58-0fca-481e-9188-ee5bce9a81df`, Success, exit 0, steps pin, source, inspect and contracts ok, nothing
written) read live `a364af9a…` (`live_matches_expected` true, `already_applied` false, `precondition_failures` `[]`); the apply command
was sent only after that. Then `--phase apply` (SSM `6781f116-8801-4164-a110-80ccbcb8f437`, Success, exit 0, run
`14532473-eb26-43de-b552-be5def063452`, workstream `prod-sql168-desk-same-agent-20261116`, one_use_id
`sql168-prod-c1d1978f-d118-4880-a015-e43aa0743d52`): contracts 4/4, 6/6 and 43/43; all 11 steps ok; manifest `7c9931cb…`; receipt
`a364af9a…` → `6032655886f96d76f95434ded6d947284eb0bf6e7cfa7aab11c4b21d1fd41166` (intended), result `applied`, unrelated catalog
`9cf20519…`; post-apply inspect `already_applied` true, `precondition_failures` `[]`, `aws_mortgage_desk_route_same_agent(uuid, text)`
and `aws_mortgage_desk_route_same_agent_trigger()` `intended`, triggers `loss_draft_tracking aws_loss_draft_route_same_agent` and
`check_intake_items aws_check_claim_route_same_agent` `intended`. The run's whole output arrived (25520 bytes, sha256
`aa91232b09b8787e979937c593fecdbd654dbd25952a3701db705019adc4f894`; read back in compact form and re-serialized to that same size and
sha256; the copy on the runner was removed afterwards). A process check after the apply found no one-shot running and the runner was
stopped afterwards. Recorded in the pin's `applied` and `production_evidence`; `execute` is false again; the production overlay plan
records SQL 168 live (`sql_prerequisites`), so `db-readonly-validate.mjs` is no longer held by it. Production acceptance had not been
reported by the owner when this record was written; this record does not claim it. The production `/db-readonly-validate` now sees 192
public triggers against the 190 its deployed validator expects, and reports unhealthy until the `db-readonly-validate.mjs` production
REPLACE (owner's words "DEPLOY db-readonly-validate.mjs TO PRODUCTION"); that REPLACE is not part of this record.

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec `sql168` in
`release-sql-specs.mjs`). Intended `6032655886f96d76f95434ded6d947284eb0bf6e7cfa7aab11c4b21d1fd41166`:

```
release sql168 v1
function public.aws_mortgage_desk_route_same_agent(uuid, text): lang=plpgsql vol=v parallel=u secdef=true result=uuid config=row_security=on;search_path=public, pg_temp prosrc=ed48550667547efc48bb81a2c87d347cf33bd2e58ff001e2a2196279aafc4b82 acl=owner EXECUTE
function public.aws_mortgage_desk_route_same_agent_trigger(): lang=plpgsql vol=v parallel=u secdef=true result=trigger config=row_security=on;search_path=public, pg_temp prosrc=e38f3c2c99fbbb90fc2d2297f57b29e135ee5e78e5c8758e416f959488a6a713 acl=owner EXECUTE
trigger public.loss_draft_tracking aws_loss_draft_route_same_agent: enabled=O def=3769e9227a22fb610c63abb8c589b9ead1a0306ce5e38b8255ce7b79e0e8b288
trigger public.check_intake_items aws_check_claim_route_same_agent: enabled=O def=e51b64d909084de0d479ee33def3fd71d44ab3437fde3314a65662dfa27d0165
```

**Expected pre-state (both environments).** The two functions and the two triggers absent:

```
release sql168 v1
function public.aws_mortgage_desk_route_same_agent(uuid, text): absent
function public.aws_mortgage_desk_route_same_agent_trigger(): absent
trigger public.loss_draft_tracking aws_loss_draft_route_same_agent: absent
trigger public.check_intake_items aws_check_claim_route_same_agent: absent
```

That is `a364af9a300c5e617db353e67e3f37a18691a27f10d9349d506471067a31ef33` (`releaseStateHash('sql168', {})`). Each pin records its own environment's read; neither value is written
into a pin before a run reads it. A pre-state other than this one is a stop.

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present` (the seven relations, `has_role(uuid, public.app_role)` and every column the file reads or
copies or posts, `homeowner_ssn_last_four`, the typed claim fields, `check_messages` and `profiles.full_name` among them); `function_acl_replaceable`,
`functions_owned_by_login` and `function_results_match` (where present); `altered_relations_owned_by_login` on
`loss_draft_tracking` and `check_intake_items` (the triggers' tables); `definer_can_write_relations` on
`check_intake_items`, `loss_draft_tracking`, `mortgage_handling_requests`, `mortgage_ops_request_audit`,
`mortgage_agent_accounts`, `check_messages` and `profiles` (the DEFINER functions must reach them as their owner).

Post-conditions: the intended fingerprint; everything else in schema `public` unchanged. The tools roll back otherwise.

## Steps

Each step is its own reviewed PR or run and waits for the owner's words for that step.

1. Staging: the staging executor must carry SQL 168 first (executor package refresh through the guarded staging executor
   `deploy` mode, its own reviewed run). Then `read-live` for `sql168-mortgage-desk-same-agent-new-check`. Expected
   `already_applied` false, `precondition_failures` `[]`, `prerequisites_missing` `[]`, live `a364af9a…`. Otherwise stop.
   Record `LIVE_DEFINITION_SHA256` in the staging pin (`expected_live_definition_sha256`, owner-approved `authorization`,
   `execute: true`, wave 60) in a reviewed change, `apply`, then `read-live` again.
2. Production: with the owner's OK for that read, the read-only inspect on the runner
   (`node scripts/deployment-guard/production-sql-one-shot.mjs --migration sql168 … --phase inspect`); record
   `production_inspect`, copy `live_definition_sha256` into `expected_live_definition_sha256`, record the staging runs in
   `staging_acceptance`, set an owner-approved `authorization` and `execute: true`, in one reviewed change.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs --migration sql168
   --approval-scope sql168 … --phase apply` with the owner's words (authorization phrase
   `ROUTE_NEW_CHECK_TO_SAME_MORTGAGE_AGENT`).
4. Record the apply and retire the pin (`execute: false`).
5. Then the db-readonly-validate justified triggers and expected count for the two new triggers, its own change.

Rollback (not part of this pin; a reviewed step of its own if ever needed): drop the two triggers, then the two
functions. Requests already routed stay as they are.
