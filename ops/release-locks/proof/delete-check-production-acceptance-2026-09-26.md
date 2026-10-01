## Delete Check accepted production contract (2026-09-26)

This document records the accepted Delete Check behavior that is now treated as a production contract.

Scope: safeguards / provenance only. This file does **not** authorize deployment, change IAM, or alter database schema/RLS.

### Accepted production baseline

- **Production Lambda**: `checksops-production-prep-api`
- **Accepted post-deploy Lambda CodeSha256**: `Hhij5GWW/GDBcRE+4wYomml96R+6IWwFJPczbz5YLZM=`
- **Accepted Git provenance**: `f5d616431642ce5938827379c9221c822fea5bf3`
- **Accepted staging source package (prior acceptance)**: `checksops-staging-api` CodeSha256 `U2veBoccUbthwAXZ8b1TiZFkmL6c41EASYxMmX4OZXQ=`

### Deployment method (accepted)

Accepted production was produced by a controlled overlay:

- Base: download the **live** `checksops-production-prep-api` package zip.
- Overlay: replace only `workflow.mjs` with the staging-accepted implementation.
- Deploy: `aws lambda update-function-code` to `checksops-production-prep-api`.
- Preserve: environment variables / role / VPC / flags unchanged.

### Delete Check behavioral invariants (must not regress)

1. Delete Check is platform-admin-only.
2. A deletion reason of at least 3 **trimmed** characters is required.
3. Claim linkage alone does not prevent deletion.
4. Partner/shared checks cannot be deleted.
5. Deposited/terminal financial checks cannot be deleted.
6. Checks with actual financial/provider activity cannot be deleted (specific blocker is reported).
7. Tenant/RLS isolation remains enforced.
8. Non-financial dependent relationships can be safely cleaned when required.
9. Check-specific S3 objects are cleaned after successful DB deletion.
10. S3 cleanup remains check-scoped (never broaden to tenant-wide prefixes).
11. Another check’s S3 objects are never removed.
12. Storage-cleanup failure is explicit (not silently reported as complete success).
13. Specific refusal/error codes remain available (not generic refusal).
14. The AWS frontend/RPC bridge forwards the **trimmed** deletion reason correctly.
