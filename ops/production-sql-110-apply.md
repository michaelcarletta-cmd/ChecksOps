# Production SQL 110 (homeowner pre-claim links: delete and public upload)

| key | file | what it does |
|---|---|---|
| `sql110` | `aws/workflows/sql/110_homeowner_preclaim_links.sql` (sha256 `17055748984218ae646ea0de138626318a6c4de4c1c575be1e23fc8dd0422db4`) | `GRANT DELETE ON public.homeowner_ledger_tokens TO checksops`, and `CREATE OR REPLACE FUNCTION public.aws_public_homeowner_ledger_upload(text, text, text, text, numeric, text)`: SECURITY DEFINER, `search_path = public`, EXECUTE `checksops` only (PUBLIC revoked). No policy, table, column or trigger change. |

**Why.**

- *Delete a pre-claim link.* The owner wants a real Delete for "Recent Pre-claim links"
  (Manager > Homeowner Uploads), a permanent delete rather than hiding. SQL 68 grants
  `SELECT, INSERT, UPDATE` on `homeowner_ledger_tokens` to `checksops`, no `DELETE`, and the AWS
  copy of the Supabase schema was restored without ACLs, so `authenticated` holds nothing on the
  table. A DELETE by `checksops` is refused before any policy runs. SQL 110 grants only `DELETE`,
  only to `checksops` (matching SQL 68, which granted nothing to `authenticated`; `checksops` is a
  member of `authenticated`, so the policies `TO authenticated` apply to it).
- *Public homeowner upload.* `handleHomeownerLedgerUpload` (`aws/functions/api/homeowner.mjs`)
  runs with no app identity on `checksops` (not BYPASSRLS, not the owner). Its direct INSERT into
  `homeowner_ledger_check_uploads` is refused by `aws_write_homeowner_ledger_check_uploads`
  (`FOR ALL TO authenticated`, `aws_can_write_tenant(tenant_id)`). The upload needs a narrow
  definer writer keyed by the link token, in the style of `aws_public_homeowner_ledger_by_token`
  (SQL 82).

**Authorization boundary for DELETE.** `aws_write_homeowner_ledger_tokens`
(`aws/rls/sql/24_complete_write_policies.sql`) is `FOR ALL TO authenticated USING
(aws_can_write_tenant(tenant_id))`: it covers DELETE, so only a same-tenant admin/staff identity
(or the platform owner) deletes a link; any other session deletes no row. SQL 110 changes no
policy. If production still carries the restored Supabase policy `tenant staff manage ledger
tokens` (FOR ALL, any `tenant_users` member through `auth.uid()`), it is permissive and ORs with
the AWS one exactly as it already does for INSERT and UPDATE. SQL 110's fingerprint does not cover
policies, so its inspect does not show which policies are live; check that separately if it matters.

**Foreign keys to `homeowner_ledger_tokens(id)`** (supabase migrations `20260712113217`,
`20260830125722`): `homeowner_ledger_check_uploads.token_id` and
`homeowner_deductible_payments.token_id`, both `ON DELETE SET NULL`. A delete neither fails nor
cascades: those rows stay and lose their `token_id`. The API deletes only links with no uploads
attached; the database does not enforce that.

**What the writer does.** `aws_public_homeowner_ledger_upload(_token, _front_path, _back_path,
_kind, _amount_estimate, _homeowner_note)`:

- finds the token row by the exact trimmed token, locked `FOR UPDATE`; `not_found` (unknown or
  shorter than 8), `revoked`, `expired` (the checks of `aws_public_homeowner_ledger_by_token`);
- `_kind` `check` or `document` (NULL is `check`), else `invalid_kind`; `_amount_estimate` NULL
  or 0 to 10,000,000, else `invalid_amount`; the note trimmed and cut to 1000 characters;
- paths exactly `ledger/<claim_id or token id>/<digits>_front.<ext>` (required) and
  `..._back.<ext>` (optional), `ext` in jpg, jpeg, png, webp, heic, pdf, no `..`; else
  `invalid_path`;
- 25 or more uploads on the token in the last 24 hours: `rate_limited`;
- inserts one `homeowner_ledger_check_uploads` row (`pending_review`; tenant, claim, token,
  `partner_code` and `assigned_to_user_id` = `sent_by_user_id` from the token). The table has no
  `kind` column: the kind is returned and recorded on the ledger event only;
- when the link has a claim, appends one `homeowner_ledger_events` row (`homeowner_check_upload`,
  the value the event_type CHECK allows; `claim_id` is NOT NULL there), actor `Homeowner`,
  payload `{upload_id, kind}`;
