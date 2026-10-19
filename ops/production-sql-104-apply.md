# Production SQL 104 (the payment_idempotency_keys table grant), after SQL 91

| key | file | what it does |
|---|---|---|
| `sql104` | `aws/workflows/sql/104_payment_idempotency_keys_grant.sql` (sha256 `e8831083266b546deac5e2502e94f27ca353a13ed89ce5b8cca21ad18d523c8f`) | `GRANT SELECT, INSERT, UPDATE ON TABLE public.payment_idempotency_keys` to `checksops` and to `authenticated`, each only when the role exists (skipped with a NOTICE when the table is absent). Nothing else: no DELETE, no PUBLIC or anon grant, no RLS or policy change. |

**Why.** SQL 91 (`aws/workflows/sql/91_moov_onboarding.sql`) added the policies
`aws_onboarding_insert_payment_idempotency_keys` and `aws_onboarding_update_payment_idempotency_keys`
but no table grant; the table's only grants come from supabase migration `20260727224957`, to
`service_role`. PostgreSQL checks table privileges before row-level security, so saving Moov
onboarding fails with `permission denied for table payment_idempotency_keys` before SQL 91's
policies are evaluated. #1062 added the grant to SQL 91's file instead; SQL 91 is already
applied (staging 2026-10-17, production 2026-10-19) and recorded against its original bytes
(`199bfa1a…`, fingerprint `f8611dcc…`), and its production pin is retired, so that edit would
never reach production and the guard refuses it (`UNRELATED_MUTATION`). SQL 104 is the same grant
as its own migration. SQL 91's file, pins and fingerprint are unchanged.

**Staging was granted by hand.** Per #1062 the grant was applied to staging directly, outside the
guard. GRANT of a held privilege is a no-op, so staging's read-live is expected to report
`already_applied` true (step 1).

**Staging read-live (2026-10-19).** The staging executor was refreshed to carry SQL 104 (run
39296205973, main `4e7c78905`, CodeSha256 `jJioB/Xf…` -> `22ZCkh6t…`), then read-live run 39296513948
found `payment_idempotency_keys` holding only `checksops SELECT`: no INSERT or UPDATE for
`checksops`, nothing for `authenticated`. The hand grant #1062 describes is not present.
`already_applied` false, live `22b2d47d…`, predecessor SQL 91 true, `precondition_failures` [].
So step 1 takes the apply path, not the read-live-only path.

**Status:** the staging pin is execute-authorized (wave 7, owner approved 2026-10-19, "do the SQL
104 staging pin", pre-state `22b2d47d…`); the staging apply still needs its own run. The production
pin is pending (`execute: false`, no recorded pre-state).

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec
`table_privileges` in `release-sql-specs.mjs`): the SELECT, INSERT and UPDATE grants of
`checksops` and `authenticated` on the table, or `absent`. Intended
`e5b35104ca9c3f68fd03298354c5d6e1e48218f0871a3f216539999931a291a6`:

```
release sql104 v1
privileges public.payment_idempotency_keys SELECT,INSERT,UPDATE: authenticated INSERT;authenticated SELECT;authenticated UPDATE;checksops INSERT;checksops SELECT;checksops UPDATE
```

Other privileges of those roles (DELETE, TRUNCATE, …) and every other role's grants are outside
the fingerprint; the post-condition `other_table_privileges_unchanged` requires them unchanged.

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present` (the table, roles `checksops` and `authenticated`); `predecessors_applied`
(SQL 91 at its intended fingerprint `f8611dcc…`); `altered_relations_owned_by_login` (the login
owns the table, so its GRANT takes effect). A table that already holds some or all of the six
grants passes: the file only adds the missing ones.

Post-conditions: the intended fingerprint; `other_table_privileges_unchanged`; everything else in
schema `public` (and the functions of `auth`) unchanged, the table's ACL excepted. The tools roll
back otherwise.

## Order

Any time after SQL 91, and before Moov onboarding is used in production. No later migration
revokes these grants, so SQL 104 is not re-run. `production-api-overlay-plan.json` has no entry
for SQL 104; the onboarding Lambda members name SQL 91 in `sql_before`, and need SQL 104 too
before onboarding saves work.

## Steps

1. Staging: the staging executor must carry SQL 104 first (executor package refresh through
   `sql-executor-ensure.mjs` / the guarded staging executor `deploy` mode, its own reviewed run).
   Then run the guarded staging SQL executor with `read-live` for
   `sql104-payment-idempotency-keys-grant`. Expected `already_applied` true (the hand grant):
   then no staging apply, and the read-live run is the staging evidence (as for SQL 103). If it
   reports anything else, record `LIVE_DEFINITION_SHA256` in the staging pin
   (`expected_live_definition_sha256`, owner-approved `authorization`, `execute: true`) in a
   reviewed change, `apply`, then `read-live` again.
2. Production: run the read-only inspect on the runner
   (`node scripts/deployment-guard/sql104-payment-idempotency-keys-grant-production-apply.mjs --inspect`,
   or the one-shot's `--phase inspect`); record `production_inspect` and copy
   `live_definition_sha256` into `expected_live_definition_sha256`; record the staging run in
   `staging_acceptance`; set an owner-approved `authorization` and `execute: true`, in one
   reviewed change. Expected: `already_applied` false, `precondition_failures` [].
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs
   --migration sql104 --approval-scope sql104 … --phase inspect`, then the owner-named
   `--phase apply`.
4. Record the apply and retire the pin (`execute: false`).
