# Production SQL 127 (homeowners sign from the claim portal)

| key | file | what it does |
|---|---|---|
| `sql127` | `aws/workflows/sql/127_homeowner_portal_signing.sql` (sha256 `4d2d311bad221c2d0e33370a56c1ebf00b0887d7286892954cf76eef0e107c33`) | `CREATE OR REPLACE` of SQL 83's `aws_public_homeowner_ledger_endorse_capability(text, uuid)` and `aws_public_homeowner_pending_signatures(text)` with the same signature and result, and a new `aws_public_homeowner_document_portal_signer(text, uuid)`; all three `SECURITY DEFINER`, `search_path = public`, `row_security = off`. `REVOKE ALL` on the three from `PUBLIC` and `authenticated`; `GRANT EXECUTE` to `checksops`. |

**Why.** Owner decision 2026-10-29 ("Portal link is enough"): the homeowner claim portal (the
tracking link, `homeowner_ledger_tokens`) is where a homeowner signs every check and document on
their claim. Before this file the portal could open signing only for a check endorsement staff had
already emailed (`sent`), only for a document whose signer still had its raw `access_token` (the
Supabase-era sender clears it after the email), and never for a document signer whose emailed link
was past its 72-hour expiry.

**What it changes.**

| function | was (SQL 83) | now (SQL 127) |
|---|---|---|
| `aws_public_homeowner_ledger_endorse_capability(text, uuid)` | opens an insured endorsement only in status `sent` | `pending` (created, not yet emailed) or `sent`; every other gate unchanged (ledger token bound to the exact tenant and claim, exact check on that claim, insured payee only, identity match, mint the token only when empty, `FOR UPDATE`); `manual_required` and every other status still `invalid_state` |
| `aws_public_homeowner_pending_signatures(text)` | hides a homeowner signer whose emailed link expired | lists an open homeowner signer whatever its `expires_at` |
| `aws_public_homeowner_document_portal_signer(text, uuid)` | (absent) | SQL 83's document gates (tenant and claim binding, homeowner signer type, identity match, open request and signer, signing order) with the signer row locked; returns the signer's existing `token_hash` (never a raw token) so the API signs through the same `/sign` engine as the emailed link; when that link has expired or expires within the hour, sets `expires_at` to `now() + 72 hours` for that one signer; the hash is not rotated |

The writes: `check_endorsements.token` (the endorse capability mints it only when empty, as in SQL
83) and `signature_signers.expires_at` (the portal signer). Not changed: SQL 82's
`aws_public_homeowner_ledger_by_token`, SQL 83's `aws_public_homeowner_document_sign_capability`;
any table, column, view, policy, RLS setting, table grant, trigger or row. SQL 82 and SQL 83 are
not edited. No API, Lambda or SPA change is part of this file or its pins. No trigger is added, so
the DB validator's public trigger count is not concerned.

**Staging executor refreshed (2026-10-29).** Inspect run 40947091811 found the live executor at
`ODInv6cl…` without `sql/127_homeowner_portal_signing.sql`. Deploy run 40947474906 updated it to
main's package (`wr7SyRLnmdIHOd+8oL5HSOWZKk1C2z27y3gN9HsepDo=`; "Verify live executor now carries
main's package" passed).

**Staging read-live (2026-10-29).** Run 40947834848 (main `f0264d9`): SQL 83's
`aws_public_homeowner_ledger_endorse_capability(text, uuid)` and
`aws_public_homeowner_pending_signatures(text)` present with SQL 83's bodies (state `different`),
`aws_public_homeowner_document_portal_signer(text, uuid)` absent; every prerequisite present; the
definer writes to `check_endorsements` and `signature_signers` possible; live
`4b4af399a73a25e191d2f914cc074a3744c84fffbc8ce3e55f2adec2cf93dfe0` (the SQL 83 pre-state derived from SQL 83's
bytes), `already_applied` false, `precondition_failures` `[]`. Recorded in the staging pin
(`expected_live_definition_sha256`, `execute: true`, wave 26) under the owner's words of
2026-10-29, "start the SQL 127 staging apply".

