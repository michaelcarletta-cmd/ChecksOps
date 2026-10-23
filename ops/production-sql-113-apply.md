# Production SQL 113 (payee setup)

| key | file | what it does |
|---|---|---|
| `sql113` | `aws/workflows/sql/113_payee_setup.sql` (sha256 `871d953df9ebb066601993ea6c36ec8162bd9664b813f27eccbf972e07d9f3ad`) | `ADD COLUMN IF NOT EXISTS` of the payee state on `public.external_payment_recipients` (`tos_accepted_at`, `identity_submitted_at`, `bank_verified_at`, `verified_at`, `disconnected_at`, `provider_bank_account_id`, `setup_attempts integer NOT NULL DEFAULT 0`, and, where an older copy lacks them, `stakeholder_account_id`, `provider_bank_name`, `provider_last_four`, `bank_linked_at`; no identity, account or routing number); `stakeholder_accounts_origin_check` gains `provider_recipient` (replaced only from the exact four-value check of supabase `20260728110453`, any other value set refuses with 55000 `sql113_origin_check_unexpected`); `GRANT SELECT ON public.external_payment_recipients TO checksops, authenticated`; six SECURITY DEFINER functions (`search_path = public`, EXECUTE revoked from PUBLIC and granted to `checksops` only): `aws_payee_create`, `aws_payee_reissue_link`, `aws_payee_disconnect`, `aws_public_payee_by_token`, `aws_public_payee_record`, `aws_payee_apply_status`. No policy, RLS flag, other grant or other table's column changes; nothing moves money. |

**Why.** The Moov recipient flow exists only for sandbox (`providers/parity/moov-onboard.mjs`):
its rows are written by the browser or a tenant session under RLS, the `/pay-setup` link has no
anonymous path on AWS, its handlers write `external_payment_recipients` columns no migration
creates, and its stakeholder row uses origin `provider_recipient`, which the supabase origin check
refuses. `external_payment_recipients`' grants came from a supabase migration the AWS copy restored
without ACLs, and no `aws/workflows/sql` migration grants it to `checksops` (as SQL 104, 105 and 112
found for other tables). SQL 113 gives the production payee flow its columns, its origin, its read
grant and six definer functions: tenant-side ones check that `auth.uid()` is a member of the tenant
(`aws_user_tenant_ids()`), public ones are keyed by the secure link token alone, and a payee becomes
payable (stakeholder `verification_status` `verified` with its Moov account and bank ids) only
through `aws_payee_apply_status('verified')` after terms, identity and a verified bank.

**Expected outcome of the inspect.** `already_applied` false with `precondition_failures` `[]`
(the functions absent; whichever columns, origin check and grants production holds are recorded in
the fingerprint). Anything else (a precondition failure, a missing table, column, role or helper,
a login that cannot write the payee tables as a definer) stops and needs its own reviewed change.
The origin check is not a precondition of the engine: the file itself refuses a value set other
than the four supabase values, so an inspect that shows `stakeholder_accounts_origin_check`
`different` must be read before any apply.

**Staging executor refreshed (2026-10-23).** Inspect run 40017771702 (main `ac2860a5a`) found the
live executor at CodeSha256 `51tMc1XF…` without SQL 113 (adds only `sql/113_payee_setup.sql`,
supersedes the three engine files, nothing dropped, no collisions). Deploy run 40018037771 updated it
to main's package (`hU2AzlaR…`).

**Staging read-live (2026-10-23).** Run 40018316361 (main `ac2860a5a`): the six functions absent;
`stakeholder_account_id`, `provider_bank_name`, `provider_last_four` and `bank_linked_at` already the
file's, the seven payee state columns absent; `stakeholder_accounts_origin_check` `different` (not yet
the five-value check; the file replaces only the exact four-value supabase check and refuses any
other); `checksops` holds `SELECT` (and `UPDATE`, outside the fingerprint) on
`external_payment_recipients`, `authenticated` none of the pinned lines; definer writes ok on the three
payee tables. Live `88787a89c85585f25c18ea31d60740a6526522377a1b0d7b02e7902fe18970c1`,
`already_applied` false, `precondition_failures` `[]`. Recorded in the staging pin
(`expected_live_definition_sha256`, `execute: true`, wave 14) under the owner's words of
2026-10-23, "Apply SQL 113 to staging".

