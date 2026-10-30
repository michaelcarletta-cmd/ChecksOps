# Cursor staging role: deny the production user pool

Role: `ChecksOpsCursorCloudStaging` (assumable only from the SSO `AdministratorAccess` role).
Inline policy: `ChecksOpsDenyProduction`. It was created by hand and is not in any template, so
it changes only through this target document, with the owner's approval of the apply run.

| File | What it is |
|---|---|
| `policies/deny-production.live-2026-10-29.json` | the live document, read 2026-10-29 with `iam:GetRolePolicy` (evidence and rollback) |
| `policies/deny-production.json` | the target: the live denies plus `DenyProductionUserPool` (`cognito-idp:*` on `us-east-1_h00WorYMT`) |

Test: `aws/tests/cursor-cloud-staging-deny-production-pool.test.mjs`.

## Why

The role's `ChecksOpsStagingDeploy` policy allows `cognito-idp:*` on `*`. `ChecksOpsDenyProduction`
denies the production Lambda, buckets, secrets, API, stacks, alarms and CloudFront writes, but
not the production user pool, so a "staging" Cursor session can create, change, disable or delete
any production login and change the pool's settings.

## Read-only inspect (2026-10-29, `user/claude-code`)

- `iam:SimulatePrincipalPolicy` as the role, before: `AdminCreateUser`, `AdminGetUser`,
  `AdminSetUserPassword`, `AdminDisableUser`, `AdminDeleteUser`, `AdminUpdateUserAttributes`,
  `UpdateUserPool` and `ListUsers` are `allowed` on both the staging pool `us-east-1_vPmQ7cL1F`
  and the production pool `us-east-1_h00WorYMT`.
- CloudTrail `LookupEvents`, last 90 days, this role on the production pool: 103
  `AdminSetUserPassword` (latest 2026-10-02), 175 `AdminGetUser` (latest 2026-10-03), 11
  `AdminCreateUser` and 1 `AdminDisableUser` (latest 2026-09-23). None after 2026-10-03. On the
  staging pool: 437 `AdminSetUserPassword`, 336 `AdminGetUser`, 14 `AdminCreateUser`, 1
  `AdminDisableUser`; those stay allowed.

After the apply, production user administration goes through the app (platform-owner screens,
which use the production Lambda role) or the SSO administrator role directly, never a Cursor
staging session.

## Apply (only on the owner's approval of this run)

```bash
aws iam put-role-policy \
  --role-name ChecksOpsCursorCloudStaging \
  --policy-name ChecksOpsDenyProduction \
  --policy-document file://aws/cursor-cloud-staging/policies/deny-production.json
```

Before the apply, re-read the live document with `iam:GetRolePolicy` and stop if it differs from
`deny-production.live-2026-10-29.json`.

## Verify after apply

1. `iam:GetRolePolicy` equals `deny-production.json`.
2. `iam:SimulatePrincipalPolicy`: every action above `explicitDeny` on `us-east-1_h00WorYMT`,
   still `allowed` on `us-east-1_vPmQ7cL1F`.

## Rollback

```bash
aws iam put-role-policy \
  --role-name ChecksOpsCursorCloudStaging \
  --policy-name ChecksOpsDenyProduction \
  --policy-document file://aws/cursor-cloud-staging/policies/deny-production.live-2026-10-29.json
```

## Not covered here

The role's `ChecksOpsStagingDeploy` also allows `iam:PutRolePolicy` on `checksops-staging-*` roles,
so a Cursor session could re-widen the staging API role's Cognito grant (finding A,
`aws/staging-api/`). That is a separate change: see "Staging role boundary" below.

## Applied (2026-10-29)

