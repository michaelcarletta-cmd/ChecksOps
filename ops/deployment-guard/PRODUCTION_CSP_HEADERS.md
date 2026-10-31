# Guarded production CSP headers

`.github/workflows/guarded-production-csp-headers.yml` is SPA CSP rollout step 5
(`ops/security/SPA_CSP_ROLLOUT.md`): the enforcing Content-Security-Policy on
`https://checksops.com`, the one staging has enforced since run 41086648035.

Owner decisions, 2026-10-31: "Production CSP: whether to roll it out now. It has been enforced on
staging without problems. - roll out" and "build the production CSP tooling, in place". In place:
the existing production response headers policy `756a8f23-68dd-4f8a-8293-5a2fd08f919a`
(`checksops-production-browser-security-headers`, attached to the default behavior, `/prep` and
`/prep/*` of distribution `E1B0ZWWO5559U5`) is updated. The distribution is not changed and no
policy is created.

This file and the tool are source only. Nothing has been run against production.

## What each mode does

- **inspect** reads the distribution, the policy and the live `index.html` in
  `checksops-production-frontend-806168576068`. It prints the state, the snapshot SHA-256 and the
  exact `Content-Security-Policy` an enforce would set. The states are:
  - `BASELINE`: exactly the SH-1 template, no CSP;
  - `ENFORCING_CURRENT`: our CSP for the live `index.html`;
  - `ENFORCING_STALE`: our CSP, but a newer `index.html` changed the inline-script hash;
  - `BLOCKED`: anything else.
- **enforce** ("ENFORCE CSP ON PRODUCTION", from `BASELINE` or `ENFORCING_STALE`) updates the
  policy to:
  - the SH-1 `SecurityHeadersConfig` from `aws/production/cloudfront-security-headers.yaml`,
    byte-for-byte (HSTS one year with subdomains, `X-Frame-Options: SAMEORIGIN`, `nosniff`,
    `strict-origin-when-cross-origin`);
  - `ContentSecurityPolicy` = `buildCsp({ environment: 'production', indexHtml: <live index.html>, enforce: true })`
    (`scripts/deployment-guard/lib/spa-csp.mjs`), Override true;
  - the comment "Low-risk browser security headers plus the enforcing SPA CSP
    (guarded-production-csp-headers.yml)."
