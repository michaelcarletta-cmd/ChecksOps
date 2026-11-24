# Production check ownership inspect (read-only)

`scripts/deployment-guard/check-ownership-inspect.mjs --inspect` answers one question about
production, without changing anything:

> How many checks have an ownership (`tenant_id`, `uploaded_by`, `tenant_users` membership) or an
> image path scope that keeps their own uploader from writing them, and how old are they?

Owner report 2026-11-24: on an old check, uploaded in the Cursor / Lovable (Supabase) era,
editing the endorsements or generating the deposit image fails with "check not found or not
writable". The check is not partner-shared. The owner asked to count the old checks.

It is inspect-only. It has no pin, no `execute`, no apply, no `--input`, no receipt and no
one-shot entry. The configuration in `ops/deployment-guard/check-ownership-inspect.json` names
the same production RDS and `checksops_admin` secret as the Mortgage Desk access inspect.

## Why these counts

Where the message comes from (main at the time of this change):

- Every API session, read or write, logs in as the same `checksops` role and sets the same
  `request.app_user_id`; a write session only drops `default_transaction_read_only`
  (`aws/functions/api/data.mjs` `withIdentity`, `db-health.mjs` `buildWriteClientConfig`). So a
  plain `SELECT` sees the same rows in both: `aws_select_check_intake_items`
  (`aws_is_cross_tenant_reader() OR aws_can_access_tenant(tenant_id) OR
  aws_is_active_shared_check_target(id)`, `aws/rls/sql/34_c1c_partner_visibility.sql`) or
  `aws_write_check_intake_items` (`FOR ALL`, `aws_can_write_tenant(tenant_id)`,
  `aws/rls/sql/21_proposed_write_policies.sql`). No AWS policy reads `uploaded_by`.
- "check not found or not writable" is returned when the check lookup's `SELECT` finds no row:
  `lookupCheck` (`write-check-workflow.mjs`), `lookupWritableCheck` (`storage-write-auth.mjs`),
  and the `SELECT … FOR UPDATE` lookups in `workflow-rpc.mjs` (where the `UPDATE` policy also
  filters, so a row the caller can read but not write is "not found" there).
- A check with `tenant_id` NULL or an unknown tenant is invisible to a tenant member through the
  API at all (only the platform owner reads it). A check whose uploader is not a member of its
  tenant is invisible to that uploader. These are the ownership counts.
- The deposit image is uploaded next to the original back image
  (`src/components/checks/EndorsementAdjuster.tsx`: the folder of `originalImagePath`). The
  storage gate (`authorizeStorageWritePath`) takes the check id from the path's
  `checks/<uuid>/` segment and looks that check up. The Supabase-era upload prefix was
  `checks/<user id>/<claim dir>` (`src/pages/CheckCommandCenter.tsx`), so for those checks the
  uuid is the uploader, the lookup finds no check, and the answer is "check not found or not
  writable" even when the check's ownership is correct. These are the path counts.

## What it reads

One `BEGIN READ ONLY … ROLLBACK` with `search_path` set to `pg_catalog`, a 20 s statement
timeout, a 2 s lock timeout and `TimeZone` UTC. Inside it, only the fixed statements in `Q`
(`lib/check-ownership-inspect.mjs`). Every statement returns counts, booleans, code labels and a
`YYYY-MM` month. Ids and paths are used only inside predicates; none is returned.

Every check gets one ownership class, decided in this order:

| class | meaning |
|---|---|
| `tenant_null` | `tenant_id` is NULL: `aws_can_write_tenant(NULL)` is false for every caller |
| `tenant_missing` | `tenant_id` names no row of `public.tenants` |
| `uploader_null` | the tenant exists, `uploaded_by` is NULL (no uploader to judge) |
| `uploader_not_member` | the tenant exists, the uploader has no `tenant_users` row in it |
| `uploader_member` | the uploader is a `tenant_users` member of the check's tenant |

Membership is exactly the API's `TENANT_MEMBER_SQL` and SQL 90's `aws_is_tenant_member`: a
`tenant_users` row with `user_id` = the uploader and `tenant_id` = the check's tenant; the role is
ignored. `uploader_tenants` is the uploader's number of distinct `tenant_users` tenants:
`uploader_null`, `none`, `one` (the safe re-home target), `several`.

