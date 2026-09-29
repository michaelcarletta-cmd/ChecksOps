# E14A — Production Admin Tools check image re-upload

Recorded 2026-09-22T22:26Z. This is **not** cancellation of E14. CheckAlt flags were closed so the image workflow could be repaired. Reopen only after the operator replaces the real photos and E14 is re-preflighted.

## Execution window closed

Effective `checksops-production-prep-api` env (re-read after close and after the upload fix):

| Flag | Value |
| --- | --- |
| `AWS_PROVIDER_EXECUTION_ENABLED` | `false` |
| `AWS_CHECKALT_ENABLED` | `false` |
| `AWS_FINANCIAL_PERMISSIONS_ACTIVATED` | `false` |
| `AWS_PROVIDER_WEBHOOK_DRY_RUN` | `true` |
| `AWS_CHECKALT_STATUS_RECONCILE_ENABLED` | `false` |
| `AWS_MOOV_ENABLED` | `false` |
| `AWS_STORAGE_WRITES_ENABLED` | `true` |

CodeSha still `xt/R8za4uuGndEDN0g82S4wIhR+eBO0sO/RR92u5P/E=` (E13 overlay + eligibility-select). No Lambda code change in E14A.

## Failing request

Admin Tools `ReuploadCheckImageButton` → `POST /prep/storage/upload-url` → browser `PUT` to a 60s presigned S3 URL.

Traced as Freedom admin `mcarletta@freedomadj.com` (Cognito sub `a45884b8…`, app user `7dbb3009…`, production issuer `us-east-1_h00WorYMT`):

1. `POST /storage/upload-url` for `claim-files` / `checks/reupload/a3a4a153-46e1-4c28-a273-79a9bd04f3a6/{side}-{ts}.jpg` → **HTTP 200**, identity mapped, path allowlisted.
2. Browser-equivalent `PUT` with `content-type: image/jpeg` to `checksops-production-privatefiles-806168576068.s3.us-east-1.amazonaws.com/files/claim-files/checks/reupload/…` → **HTTP 403**.

Exact S3 body:

```
AccessDenied
User: arn:aws:sts::806168576068:assumed-role/checksops-production-api-execution/checksops-production-prep-api
is not authorized to perform: s3:PutObject
on arn:aws:s3:::checksops-production-privatefiles-806168576068/files/claim-files/checks/reupload/…
because no identity-based policy allows the s3:PutObject action
```

SPA toast title is `Upload failed` (`upload_failed` from the non-OK PUT).

Not the failure:

- View Check Images (`/storage/sign` + GET) — still 200 for the existing front JPEG, endorsed SVG back, and original rear JPEG.
- Tenant/check RLS for the Freedom admin — upload-url authorized.
- `claims@freedomadj.com` 403 `rls_denied` — that identity is `mortgage_agent` with no Freedom membership; not the operator path.
- CORS — `OPTIONS`/`PUT` already allow `content-type` from `https://checksops.com`.
- E14 eligibility `front_image_path` SELECT — independent of this uploader.
- `AWS_STORAGE_WRITES_ENABLED` — already `true`.

Root cause: E7 production bucket policy granted the prep API role **Get/List only**. The role template’s `PutObject` identity grant defaults to the **staging** privatefiles bucket. Same-account implicit deny on production `PutObject`.

## Fix / deploy

Live `PutBucketPolicy` on `checksops-production-privatefiles-806168576068` added Sid `E14AAllowPrepApiObjectWrite`:

- Principal: `checksops-production-api-execution`
- Actions: `s3:PutObject`, `s3:DeleteObject`, `s3:DeleteObjectVersion`, `s3:AbortMultipartUpload`
- Resource: `arn:aws:s3:::checksops-production-privatefiles-806168576068/*`

Kept `DenyStagingApiRole` and `E7AllowPrepApiReadSign`. Recorded in `aws/production/privatefiles-bucket-policy.json`. Role template now documents that live `FilesBucketName` must be the production bucket. IAM `GetRole`/`PutRolePolicy` remains denied to this agent, so the identity policy was not rewritten; the bucket policy is the live grant.

No Lambda redeploy. No check row mutation. No manual object copy of operator photos.

## Upload acceptance (same production API the SPA uses)

Freedom-admin probe JPEGs (317-byte placeholders, **not** operator retakes; deleted after):

| Step | Front | Back |
| --- | --- | --- |
| `/storage/upload-url` | 200 | 200 |
| S3 `PUT` + Origin `https://checksops.com` | 200 | 200 |
| CORS preflight | 200 `PUT` / `content-type` | same |
| `HeadObject` | 317 / `image/jpeg` | 317 / `image/jpeg` |
| `/storage/delete` | 200 | 200 |
| `HeadObject` after delete | missing | missing |

View Check Images on the **authoritative existing** paths still GET 200 (front 4,529,502 JPEG; back 4,641,698 SVG; original rear 3,463,826 JPEG).

Selected check **unchanged**:

- `a3a4a153-46e1-4c28-a273-79a9bd04f3a6` / `#0121319295` / `$1,546.72` / Freedom
- `approved_for_deposit` / `ready_for_deposit`
- original front / endorsed back / original rear pointers unchanged
- `back_image_deposit_path` still null
- `checkalt_deposits` for this check: **0**
- historical CheckAlt rows still 69 / 453990.48 / last_updated `2026-09-04T15:58:10.843Z`
- no duplicate `#0121319295`
- money flags remain closed; no FinCapture / Moov / ACH / RTP / wire

Dummy probes were **not** written onto `check_intake_items`. Original image paths use `checks/shared/…` and cannot be restored through the write allowlist (`asImagePath` requires a check-scoped prefix). Replacing them with 1×1 JPEGs would have been destructive.

## Operator action required

The uploader is ready. Sign in to production Admin Tools as the Freedom admin and **Replace Front** then **Replace Back** with the real retakes. The UI will:

1. `POST /storage/upload-url` → `PUT` to `checks/reupload/{checkId}/{side}-{ts}.ext`
2. Front: set `front_image_path`
3. Back: atomically set `back_image_path` + `back_image_original_path` and clear `back_image_deposit_path` / `endorsement_render_status=idle` / `endorsement_render_meta`
4. Invalidate check image queries so View Check Images signs the new paths

Then re-preflight E14 before reopening CheckAlt flags. Do not submit CheckAlt from this window.
