# External penetration test, November 2026 (AvalonX PT-47865)

Report: "Penetration Test Report", client checksops.com, document reference PT-47865, assessment and
report date 2026-11-24, black-box, unauthenticated, external. Overall rating Medium: 0 critical,
0 high, 2 medium, 2 low, 6 informational. The owner brought it on 2026-11-25: "Had a pen test
performed and this was the results. Overall good nothing critical but we need to fix some areas".

This file records what was done about each finding and what the owner decided. It changes nothing
by itself.

## Findings and what happened

| ID | Severity | Finding | Outcome |
|---|---|---|---|
| F-01 | Medium | The API health endpoint told an anonymous caller the service name, environment, database name and whether the database secret is configured | Fixed. #2074; staging rebuild run 45628951828, production rebuild run 45633410707 (`ops/deployment-guard/lambda-rebuild-plan.json`, tenth sections). Read afterwards on both: `{"status":"ok"}` only |
| F-04 | Medium | SPF for checksops.com ended in `~all` (soft fail) | Fixed by the owner in DNS, 2026-11-25: `-all`. See "Email" below |
| F-02 | Low | No Content-Security-Policy on the production site | Fixed. Enforce run 45648762313, recorded by #2080 (`ops/deployment-guard/PRODUCTION_CSP_HEADERS.md`) |
| F-03 | Low | The API sent none of `x-content-type-options`, `strict-transport-security`, `x-frame-options` | Fixed with F-01 (same rebuilds) |
| F-09 | Informational | The retired `/auth/login` named the sign-in methods | Fixed with F-01: 410 `gone`, no method named |
| F-06, F-07, F-10 | Informational | `claims.checksops.com` ("One CRM", a Lovable project on Supabase): deployment id in a header, two extra Cloudflare ports, Supabase URL and anon key in the bundle | The owner, 2026-11-25: "that claims.checksops.com should not be a part of ChecksOps". The owner deleted its five DNS records (A `claims`, TXT `_lovable.claims`, MX and TXT `send.claims`, TXT `resend._domainkey.claims`) and reported "done" |
| F-05 | Informational | The staging site and staging API are reachable from the internet | Accepted. See "Staging stays public" below |
| F-08 | Informational | The API answers `Access-Control-Allow-Origin: *` (no credentials) | No change. The report asks for none: "revisit before serving authenticated data from these routes" |

The report names the staging API for F-01, F-03 and F-09. The same responses were read on production
(`https://checksops.com/prep/health`, `/prep/auth/login`) on 2026-11-25 before the fix, so the fix
went to both.

## Staging stays public (F-05, accepted)

Owner, 2026-11-25: "Leave staging open and write it into the security notes".

What is public: `https://staging.checksops.com` (CloudFront `E1CG52WRQZI7X1`, no web ACL) and the
staging API on its API Gateway address. The tester reached the sign-in page and the public API
routes, and reported no authentication bypass and no protected data.

Why it is accepted:
- The finding is informational; nothing was reached without an account.
- Every guarded staging deploy ends with a check from GitHub's runners against the public staging
  site and API (the SPA upload's public verify, the rebuild's `/health`, `/db-health` and
  `/db-readonly-validate` smoke). An IP allow-list would block them.
- The payment, check-processing and email sandboxes call the staging API from their own servers.
- The staging API is an API Gateway HTTP API, which takes no web ACL directly: restricting it means
  putting it behind CloudFront, as production is. That is a project, not a setting.

The rule that goes with the decision: **staging holds no real customer data.** Staging email is in
`sink` mode to `staging-sink@checksops.invalid` with an allowlist (`AWS_EMAIL_MODE`,
`AWS_EMAIL_ALLOWLIST_*` on `checksops-staging-api`, read 2026-11-25). The contents of the staging
database were not inspected for this record.

Revisit if: staging is ever loaded with production data; a later test reaches data or bypasses
sign-in on staging; or the staging API moves behind CloudFront for another reason, which makes a web
ACL cheap.

## Email (F-04 and what followed)

Done by the owner in Cloudflare DNS and the SES console on 2026-11-25:
- SPF on checksops.com: `v=spf1 include:spf.protection.outlook.com -all`.
- A custom MAIL FROM domain, `mail.checksops.com`, on the SES identities `checksops.com` and
  `Support@checksops.com` (MX `feedback-smtp.us-east-1.amazonses.com`, TXT
  `v=spf1 include:amazonses.com -all`); SES reports `MailFromDomainStatus` `SUCCESS`, fallback
  `USE_DEFAULT_VALUE`.
- One `_dmarc` TXT record. Two extra `_dmarc` records, added the same day on the operator's
  instruction without knowing one already existed, made receivers read no policy (`dmarc=none`,
  `compauth=fail reason=601` in a message header); the owner deleted them and reported the Outlook
  "unverified sender" label gone.

Senders as `@checksops.com`, per the owner ("just Outlook, maybe resend, and the app"): Microsoft 365;
the application through SES (DKIM signing enabled, verified); Resend for endorsement requests
(`notify@checksops.com`; the owner reports the domain "verified in resend").

DMARC, later the same day. The one `_dmarc` record had been written when the domain was connected
to Lovable and sent its aggregate reports there: `rua=mailto:dmarcreports@lovable.dev`. The owner
changed it in two edits:
- `p=none` to `p=quarantine` (the record as the owner pasted it:
  `v=DMARC1; p=quarantine; pct=100; rua=mailto:dmarcreports@lovable.dev`);
- the `rua` address to a mailbox at checksops.com ("Changed the address"; the new value was not seen
  by the operator).

The owner's tests with `p=quarantine` in place, all to Gmail: the application's sign-in code arrived
("I got the email to sign in"), the Microsoft 365 message arrived, and the endorsement request
arrived in spam. Gmail showed SPF, DKIM and DMARC as PASS on it, on a mailbox that had not received
one before as well, with Resend click tracking off for that send. So the spam placement is not an
authentication failure; the cause was not established. SES sent nothing between 13:21 and 16:17 UTC
(CloudWatch `AWS/SES` `Send`), which is why an earlier "no code arrived" was a code never requested.

Open:
- `p=reject` is the last DMARC step, after a period at `quarantine` with nothing legitimate junked.
- Endorsement requests (Resend, `notify@checksops.com`) landing in Gmail spam.
- The public DNS records were not readable from the operator's environment; the SPF and DMARC values
  above are as the owner reported and showed them.

## Not done, and why

- Other API responses still carry `service` and `environment` in the body (the 410 on `/auth/login`
  included). Not in the report's findings; removing them is a wider change.
- The "One CRM" Lovable project and its Supabase database still exist at their own addresses. They
  are not part of ChecksOps. Whether Row Level Security covers every table reachable with its anon
  key (the substance of F-10) was not examined.
- No re-test by the tester has been run against the fixes.
