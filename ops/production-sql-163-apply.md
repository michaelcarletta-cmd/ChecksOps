# Production SQL 163 (the Mortgage Desk agent sees the request's check and homeowner timeline, and sends the homeowner link)

| key | file | what it does |
|---|---|---|
| `sql163` | `aws/workflows/sql/163_mortgage_desk_check_timeline_homeowner_link.sql` (sha256 `7075128ade468e88881dee2527280ef36e3e54b357b0595c3d00077428bb73ad`, authored by `7a9df4765`) | Refuses without its prerequisites (`55000 sql163_prerequisite_missing`) or unless the applying login can reach `check_intake_items`, `claims`, `homeowner_ledger_events`, `homeowner_ledger_tokens` and `mortgage_handling_requests` past RLS (`55000 sql163_definer_cannot_reach`); then three new SECURITY DEFINER functions, EXECUTE `checksops` and the owner only. |

**Why.** Owner 2026-11-12: "A check was sent for Kenneth Smith to mortgage desk, the check did not show for mortgage
agent and it says check not linked from checksops. The check should be linked."; "notes should show on the mortgage
agents side as well so they know they made contact with homeowner or tenant"; "When sending homeowner link from
mortgage desk, error missing_cognito_token. Fix it." Approval to build: "Start the desk fixes" (2026-11-13).

- The Desk page (`src/pages/mortgage-ops/MortgageOpsRequestDetail.tsx`) reads the check from `check_intake_items`
  under RLS. That policy has no mortgage agent clause, so the assigned agent reads no row and the page says "No check
  linked to this request" (the platform owner reads it as platform owner). The images come from
  `get-check-image-urls`, which reads the same row under RLS.
- "Log update to homeowner timeline" (SQL 124 h) writes `homeowner_ledger_events`; the Desk has no read of that
  timeline, so the agent never sees what was logged.
- "Send tracking link to homeowner" calls `homeowner-ledger-send` with the tenant session, which a Desk session does
  not have (`missing_cognito_token`); that handler also requires `tenant_users` membership (`cross_tenant_denied`).

**What it does.** Each function is plpgsql, SECURITY DEFINER, `SET search_path = public, pg_temp`, and starts with
SQL 124's `aws_mortgage_desk_readable_request` (the assigned mortgage agent holding `mortgage_agent`, or the platform
owner; the request `in_progress` or `completed` and with a check; `42501 not_authorized` / `not_assigned_to_you` /
`request_not_in_status` or `22023 request_has_no_check` otherwise).
- `aws_mortgage_desk_request_check(uuid)` (STABLE): the request's check, one row, the fields the Desk page shows (id,
  claim, amount, check number, carrier, payee, payee and property address, issue date, claim number read from the
  check, image paths, status, stage, funds type). Never `routing_number`, `account_number`, OCR payloads or a tenant
  column.
- `aws_mortgage_desk_homeowner_timeline(uuid)` (STABLE): the homeowner timeline of the request's claim as the
  request's tenant wrote it (`homeowner_ledger_events` with that `claim_id` and `tenant_id`), newest first, at most
  200: event id, type, time, actor label, the payload's `note` only, amount, and `from_desk` (the payload carries
  `desk_request_id`, SQL 124 h). No rows without a claim. This is the timeline the homeowner already sees.
- `aws_mortgage_desk_homeowner_link(uuid, text)` (VOLATILE): the homeowner tracking link of the request's claim for
  the homeowner on file, never a caller-chosen address. The request needs a claim (`22023 request_has_no_claim`) that
  belongs to its tenant (`42501 claim_not_in_tenant`); the email is the request's `homeowner_email`, else the claim's
  `policyholder_email` (`22023 no_homeowner_email` without an address). It reuses that recipient's live token (same
  tenant, claim and email, not revoked or expired, name blank or the same), as `runHomeownerLedgerSend` does; else it
  inserts the API's new token (48 lower-case hex characters, `22023 invalid_token` otherwise) with `created_by` the
  caller. It returns the token, email, name, tenant and `reused`; the API builds the link and sends the email.