- returns `{ok, upload_id, tenant_id, claim_id, token_id, kind, sent_by_user_id}`
  (`sent_by_user_id` falls back to `created_by`).

**Status:** applied to staging and to production (2026-10-22); the production pin is retired
(`execute: false` again; see "Production apply of SQL 110").

## Status

- **Staging executor refreshed (2026-10-22).** Inspect run 39836139410 (main `6cf4c2f6b`) found the
  live executor at CodeSha256 `ueLvAc0a…` without SQL 110 (adds only
  `sql/110_homeowner_preclaim_links.sql`, supersedes the three engine files, nothing dropped, no
  collisions). Deploy run 39836443329 updated it to main's package.
- **Staging read-live (2026-10-22).** Run 39836749684 (main `6cf4c2f6b`): the writer `absent`, no
  DELETE grant on `homeowner_ledger_tokens` (other write grant `checksops UPDATE`), live
  `3fdbb3d323c1c0edab0c2ee7e4a6c1b08aa30c1a021c7d81899e95a616f186fd`, `definer_writes` ok for all three tables,
  `already_applied` false, `precondition_failures` `[]`. Recorded in the staging pin
  (`expected_live_definition_sha256`, `execute: true`, wave 11) under the owner's statement of
  2026-10-22, "Apply SQL 110 to staging".
- **Staging apply (2026-10-22).** After the staging pin change merged (#1166, main `7c3b7abc7`),
  deploy run 39838297300 (executor `SzEmktClMuLSQYvBYA5VY4RztzdTXJe8SMZOC5lJbec=`), then apply run
  39838878110: `applied`, `3fdbb3d3…` ->
  `ae039876920fde43cba6c3d01ed9443f2d129ad11d23825ec3c120256fc21ac3`, function `intended`, ACL
  `checksops EXECUTE`, `owner EXECUTE`, table privilege `checksops DELETE`. Read-live run 39839173968:
  `already_applied` true, live = intended, `precondition_failures` `[]`.
- **Production inspect recorded (2026-10-22).** Read-only `--inspect` through SSM
  `85ee4f39-7234-42a4-b1d8-79cd1390fdbc` on `i-0c35557c4e5385406`, main `7c3b7abc7` (tarball sha256
  `58bd457946f37e970501c83fe226b9d18a5092d9aff80d150c7b34b19a8bde21`, transfer run 39839811134):
  the writer `absent`, no DELETE grant on `homeowner_ledger_tokens` (other write grant `checksops
  UPDATE`), live `3fdbb3d323c1c0edab0c2ee7e4a6c1b08aa30c1a021c7d81899e95a616f186fd` (the same
  pre-state as staging), `definer_writes` ok for all three tables, `already_applied` false,
  `precondition_failures` `[]`. Recorded in the pin as `expected_live_definition_sha256`, with the
  staging apply run 39838878110 as `staging_acceptance`.
- **Pin `execute: true`** once that change is merged (#1167), under the owner's statement of
  2026-10-22, "apply SQL 110 in production", which covers SQL 110's whole guarded path to
  production. Nothing is applied by it; the apply (step 3) passes the owner's words for that run.
- **Applied to production (2026-10-22)** and the pin retired (`execute: false` again; see
  "Production apply of SQL 110" below).

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec
`functions` and `table_privileges` in `release-sql-specs.mjs`). Intended
`ae039876920fde43cba6c3d01ed9443f2d129ad11d23825ec3c120256fc21ac3`:

```
release sql110 v1
function public.aws_public_homeowner_ledger_upload(text, text, text, text, numeric, text): lang=plpgsql vol=v parallel=u secdef=true result=jsonb config=search_path=public prosrc=9befcfbe3cdf8107eb15b0249d0cfbde5a9a912e76df0ec8055b63132c34a761 acl=checksops EXECUTE;owner EXECUTE
privileges public.homeowner_ledger_tokens DELETE: checksops DELETE
```

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present` (the three tables, the columns the writer uses, role `checksops`);
`definer_can_write_relations` (the login owns `homeowner_ledger_tokens`,
`homeowner_ledger_check_uploads` and `homeowner_ledger_events` without FORCE ROW LEVEL SECURITY,
or is a superuser or BYPASSRLS); `homeowner_ledger_tokens` owned by the login. The file itself
refuses with `55000 sql110_prerequisite_missing` / `sql110_definer_cannot_write`.

Post-conditions: the intended fingerprint; every other grant on `homeowner_ledger_tokens`
unchanged; everything else in schema `public` (and the functions of `auth`) unchanged. The tools
roll back otherwise.

## Order

No predecessor. Apply before the API change that deletes pre-claim links or calls the writer.

## Steps

1. Staging: the staging executor must carry SQL 110 first (executor package refresh through
   `sql-executor-ensure.mjs` / the guarded staging executor `deploy` mode, its own reviewed run).
   Then `read-live` for `sql110-homeowner-preclaim-links`. Expected `already_applied` false and
   `precondition_failures` `[]`. Record `LIVE_DEFINITION_SHA256` in the staging pin
   (`expected_live_definition_sha256`, owner-approved `authorization`, `execute: true`) in a
   reviewed change, `apply` with the owner's approval of that run, then `read-live` again
   (expected `already_applied` true).
2. Production: run the read-only inspect on the runner
   (`node scripts/deployment-guard/sql110-homeowner-preclaim-links-production-apply.mjs --inspect`,
   or the one-shot's `--phase inspect`); record `production_inspect` and copy
   `live_definition_sha256` into `expected_live_definition_sha256`; record the staging runs in
   `staging_acceptance`; set an owner-approved `authorization` and `execute: true`, in one
   reviewed change. Expected: `already_applied` false, `precondition_failures` [].
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs
   --migration sql110 --approval-scope sql110 … --phase inspect`, then the owner-named
   `--phase apply`.
4. Record the apply and retire the pin (`execute: false`).

## Production apply of SQL 110 (2026-10-22)

The owner's statement of 2026-10-22 was "apply SQL 110 in production", passed verbatim (base64,
`--approval-statement-b64`). The one-shot cannot verify who said it, and the statement covered this
run only. `production-sql-one-shot.mjs --migration sql110 --approval-scope sql110` on
`i-0c35557c4e5385406`, operator `michaelcarletta-cmd`, workstream
`prod-sql110-homeowner-preclaim-links-20261022`, from main `e29b971fb` (tarball
`source-e29b971fbf9c33d89cdf133155853d0c5e9c9b26.tar.gz`, sha256 `a86f2b28…`, transfer run
`39842733299`, `sql53-temporary-transfer.yml` dispatched on main after the #1167 merge; its package
job printed `TARBALL_SHA256 a86f2b286e579e75695ffed3e66919846a19995ea6654f1416ece5f9079abc19`, equal
to the uploaded `.sha256` sidecar).

