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

**Status:** applied in staging (wave 59, 2026-11-14, apply run 43628481801); staging acceptance: the staging apply under the owner's run approval ("apply SQL 166 and SQL 167 in staging"; no separate acceptance statement); applied to production (2026-11-14); the production pin is retired (`execute: false`).

**Staging read-live (2026-11-14).** Run 43623494491 (main `3239508c`, after executor inspect run 43622613027 and executor deploy
run 43622915623 (executor CodeSha256 `BGu9krtX…` -> `4gH9sgaz…`)), under the owner's words "apply SQL 166 and SQL 167 in
staging": `already_applied` false, `precondition_failures` `[]`, `prerequisites_missing` `[]`; the function absent. Live
`45b7f3a90b7613a53af9e72b569d59f16cdb0de40119ecd6fbe6f2213ea19343`, equal to the derived pre-state; intended `3aebf662…`. Recorded in the staging pin
(`expected_live_definition_sha256`, `execute: true`, wave 59). The staging apply is a separate run after this pin is merged and
the executor is redeployed carrying it, on the owner's words for that run. The production pin stays pending.

**Staging executor refreshed and staging apply (2026-11-14).** The staging pins for SQL 166 and SQL 167 (waves 58 and 59, PR
#1908, owner's words "merge #1908") merged as `84dd7e5492e911aee336282a6262888965fd6659`. Deploy run 43626936092 updated the staging guarded SQL executor
(CodeSha256 `4gH9sgaz…` -> `0KNPXGrb…`); a fresh read-live, run 43628253879, read `45b7f3a9…`. Apply run 43628481801 (main
`84dd7e5`) under the owner's words "apply SQL 166 and SQL 167 in staging": `before_hash` `45b7f3a90b7613a53af9e72b569d59f16cdb0de40119ecd6fbe6f2213ea19343`, `after_hash`
`3aebf66213d324256f0a93f91aadd829adca0e1b258c96f91ee68a2d1147635c` (the intended hash). Read-live run 43628751159: `already_applied` true. The owner gave the run
approval "apply SQL 166 and SQL 167 in staging"; no separate staging acceptance statement was given. There is no separate
staging record PR for SQL 167: these staging runs are recorded here and in the production pin's `staging_acceptance` by the
production pin PR.

**Production inspect (2026-11-14).** Read-only `--inspect` through SSM `6b4e6de5-3548-4477-927c-bcbda4a11391` on
`i-0c35557c4e5385406` (under the owner's words "run the SQL 166 and SQL 167 production inspect"; runner started from stopped
with no SSM command in progress, command 18:54:51Z to 18:55:02Z, AWS-RunShellScript, Success, runner stopped again afterwards,
all by `user/claude-code`; the same command ran SQL 166's `--inspect`, recorded in `ops/production-sql-166-apply.md`), main
`84dd7e549` (tarball sha256 `f7965818d5b9d95284f125c9fded2fde1c50f3702d24a036e03e5aac68767c03`, checked by `sha256sum -c` on the runner, `SOURCE_COMMIT` matched, staged by
`sql53-temporary-transfer.yml` run 43629060749; sha256 of the printed sql167 output, computed on the runner,
`0db0c0abc74b215e0d6c301a4262856ea021f5f6a63eaef90d4b39718952f7e5`, 2383 bytes), exit 0, `ok` true, `read_only` true, `current_user` `checksops_admin`,
`missing_dependencies` `[]`: live `45b7f3a90b7613a53af9e72b569d59f16cdb0de40119ecd6fbe6f2213ea19343` (the function absent: the derived pre-state, equal to staging's
before its apply), no predecessor, `prerequisites_missing` `[]`, `successors_applied` `[]`, `definer_writes` ok on
`check_intake_items`, `claims`, `loss_draft_tracking`, `signature_requests`, `check_audit_log` and `claim_settlements`,
`already_applied` false, `precondition_failures` `[]`, `apply_preconditions_met` false (no pre-state recorded yet).
Production's pre-state equals staging's (read-live runs 43623494491 and 43628253879), so the staging apply took the path
production will. Recorded in the production pin with the staging apply (run 43628481801) as its staging acceptance and
`execute: true` under the owner's "Yes" to "Shall I open the pin PR?". The owner merges the pin change; the apply runs only
after that merge is on main and staged, under the owner's words for that run (phrase
`RELINK_CHECK_TO_CORRECTED_EXISTING_CLAIM`).

Not covered by the inspect (not verified): the live-only trigger `touch_claim_on_signature` on `signature_requests`
(`public.touch_claim_updated_at`, AFTER INSERT, UPDATE or DELETE; listed in the live trigger inventory
`aws/db-copy/analysis/triggers_classified.json`, defined by no migration under `aws/`). It fires when the relink moves this
check's `signature_requests` rows and touches the `claims` row they point to. It matters only when a moved check's signature
requests point to a target claim with no `org_id`: SQL 155's claim owner stamp (`trg_aws_stamp_claim_org_id`, BEFORE INSERT
OR UPDATE on `claims`) keeps an existing `org_id` and acts only on an UPDATE of a claims row whose `org_id` is NULL. The
release inspect does not read triggers outside the spec, and the PostgreSQL test does not carry this trigger.

