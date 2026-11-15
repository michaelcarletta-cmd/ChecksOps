# Production files bucket: allow uploads and downloads from the iOS and Android apps

**What breaks without this.** The owner chose on 2026-11-15 to make the app (`com.checksops.app`) a
production app ("Option A"; Codemagic `ios-production` / `android-production`, PR #1927). The app
is the website bundled by Capacitor, served from `capacitor://localhost` on iOS and
`https://localhost` on Android. A check photo upload is two requests (`src/integrations/aws/storage.ts`):
`/storage/upload-url` to the API, then a presigned `PUT` straight to the bucket; downloads read the
presigned `GET` with `fetch`. The browser asks the bucket first (CORS preflight). The production
bucket `checksops-production-privatefiles-806168576068` allows only `https://checksops.com` and
`https://www.checksops.com`, so from the app the preflight is refused. Read-only preflights on
2026-11-15 (`OPTIONS`, `PUT`, `content-type`): `https://checksops.com` 200; `capacitor://localhost`
and `https://localhost` 403. This is the same fix staging got on 2026-11-09
(`ops/staging-files-bucket-cors.md`).

**Why a one-time owner change.** No guarded workflow manages bucket CORS, and the production deploy
role may not read or change it (`ops/production-files-bucket-cors.md`). Same path as the
2026-11-04 production change and the 2026-11-09 staging change.

**What the extra origins allow.** A request carrying one of these origins can `PUT` or `GET` an
object only with a presigned URL, which the production API issues to a signed-in user for one
object and a few minutes. CORS is not what protects the files; the presigned URL is. Adding
`https://localhost` means a page served on someone's own machine at that address, holding a valid
presigned URL, could use it; it could not obtain one.

## The change

`ops/production-files-bucket-cors/before-2026-11-15.json` is the live configuration read on
2026-11-15 (`GetBucketCors` as `user/claude-code`); it equals the recorded
`ops/production-files-bucket-cors/after.json` of 2026-11-04, so nothing changed it since.
`ops/production-files-bucket-cors/after-app-origins.json` is the same configuration with one
difference: both rules' `AllowedOrigins` add `capacitor://localhost` and `https://localhost`. The
methods (GET/HEAD and PUT), allowed headers, exposed headers and max ages are unchanged.
`aws/tests/production-files-bucket-cors-app.test.mjs` proves that is the only difference.

No Lambda, IAM, bucket policy, encryption, lifecycle, SQL or staging change. `aws/template.yaml`
is unchanged: its production `SpaPresignedUploads` rule already differs from the live production
bucket (one rule vs two), as recorded for the 2026-11-04 change, and no production stack update
writes this bucket's CORS.

The app also needs the production API to allow its origins (the HTTP API CORS allow-list,
`ops/production-cors-allowlist.md`). That is a separate guarded step; neither change needs the
other to be safe.

## Steps (the owner, as `michael-admin`, from an LF checkout of main after this PR merges)

On the Windows desktop, run each command inside WSL (`wsl -d Ubuntu -- bash -ic 'cd /home/carle/ChecksOps && ...'`).

1. Confirm the live configuration is still the recorded before state. Stop if `diff` prints anything.

   ```bash
   B=checksops-production-privatefiles-806168576068
   aws s3api get-bucket-cors --bucket "$B" --output json > /tmp/cors-live.json
   diff <(python3 -m json.tool --sort-keys /tmp/cors-live.json) \
        <(python3 -m json.tool --sort-keys ops/production-files-bucket-cors/before-2026-11-15.json) \
     && echo "LIVE MATCHES BEFORE"
   ```

2. Apply the after state (S3 replaces the whole CORS configuration with this file).

   ```bash
   aws s3api put-bucket-cors --bucket "$B" \
     --cors-configuration file://ops/production-files-bucket-cors/after-app-origins.json
   ```

3. Confirm the live configuration is now the after state.

   ```bash
   aws s3api get-bucket-cors --bucket "$B" --output json > /tmp/cors-live.json
   diff <(python3 -m json.tool --sort-keys /tmp/cors-live.json) \
        <(python3 -m json.tool --sort-keys ops/production-files-bucket-cors/after-app-origins.json) \
     && echo "LIVE MATCHES AFTER"
   ```

4. Tell Claude it is done. A read-only check re-reads the bucket CORS, the PutBucketCors
   CloudTrail event and the preflights, and a record PR adds the result here.

5. Test upload once the production app build is installed and the API allow-list includes the app:
   photograph a check and upload it; the check image shows. Then upload on checksops.com in a
   browser, to confirm the website still uploads.

**Rollback.** Run step 2 with `before-2026-11-15.json`. That brings back the refused app uploads;
the website is unaffected either way.
