# Gate 3A BLOCKED — CreateSecret denied by KMS

**STOP FOR REVIEW. Gates 3A–3C were not applied.**

Assumed `ChecksOpsCursorApiPerimeterStep3Temp`
(`.../checksops-step3-gates-3abc`). Caller identity is the expected
Step 3 temporary OIDC role.

Execution role `checksops-production-origin-verify` **exists** and
matches the reviewed template:

| Check | Result |
|---|---|
| Trust | `lambda.amazonaws.com` / `sts:AssumeRole` only |
| Inline policy `origin-verify-secret-and-logs` | matches reviewed YAML (authorizer logs + `GetSecretValue` on `cloudfront-origin-verify*`) |
| `ListRolePolicies` / `ListAttachedRolePolicies` | AccessDenied on Step3Temp (no list). CFN stack created no managed policies |
| `holds.ok` | **true** |
| `productionExecution` | **false** |
| Moov / CheckAlt / provider / financial | **false** |
| `64_financial_activation_grants.sql` | **NOT_APPLIED** |

| Gate | Result |
|---|---|
| 3A | **FAIL / BLOCKED** — `secretsmanager:CreateSecret` → `Access to KMS is not allowed` (explicit deny `kms:*` / `DenyKmsAndRoleChaining`) |
| 3B | **NOT STARTED** |
| 3C | **NOT STARTED** |
| 3D / `ORIGIN_VERIFY_REQUIRE=true` | **Not started** |

Nothing was created: no secret, no authorizer Lambda, no authorizer
object. `$default` is still `NONE`. CloudFront was not modified.
SPA / prep Lambda / RDS / Cognito / WAF / DNS untouched. Temporary
API-perimeter roles were not deleted.

AWS-managed Secrets Manager key (from staging `DescribeKey` denial):
`arn:aws:kms:us-east-1:806168576068:key/691886af-d43c-4c6e-a411-3e55f44249ba`
(`alias/aws/secretsmanager`).

---

## Privileged operator — pick one

Do **not** paste the secret value into tickets, chat, or Git.

### A. Create the secret only (smallest)

Prints **ARN only**. Deletes the local file.

```
umask 077
python3 -c 'import json,secrets; open("/tmp/ov-secret.json","w").write(json.dumps({"current":secrets.token_hex(32),"next":""}))'
chmod 600 /tmp/ov-secret.json
aws secretsmanager create-secret \
  --region us-east-1 \
  --name checksops/production/cloudfront-origin-verify \
  --description "CloudFront origin-verify dual-secret. Do not print." \
  --secret-string file:///tmp/ov-secret.json \
  --query ARN --output text
shred -u /tmp/ov-secret.json 2>/dev/null || rm -f /tmp/ov-secret.json
```

Then Cursor resumes Gate 3A (script will `describe-secret` and skip
create). If `GetSecretValue` also hits the KMS deny, use option B.

### B. Except the SM KMS key on Step3Temp (so 3A can create it)

Explicit deny wins over allow. Update
`ChecksOpsCursorApiPerimeterStep3Deny` `DenyKmsAndRoleChaining` to
`NotResource` the SM key / alias, and add an allow:

- `kms:Encrypt`
- `kms:Decrypt`
- `kms:GenerateDataKey`
- `kms:DescribeKey`

on `arn:aws:kms:us-east-1:806168576068:key/691886af-d43c-4c6e-a411-3e55f44249ba`
and `arn:aws:kms:us-east-1:806168576068:alias/aws/secretsmanager`.

Do not broaden staging. Do not recreate deleted hardening roles.
Do not attach the authorizer. Do not change CloudFront. Do not set
`ORIGIN_VERIFY_REQUIRE=true`.
