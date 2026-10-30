# Production SQL 124 (the Mortgage Desk sends for signature, reads the check, posts timeline updates)

| key | file | what it does |
|---|---|---|
| `sql124` | `aws/workflows/sql/124_mortgage_desk_signature_and_reads.sql` (sha256 `0b597e65eec3bbcf96fd685b757015645a58bd224c942bef6c66c251de2be76f`) | Lets the assigned mortgage agent (or the platform owner) read the thread, files and signature requests of the request's check, sign storage reads of those files, send a `.pdf` / `.docx` of the check for signature (to the insured and/or the contractor company) and record its email sends, and post follow-ups and updates on the homeowner timeline, through server functions that check the caller themselves. |

**Why.** The owner, 2026-10-28: the Desk works a check it is assigned to without being a member of
the requesting tenant, so the tenant-scoped reads and the e-sign create path (`esign.mjs`
`requireSignatureActor`: `tenant_users` members only) refuse it. The owner's answers: the signers are
the insured (`policyholder`; a co-insured is a second policyholder) and/or the tenant
(`contractor`), up to 4; the document sent must be a `check_files` row of that check (any file can
be uploaded, SQL 122's `aws_mortgage_desk_attach_file`), a `.pdf` or `.docx`; the email sender
name is ChecksOps (an API concern); the tenant sees the Desk's signature requests like any other
request of the check. Defaults kept for v1: the agent may read while the request is `in_progress`
or `completed`; no Desk resend, void or delete; timeline updates are not mirrored to the tenant
thread.

**What it changes.** Same approach as SQL 99, SQL 111 and SQL 122: no table, column, trigger,
policy, RLS change or table grant; SECURITY DEFINER functions (`search_path = public`, owned by the
applying login, no `row_security` setting, so the triggers their writes fire,
`trg_mirror_signature_request_to_homeowner_ledger`, `assign_case_on_signature_requests` and
`assign_case_on_ledger_events`, keep running as today) that check the caller themselves.

- `aws_mortgage_desk_readable_request(uuid)` (internal; EXECUTE for the owner only; STABLE): SQL
  122's rule (the platform owner, or the assigned agent holding `mortgage_agent`; the request has a
  check) with the statuses fixed to `in_progress` and `completed` and no row lock. Otherwise 42501
  (`not_authorized`, `not_assigned_to_you`, `request_not_in_status`) or 22023
  (`request_has_no_check`).
