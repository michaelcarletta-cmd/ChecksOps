# Scheduled Check Alt status check (production)

Every 30 minutes, EventBridge Scheduler invokes `checksops-production-prep-api`
directly with job `checkalt-poll-deposits`. The job refreshes every non-final
Check Alt deposit (`pending_approval`, `submitted`; `CHECKALT_STATUS_REFRESH_STATUSES`)
through the same read-only reconcile as Poll Now. That reconcile uses the
status-read fetch guard, which allows authenticate, `/deposit/item`,
`/deposit/history` and `getUserAccountInformation` and refuses
`/deposit/process`, `/deposit/approve` and `/useraccount/register`. The job
never inserts a deposit and moves no money.

Definition: `aws/production/checkalt-status-reconcile-schedule.yaml` (stack
`checksops-production-checkalt-status-schedule`: one IAM role that may only
call `lambda:InvokeFunction` on the prep Lambda, and one
`AWS::Scheduler::Schedule`). The direct invoke is IAM-authorized, so there
is no shared secret and the Lambda environment does not change.
`scheduled.mjs` accepts this event shape only for `checkalt-poll-deposits`.
An HTTP request cannot produce it, because API Gateway builds `version`,
`routeKey`, `headers` and `requestContext.apiId` itself.

## Why the job needs an actor

Every `checkalt_deposits` read and write runs under row security as
`checksops`, and that requires `request.app_user_id`. The job runs as the
platform-owner `application_user_id` given in the stack parameter
`ActorApplicationUserId`. It checks `public.is_platform_owner()` and refuses
to call Check Alt if that check is false. Like Poll Now, it binds the same
financial GUCs that approve uses (production holds are lifted). Without them,
`aws_checkalt_production_config()` (SQL 65) raises 42501, aborts the
transaction, and the API returns 503 `checkalt_config_unreadable`. Each row is
refreshed in its own savepoint.

## Order (each step is its own owner approval)

1. The Lambda members of this PR are live in staging and accepted there.
2. The Lambda members are live in production, in order, through
   `guarded-production-lambda-overlay.yml`:
   `providers/production/checkalt-poll.mjs`, then
   `providers/production/checkalt-status-reconcile.mjs`, then `scheduled.mjs`.
   Each apply needs `DEPLOY <member> TO PRODUCTION`.
3. Poll Now works in production. The owner presses it once on the
   "Waiting in Check Alt" tab and the toast shows a per-deposit result.