**Staging apply (2026-10-23).** After the staging pin change merged (#1207, main `b6e8d56bf`),
inspect run 40021640429 found the executor without the new pin (`hU2AzlaR…`, supersedes
`lib/sql-executor-auth.mjs`); deploy run 40021885543 updated it (executor
`nloTNyc3Hlg8ps1wpeSGqoo6FTnX9NHOKT5TcfN3FIg=`). Read-live run 40022139561: live still `88787a89…`.
Apply run 40022413642: `applied`, `88787a89…` ->
`5984d321197bd03552da656381ea47b67220d8f0accac10214aa392fd26f81d7`. Read-live run 40022674916:
`already_applied` true, live = intended; every payee column, the origin check and the six functions
`intended`, `SELECT` on `external_payment_recipients` for `authenticated` and `checksops`, each
function `EXECUTE` `checksops` and the owner only.

**Production inspect (2026-10-23).** Read-only `--inspect` through SSM
`8ee0c634-8fa3-457e-88aa-adbeb392b4fc` on `i-0c35557c4e5385406`, main `b6e8d56bf` (tarball sha256
`df13b10343fb19667dcfd5309d06f836b1b0e2e2c0cfc253066a8236d81b05a8`, transfer run 40023140920, migration
source `871d953d…` == pin), connected as `checksops_admin`, `read_only` true, `source_ok` true: the
six functions absent; `stakeholder_account_id`, `provider_bank_name`, `provider_last_four` and
`bank_linked_at` already the file's, the seven payee state columns absent;
`stakeholder_accounts_origin_check` `different`; `checksops` holds `SELECT` on
`external_payment_recipients` (and `UPDATE` and `DELETE`, outside the fingerprint and unchanged by
SQL 113), `authenticated` none of the pinned lines; definer writes ok on the three payee tables.
Live `88787a89c85585f25c18ea31d60740a6526522377a1b0d7b02e7902fe18970c1` (the same pre-state as
staging), `already_applied` false, `missing_dependencies` `[]`, `precondition_failures` `[]`.

**Production pin (2026-10-23).** Under the owner's words "Approve SQL 113 for production" the
production pin records the inspect above as its pre-state (`88787a89…`) and the staging apply run
40022413642 from the same pre-state as its staging acceptance, and sets `execute: true`. The owner
reviews and merges it; nothing is applied by it.

**Status:** applied to staging and to production (2026-10-23); the production pin is retired
(`execute: false` again; see "Production apply of SQL 113").

## Production apply of SQL 113 (2026-10-23)

The owner's statement of 2026-10-23 was "apply SQL 113 in production and merge 1209 when green",
passed verbatim (base64, `--approval-statement-b64`). The one-shot cannot verify who said it, and the
statement covered this run only. `production-sql-one-shot.mjs --migration sql113 --approval-scope
sql113` on `i-0c35557c4e5385406`, operator `michaelcarletta-cmd`, workstream
`prod-sql113-payee-setup-20261023`, from main `09425a013` (tarball
`source-09425a01389ce92e703f34eb2bcc526d532f1c13.tar.gz`, sha256 `201d6e08…`, transfer run
`40028392875`, `sql53-temporary-transfer.yml` dispatched on main after the #1209 merge; its package
job printed `TARBALL_SHA256 201d6e0840d0aba76c7d1378ad8782acbfbaf26c3f6a47a8b612753c0d77b3ef`).

- **Inspect phase:** SSM `f77ae429-c9e4-458d-9152-06bf767f28c1`, run_id
  `cc5c4e70-5ce2-4811-962f-d985ef82255a`, approval statement "apply SQL 113 in production and merge
  1209 when green": pin, source, inspect and contracts ok, nothing written; live
  `88787a89…` (live_matches_expected true), already_applied false, precondition_failures [],
  apply_preconditions_met true.
- **Apply phase:** SSM `9f209788-6247-47ed-bc6e-838d5791a42e` (2026-10-23T21:42:38Z to 21:42:54Z),
  run_id `594619a2-671f-45f5-a260-7f991d5007ef`, one_use_id
  `sql113-prod-86f11689-ab1d-4459-9f15-10ff2d135818` (spent): every step ok (pin, source, inspect,
  contracts, manifest, source-recheck-before-preflight, preflight (receipt issued), evaluate
  (`sql113_production_apply_allowed` true), source-recheck-before-apply, apply (applied),
  post-apply-inspect); migration source `871d953d…` (== pin); pre-apply inspect live `88787a89…`,
  predecessors `{}`, precondition_failures []; contracts claim-ledger 4/4,
  tenant-isolation 6/6, financial-write-protections 43/43; manifest `be0e945a…`; receipt `88787a89…`
  -> `5984d321…`, result applied, unrelated catalog `d080ebf0…` (relations 890, columns 3531,
  constraints 2232, policies 404, functions 1320, indexes 654, triggers 180, views 25, types 18, roles
  29, role memberships 15); post-apply inspect live `5984d321…` (= intended), already_applied true,
  precondition_failures []. The six payee functions are `intended`, each with EXECUTE for `checksops`
  and the owner only; all eleven payee columns and `stakeholder_accounts_origin_check` are `intended`;
  `external_payment_recipients` grants `SELECT` to `authenticated` and `checksops` (`checksops` DELETE
  and UPDATE there unchanged, `other_write_grants`); definer writes ok on the three payee tables.

No later read-only inspect is recorded. The pin is `execute: false` again; a re-apply needs a new
reviewed pin change.

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec
`functions`, `added_columns`, `constraints` and `table_privileges` in `release-sql-specs.mjs`):
each function's language, volatility, parallel, SECURITY DEFINER, result, proconfig, sha256 of its
body (from the file bytes) and EXECUTE ACL; each added column's type, NOT NULL, default and column
ACL; the origin check's definition; the SELECT grants of `checksops` and `authenticated` on
`external_payment_recipients`; or `absent` per object. Intended
`5984d321197bd03552da656381ea47b67220d8f0accac10214aa392fd26f81d7`:

