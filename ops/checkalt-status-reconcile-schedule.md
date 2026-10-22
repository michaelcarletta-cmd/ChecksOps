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
4. Create the schedule (this file). The repository has no guarded
   CloudFormation workflow for production, and the Cloud Agent may not create
   stacks or IAM roles. So an operator who holds those rights runs the stack
   create, and only after the owner writes, for this run:

   `CREATE CHECKALT STATUS SCHEDULE IN PRODUCTION`

   ```bash
   aws cloudformation create-stack \
     --region us-east-1 \
     --stack-name checksops-production-checkalt-status-schedule \
     --template-body file://aws/production/checkalt-status-reconcile-schedule.yaml \
     --capabilities CAPABILITY_NAMED_IAM \
     --parameters ParameterKey=ActorApplicationUserId,ParameterValue=<platform-owner application_user_id>
   ```

   Use the template from main at the merged commit. Do not edit it in place.
5. Verify read-only. `scheduler:GetSchedule` returns
   `checksops-production-checkalt-status-reconcile` as ENABLED. After the next
   run, the prep Lambda log has one invocation with no `/deposit/process` or
   `/deposit/approve` call. `checkalt_deposits.last_polled_at` moves for the
   non-final rows, and a still-unresolved row carries
   `last_status_payload.last_reconcile_unresolved` (key names and counts
   only).

To pause the job, update the stack with `ScheduleState=DISABLED`. To remove
it, delete the stack. Both are production changes and need the owner's
approval of that run.
