# SQL53 writer Cursor OIDC trust (prepare only)

**STOP FOR APPROVAL.** Do not update IAM, assume
`ChecksOpsProductionSql53ConfigWriter`, invoke Lambda, or set SQL53
environment variables from this document.

## Live Cursor Cloud OIDC

This run minted a Cursor Cloud OIDC token with `aud=sts.amazonaws.com`
and decoded these claims (token not stored):

| Claim | Live value |
|---|---|
| `iss` | `https://api.cursor.com` |
| `aud` | `sts.amazonaws.com` |
| `sub` | `user:325724407` |
| `alg` | `RS256` |

That exact token assumed `ChecksOpsCursorCloudStaging` via
`AssumeRoleWithWebIdentity`. That proves the account OIDC provider
`arn:aws:iam::806168576068:oidc-provider/api.cursor.com` accepts this
owner subject. It does **not** grant this staging role any new
permissions and does **not** let staging assume the SQL53 writer.

`iam:GetOpenIDConnectProvider` from Cursor staging remains
`AccessDenied`. Cursor staging was not asked to assume the writer.

## Can `user:325724407` securely assume the writer?

| Question | Answer |
|---|---|
| Can it assume **today**? | **No.** Owner-reported live trust allows only the IAM Identity Center AdministratorAccess role. |
| Can it assume **after this additive statement**? | **Yes**, only that Cursor owner subject, using `sts:AssumeRoleWithWebIdentity`. |
| Other Cursor users? | **No.** `StringEquals` on `api.cursor.com:sub=user:325724407`. |
| `ChecksOpsCursorCloudStaging`? | **No.** Not added as a trusted principal. Staging cannot `sts:AssumeRole` onto the writer. |
| Existing Identity Center admin? | **Unchanged.** The merge only appends. It refuses to emit a document that drops the Identity Center AdministratorAccess allow. |

Residual: any later Cloud Agent owned by `user:325724407` could assume
the writer and then use its Lambda permissions. The official writer
still requires a signed receipt before configuration apply/invoke.
Fingerprint-only is a later, separate authorization.

Live `GetRole` / `GetRolePolicy` from Cursor staging are `AccessDenied`.
The Identity Center role ARN and the live identity-policy document are
therefore **unverified** here. Required remaining permissions:

```text
lambda:GetFunctionConfiguration
lambda:UpdateFunctionConfiguration
lambda:InvokeFunction
```

on only

```text
arn:aws:lambda:us-east-1:806168576068:function:checksops-production-prep-api
```

## Proposed trust-policy change

Append **exactly one** statement. Do not edit, reorder, or remove the
existing Identity Center AdministratorAccess allow.

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

File: `aws/production/sql53-config-writer-trust-additive-cursor-oidc.json`.

Do not grant access to `ChecksOpsCursorCloudStaging`. Do not use
`api.cursor.com:sub` wildcards. Do not add GitHub OIDC.

## Owner apply procedure (not authorized yet)

Run only from the existing Identity Center AdministratorAccess role
after this change is approved:

```bash
aws iam get-role --role-name ChecksOpsProductionSql53ConfigWriter \
  --query 'Role.AssumeRolePolicyDocument' --output json > /tmp/sql53-writer-trust-current.json

aws iam get-role-policy --role-name ChecksOpsProductionSql53ConfigWriter \
  --policy-name ChecksOpsProductionSql53ConfigWriterInline \
  --query 'PolicyDocument' --output json

# Confirm the identity policy is still only the three Lambda actions on
# checksops-production-prep-api. If the inline name differs, list-role-policies
# first. If attached managed policies exist, stop.

# Merge locally with scripts/deployment-guard/lib/sql53-config-writer-trust-merge.mjs
# The merge must report changed:true and keep the current first statement(s).

aws iam update-assume-role-policy \
  --role-name ChecksOpsProductionSql53ConfigWriter \
  --policy-document file://<merged-trust.json>
```

Then independently `GetRole` and confirm:

1. The original Identity Center allow is still present and unchanged.
2. The Cursor OIDC statement above is present.
3. Permissions are still the three approved Lambda actions.
4. Staging is not trusted.

Stop again before `--fingerprint-only`.
