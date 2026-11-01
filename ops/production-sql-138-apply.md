# Production SQL 138 (payee setup link records no step once the payee is verified)

| key | file | what it does |
|---|---|---|
| `sql138` | `aws/workflows/sql/138_payee_setup_link_closed_after_verification.sql` (sha256 `b4b3da5a22c18d69c143cf7e9f2add93be197304c65b70e11213d45b24392ef9`) | Refuses without SQL 113's payee setup (`55000 sql138_prerequisite_missing`), when the applying login could not write `external_payment_recipients` and `payment_provider_methods` as a DEFINER owner (`55000 sql138_definer_cannot_write`) or does not own `aws_public_payee_record` (`55000 sql138_function_not_owned`). Then `CREATE OR REPLACE` of SQL 113's `aws_public_payee_record(text, text, jsonb)` (`plpgsql`, `VOLATILE`, `SECURITY DEFINER`, `search_path = public`, `RETURNS jsonb`, unchanged), `REVOKE ALL ... FROM PUBLIC`, `GRANT EXECUTE ... TO checksops` and `COMMENT ON FUNCTION` on it. No other statement. |

**Why.** Security audit 2026-10-29, finding 18 (low). SQL 113's public link writer
`aws_public_payee_record(_token, _event, _data)` checks only that the payee is not disconnected, that
the link has not expired (`token_expires_at`, 14 days from the email) and the attempt counter; it
never looks at `verified_at`, and `aws_payee_apply_status('verified')` keeps `secure_token`. Until the
link expires, a `bank_linked` event for a verified payee disconnects the verified bank's
`payment_provider_methods` row and connects another one (`onboarding_status` stays `verified`), and
the API (`aws/functions/api/providers/payees/handlers.mjs`, `publicBankAdd` with `replace_bank: true`)
then removes the previous bank at the payment provider. A leaked link can therefore replace a
verified payee's bank. Owner 2026-10-31: "Okay, let's do option A and fix it correctly for SQL 138".

The product has no verified bank change through a link: `aws_payee_reissue_link` refuses a verified
payee (`already_verified`), the API's `publicIdentity` refuses one, and the page
(`src/pages/RecipientPaymentSetup.tsx`) offers "Use a different bank account" only on the Verify step,
before setup is complete. No call of the legitimate flow records a step after verification.

**What it changes.** One function, `aws_public_payee_record(text, text, jsonb)`: SQL 113's body plus
one check after the row is read `FOR UPDATE` (so an event that waited on a concurrent
`aws_payee_apply_status` sees its `verified_at`):

```sql
IF rec.verified_at IS NOT NULL THEN RETURN jsonb_build_object('error', 'already_verified'); END IF;
```

Once the payee is verified, every event (`tos_accepted`, `identity_submitted`, `bank_linked`,
`bank_verified`, any other) is refused and nothing is written: no `setup_attempts` increment, no
`payment_provider_methods` row, no payee column. The `not_found`, `disconnected`, `expired` and
`rate_limited` answers and every step of an unverified payee (including replacing a bank that is not
yet verified) are unchanged.

- Why `verified_at`: the column the product reads as setup complete (reissue, the API, the page).
  `token_used_at` is set in the same `UPDATE`, but reissue does not clear it and the column predates
  SQL 113, so it could be set on a payee still setting up.
- Why `already_verified`: the code SQL 113 already uses for this state (`aws_payee_reissue_link`). The
  public handlers map a code outside `LINK_ERRORS` to 400 `setup_step_refused` "This step could not
  be saved." (inline, not a 500, not a terminal page); `syncPayee` ignores a refused record. `expired`
  or `disconnected` would tell a verified payee something untrue, and the legitimate flow never
  reaches this answer.

EXECUTE stays `checksops` and the owner (`CREATE OR REPLACE` keeps the ACL; the file restates SQL 113's
`REVOKE` from `PUBLIC` and `GRANT` to `checksops`).

