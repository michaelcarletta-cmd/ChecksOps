# Production SQL 171 (the phones a signed-in user receives push notifications on)

| key | file | what it does |
|---|---|---|
| `sql171` | `aws/workflows/sql/171_device_push_tokens.sql` (sha256 `40d5fbfbbedf9a6787346f3d5e517857aa20cad37f328f7e0ab2db4dc1a64d59`, authored by `8f9d568d0`) | Refuses without its prerequisites (`55000 sql171_prerequisite_missing`) or when a `public.device_push_tokens` table already exists with other columns (`55000 sql171_unexpected_table`); then creates `public.device_push_tokens` (RLS on, no policy, every non-owner grant revoked) and two new SECURITY DEFINER functions, `public.aws_push_register_device(text, text)` and `public.aws_push_unregister_device(text)`, EXECUTE `checksops` and the owner. |

**Why.** Owner 2026-11-19: app notifications when signatures are received, funds are disbursed or received, the wallet
changes, or a message arrives. The app side (PR 2016, `src/lib/nativePush.ts`) asks permission after sign-in, gets the
phone's push token from Apple or Google and sends it to the API (`push-register-device`). This file is where the API keeps
it. Sending notifications, and reading the tokens to send to, is a later, separate step with its own review; nothing here
sends anything or is read by anything yet.

**What it does.**
- `public.device_push_tokens`: one row per phone token. Columns `id uuid` (primary key, `gen_random_uuid()`), `user_id
  uuid`, `platform text` (`ios` or `android`, CHECK `device_push_tokens_platform`), `token text` (1 to 4096 characters,
  no whitespace, CHECK `device_push_tokens_token_shape`; unique, `device_push_tokens_token_key`), `created_at` and
  `last_seen_at` (`timestamptz`, `now()`), all NOT NULL; index `device_push_tokens_user_idx` on `(user_id, last_seen_at
  DESC)`. ROW LEVEL SECURITY on (not forced), no policy, and the revoke of every non-owner grant (whatever the database's
  default privileges gave the new table, as SQL 118 and SQL 158): only the functions below, which run as the table owner,
  read or write it.
- `aws_push_register_device(_platform text, _token text) RETURNS uuid`: the signed-in user (`auth.uid()`; `42501
  not_authorized` without one) registers this phone. `22023 invalid_platform` / `22023 invalid_token` on a bad platform or
  token. Inserts the token, or moves an existing one to the caller and refreshes `last_seen_at` (`created_at` is kept when
  the same user registers it again, reset when the token moves). A user keeps at most 20 tokens; beyond that the least
  recently seen are removed. Returns the row id.
- `aws_push_unregister_device(_token text) RETURNS boolean`: the signed-in user removes this phone (sign-out,
  notifications turned off). Only the caller's own token is removed; returns whether a row was removed.
- Both functions: plpgsql, VOLATILE, SECURITY DEFINER, `search_path = public`, `row_security = off`, owned by the applying
  login, `REVOKE ALL ... FROM PUBLIC`, `GRANT EXECUTE ... TO checksops`.
- Idempotent: `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`; a second run
  changes nothing.

**Not changed:** no existing table, column, constraint, index, trigger, function, policy, RLS setting, grant or row. No
API, Lambda or SPA change is part of this pin; the API route that calls the functions ships in its own step after this pin
is applied in production.

**Status:** applied in staging (wave 63, 2026-11-19, apply run 44614240107); staging acceptance: the staging apply under the owner's run approval ("deploy and apply SQL 171 on staging"; no separate acceptance statement); applied to production (2026-11-19); the production pin is retired (`execute: false`). Nothing a user sees changes until the API route that calls the functions (`push-register-device`) is deployed.

