# Production SQL 116 (the Moov onboarding business profile keeps the business's industry)

| key | file | what it does |
|---|---|---|
| `sql116` | `aws/workflows/sql/116_moov_onboarding_profile_industry.sql` (sha256 `31217651d76753c9f76232f0bd2c64ab3fd9a36754ccda081fda18169437b8b8`) | `ALTER TABLE public.moov_onboarding_profiles ADD COLUMN IF NOT EXISTS industry text`: nullable, no default, so every existing row is unchanged. Refuses (`55000 sql116_prerequisite_missing`) without the table. Nothing else: no constraint, grant, policy, function, trigger or row change. |

**Why.** Moov requires an industry on a business account's profile (`profile.business.industry`,
a value from Moov's `GET /industries` list). ChecksOps never asked for one and
`moov_onboarding_profiles` (SQL 91) had nowhere to keep it. On staging on 2026-10-26 Moov's form
for Freedom Adjustment's new sandbox account (tenant `2eff5f1a`) listed Industry as required and
empty, so the account stayed `onboarding_incomplete` whatever ChecksOps sent. The column holds
the industry identifier from Moov's list; the API validates it before writing it (a later code
change), so the column carries no check. SQL 91's table grants (`SELECT, INSERT, UPDATE` to
`checksops` and `authenticated`) cover the new column.

**Expected outcomes of the inspect.** `already_applied` false with `precondition_failures` `[]`
(SQL 91 in place, the table owned by the login, no `industry` column), or `already_applied` true
(nothing to apply; the inspect is recorded as the verified-live evidence and the pin stays
`execute: false`). Anything else (SQL 91 not in place, a table not owned by the login, an
`industry` column of another type, default or grant) stops and needs its own reviewed change.

**Staging executor refreshed (2026-10-26).** Inspect run 40335246738 (main `d8d4e3b`) found the
live executor at CodeSha256 `k6Gyn1k4…` without SQL 116 (adds
`sql/116_moov_onboarding_profile_industry.sql`). Deploy run 40335727438 updated it to main's
package (`taTo9Hxf…`; "Verify live executor now carries main's package" passed).

**Staging read-live (2026-10-26).** Run 40336144625 (main `d8d4e3b`): `moov_onboarding_profiles.industry`
absent, predecessor SQL 91 in place; live `d145c18e29fb0e309222d250e270f5750be7f23a8cbe336190d5c9d7bfd7d9dd`, `already_applied` false,
`precondition_failures` `[]`. Recorded in the staging pin (`expected_live_definition_sha256`,
`execute: true`, wave 17) under the owner's words of 2026-10-26, "Approve SQL 116 staging apply
and merge when green".

**Staging apply (2026-10-26).** After the staging pin change (#1256), executor runs 40338592142 and
40338947124 preceded the apply; at the apply the live executor was `y4Tko8e2…` and carried main's
package. Apply run 40339373370 (staging pin commit `eb945142`): result `applied`, before
`d145c18e29fb0e309222d250e270f5750be7f23a8cbe336190d5c9d7bfd7d9dd`, after
`c99fc953f7ab14c2c68647ed3bcfa3e0b50a5aa4888bdc9f9c71163392314ee1` (intended). Read-live run
40339796555: `already_applied` true, `moov_onboarding_profiles.industry` intended.

**Production inspect (2026-10-26).** Read-only `--inspect` through SSM
`5120ddac-a515-4411-92c7-7c0046de0790` on `i-0c35557c4e5385406`, main `fc2af0c45` (tarball sha256
`2adf95c3a17f3edba52f56080b1c50f72d6284020d32df09ecff7be03046ca0d`, transfer run 40382971367, migration
source `31217651…` == pin), connected as `checksops_admin`: `moov_onboarding_profiles.industry`
absent, predecessor SQL 91 in place; live `d145c18e29fb0e309222d250e270f5750be7f23a8cbe336190d5c9d7bfd7d9dd`
(the staging pre-state), `already_applied` false, `precondition_failures` `[]`. Recorded in the
production pin with the staging apply as its staging acceptance and `execute: true` under the owner's
words of 2026-10-26, "build the SQL 116 pin PR". Each apply still needs the owner's run-time approval.
Apply SQL 116 before the onboarding members `store.mjs`, `moov-sync.mjs` and `handlers.mjs`
(production-moov-onboarding-reconcile manifest).

**Status:** staging applied (wave 17); production pin execute-authorized; production apply pending.

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec
`added_columns` in `release-sql-specs.mjs`): the column's type, not-null flag, default and column
ACL. Intended `c99fc953f7ab14c2c68647ed3bcfa3e0b50a5aa4888bdc9f9c71163392314ee1`:

```
release sql116 v1
column public.moov_onboarding_profiles.industry: text notnull=false default=- acl=
```

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present` (`moov_onboarding_profiles`); `predecessors_applied` (SQL 91);
`altered_relations_owned_by_login` (`moov_onboarding_profiles`); `added_columns_absent_or_intended`
(no `industry` column, or one exactly as intended).

Post-conditions: the intended fingerprint; everything else in schema `public` (and the functions
of `auth`) unchanged, this column excepted. The tools roll back otherwise.

## Order

Predecessor SQL 91, which SQL 116 supersedes: SQL 91 fingerprints the full column list of
`moov_onboarding_profiles`, so once SQL 116 is in place SQL 91 counts as applied by SQL 116's
fingerprint (as SQL 93 by SQL 96's), and SQL 104, 105 and 109 keep their SQL 91 predecessor.
The API change that writes and sends the column follows SQL 116 in each environment; until then
nothing reads it.

## Steps

1. Staging: the staging executor must carry SQL 116 first (executor package refresh through
   `sql-executor-ensure.mjs` / the guarded staging executor `deploy` mode, its own reviewed run).
   Then run the guarded staging SQL executor with `read-live` for
   `sql116-moov-onboarding-profile-industry`. If it reports `already_applied` false and
   `precondition_failures` `[]`, record `LIVE_DEFINITION_SHA256` in the staging pin
   (`expected_live_definition_sha256`, owner-approved `authorization`, `execute: true`) in a
   reviewed change, `apply` with the owner's approval of that run, then `read-live` again
   (expected `already_applied` true). Anything else: stop and record it in its own reviewed
   change.
2. Production: run the read-only inspect on the runner
   (`node scripts/deployment-guard/sql116-moov-onboarding-profile-industry-production-apply.mjs --inspect`,
   or the one-shot's `--phase inspect`); record `production_inspect`. If `already_applied` is
   true, the reviewed change records it as verified live and leaves `execute: false`. Otherwise
   copy `live_definition_sha256` into `expected_live_definition_sha256`, record the staging runs
   in `staging_acceptance`, and set an owner-approved `authorization` and `execute: true`, in one
   reviewed change.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs
   --migration sql116 --approval-scope sql116 … --phase inspect`, then the owner-named
   `--phase apply`.
4. Record the apply and retire the pin (`execute: false`).
