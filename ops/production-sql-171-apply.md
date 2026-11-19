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

**Status:** tooling built; staging and production pins pending (`execute: false`). Nothing applied or read. Staging
wave 63 when approved (SQL 170, the endorsement email status, takes wave 62).

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
