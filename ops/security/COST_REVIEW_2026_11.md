# Cost review, 2026-11-17: what was changed and what was not

Owner, 2026-11-17: "how can we drop the costs down" (October bill $351.67), then a go for each
numbered item of the review. This note records the items that have no note of their own. No
guarded workflow covers these resources, so each was an explicit exception on the owner's words,
run by Claude through boto3 (see the identity correction below).

**Correction, 2026-11-17 (identity).** Every write in this review (items 1, 5, 7, 8 and 9) ran as the account **root** user, not as
`user/claude-code`. They went through the AWS connector attached to the Claude session
(`aws-mcp.amazonaws.com`), which is signed in as root. CloudTrail: `userIdentity.type` `Root`,
`arn:aws:iam::806168576068:root`, source and user agent `aws-mcp.amazonaws.com`, for each write
listed here. The read-only inventory at the start of the review did run as `user/claude-code`,
through the session proxy. The limits in `ops/security/IAM_CLAUDE_CODE_LEAST_PRIVILEGE.md` did
not apply to the connector, and root use is what the `Policy:IAMUser/RootCredentialUsage`
GuardDuty finding reports.

| item | what | owner's words | state | record |
|---|---|---|---|---|
| 1, 8 | Delete the old four-AZ NAT and its addresses; release idle `100.50.171.44` | "do 1 and 8" | done | `ops/security/NAT_GATEWAY_COST_PLAN_2026_11.md` |
| 5 | Delete the Cognito interface endpoint | "do 4 and 5" | done, with a 19-request production 401 burst | `aws/rls/COGNITO_IDP_VPCE.md` |
| 6 | X-Ray `Active` → `PassThrough` | "do 3 and 6", then "apply the x-ray change live" | templates merged (#1974); applied live 2026-11-17 17:39–17:40 UTC | #1974 and below |
| 7 | Security Hub: disable CIS 1.2.0 | "do 7, 9 and 10 and 2" | done | below |
| 9 | Staging backup retention 35 → 7 days | same | done | below |
| 3 | Cache Secrets Manager reads | "do 3 and 6", "land the secrets cache and move both pins", "ship the secrets cache with a guarded rebuild", then the two apply phrases | **live in staging and production** since 2026-11-17 (staging apply 44151849515, production apply 44155016281); `GetSecretValue` by the production API role fell from about 1,000 per five minutes to 60 for 1,442 requests | #1980, #1982, #1984, `ops/deployment-guard/lambda-rebuild-plan.json` |
| 4 | Merge the two Secrets Manager endpoints | "do 4 and 5" | **not done**, with the owner | below |
| 10 | Terminate the "SQL53 temporary runner" | "do 7, 9 and 10 and 2" | **not done, and must not be** | below |
| 2 | Shrink the NAT from two AZs to one | same, then "do it deterministically", then "proceed as roof" | done 2026-11-17 17:21–17:32 UTC, us-east-1a kept | `ops/security/NAT_GATEWAY_COST_PLAN_2026_11.md`, "Applied: one zone" |

## Item 7: Security Hub CIS 1.2.0 disabled

`BatchDisableStandards` for
`arn:aws:securityhub:us-east-1:806168576068:subscription/cis-aws-foundations-benchmark/v/1.2.0`
at 17:07:47 UTC, status `DELETING`. `GetEnabledStandards` 25 seconds later lists only
`aws-foundational-security-best-practices/v/1.0.0`, `READY`. Cost Explorer for October:
`USE1-PaidComplianceCheck` 10,145 checks, $10.14 across both standards. The share that was CIS
is not known, so the saving is an estimate of about half. Re-enabling is `BatchEnableStandards`
with `arn:aws:securityhub:::ruleset/cis-aws-foundations-benchmark/v/1.2.0`.

## Item 9: `checksops-staging` backup retention is 7 days

`ModifyDBInstance` `checksops-staging` `BackupRetentionPeriod=7`, `ApplyImmediately`, at
17:07:48 UTC. Read back: retention 7, status `available`, no pending values, deletion protection
still on. `checksops-production` is unchanged at 35 days with its `us-east-2` replication.
Automated backups of staging older than 7 days are deleted by RDS and cannot be recovered.

Documents that still say staging keeps 35 days describe the state before this change:
`ops/security/AWS_ACCOUNT_HARDENING_2026_11.md` (item 6),
`ops/security/RDS_PRIVATE_SUBNETS_PLAN_2026_11.md`, `aws/cutover/OPERATOR_SECURITY_HANDOFF_2TO6.md`.

## Item 6: X-Ray tracing is `PassThrough` on both API functions

Owner, 2026-11-17: "apply the x-ray change live". No guarded workflow changes `TracingConfig`
(`ops/lambda-configuration-change.md` covers environment variables only), so this was a direct
`UpdateFunctionConfiguration` with `TracingConfig.Mode=PassThrough` and the `RevisionId` checked, as
the account root user through the AWS connector, like the other writes of this review.

| function | time (UTC) | `RevisionId` before → after | unchanged |
|---|---|---|---|
| `checksops-staging-api` | 17:39:54 | `68668373-2865-4be4-9a9e-a5f451550fbc` → `d2fc1ab8-3a9e-4dc9-9dbb-5cf10b93a644` | `CodeSha256` `B9zvTiOU…`, 46 environment variables, subnet, security group |
| `checksops-production-prep-api` | 17:40:37 | `dfef83fc-d69b-497f-a768-61ced5ffbf10` → `a1441c7d-6379-4adc-adae-266b60304af6` | `CodeSha256` `B9zvTiOU…`, 50 environment variables, subnet, both security groups |

Verified: staging `GET /staging/authorization/jwks-check` 10 of 10 HTTP 200, `/staging/db-health`
and `/staging/providers/egress` 200. Production Lambda `Errors` 0 and average duration 140–170 ms
in the minutes around the change. Production `REPORT` log lines with `Sampled: true`: 160 of 161
at 17:39, 88 of 144 at 17:40, **0 of 83 at 17:41**. The live setting now matches the templates
merged by #1974. Cost Explorer for October: `USE1-XRay-TracesStored` 1,259,588 traces, $5.80.

Not verified: the X-Ray line on a later bill.

## Item 10: the runner is not a leftover

`i-0c35557c4e5385406` (`checksops-sql53-temporary-runner`) is the runner for every production SQL
apply (`ops/production-sql-one-shot.md`, "Runner state: stopped between runs"). It costs about
$1.28/month for its 16 GB volume while stopped. The review was wrong to list it. Nothing was changed.

## Item 3: the cache is written but changes pinned bytes

CloudTrail, 24 hours to 2026-11-17: 53,265 `GetSecretValue` calls for the production database
secret by `checksops-production-api-execution`, one per API request (October: 1,557,617 API
requests to Secrets Manager, $7.79). A five-minute cache in `getSecretStringFromAws`
(`aws/functions/api/secrets.mjs`) with six tests exists on an unpushed local branch. It makes 13
existing tests fail, because the bytes of `secrets.mjs` are pinned:
`SQL53_READONLY_INSPECT_SECRETS_SHA256` in `sql53-production-readonly-inspect.mjs` (12 tests; the
inspect refuses when the live file differs) and the accepted staging hash in
`ops/deployment-guard/lambda-rebuild-plan.json` (1 test). No pin was edited. Landing the cache
means moving both pins in the same reviewed PR; that is the owner's decision.

**Update, same day.** The paragraph above is the state before the owner's decision. The owner chose
to land it ("land the secrets cache and move both pins"): #1980 merged the cache and moved the
pins, with hashes from `hashSql53PackageMember`, and no accepted hash in the rebuild plan was
edited. It reached both functions by a guarded full rebuild
(`ops/production-lambda-rebuild.md`): staging apply run 44151849515 (18:49:27 UTC) and production
apply run 44155016281 (19:07:12 UTC), each `VERIFIED`, on the owner's exact phrases. The rebuild
also carried `workflow-delete-check.mjs`, the Delete Check workstream's rebuild-only change, which
the owner was shown and chose to ship ("ship all three to staging"). CloudTrail afterwards:
`GetSecretValue` by `checksops-production-api-execution` was 1,209 and 1,006 in the two
five-minute windows before the apply and 60 in the first full one after it, for 1,442 requests.
The full record is the ninth sections of `ops/deployment-guard/lambda-rebuild-plan.json`.

## Item 4: not a delete

- `vpce-01649ea2cdb21a689` (production, private DNS off) is named by its own DNS name in the
  production SQL runbooks and is the only HTTPS destination the `checksops-production-lambda`
  security group allows. It stays.
- `vpce-0962386266e90e1c6` (staging, private DNS on) is `SecretsManagerVpcEndpoint` in the
  `checksops-staging` stack. Removing it is a template change and a stack deploy, and it is another
  private-DNS switch on a name the production API resolves on every request (see item 5's record
  for what one such switch cost).

## Item 2: one-AZ NAT

`nat-1f2d1e419482e2737` is a manual-mode regional NAT in us-east-1a and us-east-1f. The
[regional NAT documentation](https://docs.aws.amazon.com/vpc/latest/userguide/nat-gateways-regional.html)
says traffic from a zone the gateway has not yet expanded to "is processed across zones" for
automatic mode; for manual mode it says only that "you are responsible for expanding and
contracting". Whether a manual-mode gateway drops traffic from a zone with no address is not
documented and was not tested.

The deterministic route is to take every VPC Lambda out of one zone first. Read-only state:
- VPC Lambdas, all in `subnet-0df2518070c5b9ff0` (1a) and `subnet-092e4e41821fba6c4` (1f):
  `checksops-production-prep-api`, `checksops-staging-api`,
  `checksops-staging-guarded-sql-executor`, `checksops-staging-rehearsal-oneshot`.
- `checksops-production` is Multi-AZ, primary us-east-1f, standby us-east-1a.
- `checksops-staging` stack parameter `SubnetIds` is both subnets.

Two facts the owner did not have when choosing this route:
- **No guarded workflow changes a Lambda's VPC configuration.** `ops/lambda-configuration-change.md`
  covers environment variables only ("not code, not the role, runtime, handler, memory, timeout or
  VPC"). The change would be a direct `UpdateFunctionConfiguration` on the production API, plus the
  stack parameter and templates so that a later deploy does not put the second subnet back.
- **It makes the whole production API single-AZ, not only its egress.** With one subnet, a failure
  of that zone stops the API even though the database fails over.

Nothing had been changed for item 2 when this section was written. The owner then chose to proceed;
see `ops/security/NAT_GATEWAY_COST_PLAN_2026_11.md`, "Applied: one zone (2026-11-17)". The zone kept is
us-east-1a, not us-east-1f, because the production SQL runner is there.

## Second round, same day: endpoints to one zone and a database reservation

Owner, 2026-11-17: "what else can we do to cut costs", then "do 1 and 2" of that second list
(1: shrink both Secrets Manager endpoints to the one zone the Lambdas now use; 2: buy a 1-year
reserved instance for the databases). Asked which reservation to buy, with the prices below, the
owner chose "Production only, no upfront". The writes ran as the account root user through the AWS
connector, like the others of this review.

**Endpoints.** Both interface endpoints had an interface in each Lambda subnet; since the NAT
change every VPC Lambda runs only in `subnet-0df2518070c5b9ff0` (us-east-1a).

| time (UTC) | call | result |
|---|---|---|
| 20:22:02 | `ModifyVpcEndpoint` `vpce-01649ea2cdb21a689` (production, private DNS off) `RemoveSubnetIds=[subnet-092e4e41821fba6c4]` | `available` with one interface, `eni-006d1d9683a31fb3b`, by 20:22:51; its regional DNS name, the one the production SQL runbooks use, is unchanged |
| 20:23:04 | the same on `vpce-0962386266e90e1c6` (staging stack, private DNS on) | `pending` at 20:23:59, `available` with one interface, `eni-03224d8d3e5c575b1`, when read at 20:25:58; private DNS still on |

Read first: no file in the repository uses a zone-specific endpoint name. Verified:
`GET /staging/db-health` 30 of 30 HTTP 200 from 20:24 to 20:25:58, while the staging endpoint was
changing. Production API access log 20:15–20:28: HTTP 200 for every request (1 or 2 a minute until
20:25, then 45 to 63 a minute); Lambda average duration 85–206 ms; no log line matching a timeout,
a connection error or a secret error. Two endpoint interfaces fewer is 2 x 730 h x $0.01 =
about $14.60 a month.

The staging endpoint is `SecretsManagerVpcEndpoint` in the `checksops-staging` stack. The stack's
`SubnetIds` parameter has named only the us-east-1a subnet in `aws/samconfig.toml` since #1978, so
the next staging stack deploy asks for what is now live. Until then CloudFormation's recorded state
of that resource differs from the live one.

Not verified: the production SQL one-shot path against the one-interface production endpoint (it
was not run), and `checksops-p5c-sql-oneshot` and the staging read-only diagnostic from the
us-east-1f subnet, which now reach an endpoint interface in the other zone.

**Reservation.** `PurchaseReservedDBInstancesOffering`, offering
`17163f16-0f60-41c4-9f82-5e6416901ace`, read back immediately before the purchase as
db.t4g.small, Multi-AZ, postgresql, 1 year (31,536,000 s), No Upfront, $0 fixed, $0.047 an hour.
Reservation id `checksops-production-t4g-small-maz-2026-11`, count 1, start
2026-11-17T20:30:30Z, state `payment-pending` when last read at 20:31:24 (not yet seen `active`).
There was no reservation before it. It covers `checksops-production`, which was billed $0.065 an
hour on demand in October (`Multi-AZUsage:db.t4g.small`, 744 h, $48.36): about $13 a month less,
against a commitment of 8,760 h x $0.047 = about $412 for the year, which cannot be cancelled.
`checksops-staging` was left on demand so that it can be stopped on a schedule later.

The other offers at the time, for the record: production Partial Upfront $195 + $0.022 an hour,
All Upfront $379; staging (db.t4g.micro, single-AZ) No Upfront $0.012 an hour, Partial Upfront
$49 + $0.006 an hour, All Upfront $95.

## Second round, continued: Internet Monitor off, staging database stopped at night

Owner, 2026-11-17: "do 3 and 5" of the second list (3: stop the staging database on a schedule;
5: turn off CloudWatch Internet Monitor on the CloudFront distribution). Asked how to handle the
staging database, with what stopping it would affect, the owner chose "Nights only": stop 1am to
7am Eastern every day and move the nightly staging job to 7:30am. The writes ran as the account
root user through the AWS connector.

**Internet Monitor.** `UpdateMonitor` `cloudfront_E1B0ZWWO5559U5-Monitor` `Status=INACTIVE` at
20:37:08 UTC; read back `INACTIVE`. The monitor was created on 2026-11-09, nothing in the
repository refers to it and no alarm uses it. It is switched off, not deleted; the distribution
`E1B0ZWWO5559U5` was read back `Deployed` and enabled and was not changed. Cost Explorer for
2026-11-01 to 11-16: `USE1-CW:InternetMonitor-MonitoredResource` $1.75.

**Staging database, nights.** Stack `checksops-staging-db-night-schedule` from
`aws/staging/db-night-schedule.yaml` (3,227 bytes, the template the stack was created from),
`CREATE_COMPLETE` at about 20:40 UTC:

- role `ChecksOpsStagingDbNightSchedule`, assumable by EventBridge Scheduler from this account,
  allowed `rds:StopDBInstance` and `rds:StartDBInstance` on `checksops-staging` only (the template
  does not accept another instance name);
- schedule `checksops-staging-db-stop-nightly`, `cron(0 1 * * ? *)` America/New_York;
- schedule `checksops-staging-db-start-morning`, `cron(0 7 * * ? *)` America/New_York.

Two things moved out of the stopped hours:

- `ModifyDBInstance` `checksops-staging` `PreferredMaintenanceWindow` `wed:06:52-wed:07:22` →
  `wed:03:00-wed:03:30` (UTC) at 20:40:26, no pending values. The backup window, 04:03–04:33 UTC,
  is before the stop in both winter and summer time and was not changed.
- `PutRule` `moov-monthly-tenant-billing` ("Staging monthly tenant billing simulation")
  `cron(15 6 * * ? *)` → `cron(30 12 * * ? *)` (UTC: 7:30am Eastern in winter, 8:30am in summer) at
  20:40:28; state, description and its one target unchanged. Its API destination
  `checksops-staging-scheduled` was `INACTIVE` when read, so the rule was not delivering before
  this change either.

Read first: the three alarms on the staging database (`checksops-prod-rds-connections`, `-cpu`,
`-free-storage`, which despite the name watch `checksops-staging`) and
`checksops-staging-api-errors-inspect` all have `TreatMissingData: notBreaching`, so a stopped
database does not raise the database alarms. There is no RDS Proxy and no read replica.

What it costs to work at night: between 1am and 7am Eastern the staging API has no database.
Every production database or Lambda step needs a staging step first, so work in those hours starts
with `aws rds start-db-instance --db-instance-identifier checksops-staging` (CloudShell or the
console; about 5 to 10 minutes). The stop schedule stops it again the next night. A request that
reaches the staging API in those hours and needs the database fails, and a Lambda error there can
raise `checksops-staging-api-errors-inspect`.

Saving: db.t4g.micro at $0.016 an hour, 6 of 24 hours, about $3 a month (storage is still billed
while stopped). To end it, delete the stack.

Not verified: that the schedules fire. Neither has run yet; the first stop is 2026-11-18 01:00
Eastern (06:00 UTC) and the first start 07:00 Eastern (12:00 UTC). The `Input` key
(`DbInstanceIdentifier`) follows the universal-target form in the EventBridge Scheduler
documentation and has not been observed working here.

## Second round, continued: Config recording frequency and one unused secret

Owner, 2026-11-17: "do 6 and 7" of the second list (6: record AWS Config changes daily instead of
continuously, or exclude noisy types; 7: delete unused secrets). The writes ran as the account root
user through the AWS connector. Both turned out smaller than the review estimated.

**Config.** Recorder `checksops-production-config-items` stays `CONTINUOUS` for everything except
five resource types, which now record once a day (`PutConfigurationRecorder`, 20:53:41 UTC;
recording group and role read back unchanged, recorder `recording: true`, `lastStatus SUCCESS`):
`AWS::Lambda::Function`, `AWS::EC2::Instance`, `AWS::RDS::DBInstance`,
`AWS::SSM::AssociationCompliance`, `AWS::SSM::ManagedInstanceInventory`.

Why those: `AWS/Config` `ConfigurationItemsRecorded` for the 14 days to 2026-11-17 counts 470
items, of which Lambda functions 169, the EC2 instance (the SQL runner starting and stopping) 114,
RDS instances 29 and the two SSM types 23. IAM roles, security groups, S3 buckets, VPC resources
and every other type are still recorded continuously. The staging database's new night schedule
would otherwise have added two RDS items a day.

The saving is small: at $0.003 an item, about 335 of 470 items in 14 days are of these types, so
at most about $2 a month, and less in a quiet month. The review said $3 to $5; that was an
over-estimate made before the per-type counts were read. What it costs: a change to a Lambda
function, the runner or a database instance can take up to 24 hours to appear in Config and in the
Security Hub controls that read it.

To undo: `PutConfigurationRecorder` with `recordingModeOverrides: []`.

**Secrets.** Of the secrets the review named as possibly unused, one was:

- `checksops/isolated/azure-document-intelligence-504e`: `DeleteSecret` with a 30-day recovery
  window at 20:53:42 UTC, deletion date 2026-12-17. It belonged to the isolated validation function
  `checksops-ocr-azure-validation-504e`, which `ops/security/lambda-retirement-2026-11.json`
  proposed to retire and which is no longer among the account's functions. CloudTrail for the
  previous 60 days shows no `GetSecretValue` on it (only `DescribeSecret` by Resource Explorer);
  `LastAccessedDate` 2026-09-18, the day it was created. `aws/tests/ocr-azure-secret.test.mjs` uses
  the name only as a string to prove such a secret is refused. About $0.40 a month. Until
  2026-12-17 it can be brought back with `RestoreSecret`.

Left alone, with the reason:

- `checksops/staging/master-uat-password`: in use. CloudTrail shows `GetSecretValue` by many
  `ChecksOpsCursorCloudStaging` sessions in the previous 60 days. The review was wrong to list it.
- `checksops/production/moov-webhook`: a production secret with one `GetSecretValue` (by root) in
  60 days and no reference in the repository. Not deleted on that evidence; the owner decides.
- `events!connection/checksops-staging-scheduled/...`: owned by the EventBridge connection of the
  staging billing job, whose API destination is `INACTIVE`. It goes only if that connection does.
- `checksops/staging/storage-migration-token`: already scheduled for deletion since 2026-10-21.
