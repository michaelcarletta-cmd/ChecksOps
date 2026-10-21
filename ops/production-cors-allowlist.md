# Production HTTP API CORS allow-list

Workflow: `.github/workflows/guarded-production-cors.yml` (production environment, role
`ChecksOpsGitHubProductionLambdaOverlay`). Preflight: `scripts/deployment-guard/github-production-cors.mjs`.
Writer (the only thing that writes): `scripts/deployment-guard/production-cors-update.mjs`.

The one permitted change on HTTP API `kiqojucc02`:

```
AllowOrigins: ["*"]  ->  ["https://checksops.com", "https://www.checksops.com"]
```

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
