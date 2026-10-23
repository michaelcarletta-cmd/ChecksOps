# SQL 112 (Moov invoice table grants) — APPLIED IN PRODUCTION

This file is repository apply-evidence. It does **not** apply SQL.
Do **not** reapply this file on production merely because this proof exists.

## Source

| Field | Value |
|---|---|
| File | `aws/workflows/sql/112_moov_invoice_table_grants.sql` |
| source_sha256 | `497e23e9b158d7d8287244b315ee1135cafb6fc955af05c0e1c60d0c5c44c7e4` |
| Authored | commit `fcb2ead39b4bf3c58185a96abfc7e2b7b220bed9` (#1188, merged as `c74e7264c`) |
| Intended fingerprint | `7caba5ba4a322d54a3c55ca712966da58cf4358c0db81f95c142dabfc916f315` (`releaseIntendedHash('sql112', file bytes)`) |
| Production pin | `ops/deployment-guard/sql112-moov-invoice-table-grants-production-apply.json` (retired, `execute: false`, #1191) |
| Runbook | `ops/production-sql-112-apply.md` |

## Production apply (do not reapply)

| Field | Value |
|---|---|
| Owner's words | "apply SQL 112 in production" (passed verbatim as `--approval-statement-b64`) |
| Workstream | `prod-sql112-moov-invoice-table-grants-20261023` |
| Source commit / tarball | main `4d2cf0c119280c12a360400be657d6e43f2b7a64`, `source-4d2cf0c1….tar.gz` sha256 `49862a9b106391ce61a04c4bec9040f3faf59fe0a6d935bf9df9bcb81e873d8f`, transfer run 39969627282 |
| Read-only inspect phase | SSM `a48aa853-2312-4b5f-a142-dcf06307d8e4`, run id `84dc3b92-6d90-4eda-b525-5f29b11270ed` |
| Apply phase | SSM `654fb07f-7c95-4828-ad95-7fce135f1d27` (2026-10-23T14:30:31Z to 14:30:49Z), run id `3f3f7d9d-51df-458f-b9fe-49b4bc91f841`, one_use_id `sql112-prod-95240935-fac1-4d76-b727-7fd1f2f55bf4` (spent) |
| Runner | `i-0c35557c4e5385406`, connected as `checksops_admin` |
| Contracts | claim-ledger 4/4, tenant-isolation 6/6, financial-write-protections 43/43 |
| Receipt | before `a61983121c4739f38084c66c6aaafcb67968b008526ff0c69459713280292acd` -> after `7caba5ba4a322d54a3c55ca712966da58cf4358c0db81f95c142dabfc916f315`, result `applied`, manifest `f8cc024e1d1e36cfd1f0ea441cec95e6834f26bd2e21091b27b1bb97ef07786d`, unrelated catalog `9cf1140a95c118bdf6d82d7e9a7f57d2a20b05ee423641ba6572bda00a57bbaf` |
| Post-apply inspect | `already_applied` true, `precondition_failures` `[]` |

## Grants after the apply (production)

| Table | Lines |
|---|---|
| `public.moov_invoices` | `authenticated` and `checksops`: SELECT, INSERT, UPDATE, DELETE |
| `public.moov_invoice_customers` | `authenticated` and `checksops`: SELECT, INSERT (`checksops` UPDATE and DELETE unchanged, outside the fingerprint) |

Before the apply (read-only inspect SSM `a868258f-3cac-4fce-88a3-318be6133ca5`, main `c74e7264c`,
2026-10-23) `checksops` already held every line the production invoice handler uses; the apply
added only the `authenticated` lines. Staging reached the same fingerprint from a different
pre-state (apply run 39967007467).

## What this proof does not claim

- It does not authorize a second apply of SQL 112.
- It does not change production data.
- It records no Lambda change: the handler's overlays are recorded in the lock's
  `deployment_fingerprint` and in `ops/deployment-guard/production-api-overlay-plan.json`.

The ledger `apply_evidence` row for SQL 112 links here. Future audits must treat this file as
already applied in production unless a later reviewed change records otherwise.
