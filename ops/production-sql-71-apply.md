# Production SQL 71 (Review amount column grant)

Applies only `aws/workflows/sql/71_review_amount_column_grant.sql` (from PR #901):

```sql
GRANT UPDATE (amount) ON TABLE public.check_intake_items TO checksops;
```

With it, the API can correct a check's amount while the check is in Review. The API
changes `amount` only when the status is `uploaded`, `needs_review`, `ocr_complete` or
`manual_review_required`, in the same UPDATE (`write-check-workflow.mjs`).
`routing_number` and `account_number` were granted by SQL 52
(`52_verified_ocr_micr_column_grant.sql`). SQL 52 is a prerequisite: the tool refuses
the apply when either column is missing or not granted.

**Status:** tooling only. The owner approved building it on 2026-10-16 ("start steps
1-3"). The pin `ops/deployment-guard/sql71-review-amount-production-apply.json` is
`authorization: "pending"`, `execute: false`, `expected_live_definition_sha256: null`,
`staging_acceptance.ok: false`. It authorizes nothing.

**Staging is already applied.** The guarded staging SQL executor's read-live run 71
(`38903724634`) on main `b83e5cc33` reported `already_applied` true,
`amount_update_granted` true, `table_level_update` false, and live `ff8e86f9…`.

Tool: `scripts/deployment-guard/sql71-review-amount-production-apply.mjs`.
Registered in the one-shot as `--migration sql71` (`ops/production-sql-one-shot.md`).

## Fingerprint

The live hash is the staging executor's (`handleSql71AmountGrant`). It is the sha256 of
`AMOUNT_GRANT_STATE_TEXT.absent` or `.granted`, chosen by
`has_column_privilege('checksops', 'public.check_intake_items', 'amount', 'UPDATE')`:

| state | hash |
|---|---|
| amount absent (pre-state, the same in staging) | `2d96f50bae23aac3c9893656a4e68eccb1f1c298d5c1085753dd1472e1a3df2a` |
| amount granted (post-state, `intended_replacement_sha256`) | `ff8e86f95a78474068f6b083087ac6fdad7af321aff9a6536ca38faadf5d35a9` |

The hash only records amount. So the production rules also bind the full set of columns
checksops can UPDATE (`updatable_columns`, `updatable_columns_sha256`), the table owner and
the table ACL to the values recorded in the pin's `production_inspect`.

## Where it runs

It runs only on the SQL53 runner `i-0c35557c4e5385406` in `vpc-09f2268778966ce97`, from
the reviewed main source staged by `.github/workflows/sql53-temporary-transfer.yml`. It
never runs from GitHub-hosted runners or Lambda. Set
`AWS_ENDPOINT_URL_SECRETS_MANAGER=https://vpce-01649ea2cdb21a689-tp7fo1qj.secretsmanager.us-east-1.vpce.amazonaws.com`.

The credentials come only from the pinned `checksops_admin` secret (`admin_secret_arn`).
The secret records `dbInstanceIdentifier` but no host. The tool uses the pinned
`rds_host` for that identifier and still proves it is the production RDS
(`credentialsToProductionDatabaseUrl`). A password, URL, host or user flag is refused.

## Steps (each needs owner approval)

1. **Inspect (read-only):**

   ```bash
   AWS_ENDPOINT_URL_SECRETS_MANAGER=https://vpce-01649ea2cdb21a689-tp7fo1qj.secretsmanager.us-east-1.vpce.amazonaws.com \
     node scripts/deployment-guard/sql71-review-amount-production-apply.mjs --inspect
   ```

   It runs in `BEGIN READ ONLY … ROLLBACK` and reports:
   - `current_user` / `session_user`: must be `checksops_admin`;
   - `table_owner`, `table_acl`, `table_acl_entries`;
   - `updatable_columns`: every column checksops can UPDATE;
   - `amount_update_granted`, `routing_number_update_granted`, `account_number_update_granted`,
     `sql52_prerequisite_met`;
   - `table_level_update`: any table-level UPDATE for checksops, by any route;
   - `column_update_entries`, `grantee_grant_option`, `login_can_grant_amount`;
   - `live_definition_sha256`, and `post_state`: the hash and column set the apply must leave;
   - `precondition_failures` and `apply_preconditions_met`.

   On the first run, `precondition_failures` lists `table_owner_as_inspected`,
   `table_acl_as_inspected` and `updatable_columns_as_inspected`, because nothing is
   recorded yet. Stop if anything else is listed. A missing SQL 52 grant shows as
   `sql52_*_granted`, and a table-level UPDATE as `no_table_level_update`.
2. **Record the pre-state** in a reviewed pin change. Copy `live_definition_sha256`
   (expected `2d96f50b…`) into `expected_live_definition_sha256`. Copy `table_owner`,
   `table_acl`, `updatable_columns` and `updatable_columns_sha256` into
   `production_inspect`. This change does not authorize execution.
3. **Authorize** in a later reviewed pin change. It records the owner's approval in
   `authorization` ("Owner approved …"), the staging acceptance reference
   (`staging_acceptance.ok` true) and `execute: true`.
4. **Apply** through the one-shot, with the owner's run-time approval for this workstream:
   `node scripts/deployment-guard/production-sql-one-shot.mjs --migration sql71 --approval-scope sql71 --phase inspect|apply …`
   (see `ops/production-sql-one-shot.md`). The one-shot runs the inspect, the contracts,
   preflight (receipt and lease), the evaluate, then
   `sql71-review-amount-production-apply.mjs --apply --input <manifest>` with
   `CHECKSOPS_DEPLOYMENT_GUARD_APPLY=1`, then the post-apply inspect.

   The apply is one transaction (`lock_timeout` 5s, advisory locks). It refuses on any of these:
   - table-level UPDATE (`DEPLOYMENT_COLLISION`);
   - amount already granted (`UNRELATED_MUTATION`, already in place);
   - any failed precondition, such as a wrong login, a missing SQL 52 grant, or drift from
     the recorded columns, owner or ACL (`DEPLOYMENT_COLLISION`);
   - a live hash that is not the pinned one (`DEPLOYMENT_COLLISION`).

   Then it runs only the pinned GRANT. It rolls back unless all of these hold:
   - the updatable set is exactly the pre-apply set plus `amount`;
   - the only new column ACL entry is `amount checksops UPDATE granted by checksops_admin`;
   - there is still no table-level UPDATE or grant option;
   - the table ACL and owner are byte-identical;
   - everything else in schema public (and schema auth's functions) is unchanged.

   If the tool reports the COMMIT outcome as unknown, run step 1 before anything else.
5. **Verify:** re-run step 1. `already_applied` must be true, `live_definition_sha256`
   must be `ff8e86f9…`, and `updatable_columns` must equal the recorded set plus `amount`.
   Then record the apply and set `execute` back to false in a reviewed pin change.

## Rollback

`REVOKE UPDATE (amount) ON TABLE public.check_intake_items FROM checksops;` is a separate
owner-approved operation. The SQL 52 grants are untouched. Amount corrections in Review
then fail with a permission error until it is granted again.
