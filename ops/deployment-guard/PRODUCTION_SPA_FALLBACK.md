# Guarded production SPA fallback

`.github/workflows/guarded-production-spa-fallback.yml` changes the CloudFront Function
`checksops-production-spa-fallback` (runtime `cloudfront-js-2.0`, viewer-request on the default
behavior of distribution `E1B0ZWWO5559U5`, checksops.com) so that the public marketing pages are
served from their own S3 objects instead of being rewritten to `/index.html`.

Why: PR #1647 builds each public marketing page (`MARKETING_PAGES` in
`src/pages/marketing/marketingPages.ts`) into an extensionless S3 key with its own `<head>` (title,
Open Graph and Twitter preview, canonical, JSON-LD; `staticPageKey` in
`src/pages/marketing/marketingStaticHead.ts`, plugin `checksops-marketing-static-heads` in
`vite.config.ts`). The SPA uploaders give those keys `text/html; charset=utf-8` and no-cache. The
objects exist in `checksops-production-frontend-806168576068`, but the LIVE function rewrites every
extensionless URI to `/index.html`, so a shared `/pricing` link still previews the home page.

This file and the tool are source only. Nothing has been run against production.

## The two versions

| file | what it does | SHA-256 |
|---|---|---|
| `aws/cloudfront/spa-fallback.baseline.js` | byte-for-byte the code LIVE before this tool (the `spa-fallback.js` of commit 2ba5c6fc1, Step 1): `/prep` and `/prep/*` unchanged, a last segment with a dot unchanged, everything else `/index.html` | `0cf839198b024b943b2834e6de414e2d0deea59d88c23373886561575f9269a1` |
| `aws/cloudfront/spa-fallback.js` | the same, plus an exact-match allowlist of every `MARKETING_PAGES` path but `/` returned unchanged | `node scripts/deployment-guard/github-production-spa-fallback.mjs` prints it as `current_code_sha256`; derive it with `sha256sum aws/cloudfront/spa-fallback.js` on an LF checkout |

The allowlist is `/pricing`, `/vs/checksops-vs-iink-payments`, `/vs/checksops-vs-snapsheet`,
`/vs/checksops-vs-guidewire-claimcenter`, `/claim-check-tracking`. `/` still goes to `/index.html`
(DefaultRootObject and the function agree), and so does `/pricing/` (exact match only).
`aws/tests/github-production-spa-fallback.test.mjs` keeps the allowlist, the writer's
`MARKETING_PATHS`, the role's S3 keys and `MARKETING_PAGES` equal, and runs both files in `node:vm`.

Staging needs no change: `E1CG52WRQZI7X1` has no function. It maps 403/404 to `/index.html`, so an
existing key such as `pricing` is already served as its own object there.

## What each mode does

- **inspect** reads, never writes:
  - `describe-function` and `get-function` for the LIVE and DEVELOPMENT stages (config, ETag, code
    SHA-256);
  - `get-distribution E1B0ZWWO5559U5` (aliases, WAF, status, every behavior's function
    associations, the config SHA-256);
  - `head-object` on every marketing key and `index.html` in the production bucket.

  It prints the state, the snapshot SHA-256 and the code SHA-256s, then probes
  `https://staging.checksops.com` for each marketing path (200, `text/html`, the page's own
  `og:title`). A green inspect run is the staging acceptance reference for publish. The states:
  - `BASELINE`: LIVE runs exactly the baseline file;
  - `CURRENT`: LIVE runs exactly `spa-fallback.js`;
  - `BLOCKED`: anything else, or `BASELINE` while a marketing object is missing or not
    `text/html; charset=utf-8` (passing a path through to a missing key would serve an S3 error).
- **publish** ("PUBLISH SPA FALLBACK TO PRODUCTION", from `BASELINE`):
  1. `update-function` on the DEVELOPMENT stage with the DEVELOPMENT ETag as If-Match, the LIVE
     runtime and comment, and the bytes of `aws/cloudfront/spa-fallback.js`;
  2. `test-function` on DEVELOPMENT for every marketing path, `/`, `/login`, `/pricing/`,
     `/assets/index-x.js` and `/prep/health`; each result must be the URI the rules give
     (`expectedUri` in the writer, written from the rules, not from the code). A failure stops here
     with LIVE unchanged;
  3. `publish-function` with the new ETag as If-Match.
- **revert** ("REVERT SPA FALLBACK ON PRODUCTION", from `CURRENT`, also when a page object went
  missing) does the same with the baseline file.

The caller never supplies code: it comes only from the two repository files.

`BLOCKED` covers:
- staging ids;
- LIVE code that is neither file, or DEVELOPMENT code that is neither file (someone else is
  working on the function);
- a runtime other than `cloudfront-js-2.0`, a comment that differs between the stages, a key value
  store association;
- the function not the default behavior's only function association (viewer-request), the function
  on any other behavior, `/prep` or `/prep/*` missing;
- WAF or alias drift, or a distribution that is not `Deployed`.

## Guards

