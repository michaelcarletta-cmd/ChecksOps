# Production SQL 167 (correct a linked check's claim number so the check joins the existing claim)

| key | file | what it does |
|---|---|---|
| `sql167` | `aws/workflows/sql/167_claim_ledger_relink_check.sql` (sha256 `72bd9ae6a3d336b049d6e7d11ae28da061bf052a5516912ac690a2276b288c6d`, authored by `254932308`) | Refuses without its prerequisites (`55000 sql167_prerequisite_missing`) or unless the applying login can reach `check_intake_items`, `claims`, `loss_draft_tracking`, `signature_requests`, `check_audit_log` and `claim_settlements` past RLS (`55000 sql167_definer_cannot_reach`); then one new SECURITY DEFINER function, EXECUTE `checksops` and the owner only. |

**Why.** A check is linked to a claim (`check_intake_items.claim_id`) only while the link is empty: SQL 41's OCR
persist and auto-link triggers, SQL 43's Review save and SQL 44's `claim_ledger_link_or_create` ("Already-linked
checks return the existing claim and never relink or create"; it updates only `WHERE claim_id IS NULL`), and SQL 89
removed the API's column UPDATE on `check_intake_items.claim_id`. So once a check is linked under a wrong claim
number, correcting the number renames that claim, and the check never reaches the existing claim the corrected number
names. Owner 2026-11-14: "Need to be able to change/correct claim number once edited for ledger to link to existing
claim." Decisions: correctable only before deposit (SQL 43's lock rule); when the check moves, its loss draft file
(`loss_draft_tracking.claim_id`) and its signature requests move to the new claim too; a corrected number that
matches no claim keeps today's behaviour (rename), which is not this function.

**What it does.**
- `claim_ledger_relink_check(p_check_id uuid, p_tenant_id uuid, p_claim_number text, p_action text, p_actor_id uuid)`
  (plpgsql, VOLATILE, RETURNS jsonb with `ok`, `persisted` and `code`, as SQL 44), `p_action` `inspect` or `relink`:
  - arguments: `invalid_args`, `invalid_action`; `relink` needs `p_actor_id` (`actor_required`);
  - locks the check (`FOR UPDATE`); `check_not_found`; `tenant_mismatch`; `locked` when `deposited_at` is set or
    `check_stage` is `deposited`, `voided` or `returned` (SQL 43's rule, word for word); `not_linked` when the check
    has no claim yet (SQL 44's `link_or_create` handles that, unchanged);
  - the target claim by SQL 44's same-tenant match, copied exactly: `ocr_claim_number_key` (SQL 41: `lower(btrim())`)
    of `claims.claim_number`; a claim of the tenant (`org_id`), or a legacy claim with no `org_id` that one of the
    tenant's checks links and no other tenant's check links. Several such claims, or a legacy claim linked from this
    tenant and another, is `ambiguous`; a claim only another tenant owns or links is `cross_tenant`; none is
    `no_match` (the caller renames as today). It never creates, renames or deletes a claim;
  - the target is the check's current claim: `unchanged`, nothing written;
  - `inspect` (`relink_available`): the target claim (id, number, policyholder name), the current claim (id, number),
    `old_claim_other_check_count` (the tenant's other checks on it), `old_claim_has_settlements`
    (`claim_settlements` rows), `loss_draft_rows_to_move` and `signature_request_rows_to_move`. Writes nothing;
  - `relink` (`relinked`): `UPDATE check_intake_items SET claim_id = target WHERE id = p_check_id AND tenant_id =
    p_tenant_id AND claim_id = <the claim it read> AND <not deposited>`; this check's `loss_draft_tracking` and
    `signature_requests` rows (`check_intake_item_id = p_check_id`) still on the old claim move to the target; one
    `check_audit_log` row (`check_id`, `tenant_id`, `actor_id`, `event_type` `claim_relinked`, `event_description`,
    `event_data` with the previous and new claim and the rows moved). Returns `old_claim_remaining_check_count`. It
    never touches another check, another check's rows, a claim-only signature request, `claim_settlements`, payouts
    or either `claims` row.

Triggers that fire on those writes (not changed here; covered by the PostgreSQL test): on `check_intake_items`,
`assign_case_on_check_intake` (BEFORE INSERT OR UPDATE OF `claim_id`, `freedom_claim_id`, `tenant_id`;
`tg_check_intake_assign_case`, SQL 87) and SQL 41's auto-link triggers act only when `case_id` / `claim_id` is NULL,
so the check keeps its `case_id`; on `loss_draft_tracking` and `signature_requests` the case triggers
(`tg_loss_draft_assign_case`, SQL 87; `tg_claim_id_assign_case`, SQL 88) likewise act only on a NULL `case_id`.
`trg_sync_check_claim_ledger` (`supabase/migrations/20260918170100`, marked unapplied) is defined by no file under
`aws/` and is not in the live trigger inventory `aws/db-copy/analysis/triggers_classified.json`.

Not changed: no existing function is replaced (SQL 41, SQL 43 and SQL 44 keep their bodies and ACLs); no table,
column, policy, table grant, trigger or row. The db-readonly-validate trigger count is not affected. No API, Lambda or
SPA change is part of this pin: the API (`claim_ledger_relink_check` in the RPC route) and the Review screen ship
afterwards through their own guarded paths.

**Status:** staging pin execute-authorized (wave 59); not applied anywhere. The production pin is pending.

**Staging read-live (2026-11-14).** Run 43623494491 (main `3239508c`, after executor inspect run 43622613027 and executor deploy
run 43622915623 (executor CodeSha256 `BGu9krtX…` -> `4gH9sgaz…`)), under the owner's words "apply SQL 166 and SQL 167 in
staging": `already_applied` false, `precondition_failures` `[]`, `prerequisites_missing` `[]`; the function absent. Live
`45b7f3a90b7613a53af9e72b569d59f16cdb0de40119ecd6fbe6f2213ea19343`, equal to the derived pre-state; intended `3aebf662…`. Recorded in the staging pin
(`expected_live_definition_sha256`, `execute: true`, wave 59). The staging apply is a separate run after this pin is merged and
the executor is redeployed carrying it, on the owner's words for that run. The production pin stays pending.

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec `sql167` in
`release-sql-specs.mjs`). Intended `3aebf66213d324256f0a93f91aadd829adca0e1b258c96f91ee68a2d1147635c`:

```
release sql167 v1
function public.claim_ledger_relink_check(uuid, uuid, text, text, uuid): lang=plpgsql vol=v parallel=u secdef=true result=jsonb config=row_security=off;search_path=public prosrc=928e5a5cd2cd91bd4416a16012186117fd3491e32cfdad90d471e7de021af702 acl=checksops EXECUTE;owner EXECUTE
```

**Expected pre-state (both environments).** The function absent:

```
release sql167 v1
function public.claim_ledger_relink_check(uuid, uuid, text, text, uuid): absent
```

That is `45b7f3a90b7613a53af9e72b569d59f16cdb0de40119ecd6fbe6f2213ea19343` (`releaseStateHash('sql167', {})`). Each pin records its own environment's read; neither value is written
into a pin before a run reads it. A pre-state other than this one is a stop.

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present` (SQL 41's `ocr_claim_number_key(text)` among them); `function_acl_replaceable`,
`functions_owned_by_login` and `function_results_match` (where present); `definer_can_write_relations` on
`check_intake_items`, `claims`, `loss_draft_tracking`, `signature_requests`, `check_audit_log` and `claim_settlements`
(the DEFINER function runs with `row_security = off` and must reach them as their owner).

Post-conditions: the intended fingerprint; everything else in schema `public` unchanged. The tools roll back otherwise.

## Steps

Each step is its own reviewed PR or run and waits for the owner's words for that step.

1. Staging: the staging executor must carry SQL 167 first (executor package refresh through the guarded staging executor
   `deploy` mode, its own reviewed run). Then `read-live` for `sql167-claim-ledger-relink-check`. Expected
   `already_applied` false, `precondition_failures` `[]`, `prerequisites_missing` `[]`, live `45b7f3a9…`. Otherwise stop.
   Record `LIVE_DEFINITION_SHA256` in the staging pin (`expected_live_definition_sha256`, owner-approved `authorization`,
   `execute: true`, wave 59) in a reviewed change, `apply`, then `read-live` again.
2. Production: with the owner's OK for that read, the read-only inspect on the runner
   (`node scripts/deployment-guard/production-sql-one-shot.mjs --migration sql167 … --phase inspect`); record
   `production_inspect`, copy `live_definition_sha256` into `expected_live_definition_sha256`, record the staging runs in
   `staging_acceptance`, set an owner-approved `authorization` and `execute: true`, in one reviewed change.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs --migration sql167
   --approval-scope sql167 … --phase apply` with the owner's words (authorization phrase
   `RELINK_CHECK_TO_CORRECTED_EXISTING_CLAIM`).
4. Record the apply and retire the pin (`execute: false`).
5. Then the API (the RPC route: `inspect` first, `relink` on the user's confirmation, the rename path on `no_match`)
   and the Review screen through the guarded Lambda overlay and SPA paths, each with its own approval.

Rollback (not part of this pin; a reviewed step of its own if ever needed): drop the function.
