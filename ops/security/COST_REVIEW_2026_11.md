# Cost review, 2026-11-17: what was changed and what was not

Owner, 2026-11-17: "how can we drop the costs down" (October bill $351.67), then a go for each
numbered item of the review. This note records the items that have no note of their own. No
guarded workflow covers these resources, so each was an explicit exception on the owner's words,
run by Claude through boto3 as `user/claude-code`.

| item | what | owner's words | state | record |
|---|---|---|---|---|
| 1, 8 | Delete the old four-AZ NAT and its addresses; release idle `100.50.171.44` | "do 1 and 8" | done | `ops/security/NAT_GATEWAY_COST_PLAN_2026_11.md` |
| 5 | Delete the Cognito interface endpoint | "do 4 and 5" | done, with a 19-request production 401 burst | `aws/rls/COGNITO_IDP_VPCE.md` |
| 6 | X-Ray `Active` → `PassThrough` in the API templates | "do 3 and 6" | templates merged (#1974); **not applied live** | #1974 |
| 7 | Security Hub: disable CIS 1.2.0 | "do 7, 9 and 10 and 2" | done | below |
| 9 | Staging backup retention 35 → 7 days | same | done | below |
| 3 | Cache Secrets Manager reads | "do 3 and 6" | **not done**, with the owner | below |
| 4 | Merge the two Secrets Manager endpoints | "do 4 and 5" | **not done**, with the owner | below |
| 10 | Terminate the "SQL53 temporary runner" | "do 7, 9 and 10 and 2" | **not done, and must not be** | below |
| 2 | Shrink the NAT from two AZs to one | same, then "do it deterministically" | **not done**, with the owner | below |

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

Nothing was changed for item 2.
