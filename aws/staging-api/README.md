# Staging API role: Cognito invite grant scoped to the staging pool

Role: `checksops-staging-ApiFunctionRole-7E7XRyLe3nyi` (Lambda `checksops-staging-api`).
Inline policy: `ApiFunctionRolePolicyClassA`. It was created by hand and is not in
`aws/template.yaml`, so it changes only through this target document, with the owner's
approval of the apply run.

| File | What it is |
|---|---|
| `policies/class-a-policy.live-2026-10-29.json` | the live document, read 2026-10-29 with `iam:GetRolePolicy` (evidence and rollback) |
| `policies/class-a-policy.json` | the target: identical except `StagingCognitoAdminInvite` names the staging pool `us-east-1_vPmQ7cL1F` instead of `userpool/*` |

Test: `aws/tests/staging-api-role-cognito-scope.test.mjs`.

## Why

`StagingCognitoAdminInvite` grants `AdminCreateUser`, `AdminGetUser`, `AdminDisableUser` and
`AdminSetUserPassword` on `userpool/*`, which includes the production pool
`us-east-1_h00WorYMT`. That pool allows PASSWORD sign-in, so code running as the staging Lambda
(any job in the GitHub `staging` environment can update that function, as can the Cursor staging
role) could set the password of any production login, the platform owner's included, and sign in.

## Read-only inspect (2026-10-29, `user/claude-code`)

- `lambda:GetFunctionConfiguration checksops-staging-api`: `COGNITO_USER_POOL_ID=us-east-1_vPmQ7cL1F`.
- `iam:SimulatePrincipalPolicy` as the role, before:

  | action | staging `us-east-1_vPmQ7cL1F` | production `us-east-1_h00WorYMT` |
  |---|---|---|
  | AdminCreateUser | allowed | **allowed** |
  | AdminGetUser | allowed | **allowed** |
  | AdminSetUserPassword | allowed | **allowed** |
  | AdminDisableUser | allowed | **allowed** |
  | AdminDeleteUser | implicitDeny | implicitDeny |
  | AdminUpdateUserAttributes | implicitDeny | implicitDeny |

- CloudTrail `LookupEvents`, last 90 days, Cognito admin calls by this role: 31 `AdminCreateUser`,
  6 `AdminSetUserPassword` and 13 `AdminGetUser`, all on the staging pool; none on the production
  pool. Scoping the grant removes nothing the staging Lambda uses.

## Apply (only on the owner's approval of this run)

```bash
aws iam put-role-policy \
  --role-name checksops-staging-ApiFunctionRole-7E7XRyLe3nyi \
  --policy-name ApiFunctionRolePolicyClassA \
  --policy-document file://aws/staging-api/policies/class-a-policy.json
```

Before the apply, re-read the live document with `iam:GetRolePolicy` and stop if it differs from
`class-a-policy.live-2026-10-29.json`.

## Verify after apply

1. `iam:GetRolePolicy` equals `class-a-policy.json`.
2. `iam:SimulatePrincipalPolicy`: the four invite actions `allowed` on `us-east-1_vPmQ7cL1F`,
   `implicitDeny` on `us-east-1_h00WorYMT`.
3. Staging smoke: invite a test user in a staging tenant; the invite succeeds.

## Rollback

```bash
aws iam put-role-policy \
  --role-name checksops-staging-ApiFunctionRole-7E7XRyLe3nyi \
  --policy-name ApiFunctionRolePolicyClassA \
  --policy-document file://aws/staging-api/policies/class-a-policy.live-2026-10-29.json
```

## Not covered here

The Cursor role `ChecksOpsCursorCloudStaging` also reaches the production pool. That is a separate
finding with its own change.
