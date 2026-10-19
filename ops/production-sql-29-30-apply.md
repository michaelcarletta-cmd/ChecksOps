# Production SQL 29 and SQL 30 (Mortgage Ops library parity, tenant_documents doc_type CHECK)

Applies only the two unchanged operator packages (release lock `mortgage-ops`,
`source_only_not_applied`):

| key | file | what it does |
|---|---|---|
| `sql29` | `aws/rls/sql/29_mortgage_ops_library_parity.sql` (sha256 `e8d416a5…`) | Five SECURITY DEFINER helpers (desk-agent read of attached `library:mortgage:%` rows on an open or assigned request; the storage-sign path check; the library manage check; the attach INSERT check; the auto-share trigger function `share_library_docs_to_mortgage_request()`), the two policies on `public.mortgage_request_library_documents` (`aws_select_…` SELECT, `aws_write_…` INSERT), the three Lovable policies dropped, and SELECT/INSERT-only grants for `authenticated` and `checksops`. |
| `sql30` | `aws/rls/sql/30_tenant_documents_mortgage_doc_type.sql` (sha256 `d30c7caf…`) | `tenant_documents_doc_type_check` from the 3- or 6-value Supabase predecessor to the 13-value list: the 6 legacy values plus the 7 canonical `library:mortgage:*` values. Template, shingle, siding, catalog and letterhead still need SQL 94. |

**Why.** MortgageOps sync of the Document Library works in the API code
(`aws/functions/api/mortgage-library-docs.mjs`) but needs SQL 29's functions and policies
and SQL 30's CHECK in the database. Neither has ever been applied on AWS (release lock
`mortgage-ops`: `applied: false`). Production evidence (2026-10-16, read-only): zero objects
under `files/tenant-documents/*/library/`; row counts and the SQL 29/30 state are unknown —
the first `--inspect` reports them.

**Status:** not applied anywhere. Staging executor pins `sql29-mortgage-ops-library-parity`
and `sql30-tenant-documents-doc-type` and both production pins are pending
(`expected_live_definition_sha256: null`, `execute: false`, `authorization: "pending"`, no
staging acceptance), so every apply refuses before connecting.

## Order

0. **SQL 103 immediately before SQL 29** (`aws/workflows/sql/103_share_library_trigger_acl.sql`,
   `ops/production-sql-103-apply.md`). Production (inspect 2026-10-19) holds `checksops`
   EXECUTE on `share_library_docs_to_mortgage_request()`, which SQL 29 does not revoke, so
   SQL 29's guard refuses with `function_acl_replaceable` until SQL 103 leaves the owner as the
   only grantee. SQL 29's file and intended fingerprint are unchanged. Production run order:
   SQL 103 → SQL 29 → SQL 30 → SQL 90 → … → SQL 102.
1. **SQL 29 before SQL 90** (`aws/workflows/sql/90_users_only_tenant_roles.sql`). SQL 29's
   `aws_can_manage_mortgage_library` still has the tenant owner/admin tier; SQL 90 replaces it
   with the membership rule (owner policy: every member is an equal user). Re-applying SQL 29
   after SQL 90 would bring the tier back, so both tools refuse SQL 29 with
   `sql90_not_applied` once SQL 90's `public.aws_is_tenant_member(uuid)` exists. If SQL 90
   lands first, SQL 29 needs its own reviewed change (a membership-only copy).
2. **SQL 30 before SQL 94** (`aws/workflows/sql/94_document_library_restore.sql`). SQL 94's
   CHECK supersedes SQL 30's and accepts it as a predecessor; SQL 30 refuses SQL 94's CHECK
   (`check_is_supported_predecessor`). Applying SQL 94 alone is also fine (it accepts the
   6-value predecessor): then SQL 30 is skipped for good.
3. SQL 29 and SQL 30 are independent of each other.

## Fingerprints

Both are code-derived state texts in `scripts/deployment-guard/lib/sql-executor-auth.mjs`
(shared by the staging executor and the production tools), so the post-state hash is known
before any run and is the same in both environments (owner names are not part of it):

- SQL 29 — `sql29StateText`: each function (absent, or sha256 of `prosrc`, SECURITY DEFINER,
  `proconfig`, ACL with the owner read as `owner`), the two policies (cmd, permissive, roles,
  whether the expression calls the reviewed helpers), the names of any other policy on the
  table, and SELECT/INSERT/UPDATE/DELETE of PUBLIC, `authenticated` and `checksops` on it.
  Intended `1271ea9b61ec983f88e911b23c569403979fb5f560880021b58d3b1e57243c79`.
- SQL 30 — `sql30StateText`: `doc_type` type and nullability, and the constraint (present,
  validated, IN list, sorted literals). Intended
  `e573962eb3d7a427d6b4a2fe1fc48fa3c49f4ad22c6ae66372fb236017ca2556`.

