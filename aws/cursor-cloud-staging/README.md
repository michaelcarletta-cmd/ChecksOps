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
`aws/staging-api/`). That is a separate change.

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