4. Create the schedule through the guarded workflow
   `.github/workflows/guarded-production-checkalt-schedule.yml` (production
   environment, role `ChecksOpsGitHubProductionLambdaOverlay`). Preflight:
   `scripts/deployment-guard/github-production-checkalt-schedule.mjs` (read-only).
   Writer, the only thing that writes:
   `scripts/deployment-guard/production-checkalt-schedule.mjs`.

   **One-time IAM prerequisite (owner-approved, manual, not done by the PR that
   added the workflow).** The deploy role has no CloudFormation, IAM or
   Scheduler rights until an operator attaches the statements checked in at
   `aws/production-lambda-overlay/policies/permissions-policy.json` (Sids
   `InspectExactCheckAltStatusScheduleStack`,
   `CreateExactCheckAltStatusScheduleStack`,
   `UpdateExactCheckAltStatusScheduleStack`,
   `InspectExactCheckAltStatusScheduleRole`,
   `CreateExactCheckAltStatusScheduleRole`,
   `PassCheckAltStatusScheduleRoleToSchedulerOnly`,
   `InspectExactCheckAltStatusSchedule`,
   `CreateUpdateExactCheckAltStatusSchedule`) to the live role, once. Each is
   scoped to this stack (`stack/checksops-production-checkalt-status-schedule/*`),
   this IAM role (`role/checksops-production-checkalt-status-schedule`; PassRole
   only to `scheduler.amazonaws.com`) or this schedule
   (`schedule/default/checksops-production-checkalt-status-reconcile`). There is
   no delete right. Until they are attached, inspect fails with
   `AccessDenied` and nothing changes. This is the single remaining manual step.
   After the create, the create-only statements
   (`CreateExactCheckAltStatusScheduleStack`,
   `CreateExactCheckAltStatusScheduleRole`) can be detached again; pause and
   resume need only the inspect, update, PassRole and schedule statements.

   a. **Inspect** (`mode: inspect`). It checks the template bytes against the
      pinned sha256
      (`4db5dd4f1e9abf120db92dedb8e3213ddc4960a21bb96d5aa6c19d3a478a5845`,
      main `bd9fe944b`) and reads the stack, the IAM role, the schedule and the
      prep Lambda. `ABSENT` means create may proceed. The run summary shows the
      snapshot SHA-256.
   b. **Create** (`mode: create`) with `approved_commit` = main,
      `expected_snapshot_sha256` from the inspect,
      `actor_application_user_id` = the platform-owner `application_user_id`
      (lower-case UUID, the template's `AllowedPattern`),
      `staging_acceptance_reference` = the run or PR URL that records step 1,
      and `approval_phrase` exactly the owner's words for this run:

      `CREATE CHECKALT STATUS SCHEDULE IN PRODUCTION`

      The production environment reviewer approves the job. It takes the
      `production-checkalt-status-schedule` lease, issues a KMS-signed receipt
      whose preflight fingerprint is the whole snapshot and whose owned
      components carry the actor id, re-reads before and immediately before the
      write, then sends one `CreateStack` with exactly the pinned template bytes,
      `CAPABILITY_NAMED_IAM`, `ActorApplicationUserId` and every other
      parameter at its default (`ENABLED`, `rate(30 minutes)`), with
      `OnFailure=DO_NOTHING`. It waits for `CREATE_COMPLETE`. On any other end
      state it prints the failed stack events and stops: no retry, no delete.
      A failed create is reported to the owner, and cleaning it up is a
      separate approved step.

   Fallback, only if the workflow cannot be used and the owner approves an
   operator run with the same words:

   ```bash
   aws cloudformation create-stack \
     --region us-east-1 \
     --stack-name checksops-production-checkalt-status-schedule \
     --template-body file://aws/production/checkalt-status-reconcile-schedule.yaml \
     --capabilities CAPABILITY_NAMED_IAM \
     --parameters ParameterKey=ActorApplicationUserId,ParameterValue=<platform-owner application_user_id>
   ```

   Use the template from main at the merged commit. Do not edit it in place.
5. Verify. The workflow's verify step re-reads everything: the stack is
   `CREATE_COMPLETE` from the pinned template, the schedule
   `checksops-production-checkalt-status-reconcile` exists and is `ENABLED`,
   its target is exactly `checksops-production-prep-api`, its role is
   `checksops-production-checkalt-status-schedule` (trust: scheduler only;
   policy: invoke the prep Lambda only), its input actor is the given id, and
   the prep Lambda did not move. Then, read-only and by hand: after the next
   run, the prep Lambda log has one invocation with no `/deposit/process` or
   `/deposit/approve` call. `checkalt_deposits.last_polled_at` moves for the
   non-final rows, and a still-unresolved row carries
   `last_status_payload.last_reconcile_unresolved` (key names and counts
   only).

To pause the job, run the same workflow with `mode: set-state`,
`schedule_state: DISABLED` and the owner's words
`PAUSE CHECKALT STATUS SCHEDULE IN PRODUCTION`; to resume, `schedule_state:
ENABLED` and `RESUME CHECKALT STATUS SCHEDULE IN PRODUCTION` (each after a
fresh inspect, with its snapshot SHA-256). The writer sends one `UpdateStack`
with `UsePreviousTemplate` that changes only `ScheduleState` (the other
parameters keep their previous values), and verify requires that nothing else
moved. To remove the schedule, delete the stack; the workflow cannot do that
(no delete right), so it is a separate operator step. Each of these is a
production change and needs the owner's approval of that run.
