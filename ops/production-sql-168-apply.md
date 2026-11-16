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

**Status:** tooling built; staging and production pins pending (`execute: false`). Nothing applied or read. Staging
wave 60 when approved (wave 59 is SQL 167, the highest on main).

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
