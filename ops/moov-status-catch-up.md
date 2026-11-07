# Moov status catch-up

Owner request, 2026-11-07: "build the Moov status catch-up".

## Why

Production has never stored a `transfer.*` Moov webhook. Read-only evidence (SSM
`6db9b33b-e076-4735-96ba-0c1dd545030c`): `public.aws_provider_webhook_receipts` holds two
Moov receipts ever, `event.test` (2026-10-31) and `balance.updated` (2026-11-01), while
`AWS_PROVIDER_WEBHOOK_DRY_RUN` is `false`. The production API Gateway access log answers
`POST /prep/webhooks/moov` 401 about 290 times from 2026-09-20 to 2026-10-31 and 200 about
100 times since 2026-10-31. The live `providers/webhooks.mjs` (sha256 `59b58674…`, PR #1483)
keys a receipt on `X-Webhook-ID` alone and answers 200 `duplicate` on a conflict, so when
Moov repeats that header every later event, `transfer.*` included, is dropped. That receipt
key is fixed in a separate PR. Until it is live, webhooks keep dropping events. The catch-up
does not read `aws_provider_webhook_receipts` at all, so it works either way.

So transfer status never moved. Example: Freedom Adjustment's 2026-09 fee
(`tenant_maintenance_payments` `72b622f9-b68f-4032-a971-a854dbcfbf57`, status `due`, Moov
transfer `b31c7752-031f-4b8b-9b6e-82dd0aaed2cb`, leg `ab2895c9…` `submitted`). The owner saw
it as COMPLETED in the Moov dashboard. Other fee legs, partner sends (`send_wallet`,
`send_bank`) and wallet funding are probably stuck at `submitted` too.

## What it is

- `aws/functions/api/providers/moov-status-catch-up.mjs`: runs inside the API Lambda.
- `scripts/deployment-guard/moov-status-catch-up.mjs`: builds the direct-invocation event,
  calls `lambda:InvokeFunction` and prints the answer.
- `aws/tests/moov-status-catch-up.test.mjs`: tests for both.

For each candidate Moov transfer, it does what the webhook route (`providers/webhooks.mjs`)
does with a confirmed `transfer.updated`:

1. Reads the transfer from Moov with `confirmMoovWebhookPayload`
   (`GET /accounts/{platform}/transfers/{id}`). The trusted payload is built from Moov's
   record, not from anything ChecksOps holds.
2. Applies that payload with `applyProductionMoovTransferWebhook` (the SQL 109 writer, for
   `wallet_funding`, `send_wallet` and `send_bank` legs), then with
   `applyCollectionV2ProviderCompletion` (fee legs and their obligation), in the webhook's
   order.

Candidates are:

- `payment_transfers` rows with provider `moov`, this runtime's environment, a
  `provider_transfer_id`, and a status that is not final (`completed`, `settled`, `failed`,
  `canceled`, `returned`, `reversed`);
- `tenant_maintenance_payments` rows with a `provider_transfer_id` that are not `settled`.

Rows are grouped by Moov transfer id, so each transfer is read once.

## Where it runs, and why

It runs in the **production API Lambda** (`checksops-production-prep-api`), started by a
**direct invocation**.

- **Moov keys.** Only the production API runtime may use the production Moov keys.
  `resolveBillingMoovContext` refuses them anywhere else (`production_credentials_refused`),
  and that is how the SQL53 runner `i-0c35557c4e5385406` was refused. The runner keeps the
  database admin path for SQL. It does not get Moov keys.
- **No HTTP route.** The repo's privileged one-shots run on direct invocation, not on a
  route: the SQL 53 read-only inspect, and the Check Alt scheduled status job
  (`isSchedulerDirectInvocation` in `scheduled.mjs`). `isMoovStatusCatchUpInvocation` uses
  the same test. The event must have `checksops_operator: "moov-status-catch-up"` and
  `rawPath: "/scheduled/moov-status-catch-up"`, and it may carry only `requestContext.http.method`
  set to `POST`. It may not carry `version`, `routeKey`, `headers`, `body`,
  `queryStringParameters`, `apiId`, `stage` or any key outside the allowed list. API Gateway
  always adds those, so an internet request can never reach this code. Only a principal with
  `lambda:InvokeFunction` on the function can start it.
- **Row security.** `payment_transfers`, `tenant_maintenance_payments` and their policies
  apply to `checksops` with no user. Like the Check Alt scheduled job, the catch-up binds
  one reviewed actor, `actor_application_user_id`, as `request.app_user_id`. It refuses
  unless `public.is_platform_owner()` is true for that actor.

## Deploy prerequisite (a separate, owner-approved step)

This PR is source only. The catch-up cannot run until the Lambda serves it. That needs two
production overlay members, planned in their own PR and applied with their own approvals
(`ops/production-lambda-rebuild.md`, `ops/deployment-guard/README.md`):

1. ADD `providers/moov-status-catch-up.mjs`. It imports only members that are already in the
   live plan: `moov-webhook-confirm.mjs`, `moov-transfer-webhook.mjs`,
   `tenant-collection-v2*.mjs`, `tenant-billing-destination.mjs`, `db-health.mjs`,
   `secrets.mjs`, `provider-secrets.mjs` and `provider-flags.mjs`.
2. REPLACE `scheduled.mjs`, adding this hook next to the existing scheduler check:

   ```js
   import { handleMoovStatusCatchUp, isMoovStatusCatchUpInvocation } from './providers/moov-status-catch-up.mjs';
   // in handleScheduledRequest, before the shared-secret check:
   if (isMoovStatusCatchUpInvocation(event)) return handleMoovStatusCatchUp(event, deps);
   ```

   `index.mjs` already routes `/scheduled/*` to `scheduled.mjs`, and `index.mjs` is never
   overlaid.

**Planned (2026-11-07, planning only).** The hook is in `scheduled.mjs` on main, and the
production overlay plan has both rows. The manifest is
`aws/tests/fixtures/production-moov-status-catch-up-manifest-2026-11-07.json`.

- `providers/moov-status-catch-up.mjs`: ADD (expected absent).
- `scheduled.mjs`: REPLACE `458ba424…` -> the hook bytes.
- Order: both rows come right after `tenant-billing-destination.mjs`, past the planned ADD rows
  the catch-up imports. The ADD comes first, because `scheduled.mjs` imports it at load.
- Release lock: the `auto-deposit` `tree_hash` moves with `scheduled.mjs`.

The two open questions above are answered from the record:

- **Which bytes are live.** `458ba424…`, not `4b06d4cd…`.
  - Overlay apply run 39806472626 (2026-10-22) replaced `4b06d4cd…` with `458ba424…`
    (`VERIFIED`). Inspect run 39806888970 then read `ALREADY_ACCEPTED`. Neither was recorded in
    git, which is why the row still expected `4b06d4cd…`.
  - The fourth full-package production rebuild (apply run 41469896446, 2026-11-02, main
    `1364af787`) kept those bytes. `scheduled.mjs` is not among that section's changed members,
    and main's `scheduled.mjs` at `1364af787` is `458ba424…`.
  - No overlay run touched `scheduled.mjs` after 2026-10-22. This is from the logs of every
    production overlay run from 2026-10-22 to 2026-11-07.
- **The live copy that `ops/live-api-reconciliation-2026-10-21.md` records**
  (`moov-monthly-tenant-billing`) is no longer live.
- **Only the two hook lines differ** from `458ba424…`. A test strips them and gets that hash back.
- **Every module the catch-up imports is live at main's bytes.** The modules come from the rebuild,
  and `tenant-collection-v2.mjs` from fee leg apply 42366401914.

**Before each apply**, a read-only overlay inspect (`guarded-production-lambda-overlay.yml`,
`mode: inspect`) must print:

- `ABSENT` for `providers/moov-status-catch-up.mjs`;
- `LIVE_MEMBER_SHA256` `458ba42455afe324ba4e8169bf23cdbd15498b180ada279286a8a92be6193791` for
  `scheduled.mjs`.

Any other value is a stop (`SOURCE_RECONCILIATION_REQUIRED`). Each apply also needs a staging
acceptance reference and the owner's `DEPLOY <member> TO PRODUCTION` for that run.

**Applied (2026-11-07, main `050db7b33`).** Both members are live in production, recorded in
`aws/tests/fixtures/production-moov-status-catch-up-applied-manifest-2026-11-07.json`:

- `providers/moov-status-catch-up.mjs`: inspect run 42370515427 (`READY`, `ABSENT`), apply run
  42370581114 (`VERIFIED`, `502995f6…` present), re-inspect run 42370641735 (`ALREADY_ACCEPTED`).
  Staging acceptance: run 42370270563.
- `scheduled.mjs`: inspect run 42370698741 (`READY`, `458ba424…` live), apply run 42370751130
  (`VERIFIED`, `39d7c568…` live), re-inspect run 42370821197 (`ALREADY_ACCEPTED`). Staging
  acceptance: run 42370407042.

Step 0 below is done. The catch-up itself has not been run.

**Invoke identity.** A principal needs `lambda:InvokeFunction` on
`arn:aws:lambda:us-east-1:806168576068:function:checksops-production-prep-api`. The owner chose
a dedicated limited role (2026-11-07: "Dedicated limited role for status catch up"):
`ChecksOpsGitHubProductionMoovStatusCatchUp`, used only by the workflow
`.github/workflows/production-moov-status-catch-up.yml`. Its only permission is that invoke; its
trust is pinned to that workflow file on `main` in the `production` environment. The owner
creates it and sets the GitHub variable `CHECKSOPS_PRODUCTION_MOOV_STATUS_CATCH_UP_ROLE_ARN`
(`ops/deployment-guard/production-moov-status-catch-up/README.md`). This repository writes the
policy documents; it never creates IAM.

**The workflow.** `production-moov-status-catch-up.yml` (Actions, Run workflow, from `main`) runs
in the `production` environment, so every run, plan included, waits for the owner's approval of
that run. Inputs: `phase` (`plan` or `apply`), `actor_application_user_id`, `limit`, and for apply
only `manifest_sha256`, `transfer_ids` (comma separated) and `approval_phrase`. It invokes the
Lambda through `scripts/deployment-guard/github-production-moov-status-catch-up.mjs`, which builds
the event with `scripts/deployment-guard/moov-status-catch-up.mjs`, and prints the Lambda's JSON in
the log and the run summary. It reads no secret. The two commands below are the same steps from an
owner's own AWS session.

## Steps and approvals

Each step needs its own approval. An approval never carries over to the next step.

0. **Deploy** the two members above, with the owner's approval of that overlay run.
1. **Staging rehearsal** (recommended before production). Run
   `--environment staging --phase plan`. Staging is `sandbox` there, and its
   apply runs only if `AWS_PROVIDER_WEBHOOK_DRY_RUN` is `false` on staging.
2. **Plan, read-only.** The owner says: **"run the read-only Moov catch-up plan"**.

   ```bash
   node scripts/deployment-guard/moov-status-catch-up.mjs --environment production \
     --phase plan --actor-application-user-id <platform owner application user id> \
     --limit 50 --out moov-catch-up-plan.json
   ```

   The plan reads the candidates inside `BEGIN READ ONLY` (it checks
   `transaction_read_only = on`), then reads Moov. For every transfer it prints:

   - the database status of each leg and obligation;
   - Moov's status, amount and ACH return or NOC code;
   - `predicted_status`, the status the apply functions would write;
   - `action`: `apply`, `skip` or `refuse`, with a `reason`.

   It also prints `counts`, the `manifest_sha256` and the `transfer_ids`. It writes nothing.

   Through the workflow: `phase: plan`, the actor id and the limit; leave the apply inputs
   empty (a plan run with any of them is refused). The plan JSON is in the run summary.
3. **Review.** Send the owner the plan file: the counts, every `apply` row, and every
   `refuse` row (`amount_mismatch`, `terminal_row_would_change`, `duplicate_legs`). Stop if
   anything looks wrong.
4. **Apply.** Only with the owner's exact words for this plan, for example
   *"apply the Moov catch-up plan &lt;manifest_sha256&gt; in production"*:

   ```bash
   node scripts/deployment-guard/moov-status-catch-up.mjs --environment production \
     --phase apply --actor-application-user-id <same uuid> --plan moov-catch-up-plan.json \
     --approval-statement-b64 <base64 of the owner's exact words>
   ```

   Through the workflow: `phase: apply`, the same actor id and limit, the plan run's
   `manifest_sha256` and `transfer_ids`, and `approval_phrase` exactly
   `apply the Moov catch-up plan <manifest_sha256> in production` with that hash, the owner's
   words for that plan. Anything else is refused before any AWS call. The workflow then plans
   again and invokes the apply only if the fresh plan has exactly that `manifest_sha256` and
   those transfer ids; the apply event is built from that fresh plan.

   The apply first plans again. It refuses and writes nothing if any of these hold:

   - the new manifest hash differs from the reviewed one (`catch_up_plan_changed`: the
     database or Moov moved);
   - the transfer ids differ;
   - the plan was truncated;
   - Moov could not be read.

   Then it runs one transaction per transfer:

   1. Bind the actor and set `request.provider_webhook`.
   2. Lock the rows with `FOR UPDATE` and re-check the planned pre-state
      (`catch_up_state_changed_since_plan`).
   3. Run the two apply functions.
   4. Re-read the rows and require exactly the planned post-state
      (`catch_up_outcome_differs_from_plan`).
   5. `COMMIT`.

   Any failure rolls back that transfer and stops the run (`stopped_at`). Transfers already
   committed stay committed and are listed in `applied`.
5. **More than `--limit` candidates.** Repeat steps 2 to 4 with a fresh plan and a fresh
   approval for each batch.
6. **Record.** Keep the plan and apply JSON, the invoke request ids and the owner's words in
   a record PR. No pin or lock changes.

## Idempotent

- A transfer that has been applied is no longer a candidate.
- The SQL 109 writer records the event id `moov-status-catch-up:<transfer id>:<moov status>`
  once per transfer.
- An old `manifest_sha256` no longer matches a new plan.
- Running apply again is refused and writes nothing. A new plan shows nothing more to apply.

## What it does not do

- It moves no money. It creates, cancels and retries no Moov transfer. Moov is only read with
  `GET`.
- It writes nothing that did not come from Moov's read-back.
- It does not change a transfer Moov has not finished (`created`, `queued`, `pending`:
  `moov_not_final`).
- It refuses an amount or currency that differs from Moov's (`amount_mismatch`), and a
  transfer Moov cannot find (`moov_not_found`).
- It never rewrites a final row (`terminal_row_would_change`), and it never moves a status
  backwards (the SQL 109 rank).
- It inserts no `aws_provider_webhook_receipts` row and does not fix the webhook receipt key
  (separate PR).
- It does not change the Moov webhook subscription (the owner does that in Moov).
- It changes no SQL, policy, grant, Lambda configuration or release lock, and it deploys
  nothing.
- Its output never includes secrets, account or routing numbers, payment method ids, Moov
  account ids, notes or hostnames.

## Open questions (verify in the staging rehearsal)

- **Fee completion event under row security.** `applyCollectionV2ProviderCompletion` inserts
  a `payment_event_log` row (`collection_v2.completed`). The insert policies on that table
  accept `request.provider_webhook_apply = '1'`, which the SQL 109 call resets to `0` before
  the collection call. They also accept a tenant member with `request.financial_execution`.
  Neither is the platform-owner actor. If production refuses that insert, the transaction
  aborts. The catch-up then fails its post-state check, rolls back and stops on the first fee
  transfer. That is safe, but the September fee would stay `due` until a reviewed fix (a
  policy or a narrow writer) lands. The same row security means the live webhook, which has
  no user, may not see fee rows at all, so `no_billing_occurrence` is possible there.
- **Who may invoke the production Lambda**: answered, the dedicated role above (see "Invoke
  identity"). It works only once the owner has created it and set the variable.
