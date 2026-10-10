# Production SQL 53 overlay

Owner-authorized guarded Lambda overlay that adds the SQL 53 read-only
catalog diagnostic to `checksops-production-prep-api`. Diagnostic
invocation, SQL sessions, IAM changes, tokens, and SPA deploys remain
unauthorized.

## Applied live fingerprints (2026-10-10T18:26:47Z)

- Function: `checksops-production-prep-api`
- CodeSha256: `oQDCIRFyreTPe781aeSFLdXNfU3M2ZUQo5Wcgi0EqWI=`
- RevisionId: `534d4e36-0e62-461e-948e-e2bf00d3920e`
- LastModified: `2026-10-10T18:26:47.000+0000`
- LastUpdateStatus: `Successful`
- Members: 6482
- `CHECKSOPS_ENV=production-prep` unchanged
- SQL53 authorization and expiry environment variables remain absent
- Secret ARN and VPC/role/runtime/handler/memory/timeout unchanged

## Pre-apply fingerprints (unchanged until overlay)

- CodeSha256: `DMcCoF3dpIiULPe530F8DJ8vC1wL1BP7ayqr+e8SCyI=`
- RevisionId: `fb17cb70-7b50-468d-a0a6-59a020c43f8c`
- LastModified: `2026-10-06T20:29:23.000+0000`
- Members: 6481
- Live `index.mjs`: `24f13aa5ff4f3d72e7f5ff4dc45dd194796aa4e75958de5bc39c8c1dce3eb4da`

## Member changes

Added:

- `sql53-production-readonly-inspect.mjs` (`4e356350e4abdf58fdb6ba3ab4e62efbe1aa21f7720a49f1f0128860870edb68`)

Surgically patched live `index.mjs` only:

- import the diagnostic
- call `isSql53ProductionReadonlyInspectEvent(event)` before HTTP routing
- patched hash `77836ef63e6fbca6fb3e49f5970e705cf38b2af653c1be2c4a728be04caf3a9f`

Preserved: 6480 members, including `db-readonly-validate.mjs`,
`db-health.mjs`, and `secrets.mjs`. Deleted: none.

Independent post-apply ZIP download matched live CodeSha256. Official
post-overlay membership check passed.

## HTTP and auth

The diagnostic is not registered as an HTTP route. API Gateway GET
`/sql53-production-readonly-inspect` remains Forbidden (same as `/health`).
Authorization tokens were not created. Temporary diagnostic environment
variables remain unset.

## Next authorized step

Later temporary owner-chosen token, `CHECKSOPS_SQL53_READONLY_INSPECT_EXPIRES_AT`,
and tightly scoped `lambda:InvokeFunction`. Do not invoke the diagnostic
until that authorization exists.
