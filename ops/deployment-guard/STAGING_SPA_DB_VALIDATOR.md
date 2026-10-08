# Guarded staging SPA for `/admin/db-validator` (issue #809)

Source-only follow-up after merged PR #808. This document does **not**
authorize merge, deploy, Lambda overlay, S3 upload, CloudFront invalidation,
or database changes.

## Why

PR #808 added `/admin/db-validator` in git. The staging S3 frontend bundle is
older and does not contain that route until a reviewed, guarded SPA promote
runs against current live `index.html`.

## Authorization contract (verified in source)

| Layer | Gate | Details returned |
|---|---|---|
| Public `GET /db-readonly-validate` | none | `service`, `status`, `readOnly` only |
| API details | Cognito `resolveClaims` (`auth.ok`) | full validator payload |
| Staging UI | `isAdmin` **and** `VITE_AUTH_PROVIDER=cognito` **and** host `staging.checksops.com` | sanitized issue kind/severity/SQLSTATE/table/probe |

The Lambda handler does **not** check `user_roles.admin`. That is intentional
for this follow-up: the existing staging DB diagnostic workflow uses a Cognito
ID token, not an application-role probe. Tightening the API to app-admin would
be a separate reviewed Lambda overlay (`SOURCE_RECONCILIATION_REQUIRED` if
`index.mjs` already differs from live). Do not change that contract from a SPA
workstream.

UI 401/403 handling and sanitizer tests remain in
`tests/db-validator-diagnostics.test.ts`.

## CORS

`aws/template.yaml` `ChecksOpsApi` already allows origin `*`, method `GET`, and
header `authorization`. Handler `OPTIONS` responses advertise the same headers.
If the **live** HTTP API CORS config differs from the template, the smallest
fix is to add `GET` and `authorization` there. That is an API Gateway change
and is **not** applied here.

Unauthenticated `GET` must stay publicly redacted. Do not send ID tokens from
this workstream.

## Concurrent workstreams and release locks

- Independent **source** work may continue.
- Shared-target **deploy** of `staging-frontend` / `index.html` needs a lease
  plus a spa-promote receipt bound to this workstream, commit, and live
  fingerprint.
- If another open frontend workstream also changed the SPA:
  `SOURCE_COMPOSITION_REQUIRED`. Build one combined candidate; do not overwrite
  unrelated live members.
- If live `index.html` changed after preflight: `DEPLOYMENT_COLLISION`. Stop.
  Never put the old index back. Never reclaim staging.
- Do not touch `ops/release-locks/*` from this workstream.
- Do not overlay `checksops-staging-api` or apply SQL for this page.

## Guarded staging frontend procedure (evaluate, then separately authorized apply)

Official commands only. Evaluate-only unless a later reviewed apply
authorization exists for **this** workstream.

1. Read-only inspect current staging `index.html` (does not upload):

   ```bash
   node scripts/deployment-guard/staging-spa-inspect.mjs
   ```

2. Confirm frontend composition. If multiple workstreams changed SPA sources,
   stop and compose. Do not promote a partial bundle.

3. Fresh clean build (never reuse `dist/`):

   ```bash
   npm run build:aws
   ```

4. Identity, lease, receipt (no AWS write):

   ```bash
   node scripts/deployment-guard/manifest.mjs --input path/to/workstream.json
   node scripts/deployment-guard/preflight.mjs --acquire-lease --receipt --input path/to/workstream.json
   node scripts/deployment-guard/spa-promote.mjs --input path/to/spa.json
   ```

   `workstream.json` / `spa.json` must set `target_environment=staging`,
   `deployment_type=spa-promote`, `owned_components` including `index.html`,
   current live `index_html_sha256` + `entry_bundle`, a source composition
   manifest, and `immediately_before` captured at the mutation boundary.
   Production bucket `checksops-production-frontend-806168576068` is forbidden.

5. Apply is **not** performed by this PR. A later authorized operator may run
   `scripts/deployment-guard/staging-spa-upload.mjs` only with a valid
   staging-frontend spa-promote receipt. That writer re-reads live `index.html`
   immediately before the switch and refuses fingerprint drift.

6. After an authorized upload, hard-refresh `https://staging.checksops.com/admin/db-validator`
   with an admin Cognito session. Public CORS/page checks:

   ```bash
   node scripts/deployment-guard/db-validator-staging-probe.mjs --input path/to/observations.json
   ```

   Default CLI is evaluate-only. `--live` is refused in this follow-up so CI
   cannot open authenticated or mutating sessions.

## Blockers (this agent run)

- No reviewed apply receipt/lease for workstream `pr-809-staging-db-validator-spa`.
- This environment could not resolve `staging.checksops.com` or the staging
  execute-api host (`curl: Could not resolve host`). Live page and live CORS
  were **not** observed here.
- Live S3 bundle is reported older than PR #808; source still contains the
  route. Confirm with `staging-spa-inspect` from an authorized main inspect
  workflow before any upload.
- Authenticated detail UAT needs an admin Cognito login and is out of band.
- Production remains untouched.

## Tests

```bash
node --test aws/tests/staging-db-validator-followup.test.mjs
node --experimental-strip-types --test tests/db-validator-diagnostics.test.ts
```

Do not merge, deploy, or modify AWS or database resources from this document.
