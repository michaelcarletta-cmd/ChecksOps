# Production SQL 53 overlay (evaluate-only)

Source-only preparation of the smallest production Lambda overlay that
adds the owner-gated SQL 53 catalog diagnostic. This workstream does not
upload a ZIP, change Lambda configuration, create tokens, invoke SQL, or
dispatch apply.

## Live fingerprints (2026-10-10)

- Function: `checksops-production-prep-api`
- CodeSha256: `DMcCoF3dpIiULPe530F8DJ8vC1wL1BP7ayqr+e8SCyI=`
- RevisionId: `fb17cb70-7b50-468d-a0a6-59a020c43f8c`
- LastModified: `2026-10-06T20:29:23.000+0000`
- Members: 6481
- `CHECKSOPS_ENV=production-prep`
- SQL53 authorization and expiry environment variables are absent
- Secret ARN remains the proven production credential
- Target RDS identifier remains `checksops-production`

These fingerprints match the #858 pin. No live drift.

## Proposed member changes

Add:

- `sql53-production-readonly-inspect.mjs`

Surgically patch live `index.mjs` only:

- import the diagnostic
- call `isSql53ProductionReadonlyInspectEvent(event)` before HTTP routing

Do not replace live `index.mjs` with `origin/main`. Do not replace
`db-readonly-validate.mjs`, `db-health.mjs`, or `secrets.mjs`.

Official evaluate-only result: 1 added, 1 changed, 0 deleted, 6480 identical.

## HTTP and auth

The diagnostic is not registered as an HTTP route. API Gateway GET
`/sql53-production-readonly-inspect` continues to 404. Authorization
tokens are not enabled and must not be created in this workstream.

The live Lambda environment is `production-prep`. The diagnostic now
accepts `production` or `production-prep` and still binds the secret host
to `checksops-production` before connect.

## Next authorized step

After explicit overlay apply authorization: download a fresh live ZIP,
confirm CodeSha256 and RevisionId are unchanged, overlay only the two
owned members through `scripts/deployment-guard/lambda-overlay.mjs`, and
do not set authorization environment variables in that same step.