- **revert** ("REMOVE CSP FROM PRODUCTION", from `ENFORCING_CURRENT` or `ENFORCING_STALE`) puts
  exactly the SH-1 template back (no CSP, its comment "Low-risk browser security headers; CSP
  intentionally deferred.").

The CSP hash comes from the live `index.html` that the run reads, never from a typed value.

`BLOCKED` covers:
- staging ids;
- the policy missing from the default behavior, `/prep` or `/prep/*`;
- WAF or alias drift, or a distribution that is not `Deployed`;
- a baseline header changed;
- a CSP that is not ours;
- custom headers, CORS, removed headers or server timing on the policy;
- a comment this tool does not set.

### The policy text enforce sets today

This is `buildCsp` on main's `index.html`, whose bytes are those of the last production SPA upload
(main 9cd8b75b3, run 41192829445). The run rebuilds it from the live file.

```
default-src 'self'; script-src 'self' 'sha256-ts3my6jAAjgd6WfZ3C3O2R2Lc8IrKeHMSIlUM6Sdsmg='; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.s3.amazonaws.com https://*.s3.us-east-1.amazonaws.com; font-src 'self' data:; connect-src 'self' https://*.s3.amazonaws.com https://*.s3.us-east-1.amazonaws.com https://api.zippopotam.us data: blob:; frame-src 'self' blob: data: https://*.s3.amazonaws.com https://*.s3.us-east-1.amazonaws.com; worker-src 'self' blob:; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'; upgrade-insecure-requests
```

Compared with staging's enforcing policy, this one drops the staging API host
(`https://psr19uhop4.execute-api.us-east-1.amazonaws.com`). Production calls the API same-origin
at `/prep`: the production SPA build sets `VITE_CHECKSOPS_API_URL=/prep`, so both checksops.com and
www are covered by `'self'`. Everything else is the same:
- presigned S3 is served from `*.s3.amazonaws.com` / `*.s3.us-east-1.amazonaws.com`;
- ZIP lookups use `api.zippopotam.us`;
- the pdf.js worker is self-hosted;
- fonts are served from the SPA itself;
- no Cognito, Moov or Check Alt host is called from the browser.

The writer refuses a production CSP that contains `psr19uhop4`, `staging.checksops.com` or the
staging bucket.

### Behaviors behind the same policy

`/prep` and `/prep/*` share the policy, so API responses carry the CSP too. The API serves JSON and
signature-checked raster logos (`/prep/branding/logo/*`), never HTML, so the CSP changes nothing
there. The logo route has no stricter CSP of its own: it stays deferred
(`ops/security/BRANDING_LOGO_ROUTE_HEADERS.md`). A stricter one would need its own behavior and
policy, which is a distribution change and not part of this tool.

## Guards

- **Writer.** `scripts/deployment-guard/production-csp-headers.mjs` makes exactly one call that
  writes: UpdateResponseHeadersPolicy on `756a8f23-…`, with the policy's If-Match ETag. It refuses
  any other distribution or policy, and refuses `E1CG52WRQZI7X1` and `d3f84b15-…` by name.
- **Receipt and lease.** It needs a production `cloudfront-response-headers-policy` receipt for
  component `production-spa` that owns exactly `response-headers-policy:756a8f23-…`, plus the
  lease. It also needs the production gate: a staging acceptance reference, approval for this
  workstream, and a second fingerprint taken immediately before the write.
- **Snapshot.** It re-reads the whole snapshot (distribution config, policy, `index.html`) and
  compares it with the signed inspect, once at preflight and once immediately before the write.
- **Post-write check.** After the write, the distribution config must be byte-for-byte unchanged
  and the policy must read back exactly as sent (CloudFront's empty-section echo is not drift).
- **Preflight.** `scripts/deployment-guard/github-production-csp-headers.mjs` never writes AWS.
- **Concurrency.** The workflow shares the production SPA upload's concurrency group
  (`guarded-production-spa-upload`), so the two never overlap. Any SPA upload changes the
  inline-script hash, which makes inspect report `ENFORCING_STALE`; enforce again refreshes it.
- **Role.** `ChecksOpsGitHubProductionCspHeaders` (`ops/deployment-guard/production-csp-headers/`)
  is trusted only for this workflow file on `refs/heads/main` in the `production` environment.

Tests: `aws/tests/github-production-csp-headers.test.mjs`, `aws/tests/spa-csp.test.mjs`.

## One-time setup (owner)

1. Create the role from `ops/deployment-guard/production-csp-headers/` (its README has the
   commands).
2. In the GitHub `production` environment, add the variable
   `CHECKSOPS_PRODUCTION_CSP_HEADERS_ROLE_ARN` =
   `arn:aws:iam::806168576068:role/ChecksOpsGitHubProductionCspHeaders`.
   `CHECKSOPS_PRODUCTION_DEPLOYMENT_GUARD_KMS_KEY_ARN` is already set.

## Each change

1. Run the workflow from `main` with `mode: inspect`. Expect `BASELINE` before the first enforce.
   Note the snapshot SHA-256 and the CSP value in the run summary. Any `BLOCKED` problem stops
   here: report it.
2. Run it with:
   - `mode: enforce`;
   - `approved_commit` = the current `main` SHA;
   - `expected_snapshot_sha256` = the value from step 1;
   - `staging_acceptance_reference` = `https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/41086648035`;
   - `approval_phrase` = `ENFORCE CSP ON PRODUCTION`.

   The production environment reviewer (the owner) approves the job.
3. The run stops before any write if `main` moved, the phrase or the reference is missing or
   wrong, or the distribution, the policy or the live `index.html` changed since the inspect
   (`DEPLOYMENT_COLLISION`). After the write, the run checks the following, and fails if any
   check fails:
   - it re-reads the snapshot and expects `ENFORCING_CURRENT`, with the distribution config
     unchanged;
   - `https://checksops.com/` serves exactly the enforcing `Content-Security-Policy`, the four
     SH-1 headers, and no report-only header;
   - `https://checksops.com/prep/health` answers 200 `ok`.
4. Use every screen with the console open: sign-in, checks, uploads and previews, PDF field
   placement, deposits, wallet, settings, tenant logos. A blocked load is now a broken screen.
   Revert at once if one appears.
5. Record the run (run id, snapshot before and after, the CSP value) in this file and in
   `ops/security/SPA_CSP_ROLLOUT.md` with a record PR.

**Revert.** Run inspect, then the same inputs with `mode: revert` and the phrase
`REMOVE CSP FROM PRODUCTION`. `staging_acceptance_reference` is still required: cite the enforce
run being reverted. The public check then expects no `Content-Security-Policy`, with the SH-1
headers still present.

**After an SPA upload.** Inspect reports `ENFORCING_STALE` once the inline script changes. Until
the policy is refreshed, the old hash blocks that inline script, which only sets the page title.
Refresh with inspect, then enforce again (same phrase, a new run, a new approval).

## Run log

None yet.
