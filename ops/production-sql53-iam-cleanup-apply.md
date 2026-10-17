# SQL53 IAM trust cleanup

## IAM_CLEANUP_VERIFIED: NO

Authorized one-statement removal of `AllowOwnerCursorCloudOidcFingerprintOnly` was not applied.

No Identity Center AdministratorAccess session was available. Official `--identity-only` returned `PRODUCTION_APPROVAL_REQUIRED` / `arn_class=unavailable`. Live trust was not read. `update-assume-role-policy` was not called.

## Sanitized before/after

| | Before | After |
| --- | --- | --- |
| Live trust document | unread | unread |
| Added statements | none | none |
| Removed statements | none | none |
| Permission policies | untouched | untouched |

## Stop conditions met

* Authorized IAM Identity Center AdministratorAccess session: missing
* Complete live trust policy immediately before apply: not read
* Exact one-statement removal: not verified against live JSON

Available identities were the invalid injected default credentials, expired writer session, and `ChecksOpsCursorCloudStaging`. Those were not used to bypass AccessDenied or update IAM.

Re-run only with an `AWSReservedSSO_AdministratorAccess_*` session:

`CHECKSOPS_SQL53_OIDC_TRUST_CLEANUP=1 node scripts/deployment-guard/sql53-config-writer-trust-cleanup.mjs --apply`