- EXECUTE for `checksops` (the API login) and the owner only:
  - `aws_mortgage_desk_messages(uuid)` (STABLE): the check's `check_messages` not deleted, the
    newest 500, oldest first, each marked `from_desk`;
  - `aws_mortgage_desk_check_files(uuid)` (STABLE): the newest 1000 `check_files` rows of the
    check, oldest first;
  - `aws_mortgage_desk_signature_requests(uuid)` (STABLE): the newest 200 signature requests of
    the check with their signers (never `access_token`, `token_hash` or `expires_at`);
  - `aws_mortgage_desk_can_read_path(text[], text)` (`sql`, STABLE): the Desk's storage-sign check
    (modeled on `aws_mortgage_agent_can_read_library_path`): true only for a path that is a check
    file, a signature request document or final PDF of a readable request's check, or exactly
    `checks/<check>/mortgage-ops/<one name>`;
  - `aws_mortgage_desk_create_signature_request(uuid, text, text, text, jsonb, jsonb, timestamp with
    time zone)` (in progress; SQL 122's working gate, which locks the Desk request): one `draft`
    `signature_requests` row on a `.pdf` / `.docx` of the check, 1 to 4 signers (`policyholder` or
    `contractor`, in signing order 1..n, API-minted 64-hex tokens hashed as `esign.mjs` does, links
    valid at most 72 hours), at most 200 fields with a signature field per signer, the check's
    `check_files` rows of that path linked, one `esign_event_logs` row
    (`mortgage_desk_request_created`); a repeat within 10 minutes and more than 10 per Desk request
    in 24 hours are refused;
  - `aws_mortgage_desk_record_signature_delivery(uuid, uuid, jsonb)` (in progress or completed):
    once per Desk signature request still a draft, the API's per-signer email results, the request
    moved to `pending` (or `failed`) exactly as `esign.mjs runSendSignatureRequest` does, one
    `esign_event_logs` row (`mortgage_desk_delivery_recorded`);
  - `aws_mortgage_desk_post_timeline(uuid, text, text)` (in progress): one `mortgage_followup` or
    `mortgage_update` homeowner timeline row, note 1 to 2000 characters, payload `desk_request_id`
    (never `mortgage_request_id`, so SQL 122's completion row is unaffected).

Not changed: no table, column, trigger, policy, RLS flag or table grant; no existing function (SQL
122's are called, not replaced), row or column. Agents still cannot read `check_messages`,
`check_files` or `signature_requests`, or write `signature_requests`, `signature_signers`,
`signature_fields`, `esign_event_logs`, `check_files` or `homeowner_ledger_events`, directly. No
resend, void or delete path for the Desk; the tenant e-sign paths are unchanged. No trigger is
added, so the DB validator's public trigger count is not concerned.

**Staging executor refreshed (2026-10-28).** Inspect run 40753819395 found the live executor at
`W54SxDwd…` without `sql/124_mortgage_desk_signature_and_reads.sql`. Deploy run 40754334967 updated
it to main's package (`OWClSgc4zkbCgaPCgFtK1wrq7OK858BFG50wSqSaP14=`; "Verify live executor now
carries main's package" passed).

**Staging read-live (2026-10-28).** Run 40754712957 (main `3606348`): the eight functions absent;
every prerequisite present (SQL 122's `aws_mortgage_desk_working_request(uuid, text[])` included);
the definer writes to `check_messages`, `check_files`, `mortgage_handling_requests`,
`homeowner_ledger_events`, `signature_requests`, `signature_signers`, `signature_fields` and
`esign_event_logs` possible; live
`59fe6907e23de341e97d4aec548203d0cd7f7cf320b009e0e440d247d82a4db2`, `already_applied` false,
`precondition_failures` `[]`. Recorded in the staging pin (`expected_live_definition_sha256`,
`execute: true`, wave 23) under the owner's words of 2026-10-28, "start the SQL 124 staging apply".

**Staging apply (2026-10-28).** Run 40757497983 (main `593ea3f`, after #1349 merged the staging pin and
executor deploy run 40757069032 carried it, `7UUN4EHi…`; workstream `github-staging-sql-40757497983`):
receipt before `59fe6907e23de341e97d4aec548203d0cd7f7cf320b009e0e440d247d82a4db2`, after
`daeeff54652d04b45bd7cbfb3e47f56209b90ce14c7410c32285e3cf8b129ccb` (intended), result `applied`. Read-live
run 40757812948: `already_applied` true, `precondition_failures` `[]`, the eight functions at the intended
state (the readable-request check EXECUTE for the owner only, the other seven for `checksops` and the
owner), every definer write possible.

**Production inspect (2026-10-28).** Read-only `--inspect` through SSM
`a139e8f8-df32-4f19-a5ce-4471623d65fb` on `i-0c35557c4e5385406`, main `593ea3f` (tarball sha256
`f20220becb388abed7cf23852971827f1a0a6fdec6922d75e186629c1ddc49b6`, transfer run 40758552614, migration
source `0b597e65…` == pin), connected as `checksops_admin`: the eight functions absent; every prerequisite
present; the definer can write `check_messages`, `check_files`, `mortgage_handling_requests`,
`homeowner_ledger_events`, `signature_requests`, `signature_signers`, `signature_fields` and
`esign_event_logs` (production confirms the e-sign table ownership the file header asks about); live
`59fe6907e23de341e97d4aec548203d0cd7f7cf320b009e0e440d247d82a4db2`, `already_applied` false,
`precondition_failures` `[]`, the same pre-state as staging's. Recorded in the production pin with the
staging apply as its staging acceptance and `execute: true` under the owner's words of 2026-10-28, "start
the SQL 124 pin PR". The owner merges the pin change; the apply still needs the owner's run-time approval
and runs only after that merge is on main and staged.

**Production apply (2026-10-28).** After the pin change (#1350, merged green on the owner's words "merge
the SQL 124 pin PR when green"), transfer run 40761332004 staged main `b458e9510` (tarball sha256
`00dc4431386131cd0825c8785a6acb1d5828e0f28ea17342ca613dd1e35d4ae8`). One-shot `--phase inspect` (SSM
`2a6ff3c9-9932-41a6-85e4-3191bb86ce7d`, run `aae38fa7…`: live `59fe6907…`, `precondition_failures` `[]`) then
`--phase apply` run `4b59c99e-5c5b-44e5-9f03-a70562dbe3d5` through SSM `35de8528-5a59-4202-b12e-43ba87fc576e`,
workstream `prod-sql124-mortgage-desk-signature-and-reads-20261028`, under the owner's words "apply SQL 124
into production" (passed verbatim): every step ok, contracts 4/4, 6/6 and 43/43; receipt `59fe6907…` →
`daeeff54652d04b45bd7cbfb3e47f56209b90ce14c7410c32285e3cf8b129ccb` (intended), result `applied`, unrelated
catalog `32fe278f…` (triggers 184: SQL 124 adds none); post-apply inspect `already_applied` true,
`precondition_failures` `[]`, the eight functions intended (the readable-request check EXECUTE for the owner
only, the other seven for `checksops` and the owner); a separate read-only inspect (SSM
`b992e01d-8017-464b-9650-a226fcda4c2c`) agreed. SSM truncated the run's output at 24000 characters inside the
one-shot's own `applied` object; the pin's `applied` block is rebuilt from the complete fields it is made of
(see its `one_shot_note`).

**Status:** applied to staging (wave 23) and to production (2026-10-28); the production pin is retired
(`execute: false`). The API and
SPA change that calls these functions is a separate, later step after SQL 124 is live in staging;
until then nothing calls them.

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec
`sql124` in `release-sql-specs.mjs`): each function's language, volatility, SECURITY DEFINER,
result (the two `TABLE (...)` results and the readable-request row type as `pg_get_function_result`
prints them), proconfig, body hash and EXECUTE ACL. Intended
`daeeff54652d04b45bd7cbfb3e47f56209b90ce14c7410c32285e3cf8b129ccb`:

```
release sql124 v1
function public.aws_mortgage_desk_readable_request(uuid): lang=plpgsql vol=s parallel=u secdef=true result=public.mortgage_handling_requests config=search_path=public prosrc=db05261799a2b1dde7cb718f246291b8e0855e44644acd4408da6f54ed35e38c acl=owner EXECUTE
function public.aws_mortgage_desk_messages(uuid): lang=plpgsql vol=s parallel=u secdef=true result=TABLE(id uuid, sender_id uuid, body text, created_at timestamp with time zone, from_desk boolean) config=search_path=public prosrc=4710d2485849eb8fad2e677ae0c3b980538ff7007e2a67a646fa087b4c501eb6 acl=checksops EXECUTE;owner EXECUTE
function public.aws_mortgage_desk_check_files(uuid): lang=plpgsql vol=s parallel=u secdef=true result=TABLE(id uuid, file_name text, file_path text, file_type text, file_size bigint, category text, description text, source text, created_at timestamp with time zone, signature_request_id uuid) config=search_path=public prosrc=7a93e487fe439d2abe810826c0c9e7cde20a0183c68ba482b765219ec8d09bce acl=checksops EXECUTE;owner EXECUTE
function public.aws_mortgage_desk_signature_requests(uuid): lang=plpgsql vol=s parallel=u secdef=true result=jsonb config=search_path=public prosrc=e9806ac88d3a182ee87e1d2f968796e2230c2edbab98617b6b35dbd630d890d0 acl=checksops EXECUTE;owner EXECUTE
function public.aws_mortgage_desk_can_read_path(text[], text): lang=sql vol=s parallel=u secdef=true result=boolean config=search_path=public prosrc=8e1f8738bc9053abd6287044415731843d9d7647d5a9de258fce6caf493bdb60 acl=checksops EXECUTE;owner EXECUTE
function public.aws_mortgage_desk_create_signature_request(uuid, text, text, text, jsonb, jsonb, timestamp with time zone): lang=plpgsql vol=v parallel=u secdef=true result=jsonb config=search_path=public prosrc=0887e12be5e792a623d19225ef5b03041824862b1d629ed824a1d355db557c39 acl=checksops EXECUTE;owner EXECUTE
function public.aws_mortgage_desk_record_signature_delivery(uuid, uuid, jsonb): lang=plpgsql vol=v parallel=u secdef=true result=jsonb config=search_path=public prosrc=2b9113f7f354e5f99a0f9984e4ea3b8b7e1eb12a0ba7fa3749548bfc1be7352a acl=checksops EXECUTE;owner EXECUTE
function public.aws_mortgage_desk_post_timeline(uuid, text, text): lang=plpgsql vol=v parallel=u secdef=true result=uuid config=search_path=public prosrc=75fe434d172c4786ba79fb1a9163f1edc55bcb26179a69fc7c4ed8196d0dff77 acl=checksops EXECUTE;owner EXECUTE
```

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present` (SQL 122's `aws_mortgage_desk_working_request(uuid, text[])`, SQL 100's
`aws_is_mortgage_ops_agent()`, SQL 90's `aws_is_platform_owner_user(uuid)`, `is_platform_owner()`,
`has_role(uuid, app_role)` and the type `app_role`, `auth.uid()`, `pg_catalog.sha256(bytea)`, the
role `checksops`, and `check_messages`, `check_files`, `check_intake_items`,
`mortgage_handling_requests`, `homeowner_ledger_events`, `signature_requests`,
`signature_signers`, `signature_fields` and `esign_event_logs` with every column the file's own
prerequisite check names); `functions_owned_by_login`, `function_results_match` and
`function_acl_replaceable` (a function that already exists holds only EXECUTE entries the file
keeps or revokes); `definer_can_write_relations` (the eight tables above other than
`check_intake_items`: owned by the login without FORCE ROW LEVEL SECURITY; `signature_requests`,
`signature_signers`, `signature_fields` and `esign_event_logs` are the four this file adds to SQL
122's rule, and the read-only inspect before staging and production must show them `ok`). The file
itself also refuses (55000 `sql124_prerequisite_missing`, `sql124_definer_cannot_write`).

Post-conditions: the intended fingerprint; every function owned by the login; everything else in
schema `public` (and the functions of `auth`) unchanged. The tools roll back otherwise.

## Steps

1. Staging: the staging executor must carry SQL 124 first (executor package refresh through the
   guarded staging executor `deploy` mode, its own reviewed run). Then run the guarded staging
   SQL executor with `read-live` for `sql124-mortgage-desk-signature-and-reads`. If it reports
   `prerequisites_missing` other than `[]` or `precondition_failures` other than `[]`, stop.
   Otherwise record `LIVE_DEFINITION_SHA256` in the staging pin (`expected_live_definition_sha256`,
   owner-approved `authorization`, `execute: true`) in a reviewed change, `apply`, then `read-live`
   again. The API and SPA change that calls the functions follows in its own reviewed step; test
   the Desk signature flow on staging then.
2. Production: run the read-only inspect on the runner
   (`node scripts/deployment-guard/production-sql-one-shot.mjs --migration sql124 … --phase inspect`);
   record `production_inspect` and copy `live_definition_sha256` into
   `expected_live_definition_sha256`; record the staging runs in `staging_acceptance`; set an
   owner-approved `authorization` and `execute: true`, in one reviewed change.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs
   --migration sql124 --approval-scope sql124 … --phase apply` with the owner's words.
4. Record the apply and retire the pin (`execute: false`).
