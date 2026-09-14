# SQL 30 — tenant_documents Mortgage Ops `doc_type` allowlist

**This is an unapplied AWS operator package.** It is not a Supabase migration.
Do not apply from completeAuth, CI, deploy, package scripts, Supabase Preview,
or application startup.

SQL 29 (`29_mortgage_ops_library_parity.sql`) stays unchanged. Staging has
already applied SQL 29. This package only replaces
`public.tenant_documents_doc_type_check`.

## Why

`tenant_documents_doc_type_check` currently allows only the 2016/2026 legacy
IN-list. The Document Library stores Mortgage Ops packet files as
`library:mortgage:<canonical-slug>`. Those values fail the CHECK, so library
uploads cannot persist even though SQL 29 policies already filter
`library:mortgage:%`.

## Old constraint (predecessor)

Constraint name: `tenant_documents_doc_type_check`  
Column: `public.tenant_documents.doc_type TEXT NOT NULL`

Supported predecessor shapes (fail closed on anything else):

1. Original create (`supabase/migrations/20260506174503_52acae08-cbb8-4bcd-9dbd-e013c72d6191.sql`):

   `CHECK (doc_type IN ('w9', 'license', 'insurance'))`

2. Current in-repo / staging replacement (`supabase/migrations/20260709153833_66ac5141-9ddc-42d8-87b1-5140546745a3.sql`):

   `CHECK (doc_type IN ('w9','license','insurance','saas_agreement','terms_of_service','privacy_policy'))`

Live apply fingerprints the `pg_get_constraintdef` string by MD5 and by the
sorted extracted literals. Unexpected names, LIKE prefixes, or extra values
abort.

## New constraint

Same name. Same `NOT NULL`. Exact IN-list (legacy six + seven Mortgage Ops
canonical values):

- `w9`
- `license`
- `insurance`
- `saas_agreement`
- `terms_of_service`
- `privacy_policy`
- `library:mortgage:w-9`
- `library:mortgage:contractor-license`
- `library:mortgage:general-liability-insurance`
- `library:mortgage:workers-comp-insurance`
- `library:mortgage:certificate-of-insurance`
- `library:mortgage:signed-contract`
- `library:mortgage:adjuster-tpa-letter`

Arbitrary suffixes such as `library:mortgage:evil` are rejected. Template,
shingle, siding, catalog, letterhead, verification, and other non-allowlisted
categories remain rejected by this CHECK (unchanged from staging today). SQL 29
keeps its broader `LIKE 'library:mortgage:%'` helper filter as defense in depth.

The application no longer constructs `library:mortgage:${slug}` from free text.
Frontend and API share the seven canonical values above.

## Deprecated / dead values still allowed

The six legacy values remain valid so existing rows are not rewritten. The
Document Library UI no longer emits them as `doc_type` (it uses `library:*`
prefixes). They are preserved only because they are currently allowed by the
predecessor CHECK.

## SQL files and SHA-256

| File | SHA-256 |
| --- | --- |
| `aws/rls/sql/30_tenant_documents_mortgage_doc_type.sql` | `d30c7cafb232387e174eb5a3938af9e0942a006fa8b775c2d6eac490d84c7d5a` |
| `aws/rls/sql/30_tenant_documents_mortgage_doc_type_rollback.sql` | `c6dc96c2acc8c39fb448bb7ea0c8931cee8896ac3e1e62ea3f58233615ea67fe` |

Recompute with `sha256sum aws/rls/sql/30_tenant_documents_mortgage_doc_type.sql`.
The operator requires `CHECKSOPS_EXPECTED_SQL_SHA` to match the apply file.

The apply script is one transaction with `lock_timeout = 3s` and
`statement_timeout = 15s`. DROP + ADD of the same constraint name happen inside
that transaction, so any failure restores the predecessor through rollback. No
row rewrites. Second apply is idempotent (`sql30_already_current`).

## Staging preflight requirements

Operator module: `aws/rls/operator/tenant-documents-mortgage-doc-type.mjs`

- Never imported by `completeAuth`, `writePlan`, `enableRls`, or `oneshot/index.mjs`
- Never applies SQL 24 or SQL 29
- No production default
- Default `plan` mode does not open AWS or PostgreSQL
- Live modes require the apply-file SHA, staging account `806168576068`,
  region `us-east-1`, RDS identifier `checksops-staging`, endpoint
  `checksops-staging.cyr0q4kcop3c.us-east-1.rds.amazonaws.com`, database
  `checksops`
- Apply additionally requires `CHECKSOPS_OPERATOR_EXECUTE=1`,
  `CHECKSOPS_SQL30_APPLY=I_UNDERSTAND_STAGING_TENANT_DOCUMENTS_DOC_TYPE`, and
  `CHECKSOPS_SQL30_ALLOW_LIVE_CONNECT=1`
- This PR does not create or invoke that live path

Read-only preflight counts invalid rows and Mortgage Ops rows. It does not
return row contents.

## Apply procedure (later operator change; not this PR)

1. Confirm SQL 29 is already applied and will not be reapplied.
2. `node aws/rls/operator/tenant-documents-mortgage-doc-type.mjs plan`
3. Export `CHECKSOPS_EXPECTED_SQL_SHA` equal to the apply SHA above.
4. Run `preflight` against staging only. Stop if `invalid_for_target_n > 0`
   or guards fail.
5. Apply. Capture the predecessor `definition_md5` from the operator result.
6. Run `verify`. Extracted literals must be the 13-value target set.

## Verification queries (counts and hashes only)

```sql
SELECT conname, md5(pg_get_constraintdef(oid)) AS definition_md5
FROM pg_constraint
WHERE conname = 'tenant_documents_doc_type_check';

SELECT count(*) AS mortgage_ops_n
FROM public.tenant_documents
WHERE doc_type LIKE 'library:mortgage:%';

SELECT count(*) AS invalid_for_target_n
FROM public.tenant_documents
WHERE doc_type IS NULL
   OR doc_type NOT IN (
     'w9', 'license', 'insurance', 'saas_agreement', 'terms_of_service', 'privacy_policy',
     'library:mortgage:w-9',
     'library:mortgage:contractor-license',
     'library:mortgage:general-liability-insurance',
     'library:mortgage:workers-comp-insurance',
     'library:mortgage:certificate-of-insurance',
     'library:mortgage:signed-contract',
     'library:mortgage:adjuster-tpa-letter'
   );
```

Do not SELECT file paths, names, or other row contents for operator logs.

## Rollback conditions

`aws/rls/sql/30_tenant_documents_mortgage_doc_type_rollback.sql` restores the
6-value predecessor from `20260709153833`. It:

- aborts unless the live constraint is the SQL 30 target (or already the
  6-value predecessor);
- counts `library:mortgage:%` rows and **aborts if any exist**;
- does not delete or rewrite those rows.

If Mortgage Ops document rows exist, the operator must resolve them out of
band (category change or deletion through normal application paths) and only
then rerun rollback. There is no force-override that would restore a CHECK
those rows would violate.

Rollback SHA: `c6dc96c2acc8c39fb448bb7ea0c8931cee8896ac3e1e62ea3f58233615ea67fe`.
Requires `CHECKSOPS_SQL30_ROLLBACK=I_UNDERSTAND_STAGING_TENANT_DOCUMENTS_DOC_TYPE_ROLLBACK`.

## Confirmation

- No `supabase/migrations/` file in this package
- `completeAuth` still applies 11 → 20 → 15 → 22 → 21 → 24 → 29 only
- Operator is not a Lambda handler and is not in `aws/rls/oneshot/`
