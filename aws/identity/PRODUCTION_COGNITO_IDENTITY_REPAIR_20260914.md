# Production Cognito identity-link repair — 2026-09-14

Operator record of a live `checksops` data repair. No new application users. No
deleted users. No tenant/role changes. No MFA change. No CheckAlt. No provider
permission activation. No money movement. No SPA deploy.

Continuation of the STOP reported in
`aws/cutover/PRODUCTION_SPA_COGNITO_CUTOVER_ATTEMPT_20260914.md`. That report
identified `401 identity_not_linked` for the two standard T0 test accounts as
the blocking issue. This document repairs that issue for **all 8** production
Cognito accounts, not just the two T0 accounts, since Phase 1 showed all 8
were affected identically.

`origin/main` at the time of this repair: `faf9b82e7` (unchanged from the
preflight report — no new commits landed on `main` between the two).

## Phase 1 — inventory (read-only)

### Tooling

No standing tool exists that lets an outside-VPC operator run arbitrary
read-only SQL against the shared `checksops` RDS instance. Following the
precedent recorded in
[PR #217](https://github.com/michaelcarletta-cmd/ChecksOps/pull/217)
(`aws/identity/PRODUCTION_COGNITO_SUB_REPAIR_3B14P1.md`, "Database: `checksops`
as `checksops_admin` via `checksops-staging-rehearsal-oneshot`"), a **new**,
distinctly-named, temporary Lambda function
(`checksops-cursor-identity-inventory-temp`) was created for this task instead
of reusing/overwriting any existing shared function:

- Same VPC/subnets/security group as the existing `checksops-staging-rehearsal-oneshot`
  and `checksops-production-prep-api` functions (both already reach the same
  shared RDS instance).
- Reused the existing `checksops-staging-rehearsal-oneshot` **execution role**
  (`arn:aws:iam::806168576068:role/checksops-staging-rehearsal-oneshot`) via
  `iam:PassRole` — no new IAM role/policy created.
- Same `ADMIN_SECRET_ARN` (`checksops_admin`) and `RDS_HOST` the existing
  rehearsal Lambda already uses — this is the **same physical database** that
  backs `checksops-production-prep-api` (`DATABASE_SECRET_ARN` on the
  production API points at the identical `rds-db-credentials/checksops-staging/checksops`
  secret family and the same RDS host). Production and staging are not
  separate databases; they share one `checksops` database. This fact directly
  motivates the design recommendation at the end of this document.
- Every Phase 1 query ran inside `BEGIN; SET TRANSACTION READ ONLY; … ROLLBACK;`.
  No INSERT/UPDATE/DELETE statements exist in the inventory code path.
- The existing `checksops-staging-rehearsal-oneshot` function's code and
  configuration were **never modified** — its `CodeSha256` was recorded before
  and re-verified identical after this task
  (`Uuqs/fRkCulPrdKUj72FJTlHdTkfhVXc+mttZljUzwk=`). No other team's in-flight
  work on that function was touched.
- The temporary function was deleted immediately after Phase 3 completed
  (`aws lambda delete-function --function-name checksops-cursor-identity-inventory-temp`),
  confirmed gone via a follow-up `get-function` (`ResourceNotFoundException`).
- Cognito user emails were joined against `identity_accounts`/`profiles`
  **inside** the Lambda; only masked emails (`ab***@domain`) ever left the VPC
  in the JSON response. No full email, name, token, or secret was printed to
  any log or terminal by this task.

### Production Cognito pool census

`aws cognito-idp list-users --user-pool-id us-east-1_h00WorYMT` returned
**exactly 8 users**, all `Enabled: true`, `UserStatus: CONFIRMED`,
`MFAOptions: None`, all created `2026-09-06T12:10:0x–2x`. In this pool,
`Username` equals the Cognito `sub` (no separate alias).

### Matching method (not by display name)

Each of the 8 Cognito accounts was matched to an existing application user by
**lower(email) equality** between the Cognito `email` attribute and
`public.identity_accounts.email` (falling back to `public.profiles.email` when
no `identity_accounts` row existed). `identity_accounts` enforces
`UNIQUE(cognito_sub)` and `PRIMARY KEY(application_user_id)`; email equality
was checked for uniqueness before accepting a match (no case produced more
than one candidate). All 8 matches were **unique and unambiguous**.

### Findings table (masked)

| Masked email | application_user_id | Production Cognito sub | `identity_accounts.cognito_sub` (before) | Status | Tenant(s) | App role(s) |
|---|---|---|---|---|---|---|
| `cl***@freedomadj.com` | `b100f05d-9e81-4a7b-b9cc-9baf173131d9` | `34c8a478-e0d1-70f3-3c49-02225e7404b6` | `2498c4b8-f0a1-701b-da4b-a1f5c79f675a` | STAGING_SUB | (none) | `mortgage_agent` |
| `pa***@condition1commercial.com` | `fd857564-9534-4b0f-95ac-624ed1273725` | `74286478-c0c1-7068-9fea-9deea6f61627` | `e418f488-4011-7046-5a09-3f8b51140899` | STAGING_SUB | `c1c` | `admin` |
| `ch***@freedomadj.com` (T0 tester) | `abd3c2a0-6dc0-4680-92dd-a013e1141c91` | `f468b438-4081-7004-d865-a1b86eb19beb` | `04d85458-1041-7017-a8e8-b2f3f0a5b75b` | STAGING_SUB | `freedom` | `staff` |
| `as***@condition1commercial.com` | `3af0234c-de1b-4819-938d-fa4f9390811b` | `24d874d8-80d1-7092-7f34-48b8704702f8` | `84185468-a041-70e7-6f61-c6c63f4aff19` | STAGING_SUB | `c1c` | `admin` |
| `su***@homeheropros.com` | `30d0505c-bcfa-4732-81fd-869dc46da5dd` | `34388468-a021-7036-c34d-2ff14a20ed40` | `14187428-90d1-70f2-95f3-10844b186461` | STAGING_SUB | `homehero` | `admin` |
| `mc***@freedomadj.com` | `7dbb3009-f059-4767-b5dc-1c5c72379330` | `a45884b8-d051-70b3-b19d-ca704964c6e8` | `c4386408-60e1-70e2-abb6-e6194e8e635f` | STAGING_SUB | `freedom` | `admin` |
| `lh***@condition1commercial.com` | `0160a5f3-30a4-4aba-8e54-6529f1ceb0d4` | `d418a4f8-80f1-70d6-36c9-fe490220bf4a` | `5458c4f8-1081-701d-10cf-02a993311263` | STAGING_SUB | `c1c` | `admin` |
| `ba***@gmail.com` | `e2ad0849-c6b6-4f4a-a68a-8c52f563c6fd` | `647894c8-2011-70d4-e874-efd4b080700e` | `34a8e428-6071-70b2-92de-fc7e3fd74f14` | STAGING_SUB | `barzziniconstruction` | `admin` |

**All 8 of 8 production Cognito users were `STAGING_SUB`** — the value in
`identity_accounts.cognito_sub` did not match any of the 8 current production
subs, so login through the production pool could authenticate but never
resolve to an application user (`identity_not_linked`). No account was
`MATCH`, `MISSING`, or `AMBIGUOUS`.

Notably, `mc***@freedomadj.com` (the Freedom admin / master-owner account)
was the **exact** account [PR #217](https://github.com/michaelcarletta-cmd/ChecksOps/pull/217)
already repaired once, on 2026-09-10, setting `cognito_sub` to
`a45884b8-d051-70b3-b19d-ca704964c6e8`. By the time of this inventory its
`linked_at` had moved to `2026-09-11 22:53:14` and its `cognito_sub` had
drifted **back** to a stale value (`c4386408-60e1-70e2-abb6-e6194e8e635f` —
notably, the original *staging* sub previously associated with the T0 tester
account in `aws/identity/expected-mappings.mjs`, freed up when the tester's
own sub changed at `2026-09-11 16:33:20`). This is direct, dated evidence that
the drift PR #217 fixed **recurred** after that PR merged — see the design
recommendation below.

### `identity_accounts` row accounting

`identity_accounts` had **11** rows total (unchanged before/after this
repair). 8 correspond to the production Cognito users above. The remaining 3
do **not** correspond to any of the 8 production Cognito users and were left
untouched:

| application_user_id | Masked email | `cognito_sub` | status | Note |
|---|---|---|---|---|
| `233c588f-dc33-4307-8c3f-3da49c9fd2b3` | `ch***@gmail.com` | `84e85408-b091-7058-a111-1d9a84e78da0` | `active` | Has a `profiles` row only (no tenant/role membership) — a self-registered/unapproved user, not one of the 8 known production accounts. Out of scope. |
| `c7729c3e-d87b-46c6-973e-9c04fbdcc961` | `st***@checksops.invalid` | `b4d8d428-2081-706b-04b0-e4694e568059` | `active` | No `profiles`/`tenant_users`/`user_roles` row at all — an orphaned test-probe identity (`*.invalid` domain, matches the `staging-identity-probe` pattern). Out of scope. |
| `dd24eea5-5d12-47d1-999e-d5930c278b7d` (documented "ninth" UUID) | (none) | (null) | `pending` | Matches the intentionally-unlinked "ninth" UUID already documented in `aws/identity/expected-mappings.mjs`/`onboard.mjs`. Explicitly out of scope by design. |

No `identity_accounts` row was ambiguous, and no repair touched any of these
3 rows.

## Phase 2 — repair plan and constraint proof

`identity_accounts` constraints (read live via `information_schema`/`pg_constraint`,
not assumed):

- `identity_accounts_pkey`: `PRIMARY KEY (application_user_id)`
- `identity_accounts_cognito_sub_key`: `UNIQUE (cognito_sub)`
- `identity_accounts_status_check`: `status IN ('pending','active','isolated_test')`
- `identity_accounts_sub_when_linked`: `(status='pending' AND cognito_sub IS NULL) OR (status IN ('active','isolated_test') AND cognito_sub IS NOT NULL)`

The repair only ever changes `cognito_sub` (non-null → non-null) and
`linked_at` on rows that stay `status='active'` throughout — every constraint
above remains satisfied by construction; `application_user_id` and `email`
are never written.

Before applying anything, a **dry-run "plan" mode** (still fully read-only,
explicit `ROLLBACK` regardless of outcome) re-verified, for each of the 8
proposed `(application_user_id, oldSub → newSub)` links:

1. The live row's current `cognito_sub` still equals the `oldSub` observed in
   Phase 1 (guards against a race since inventory).
2. The live row's `status` is still `'active'`.
3. No other row in `identity_accounts` already holds the proposed `newSub`
   (collision check against the **entire** table, not just the 8 target
   rows).
4. No two of the 8 proposed `newSub` values collide with each other.

Result: `guardFailures: []`, `duplicateNewSubsWithinRequest: []`,
`totalIdentityAccountsRows: 11` (unchanged). All 8 links were provably safe to
apply with **zero** collision risk before any write was attempted.

## Phase 3 — controlled repair (evidence)

All 8 rows were repaired in a **single atomic transaction**
(`BEGIN` → `SELECT … FOR UPDATE` row locks re-running every Phase 2 guard →
8 guarded `UPDATE`s → post-write verification → `COMMIT`), matching the
one-row-per-application-user model and guarded-`UPDATE` shape already
established by PR #217:

```sql
UPDATE public.identity_accounts
   SET cognito_sub = $newSub,
       linked_at = now()
 WHERE application_user_id = $applicationUserId
   AND cognito_sub = $oldSub
   AND status = 'active';
```

If any guard had failed, or any single `UPDATE` had affected `0` or `>1`
rows, the entire transaction would have rolled back with **no** partial
writes — this did not happen; all 8 updates affected exactly 1 row each.

Post-write, still inside the same transaction, the following were asserted
before `COMMIT`:

- `identity_accounts` row count is still **11** (no row created or deleted).
- No duplicate `cognito_sub` values exist anywhere in the table.
- Each of the 8 rows now has `cognito_sub` equal to its intended production
  sub.
- `tenant_users`/`user_roles`/`profiles` row counts for each of the 8
  `application_user_id`s are **byte-for-byte identical** before and after
  (`sideEffectDrift: false`).

| application_user_id | `cognito_sub` before | `cognito_sub` after | `linked_at` after | Tenant memberships (unchanged) | Roles (unchanged) |
|---|---|---|---|---|---|
| `b100f05d-9e81-4a7b-b9cc-9baf173131d9` | `2498c4b8-f0a1-701b-da4b-a1f5c79f675a` | `34c8a478-e0d1-70f3-3c49-02225e7404b6` | `2026-09-14 10:07:27 UTC` | 0 | 1 |
| `fd857564-9534-4b0f-95ac-624ed1273725` | `e418f488-4011-7046-5a09-3f8b51140899` | `74286478-c0c1-7068-9fea-9deea6f61627` | `2026-09-14 10:07:27 UTC` | 1 | 1 |
| `abd3c2a0-6dc0-4680-92dd-a013e1141c91` | `04d85458-1041-7017-a8e8-b2f3f0a5b75b` | `f468b438-4081-7004-d865-a1b86eb19beb` | `2026-09-14 10:07:27 UTC` | 1 | 1 |
| `3af0234c-de1b-4819-938d-fa4f9390811b` | `84185468-a041-70e7-6f61-c6c63f4aff19` | `24d874d8-80d1-7092-7f34-48b8704702f8` | `2026-09-14 10:07:27 UTC` | 1 | 1 |
| `30d0505c-bcfa-4732-81fd-869dc46da5dd` | `14187428-90d1-70f2-95f3-10844b186461` | `34388468-a021-7036-c34d-2ff14a20ed40` | `2026-09-14 10:07:27 UTC` | 1 | 1 |
| `7dbb3009-f059-4767-b5dc-1c5c72379330` | `c4386408-60e1-70e2-abb6-e6194e8e635f` | `a45884b8-d051-70b3-b19d-ca704964c6e8` | `2026-09-14 10:07:27 UTC` | 1 | 1 |
| `0160a5f3-30a4-4aba-8e54-6529f1ceb0d4` | `5458c4f8-1081-701d-10cf-02a993311263` | `d418a4f8-80f1-70d6-36c9-fe490220bf4a` | `2026-09-14 10:07:27 UTC` | 1 | 1 |
| `e2ad0849-c6b6-4f4a-a68a-8c52f563c6fd` | `34a8e428-6071-70b2-92de-fc7e3fd74f14` | `647894c8-2011-70d4-e874-efd4b080700e` | `2026-09-14 10:07:27 UTC` | 1 | 1 |

No `application_user_id`, no `email`, no `tenant_users` row, no `user_roles`
row, no `profiles` row, and no Cognito user attribute (MFA, enabled, status)
was created, deleted, or modified by this repair. Only `cognito_sub` and
`linked_at` changed, on exactly these 8 rows.

A follow-up read-only re-query (same guard logic, `oldSub` set to the new
production value) confirmed all 8 rows now read back as expected, with
`identity_accounts` still at 11 total rows.

## Phase 4 — validation

`aws/cutover/scripts/t0-app-smoke.mjs` was updated to default to the same
CloudFront-fronted origin the live SPA uses (`https://checksops.com/prep`,
overridable via `T0_API_BASE`) instead of the raw `execute-api` origin,
because the production API perimeter now rejects direct `execute-api` calls
that lack the `x-checksops-origin-verify` header CloudFront injects (see the
preflight STOP report). This is a durable fix to the test script itself, not
a temporary debug change.

Re-run against `https://checksops.com/prep` after the repair:

- **Authentication**: both T0 accounts (tester, C1C admin) authenticated
  through the production Cognito pool.
- **`/identity/me`**: `200`, `applicationUserId` correctly resolved for both
  accounts, no `identity_not_linked`.
- **`/identity/session`**: `200`, `applicationUserId` correctly resolved for
  both accounts, no `identity_not_linked`.
- **`/data/query`**: `200` for both; tester read 194 `check_intake_items`
  rows, C1C admin read 37, each account seeing **its own tenant only**
  (`overlapTenants: 0`, `tenantsDiffer: true`).
- **`/ops/readiness`**: `200` for both accounts.
- **`/providers/status`** (safe, read-only provider status): `200` for both
  accounts, no error.
- **`/financial/prepare`**, **`/financial/simulate-submit`**: both rejected
  (`400`/`404`) — no financial execution occurred, consistent with
  `AWS_FINANCIAL_PERMISSIONS_ACTIVATED`/permission gates already documented as
  `activated: false` in the preflight report.
- **Storage**: signed URLs succeeded for both a historical and a current
  check image.
- **Safe write**: a non-financial `check_message_reads` upsert succeeded
  (`200`, `ok: true`).
- Overall smoke script verdict: `"ok": true`.

One nested legacy assertion inside the smoke script's own report
(`tenantIsolation.pass`) still reads `false`, because it was written to expect
the C1C test account to see **zero** rows (`c1cRows.length === 0`). That
account now legitimately has 37 real rows in its own tenant. The authoritative
isolation proof — zero overlap between the tenant IDs visible to the two
accounts (`overlapTenants: 0`) plus `tenantsDiffer: true` — holds. This stale
assertion was not modified as part of this task since fixing test-script
assertions was out of scope here; it is called out explicitly so it is not
mistaken for a new isolation defect.

### The other 6 production identities

Per instruction, credentials for the other 6 real production accounts
(`claims@freedomadj.com`, `asukanick@condition1commercial.com`,
`support@homeheropros.com`, `mcarletta@freedomadj.com`,
`lhogan@condition1commercial.com`, `barzziniconstructiongroup@gmail.com`) were
**not** reset and no login token was minted for them — only the two
dedicated T0 test accounts go through `admin-set-user-password` +
`initiate-auth`. Their validation is:

- The same Phase 3 before/after DB evidence above, which already proves each
  of these 6 rows now holds its correct production `cognito_sub`, with
  `status='active'` and zero drift in tenant/role/profile rows.
- A read-only `admin-get-user` check (no write) for all 8 accounts confirmed
  `Enabled: true`, `UserStatus: CONFIRMED`, `PreferredMfaSetting: null`,
  `UserMFASettingList: null` for every one of the 8 — identical to their
  state before this task. MFA enrollment was not touched, consistent with the
  Do-Not list.

### Tenant/role drift check

No tenant or role drift occurred: `sideEffectDrift: false` for all 8 rows in
the Phase 3 evidence above, and the live T0 smoke test independently confirms
each account still resolves to its correct tenant.

## What this repair did NOT do

- Did not create any new application user (`profiles`/`tenant_users`/`user_roles`
  row count is unchanged for all touched IDs).
- Did not delete any user.
- Did not alter tenant membership or roles.
- Did not change MFA enrollment (verified read-only, before this task and
  after).
- Did not enable CheckAlt.
- Did not activate provider permissions.
- Did not initiate money movement (`/financial/prepare` and
  `/financial/simulate-submit` both still reject).
- Did not deploy the SPA. `checksops.com` continues to serve the existing
  Supabase-mode bundle (`assets/index-ByTwb1fQ.js`) documented in the
  preflight report; this task only repaired backend identity-linking data.
- Did not modify `aws/identity/expected-mappings.mjs` (it is a
  staging-onboarding reference file with staging-pool sub values; updating it
  was out of scope for this production data repair).
- Did not modify, or leave running, any Lambda function other than the
  temporary, distinctly-named one created and deleted for this task.

## Design recommendation for preventing recurrence (not implemented here)

**Root cause**: `checksops-production-prep-api` and
`checksops-staging-rehearsal-oneshot` connect to the **same physical**
`checksops` Postgres database, and `public.identity_accounts` has exactly one
`cognito_sub` column per `application_user_id` (`UNIQUE(cognito_sub)`,
`PRIMARY KEY(application_user_id)`). A production sub and a staging sub for
the same application user can never coexist in that one column. Any
staging-oriented reconciliation/onboarding script that writes the staging
pool's subs for these 8 shared application users (for example,
`aws/identity/oneshot/onboard.mjs`'s `reconcileKnownUsers`/`applyLinks`,
driven by the static staging subs in `aws/identity/expected-mappings.mjs`) —
even when run only against a rehearsal/staging schema most of the time — will
silently clobber the production link the instant it (or something like it) is
pointed at the shared `checksops` database, because the same 8 rows are the
only rows that exist for these users. This is exactly what happened to the
Freedom admin account between 2026-09-10 (fixed by PR #217) and 2026-09-11
(regressed), and it is why all 8 production accounts — not just the two T0
accounts — were found `STAGING_SUB` in Phase 1 of this task.

**Recommendation**: make it structurally impossible for a staging Cognito sub
and a production Cognito sub to compete for the same column. Concretely,
replace the single `cognito_sub` column with a per-pool mapping — e.g. a
child table `identity_accounts_cognito_links(application_user_id, cognito_user_pool_id,
cognito_sub, linked_at)` with `UNIQUE(cognito_user_pool_id, cognito_sub)` and
`UNIQUE(application_user_id, cognito_user_pool_id)` — and have
`LOOKUP_MAPPING_SQL` in `aws/functions/api/identity.mjs` look up by
`(cognito_user_pool_id, cognito_sub)` using the pool id already present in the
verified token's `iss`/`aud` claims. Under that model, a staging onboarding
script writing the staging pool's sub for a shared application user can never
overwrite — or even touch — the production pool's row for that same user,
because they would be different rows keyed by different pool ids. (This
redesign is **not** implemented as part of this task, per instructions — it
is recorded here as a recommendation for a separate, deliberately-scoped
follow-up.)

## Remaining known blockers before SPA cutover

Repairing identity linking removes the blocker reported in the preflight STOP
report. It does **not** by itself clear the SPA for cutover. Per the user's
own sequencing, the following remain and are explicitly deferred to separate
tasks:

- CheckAlt AWS readiness.
- Webhook migration from Supabase to AWS.
- Production data delta/reconciliation.
- Preventing future routine SPA deploys from reverting AWS mode (the SPA
  currently redeploys from `.env.production`, which is Supabase-only, by
  default — see the preflight report).
- The final SPA cutover itself.

`checksops.com` still serves the Supabase-mode bundle
(`assets/index-ByTwb1fQ.js`) at the time of this report. No SPA deploy or
CloudFront invalidation was performed as part of this task.