SQL 30's file carries its own `BEGIN;` / `COMMIT;`. The tools execute only the bytes between
them (`sql30ExecutableText`, which refuses any other shape) inside their own transaction,
so the post-conditions are checked before COMMIT and a failure rolls back.

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

SQL 29: prerequisites present (`has_role`, `aws_is_authenticated`, `aws_is_cross_tenant_reader`,
`aws_can_access_tenant`, `aws_can_write_tenant`, `auth.uid`, `app_role`, the Mortgage Ops
tables, roles `checksops` and `authenticated`); `sql90_not_applied`; table owned by the login;
RLS enabled on `mortgage_request_library_documents`; existing functions owned by the login
with the same result type; no function or table ACL entry the file would not replace; no
policy on the table other than the two reviewed and the three dropped.

SQL 30: table present; `doc_type` text NOT NULL; table owned by the login; the CHECK is the
3- or 6-value predecessor; no row outside the 13 values (`rows_outside_sql30_values` 0; the
file itself refuses otherwise).

Post-conditions: the intended fingerprint; owners unchanged; SQL 29 leaves SQL 30's state
unchanged and vice versa; the trigger(s) running `share_library_docs_to_mortgage_request`
unchanged; and everything else in schema `public` (relations, columns, constraints, policies,
triggers, schema ACL) and the functions of `public` and `auth` unchanged.

## Inspect (read-only)

```bash
node scripts/deployment-guard/sql29-mortgage-ops-library-parity-production-apply.mjs --inspect
node scripts/deployment-guard/sql30-tenant-documents-doc-type-production-apply.mjs --inspect
```

`BEGIN READ ONLY … ROLLBACK`, `search_path` `pg_catalog`. Of table rows it reads only
aggregate `COUNT(*)`s, each in its own savepoint (`null` with a reason code when unreadable):

- `tenant_documents_by_category`: legacy, mortgage, template, shingle, siding, catalog,
  letterhead, library_other, other;
- `tenant_documents_by_path_form`: `aws_library` (`{tenant_id}/library/…`), `url` (Supabase
  storage URLs), `bucket_prefixed` (`tenant-documents/…`), `other_tenant_library`, `other`;
- `shared_with_homeowners_true` (null when the column is absent);
- `mortgage_request_library_documents`;
- `rows_outside_sql30_values`.

It also prints whether each SQL 29 function, policy and the auto-share trigger exist, the
CHECK's shape and `check_definition_sha256`, `sql90_applied`, `precondition_failures`,
`apply_preconditions_met` and `live_definition_sha256` (the value to pin). No ids, names,
paths or row data.

## Steps

1. Staging: run the guarded staging SQL executor with `read-live` for
   `sql29-mortgage-ops-library-parity` / `sql30-tenant-documents-doc-type`; record the
   `LIVE_DEFINITION_SHA256` in the staging pin (`expected_live_definition_sha256`) in a
   reviewed change; then `apply`; then `read-live` again (`already_applied` true).
2. Production: run `--inspect` on the runner; record `production_inspect` and copy
   `live_definition_sha256` into `expected_live_definition_sha256`; record the staging runs in
   `staging_acceptance`; set an owner-approved `authorization` and `execute: true` in one
   reviewed change.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`), one run per migration, SQL 29
   first: `production-sql-one-shot.mjs --migration sql29 --approval-scope sql29 … --phase
   inspect`, then the owner-named `--phase apply` run; the same for `sql30`. Both runs come
   before SQL 90. The one-shot runs the tool's `--inspect`, builds the manifest from the pin
   (`source_sha256`, expected and intended hashes, `authorization_phrase`), issues the receipt
   with `preflight.mjs --acquire-lease --receipt`, runs the tool's `--input` (evaluate) and
   `--apply --input` with a fresh `one_use_id`, then `--inspect` again.
4. Record the apply and retire the pin (`execute: false`). Do not edit the release lock
   `mortgage-ops` from this runbook; that is its own reviewed change.

The one-shot orchestrator (`production-sql-one-shot.mjs`) registers `sql29` and `sql30`
(`ONE_SHOT_TOOLS` in `scripts/deployment-guard/lib/production-sql-one-shot.mjs`). It refuses
both while their pins are `execute: false`; for a read-only inspect before the pin change, run
the tool's own `--inspect`. The registry entries hold no hashes: a reviewed change to either
file updates its production pin (and the tool's staging binding in
`scripts/deployment-guard/lib/sql-executor-auth.mjs`), not the registry. Besides the tool's
own `sql90_not_applied`, the one-shot refuses SQL 29 unless the inspect reports
`sql90_applied: false`.
