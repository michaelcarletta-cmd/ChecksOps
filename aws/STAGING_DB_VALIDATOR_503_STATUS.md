# Staging DB validator 503 status (#812)

Read-only source and sandbox evidence. **No AWS writes, Lambda overlay, SPA promote, RDS change, or production change.** PR #808 is merged on `main` and is **not proven deployed**.

## Live verification from this runner

This coding-agent sandbox could not resolve `staging.checksops.com` or the staging execute-api hostname (DNS `REFUSED` / no address) and had no AWS credentials (`aws sts` → `NoCredentials`). Public HTTPS fingerprinting and API Gateway inspection were therefore **not proven live here**.

Re-run after an approved network/IAM read-only context (still no deploy):

```bash
node scripts/deployment-guard/staging-db-validator-readonly-status.mjs
```

That script: GETs the staging SPA and entry bundle, OPTIONS/GET on `/db-readonly-validate`, records SHA-256 / entry bundle / whether `/admin/db-validator` is in live assets, and checks CORS GET + `authorization`. It never sends a token.

Existing S3 inspect (`scripts/deployment-guard/staging-spa-inspect.mjs`) remains the control-plane fingerprint when a staging read-only role is authorized.

## Source: SPA admin UI (#808)

- Route `/admin/db-validator` is in `src/App.tsx`.
- UI is gated by admin + `VITE_AUTH_PROVIDER=cognito` + host `staging.checksops.com`.
- Browser session `access_token` is the Cognito **ID token** (`src/integrations/aws/client.ts` `toSession`).
- The page issues one body-less `GET /db-readonly-validate` with `authorization`.
- Client sanitizer keeps only `ok`, `readOnly`, and per-issue `kind` / `severity` / SQLSTATE `code` / `table` / `probe`.

Until the live SPA bundle contains `/admin/db-validator`, an authenticated admin cannot use that page. Do not promote the SPA without a separate deployment-guard approval.

## Source: CORS and `resolveClaims`

- `aws/template.yaml` `ChecksOpsApi` CORS allows origin `*`, methods including `GET`/`OPTIONS`, headers including `authorization`.
- Lambda `json()` also sets `access-control-allow-origin: *`, `allow-methods` including GET, `allow-headers` including `authorization`.
- Live gateway may still differ from the template; the status script records OPTIONS evidence. Smallest live fix if it differs: add GET + `authorization` (not applied here).
- `resolveClaims` (`aws/functions/api/data.mjs`) accepts API Gateway JWT claims or verifies a Cognito **ID** token. It does **not** check application admin role.

## Server-side detail access (least privilege)

Before this PR, any caller who passed `resolveClaims` received the full validator object (tables, counts, catalog, RLS roles, issue messages).

Source-only restriction now in `authorizeDbValidatorDetails`:

| Caller | Staging | Production |
| --- | --- | --- |
| Unauthenticated / invalid token | Public `{service,status,readOnly}` 200/503 | Same public contract |
| Authenticated non-admin | `403 {error:not_authorized}` | Full details (unchanged) |
| Authenticated `user_roles` admin | Full details (existing diagnostic contract) | Full details (unchanged) |

Identity lookup uses existing `resolveIdentitySession` / `user_roles`. Failures fail closed to 403 with no identity or validation fields. This is **not deployed**; live staging still follows previously shipped Lambda code until a separately approved overlay.

Do not use staff/owner/manager privileged roles. Do not add Cognito groups.

## 503 checks (do not assume row-count drift)

`validation.ok` is false (HTTP 503 for authorized details) when any issue has severity `error`, a core table is missing, or a table row fails `present && countMatches && !error`. Error kinds include:

- Connectivity / secrets / TLS / authentication / `SELECT 1` (`classifyDbError` stages)
- `wrong_database` / connected role not `checksops`
- `missing_relation` (any of 16 `CORE_TABLES`, or restore sentinel)
- `count_mismatch` **only when RLS is off** and `rowCount !== EXPECTED_ROW_COUNTS` — possible, **not assumed**
- `permission` (SELECT denied, unexpected writes, FORCE RLS, partial RLS, fail-closed visibility when RLS is on, schema USAGE)
- `trigger` (public trigger count ≠ 165)
- `function` / `missing_fk` / generic `query`

`/health` and `/db-health` 200 only prove the API process and a read-only `SELECT 1`. They do not identify which validator assertion fails.

Exact live kind/severity/table/probe still requires an **approved staging SPA (or diagnostic workflow)** plus an **admin Cognito ID token** GET. Record only those allowlisted fields. Never log tokens, secrets, or raw rows.

## Focused remediation (after authenticated evidence)

1. Confirm live SPA fingerprint vs `#808` commit; promote only with deployment-guard SPA receipt if the admin route is missing.
2. Confirm live OPTIONS allows GET + `authorization` from `https://staging.checksops.com`.
3. Run authenticated GET as admin; classify by issue `kind`/`probe`, not by guessed row-count drift.
4. Apply this source admin gate with a **separate** reviewed staging Lambda overlay if live code still returns details to any Cognito user.
5. Repair only the failing assertion class. No Review-to-Endorsing, financial/provider/auth architecture, RDS, or production changes. No Release Lock / #801 / #802 bypass.

## Tests

```bash
node --experimental-strip-types --test tests/db-validator-diagnostics.test.ts
node --test aws/tests/db-validator-access.test.mjs aws/tests/staging-db-validator-readonly-status.test.mjs
```
