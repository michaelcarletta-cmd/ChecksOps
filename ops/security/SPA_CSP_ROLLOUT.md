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
- `index.html` used to set `<meta http-equiv="Content-Security-Policy" content="frame-ancestors 'self'">`,
  which browsers ignore (`frame-ancestors` has no effect in a meta tag). Removed after the
  2026-10-30 click-through; the header carries `frame-ancestors 'self'`.

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
- Tenant logos: `<img>` from the API's `/storage/public?bucket=tenant-logos&path=…`
  (`getPublicUrl` in `src/integrations/aws/storage.ts`, `src/lib/brandingPublicUrl.ts`): the
  execute-api host on staging (in `img-src` there), same-origin `/prep` on production.
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
3. **Staging enforce.** `guarded-staging-csp-headers.yml`: `mode: inspect` (expect
   `ATTACHED_CURRENT`), then `mode: enforce` with the inspect's snapshot SHA-256 and the owner's words
   "ENFORCE CSP ON STAGING". It updates policy `d3f84b15-…` only (the distribution is not changed):
   the same directives plus `upgrade-insecure-requests` in `SecurityHeadersConfig.ContentSecurityPolicy`
   (Override true), and no `Content-Security-Policy-Report-Only` header. The run verifies the policy,
   that the distribution config is unchanged, and that staging serves exactly that
   `Content-Security-Policy` and no report-only header. Retest every screen; a blocked load is now a
   broken screen. Way back: `mode: revert`, "REVERT CSP TO REPORT-ONLY ON STAGING" (exactly the
   report-only policy again), or `mode: rollback`, "DETACH CSP FROM STAGING" (no policy at all).
   Inspect reports `ENFORCING_CURRENT` after it, `ENFORCING_STALE` once a new `index.html` changes
   the inline-script hash (enforce again refreshes it); `apply` is refused while enforcing.
4. **Production report-only**, then **production enforce**, on the production policy
   `756a8f23-…`, each on the owner's approval of that change.

## Staging click-through (2026-10-30)

Policy `d3f84b15-…` attached report-only (apply run 41067994638, confirmed `ATTACHED_CURRENT` by
inspect run 41070941215). The owner used sign-in, checks, previews, deposits and wallet screens with
the console open. CSP reports:

1. `img-src`, 22 times: tenant logos from `https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging/storage/public?…tenant-logos…`.
   Fixed: the staging API origin is in staging's `img-src`; production unchanged.
2. "`frame-ancestors` is ignored when delivered via a `<meta>` element". Fixed: the meta tag is
   removed from `index.html`.

No other CSP reports. The 404s from `/storage/sign`, 401s, 409, 406 and 502 seen in the same
session are API responses, not CSP.

Order to apply: deploy the SPA to staging first (guarded staging SPA upload), then run
`guarded-staging-csp-headers.yml` inspect (expect `ATTACHED_STALE`) and apply ("ATTACH REPORT-ONLY
CSP TO STAGING"), which updates the policy in place. The inline-script hash is unchanged by this
change, but the apply always builds from the live `index.html`.

Click-through after apply run 41079658922 (the report-only policy updated to the live
`index.html` deployed by #1308): the owner used the screens again with the console open. No CSP
reports. The `/storage/sign` 404s in the same console are staging data, not CSP: the signed objects
are missing, most likely from the finding-5 `Migration/` deletion. This cleared step 3.

## Rollback

`guarded-staging-csp-headers.yml` with `mode: rollback` and the owner's words "DETACH CSP FROM
STAGING": the default behavior goes back to no response headers policy, as before step 1; the policy
object stays. Report-only never blocks anything. From enforcing, `mode: revert` with "REVERT CSP TO
REPORT-ONLY ON STAGING" goes back to report-only instead (policy only); rollback also works from
enforcing.

## Not done yet

Staging enforce is in source (`mode: enforce`) but not run: it waits for the owner's "ENFORCE CSP ON
STAGING" on a fresh inspect. Production report-only and production enforce. No production change.