| section | content |
|---|---|
| `row_security` | per table, whether row-level security filters what `checksops_admin` reads (expected all `false`; `true` would make the counts partial) |
| `summary` | total checks, deposited / not deposited, `uploaded_by_null`, `uploader_cannot_write` (`tenant_null` + `tenant_missing` + `uploader_not_member`) and per class the `uploader_tenants` split |
| `ownership` | checks by class, `uploader_tenants` and deposited (`deposited_at` set) |
| `affected` | distinct tenants with checks, missing tenants, tenants with an `uploader_not_member` check, tenants affected, uploaders affected: counts only |
| `by_month` | checks by class, deposited and `created_at` month (UTC) |
| `by_stage` | checks by class, deposited, `status` and `check_stage` |
| `claims` | checks by class, deposited and claim class (`no_claim`, `claim_missing`, `claim_org_null`, `claim_org_equal`, `claim_org_differs` against the check's `tenant_id`), and whether the uploader is a member of the claim's org |
| `image_paths` | per image column (`front_image_path`, `back_image_path`, `back_image_original_path`, and `adjuster_source` = `back_image_original_path`, else `back_image_path`), checks by class, deposited and path class |

Path classes (`path_classes` in the output): `empty`; `check_scoped_self` (the check's own scope);
`check_scoped_uploader` (`checks/<uploader>/`, the Supabase-era prefix); `check_scoped_tenant`;
`check_scoped_other_check`; `check_scoped_other_uuid`; `not_check_scoped`; `url_not_parsed`. The
SQL mirrors `storage-paths.mjs` `normalizePath(…, 'claim-files')` and `matchCheckScopedPath`; the
tests compare the two on PostgreSQL 16.

A statement whose columns are missing is reported as
`{ "read": false, "reason": "columns_missing:…" }`; the others still run. Labels that do not look
like a code label are printed as `other`. Errors, a failed connection included, report only the
stage and the error's code (SQLSTATE or a Node `E*` code).

## Run (SSM runner `i-0c35557c4e5385406`, stopped between runs)

This runs only after the change is merged to main and the owner approves the run.

1. Stage main: dispatch `.github/workflows/sql53-temporary-transfer.yml` on `main`. When its
   `upload` job has finished, copy `SOURCE_COMMIT` and `TARBALL_SHA256` from the `package` job log.
2. Check the runner: `i-0c35557c4e5385406` (`checksops-sql53-temporary-runner`, profile
   `ChecksOpsSql53TemporaryRunner`) is `stopped` and has no SSM command in progress. Start it, wait
   for `running`, then for SSM `PingStatus` `Online`.
3. Send one SSM `AWS-RunShellScript` command:

   ```bash
   set -euo pipefail
   SHA=<full main sha>
   TARBALL_SHA256=<TARBALL_SHA256 from the transfer run log>
   WORK=$(mktemp -d /var/tmp/check-ownership-inspect-XXXXXX)
   cd "$WORK"
   aws s3 cp "s3://checksops-sql53-transfer-806168576068/sql53/source-${SHA}.tar.gz" . --no-progress
   aws s3 cp "s3://checksops-sql53-transfer-806168576068/sql53/source-${SHA}.tar.gz.sha256" . --no-progress
   echo "${TARBALL_SHA256}  source-${SHA}.tar.gz" | sha256sum -c -
   mkdir src
   tar -xzf "source-${SHA}.tar.gz" -C src
   cd src
   test "$(cat SOURCE_COMMIT)" = "$SHA"
   AWS_ENDPOINT_URL_SECRETS_MANAGER=https://vpce-01649ea2cdb21a689-tp7fo1qj.secretsmanager.us-east-1.vpce.amazonaws.com \
     node scripts/deployment-guard/check-ownership-inspect.mjs --inspect
   cd / && rm -rf "$WORK"
   ```

4. Stop the runner and wait for `stopped`, whatever the result.
5. Record the date, SSM command id, source commit and the answer in `production_inspect` of the
   configuration file, in a reviewed change.

## Reading the answer

- `row_security` has a `true`: the counts are what `checksops_admin` can see, not every row. Stop
  and report it.
- `summary.uploader_cannot_write.checks` is the number of checks whose own uploader cannot write
  them; `by_month` says whether they are old (Supabase era) or recent.
- `tenant_null` / `tenant_missing` with `uploader_tenants.one`: the check can be re-homed to the
  uploader's single tenant. `several` or `none` needs the owner's decision per tenant; `claims`
  (`claim_org_equal` / `claim_org_differs` with `uploader_member_of_claim_org`) can point at the
  right tenant. Any data fix is a new numbered migration through the guarded staging and
  production path, never a hand edit.
- `uploader_not_member`: the uploader is not (or no longer) a member of the check's tenant. Other
  members of that tenant can still write the check; this alone is not a data error.
- `image_paths` with `adjuster_source` `check_scoped_uploader` (or `_tenant`, `_other_uuid`,
  `_other_check`) on `uploader_member` checks: ownership is fine and the deposit image upload is
  refused by the storage gate's path scope. The fix is in where the deposit image is written (a
  frontend or storage-gate change), not in the data.

## Staging

This change adds no staging tool. The tests run the same statements on PostgreSQL 16
(`aws/tests/check-ownership-inspect.test.mjs`).
