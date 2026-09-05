# ACM for checksops.com / www.checksops.com (DNS not changed)

**STOP. Do not create Cloudflare records from the agent.** Copy the `ResourceRecord` CNAME name/value below into an operator change window. This is DNS validation for TLS only. It is **not** an apex/`www` cutover.

## Certificate (already requested)

| Field | Value |
|---|---|
| ARN | `arn:aws:acm:us-east-1:806168576068:certificate/5cdde8e7-49fb-4b42-ba36-9aaa9d9b1aa3` |
| Region | `us-east-1` (required for CloudFront) |
| Status (2026-09-05 20:23 UTC) | **`ISSUED`** (both names `SUCCESS`). Not attached to CloudFront (`InUseBy` empty). |
| Domains | `checksops.com`, `www.checksops.com` |
| Method | DNS |
| In use by | none (`InUseBy` empty) |
| Transparency logging | ENABLED |

Do **not** request a second certificate. Idempotent check: `aws acm list-certificates` already shows this ARN for `checksops.com`.

## Exact DNS validation CNAME records (operator only)

These values came from `aws acm describe-certificate` on 2026-09-05. Re-describe before applying if ACM rotates the record.

| Domain | Validation status | Type | Name (host) | Value (target) |
|---|---|---|---|---|
| `checksops.com` | SUCCESS (cert ISSUED) | CNAME | `_424da145c81cf0e7659ae4a2559d8f82.checksops.com.` | `_6e2cf5fd041966fbe6c8925823deca17.jkddzztszm.acm-validations.aws.` |
| `www.checksops.com` | SUCCESS (cert ISSUED) | CNAME | `_4ed6942e58099ae2ecedf7cf0da89c69.www.checksops.com.` | `_94d94bddd98b0b11148e9581801530c8.jkddzztszm.acm-validations.aws.` |

Cloudflare notes (operator):

- Proxy status **DNS only** (grey cloud). ACM cannot validate an orange-clouded CNAME.
- Do **not** change apex or `www` A records. They must remain `185.158.133.1` (Lovable) until a cutover decision.
- These hosts are unique ACM hashes, not `checksops.com` / `www`.

Operator added both CNAMEs as Cloudflare **DNS-only** (grey cloud) on 2026-09-05. Public `dig` matches the ACM targets. Apex/`www` A still `185.158.133.1`. Certificate became **`ISSUED`** at 2026-09-05T20:23:49Z. Valid through 2027-03-21. Still not in use by any CloudFront distribution.

## After ISSUED (still not cutover)

1. Confirm `Status=ISSUED`.
2. Do **not** add CloudFront aliases for apex/`www` until a human cutover decision.
3. Production-prep distribution `E1B0ZWWO5559U5` currently uses the CloudFront default certificate and has **Aliases quantity 0**.

Request command (already executed; do not repeat unless the cert is deleted):

```bash
aws acm request-certificate \
  --region us-east-1 \
  --domain-name checksops.com \
  --subject-alternative-names www.checksops.com \
  --validation-method DNS \
  --options CertificateTransparencyLoggingPreference=ENABLED \
  --tags Key=Environment,Value=production-prep Key=DoNotCutover,Value=true
```
