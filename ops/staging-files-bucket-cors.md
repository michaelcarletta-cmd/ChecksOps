# Staging files bucket: allow uploads from the iOS and Android apps

**What breaks today.** In the ChecksOps iOS app (staging build), taking a photo of a check works,
then the upload fails. Reported by the owner on 2026-11-04. The app is the staging website bundled by
Capacitor (`mobile/`, michaelcarletta-cmd/ChecksOps#1585), served from `capacitor://localhost` on
iOS and `https://localhost` on Android. An upload is two requests
(`src/integrations/aws/storage.ts`): `/storage/upload-url` to the staging API, which allows any
origin, then a presigned `PUT` straight to the bucket. The browser asks the bucket first (CORS
preflight) whether the app's origin may send it. The staging bucket
`checksops-staging-privatefilesbucket-erzqsolpucjp` allows only `https://staging.checksops.com`, so
the preflight is refused and the file is never sent. Presigned downloads read with `fetch` (the same
file) hit the same rule.

**Why a one-time owner change.** No guarded workflow manages bucket CORS. This follows the
production files bucket change of 2026-11-04 (`ops/production-files-bucket-cors.md`) and the staging
change of 2026-10-19. The live configuration was last set by CloudTrail `PutBucketCors` from
`michael-admin` at 2026-10-19T15:03:07Z, request id `XWYGYYKV144HN4S1`.

**What the extra origins allow.** A request carrying one of these origins can send a `PUT` or `GET`
to the bucket only with a presigned URL, which the staging API issues to a signed-in user for one
object and a few minutes. CORS is not what protects the files; the presigned URL is. Adding
`https://localhost` means a page served on someone's own machine at that address, holding a valid
presigned URL, could use it; it could not obtain one. Production is unchanged and still allows only
`https://checksops.com` and `https://www.checksops.com`.

## The change

`ops/staging-files-bucket-cors/before-2026-11-04.json` is the live configuration read on 2026-11-04
(`GetBucketCors` as `claude-code`, written as returned). `ops/staging-files-bucket-cors/after.json` is
the same configuration with one difference: the rule's `AllowedOrigins` becomes
`https://staging.checksops.com`, `capacitor://localhost`, `https://localhost`. The methods (`PUT`,
`GET`), allowed headers, exposed headers and max age are unchanged.
`aws/template.yaml` `SpaPresignedUploads` gets the same staging origins, so a later stack deploy keeps
them; its production origins are unchanged. `aws/tests/staging-files-bucket-cors.test.mjs` proves
both.

No Lambda, IAM, bucket policy, encryption, lifecycle, SQL or production change.

## Steps (the owner, as `michael-admin`, from an LF checkout of main after this PR merges)

On the Windows desktop, run each command inside WSL (`wsl -d Ubuntu -- bash -ic 'cd /home/carle/ChecksOps && ...'`).

1. Confirm the live configuration is still the recorded before state. Stop if `diff` prints anything.

   ```bash
   B=checksops-staging-privatefilesbucket-erzqsolpucjp
   aws s3api get-bucket-cors --bucket "$B" --output json > /tmp/cors-live.json
   diff <(python3 -m json.tool --sort-keys /tmp/cors-live.json) \
        <(python3 -m json.tool --sort-keys ops/staging-files-bucket-cors/before-2026-11-04.json) \
     && echo "LIVE MATCHES BEFORE"
   ```

2. Apply the after state (S3 replaces the whole CORS configuration with this file).

   ```bash
   aws s3api put-bucket-cors --bucket "$B" \
     --cors-configuration file://ops/staging-files-bucket-cors/after.json
   ```

3. Confirm the live configuration is now the after state.

   ```bash
   aws s3api get-bucket-cors --bucket "$B" --output json > /tmp/cors-live.json
   diff <(python3 -m json.tool --sort-keys /tmp/cors-live.json) \
        <(python3 -m json.tool --sort-keys ops/staging-files-bucket-cors/after.json) \
     && echo "LIVE MATCHES AFTER"
   ```

4. Tell Claude it is done. A read-only check re-reads the bucket CORS and the PutBucketCors
   CloudTrail event, and a record PR adds the result here.

5. Test upload: in the iOS app (staging build), photograph a check and upload it. The upload
   finishes and the check image shows. Then do the same on staging.checksops.com in a browser, to
   confirm the website still uploads.

**Rollback.** Run step 2 with `before-2026-11-04.json`. That brings back the refused app uploads; the
website is unaffected either way.
