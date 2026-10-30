# Branding logo route: response headers (2026-10-29)

Closes the security audit follow-up "logo-route security headers" (audit of 2026-10-29) as
covered. Owner decision of 2026-10-29: "go with option 1" (close as covered; CSP stays deferred).
Nothing was deployed for this note.

## Route

`GET /prep/branding/logo/<tenant-uuid>` (and `/prep/branding/logo?tenantId=`), served by
`handleBrandingLogo` in `aws/functions/api/storage.mjs` through `aws/functions/api/index.mjs`.

## What protects it

1. **Served types (security audit finding 2, live since production overlay run 40910519696).**
   The route serves a stored logo only as `image/png`, `image/jpeg`, `image/webp` or `image/gif`, and
   only when the object's bytes carry that type's file signature (`servableBrandingLogoType`).
   Anything else, `image/svg+xml` above all, answers 404 `logo_type_not_served`. Stored bytes are
   never relabelled.
2. **Lambda headers** (`index.mjs`): `content-type` (the verified raster type),
   `cache-control: public, max-age=3600`, `access-control-allow-origin: *`.
3. **CloudFront headers (SH-1).** Read-only `GetDistributionConfig` and `GetResponseHeadersPolicy`
   on 2026-10-29: distribution `E1B0ZWWO5559U5` (ETag `E1VC38T7YXB528`) attaches response headers
   policy `756a8f23-68dd-4f8a-8293-5a2fd08f919a` (`checksops-production-browser-security-headers`,
   ETag `E23ZP02F085DFQ`) to the default behavior, `/prep` and `/prep/*`, the same fingerprint as
   `SH1_ACCEPTED_PRODUCTION_BASELINE.md`. Every logo response therefore carries
   `X-Content-Type-Options: nosniff`, `Strict-Transport-Security` (one year, subdomains),
   `X-Frame-Options: SAMEORIGIN` and `Referrer-Policy: strict-origin-when-cross-origin`.

With only signature-checked raster types served and `nosniff` set, a stored logo cannot be
interpreted as HTML or script on the app origin.

## Not done, and why

A `Content-Security-Policy` (for example `default-src 'none'; sandbox`) on the logo response would be
defense in depth only. It stays deferred, as in the SH-1 policy ("CSP intentionally deferred"):

- In code it needs `index.mjs`, which the production overlay plan never overlays; it would ship only
  with a full API package rebuild, which today would also carry other workstreams' unreleased
  changes.
- In CloudFront it needs a new response headers policy and a `/prep/branding/logo/*` behavior: a
  production CloudFront mutation with no guarded tooling in this repository.

Revisit with the next full API rebuild or the next reviewed CloudFront change.

## Not verified

The headers were read from the CloudFront configuration, not from a live response: this workstream's
session could not reach checksops.com. A `curl -sI https://checksops.com/prep/branding/logo/<tenant>`
from an allowed network shows them.

This note is evidence of the state on 2026-10-29, not restore authority. Before any later change,
read production again.