- **Writer.** `scripts/deployment-guard/production-spa-fallback.mjs` makes three kinds of call
  that write, all on `checksops-production-spa-fallback`: UpdateFunction (DEVELOPMENT, If-Match),
  TestFunction, PublishFunction (If-Match). It refuses any other function, distribution, bucket or
  key, and refuses `E1CG52WRQZI7X1`, the staging bucket and any function name with "staging".
- **Receipt and lease.** It needs a production `cloudfront-function` receipt for component
  `production-spa` that owns exactly `cloudfront-function:checksops-production-spa-fallback`, plus
  the lease. It also needs the production gate: a staging acceptance reference, approval for this
  workstream, and a second fingerprint taken immediately before the write.
- **Snapshot.** It re-reads the whole snapshot (both stages, the distribution config, the page
  objects) and compares it with the signed inspect, once at preflight and once immediately before
  the first write.
- **Post-write check.** LIVE and DEVELOPMENT must run the desired bytes with the same runtime and
  comment; the distribution config must be byte-for-byte unchanged (so the association is too).
- **Preflight.** `scripts/deployment-guard/github-production-spa-fallback.mjs` never writes AWS.
- **Concurrency.** The workflow shares the production SPA upload's concurrency group
  (`guarded-production-spa-upload`), and the same `production-spa` lease.
- **Role.** `ChecksOpsGitHubProductionSpaFallback` (`ops/deployment-guard/production-spa-fallback/`)
  is trusted only for this workflow file on `refs/heads/main` in the `production` environment.

Tests: `aws/tests/github-production-spa-fallback.test.mjs` (run with
`node --experimental-strip-types --test`), `aws/tests/marketing-static-head.test.mjs`.

## One-time setup (owner)

1. Create the role from `ops/deployment-guard/production-spa-fallback/` (its README has the
   commands).
2. In the GitHub `production` environment, add the variable
   `CHECKSOPS_PRODUCTION_SPA_FALLBACK_ROLE_ARN` =
   `arn:aws:iam::806168576068:role/ChecksOpsGitHubProductionSpaFallback`.
   `CHECKSOPS_PRODUCTION_DEPLOYMENT_GUARD_KMS_KEY_ARN` is already set.

## Each change

1. Run the workflow from `main` with `mode: inspect`. Expect `BASELINE` before the first publish,
   with no page problems and a green staging probe. Note the snapshot SHA-256 and the run URL. Any
   `BLOCKED` problem stops here: report it. If LIVE is neither file (for example the code was
   uploaded with CRLF line endings), the inspect says `live_code_unknown`: stop and report the
   LIVE SHA-256; do not edit the baseline file to match it without the owner.
2. Run it with:
   - `mode: publish`;
   - `approved_commit` = the current `main` SHA;
   - `expected_snapshot_sha256` = the value from step 1;
   - `staging_acceptance_reference` = the green inspect run URL from step 1;
   - `approval_phrase` = `PUBLISH SPA FALLBACK TO PRODUCTION`.

   The production environment reviewer (the owner) approves the job.
3. The run stops before any write if `main` moved, the phrase or the reference is missing or
   wrong, or the function, the distribution or a page object changed since the inspect
   (`DEPLOYMENT_COLLISION`). After the write, the run checks the following, and fails if any
   check fails:
   - it re-reads the snapshot and expects `CURRENT` with every page object present as HTML, the
     distribution config unchanged;
   - on `https://checksops.com` (up to 20 attempts, 30 s apart, for edge propagation): each
     marketing path is 200 `text/html` with its own `og:title`; `/` and `/login` still serve
     `index.html` (the home `og:title`); the entry bundle referenced by `/` loads;
     `/prep/health` answers 200 `ok`.
4. Open each marketing page and share-preview it (LinkedIn Post Inspector, Slack). Sign in and use
   a deep link (for example a check page) to confirm the SPA still routes.
5. Record the run (run id, snapshot before and after, code SHA-256s) in this file with a record PR.

**Revert.** Run inspect, then the same inputs with `mode: revert` and the phrase
`REVERT SPA FALLBACK ON PRODUCTION`. `staging_acceptance_reference` is still required: cite the
publish run being reverted. The public check then expects every marketing path to serve
`index.html` (the home `og:title`).

**Adding a marketing page.** Add it to `MARKETING_PAGES`, to the allowlist in
`aws/cloudfront/spa-fallback.js`, to `MARKETING_PATHS` in the writer, to the role's S3 keys and to
both inline session policies (the tests fail until all agree). The owner re-runs `put-role-policy`.
`spa-fallback.js` then differs from LIVE: inspect reports `BLOCKED` (`live_code_unknown`) until the
baseline question is settled. The baseline file stays the pre-tool code; a change that needs a new
revert target is its own reviewed PR.

## Not done

- No AWS call of any kind was made for this change. The role does not exist yet; the GitHub
  variable is not set.
- That LIVE runs exactly the baseline bytes (`0cf83919…`) is taken from the repository (the file
  the Step 1 script uploaded); the first inspect confirms or refutes it.
- Fact noted 2026-11-06: the production CSP headers role `ChecksOpsGitHubProductionCspHeaders`
  (`ops/deployment-guard/production-csp-headers/`) does not exist in account `806168576068`, so
  `guarded-production-csp-headers.yml` cannot run yet either. Not addressed here.

## Run log

None yet.