```
release sql113 v1
function public.aws_payee_create(uuid, uuid, text, text, text, text, text, text, text, timestamp with time zone, uuid, uuid): lang=plpgsql vol=v parallel=u secdef=true result=jsonb config=search_path=public prosrc=42a0082c917a811c77088952c7a14067dccb5b0dfdfc7c785ce118b94a8c5bc4 acl=checksops EXECUTE;owner EXECUTE
function public.aws_payee_reissue_link(uuid, text, timestamp with time zone): lang=plpgsql vol=v parallel=u secdef=true result=jsonb config=search_path=public prosrc=a0c7036f5b88432f52e1caa32e87f4a266384968ff423301762fb27888d37d35 acl=checksops EXECUTE;owner EXECUTE
function public.aws_payee_disconnect(uuid): lang=plpgsql vol=v parallel=u secdef=true result=jsonb config=search_path=public prosrc=2ab5b7dd8fef1feaa46db4049223f4baf80671f272e2a9557250da242378de21 acl=checksops EXECUTE;owner EXECUTE
function public.aws_public_payee_by_token(text): lang=plpgsql vol=s parallel=u secdef=true result=jsonb config=search_path=public prosrc=2d86403632f9d1626a4d9b2cadbacaf351d3649d4b29a64b5813f72184ac54ac acl=checksops EXECUTE;owner EXECUTE
function public.aws_public_payee_record(text, text, jsonb): lang=plpgsql vol=v parallel=u secdef=true result=jsonb config=search_path=public prosrc=7a0aa3199e3e4da53d3a563288e80f98b8a8f7465855961b2f14a16b27b6d2f2 acl=checksops EXECUTE;owner EXECUTE
function public.aws_payee_apply_status(text, text, text): lang=plpgsql vol=v parallel=u secdef=true result=jsonb config=search_path=public prosrc=b2cbe2f2a153e59305c90bb6f2cff381ddfde3f53a59dfae7ebd1a11f872c08f acl=checksops EXECUTE;owner EXECUTE
column public.external_payment_recipients.stakeholder_account_id: uuid notnull=false default=- acl=
column public.external_payment_recipients.provider_bank_name: text notnull=false default=- acl=
column public.external_payment_recipients.provider_last_four: text notnull=false default=- acl=
column public.external_payment_recipients.bank_linked_at: timestamp with time zone notnull=false default=- acl=
column public.external_payment_recipients.provider_bank_account_id: text notnull=false default=- acl=
column public.external_payment_recipients.tos_accepted_at: timestamp with time zone notnull=false default=- acl=
column public.external_payment_recipients.identity_submitted_at: timestamp with time zone notnull=false default=- acl=
column public.external_payment_recipients.bank_verified_at: timestamp with time zone notnull=false default=- acl=
column public.external_payment_recipients.verified_at: timestamp with time zone notnull=false default=- acl=
column public.external_payment_recipients.disconnected_at: timestamp with time zone notnull=false default=- acl=
column public.external_payment_recipients.setup_attempts: integer notnull=true default=5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9 acl=
constraint public.stakeholder_accounts stakeholder_accounts_origin_check: 274bd6d1db8df9c560fa649972c2123a30a6e1fb98c28dc6fdcb0ab8d46bc911 validated=true
privileges public.external_payment_recipients SELECT: authenticated SELECT;checksops SELECT
```

