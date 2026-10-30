# SPA Content-Security-Policy rollout

Owner, 2026-10-30: "Work on items 1 and 2" (item 2: a real Content-Security-Policy for the SPA,
report-only on staging first). Sign-in tokens live in `localStorage`, so a CSP is the main backstop
if injected content ever reaches the page.

| File | What it is |
|---|---|
| `scripts/deployment-guard/lib/spa-csp.mjs` | builds the policy for staging or production; hashes `index.html`'s inline script |
| `aws/staging/cloudfront-security-headers.yaml` | source-only staging response headers policy: the production baseline headers plus `Content-Security-Policy-Report-Only` |
| `.github/workflows/guarded-staging-csp-headers.yml` | the guarded staging tool for step 1: inspect, apply (create the policy, attach it), rollback (detach); `ops/deployment-guard/STAGING_CSP_HEADERS.md` |

Tests: `aws/tests/spa-csp.test.mjs`, `aws/tests/github-staging-csp-headers.test.mjs`.

## Live state (read-only, 2026-10-30, `user/claude-code`)

- Production `E1B0ZWWO5559U5` (`checksops.com`): response headers policy
  `756a8f23-68dd-4f8a-8293-5a2fd08f919a` on every behavior (HSTS, `X-Frame-Options: SAMEORIGIN`,
  `nosniff`, `strict-origin-when-cross-origin`); its CSP is empty ("CSP intentionally deferred").
- Staging `E1CG52WRQZI7X1` (`staging.checksops.com`, origin `StagingSpaS3`): no response headers
  policy at all.
- `index.html` sets only `<meta http-equiv="Content-Security-Policy" content="frame-ancestors 'self'">`,
  which browsers ignore (`frame-ancestors` has no effect in a meta tag).

## What the SPA loads (source inventory)

- API: staging `https://psr19uhop4.execute-api.us-east-1.amazonaws.com` (absolute); production
  same-origin `/prep`. Sign-in (email code, passkeys) goes through the API; the SPA makes no direct
  Cognito calls.
- Files: presigned S3 URLs from the API (`storage.mjs`, `storage-write.mjs`), read with `fetch`,
  shown in `<img>`/`<iframe>`, uploaded with `PUT`. Many `blob:` object URLs for previews, CSV and
  PDF downloads.
- pdf.js worker: bundled with the SPA (`FieldPlacementEditor.tsx` imports react-pdf's own
  `pdfjs-dist/build/pdf.worker.min.mjs?url`, emitted as `assets/pdf.worker.min-<hash>.mjs`), so it
  always matches the pdf.js version react-pdf runs. Both SPA uploaders serve `.mjs` as
  `application/javascript`, which a module worker needs. It used to come from `https://unpkg.com`.
- ZIP lookups: `https://api.zippopotam.us` (`ContractorServiceAreaCard.tsx`).
- Fonts: `@fontsource` files served from the SPA itself; PWA manifest and service worker from `'self'`.
- Inline: one inline `<script>` in `index.html` (the hostname title script, allowed by its sha256)
  and one `style` attribute (the initial loader). No `eval`/`new Function` in `src/`.
- Links only, never loaded: Google Maps, app stores, Moov docs, `insurance.servicer.com`.

## Policy

`buildCsp({ environment, indexHtml })`; the staging value is in the template. Highlights:
`default-src 'self'`, `script-src 'self' 'sha256-…'` (no `'unsafe-inline'`, no
`'unsafe-eval'`), `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`,
`frame-ancestors 'self'`, `connect-src` limited to the API, presigned S3, ZIP lookup,
`data:` and `blob:`. Production drops the execute-api host (same-origin `/prep`).

## Open decisions (owner)

1. **Style `'unsafe-inline'`.** The loader's `style` attribute and UI libraries that inject `<style>`
   need it. Keeping it is common and low risk (style injection cannot run script); removing it
   needs the loader moved into a stylesheet and a report-only check of every screen.
2. **Report endpoint.** Report-only with no `report-uri` shows violations in the browser console only.
   Option: a small API route that logs reports (rate-limited, no body stored), added as its own PR.
3. **pdf.js worker.** Done (2026-10-30): the worker is self-hosted and `https://unpkg.com` is gone
   from `script-src`, `connect-src` and `worker-src`. The SPA ships it on the next guarded website
   deploy.

## Rollout (each step on the owner's words, staging before production)

1. **Staging report-only.** `guarded-staging-csp-headers.yml`: `mode: inspect`, then `mode: apply`
   with the inspect's snapshot SHA-256 and the owner's words "ATTACH REPORT-ONLY CSP TO STAGING". It
   creates the policy from `aws/staging/cloudfront-security-headers.yaml` with the CSP built from the
   live staging `index.html` and attaches it to `E1CG52WRQZI7X1`'s default behavior. Deploy the
   current `main` to staging first, so the self-hosted pdf.js worker is what staging serves. Use every
   screen (sign-in, checks, uploads and previews, PDF field placement, deposits, settings) and collect
   violations from the console.
2. **Adjust** the directives in `spa-csp.mjs` for any real violation (reviewed PR), repeat 1.
3. **Staging enforce.** Move the value to `SecurityHeadersConfig.ContentSecurityPolicy`, add
   `upgrade-insecure-requests`, retest.
4. **Production report-only**, then **production enforce**, on the production policy
   `756a8f23-…`, each on the owner's approval of that change.

## Rollback

`guarded-staging-csp-headers.yml` with `mode: rollback` and the owner's words "DETACH CSP FROM
STAGING": the default behavior goes back to no response headers policy, as before step 1; the policy
object stays. Report-only never blocks anything.

## Not done yet

Nothing is attached or created: the staging tool has not run, and its IAM role
(`ChecksOpsGitHubStagingCspHeaders`) does not exist yet (`ops/deployment-guard/STAGING_CSP_HEADERS.md`).
No production change.