- **Inspect phase:** SSM `c0dce565-8dce-46fa-9f2d-42702987afe1`, run_id
  `02f48809-841d-47a8-bb38-16c290854101`: pin, source, inspect and contracts ok, nothing written;
  live `3fdbb3d3…` (live_matches_expected true), function `absent`, no `checksops DELETE`,
  precondition_failures [].
- **Apply phase:** SSM `dff74531-5a77-4f17-9027-e927f7f10644` (2026-10-22T19:46:49Z to 19:47:07Z),
  run_id `04f2dadf-1866-492e-a9e9-d301a2766b2b`, one_use_id
  `sql110-prod-a04eae17-2564-42ba-87a1-51bc200582ff` (spent): every step ok (pin, source, inspect,
  contracts, manifest, source-recheck-before-preflight, preflight, evaluate,
  source-recheck-before-apply, apply (applied), post-apply-inspect); migration source `17055748…`
  (== pin); contracts claim-ledger 4/4, tenant-isolation 6/6, financial-write-protections 43/43;
  pre-apply inspect live `3fdbb3d3…`, predecessors `{}`, precondition_failures []; manifest
  `ce9d1d6c…`; receipt `3fdbb3d3…` -> `ae039876…`, result applied, unrelated catalog `9d4cf067…`
  (relations 890, columns 3535, constraints 2233, policies 404, functions 1314, indexes 654, triggers
  180, views 25, types 18, roles 29, role memberships 15); post-apply inspect live `ae039876…`,
  already_applied true, precondition_failures [], function `intended`, ACL `checksops EXECUTE`,
  `owner EXECUTE`, `homeowner_ledger_tokens` `checksops DELETE` (other write grant `checksops UPDATE`
  unchanged).

No later read-only inspect was run, and neither a pre-claim link delete nor a public homeowner
upload has been observed through production since the apply. The policies on
`homeowner_ledger_tokens` are not covered by the fingerprint and were not inspected. The pin is
`execute: false` again; a re-apply needs a new reviewed pin change. The API change that deletes
pre-claim links or calls the writer is not part of this record and goes through its own guarded
Lambda path.
