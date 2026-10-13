# Production SQL 72 (tenant-member payment write policies)

Creates only the five `aws_member_*` policies in
`aws/workflows/sql/72_member_payment_writes.sql` on `payment_transfers`,
`payment_wallets` and `payment_event_log`. With them, any member of a tenant can
fund the tenant's wallet and refresh its balance, but only while the API's
funding or refresh code has set the financial execution GUCs. Until then, only
platform admin/staff logins can.

Pin: `ops/deployment-guard/sql72-production-apply.json`
(before `febc45be…` = all five absent, after `57233f0f…` = all five present and
well-formed, the states staging applied in run 38438034883). Tool:
`scripts/deployment-guard/sql72-production-apply.mjs`.

## Where it runs

Only on the SQL53 runner `i-0c35557c4e5385406` in `vpc-09f2268778966ce97`, from the
reviewed main source staged by `.github/workflows/sql53-temporary-transfer.yml`.
Never from GitHub-hosted runners or Lambda. Set
`AWS_ENDPOINT_URL_SECRETS_MANAGER=https://vpce-01649ea2cdb21a689-tp7fo1qj.secretsmanager.us-east-1.vpce.amazonaws.com`.

The production admin secret records `dbInstanceIdentifier` but no host; the tool
uses the pinned endpoint for that identifier and still proves it is the production
RDS (`credentialsToProductionDatabaseUrl`).

## Steps (each needs owner approval)

1. **Inspect (read-only):**
   `node scripts/deployment-guard/sql72-production-apply.mjs --inspect`
   runs in `BEGIN READ ONLY … ROLLBACK`. Proceed only when
   `apply_preconditions_met` is true (all five policies absent, and the three
   helper functions present and executable by `authenticated`).
2. **Manifest** (`sql-apply`, `production`, `production-sql`): exact pin fields,
   `live_definition_sha256` = `"<live hash from step 1>"`,
   `preflight_live_fingerprint` = `production_fingerprint` =
   `immediately_before_fingerprint` = `{ "sql": "<live hash from step 1>" }`,
   the pin's `staging_acceptance`, `approval` for this workstream,
   `authorization_phrase` `CREATE_MEMBER_PAYMENT_WRITE_POLICIES`, a new
   `one_use_id`, and `owned_components` = `["<pin filename>"]` (the tool refuses a
   receipt that does not own the pinned file).
3. **Lease and receipt** on the same host:
   `node scripts/deployment-guard/preflight.mjs --acquire-lease --receipt --input <manifest>`.
4. **Apply:**
   `CHECKSOPS_DEPLOYMENT_GUARD_APPLY=1 CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT=<receipt> node scripts/deployment-guard/sql72-production-apply.mjs --apply --input <manifest>`.
   One transaction with an advisory lock. It refuses unless all five policies are
   absent and the helpers are executable. It rolls back unless afterwards all five
   are present and well-formed (`TO authenticated`, PERMISSIVE, each clause a pure
   AND of the three conditions) and every other policy on the three tables is
   byte-identical. If the tool reports the COMMIT outcome as unknown, run step 1
   before anything else.
5. **Verify:** re-run step 1; `already_applied` must be true. Then set the pin's
   `execute` to `false` in a follow-up so it is no longer a standing authorization.

## Rollback

Drop the five policies (`DROP POLICY IF EXISTS aws_member_… ON public.…` for each)
as a separate owner-approved operation. The admin/staff policies are untouched, so
funding and refresh fall back to platform admin/staff only.
