# Production SQL 170 (endorsement email status: delivered, bounced, spam; link opened)

| key | file | what it does |
|---|---|---|
| `sql170` | `aws/workflows/sql/170_check_endorsement_email_status.sql` (sha256 `44eb656742cc137bab736fb4ef54630a5c7a27df074428de918a0c7d9b942370`, authored by `bb45ea43f`) | Refuses without its prerequisites (`55000 sql170_prerequisite_missing`), unless the applying login can write `check_endorsements` past row security (`55000 sql170_definer_cannot_write`), or when a new column already exists with another type, NOT NULL or default (`55000 sql170_column_conflict`); then adds eight columns to `check_endorsements`, the partial index `check_endorsements_email_message_id_idx` and three SECURITY DEFINER functions with EXECUTE for `checksops` only. |

**Why.** Owner 2026-11-19: "Is there anyway for tenants to see if an email has been delivered and opened? For this to
show up near the payee signature request". Today the endorsement card shows only "Last sent <time>"
(`check_endorsements.request_sent_at`); the `delivered` the API stores on `endorsement_requests` means only that Resend
accepted the email, and nothing records an opened link. Offered (1) the link opened, recorded when the payee opens the
endorsement page, and (2) delivered or bounced from Resend's delivery reports, the owner answered "Yeah build 1 and 2".
An "email opened" tracking pixel is deliberately not used: Apple Mail preloads images (false opens), many clients block
them (missed opens), and it can hurt deliverability. The opened link is the signal.

