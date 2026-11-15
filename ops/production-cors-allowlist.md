# Production HTTP API CORS allow-list

Workflow: `.github/workflows/guarded-production-cors.yml` (production environment, role
`ChecksOpsGitHubProductionLambdaOverlay`). Preflight: `scripts/deployment-guard/github-production-cors.mjs`.
Writer (the only thing that writes): `scripts/deployment-guard/production-cors-update.mjs`.

The one permitted change on HTTP API `kiqojucc02` (since 2026-11-15):

```
AllowOrigins: ["https://checksops.com", "https://www.checksops.com"]
          ->  ["https://checksops.com", "https://www.checksops.com", "capacitor://localhost", "https://localhost"]
```

The owner made the iOS/Android app (`com.checksops.app`) the production app on 2026-11-15
("Option A"; Codemagic `ios-production` / `android-production`, PR #1927). The app is the website
bundled by Capacitor, served from `capacitor://localhost` (iOS) and `https://localhost` (Android),
and calls `https://checksops.com/prep` cross-origin, so the API must allow those two origins.
Read-only preflights on 2026-11-15 through CloudFront: both app origins get 204 with no
`Access-Control-Allow-Origin`. The previous permitted change (`"*"` -> the two site origins) was
applied 2026-10-21 (record below); its result is this change's baseline. `aws/production/api-cfn.yaml`
and `aws/production/api-template.yaml` carry the same four origins, so a later stack update keeps them.

**What the app origins allow.** A page at one of these origins can read API responses in a browser.
Every data route still needs a signed-in user's Cognito token (and the origin-verify authorizer
through CloudFront); CORS is not what protects the API. `https://localhost` could also be a page on
someone's own machine; it would still need a user's token.

Headers, methods and `MaxAge` stay as they are. Routes, the origin-verify authorizer, the stage,
CloudFront, the WAF and the Lambda are read and pinned, never written.

## Who is affected

The website calls the API same-origin through CloudFront (`/prep` on checksops.com and
www.checksops.com), so CORS does not apply to it. The documented rollback URL (raw execute-api,
called from checksops.com) is covered by the allow-list. Server-to-server callers (webhooks) do
not use CORS. Direct execute-api calls are already refused by the origin-verify authorizer unless
they come through CloudFront. Staging keeps `*` (its own API `psr19uhop4`).

## IAM prerequisite (owner)

The role needs `apigateway:GET` on `/apis/kiqojucc02`, its routes and authorizers,
`apigateway:PATCH` on `/apis/kiqojucc02`, and `cloudfront:GetDistribution` on `E1B0ZWWO5559U5`
(checked in: `aws/production-lambda-overlay/policies/permissions-policy.json`). Until the live role
policy carries them, inspect fails with `AccessDeniedException` and nothing changes.

## Steps (each needs owner approval)

For the 2026-11-15 app change: staging acceptance is a green `cors-staging-live-probe.yml` run
(staging allows any origin, and the owner's check upload from the staging app worked on
2026-11-09); the approval phrase is exactly `ALLOW THE APP ON PRODUCTION API`; verify and smoke
also require `capacitor://localhost` and `https://localhost` to be allowed and an untrusted origin
not. The 2026-10-21 steps below used the phrase `TIGHTEN PRODUCTION CORS`, which apply no longer
accepts.

1. **Staging acceptance**: a green run of `cors-staging-live-probe.yml` (read-only probes of the
   staging API: the staging origin is allowed, an untrusted origin is not privileged, health ok).
2. **Production inspect** (`mode: inspect`): `READY` when the live API holds the `*` baseline and
   the pinned shape; the run summary shows the snapshot SHA-256.
3. **Production apply** (`mode: apply`) with `approved_commit` = main, `expected_snapshot_sha256`
   from the inspect, `staging_acceptance_reference` = the probe run URL and `approval_phrase`
   exactly `TIGHTEN PRODUCTION CORS`. The production environment reviewer approves the job. The
   job takes the `production-http-api` lease, issues a KMS-signed receipt whose preflight
   fingerprint is the whole snapshot, re-reads before and immediately before `UpdateApi`, writes
   only the CORS configuration, and requires the post-write snapshot to differ only in
   `AllowOrigins`. Then it verifies and smokes: `checksops.com` and `www.checksops.com` preflights
   are allowed, an untrusted origin gets no `Access-Control-Allow-Origin`, and
   `https://checksops.com/prep/health` is ok.

## Rollback

The writer never restores. Reverting to `*` would be a reviewed change with its own writer; the
allow-list is the state the repository's CORS tests already require.

## Applied (2026-10-21)

| | |
|---|---|
| Staging acceptance | [`cors-staging-live-probe.yml` run 39600331863](https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/39600331863): staging origin allowed, protected probe 401 without auth, health 200 |
| Production inspect | [run 39601929209](https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/39601929209), main `c18e7b0c1`: `READY`, snapshot `5c7e907382ee58f6abab59bd41e8d58099ff29a3041a193a9b19de08c7fef0e4` |
| Production apply | [run 39602211635](https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/39602211635), main `c18e7b0c1`, owner's words `TIGHTEN PRODUCTION CORS` |
| Change | `AllowOrigins` `["*"]` → `["https://checksops.com", "https://www.checksops.com"]`; snapshot `5c7e9073…` → `9dffd25a5442455640710ba1603dcab8e152dc0137085b4f1804d2fac192bd25`; only `AllowOrigins` differs |
| Verify and smoke | `VERIFIED`; preflight from `checksops.com` and `www.checksops.com` answered with their own origin, an untrusted origin got no `Access-Control-Allow-Origin`, `https://checksops.com/prep/health` 200 |

The IAM statements the role needed were applied the same day and read back; every other
statement in the role policy is unchanged. A later inspect reports `ALREADY_ACCEPTED`.
