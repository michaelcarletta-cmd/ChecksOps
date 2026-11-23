# Production SQL 172 (endorsement email engagement: opened and clicked)

| key | file | what it does |
|---|---|---|
| `sql172` | `aws/workflows/sql/172_check_endorsement_email_engagement.sql` (sha256 `d0f860f034158d621ea6de9173fd53d4ec60467e229f16cfba4a42c7104435c3`, authored by `1bfb02bbe`) | Refuses without SQL 170 or its other prerequisites (`55000 sql172_prerequisite_missing`), unless the applying login can write `check_endorsements` past row security (`55000 sql172_definer_cannot_write`), or when a new column already exists with another type, NOT NULL or default (`55000 sql172_column_conflict`); then adds six columns to `check_endorsements` and one SECURITY DEFINER function with EXECUTE for `checksops` only. |

**Why.** Owner 2026-11-23: "Yes build opened and clicked": show Resend's "opened" and "clicked" email events for a
payee's endorsement request email in ChecksOps, next to Delivered. SQL 170 (applied to production 2026-11-19) records the
latest request email's Resend id (`check_endorsements.email_message_id`) and its delivered, bounced and spam reports, and
the payee opening the signing page; nothing records Resend's engagement events. Resend's "opened" comes from its tracking
pixel (a mail client preloading images can report one), "clicked" from its link tracking; the website shows them beside
Delivered and the link opened, not in place of them.

**What it does.**
- Six columns on `public.check_endorsements`, the latest request email's engagement: `email_first_opened_at`,
  `email_last_opened_at` (timestamptz), `email_open_count` integer NOT NULL DEFAULT 0, `email_first_clicked_at`,
  `email_last_clicked_at` (timestamptz) and `email_click_count` integer NOT NULL DEFAULT 0. The four times nullable with
  no default. No column grant: the table SELECT for `checksops` (`aws/write-path/sql/33_tranche2_write_grants.sql`)
  covers new columns, and the API writes them only through the function.
- One function (plpgsql, VOLATILE, SECURITY DEFINER, `search_path = public`, `row_security = off`, owned by the applying
  login; EXECUTE revoked from PUBLIC, `anon`, `authenticated` and `service_role`, granted to `checksops`):
  `aws_endorsement_email_engagement(text, text, timestamp with time zone)` returns boolean, called
  `(p_email_id, p_kind, p_at)`: one Resend engagement event. `p_kind` `opened` or `clicked` (trimmed, any case) updates
  the endorsements whose `email_message_id` is that id, found exactly as SQL 170's `aws_endorsement_email_event` finds
  them (the id trimmed, first 200 characters): first time once (`COALESCE`), latest time the later of the recorded one
  and `p_at` (`GREATEST`), count plus one. `p_at` NULL is `now()`. Any other kind, or a NULL or blank id, changes nothing
  and returns false; returns whether an endorsement was updated (false for an email that is not an endorsement's latest
  request).
  It changes no other column: not `status`, `signed_at`, the token, `updated_at` or SQL 170's columns.
- Idempotent: `ADD COLUMN IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`; when everything is already current it notices
  `sql172_already_current`.

**A resend.** SQL 170's `aws_endorsement_email_sent` (not changed here) stores the new email's id and clears only SQL
170's four delivery columns. The engagement columns keep the earlier email's opens and clicks; events for the earlier
email no longer match. Clearing them on a resend would replace a SQL 170 function: a separate reviewed change, if wanted.

**Not changed:** no SQL 170 object (its three functions, eight columns and index), no other column, constraint, index,
trigger, function, policy, RLS setting, table grant or row (beyond the two counts' default); `endorsement_requests` is
unchanged. Nothing records an engagement event until the API calls the function: its own later step (a Lambda overlay of
the Resend webhook handler to pass `email.opened` and `email.clicked` to the function, with open and click tracking
turned on for the sending domain in Resend), then the website (opened and clicked beside Delivered), each after this pin
is applied in production. No API, Lambda or SPA change is part of this pin.

**Status:** staging pin execute-authorized (wave 64); not applied anywhere. The production pin is pending.

**Staging read-live (2026-11-23).** Run 45267758829 (main `6a5c0b746`, after executor inspect run 45266777439 and executor deploy
run 45267274234 (executor CodeSha256 `gGHt9f/X…` -> `seM6qqQs…`)), under the owner's words "run the staging SQL executor
deploy, then the SQL 172 read-live": `already_applied` false, `precondition_failures` `[]`, predecessors `{ sql170: true }`;
the six columns and the function absent. Live
`dbf6a7240cfc5dd737cd47e7f0f765cf6349c0a3a8625a39e02f4901c2e29897`, equal to the derived pre-state; intended `fc4119aa…`. Recorded in the staging pin
(`expected_live_definition_sha256`, `execute: true`, wave 64) on the owner's "approve the SQL 172 staging apply". The
staging apply is a separate run after this pin is merged and the executor is redeployed carrying it, on the owner's words
for that run. The production pin stays pending.

## Order

After SQL 170 (`aws/workflows/sql/170_check_endorsement_email_status.sql`): the release engine refuses with
`predecessors_applied` unless SQL 170's objects read exactly its pinned intended fingerprint
(`e53dd2feaae35238f25a194cae9bc4d6356c21d4ad616051180c162eb59b0c81`), and the file itself refuses with `sql172_prerequisite_missing` without
`check_endorsements.email_message_id` or `aws_endorsement_email_event`. SQL 170 is applied in staging (wave 62) and in
production (2026-11-19). SQL 172 changes none of SQL 170's objects, so SQL 170 still reads applied afterwards.

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec `sql172` in
`release-sql-specs.mjs`). Intended `fc4119aa53c9652fa4bd9774f2e0c3add752e70ce1aa8bb9fe302981a7b38dce`:

