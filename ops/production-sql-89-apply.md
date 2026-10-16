# Production SQL 89 (check_intake_items column-level UPDATE for checksops)

Applies only `aws/workflows/sql/89_check_intake_items_column_update.sql`:

```sql
REVOKE UPDATE ON TABLE public.check_intake_items FROM checksops;
REVOKE UPDATE ON TABLE public.check_intake_items FROM authenticated;
REVOKE UPDATE ON TABLE public.check_intake_items FROM PUBLIC;
GRANT UPDATE (<the 43 columns below>) ON TABLE public.check_intake_items TO checksops;
```

**Inherited UPDATE (staging apply run 85).** `checksops` is a member of `authenticated`
(`aws/rls/sql/01_role_shim.sql:16`, `GRANT authenticated TO checksops`), so
`has_column_privilege('checksops', …, 'UPDATE')` also counts UPDATE granted to
`authenticated` and to PUBLIC (for example SQL 40 grants `UPDATE (deposit_recommendation)
TO checksops, authenticated`). The first version of the file revoked only checksops' own
UPDATE; staging apply run 85 then correctly rolled back with `UNRELATED_MUTATION`
(`intended_state`, `updatable_columns_exact`): `detected_claim_number` (and possibly
others) stayed updatable through an inherited grant recorded nowhere in the repo. The file
now also revokes UPDATE from `authenticated` and PUBLIC (a table-level REVOKE also removes
that grantee's column UPDATE grants). SELECT, INSERT and DELETE are not touched for any
role. The fingerprint (checksops' effective UPDATE) did not change, so the staging pin's
pre-state `6810985b…` (read-live run 82) still stands.

**Why.** The read-only production inspect of 2026-10-16 (SSM
`f3715bb0-5fd9-43a8-83e9-86350ef5bab7`, main `358ef188`) found the API role `checksops`
with **table-level** UPDATE on `public.check_intake_items`: ACL
`{checksops_admin=arwdDxtm/checksops_admin,checksops=arwd/checksops_admin}`, owner
`checksops_admin`, all 73 columns updatable, `id`, `tenant_id`, `created_at`,
`uploaded_by` and `deposited_by_tenant_id` included. Staging has column grants instead.
SQL 89 (owner-approved "option 3") leaves UPDATE on exactly the columns the API writes.
SELECT, INSERT and DELETE are not touched; no data changes. Afterwards SQL 71's state
(amount updatable, no table-level UPDATE) holds in production, so SQL 71 itself is not
applied there (its tool refuses on `no_table_level_update`).

**Status:** tooling only. The pin
`ops/deployment-guard/sql89-check-intake-column-update-production-apply.json` is
`authorization: "pending"`, `execute: false`, `expected_live_definition_sha256: null`,
`staging_acceptance.ok: false`. It authorizes nothing. The staging executor pin
(`sql89-check-intake-column-update`) records the staging pre-state `6810985b…` from
read-live run 82; a fresh staging read-live with this executor version should be reviewed
(provenance and the new preconditions) before another staging apply.

Tool: `scripts/deployment-guard/sql89-check-intake-column-update-production-apply.mjs`.
Registered in the one-shot as `--migration sql89` (`ops/production-sql-one-shot.md`).

## The column set

How it was derived (re-checked by `aws/tests/sql89-check-intake-column-update-production-apply.test.mjs`):

1. **Every UPDATE the API issues as checksops.** The API has one database login
   (`checksops`, `db-health.mjs` refuses `checksops_admin`) and never `SET ROLE`. Every
   template literal in `aws/functions/api/**` that UPDATEs the table was read: 26 static
   statements (their SET targets) and two built at runtime:
   - `write-check-workflow.mjs:414` (generic `/data/write`): `intakeCoerce` output plus
     `updated_at = now()` (`buildSet`); the columns are limited to
     `WRITE_ALLOWLIST.check_intake_items.columns` (`write-allowlist.mjs:126`).
   - `ingest-shared-check.mjs:345`: the inline fallback, used only when
     `public.aws_ingest_shared_check(jsonb)` (SQL 70) is missing (error 42883). It writes
     `detected_claim_number`, `payment_classification`, `freedom_claim_id`,
     `freedom_claim_number`, `partner_status`, `partner_status_label`,
     `partner_status_updated_at`, which SQL 89 does **not** grant. SQL 70's SECURITY
     DEFINER function is therefore a prerequisite (`sql70_ingest_function_security_definer`).
   - No INSERT on the table uses `ON CONFLICT … DO UPDATE`. `SELECT … FOR UPDATE`
     (`admin-override-check-status.mjs:90`, `workflow-rpc.mjs:1213`) needs UPDATE on at
     least one column, which SQL 89 keeps. WHERE / RETURNING reads use table-level SELECT,
     which is unchanged.
2. **SQL functions and triggers.** All 61 `CREATE FUNCTION` bodies in
   `supabase/migrations`, `aws/write-path/sql`, `aws/rls/sql` and `aws/workflows/sql` that
   UPDATE the table (16 functions: `admin_override_check_status`,
   `review_save_detected_claim_number` (SQL 43), `claim_ledger_link_or_create` (SQL 44),
   `aws_ingest_shared_check` (SQL 70), `ocr_commit_results`, `ocr_persist_detected_claim_number`,
   `deposit_action`, `loss_draft_action`, `record_check_return`, `resolve_check_return`,
   `submit_check_review_decision`, `recompute_check_release_stage`, `lock_stage_on_deposit`,
   `create_endorsements_from_payees`, `apply_check_contact_carryover`,
   `advance_check_on_endorsement_complete`) are SECURITY DEFINER: they run as their owner
   and need no checksops grant. BEFORE-trigger assignments to NEW need no column privilege.
   The live check is the inspect's `update_functions` / `unsafe_update_functions`
   (refuses a SECURITY INVOKER one, or a DEFINER one whose owner is not a superuser or the
   table owner and inherits checksops' privileges).
3. **Live production bytes.** Production's Lambda does not run main's bytes for every
   member. The test also reads the 2026-10-11 production snapshot (`f78e16d99`, every
   `aws/functions/api` file) and every member of
   `ops/deployment-guard/production-api-overlay-plan.json` at its `expected_live_sha256`
   (live, e.g. `write-allowlist.mjs` 0fdc95bd, `write-check-workflow.mjs` d9a9ce68,
   `workflow.mjs` bd18db71, `workflow-rpc.mjs` 9a630bdb) and `accepted_sha256` (planned
   overlay) bytes, located in git history by sha256 (all found), and runs their UPDATE
   statements as checksops after SQL 89 on PostgreSQL 16. Live production writes 42 of the
   43 columns; **no column is written only by live production**. `amount` is written only
   by main (live `write-check-workflow.mjs` d9a9ce68 drops it; it arrives with the planned
   `write-allowlist.mjs` / `write-check-workflow.mjs` overlay, which waits for this state).
4. **Staging.** Staging's repo-recorded checksops grants on the table are SQL 33 (11
   columns), SQL 35 (3), SQL 40 (1), SQL 50 (11), SQL 52 (2), SQL 71 (1) and the
   2026-09-16 endorsement lock (1): 28 columns, all in SQL 89's set (no column staging
   grants that the code never writes). 15 columns the code writes have **no staging grant
   in the repo** (marked below): `back_image_deposit_path`, `endorsement_override`,
   `endorsement_packet_path`, `endorsement_render_meta`, `endorsement_render_status`,
   `ocr_status`, `pre_return_stage`, `return_code`, `return_notes`, `return_reason`,
   `return_recorded_by`, `return_resolution`, `return_resolved_at`, `return_source`,
   `returned_at`. Either staging holds grants recorded nowhere in the repo, or those
   staging writes fail with 42501 today. The staging read-live of SQL 71 (run
   `38903724634`) does not show the column list: its read-live summary carries only
   `amount_update_granted` and `table_level_update`. The SQL 89 staging read-live reports
   `column_grant_inspect.updatable_columns`, `columns_to_grant` and `columns_losing_update`,
   which settles it.

Not granted (written by no API path as checksops): every other column, among them `id`,
`tenant_id`, `created_at`, `uploaded_by`, `deposited_by_tenant_id`, `deposited_at`,
`claim_id`, `detected_claim_number`, `raw_ocr_*`, `partner_status*`, `freedom_claim_*`.
Identity-like columns the code does write: `reviewed_by` (`workflow.mjs:519`, the
reviewer's application user id) and `return_recorded_by` (`workflow-rpc.mjs:866`).

Main line numbers are at this branch; live line numbers at `f78e16d99` unless a member
hash is named. "+n" means more sites.

| # | column | written by | main (file:line) | live production (f78e16d99 / expected_live bytes) | staging grant in repo |
|---|---|---|---|---|---|
| 1 | `account_number` | both | ocr.mjs:424; write-check-workflow.mjs:414 (generic, intakeCoerce) | ocr.mjs:426 | SQL 52 |
| 2 | `amount` | main only | write-check-workflow.mjs:414 (generic, intakeCoerce) | — | SQL 71 |
| 3 | `back_image_deposit_path` | both | endorsement-composite.mjs:543; endorsement-composite.mjs:716; endorsement-material-invalidation.mjs:259; +2 | write-check-workflow.mjs:376 (generic, live d9a9ce68); endorsement-composite.mjs:731; endorsement-composite.mjs:917; +3 | **none in repo** |
| 4 | `back_image_original_path` | both | endorsement-composite.mjs:543; endorsement-composite.mjs:716; write-check-workflow.mjs:414 (generic, intakeCoerce) | write-check-workflow.mjs:376 (generic, live d9a9ce68); endorsement-composite.mjs:731; endorsement-composite.mjs:917 | SQL 35 |
| 5 | `back_image_path` | both | endorsement-composite.mjs:543; endorsement-composite.mjs:716; write-check-workflow.mjs:414 (generic, intakeCoerce) | write-check-workflow.mjs:376 (generic, live d9a9ce68); endorsement-composite.mjs:731; endorsement-composite.mjs:917 | SQL 35 |
| 6 | `carrier_name` | both | ocr-descriptive-persist.mjs:146; ocr.mjs:375; write-check-workflow.mjs:414 (generic, intakeCoerce) | write-check-workflow.mjs:376 (generic, live d9a9ce68); ocr-descriptive-persist.mjs:198; ocr.mjs:377 | SQL 33 |
| 7 | `check_number` | both | ocr.mjs:375; write-check-workflow.mjs:414 (generic, intakeCoerce) | write-check-workflow.mjs:376 (generic, live d9a9ce68); ocr.mjs:377 | SQL 33 |
| 8 | `check_stage` | both | admin-override-check-status.mjs:116; check-endorsement.mjs:377; check-endorsement.mjs:403; +6 | check-endorsement.mjs:454; check-endorsement.mjs:482; workflow-rpc.mjs:480; +10 | SQL 50 |
| 9 | `deposit_recommendation` | both | admin-override-check-status.mjs:116; check-endorsement.mjs:403 | check-endorsement.mjs:482 | SQL 40 |
| 10 | `endorsement_override` | both | write-check-workflow.mjs:414 (generic, intakeCoerce) | write-check-workflow.mjs:376 (generic, live d9a9ce68) | **none in repo** |
| 11 | `endorsement_packet_path` | both | documents.mjs:259 | documents.mjs:429 | **none in repo** |
| 12 | `endorsement_render_meta` | both | endorsement-composite.mjs:543; endorsement-composite.mjs:716; endorsement-material-invalidation.mjs:259; +3 | write-check-workflow.mjs:376 (generic, live d9a9ce68); endorsement-composite.mjs:731; endorsement-composite.mjs:917; +4 | **none in repo** |
| 13 | `endorsement_render_status` | both | documents.mjs:259; endorsement-composite.mjs:543; endorsement-composite.mjs:716; +3 | write-check-workflow.mjs:376 (generic, live d9a9ce68); documents.mjs:429; endorsement-composite.mjs:731; +4 | **none in repo** |
| 14 | `endorsement_render_version` | both | endorsement-composite.mjs:543; endorsement-composite.mjs:716; endorsement-material-invalidation.mjs:259 | endorsement-composite.mjs:731; endorsement-composite.mjs:917; endorsement-material-invalidation.mjs:259 | SQL 2026-09-16 lock |
| 15 | `expiration_days` | both | write-check-workflow.mjs:414 (generic, intakeCoerce) | write-check-workflow.mjs:376 (generic, live d9a9ce68) | SQL 33 |
| 16 | `front_image_path` | both | write-check-workflow.mjs:414 (generic, intakeCoerce) | write-check-workflow.mjs:376 (generic, live d9a9ce68) | SQL 35 |
| 17 | `funds_type` | both | write-check-workflow.mjs:414 (generic, intakeCoerce) | write-check-workflow.mjs:376 (generic, live d9a9ce68) | SQL 33 |
| 18 | `is_multi_payee` | both | ocr-descriptive-persist.mjs:186; write-check-workflow.mjs:414 (generic, intakeCoerce) | write-check-workflow.mjs:376 (generic, live d9a9ce68); ocr-descriptive-persist.mjs:241 | SQL 33 |
| 19 | `issue_date` | both | ocr-descriptive-persist.mjs:136; write-check-workflow.mjs:414 (generic, intakeCoerce) | write-check-workflow.mjs:376 (generic, live d9a9ce68); ocr-descriptive-persist.mjs:188 | SQL 33 |
| 20 | `mortgage_monitoring_type` | both | write-check-workflow.mjs:414 (generic, intakeCoerce) | write-check-workflow.mjs:376 (generic, live d9a9ce68) | SQL 50 |
| 21 | `mortgage_received_at` | both | write-check-workflow.mjs:414 (generic, intakeCoerce) | write-check-workflow.mjs:376 (generic, live d9a9ce68) | SQL 50 |
| 22 | `mortgage_sent_at` | both | write-check-workflow.mjs:414 (generic, intakeCoerce) | write-check-workflow.mjs:376 (generic, live d9a9ce68) | SQL 50 |
| 23 | `mortgage_tracking_number` | both | write-check-workflow.mjs:414 (generic, intakeCoerce) | write-check-workflow.mjs:376 (generic, live d9a9ce68) | SQL 50 |
| 24 | `ocr_needs_verification` | both | workflow.mjs:519 | workflow.mjs:512; workflow.mjs:512 (live bd18db71) | SQL 50 |
| 25 | `ocr_status` | both | ocr.mjs:237; ocr.mjs:307 | ocr.mjs:238; ocr.mjs:308 | **none in repo** |
| 26 | `payee_address` | both | write-check-workflow.mjs:414 (generic, intakeCoerce) | write-check-workflow.mjs:376 (generic, live d9a9ce68) | SQL 33 |
| 27 | `payee_line` | both | ocr-descriptive-persist.mjs:146; ocr.mjs:375; write-check-workflow.mjs:414 (generic, intakeCoerce) | write-check-workflow.mjs:376 (generic, live d9a9ce68); ocr-descriptive-persist.mjs:198; ocr.mjs:377 | SQL 33 |
| 28 | `pre_return_stage` | both | workflow-rpc.mjs:866 | workflow-rpc.mjs:827; workflow-rpc.mjs:833 (live 9a630bdb) | **none in repo** |
| 29 | `property_address` | both | write-check-workflow.mjs:414 (generic, intakeCoerce) | write-check-workflow.mjs:376 (generic, live d9a9ce68) | SQL 33 |
| 30 | `return_code` | both | workflow-rpc.mjs:866 | workflow-rpc.mjs:827; workflow-rpc.mjs:833 (live 9a630bdb) | **none in repo** |
| 31 | `return_notes` | both | workflow-rpc.mjs:866 | workflow-rpc.mjs:827; workflow-rpc.mjs:833 (live 9a630bdb) | **none in repo** |
| 32 | `return_reason` | both | workflow-rpc.mjs:866 | workflow-rpc.mjs:827; workflow-rpc.mjs:833 (live 9a630bdb) | **none in repo** |
| 33 | `return_recorded_by` | both | workflow-rpc.mjs:866 | workflow-rpc.mjs:827; workflow-rpc.mjs:833 (live 9a630bdb) | **none in repo** |
| 34 | `return_resolution` | both | workflow-rpc.mjs:866; workflow-rpc.mjs:1019; workflow-rpc.mjs:1030 | workflow-rpc.mjs:827; workflow-rpc.mjs:958; workflow-rpc.mjs:969; +3 | **none in repo** |
| 35 | `return_resolved_at` | both | workflow-rpc.mjs:866; workflow-rpc.mjs:1019; workflow-rpc.mjs:1030 | workflow-rpc.mjs:827; workflow-rpc.mjs:958; workflow-rpc.mjs:969; +3 | **none in repo** |
| 36 | `return_source` | both | workflow-rpc.mjs:866 | workflow-rpc.mjs:827; workflow-rpc.mjs:833 (live 9a630bdb) | **none in repo** |
| 37 | `returned_at` | both | workflow-rpc.mjs:866 | workflow-rpc.mjs:827; workflow-rpc.mjs:833 (live 9a630bdb) | **none in repo** |
| 38 | `review_notes` | both | workflow.mjs:519; write-check-workflow.mjs:414 (generic, intakeCoerce) | write-check-workflow.mjs:376 (generic, live d9a9ce68); workflow.mjs:512; workflow.mjs:512 (live bd18db71) | SQL 33, SQL 50 |
| 39 | `reviewed_at` | both | workflow.mjs:519 | workflow.mjs:512; workflow.mjs:512 (live bd18db71) | SQL 50 |
| 40 | `reviewed_by` | both | workflow.mjs:519 | workflow.mjs:512; workflow.mjs:512 (live bd18db71) | SQL 50 |
| 41 | `routing_number` | both | ocr.mjs:424; write-check-workflow.mjs:414 (generic, intakeCoerce) | ocr.mjs:426 | SQL 52 |
| 42 | `status` | both | admin-override-check-status.mjs:116; check-endorsement.mjs:287; check-endorsement.mjs:350; +8 | check-endorsement.mjs:354; check-endorsement.mjs:418; check-endorsement.mjs:482; +12 | SQL 50 |
| 43 | `updated_at` | both | admin-override-check-status.mjs:116; check-endorsement.mjs:287; check-endorsement.mjs:350; +23 | write-check-workflow.mjs:376 (generic, live d9a9ce68); check-endorsement.mjs:354; check-endorsement.mjs:418; +29 | SQL 33, SQL 50 |

## Fingerprint

The live hash is the staging executor's (`readSql89State`, shared through
`scripts/deployment-guard/lib/sql-executor-auth.mjs`): sha256 of `columnUpdateStateText`,
three lines: `checksops UPDATE ON public.check_intake_items`, `table_level_update: <bool>`
(by any route: direct, PUBLIC or membership) and `updatable_columns: <sorted list>` (by
any route).

| state | hash |
|---|---|
| post-state (`intended_replacement_sha256`, both environments): no table-level UPDATE, exactly the 43 columns | `2a1d45f9250083a605e9784aba628f6f87f52840010487974b29a94097a7e2f8` |
| production pre-state | recorded from the production inspect (table-level UPDATE, every column) |
| staging pre-state | recorded from the staging read-live |

File sha256: `d91ab6576a2bda45f2a9b0d21fc98241dd8ee20adc24bd34ecb68fc09f92c28a` (authored in
commit `70518bbd7`). The file may hold only comments and exactly the four statements
(`SQL89_CANONICAL_STATEMENTS`). The first version (`cadd01c1…`, commit `cc4449a0d`, two
statements) is superseded.

## Where it runs

Only on the SQL53 runner `i-0c35557c4e5385406` in `vpc-09f2268778966ce97`, from the
reviewed main source staged by `.github/workflows/sql53-temporary-transfer.yml`. Never from
GitHub-hosted runners or Lambda. Set
`AWS_ENDPOINT_URL_SECRETS_MANAGER=https://vpce-01649ea2cdb21a689-tp7fo1qj.secretsmanager.us-east-1.vpce.amazonaws.com`.
Credentials come only from the pinned `checksops_admin` secret (`admin_secret_arn`) and
the pinned `rds_host`; a password, URL, host or user flag is refused.

## Steps (each needs owner approval)

0. **Staging.** Deploy main's executor, then read-live with migration
   `sql89-check-intake-column-update`. Record its `live_definition_sha256` as the staging
   pin's `expected_live_definition_sha256` in a reviewed change, review
   `columns_to_grant` / `columns_losing_update`, apply in staging, verify `already_applied`
   and exercise the API, then record the staging acceptance here.
1. **Inspect (read-only):**

   ```bash
   AWS_ENDPOINT_URL_SECRETS_MANAGER=https://vpce-01649ea2cdb21a689-tp7fo1qj.secretsmanager.us-east-1.vpce.amazonaws.com \
     node scripts/deployment-guard/sql89-check-intake-column-update-production-apply.mjs --inspect
   ```

   `BEGIN READ ONLY … ROLLBACK`, catalog only (no table row, no PII). It reports
   `current_user` / `session_user`, `table_owner`, `table_acl`, `table_acl_entries`,
   `table_privileges`, `table_level_update`, `updatable_columns` (+ sha256),
   `column_update_entries`, `grantee_grant_option`, `grantee_update_grantors`,
   `login_can_grant`, `sql89_columns`, `sql89_columns_missing`, `columns_to_grant`,
   `columns_losing_update`, `update_functions`, `unsafe_update_functions`,
   `ingest_function_present` / `_security_definer`, `authenticated_role_present`,
   per-column UPDATE provenance (role names only): `update_grant_sources` (per grantee
   among checksops, PUBLIC and every role checksops uses the privileges of: table-level
   flag and columns), `update_provenance` (per column, for the 43 and every updatable
   column: the grantees its UPDATE comes from), `grantee_member_of`,
   `authenticated_members` (`role`, `can_login`), `other_login_authenticated_members`,
   `other_inherited_update_roles`, `revoked_role_update_entries`, `live_definition_sha256`,
   `already_applied`, `post_state`, `precondition_failures`, `apply_preconditions_met`.

   On the first run `precondition_failures` is `table_owner_as_inspected`,
   `table_acl_as_inspected`, `updatable_columns_as_inspected` (nothing recorded yet).
   Stop on anything else: `sql89_columns_present` (a listed column is missing),
   `sql70_ingest_function_security_definer` (SQL 70 not applied), `update_functions_safe`,
   `grantee_update_granted_by_login` (an UPDATE grant the REVOKE would not remove),
   `no_grantee_grant_option`, `authenticated_role_present` (the file names the role),
   `authenticated_has_no_other_login_members` (a LOGIN role other than checksops uses
   authenticated's privileges, directly or through a chain of INHERIT/SET memberships;
   it would lose UPDATE), `no_other_inherited_update` (a role checksops is a member of,
   other than authenticated, holds UPDATE on the table; SQL 89 would not revoke it),
   `inherited_update_granted_by_login` (an UPDATE of authenticated or PUBLIC granted by
   another role, which the REVOKE would not remove). An ADMIN-only membership (no INHERIT,
   no SET) confers no privileges and is not counted. Expect `columns_losing_update` = the 30 columns outside the
   list and `columns_to_grant` = `[]`.
2. **Record the pre-state** in a reviewed pin change: `live_definition_sha256` into
   `expected_live_definition_sha256`, and `table_owner`, `table_acl`, `updatable_columns`,
   `updatable_columns_sha256` into `production_inspect`. This does not authorize execution.
3. **Authorize** in a later reviewed pin change: the owner's approval in `authorization`,
   the staging acceptance reference and `execute: true`.
4. **Apply** through the one-shot with the owner's run-time approval for this workstream:
   `node scripts/deployment-guard/production-sql-one-shot.mjs --migration sql89 --approval-scope sql89 --phase inspect|apply …`.

   One transaction (`lock_timeout` 5s, advisory locks). Refuses when already applied
   (`UNRELATED_MUTATION`), on any failed precondition or drift (`DEPLOYMENT_COLLISION`),
   or a live hash that is not the pinned one. Then it runs only the pinned file and rolls
   back unless all of these hold:
   - no table-level UPDATE for checksops (directly, via PUBLIC or membership);
   - checksops can UPDATE exactly the 43 columns, each by a direct column grant
     `<column> checksops UPDATE granted by checksops_admin`, and through no other grantee
     (`update_only_from_grantee`);
   - authenticated and PUBLIC hold no UPDATE on the table, table or column
     (`authenticated_and_public_hold_no_update`);
   - SELECT, INSERT, DELETE (and TRUNCATE, REFERENCES, TRIGGER) unchanged for every role;
     every other table and column ACL entry and the owner unchanged (the table ACL becomes
     `checksops=ard/checksops_admin`);
   - everything else in schema public, and schema auth's functions, unchanged.

   If the COMMIT outcome is unknown, run step 1 before anything else.
5. **Verify:** re-run step 1: `already_applied` true, `live_definition_sha256` `2a1d45f9…`,
   `updatable_columns` = the 43, `table_level_update` false. Record the apply, set `execute`
   back to false, then record SQL 71 verified live in the overlay plan in its own reviewed change.

## Rollback

A separate owner-approved operation:
`GRANT UPDATE ON TABLE public.check_intake_items TO checksops;` restores table-level
UPDATE (the column grants then become redundant). UPDATE that authenticated or PUBLIC held
before is listed in the pre-apply inspect's `update_grant_sources`; restore it only by
re-granting exactly those columns. Do not run it without a reason: it re-opens identity
columns to the API role.