**What it does.**
- Eight columns on `public.check_endorsements`, the latest request email's status and the link's use:
  `email_message_id` text (Resend's id of the latest request email), `email_delivered_at`, `email_bounced_at`,
  `email_bounce_reason` text (at most 300 characters), `email_complained_at` (marked as spam), `link_first_opened_at`,
  `link_last_opened_at` (timestamptz) and `link_open_count` integer NOT NULL DEFAULT 0. All other columns nullable with no
  default. No column grant: the table SELECT for `checksops` (`aws/write-path/sql/33_tranche2_write_grants.sql`) covers
  new columns, and the API writes them only through the functions.
- The partial index `check_endorsements_email_message_id_idx` on `(email_message_id) WHERE email_message_id IS NOT NULL`,
  the delivery report lookup.
- Three functions (plpgsql, VOLATILE, SECURITY DEFINER, `search_path = public`, `row_security = off`, owned by the
  applying login; EXECUTE revoked from PUBLIC, `anon`, `authenticated` and `service_role`, granted to `checksops`):
  - `aws_endorsement_email_sent(uuid, text)` returns boolean: the request email was sent; stores its id and clears the
    four email status columns (a resend starts a fresh status). A blank id changes nothing (false).
  - `aws_endorsement_email_event(text, text, timestamp with time zone, text)` returns integer: one delivery report,
    `delivered`, `bounced` (with its reason) or `complained`, stamps its time on the endorsements with that message id,
    keeping the first time on a repeat. Any other event raises `22023 invalid_email_event`. Returns the rows updated.
  - `aws_endorsement_link_opened(uuid)` returns integer: the payee opened the page; first time once, last time now, count
    plus one. Returns the new count, NULL when no such endorsement.
  None changes `status`, `signed_at`, the token or `updated_at`.
- Idempotent: `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`; when everything is
  already current it notices `sql170_already_current`.

**Not changed:** no other column, constraint, index, trigger, function, policy, RLS setting, table grant or row (beyond
`link_open_count`'s default); `endorsement_requests` is unchanged. Sending, signing and the endorsement statuses behave
as before until the API calls the functions: its own later step (a Lambda overlay of `check-endorsement.mjs` and the
Resend webhook, with the webhook signing secret through the guarded configuration path), then the website, each after
this pin is applied in production. No API, Lambda or SPA change is part of this pin.

**Status:** applied in staging (wave 62, 2026-11-19, apply run 44576208345); staging acceptance: the staging apply under the owner's run approval ("run the SQL 170 staging apply"; no separate acceptance statement); production pin execute-authorized on production's own pre-state (read-only inspect SSM `67613a6c-45ae-4d2e-b1ba-5adb161b80a1`, 2026-11-19) by the owner-reviewed pin change; not applied in production.

**Staging read-live (2026-11-19).** Run 44569070362 (main `17632da1f`, after executor inspect run 44562828532 and executor deploy
run 44567896532 (executor CodeSha256 `8i2ZsahmH…` -> `50KumbQJ…`)), under the owner's words "run the staging SQL executor
deploy, then the SQL 170 read-live": `already_applied` false, `precondition_failures` `[]`, `prerequisites_missing` `[]`;
the eight columns, the index and the three functions absent. Live
`747d10df6bd187e566fff75f14e2c2be43f14e350e70a7fabb8457931a3a7dc4`, equal to the derived pre-state; intended `e53dd2fe…`. Recorded in the staging pin
(`expected_live_definition_sha256`, `execute: true`, wave 62) on the owner's "approve the SQL 170 staging apply". The
staging apply is a separate run after this pin is merged and the executor is redeployed carrying it, on the owner's words
for that run. The production pin stays pending.

**Staging executor refreshed and staging apply (2026-11-19).** The staging pin for SQL 170 (wave 62, PR #2021, owner's words
"Merge 2021 when green") merged as `bc3d16a928330b66a76c59e86792fd734e6e5f5e`. Deploy run 44575220951 updated the staging guarded SQL
executor (CodeSha256 `50KumbQJ…` -> `0MpkBqG5…`, `EXECUTOR_CURRENT` true). Apply run 44576208345 (main `bc3d16a92`) under the owner's
words "run the SQL 170 staging apply": `before_hash` `747d10df6bd187e566fff75f14e2c2be43f14e350e70a7fabb8457931a3a7dc4`, `after_hash` `e53dd2feaae35238f25a194cae9bc4d6356c21d4ad616051180c162eb59b0c81` (the intended hash), `result` applied; the eight
columns, the index and the three functions `intended`, EXECUTE `checksops` and the owner. Read-live run 44577378245: `already_applied`
true, `precondition_failures` `[]`. The owner gave the run approval "run the SQL 170 staging apply"; no separate staging acceptance
statement was given. There is no separate staging record PR for SQL 170: these staging runs are recorded here and in the production
pin's `staging_acceptance` by the production pin PR.

**Production inspect (2026-11-19).** Read-only `--inspect` through SSM `67613a6c-45ae-4d2e-b1ba-5adb161b80a1` on
`i-0c35557c4e5385406` (under the owner's words "run the SQL 170 production inspect"; runner started from stopped with no SSM
command in progress at 17:28:02Z, command 17:28:35Z to 17:28:40Z, AWS-RunShellScript, Success, runner stopped again at 17:29:27Z,
all by `user/claude-code`; an AWS-managed AmazonInspector2-ConfigureInspectorSsmPlugin command `029078bf` was in progress at the
stop, as during earlier inspects, and no SQL ran in it), main `bc3d16a92` (tarball sha256
`e48f8139dae4de7f79e898fad14d3c7049c76366d556cc53faa9491b4239acb1`, checked by `sha256sum -c` on the runner, `SOURCE_COMMIT` matched,
staged by `sql53-temporary-transfer.yml` run 44576498107; sha256 of the printed sql170 output, computed on the runner,
`f6844c88119c7e1a38ea22f324af5acce4377559c209262892a683328ad4ebe2`, 3438 bytes), exit 0, `ok` true, `read_only` true, `source_ok` true,
`current_user` `checksops_admin`, `predecessors_applied` true: live `747d10df6bd187e566fff75f14e2c2be43f14e350e70a7fabb8457931a3a7dc4` (the eight columns, the index and the three functions
absent: the derived pre-state, equal to staging's before its apply), no predecessor, `prerequisites_missing` `[]`, `successors_applied`
`[]`, `definer_writes` `check_endorsements` ok, `already_applied` false, `precondition_failures` `[]`, `apply_preconditions_met` false (no
pre-state recorded yet). Production's pre-state equals staging's (read-live run 44569070362 and the staging apply's `before_hash`), so
the staging apply took the path production will. Recorded in the production pin with the staging apply (run 44576208345) as its
staging acceptance and `execute: true` under the owner's words "open the SQL 170 production pin PR". The owner merges the pin change;
the apply runs only after that merge is on main and staged, under the owner's words for that run (phrase
`SHOW_ENDORSEMENT_EMAIL_STATUS`).

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec `sql170` in
`release-sql-specs.mjs`). Intended `e53dd2feaae35238f25a194cae9bc4d6356c21d4ad616051180c162eb59b0c81`:

```
release sql170 v1
function public.aws_endorsement_email_event(text, text, timestamp with time zone, text): lang=plpgsql vol=v parallel=u secdef=true result=integer config=row_security=off;search_path=public prosrc=81e6868992a7749fdd970392788acd06628916ca2685530e8fffda2282d14b29 acl=checksops EXECUTE;owner EXECUTE
function public.aws_endorsement_email_sent(uuid, text): lang=plpgsql vol=v parallel=u secdef=true result=boolean config=row_security=off;search_path=public prosrc=f0fc74bdf622e4383b02c080285aa30a2cabe29ea90ebfde64beded03f1d45b4 acl=checksops EXECUTE;owner EXECUTE
function public.aws_endorsement_link_opened(uuid): lang=plpgsql vol=v parallel=u secdef=true result=integer config=row_security=off;search_path=public prosrc=2ec936d2144f16196cdc1e82fbb6b9b7c40ab584cf1d30baa191f8e3f212d15e acl=checksops EXECUTE;owner EXECUTE
column public.check_endorsements.email_message_id: text notnull=false default=- acl=
column public.check_endorsements.email_delivered_at: timestamp with time zone notnull=false default=- acl=
column public.check_endorsements.email_bounced_at: timestamp with time zone notnull=false default=- acl=
column public.check_endorsements.email_bounce_reason: text notnull=false default=- acl=
column public.check_endorsements.email_complained_at: timestamp with time zone notnull=false default=- acl=
column public.check_endorsements.link_first_opened_at: timestamp with time zone notnull=false default=- acl=
column public.check_endorsements.link_last_opened_at: timestamp with time zone notnull=false default=- acl=
column public.check_endorsements.link_open_count: integer notnull=true default=5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9 acl=
index public.check_endorsements check_endorsements_email_message_id_idx: 8a76a6374d61c77a2f34cb4a780edfa96fadaf73e4304c3ba7d01fb5fa7eae9d
```

**Expected pre-state (both environments).** Everything absent:

```
release sql170 v1
function public.aws_endorsement_email_event(text, text, timestamp with time zone, text): absent
function public.aws_endorsement_email_sent(uuid, text): absent
function public.aws_endorsement_link_opened(uuid): absent
column public.check_endorsements.email_message_id: absent
column public.check_endorsements.email_delivered_at: absent
column public.check_endorsements.email_bounced_at: absent
column public.check_endorsements.email_bounce_reason: absent
column public.check_endorsements.email_complained_at: absent
column public.check_endorsements.link_first_opened_at: absent
column public.check_endorsements.link_last_opened_at: absent
column public.check_endorsements.link_open_count: absent
index public.check_endorsements check_endorsements_email_message_id_idx: absent
```

That is `747d10df6bd187e566fff75f14e2c2be43f14e350e70a7fabb8457931a3a7dc4` (`releaseStateHash('sql170', {})`). Each pin
records its own environment's read; neither value is written into a pin before a run reads it. A pre-state other than
this one is a stop.

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present` (`check_endorsements`, its `id` column, the role `checksops`); `definer_can_write_relations` on
`check_endorsements` (the functions update it past row security); `altered_relations_owned_by_login` on
`check_endorsements`; `added_columns_absent_or_intended`; `added_indexes_absent_or_intended`;
`functions_owned_by_login`, `function_results_match` and `function_acl_replaceable` (each function absent, or owned by
the login with the same result type and only the ACL entries the file sets).

Post-conditions: the intended fingerprint; everything else in schema `public` unchanged. The tools roll back otherwise.

## Steps

Each step is its own reviewed PR or run and waits for the owner's words for that step.

1. Staging: the staging executor must carry SQL 170 first (executor package refresh through the guarded staging executor
   `deploy` mode, its own reviewed run). Then `read-live` for `sql170-check-endorsement-email-status`.
   Expected `already_applied` false, `precondition_failures` `[]`, `prerequisites_missing` `[]`, live `747d10df…`.
   Otherwise stop. Record `LIVE_DEFINITION_SHA256` in the staging pin (`expected_live_definition_sha256`, owner-approved
   `authorization`, `execute: true`, wave 62) in a reviewed change, `apply`, then `read-live` again.
2. Production: with the owner's OK for that read, the read-only inspect on the runner
   (`node scripts/deployment-guard/production-sql-one-shot.mjs --migration sql170 … --phase inspect`); record
   `production_inspect`, copy `live_definition_sha256` into `expected_live_definition_sha256`, record the staging runs in
   `staging_acceptance`, set an owner-approved `authorization` and `execute: true`, in one reviewed change.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs --migration sql170
   --approval-scope sql170 … --phase apply` with the owner's words (authorization phrase
   `SHOW_ENDORSEMENT_EMAIL_STATUS`).
4. Record the apply and retire the pin (`execute: false`).
5. Then the API (sending stores the message id, the endorsement page records the opening, the Resend webhook records the
   delivery reports) and the website (the status beside each payee), each its own PRs and runs with the owner's words.

Rollback (not part of this pin; a reviewed step of its own if ever needed): drop the three functions, the index and the
eight columns. The recorded statuses and openings are lost; nothing else depends on them.