```
release sql172 v1
function public.aws_endorsement_email_engagement(text, text, timestamp with time zone): lang=plpgsql vol=v parallel=u secdef=true result=boolean config=row_security=off;search_path=public prosrc=20faaa0f91c3e68438931e6834049d35b1d70b63bc0e314c333c745b0ffc983c acl=checksops EXECUTE;owner EXECUTE
column public.check_endorsements.email_first_opened_at: timestamp with time zone notnull=false default=- acl=
column public.check_endorsements.email_last_opened_at: timestamp with time zone notnull=false default=- acl=
column public.check_endorsements.email_open_count: integer notnull=true default=5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9 acl=
column public.check_endorsements.email_first_clicked_at: timestamp with time zone notnull=false default=- acl=
column public.check_endorsements.email_last_clicked_at: timestamp with time zone notnull=false default=- acl=
column public.check_endorsements.email_click_count: integer notnull=true default=5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9 acl=
```

**Expected pre-state (both environments).** Everything absent:

```
release sql172 v1
function public.aws_endorsement_email_engagement(text, text, timestamp with time zone): absent
column public.check_endorsements.email_first_opened_at: absent
column public.check_endorsements.email_last_opened_at: absent
column public.check_endorsements.email_open_count: absent
column public.check_endorsements.email_first_clicked_at: absent
column public.check_endorsements.email_last_clicked_at: absent
column public.check_endorsements.email_click_count: absent
```

That is `dbf6a7240cfc5dd737cd47e7f0f765cf6349c0a3a8625a39e02f4901c2e29897` (`releaseStateHash('sql172', {})`). Each pin
records its own environment's read; neither value is written into a pin before a run reads it. A pre-state other than
this one is a stop.

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present` (`check_endorsements`, its `id` column, the role `checksops`); `predecessors_applied` (SQL
170); `definer_can_write_relations` on `check_endorsements` (the function updates it past row security);
`altered_relations_owned_by_login` on `check_endorsements`; `added_columns_absent_or_intended`;
`functions_owned_by_login`, `function_results_match` and `function_acl_replaceable` (the function absent, or owned by the
login with the same result type and only the ACL entries the file sets).

Post-conditions: the intended fingerprint; everything else in schema `public` unchanged. The tools roll back otherwise.

## Steps

Each step is its own reviewed PR or run and waits for the owner's words for that step.

1. Staging: the staging executor must carry SQL 172 first (executor package refresh through the guarded staging executor
   `deploy` mode, its own reviewed run). Then `read-live` for `sql172-check-endorsement-email-engagement`.
   Expected `already_applied` false, `precondition_failures` `[]`, `prerequisites_missing` `[]`, `predecessors`
   `{ sql170: true }`, live `dbf6a724…`. Otherwise stop. Record `LIVE_DEFINITION_SHA256` in the staging pin
   (`expected_live_definition_sha256`, owner-approved `authorization`, `execute: true`, wave 64) in a reviewed change,
   `apply`, then `read-live` again.
2. Production: with the owner's OK for that read, the read-only inspect on the runner
   (`node scripts/deployment-guard/production-sql-one-shot.mjs --migration sql172 … --phase inspect`); record
   `production_inspect`, copy `live_definition_sha256` into `expected_live_definition_sha256`, record the staging runs in
   `staging_acceptance`, set an owner-approved `authorization` and `execute: true`, in one reviewed change.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs --migration sql172
   --approval-scope sql172 … --phase apply` with the owner's words (authorization phrase
   `SHOW_ENDORSEMENT_EMAIL_OPENED_AND_CLICKED`).
4. Record the apply and retire the pin (`execute: false`).
5. Then the API (the Resend webhook passes `email.opened` and `email.clicked` to the function; open and click tracking on
   for the sending domain) and the website (opened and clicked beside Delivered), each its own PRs and runs with the
   owner's words.

Rollback (not part of this pin; a reviewed step of its own if ever needed): drop the function and the six columns. The
recorded opens and clicks are lost; nothing else depends on them.
