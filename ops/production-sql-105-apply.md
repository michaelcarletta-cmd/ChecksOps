# Production SQL 105 (the onboarding payment table grants), after SQL 91

| key | file | what it does |
|---|---|---|
| `sql105` | `aws/workflows/sql/105_onboarding_payment_table_grants.sql` (sha256 `79c7bbfc0802836f165b12044cba949efbe1698f4f93906a98e7089de851f420`) | `GRANT SELECT, INSERT, UPDATE ON TABLE` `public.payment_provider_accounts`, `public.payment_provider_methods` and `public.payment_method_verifications`, and `GRANT SELECT, INSERT ON TABLE public.payment_event_log`, each to `checksops` and to `authenticated`, each only when the role exists (a table that is absent is skipped with a NOTICE). Nothing else: no DELETE, no PUBLIC or anon grant, no RLS or policy change. |

**Why.** SQL 91 (`aws/workflows/sql/91_moov_onboarding.sql`) added the onboarding policies
`aws_onboarding_{insert,select,update}_payment_provider_accounts`,
`aws_onboarding_{insert,update}_payment_provider_methods`,
`aws_onboarding_{insert,update}_payment_method_verifications` and
`aws_onboarding_insert_payment_event_log`, and granted its four `moov_*` tables, but granted
`checksops` nothing on these four tables; their only grants are supabase's (to `authenticated`
and `service_role`). PostgreSQL checks table privileges before row-level security, so on staging
(2026-10-20 12:18:20Z) `moov-onboarding-save` failed with `permission denied for table
payment_provider_accounts` on the first write after Moov accepted the account, before SQL 91's
policies were evaluated. SQL 104 fixed the same gap for `payment_idempotency_keys`; SQL 105 is the
same fix for the four remaining tables, as its own migration. SQL 91 is already applied (staging
2026-10-17, production 2026-10-19) and recorded against its original bytes (`199bfa1a…`,
fingerprint `f8611dcc…`); SQL 91's file, pins and fingerprint are unchanged.

**Staging has not been granted by hand.** Unlike SQL 104, no grant was applied to staging
outside the guard, so staging's read-live is expected to report `already_applied` false (the
`checksops` lines absent on all four tables) and a guarded staging apply is needed (step 1).

**Status:** pending. Both pins are `execute: false`, `authorization: "pending"`, with no recorded
pre-state; nothing is applied by this change. Production has not been inspected yet.

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec
`table_privileges` in `release-sql-specs.mjs`): the SELECT, INSERT and UPDATE grants of
`checksops` and `authenticated` on the first three tables and their SELECT and INSERT grants on
`payment_event_log`, or `absent` per table. Intended
`a67bc0a6faa4cf60500946c4a1a980180cec9ff44980a6cf9b5f05846e7e7127`:

```
release sql105 v1
privileges public.payment_provider_accounts SELECT,INSERT,UPDATE: authenticated INSERT;authenticated SELECT;authenticated UPDATE;checksops INSERT;checksops SELECT;checksops UPDATE
privileges public.payment_provider_methods SELECT,INSERT,UPDATE: authenticated INSERT;authenticated SELECT;authenticated UPDATE;checksops INSERT;checksops SELECT;checksops UPDATE
privileges public.payment_method_verifications SELECT,INSERT,UPDATE: authenticated INSERT;authenticated SELECT;authenticated UPDATE;checksops INSERT;checksops SELECT;checksops UPDATE
privileges public.payment_event_log SELECT,INSERT: authenticated INSERT;authenticated SELECT;checksops INSERT;checksops SELECT
```

Other privileges of those roles (`authenticated`'s DELETE where supabase granted it, TRUNCATE, …)
and every other role's grants (`service_role`'s) are outside the fingerprint; the post-condition
`other_table_privileges_unchanged` requires them unchanged on each table.

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present` (the four tables, roles `checksops` and `authenticated`);
`predecessors_applied` (SQL 91 at its intended fingerprint `f8611dcc…`);
`altered_relations_owned_by_login` (the login owns the four tables, so its GRANTs take effect).
A table that already holds some or all of its pinned lines passes: the file only adds the
missing ones. Supabase's migrations grant `authenticated` on these tables, but staging refused
`checksops` (a member of `authenticated`) on 2026-10-20, so whether those lines are held on RDS
is what the read-live and the inspect record.

Post-conditions: the intended fingerprint; `other_table_privileges_unchanged`; everything else in
schema `public` (and the functions of `auth`) unchanged, the four tables' ACLs excepted. The
tools roll back otherwise.

## Order

Any time after SQL 91, and before Moov onboarding is used in production. No later migration
revokes these grants, so SQL 105 is not re-run. `production-api-overlay-plan.json` has no entry
for SQL 105 yet; the onboarding Lambda members name SQL 91 (and SQL 104) in `sql_before`, and
need SQL 105 too before onboarding saves work.

## Steps

1. Staging: the staging executor must carry SQL 105 first (executor package refresh through
   `sql-executor-ensure.mjs` / the guarded staging executor `deploy` mode, its own reviewed run).
   Then run the guarded staging SQL executor with `read-live` for
   `sql105-onboarding-payment-table-grants`. Expected `already_applied` false and
   `precondition_failures` `[]`. Record `LIVE_DEFINITION_SHA256` in the staging pin
   (`expected_live_definition_sha256`, owner-approved `authorization`, `execute: true`) in a
   reviewed change, `apply` with the owner's approval of that run, then `read-live` again
   (expected `already_applied` true). If the first read-live reports anything else (a hand
   grant, a precondition failure), stop and record it in its own reviewed change.
2. Production: run the read-only inspect on the runner
   (`node scripts/deployment-guard/sql105-onboarding-payment-table-grants-production-apply.mjs --inspect`,
   or the one-shot's `--phase inspect`); record `production_inspect` and copy
   `live_definition_sha256` into `expected_live_definition_sha256`; record the staging runs in
   `staging_acceptance`; set an owner-approved `authorization` and `execute: true`, in one
   reviewed change. Expected: `already_applied` false, `precondition_failures` [].
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs
   --migration sql105 --approval-scope sql105 … --phase inspect`, then the owner-named
   `--phase apply`.
4. Record the apply and retire the pin (`execute: false`).