Not changed: no existing function is replaced (SQL 124's gate keeps its body and ACL); no table, column, policy, table
grant, trigger or row is changed by the apply. The db-readonly-validate trigger count is not affected. No API, Lambda
or SPA change is part of this pin: `aws/functions/api/mortgage-desk-esign.mjs` (the workspace `check` and
`homeowner_timeline`, `send_tracking_link`) and the Desk page ship afterwards through their own guarded paths; the API
tolerates the functions being absent (the workspace returns no check or timeline, the link answers 503).

**Status:** tooling built; staging and production pins pending (`execute: false`). Nothing applied or read.

Production authorization phrase (pin `authorization_phrase`): `SHOW_MORTGAGE_DESK_AGENTS_CHECK_TIMELINE_AND_HOMEOWNER_LINK`.

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec `sql163` in
`release-sql-specs.mjs`). Intended `ef536373458b30dc16679e921af2a071e63a4cb755854612f2ff90eb79184c85`:

```
release sql163 v1
function public.aws_mortgage_desk_request_check(uuid): lang=plpgsql vol=s parallel=u secdef=true result=TABLE(check_id uuid, claim_id uuid, amount numeric, check_number text, carrier_name text, payee_line text, payee_address text, property_address text, issue_date text, detected_claim_number text, front_image_path text, back_image_path text, status text, check_stage text, funds_type text) config=search_path=public, pg_temp prosrc=23b226c228663c2d8c3f65e667eed29adb4cf269ae4c392202b3ee035172101f acl=checksops EXECUTE;owner EXECUTE
function public.aws_mortgage_desk_homeowner_timeline(uuid): lang=plpgsql vol=s parallel=u secdef=true result=TABLE(event_id uuid, event_type text, occurred_at timestamp with time zone, actor_label text, note text, amount numeric, from_desk boolean) config=search_path=public, pg_temp prosrc=24c8598fef7adc7e4b4fd6e24979bbff799d827f0ea274eef4b4aed390c7ee5a acl=checksops EXECUTE;owner EXECUTE
function public.aws_mortgage_desk_homeowner_link(uuid, text): lang=plpgsql vol=v parallel=u secdef=true result=TABLE(token text, homeowner_email text, homeowner_name text, tenant_id uuid, reused boolean) config=search_path=public, pg_temp prosrc=ef1961685ec7f6fb2373d1409309ff0075481311e77d6bc39cdda53fc9b06776 acl=checksops EXECUTE;owner EXECUTE
```

**Expected pre-state (both environments).** The three functions absent:

```
release sql163 v1
function public.aws_mortgage_desk_request_check(uuid): absent
function public.aws_mortgage_desk_homeowner_timeline(uuid): absent
function public.aws_mortgage_desk_homeowner_link(uuid, text): absent
```

That is `23d41c1086f3f15412a5d374e056eaaf1bef7f428d81b0ffbdda666a5250de87` (`releaseStateHash('sql163', {})`). Each pin records its own environment's read; neither value is written
into a pin before a run reads it. A pre-state other than this one is a stop.

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present`; `function_acl_replaceable`, `functions_owned_by_login` and `function_results_match` (where
present); `definer_can_write_relations` on `check_intake_items`, `claims`, `homeowner_ledger_events`,
`homeowner_ledger_tokens` and `mortgage_handling_requests` (the DEFINER functions must reach them past RLS as their
owner; a read filtered by RLS would show the agent nothing).

Post-conditions: the intended fingerprint; everything else in schema `public` unchanged. The tools roll back otherwise.

## Steps (each its own reviewed PR or owner-approved run)

1. Staging read-live (`guarded-staging-sql-executor.yml`, choice `sql163-mortgage-desk-check-timeline-homeowner-link`), then the staging pin PR and the staging apply.
2. Production read-only inspect: `production-sql-one-shot.mjs --migration sql163 --phase inspect` (`ops/production-sql-one-shot.md`).
3. Production pin PR: record `production_inspect` and `staging_acceptance`, set `execute: true`; the owner merges it.
4. Production apply: `--phase apply` with the owner's exact words.
5. Record PR: the `applied` block, `execute: false`.
