# Production ledger migration 20261007193200

Replaces only `public.sync_homeowner_ledger_from_check()` from
`supabase/migrations/20261007193200_skip_claim_ledger_event_for_endorsement_stage.sql`,
so the Endorsing stage no longer writes a claim ledger event. Required before the
`workflow-transitions.mjs` production overlay.

Pin: `ops/deployment-guard/ledger-20261007193200-production-apply.json`
(before `9f6ec2dc…`, after `03fcea3c…`, the hashes staging applied). Tool:
`scripts/deployment-guard/ledger-production-apply.mjs`.

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
   `node scripts/deployment-guard/ledger-production-apply.mjs --inspect`
   runs in `BEGIN READ ONLY … ROLLBACK`. Proceed only when
   `apply_preconditions_met` is true.
2. **Contracts:** run `aws/tests/claim-ledger-accepted-contract.test.mjs` and
   `aws/tests/api-write.test.mjs` on the same source and record them as
   `contract_results` in the manifest.
3. **Manifest** (`sql-apply`, `production`, `production-sql`): exact pin fields,
   `live_definition_sha256` = `"<live hash from step 1>"`,
   `preflight_live_fingerprint` = `production_fingerprint` =
   `immediately_before_fingerprint` = `{ "sql": "<live hash from step 1>" }`,
   the pin's `staging_acceptance`, `approval` for this workstream,
   `authorization_phrase` `REPLACE_SYNC_HOMEOWNER_LEDGER_FROM_CHECK`, a new
   `one_use_id`, and `owned_components` = `["<pin filename>"]` (the tool refuses a
   receipt that does not own the pinned migration).
4. **Lease and receipt** on the same host:
   `node scripts/deployment-guard/preflight.mjs --acquire-lease --receipt --input <manifest>`.
5. **Apply:**
   `CHECKSOPS_DEPLOYMENT_GUARD_APPLY=1 CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT=<receipt> node scripts/deployment-guard/ledger-production-apply.mjs --apply --input <manifest>`.
   One transaction with an advisory lock: refuses unless the live definition is the
   before-hash and the preserved functions and three ledger triggers are intact;
   rolls back unless the result is the after-hash with triggers and preserved
   functions unchanged. If the tool reports the COMMIT outcome as unknown, run
   step 1 before anything else.
6. **Verify:** re-run step 1; `already_applied` must be true.

## Rollback

Re-apply the before definition (`9f6ec2dc…`, the `CREATE OR REPLACE` recorded in
`ops/deployment-guard/ledger-20261007193200-staging-authorization.json`
`expected_live_definition_source`) as a separate owner-approved operation.