**Production apply (2026-11-14).** After the pin change (#1909, merged to main as `d8da56bac`), transfer run 43632903546
(`sql53-temporary-transfer.yml`) staged main `d8da56bac` (tarball sha256
`b2d3cadcfea1a2c9681de708d4546f5bc3e7506a72395b3c1f3516617c149774`, checked by `sha256sum -c` on the runner; `SOURCE_COMMIT`
matched). Three AWS-managed SSM commands were listed InProgress on the stopped runner, queued at 18:55Z during the
production inspect `6b4e6de5`: `d1da09c7` AmazonInspector2-ConfigureInspectorSsmPlugin (Success), `007bb4e8` AWS-ConfigureAWSPackage (Success), `36b774e3` AmazonInspector2-ConfigureInspectorSsmPluginLinux (Failed); on the owner's words "Let them finish first" the runner was started and no SQL
command was sent until nothing was in progress (60 s). Under the owner's words "apply SQL 166 and SQL 167 in production" (passed verbatim to
this run and to SQL 166's, in the same runner session), on `i-0c35557c4e5385406` (root volume 39% used): one-shot `--phase inspect`
(SSM `fe8d233a-0624-464e-adb7-c3165e8c1e3f`, Success, exit 0, steps pin, source, inspect and contracts ok, nothing written) read live
`45b7f3a9…` (`live_matches_expected` true, `already_applied` false, `precondition_failures` `[]`); the apply command
was sent only after that. Then `--phase apply` (SSM `83892c35-edaf-404f-b9cd-d14cecf50a55`, Success, exit 0, run
`f2e0b482-129c-44fa-9597-b0cdc404d9b3`, workstream `prod-sql167-claim-ledger-relink-20261114`, one_use_id
`sql167-prod-a0a99ec5-74aa-472f-ad05-d8922b4d240e`): contracts 4/4, 6/6 and 43/43; all 11 steps ok; manifest
`310a2adc…`; receipt `45b7f3a9…` → `3aebf66213d324256f0a93f91aadd829adca0e1b258c96f91ee68a2d1147635c` (intended), result `applied`,
unrelated catalog `8c5639f5…`; post-apply inspect `already_applied` true, `precondition_failures` `[]`,
`claim_ledger_relink_check(uuid, uuid, text, text, uuid)` `intended` with EXECUTE `[checksops EXECUTE, owner EXECUTE]`. The run's whole output arrived (21654 bytes, sha256
`0e7c11dc570cd76979df901e8716b95159397fcad7298f3ce0d572998dce217a`; read back in compact form and re-serialized to that same size and
sha256; the copy on the runner was removed afterwards). A process check after each apply found no one-shot running and the runner
was stopped afterwards. Recorded in the pin's `applied` and `production_evidence`; `execute` is false again. Production
acceptance (a check relinked to a corrected existing claim) had not been reported by the owner when this record was written; this record does not claim it.

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