Every other grant on `external_payment_recipients` (the owner's, `service_role`'s where it exists)
is outside the fingerprint; the post-condition `other_table_privileges_unchanged` requires it
unchanged.

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present` (the three payee tables, `tenants`, `tenant_users`,
`public.aws_user_tenant_ids()`, `auth.uid()`, roles `checksops` and `authenticated`, and every
column the functions read or write); `altered_relations_owned_by_login`
(`external_payment_recipients` and `stakeholder_accounts`); `definer_can_write_relations` (the
three payee tables, no FORCE ROW LEVEL SECURITY); `functions_owned_by_login` and
`function_acl_replaceable` (a function that already exists); `added_columns_absent_or_intended`
(a payee column that already exists must already have the file's type, NOT NULL, default and no
column grant). No predecessor.

Post-conditions: the intended fingerprint; the functions owned by the login;
`other_table_privileges_unchanged`; everything else in schema `public` (and the functions of
`auth`) unchanged, the added columns, the origin check and `external_payment_recipients`' ACL
excepted. The tools roll back otherwise.

## Order

No predecessor and no order. Apply SQL 113 before the API change that calls the payee functions;
until then those calls fail with 42883. No later migration replaces it.

## Steps

1. Staging: the staging executor must carry SQL 113 first (executor package refresh through
   `sql-executor-ensure.mjs` / the guarded staging executor `deploy` mode, its own reviewed run).
   Then run the guarded staging SQL executor with `read-live` for `sql113-payee-setup`. If it
   reports `already_applied` false and `precondition_failures` `[]`, record
   `LIVE_DEFINITION_SHA256` in the staging pin (`expected_live_definition_sha256`, owner-approved
   `authorization`, `execute: true`) in a reviewed change, `apply` with the owner's approval of
   that run, then `read-live` again (expected `already_applied` true). Anything else: stop and
   record it in its own reviewed change.
2. Production: run the read-only inspect on the runner
   (`node scripts/deployment-guard/sql113-payee-setup-production-apply.mjs --inspect`, or the
   one-shot's `--phase inspect`); record `production_inspect`, copy `live_definition_sha256` into
   `expected_live_definition_sha256`, record the staging runs in `staging_acceptance`, and set an
   owner-approved `authorization` and `execute: true`, in one reviewed change.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs
   --migration sql113 --approval-scope sql113 … --phase inspect`, then the owner-named
   `--phase apply`.
4. Record the apply and retire the pin (`execute: false`).