Not changed: `aws_public_payee_by_token` (the link still reads the payee's state, so the page still
shows "You're all set" after verification), `aws_payee_create`, `aws_payee_reissue_link` (a tenant's
new link for an unverified payee still replaces `secure_token`, closing the old link),
`aws_payee_disconnect`, `aws_payee_apply_status`; no table, column, constraint, policy, RLS setting,
table grant, trigger or row. No API, Lambda or SPA change is part of this file or its pins.

**Known API residue (outside this file).** `publicBankAdd` creates the bank account at the payment
provider (`addPayeeBank`) before it calls `aws_public_payee_record`. After SQL 138 a leaked link can
still attach an unverified extra bank account to a verified payee's provider account; the refused
record stops the API before its `disableBank` of the verified bank (which runs only after the record
succeeds), and the database keeps the verified bank on the stakeholder and `payment_provider_methods`
rows. Closing that needs an API check before the provider call: a separate guarded Lambda change.

**Predecessor.** SQL 113 (`ops/production-sql-113-apply.md`, applied to production on 2026-10-23): the
engine refuses SQL 138 (`predecessors_applied`) until SQL 113's objects are at SQL 113's intended
state. SQL 138 supersedes SQL 113 (as SQL 101 supersedes SQL 90): after SQL 138, SQL 113 counts as
applied only while every other SQL 113 object still matches (staging pin
`superseded_intended_sha256.sql113` `b4e3cf0c6dec304d3121a45b964537abdc364391e279486046b48fe9e88464fa`,
`releaseSupersededIntendedHash`).

