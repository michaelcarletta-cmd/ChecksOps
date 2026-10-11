# SQL53 writer OIDC trust apply (blocked from Cursor staging)

Owner approved appending the Cursor Cloud OIDC statement for
`user:325724407`. This session could not apply it.

## Fresh pre-apply read

| Check | Result |
|---|---|
| Cursor OIDC `iss` / `aud` / `sub` | `https://api.cursor.com` / `sts.amazonaws.com` / `user:325724407` |
| Probe identity | `ChecksOpsCursorCloudStaging` |
| `iam:GetRole` | `AccessDenied` |
| Inline / attached policy list | `AccessDenied` |
| Three Lambda permissions confirmed live | **No** — unverified from this identity |
| IAM write attempted | **No** |
| Writer role assumed | **No** |
| Fingerprint-only / invoke | **No** |

Staging was not broadened. The approved statement was not applied
because this identity is not the IAM Identity Center administrator, and
the required live trust/permission read did not succeed. Applying
without that read would replace trust blindly.

## APPLY_EXECUTED: NO

`reason=AUTHORIZED_ADMINISTRATOR_UNAVAILABLE`

## Owner apply from Identity Center AdministratorAccess

```bash
aws sts get-caller-identity
# Must be account 806168576068 and
# assumed-role/AWSReservedSSO_AdministratorAccess_<id>/<session>

CHECKSOPS_SQL53_OIDC_TRUST_APPLY=1 \
  node scripts/deployment-guard/sql53-config-writer-trust-apply.mjs --apply
```

The script:

1. Refuses Cursor staging and every non-SSO-admin identity before any write.
2. Fresh-reads live trust and the single inline policy.
3. Refuses unless permissions are exactly the three approved Lambda
   actions on `checksops-production-prep-api`.
4. Appends only the approved OIDC statement; keeps the existing
   Identity Center allow unchanged.
5. Re-reads trust and permissions. It does not assume the writer,
   run fingerprint-only, or invoke the diagnostic.

Remove this Cursor OIDC trust after the authorized SQL53 work.
