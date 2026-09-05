# ACM for checksops.com / www.checksops.com (DNS not changed)

Request (idempotent if a matching cert already exists):

```bash
aws acm request-certificate \
  --region us-east-1 \
  --domain-name checksops.com \
  --subject-alternative-names www.checksops.com \
  --validation-method DNS \
  --options CertificateTransparencyLoggingPreference=ENABLED \
  --tags Key=Environment,Value=production-prep Key=DoNotCutover,Value=true
```

**STOP.** Do not create Cloudflare records from the agent. Copy the `ResourceRecord` CNAME name/value from `aws acm describe-certificate` into an operator change window.

Until those CNAMEs exist, `Status=PENDING_VALIDATION`. Production CloudFront in `prep-stack.yaml` has **no** aliases, so Lovable apex/www stay authoritative even after this cert is requested.

Requested 2026-09-05 (do not add these records from this agent):

| Domain | Status | CNAME name | CNAME value |
|---|---|---|---|
| checksops.com | PENDING_VALIDATION | `_424da145c81cf0e7659ae4a2559d8f82.checksops.com.` | `_6e2cf5fd041966fbe6c8925823deca17.jkddzztszm.acm-validations.aws.` |
| www.checksops.com | PENDING_VALIDATION | `_4ed6942e58099ae2ecedf7cf0da89c69.www.checksops.com.` | `_94d94bddd98b0b11148e9581801530c8.jkddzztszm.acm-validations.aws.` |

Certificate ARN: `arn:aws:acm:us-east-1:806168576068:certificate/5cdde8e7-49fb-4b42-ba36-9aaa9d9b1aa3`  
Not in use by any CloudFront distribution. Apex/`www` A records remain `185.158.133.1`.