Owner approval, verbatim: "start finding 1's migration PR and apply A and apply A2".
Source: `deny-production.json` from `origin/main` `e82e7d2` (PR #1368, merge `e82e7d2`),
sha256 `bb4955ff0b38259917f3d066b7f15c31063de89dc6c4c9bf6fbe4539882b7c8c`. Identity:
`arn:aws:iam::806168576068:user/claude-code`.

1. Precondition: `iam:GetRolePolicy` before the apply equalled
   `deny-production.live-2026-10-29.json`.
2. `iam:PutRolePolicy` with `deny-production.json`.
3. `iam:GetRolePolicy` after the apply equals `deny-production.json`.
4. `iam:SimulatePrincipalPolicy` after the apply: `AdminCreateUser`, `AdminGetUser`,
   `AdminSetUserPassword`, `AdminDisableUser`, `AdminDeleteUser`, `AdminUpdateUserAttributes`,
   `UpdateUserPool` and `ListUsers` are `explicitDeny` on `us-east-1_h00WorYMT` and `allowed` on
   `us-east-1_vPmQ7cL1F`.

## Staging role boundary (proposed 2026-10-29, not applied)

Owner decision of 2026-10-29: "go ahead with the permissions boundary".

| File | What it is |
|---|---|
| `policies/staging-role-boundary.json` | new managed policy `ChecksOpsStagingRoleBoundary`, the permissions boundary |
| `policies/deny-production.json` | the target: the live denies plus `DenyRoleWritesWithoutStagingBoundary`, `DenyRemovingStagingBoundary` and `DenyEditingStagingBoundaryPolicy` |
| `policies/deny-production.live-2026-10-29-after-a2.json` | the live document after A2, read 2026-10-29 (evidence and rollback for this change) |

Test: `aws/tests/cursor-cloud-staging-role-boundary.test.mjs`.

### Why

`ChecksOpsDenyProduction` limits only the Cursor role itself. `StagingIamRoles` lets the role
create any `checksops-staging-*` role, give it any inline policy and pass it to a Lambda it creates
(`lambda:*`), so a Cursor session could give a new role `*:*` or production access and run it:
every production deny on this role, A2 included, and `DenyGrantingAdminPolicies` (inline policies
are not attachments) would be bypassed. It can also rewrite the staging API role (finding A) and the
guarded staging SQL executor role.

### Read-only inspect (2026-10-29, `user/claude-code`)

- `iam:SimulatePrincipalPolicy` as the role: `iam:CreateRole`, `iam:PutRolePolicy` and
  `iam:PassRole` on a new `checksops-staging-*` role, `lambda:CreateFunction` and
  `lambda:InvokeFunction` on a new `checksops-staging-*` function, and `PutRolePolicy`,
  `AttachRolePolicy` and `DeleteRolePolicy` on `checksops-staging-ApiFunctionRole-7E7XRyLe3nyi` and
  `checksops-staging-guarded-sql-executor`: all `allowed`. `iam:CreatePolicy`, `iam:CreateUser`,
  `iam:CreateAccessKey` and writes to its own role: `implicitDeny` (roles are the only way up).
- The live `ChecksOpsDenyProduction` equals `deny-production.live-2026-10-29-after-a2.json` (A2's
  target).
- The five existing `checksops-staging-*` roles trust only `lambda.amazonaws.com`, have no boundary
  and hold staging-only grants (the Mortgage Desk harness can read the production API Lambda's
  configuration only).
- CloudTrail, last 90 days: 832 IAM writes by the role, nearly all on throwaway one-shot roles it
  created, used and deleted (107 `CreateRole`, none with a boundary); the last on 2026-09-29. Its
  147 inline grants used only Secrets Manager, S3, logs, VPC network interfaces, SES, Textract,
  staging Cognito admin, EventBridge, Scheduler and Lambda reads, IAM reads and `PutRolePolicy`; the
  managed policies it attached were `AWSLambdaVPCAccessExecutionRole`, `AWSLambdaBasicExecutionRole`
  and `AWSXrayWriteOnlyAccess`. The boundary allows exactly those services, plus the role's own
  staging services (API Gateway).

### Simulation of the target (read-only `iam:SimulateCustomPolicy`, 2026-10-29)

The Cursor role with the target `ChecksOpsDenyProduction` (and its live `ChecksOpsStagingDeploy`
and `ChecksOpsStagingHttpsWebAuthn`):

| action | resource | decision |
|---|---|---|
| `CreateRole` with the boundary | new `checksops-staging-*` role | allowed |
| `CreateRole` without a boundary, or with another one | new `checksops-staging-*` role | explicitDeny |
| `PutRolePolicy`, `AttachRolePolicy`, `DeleteRolePolicy`, `DeleteRole` | bounded role | allowed |
| `PutRolePolicy`, `AttachRolePolicy`, `DeleteRolePolicy` | staging API role, guarded SQL executor role | explicitDeny |
| `DeleteRolePermissionsBoundary` | any role | explicitDeny |
| `CreatePolicyVersion` | `ChecksOpsStagingRoleBoundary` | explicitDeny |
| `lambda:UpdateFunctionCode` | `checksops-staging-api` | allowed (unchanged) |
| `cognito-idp:AdminCreateUser` | staging pool | allowed (unchanged) |

A role carrying the boundary whose own policy is `*:*`: staging secrets, staging S3, VPC network
interfaces and SES `allowed`; production secrets, the production API Lambda, the production pool and
production buckets `explicitDeny`; `ssm:SendCommand` and `ec2:StopInstances` on the production SQL
runner, `sts:AssumeRole`, `iam:CreateUser`, `iam:CreateAccessKey` and `iam:CreatePolicy`
`implicitDeny`; a role write without the boundary, or on the staging API role, `explicitDeny`.

The simulation supplies `iam:PermissionsBoundary` as a context value; after the apply, the same
checks run against the live policies (`SimulatePrincipalPolicy`), again with that context value.

### What changes for Cursor sessions

Every role a Cursor session creates must carry the boundary:

```bash
aws iam create-role --role-name checksops-staging-<name> \
  --assume-role-policy-document file://trust.json \
  --permissions-boundary arn:aws:iam::806168576068:policy/ChecksOpsStagingRoleBoundary
```

A CloudFormation stack run as the Cursor role sets `PermissionsBoundary` on each `AWS::IAM::Role`.
Without it the call is refused with AccessDenied. Roles without the boundary (the staging API role,
the guarded SQL executor and the three other existing roles) can no longer be changed from a Cursor
session; they change through this repository with the owner's approval of the apply.

### Apply (only on the owner's approval of this run)

1. Re-read `ChecksOpsDenyProduction` with `iam:GetRolePolicy`; stop if it differs from
   `deny-production.live-2026-10-29-after-a2.json`. Check `ChecksOpsStagingRoleBoundary` does not
   exist yet.
2. Create the boundary policy:

   ```bash
   aws iam create-policy --policy-name ChecksOpsStagingRoleBoundary \
     --description "Permissions boundary for checksops-staging-* roles created by Cursor sessions" \
     --policy-document file://aws/cursor-cloud-staging/policies/staging-role-boundary.json
   ```

3. Put the target deny policy:

   ```bash
   aws iam put-role-policy --role-name ChecksOpsCursorCloudStaging \
     --policy-name ChecksOpsDenyProduction \
     --policy-document file://aws/cursor-cloud-staging/policies/deny-production.json
   ```

### Verify after apply

1. `iam:GetPolicyVersion` of the boundary equals `staging-role-boundary.json`; `iam:GetRolePolicy`
   equals `deny-production.json`.
2. `iam:SimulatePrincipalPolicy` as the role: the table above.

### Rollback

```bash
aws iam put-role-policy --role-name ChecksOpsCursorCloudStaging \
  --policy-name ChecksOpsDenyProduction \
  --policy-document file://aws/cursor-cloud-staging/policies/deny-production.live-2026-10-29-after-a2.json
aws iam delete-policy --policy-arn arn:aws:iam::806168576068:policy/ChecksOpsStagingRoleBoundary
```

(Delete the policy only if no role carries it as a boundary.)

### Applied (2026-10-29)

Owner approval, verbatim: "apply the Cursor staging role boundary".
Source: `origin/main` `f45562b`; the files as merged in PR #1399 (merge `2687bd6`):
`staging-role-boundary.json` sha256 `842239fc6743946eb52c6c9ff691af4fa2c5d4a5ca7b13f2d122f2179796d23f`,
`deny-production.json` sha256 `0f7b92a2b351095ef5efec75ef7d110cfe14a11a74c4010113597ef78e618aac`.
Identity: `arn:aws:iam::806168576068:user/claude-code`.

1. Precondition: `iam:GetRolePolicy` before the apply equalled
   `deny-production.live-2026-10-29-after-a2.json`; `ChecksOpsStagingRoleBoundary` did not exist.
2. `iam:CreatePolicy` `ChecksOpsStagingRoleBoundary` (PolicyId `ANPA3XM3EIBCF2RGGZ7UP`, version
   `v1`, created 2026-10-29T20:38:56Z, request `78724aa1-ed9a-45ac-8889-68c725c5eb6d`).
3. `iam:PutRolePolicy` `ChecksOpsDenyProduction` on `ChecksOpsCursorCloudStaging` with
   `deny-production.json` (HTTP 200, request `8b650c58-9db2-49ce-84b9-7415e1655818`).
4. Read-back: `iam:GetPolicyVersion` `v1` equals `staging-role-boundary.json`; `iam:GetRolePolicy`
   equals `deny-production.json`. The boundary had 0 attachments and 0 boundary uses.
5. `iam:SimulatePrincipalPolicy` as the role, after the apply, matched the target table above
   (17 checks): `CreateRole` with the boundary `allowed`, without it or with another one
   `explicitDeny`; writes on a bounded role `allowed`; `PutRolePolicy`, `AttachRolePolicy` and
   `DeleteRolePolicy` on the staging API role and `PutRolePolicy` on the guarded SQL executor
   `explicitDeny`; `DeleteRolePermissionsBoundary` and `CreatePolicyVersion` on the boundary
   `explicitDeny`; `lambda:UpdateFunctionCode` on `checksops-staging-api` and `AdminCreateUser` on
   `us-east-1_vPmQ7cL1F` `allowed`; `AdminSetUserPassword` on `us-east-1_h00WorYMT` and
   `lambda:UpdateFunctionCode` on `checksops-production-prep-api` `explicitDeny`.
6. `iam:SimulateCustomPolicy` of a role whose own policy is `*:*` under the live boundary document
   (9 checks): a staging secret `allowed`; a production secret, the production API Lambda, the
   production pool and the production files bucket `explicitDeny`; `ssm:SendCommand` on
   `i-0c35557c4e5385406`, `sts:AssumeRole`, `iam:CreateUser` and `iam:CreatePolicy` `implicitDeny`.

Not verified: no Cursor session has created a bounded role yet; the checks above are IAM policy
simulations, not a live `CreateRole`.
