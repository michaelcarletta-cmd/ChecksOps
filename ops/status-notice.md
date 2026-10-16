# Static status notice (`/status.json`)

The site banner (`PlatformAnnouncementBanner`) shows database announcements and,
merged by id, the notices in the static `/status.json` object. The static file is
read by everyone, including signed-out visitors on the login page, and still works
when the API is down. A missing, non-200, non-JSON or malformed file means "no notice".

`status.json` is **not** in `public/`: the guarded SPA upload sends every `dist` file
and would overwrite it. Only `.github/workflows/spa-status-notice.yml` writes it.

## Post or clear a notice

Run **SPA status notice** from `main` (Actions → SPA status notice → Run workflow):

- `environment`: `staging` or `production` (the GitHub environment gates the run)
- `action`: `post`, or `clear` (writes `{"announcements": []}`)
- `title` (≤120), `message` (≤2000), `severity` (`info` | `maintenance` | `critical`)
- optional `starts_at` / `ends_at` (ISO 8601 with offset, `ends_at` after `starts_at`),
  optional `refresh_instructions` (≤500)
- production only: `confirmation` = `POST STATUS NOTICE TO PRODUCTION`

`scripts/status-notice.mjs` validates the inputs (same limits as the
`platform-announcements` API) and builds the file before any AWS credentials exist.
The job then runs `aws s3 cp` for `status.json` only (`--cache-control "max-age=30"`,
`--content-type application/json`), invalidates `/status.json` only, and checks the
public site serves the new bytes. It never syncs, deletes or touches other objects.

Critical notices cannot be dismissed. Text is shown as plain text only.

## IAM permissions needed

The workflow reuses the existing SPA roles and narrows each session with an inline
policy. The role's own policy must allow at least:

| Environment | Role | Permissions |
| --- | --- | --- |
| staging | `ChecksOpsGitHubStagingSpaUpload` (`vars.CHECKSOPS_STAGING_SPA_DEPLOY_ROLE_ARN`) | `s3:PutObject` on `arn:aws:s3:::checksops-staging-frontend-c48b/status.json`; `cloudfront:CreateInvalidation` on `arn:aws:cloudfront::806168576068:distribution/E1CG52WRQZI7X1` |
| production | `ChecksOpsProductionSpaDeploy` | `s3:PutObject` on `arn:aws:s3:::checksops-production-frontend-806168576068/status.json`; `cloudfront:CreateInvalidation` on `arn:aws:cloudfront::806168576068:distribution/E1B0ZWWO5559U5` |

The staging role's checked-in policy (`aws/staging-spa-upload/policies/permissions-policy.json`)
already grants `s3:PutObject` on `checksops-staging-frontend-c48b/*` and the invalidation.
The production role's policy is not in the repository; if a run fails with AccessDenied,
add exactly the two permissions above to that role in a reviewed IAM change. Both role
trust policies already accept the `staging` / `production` GitHub environments.
If the bucket uses SSE-KMS with a customer key, the role also needs `kms:GenerateDataKey`
on that key (the SPA upload would need it too).