**Staging executor refreshed (2026-10-31).** Inspect run 41239489521 (main `ca7de0ab9`) found the live
executor at `sIf1rFWcrsTF2+B9dYSRe1c6Ydn1qI+V/8o8lG5ceXE=` (LastModified 2026-10-31T20:00:13Z, the
SQL 137 pin's executor) without `sql/138_payee_setup_link_closed_after_verification.sql` (main's
package also superseded three libraries). Deploy run 41239673718 (main
`ca7de0ab91152d512115b0a111bb4e92d29ee6d1`, `expected_executor_code_sha256` `sIf1rFWc…` matched)
updated `checksops-staging-guarded-sql-executor` to main's package
(`ceZWvwT9XGRuGDhID92gv8qB/PGFcv6sLi2fJukgixk=`, LastModified 2026-10-31T20:38:33Z). Corrected
2026-11-01: the version of this paragraph merged with the staging pin (#1500) named the SQL 137
runs' executor hashes (`m30FadRm…` before, `sIf1rFWc…` after), read from the wrong logs; the values
above are from runs 41239489521, 41239673718 and 41239902526 themselves. The staging pin's recorded
values (`expected_live_definition_sha256`, run 41239902526) are unaffected.

**Staging read-live (2026-10-31).** Run 41239902526 (main `ca7de0ab9`, executor `ceZWvwT9…`, pin
commit `c7c960f85`): `aws_public_payee_record(text, text, jsonb)` state `different`, its EXECUTE ACL
`checksops EXECUTE`, `owner EXECUTE`; `predecessors.sql113` true, `successors_applied` `[]`, both
definer writes (`external_payment_recipients`, `payment_provider_methods`) ok. Live
`ec36c29e3472a9777b4a1d08ff7c3da5c00b1dc70cb4b754ef5b04ff0e73633c`, equal to the derived
pre-state below; intended `9acaf809…`, `already_applied` false, `precondition_failures` `[]`,
`prerequisites_missing` `[]`. Recorded in the staging pin (`expected_live_definition_sha256`,
`execute: true`, wave 33) under the owner's words of 2026-10-31, "record the SQL 138 staging pin".
The staging apply itself is a separate run after this pin is merged and the executor carries it, on
the owner's words for that run. Production is read by its own inspect.

**Staging executor refreshed for the pin (2026-11-01).** The staging pin (wave 33, PR #1500) merged as
`6120c6480c49839c1450cdd74b49ae16fb624fb7`. Inspect run 41259961304 (main `6120c6480`) found the live
executor at `ceZWvwT9XGRuGDhID92gv8qB/PGFcv6sLi2fJukgixk=` (`executor_current` false; main's package
superseded `lib/sql-executor-auth.mjs` only). Deploy run 41260150790 (`expected_executor_code_sha256`
`ceZWvwT9…` matched) updated `checksops-staging-guarded-sql-executor` to main's package
(`9Hk1JOXAxS5SFjfXeEp7PXItiqVY5Z7jOuWuYXk0dZE=`, RevisionId `6b55618b-bb19-4596-9749-9455f7975590`;
`staging_api_untouched` true).

**Staging apply (2026-11-01).** Apply run 41260586254 (main `6120c6480`, executor `9Hk1JOXA…`,
`executor_current` true, pin commit `c7c960f85`, `expected_live_definition_sha256`
`ec36c29e3472a9777b4a1d08ff7c3da5c00b1dc70cb4b754ef5b04ff0e73633c`) under the owner's words "apply
SQL 138 in staging": success. The receipt (job 124712852864) prints `result` `applied`,
`before_hash` `ec36c29e…`, `after_hash`
`9acaf809824101d8ef62098e6440ca5d06cda1bec4117118c53931130efadf48`, `executor_identity`
`checksops-staging-guarded-sql-executor`; `aws_public_payee_record(text, text, jsonb)` in state
`intended`, its EXECUTE ACL `checksops EXECUTE`, `owner EXECUTE`; `predecessors.sql113` true; both
definer writes ok. Read-live run 41260787304 (main `6120c6480`): `already_applied` true,
`live_definition_sha256` `9acaf809…` equal to the intended hash, `precondition_failures` `[]`.
Staging acceptance: a hands-on check is not possible in staging (the setup link is only emailed, never
returned to the browser, and staging email is `AWS_EMAIL_MODE=sink` by the owner's choice). The owner
accepted on 2026-11-01, "accept SQL 138 staging on the tests": the staging apply and read-live above,
and `aws/tests/sql138-payee-setup-link-closed-pg.test.mjs` on PostgreSQL 16 in CI (a verified payee's
link refused with `already_verified` for every write, reads unchanged, an unverified payee's setup and
reissue unchanged). The staging pin keeps `execute: true`; the staging runs are recorded in the
production pin's `staging_acceptance` by the production pin PR.

**Production inspect (2026-11-01).** Read-only `--inspect` through SSM
`0cbe4c6b-5765-4f37-a543-1849ebcfe584` on `i-0c35557c4e5385406` (started 2026-11-01T11:50:46Z under the
owner's words "start the SQL runner for the SQL 138 production inspect", stopped again 11:51:49Z), main
`e8ef1f52d` (tarball sha256 `af52eb51781970da1b36757c9dc4e120d989cf2c96626ac8d93159486dba0552`, transfer
run 41263811958, migration source `b4b3da5a…` == pin), connected as `checksops_admin`:
`aws_public_payee_record(text, text, jsonb)` `different`, its EXECUTE ACL `checksops EXECUTE`,
`owner EXECUTE`; `predecessors` `{"sql113": true}`, `successors_applied` `[]`; both definer writes
(`external_payment_recipients`, `payment_provider_methods`) ok; every prerequisite present; live
`ec36c29e3472a9777b4a1d08ff7c3da5c00b1dc70cb4b754ef5b04ff0e73633c`, `already_applied` false,
`precondition_failures` `[]`. That is the pre-state derived above (the function as SQL 113 left it), the
same one staging had, so the staging apply took the path production will
(`aws/tests/sql138-payee-setup-link-closed-pg.test.mjs`). Recorded in the production pin with the staging
apply (run 41260586254) as its staging acceptance and `execute: true` under the owner's words "record the
SQL 138 production pin"; the owner's words so far name the staging steps, the inspect and this pin, not
the production apply. The owner merges the pin change; the apply still needs the owner's words for that
run and runs only after that merge is on main and staged. The known API residue above is unchanged by
this pin.

**Status:** applied in staging (wave 33, 2026-11-01); staging acceptance: owner accepted on the tests; production pin execute-authorized; not applied to production

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec
`sql138` in `release-sql-specs.mjs`). Intended
`9acaf809824101d8ef62098e6440ca5d06cda1bec4117118c53931130efadf48`:

```
release sql138 v1
function public.aws_public_payee_record(text, text, jsonb): lang=plpgsql vol=v parallel=u secdef=true result=jsonb config=search_path=public prosrc=1bdad3c1f54bcd97932451e8bf0d4d40e86ea4ad69b286b927a934cac91d9b07 acl=checksops EXECUTE;owner EXECUTE
```

**Expected pre-state (both environments).** The function as SQL 113 left it:

```
release sql138 v1
function public.aws_public_payee_record(text, text, jsonb): lang=plpgsql vol=v parallel=u secdef=true result=jsonb config=search_path=public prosrc=7a0aa3199e3e4da53d3a563288e80f98b8a8f7465855961b2f14a16b27b6d2f2 acl=checksops EXECUTE;owner EXECUTE
```

That is `ec36c29e3472a9777b4a1d08ff7c3da5c00b1dc70cb4b754ef5b04ff0e73633c`, derived from SQL 113's
bytes by `aws/tests/release-sql138-executor.test.mjs` and read back from a PostgreSQL 16 database with
SQL 113 applied. Each pin records its own environment's read; neither value is written into a pin
before a run reads it. A pre-state other than this one is a stop: read its per-function report and
ACL and return to the owner.

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present` (`external_payment_recipients` and `payment_provider_methods` with the columns
the function uses, `aws_public_payee_record(text, text, jsonb)`, `aws_public_payee_by_token(text)`,
role `checksops`); `predecessors_applied` (SQL 113); `definer_can_write_relations` (the applying login
owns both tables without `FORCE ROW LEVEL SECURITY`, or is a superuser or `BYPASSRLS`);
`functions_owned_by_login`, `function_results_match` (`jsonb`) and `function_acl_replaceable` (no
EXECUTE grant outside `checksops` and the owner, which the file keeps, and `PUBLIC`, which it revokes).

Post-conditions: the intended fingerprint; the function owned by the login; everything else in schema
`public` (and the functions of `auth`) unchanged. The tools roll back otherwise.

## Steps

1. Staging: the staging executor must carry SQL 138 first (executor package refresh through the
   guarded staging executor `deploy` mode, its own reviewed run). Then run the guarded staging SQL
   executor with `read-live` for `sql138-payee-setup-link-closed-after-verification`. Expected:
   `already_applied` false, `predecessors` `{ sql113: true }`, `precondition_failures` `[]`,
   `live_definition_sha256` `ec36c29e…` (above). If it reports `prerequisites_missing` other than
   `[]`, `precondition_failures` other than `[]` or another pre-state, stop. Otherwise record
   `LIVE_DEFINITION_SHA256` in the staging pin (`expected_live_definition_sha256`, owner-approved
   `authorization`, `execute: true`) in a reviewed change, `apply`, then `read-live` again.
2. Production: run the read-only inspect on the runner
   (`node scripts/deployment-guard/production-sql-one-shot.mjs --migration sql138 … --phase inspect`);
   record `production_inspect` and copy `live_definition_sha256` into
   `expected_live_definition_sha256`; record the staging runs in `staging_acceptance`; set an
   owner-approved `authorization` and `execute: true`, in one reviewed change.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs
   --migration sql138 --approval-scope sql138 … --phase apply` with the owner's words
   (authorization phrase `APPLY_PAYEE_SETUP_LINK_CLOSED_AFTER_VERIFICATION`).
4. Record the apply and retire the pin (`execute: false`).
