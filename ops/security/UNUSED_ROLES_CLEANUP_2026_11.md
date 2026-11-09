# Unused IAM roles clean-up, November 2026

Matrix rows CC6.2 and CC6.3. Evidence row A-1:
`docs/compliance/evidence/2026-11-06-A-1-access-review.md`, finding 3 ("IAM roles never used, or
unused for 25 days or more"). The review recommended confirming each role and deleting the ones
nothing uses, through a reviewed runbook. This is that runbook.

This file changes nothing by itself. Account `806168576068`, region `us-east-1`.

**Who runs it.** `user/claude-code` cannot change IAM: `iam:SimulatePrincipalPolicy` on
2026-11-09 returned `implicitDeny` for `iam:DeleteRole`, `iam:DetachRolePolicy`,
`iam:DeleteRolePolicy`, `iam:CreateRole` and `iam:RemoveRoleFromInstanceProfile`
(`ops/security/IAM_CLAUDE_CODE_LEAST_PRIVILEGE.md`). The owner runs every step in AWS CloudShell
(`us-east-1`), signed in through the IAM Identity Center access portal as `michael-admin`
(permission set `AdministratorAccess`), never as root.

**Approval is per role.** Each deletion below has its own go phrase. Saying one does not cover the
next role. Each deletion follows the same shape: step 0 read-only re-check, backup, delete, check.
Stop at the first step that does not print the expected result and report it; do not work around
it.

## Live state (read-only, 2026-11-09 14:02 to 14:04 UTC, `user/claude-code`, Python boto3)

Reads, per listed role: `iam:GetRole` (including `RoleLastUsed`), `ListAttachedRolePolicies`,
`ListRolePolicies` and `GetRolePolicy`, `ListInstanceProfilesForRole`, and
`cloudformation:DescribeStackResources --physical-resource-id`. Account-wide: `lambda:ListFunctions`
in every region (execution roles), `rds:DescribeDBProxies` in every region (proxy roles), every
CloudFormation stack in `us-east-1` (19: resources, parameters and template text), Step Functions
state machines and EventBridge rules and targets (role ARNs; EventBridge Scheduler was not readable,
`AccessDeniedException`), and `iam:ListEntitiesForPolicy` for the customer-managed policies attached
to the roles. Repository: a search for each role name across `aws/`, `.github/workflows/`,
`scripts/`, `ops/`, `.claude/`, `.cursor/` and `docs/` on main `17419cbc6`.

The account has 32 roles that are not service-linked (the review read 30 on 2026-11-06). None of
the eight listed roles is a resource of any CloudFormation stack, and none is in an instance
profile. The account has no RDS proxy in any region.

| Role | Created | Last used (2026-11-09) | Policies | Trust | Why it looks unused | Repo references | Stack | Recommendation |
|---|---|---|---|---|---|---|---|---|
| `rds-proxy-role-1788286368527` (path `/service-role/`) | 2026-09-01 | never | managed `service-role/rds-proxy-policy-1788286368527` (`secretsmanager:GetSecretValue` on the staging `checksops_admin` secret, `kms:Decrypt` via Secrets Manager); attached to this role only | `rds.amazonaws.com` | Console-created for an RDS proxy that does not exist; no proxy in any region | None for the role. The number also appears in the staging secret's ARN (`…/checksops_admin/1788286368527-Kv5tBt`), which is a different resource and stays | none | **Delete** |
| `rds-proxy-role-1788286468693` (path `/service-role/`) | 2026-09-01 | never | managed `service-role/rds-proxy-policy-1788286468693` (same shape, staging `checksops` application secret); attached to this role only | `rds.amazonaws.com` | Same as above | None for the role. The number appears in the staging application secret's ARN (`…/checksops/1788286468693-b4U0Rn`), which stays | none | **Delete** |
| `ChecksOpsCursorCloudStaging` | 2026-09-01 | 2026-10-11 17:29 UTC (29 days) | managed `ChecksOpsProductionPrepCloudWatchInspect` (attached to this role only); inline `ChecksOpsDenyProduction`, `ChecksOpsStagingDeploy` (broad staging writes, including `lambda:*`, `s3:*`, `secretsmanager:*` on `*` and role writes on `checksops-staging-*`), `ChecksOpsStagingHttpsWebAuthn` | account root, condition `aws:PrincipalArn` = the SSO `AdministratorAccess` role only (statement `OwnerSsoAdminOnlyCursorRemoved20261018`: the Cursor trust was removed on 2026-10-18) | The Cursor cloud agent it served can no longer assume it; staging now deploys through the guarded GitHub workflows | Documentation and history only: `aws/cursor-cloud-staging/README.md`, `aws/cutover/*.md`, `aws/production/*.yaml` (description text, tag values `DoNotBroadenStagingRole`, outputs `DoNotAttachToStagingRole`), tests that read those files, and recorded evidence in `ops/deployment-guard/sql53-staging-acceptance.json` and `production-api-overlay-plan.json`. No workflow, script, guard code or role property uses it | none. Two live stacks (`checksops-cursor-api-perimeter-steps12-role`, `checksops-production-prep-alarms`) name it in description or output text only | **Delete** (owner confirms no Cursor agent setting still points at it) |
| `ChecksOpsProductionSql53ConfigWriter` | 2026-10-10 | 2026-10-11 02:22 UTC (29 days) | inline `ChecksOpsProductionSql53ConfigWriterInline`: `lambda:GetFunctionConfiguration`, `UpdateFunctionConfiguration`, `InvokeFunction` on `checksops-production-prep-api` | account root, SSO `AdministratorAccess` role only | Temporary SQL 53 role; not used since the SQL 53 run | **Deployment guard:** `scripts/deployment-guard/lib/sql53-temporary-lambda-config.mjs` (`SQL53_CONFIG_ROLE_ARN`, identity check), used by `scripts/deployment-guard/sql53-temporary-lambda-config.mjs`; tests; `ops/production-sql53-readonly-diagnostic.md` | none | **Not a candidate here. Owner decision:** retire the SQL 53 temporary-config path in the guard (its own reviewed PR) first, then delete the role with the steps below. It can change the production API's configuration, so retiring it is worth doing |
| `ChecksOpsGitHubStagingDbReadonlyDiagnosticDeploy` | 2026-10-08 | never | inline `DiagnosticOnly` (CreateStack on `checksops-staging-db-readonly-diagnostic`, PassRole of the execution role below, diagnostic S3 prefix, Lambda publish) | GitHub OIDC, `repo:michaelcarletta-cmd/ChecksOps:environment:staging` | The diagnostic stack was never created | **Workflow:** `.github/workflows/staging-db-readonly-diagnostic-deploy.yml` (`role-to-assume`); scripts `staging-db-readonly-diagnostic-{deploy,update,independent-approval,kms-s3-ledger}.mjs`; `aws/staging-db-readonly-diagnostic/` policies and `DEPLOYMENT.md`; tests | none (stack `checksops-staging-db-readonly-diagnostic` does not exist) | **Not a candidate here. Owner decision:** keep while the staging diagnostic may still be run; otherwise retire the workflow, scripts and policies in a reviewed PR first, then delete both diagnostic roles together |
| `ChecksOpsStagingDbReadonlyDiagnosticCloudFormationExecution` | 2026-10-08 | never | inline `DiagnosticOnly` (Lambda, role, log-group writes scoped to the diagnostic stack's names) | `cloudformation.amazonaws.com` | Same as above | **Workflow:** the same workflow passes it (`iam:PassRole` session policy); same scripts and policies | none | **Not a candidate here.** Goes with the role above |
| `Checksops-role-ku1r91ck` (path `/service-role/`) | 2026-09-01 | never | managed `service-role/AWSLambdaBasicExecutionRole-af5494b2-…` (logs for `/aws/lambda/Checksops`); attached to this role only | `lambda.amazonaws.com` | Its function has never run (0 invocations in 63 days) | `ops/security/LAMBDA_RETIREMENT_REVIEW_2026_11.md` ("follow-up role cleanup") | none | **Not a candidate here: it is the execution role of the live Lambda `Checksops`** (console-created 2026-09-01, `nodejs24.x`). The owner decides that function in the Lambda retirement review; the role goes after the function is deleted |
| `checksops-production-prep-api-role` | 2026-09-05 | 2026-09-06 20:19 UTC (64 days) | managed AWS `AWSLambdaBasicExecutionRole`, `AWSXRayDaemonWriteAccess`; no inline | `lambda.amazonaws.com` | The production API `checksops-production-prep-api` now runs as `checksops-production-api-execution` | `aws/production/README.md`; `aws/cutover/SECURITY_HARDENING_BATCH4.md` ("Do not delete"); `aws/cutover/CUTOVER_READINESS_MATRIX.md` | **Referenced by the production stack `checksops-production-prep-api`**: its parameter `ExistingExecutionRoleArn` is still this role's ARN (the function's role was changed outside the stack). A stack update that keeps previous parameters, or a rollback, would point the production API at it | **Keep.** Not a candidate until the stack parameter is moved to `checksops-production-api-execution` through the guarded path (a separate change). Delete it after that |

**Candidates for deletion in this runbook:** `rds-proxy-role-1788286368527`,
`rds-proxy-role-1788286468693`, `ChecksOpsCursorCloudStaging`.

### Roles a stack or other change must remove

- No listed role is a CloudFormation stack resource, so none would be removed through a stack. If a
  later read shows a role as a stack resource (step 0 checks this), do not delete it by hand: remove
  it from the stack's template, or delete the stack, through a reviewed change.
- `checksops-production-prep-api-role`: first a reviewed change to the `checksops-production-prep-api`
  stack parameter, then this role's deletion with the steps below.
- `ChecksOpsProductionSql53ConfigWriter`, the two diagnostic roles and `Checksops-role-ku1r91ck`:
  first the reviewed change that retires what references them (guard code, workflow and scripts, or
  the Lambda), then the deletion with the steps below, each with its own go phrase.

### What deletion leaves behind

- The customer-managed policies `service-role/rds-proxy-policy-1788286368527`,
  `service-role/rds-proxy-policy-1788286468693` and `ChecksOpsProductionPrepCloudWatchInspect` are
  attached only to these roles. After deletion they are attached to nothing and grant nothing. They
  are not deleted here; that is a follow-up, if wanted. The backup keeps their documents.
- The staging Secrets Manager secrets whose names share the numbers above are in use and are not
  touched.
- If any Cursor configuration still holds `CURSOR_AWS_ASSUME_IAM_ROLE_ARN` for
  `ChecksOpsCursorCloudStaging`, remove it there; it can no longer be assumed by Cursor anyway.

## Step 0 — read-only re-check (run before each deletion, stop if anything changed)

Paste once per CloudShell session:

```bash
export AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1
precheck() {  # precheck ROLE EXPECTED_LAST_USED "EXPECTED_ATTACHED" "EXPECTED_INLINE"
  local R="$1" ok=1 ARN got
  ARN=$(aws iam get-role --role-name "$R" --query Role.Arn --output text) || { echo "STOP: get-role failed for $R"; return 1; }
  got=$(aws iam get-role --role-name "$R" --query Role.RoleLastUsed.LastUsedDate --output text)
  [ "$got" = "$2" ] || { echo "STOP: last used is '$got', expected '$2'"; ok=0; }
  got=$(aws iam list-attached-role-policies --role-name "$R" --query 'sort(AttachedPolicies[].PolicyName)' --output text | tr '\t' ' ')
  [ "$got" = "$3" ] || { echo "STOP: attached policies '$got', expected '$3'"; ok=0; }
  got=$(aws iam list-role-policies --role-name "$R" --query 'sort(PolicyNames)' --output text | tr '\t' ' ')
  [ "$got" = "$4" ] || { echo "STOP: inline policies '$got', expected '$4'"; ok=0; }
  got=$(aws iam list-instance-profiles-for-role --role-name "$R" --query 'InstanceProfiles[].InstanceProfileName' --output text)
  [ -z "$got" ] || { echo "STOP: in instance profile(s) $got"; ok=0; }
  got=$(aws lambda list-functions --query "Functions[?Role=='$ARN'].FunctionName" --output text)
  [ -z "$got" ] || { echo "STOP: Lambda function(s) use it: $got"; ok=0; }
  got=$(aws rds describe-db-proxies --query "DBProxies[?RoleArn=='$ARN'].DBProxyName" --output text)
  [ -z "$got" ] || { echo "STOP: RDS proxy uses it: $got"; ok=0; }
  if aws cloudformation describe-stack-resources --physical-resource-id "$R" >/dev/null 2>&1; then
    echo "STOP: a CloudFormation stack owns it; remove it through the stack"; ok=0
  fi
  if [ "$ok" = 1 ]; then echo "PRECHECK OK $R $ARN"; else echo "PRECHECK FAILED $R: stop and report"; return 1; fi
}
```

Expected values recorded on 2026-11-09:

```bash
precheck rds-proxy-role-1788286368527 None "rds-proxy-policy-1788286368527" ""
precheck rds-proxy-role-1788286468693 None "rds-proxy-policy-1788286468693" ""
precheck ChecksOpsCursorCloudStaging 2026-10-11T17:29:33+00:00 "ChecksOpsProductionPrepCloudWatchInspect" "ChecksOpsDenyProduction ChecksOpsStagingDeploy ChecksOpsStagingHttpsWebAuthn"
```

Repository re-check, on an up-to-date LF checkout of main (outside CloudShell). Each command must
print nothing:

```bash
git grep -l -e 'rds-proxy-role-1788286368527' -e 'rds-proxy-role-1788286468693' -- .github/workflows scripts aws ops/deployment-guard
git grep -l 'ChecksOpsCursorCloudStaging' -- .github/workflows scripts aws/functions
```

A moved last-used date, a new attachment, a function, proxy or stack using the role, or a new
reference in a workflow, script or the guard: stop and report. Do not delete.

## Backup (before each deletion)

Paste once per CloudShell session. It saves everything needed to recreate the role:

```bash
B=~/iam-role-backup-2026-11; mkdir -p "$B"
backup() {  # backup ROLE
  local R="$1" a p v
  aws iam get-role --role-name "$R" > "$B/$R.role.json" || return 1
  aws iam list-attached-role-policies --role-name "$R" > "$B/$R.attached.json" || return 1
  aws iam list-instance-profiles-for-role --role-name "$R" > "$B/$R.instance-profiles.json" || return 1
  for p in $(aws iam list-role-policies --role-name "$R" --query 'PolicyNames[]' --output text); do
    aws iam get-role-policy --role-name "$R" --policy-name "$p" > "$B/$R.inline.$p.json" || return 1
  done
  for a in $(aws iam list-attached-role-policies --role-name "$R" --query 'AttachedPolicies[].PolicyArn' --output text); do
    aws iam get-policy --policy-arn "$a" > "$B/$R.managed.${a##*/}.policy.json" || return 1
    v=$(aws iam get-policy --policy-arn "$a" --query Policy.DefaultVersionId --output text) || return 1
    aws iam get-policy-version --policy-arn "$a" --version-id "$v" > "$B/$R.managed.${a##*/}.version.json" || return 1
  done
  sha256sum "$B/$R".* && echo "BACKUP OK $R"
}
```

After each backup, download a copy off CloudShell (CloudShell storage is per user and can expire):

```bash
tar czf ~/iam-role-backup-2026-11.tgz -C ~ iam-role-backup-2026-11 && sha256sum ~/iam-role-backup-2026-11.tgz
```

Then **Actions → Download file** → `/home/cloudshell-user/iam-role-backup-2026-11.tgz`, and keep it
in the restricted compliance folder. Do not delete a role whose backup did not complete.

## Deletion 1 — `rds-proxy-role-1788286368527`

Go phrase: **"delete unused role rds-proxy-role-1788286368527"**

```bash
if precheck rds-proxy-role-1788286368527 None "rds-proxy-policy-1788286368527" "" \
   && backup rds-proxy-role-1788286368527; then
  # no inline policies, no instance profiles
  aws iam detach-role-policy --role-name rds-proxy-role-1788286368527 \
    --policy-arn arn:aws:iam::806168576068:policy/service-role/rds-proxy-policy-1788286368527 \
  && aws iam delete-role --role-name rds-proxy-role-1788286368527
fi
```

## Deletion 2 — `rds-proxy-role-1788286468693`

Go phrase: **"delete unused role rds-proxy-role-1788286468693"**

```bash
if precheck rds-proxy-role-1788286468693 None "rds-proxy-policy-1788286468693" "" \
   && backup rds-proxy-role-1788286468693; then
  # no inline policies, no instance profiles
  aws iam detach-role-policy --role-name rds-proxy-role-1788286468693 \
    --policy-arn arn:aws:iam::806168576068:policy/service-role/rds-proxy-policy-1788286468693 \
  && aws iam delete-role --role-name rds-proxy-role-1788286468693
fi
```

## Deletion 3 — `ChecksOpsCursorCloudStaging`

Go phrase: **"delete unused role ChecksOpsCursorCloudStaging"**

```bash
if precheck ChecksOpsCursorCloudStaging 2026-10-11T17:29:33+00:00 \
     "ChecksOpsProductionPrepCloudWatchInspect" \
     "ChecksOpsDenyProduction ChecksOpsStagingDeploy ChecksOpsStagingHttpsWebAuthn" \
   && backup ChecksOpsCursorCloudStaging; then
  # Remove the permissive inline policies first and the deny last; no instance profiles.
  aws iam detach-role-policy --role-name ChecksOpsCursorCloudStaging \
    --policy-arn arn:aws:iam::806168576068:policy/ChecksOpsProductionPrepCloudWatchInspect \
  && aws iam delete-role-policy --role-name ChecksOpsCursorCloudStaging --policy-name ChecksOpsStagingDeploy \
  && aws iam delete-role-policy --role-name ChecksOpsCursorCloudStaging --policy-name ChecksOpsStagingHttpsWebAuthn \
  && aws iam delete-role-policy --role-name ChecksOpsCursorCloudStaging --policy-name ChecksOpsDenyProduction \
  && aws iam delete-role --role-name ChecksOpsCursorCloudStaging
fi
```

If the pre-check or the backup fails, nothing is changed: report the `STOP` line. If a change
command fails part-way, stop, do not retry, and report it; the backup holds what is needed to put
back what was removed (see Rollback).

## Check (after each deletion)

```bash
R=rds-proxy-role-1788286368527   # the role just deleted
aws iam get-role --role-name "$R" 2>&1 | grep -q NoSuchEntity && echo "DELETED $R" || echo "STILL PRESENT $R: stop and report"
```

CloudTrail delivers IAM events within about 15 minutes. Then record the event ids:

```bash
START=2026-11-09T00:00:00Z   # set to the day of the run
for E in DetachRolePolicy DeleteRolePolicy DeleteRole; do
  aws cloudtrail lookup-events --start-time "$START" \
    --lookup-attributes AttributeKey=EventName,AttributeValue=$E --output json \
  | jq -r --arg r "$R" '.Events[] | (.CloudTrailEvent | fromjson) as $c
      | select($c.requestParameters.roleName == $r)
      | [.EventTime, .EventName, .EventId, ($c.errorCode // "ok")] | @tsv'
done
```

## Rollback (recreate from the backup)

The recreated role has the same name, ARN, trust and permissions but a new role id; nothing found
in the reads above refers to these roles by id.

```bash
R=rds-proxy-role-1788286368527   # the role to recreate
B=~/iam-role-backup-2026-11      # or the downloaded tgz, extracted
jq '.Role.AssumeRolePolicyDocument' "$B/$R.role.json" > /tmp/$R.trust.json
DESC=$(jq -r '.Role.Description // ""' "$B/$R.role.json")
aws iam create-role --role-name "$R" \
  --path "$(jq -r .Role.Path "$B/$R.role.json")" \
  --max-session-duration "$(jq -r .Role.MaxSessionDuration "$B/$R.role.json")" \
  --assume-role-policy-document file:///tmp/$R.trust.json \
  ${DESC:+--description "$DESC"}
for a in $(jq -r '.AttachedPolicies[].PolicyArn' "$B/$R.attached.json"); do
  aws iam attach-role-policy --role-name "$R" --policy-arn "$a"
done
for f in "$B/$R".inline.*.json; do
  [ -e "$f" ] || continue
  jq '.PolicyDocument' "$f" > /tmp/inline.json
  aws iam put-role-policy --role-name "$R" --policy-name "$(jq -r .PolicyName "$f")" \
    --policy-document file:///tmp/inline.json
done
aws iam get-role --role-name "$R" --query Role.Arn --output text
```

If a customer-managed policy was deleted in a later follow-up, recreate it first from
`$R.managed.<name>.version.json` (`.PolicyVersion.Document`) with `aws iam create-policy` and the
path from `$R.managed.<name>.policy.json`. None of these roles had a tag, a permissions boundary or an
instance profile on 2026-11-09; if the backup shows one, restore it too.

## Record (fill in when done; one row per role)

Add this to the A-1 evidence (or a new file beside it) in its own PR. No names or email addresses.

```markdown
## Unused roles clean-up, run <YYYY-MM-DD>

Runbook: ops/security/UNUSED_ROLES_CLEANUP_2026_11.md (main <sha>).
Run by the owner in CloudShell as the SSO AdministratorAccess role. Go phrases given: <verbatim>.

| Role | Step 0 result (UTC) | Backup tgz sha256 | DetachRolePolicy event id(s) | DeleteRolePolicy event id(s) | DeleteRole event id | get-role after |
|---|---|---|---|---|---|---|
| rds-proxy-role-1788286368527 | PRECHECK OK <time> | <sha256> | <id> | n/a | <id> | NoSuchEntity <time> |
| rds-proxy-role-1788286468693 | PRECHECK OK <time> | <sha256> | <id> | n/a | <id> | NoSuchEntity <time> |
| ChecksOpsCursorCloudStaging | PRECHECK OK <time> | <sha256> | <id> | <id> x3 | <id> | NoSuchEntity <time> |

Not deleted, with reason: ChecksOpsProductionSql53ConfigWriter (deployment guard reference),
ChecksOpsGitHubStagingDbReadonlyDiagnosticDeploy and
ChecksOpsStagingDbReadonlyDiagnosticCloudFormationExecution (workflow reference),
Checksops-role-ku1r91ck (execution role of Lambda Checksops),
checksops-production-prep-api-role (production stack parameter).
Backup location: restricted compliance folder, <file name>.
```

Then tick "Role clean-up decided" in the A-1 sign-off.
