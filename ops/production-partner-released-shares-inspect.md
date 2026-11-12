# Production partner released shares inspect (read-only)

`scripts/deployment-guard/partner-released-shares-inspect.mjs --inspect` answers one question
about production, without changing anything:

> For the checks a partner (Freedom) shared with Condition One and then released, who is the
> recorded payee of each payout, and do the payouts recorded for Condition One reach Condition
> One's Funds Received?

Owner report 2026-11-12: Freedom paid out of shared checks outside ChecksOps and recorded those
payments (`record-external-disbursement`, SQL 147: one settled `external_check` split per payee
under Freedom's tenant, the check moves to `disbursed_externally`). On Condition One's side those
checks were listed under Funds Released, which is wrong (frontend fix:
michaelcarletta-cmd/ChecksOps#1820). Where they belong depends on what Freedom recorded.
`get_tenant_funds_received` lists a payout for a tenant when `recipient_tenant_id` is the tenant,
the payee account belongs to the tenant, or the recipient name equals the tenant's name after
`normalize_org_name`. A recorded outside payment has only a typed name or a payee account, so a
payment meant for Condition One can miss.

It is inspect-only. It has no pin, no `execute`, no apply, no `--input`, no receipt and no
one-shot entry. The configuration in `ops/deployment-guard/partner-released-shares-inspect.json`
names the same production RDS and `checksops_admin` secret as the Mortgage Desk access inspect.

## What it reads

One `BEGIN READ ONLY … ROLLBACK` with `search_path` set to `pg_catalog`, a 20 s statement
timeout and a 2 s lock timeout. Inside it, only the fixed statements in `Q`
(`lib/partner-released-shares-inspect.mjs`). Every statement returns counts, dollar totals,
booleans and code labels. Ids and names are used only inside predicates; none is returned.

The receiving organization is the one tenant whose normalized name starts with `condition one`.
With zero or several matches the tool reports the number of matches and reads nothing else.

| section | content |
|---|---|
| `tenants` | how many tenants match the receiving prefix (`condition one%`) and the sharing prefix (`freedom%`); `target_resolved` |
| `functions` | `get_tenant_funds_received` and `normalize_org_name`: present, SECURITY DEFINER, `prosrc` sha256, and whether the former matches by recipient name, by `recipient_tenant_id` and by payee-account tenant |
| `shares` | active (not revoked) shares to the receiving organization: checks and check amount by `check_stage`, split by whether the sharing organization matches `freedom%` |
| `released_splits` | the sharing organization's payouts on the shared checks at `funds_released` / `disbursed_externally`: payouts, checks and amount by status, method and recipient class |
| `released_checks` | those checks by what their **settled** payouts say: `paid_to_target_listed`, `paid_to_target_near_miss_only`, `paid_to_others_only`, `no_settled_payout`, with check, settled, listed and near-miss amounts |
| `send_legs` | the sharing organization's `payment_transfers` send legs from those checks, by role, status and whether the destination is the receiving organization |
| `target_own` | the receiving organization's own payouts (by status) and send legs (by role and status); expected empty if it sent nothing through ChecksOps |

Recipient classes (`recipient_classes` in the output):

| class | Funds Received | meaning |
|---|---|---|
| `recipient_tenant_id` | listed | the payout names the receiving tenant by id |
| `payee_account_of_target` | listed | the payee account belongs to the receiving tenant |
| `recipient_name_equal` | listed | the typed name equals the tenant's name after normalization |
| `recipient_name_contains` | near miss | the typed name contains "condition one" but is not equal |
| `payee_account_name_contains` | near miss | the sharing organization's payee account is named after it |
| `recipient_name_abbreviation` | near miss | the typed name has `c1`, `c1c`, `c 1` or `cone` as a word |
| `other_recipient_name`, `other_payee_account`, `no_recipient` | other | someone else, or nobody recorded |

A statement whose tables or columns are missing is reported as
`{ "read": false, "reason": "columns_missing:…" }`; the others still run. Labels that do not look
like a code label are printed as `other`. Errors, a failed connection included, report only the
stage and the error's code (SQLSTATE or a Node `E*` code).

## Run (SSM runner `i-0c35557c4e5385406`, stopped between runs)

This runs only after the change is merged to main.

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
   WORK=$(mktemp -d /var/tmp/partner-released-shares-inspect-XXXXXX)
   cd "$WORK"
   aws s3 cp "s3://checksops-sql53-transfer-806168576068/sql53/source-${SHA}.tar.gz" . --no-progress
   aws s3 cp "s3://checksops-sql53-transfer-806168576068/sql53/source-${SHA}.tar.gz.sha256" . --no-progress
   echo "${TARBALL_SHA256}  source-${SHA}.tar.gz" | sha256sum -c -
   mkdir src
   tar -xzf "source-${SHA}.tar.gz" -C src
   cd src
   test "$(cat SOURCE_COMMIT)" = "$SHA"
   AWS_ENDPOINT_URL_SECRETS_MANAGER=https://vpce-01649ea2cdb21a689-tp7fo1qj.secretsmanager.us-east-1.vpce.amazonaws.com \
     node scripts/deployment-guard/partner-released-shares-inspect.mjs --inspect
   cd / && rm -rf "$WORK"
   ```

4. Stop the runner and wait for `stopped`, whatever the result.
5. Record the date, SSM command id, source commit and the answer in `production_inspect` of the
   configuration file, in a reviewed change.

## Reading the answer

- `tenants.target_resolved: false`: the prefix matched zero or several tenants. Nothing else was
  read. Narrow `TARGET_NAME_PREFIX` in a reviewed change and run again.
- `released_checks` mostly `paid_to_target_listed`: Freedom's recorded payments already appear in
  Condition One's Funds Received. Those checks can be left out of Condition One's Deposited tab
  (they are double listed after #1820); a frontend change.
- `paid_to_target_near_miss_only` above zero: payments were recorded for Condition One under a
  name or payee account that Funds Received does not match. The fix is in how the payee is
  recorded or matched (a new numbered migration through the guarded path, or a corrected record
  by Freedom), decided by the owner from these counts.
- `paid_to_others_only`: the money went to someone else (homeowner, contractor, mortgage
  company). Those checks are correctly absent from Condition One's Funds Received.
- `no_settled_payout`: the check is at a released stage with no settled payout of the sharing
  organization. Compare with `send_legs` (a send writes no payout row).
- `target_own` not empty: Condition One has payouts or sends of its own, contrary to the report.

## Staging

This change adds no staging tool. The tests run the same statements on PostgreSQL 16
(`aws/tests/partner-released-shares-inspect.test.mjs`).
