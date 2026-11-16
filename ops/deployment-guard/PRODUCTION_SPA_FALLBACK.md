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

When this tool was written it was source only: nothing had been run against production. The first
publish (run 42281453509, 2026-11-06) put the marketing pass-through LIVE.

## www.checksops.com redirect (2026-11-16)

Owner 2026-11-16, after a Condition One sign-in report: "build the www redirect". Passkeys are
bound to `checksops.com` (the API refuses passkey sign-in from any other origin, and the page hides
the passkey button there), so `www.checksops.com` showed only the emailed code. The current version
answers `www.checksops.com` with a `301` to the same path and query on `https://checksops.com`
(`cache-control: max-age=3600`, so a browser does not keep a stale redirect after a rollback). `/prep`
and `/prep/*` on `www` are passed through unchanged: a redirected POST would lose its body, and an
open tab on `www` keeps working. Every other host (`checksops.com`, anything else) is unchanged.

Read-only before this change (2026-11-16, GetFunction): LIVE and DEVELOPMENT both run
`9ca318b0e59f9b5a00f914cac0a4658c4e728e9ca9c09dd1be253397620c1d47` (ETags `E1F83G8C2ARO7P`,
`E3UN6WX5RRO2AG`), byte-for-byte the `spa-fallback.js` on main before this change. That code becomes
the baseline (the revert target); the pre-tool code `0cf839198b024b943b2834e6de414e2d0deea59d88c23373886561575f9269a1`
stays in git history (commit 2ba5c6fc1) and is no longer a target of this tool.

## The two versions

| file | what it does | SHA-256 |
|---|---|---|
| `aws/cloudfront/spa-fallback.baseline.js` | byte-for-byte the code LIVE before the www redirect: `/prep` and `/prep/*` unchanged, the marketing allowlist unchanged, a last segment with a dot unchanged, everything else `/index.html`; any host | `9ca318b0e59f9b5a00f914cac0a4658c4e728e9ca9c09dd1be253397620c1d47` |
| `aws/cloudfront/spa-fallback.js` | the same, plus `www.checksops.com` (not `/prep`) answered with a 301 to the same path and query on `https://checksops.com` | `node scripts/deployment-guard/github-production-spa-fallback.mjs` prints it as `current_code_sha256`; derive it with `sha256sum aws/cloudfront/spa-fallback.js` on an LF checkout |

The allowlist is `/pricing`, `/vs/checksops-vs-iink-payments`, `/vs/checksops-vs-snapsheet`,
`/vs/checksops-vs-guidewire-claimcenter`, `/claim-check-tracking`. `/` still goes to `/index.html`
(DefaultRootObject and the function agree), and so does `/pricing/` (exact match only).
`aws/tests/github-production-spa-fallback.test.mjs` keeps the allowlist, the writer's
`MARKETING_PATHS`, the role's S3 keys and `MARKETING_PAGES` plus `RETIRED_MARKETING_PATHS` equal,
and runs both files in `node:vm`.

`/pricing` is retired (owner, 2026-11-09: no public pricing). It stays in the allowlist on purpose:
the build writes the `pricing` key as a copy of the home page (home head, canonical `/`), the
guarded upload (put-only, never deletes) overwrites the old prerendered pricing object with it, and
the SPA routes `/pricing` to `/`. Dropping it from the allowlist would change
`aws/cloudfront/spa-fallback.js` away from LIVE and needs its own publish; it is not required to
take the prices down.

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
  2. `test-function` on DEVELOPMENT for every request in `SAMPLE_REQUESTS`: on `checksops.com`
     every marketing path, `/`, `/login`, `/pricing/`, `/assets/index-x.js` and `/prep/health`; on
     `www.checksops.com` `/`, `/login`, `/c1/checks?tab=funds&probe`, `/pricing`,
     `/assets/index-x.js` and `/prep/health`. Each result must be the outcome the rules give (the URI
     passed on, or `301 <location>`; `expectedOutcome` in the writer, written from the rules, not
     from the code). A failure stops here with LIVE unchanged;
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
     `/prep/health` answers 200 `ok`;
   - on `https://www.checksops.com`: after publish `/` and `/login` answer 301 to the same path and
     query on `https://checksops.com`; after revert they serve `index.html`; `/prep/health` answers
     200 `ok` both ways (never redirected).
4. Open each marketing page and share-preview it (LinkedIn Post Inspector, Slack). Sign in and use
   a deep link (for example a check page) to confirm the SPA still routes.
5. Record the run (run id, snapshot before and after, code SHA-256s) in this file with a record PR.

**Revert.** Run inspect, then the same inputs with `mode: revert` and the phrase
`REVERT SPA FALLBACK ON PRODUCTION`. `staging_acceptance_reference` is still required: cite the
publish run being reverted. The public check then expects `www.checksops.com` to serve
`index.html` again; the marketing pages keep their own objects (the baseline passes them through).

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

- 2026-11-06, runs 42281266136 (inspect) and 42281453509 (publish): the marketing pass-through
  (`9ca318b0…`) went LIVE. Confirmed read-only on 2026-11-16 (GetFunction LIVE and DEVELOPMENT).
- 2026-11-16, www redirect (#1938, merged as `496ee40f3`), under the owner's words "PUBLISH SPA
  FALLBACK TO PRODUCTION":
  - inspect run 43886112430 (main `496ee40f3`): `BASELINE`, problems and page problems none; LIVE and
    DEVELOPMENT `9ca318b0…`; snapshot `8bfd10b42d5d222a0ecd28b68cb5c75338a542b94faa9b37a3045b166a9a4e87`;
    distribution ETag `E2EUQ1WTGCTBG2`, function ETags LIVE `E1F83G8C2ARO7P`, DEVELOPMENT
    `E3UN6WX5RRO2AG`; staging probe green;
  - publish run 43886410155 (approved commit `496ee40f3`, expected snapshot `8bfd10b4…`, staging
    acceptance the inspect run): the writer tested all 16 sample requests on DEVELOPMENT (every
    `checksops.com` sample unchanged; `www` `/`, `/login`, `/c1/checks?tab=funds&probe`, `/pricing`,
    `/assets/index-x.js` answered `301` to the same path and query on `https://checksops.com`;
    `www` `/prep/health` passed through), then published `ff421c457d265495440259ab7630ffc297db286ea44d3f77e7ae98f1dbee27c1`;
    after: `CURRENT`, snapshot `deb213a2fae706896af706914747eec953edd495c56c42c7fa3e5eef3de07f88`,
    LIVE and DEVELOPMENT `ff421c45…`, LIVE function ETag `E1PA6795UKMFR9`, distribution config
    unchanged (the writer's byte comparison), distribution ETag now `E3AEGXETSR30VB`;
  - verify `VERIFIED`; public production check green on attempt 1: the marketing pages with their
    own `og:title`, `/` and `/login` `index.html`, the entry bundle, `/prep/health` 200 `ok`;
    `www` `/` and `/login` 301 to `https://checksops.com/…?probe=…`; `www` `/prep/health` 200 `ok`
    (not redirected).
  - Not verified: nobody has opened `www.checksops.com` in a browser since the publish.