**Status:** staging pin execute-authorized (wave 26); nothing applied yet; production pin pending.

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec
`sql127` in `release-sql-specs.mjs`): per function its language, volatility, parallel safety,
`SECURITY DEFINER`, result, `proconfig`, sha256 of the body and the EXECUTE ACL. Intended
`c4936010132f2d542db796e50fe2d56d1aa3bae5133cdb53e8172978a5b2e190`:

```
release sql127 v1
function public.aws_public_homeowner_ledger_endorse_capability(text, uuid): lang=plpgsql vol=v ... config=row_security=off;search_path=public prosrc=ee30f695bba20518daef0c8a96fc585df2cb2206904d9792895aea01bd5387cb acl=checksops EXECUTE;owner EXECUTE
function public.aws_public_homeowner_pending_signatures(text): lang=plpgsql vol=v ... config=row_security=off;search_path=public prosrc=a7e3ce24007575fd6ac52271bd1c810daa8c8842e8a0c8f48d22b66f9c145b34 acl=checksops EXECUTE;owner EXECUTE
function public.aws_public_homeowner_document_portal_signer(text, uuid): lang=plpgsql vol=v ... config=row_security=off;search_path=public prosrc=15838f3289938d52df214ec4e3545bef49f0f67f4614c46cf424661ecf42f222 acl=checksops EXECUTE;owner EXECUTE
```

**Expected pre-state.** SQL 83 as applied (staging and production): the two replaced functions with
SQL 83's bodies and attributes, EXECUTE for `checksops` and the owner, and the portal signer absent.
If nothing else changed them, the read-live and the production inspect report the two functions
`different`, the portal signer `absent`, `function_acl` `checksops EXECUTE` and `owner EXECUTE`, and
`4b4af399a73a25e191d2f914cc074a3744c84fffbc8ce3e55f2adec2cf93dfe0` (derived from SQL 83's bytes by
`aws/tests/release-sql127-executor.test.mjs`, and read back from a PostgreSQL 16 database with the
real SQL 82 and SQL 83 applied). A different hash is not by itself a stop (an EXECUTE grant to
`PUBLIC` or `authenticated` changes it and is revoked by the file), but the per-function report and
ACL must be read before recording it.

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present` (SQL 82's and SQL 83's four functions, `pg_catalog.gen_random_uuid()`,
`homeowner_ledger_tokens`, `claims`, `check_intake_items`, `homeowner_ledger_events`,
`check_endorsements`, `signature_requests`, `signature_signers` and every column the bodies read or
write, role `checksops`); `functions_owned_by_login`; `function_results_match` (each replaced
function keeps its `jsonb` result); `function_acl_replaceable` (no EXECUTE grant outside `PUBLIC`,
`authenticated`, `checksops` and the owner); `definer_can_write_relations` (the login can write
`check_endorsements` and `signature_signers` under RLS: superuser, `BYPASSRLS`, or their owner
without `FORCE ROW LEVEL SECURITY`).

Post-conditions: the intended fingerprint; every function owned by the login; everything else in
schema `public` (and the functions of `auth`) unchanged. The tools roll back otherwise.

## Steps

1. Staging: the staging executor must carry SQL 127 first (executor package refresh through the
   guarded staging executor `deploy` mode, its own reviewed run). Then run the guarded staging
   SQL executor with `read-live` for `sql127-homeowner-portal-signing`. If it reports
   `prerequisites_missing` other than `[]` or `precondition_failures` other than `[]`, stop.
   Otherwise record `LIVE_DEFINITION_SHA256` in the staging pin (`expected_live_definition_sha256`,
   owner-approved `authorization`, `execute: true`) in a reviewed change, `apply`, then `read-live`
   again.
2. Production: run the read-only inspect on the runner
   (`node scripts/deployment-guard/production-sql-one-shot.mjs --migration sql127 … --phase inspect`);
   record `production_inspect` and copy `live_definition_sha256` into
   `expected_live_definition_sha256`; record the staging runs in `staging_acceptance`; set an
   owner-approved `authorization` and `execute: true`, in one reviewed change.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs
   --migration sql127 --approval-scope sql127 … --phase apply` with the owner's words
   (authorization phrase `APPLY_HOMEOWNER_PORTAL_SIGNING`).
4. Record the apply and retire the pin (`execute: false`).