**Staging read-live (2026-11-19).** Run 44610159066 (main `5b1beac6f`, after executor inspect run 44608135543 and executor deploy
run 44609532435 (executor CodeSha256 `0MpkBqG5…` -> `w7QtT7Tb…`)), under the owner's words "run staging read-live" and
"deploy staging executor": `already_applied` false, `precondition_failures` `[]`, `prerequisites_missing` `[]`; the table
`public.device_push_tokens` and both functions absent. Live
`fb6d8c05258dd4094a5b48c9ca3e703ce4cbc2884bcfa07e81f9c35968a8b555`, equal to the derived pre-state; intended `254a44e1…`. Recorded in the staging pin
(`expected_live_definition_sha256`, `execute: true`, wave 63) on the owner's "approve the SQL 171 staging apply". The
staging apply is a separate run after this pin is merged and the executor is redeployed carrying it, on the owner's words
for that run. The production pin stays pending.

**Staging executor refreshed and staging apply (2026-11-19).** The staging pin for SQL 171 (wave 63, PR #2026) merged as
`dc9e02688b79f83314fd2148f41ba89659902d73`. Deploy run 44613639425 updated the staging guarded SQL executor (CodeSha256
`w7QtT7Tb…` -> `gGHt9f/X…`, `staging_api_untouched` true, `billing_sql44_untouched` true). Apply run 44614240107: expected live
`fb6d8c05258dd4094a5b48c9ca3e703ce4cbc2884bcfa07e81f9c35968a8b555`; after it `device_push_tokens` `intended` (RLS on, 6 columns, 0 policies) and
both functions `intended`, EXECUTE `checksops` and the owner. Read-live run 44614848373: `already_applied` true, `precondition_failures`
`[]`, `prerequisites_missing` `[]`, live `254a44e1fadb60b19715d8d281fbf704d4070e43fb92e9ba35fad95186b717ff` (the intended hash). No separate staging acceptance statement
was given. There is no separate staging record PR for SQL 171: these staging runs are recorded here and in the production pin's
`staging_acceptance` by the production pin PR.

**Production inspect (2026-11-19).** Read-only `--inspect` through SSM `ffa9f784-a7f8-49ff-b10e-895b1aae7f0b` on
`i-0c35557c4e5385406` (under the owner's words "run the SQL 171 production inspect"; runner stopped with no SSM command pending or
in progress, started 21:12:31Z, SSM Online 21:12:47Z, command 21:12:48Z to 21:12:56Z, AWS-RunShellScript, Success, stop issued
21:12:58Z, stopped at 21:13:30Z, all by `user/claude-code`), main `dc9e02688` (tarball sha256
`04ab7add22f12f91829d24d51eb4503ad6961308c57a00193bb1c17869c5e2f6`, checked by `sha256sum -c` on the runner, `SOURCE_COMMIT` matched,
staged by `sql53-temporary-transfer.yml` run 44615906274; the tool ran from the extracted tarball in a temporary directory removed
afterwards; sha256 of the printed sql171 output, computed on the runner,
`f27fb009cfd918a74c4ed9cf15c044b8b83ca6d10d988f18b3f1664a83c870b1`, 2230 bytes), exit 0, `ok` true, `read_only` true, `source_ok` true,
`current_user` `checksops_admin`, `predecessors_applied` true: live `fb6d8c05258dd4094a5b48c9ca3e703ce4cbc2884bcfa07e81f9c35968a8b555` (the table and both functions
absent: the derived pre-state, equal to staging's before its apply), no predecessor, `prerequisites_missing` `[]`, `successors_applied`
`[]`, `already_applied` false, `precondition_failures` `[]`, `apply_preconditions_met` false (no pre-state recorded yet). Production's
pre-state equals staging's (read-live run 44610159066), so the staging apply took the path production will. Recorded in the
production pin with the staging apply (run 44614240107) as its staging acceptance and `execute: true` under the owner's words
"approve the SQL 171 production pin". The owner merges the pin change; the apply runs only after that merge is on main and staged,
under the owner's words for that run (phrase `REGISTER_PHONES_FOR_PUSH_NOTIFICATIONS`).

**Production apply (2026-11-19).** After the pin change (#2027, merged to main as `d3bd9476f` on the owner's words "merge 2027"),
transfer run 44625822986 (`sql53-temporary-transfer.yml`) staged main `d3bd9476f` (tarball sha256
`ddadb58ac09ff51a5a44ec4ad14939acffa68fc72e059f723928902fa8aafb86`, equal to the S3 sidecar, checked by `sha256sum -c` on the runner before each
command; `SOURCE_COMMIT` matched). The runner `i-0c35557c4e5385406` was stopped with no RunShellScript command pending and was started at
22:11:57Z (Online 22:12:14Z) by `user/claude-code`. Under the owner's words "REGISTER_PHONES_FOR_PUSH_NOTIFICATIONS" (passed verbatim to
this run; root volume 39% used): one-shot `--phase inspect` (SSM `f36eab39-9c69-4fde-a561-dbede503359a`, Success, exit 0, steps pin, source,
inspect and contracts ok, nothing written) read live `fb6d8c05…` (`live_matches_expected` true, `already_applied` false,
`apply_preconditions_met` true, `precondition_failures` `[]`); the apply command was sent only after that. Then `--phase apply` (SSM
`64a77757-c18c-4b10-bdfe-b0555632e893`, Success, exit 0, run `6a62cd62-ede8-40bf-a096-3ba44bdd9fbe`, workstream `prod-sql171-device-push-tokens-20261119`, one_use_id
`sql171-prod-19a5dee9-0cde-4c6b-833d-b7754cecd65a`): contracts claim-ledger, tenant-isolation and financial-write-protections ok; all 11 steps ok;
manifest `f7a539de…`; receipt `fb6d8c05…` → `254a44e1fadb60b19715d8d281fbf704d4070e43fb92e9ba35fad95186b717ff` (intended), result `applied`; post-apply inspect
`already_applied` true, `precondition_failures` `[]`, `device_push_tokens` `intended` (RLS on, 6 columns, 0 policies) and both functions
`intended`, EXECUTE `checksops` and the owner. The whole output arrived through SSM (compact copy 14590 bytes, sha256
`0025de9fe1357fbc47826c95e15d1d4df19da42c7b0d07c964f7a9be65f7bf51`, the same as computed on the runner); the two one-shot output files were left on the runner
under `/var/tmp` (small, outside the command's temporary directory). A process check after the apply (SSM
`553c3ea2-025d-437a-a4ad-c6fd58d278d5`) found no one-shot running; the runner stop was issued at 22:12:54Z (stopped 22:13:10Z) by
`user/claude-code`. Recorded in the pin's `applied` and `production_evidence`; `execute` is false again. Production acceptance had not
been reported by the owner when this record was written; this record does not claim it.

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec `sql171` in
`release-sql-specs.mjs`). Intended `254a44e1fadb60b19715d8d281fbf704d4070e43fb92e9ba35fad95186b717ff`:

```
release sql171 v1
function public.aws_push_register_device(text, text): lang=plpgsql vol=v parallel=u secdef=true result=uuid config=row_security=off;search_path=public prosrc=34b69b708253cb0c375555ccb2874fa0e6844a3ff1eba6baa761874d221167e6 acl=checksops EXECUTE;owner EXECUTE
function public.aws_push_unregister_device(text): lang=plpgsql vol=v parallel=u secdef=true result=boolean config=row_security=off;search_path=public prosrc=f57a26fc07e53c40b28ab0a203b63412ae27c6ad880c71b50feb7215dcb9d994 acl=checksops EXECUTE;owner EXECUTE
table public.device_push_tokens: kind=r rls=true forced=false
table public.device_push_tokens column id: uuid notnull=true default=eea9a3e7c2abe43835e2a6fdf92a7d1e6f145ad6dfbfd243fc5d395e5b390a33 acl=
table public.device_push_tokens column user_id: uuid notnull=true default=- acl=
table public.device_push_tokens column platform: text notnull=true default=- acl=
table public.device_push_tokens column token: text notnull=true default=- acl=
table public.device_push_tokens column created_at: timestamp with time zone notnull=true default=28a4dae0461e17af56e979c2095abfbe0bfc45fe9ca8abf3144338a518a1bb8f acl=
table public.device_push_tokens column last_seen_at: timestamp with time zone notnull=true default=28a4dae0461e17af56e979c2095abfbe0bfc45fe9ca8abf3144338a518a1bb8f acl=
table public.device_push_tokens constraint device_push_tokens_pkey: 8c8464f42472e42ee190fc91ca8db79b5351d3a4609040516578d229c56f6fa5 validated=true
table public.device_push_tokens constraint device_push_tokens_platform: 835aebd2c40ebd30447d2df13e661b48ef79a92373125bff6b34f59ceb8bd6a5 validated=true
table public.device_push_tokens constraint device_push_tokens_token_key: a8420b878df4ffc6be2b861b570edcec86d44e6f5123aabb66cc6c78d0a0fc03 validated=true
table public.device_push_tokens constraint device_push_tokens_token_shape: 16fe9eda222770a1376cc7b48d29a63aa58a4abcc77bcfdf51ba54dc0667721e validated=true
table public.device_push_tokens index device_push_tokens_pkey: 879a48d1c79a99960d28f91759c640dce3fcf26e5203f9a9c9817478196ac06d
table public.device_push_tokens index device_push_tokens_token_key: a7b111994ae2c32e3649fe438a2498d2222a0acce92293d4086915d9269d79e9
table public.device_push_tokens index device_push_tokens_user_idx: c96d5338a808af05fbd60faa311974b2c0c39aa8b188c6039bc0a983db232d7f
table public.device_push_tokens policies: 
table public.device_push_tokens triggers: 
table public.device_push_tokens acl: 
```

**Expected pre-state (both environments).** The table and both functions absent:

```
release sql171 v1
function public.aws_push_register_device(text, text): absent
function public.aws_push_unregister_device(text): absent
table public.device_push_tokens: absent
```

That is `fb6d8c05258dd4094a5b48c9ca3e703ce4cbc2884bcfa07e81f9c35968a8b555` (`releaseStateHash('sql171', {})`). Each pin records its own environment's read; neither value is
written into a pin before a run reads it. A pre-state other than this one is a stop.

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present` (`auth.uid()`, `gen_random_uuid()`, role `checksops`); `created_tables_absent_or_intended`
(`device_push_tokens` absent, or exactly the intended table); `functions_owned_by_login`, `function_acl_replaceable` and
`function_results_match` (where the functions are present).

Post-conditions: the intended fingerprint (the new table with no grant to anyone but the owner, owned by the login);
everything else in schema `public` unchanged. The tools roll back otherwise.

## Steps

Each step is its own reviewed PR or run and waits for the owner's words for that step.

1. Staging: the staging executor must carry SQL 171 first (executor package refresh through the guarded staging executor
   `deploy` mode, its own reviewed run). Then `read-live` for `sql171-device-push-tokens`. Expected `already_applied`
   false, `precondition_failures` `[]`, `prerequisites_missing` `[]`, live `fb6d8c05…`. Otherwise stop. Record
   `LIVE_DEFINITION_SHA256` in the staging pin (`expected_live_definition_sha256`, owner-approved `authorization`,
   `execute: true`, wave 63) in a reviewed change, `apply`, then `read-live` again.
2. Production: with the owner's OK for that read, the read-only inspect on the runner
   (`node scripts/deployment-guard/production-sql-one-shot.mjs --migration sql171 … --phase inspect`); record
   `production_inspect`, copy `live_definition_sha256` into `expected_live_definition_sha256`, record the staging runs in
   `staging_acceptance`, set an owner-approved `authorization` and `execute: true`, in one reviewed change.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs --migration sql171
   --approval-scope sql171 … --phase apply` with the owner's words (authorization phrase
   `REGISTER_PHONES_FOR_PUSH_NOTIFICATIONS`).
4. Record the apply and retire the pin (`execute: false`).
5. Then the API: the `push-register-device` route (staging overlay, then production with the owner's words), its own PRs.

Rollback (not part of this pin; a reviewed step of its own if ever needed): drop the two functions and the table. The
phones register again once the API route is back.
