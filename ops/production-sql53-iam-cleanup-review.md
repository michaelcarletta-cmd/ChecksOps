# SQL53 writer IAM cleanup review

Read-only review after the successful production SQL53 inspection. IAM was not modified.

## STOP FOR APPROVAL

Do not apply this cleanup until the owner explicitly authorizes an Identity Center AdministratorAccess `update-assume-role-policy` that removes only the statement below.

## Live read

`iam:GetRole`, `iam:ListRolePolicies`, and `iam:ListAttachedRolePolicies` are AccessDenied from:

* `ChecksOpsProductionSql53ConfigWriter/sql53-execute-retry`
* `ChecksOpsCursorCloudStaging/sql53-iam-cleanup-read`

The full live trust document is therefore unread. This review does not invent the Identity Center principal ARN.

## Exact temporary Cursor OIDC statement to remove

This statement is the official additive trust for `user:325724407`. It is functionally present: that subject assumed `ChecksOpsProductionSql53ConfigWriter` for the completed inspection.

```json
{
  "Sid": "AllowOwnerCursorCloudOidcFingerprintOnly",
  "Effect": "Allow",
  "Principal": {
    "Federated": "arn:aws:iam::806168576068:oidc-provider/api.cursor.com"
  },
  "Action": "sts:AssumeRoleWithWebIdentity",
  "Condition": {
    "StringEquals": {
      "api.cursor.com:aud": "sts.amazonaws.com",
      "api.cursor.com:sub": "user:325724407"
    }
  }
}
```

## Current trust policy

Live document: unread (`iam:GetRole` AccessDenied).

Known contents:

* Temporary Cursor OIDC statement above: present
* IAM Identity Center AdministratorAccess `sts:AssumeRole` statement: preserve; exact live JSON unread

## Proposed trust policy after removal

Live document: unread.

Operation: delete only the approved Cursor OIDC statement. Leave every other statement, including Identity Center AdministratorAccess, byte-identical and in the same order. Do not call any permission-policy APIs.

Official helper: `removeSql53ConfigWriterOidcTrust`. It refuses if Identity Center would disappear, if a different Cursor OIDC statement exists, or if the comparison is not limited to that one statement.

## Comparison

| Change | Result |
| --- | --- |
| Added statements | none |
| Removed statements | only `AllowOwnerCursorCloudOidcFingerprintOnly` / `api.cursor.com` / `user:325724407` |
| Identity Center AdministratorAccess | unchanged |
| Writer permission policies | unchanged |

A complete before/after JSON dump still requires Identity Center AdministratorAccess `GetRole` immediately before apply.
