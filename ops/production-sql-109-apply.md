# Production SQL 109 (the Moov transfer webhook writer), after SQL 91

| key | file | what it does |
|---|---|---|
| `sql109` | `aws/workflows/sql/109_moov_transfer_webhook_status.sql` (sha256 `228725d8ebb81803e0fd172d92d677640eaefd51c62616c691bf3bb8775662ea`) | `CREATE OR REPLACE FUNCTION public.aws_moov_webhook_apply_transfer_status(...)`: SECURITY DEFINER, `search_path = public`, EXECUTE `checksops` only (PUBLIC revoked). Writes one `payment_transfers` row (a `wallet_funding`, `send_wallet` or `send_bank` leg) and one `payment_event_log` row per handled Moov transfer event, only while the webhook route has set `request.provider_webhook_apply = '1'` (SQL 91's `aws_moov_webhook_apply_active()`). No table, column, policy, grant or trigger change. |

**Why.** Production Moov webhooks are verified and logged (`aws_provider_webhook_receipts`) but
only onboarding status and tenant fee-collection outcomes were written back. A funding or send
leg kept the status Moov gave when it was created, so a later failure, an ACH return (R01, R10,
…), a reversal or a notification of change (NOC) never reached ChecksOps. The webhook runs as
`checksops` with no signed-in user; under RLS (`aws_select_payment_transfers`,
`aws_write_payment_transfers`, SQL 72's member policies) it can neither read nor update the row,
so the write needs one narrow definer writer, as SQL 99 did for `check_messages`.

**What the writer does** (the API side is `aws/functions/api/providers/moov-transfer-webhook.mjs`,
called from `providers/webhooks.mjs`):

- finds the row by `(provider 'moov', environment, provider_transfer_id)` and locks it; the
  tenant is the row's own `tenant_id`, never a payload field;
- answers `not_owned` for any other `leg_role` (fee collection stays with
  `tenant-collection-v2-settlement.mjs`) and `unknown_transfer` when no row matches;
- records each Moov event id once (`duplicate_event` on a replay);
- moves the status only to a higher rank (submitted 1, pending/processing 2, completed 3,
  failed/canceled 4, returned 5), so a late or replayed `pending` / `completed` never overwrites a
  failure or a return (`stale`), and a return after completion is applied;
- records an R code as `failure_reason` `ACH return R01: <reason>` and `provider_metadata.moov_return`,
  a C code (NOC) as `provider_metadata.moov_correction` without changing the status, and flags
  `provider_metadata.manual_follow_up` for a person (no payment method is edited);
- appends one `payment_event_log` row per handled event (outcome, codes, Moov event id);
- returns `notify` true once, on the move into `failed` or `returned`.

It never posts a wallet ledger entry and never moves money: the production funding and send
paths post no ledger entries (the balance shown is Moov's, which already reflects a return).

**Status:** pending. Both pins are `execute: false`, `authorization: "pending"`, with no recorded
pre-state; nothing is applied by this change. Neither staging nor production has been inspected.

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec
`functions` in `release-sql-specs.mjs`): the function's language, volatility, SECURITY DEFINER,
result, `search_path`, body hash and EXECUTE ACL, or `absent`. Intended
`925e018f0262556b8c43f872dc13ace4eeb36b411773189dc68592a37efb1982`:

```
release sql109 v1
function public.aws_moov_webhook_apply_transfer_status(text, text, text, text, text, text, text, text, text, text, timestamp with time zone): lang=plpgsql vol=v parallel=u secdef=true result=jsonb config=search_path=public prosrc=9d428fd93b9128395f6a82ec30e8228e038e258fd6ec104d83cfa5036e769884 acl=checksops EXECUTE;owner EXECUTE
```

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present` (SQL 91's `aws_moov_webhook_apply_active()`, the two tables and the
columns the writer uses, role `checksops`); `predecessors_applied` (SQL 91 at its intended
fingerprint `f8611dcc…`); `definer_can_write_relations` (the login owns `payment_transfers` and
`payment_event_log` without FORCE ROW LEVEL SECURITY, or is a superuser or BYPASSRLS). The file
itself refuses with `55000 sql109_prerequisite_missing` / `sql109_definer_cannot_write`.

Post-conditions: the intended fingerprint; everything else in schema `public` (and the functions
of `auth`) unchanged. The tools roll back otherwise.

## Order

Any time after SQL 91. The API members (`providers/moov-transfer-webhook.mjs` ADD,
`providers/webhooks.mjs` REPLACE in `production-api-overlay-plan.json`) carry no `sql_before`:
if the Lambda is deployed first nothing breaks (the call fails inside a savepoint
and the webhook is accepted and logged as before, `apply_skipped: status_writer_unavailable`).
No later migration replaces the function.

## Status

- **Staging executor refreshed (2026-10-21).** Inspect run 39663331529 (main `c92fe457b`) found the
  live executor at CodeSha256 `+GbJNvIA…` without SQL 109 (adds only
  `sql/109_moov_transfer_webhook_status.sql`, supersedes the three engine files, nothing dropped,
  no collisions). Deploy run 39663572406 updated it to
  `UMqsKj8X1zp5UqWIZRHp9ZrzARJm3eQH/Zk8iKpOhps=`.
- **Staging read-live (2026-10-21).** Run 39663914111 (main `c92fe457b`, executor `UMqsKj8X…`):
  the function `absent`, live `e0f02501f167f4bee2bbb8bc32c1e19b23deb5425a650c63102030531aa9a077`
  (the release engine's fingerprint of exactly the absent function), SQL 91 applied, `definer_writes`
  ok for both tables, `already_applied` false, `precondition_failures` `[]`. Recorded in the
  staging pin (`expected_live_definition_sha256`, `execute: true`, wave 10) under the owner's
  statement of 2026-10-21, "apply SQL 109 in production", which covers SQL 109's whole guarded path.
- **Staging apply (2026-10-21).** After the staging pin change merged (#1137, main `74e4753fe`),
  executor inspect run 39672879013 and deploy run 39673164727 (executor
  `ueLvAc0a+7gZzOTGlfQurzX3ZbhOeeaNWVCKccOpI5o=`), then apply run 39673516794: `applied`,
  `e0f02501…` -> `925e018f0262556b8c43f872dc13ace4eeb36b411773189dc68592a37efb1982`. Read-live run
  39673878120: `already_applied` true, live = intended, `precondition_failures` `[]`.
- **Production inspect recorded (2026-10-21).** Read-only `--inspect` through SSM
  `57c033fc-62fe-4254-8fcd-02010fe92de5` on `i-0c35557c4e5385406`, main `74e4753fe` (tarball sha256
  `3d304c934c615533b8e20fa9c21514c7b5d576031d6ee459e937b9bf6d81ca3b`, transfer run 39674205877):
  function `absent`, live `e0f02501f167f4bee2bbb8bc32c1e19b23deb5425a650c63102030531aa9a077` (the
  same pre-state as staging), SQL 91 applied, `definer_writes` ok, `already_applied` false,
  `precondition_failures` `[]`. Recorded in the pin as `expected_live_definition_sha256`, with the
  staging apply run 39673516794 as `staging_acceptance`.
- **Pin `execute: true`** once that change is merged, under the owner's statement of 2026-10-21
  quoted above. Nothing is applied by it; the apply (step 3) passes the owner's words for that run.

## Steps

1. Staging: the staging executor must carry SQL 109 first (executor package refresh through
   `sql-executor-ensure.mjs` / the guarded staging executor `deploy` mode, its own reviewed run).
   Then `read-live` for `sql109-moov-transfer-webhook-status`. Expected `already_applied` false and
   `precondition_failures` `[]`. Record `LIVE_DEFINITION_SHA256` in the staging pin
   (`expected_live_definition_sha256`, owner-approved `authorization`, `execute: true`) in a
   reviewed change, `apply` with the owner's approval of that run, then `read-live` again
   (expected `already_applied` true). Staging's webhook route runs the sandbox apply path and does
   not call this function; the writer is covered on PostgreSQL 16 by
   `aws/tests/sql109-moov-transfer-webhook-status-pg.test.mjs`.
2. Production: run the read-only inspect on the runner
   (`node scripts/deployment-guard/sql109-moov-transfer-webhook-status-production-apply.mjs --inspect`,
   or the one-shot's `--phase inspect`); record `production_inspect` and copy
   `live_definition_sha256` into `expected_live_definition_sha256`; record the staging runs in
   `staging_acceptance`; set an owner-approved `authorization` and `execute: true`, in one
   reviewed change. Expected: `already_applied` false, `precondition_failures` [].
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs
   --migration sql109 --approval-scope sql109 … --phase inspect`, then the owner-named
   `--phase apply`.
4. Record the apply and retire the pin (`execute: false`); record SQL 109 verified live in the
   overlay plan's `sql_prerequisites` before overlaying the API members.
