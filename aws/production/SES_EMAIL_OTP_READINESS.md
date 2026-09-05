# SES readiness for production Cognito EMAIL_OTP

**Validate only.** This pass did not create SES identities, DKIM records, or Cognito `EmailSendingAccount=DEVELOPER`. Those attach SES to production auth and require DNS.

## Required for production EMAIL_OTP (not Cognito default)

Cognito production EMAIL_OTP at DNS cut should use:

1. SES account **out of sandbox** (production bounce/complaint handling).
2. Verified identity for the From address (domain `checksops.com` preferred, or a mailbox such as `noreply@checksops.com`).
3. Cognito pool `us-east-1_h00WorYMT` `EmailConfiguration.EmailSendingAccount=DEVELOPER` plus `SourceArn` of that SES identity.
4. Cognito IAM to call SES on the pool's service-linked role (console toggle usually attaches this).

Staging currently uses `COGNITO_DEFAULT` as well. That is acceptable for UAT intercept mail. It is **not** production-ready (Cognito default daily cap, `amazoncognito.com` From, no custom From).

## Live evidence 2026-09-05

| Probe | Result |
|---|---|
| Production pool email | `EmailSendingAccount=COGNITO_DEFAULT` (no SourceArn / From) |
| Agent SES APIs | **Denied** (`ses:ListIdentities`, `GetEmailIdentity`, `GetAccount`, `GetIdentityVerificationAttributes`, `GetIdentityDkimAttributes`) |
| Public DNS `checksops.com` TXT | Microsoft 365 (`MS=ms75666337`) + `v=spf1 include:spf.protection.outlook.com ~all` — **no** `include:amazonses.com` |
| `_amazonses.checksops.com` TXT | **absent** |
| SES DKIM CNAMEs (`amazonses` / `selector1` / `selector2` `._domainkey`) | **absent** |
| MX | `checksops-com.mail.protection.outlook.com` |
| `_dmarc.checksops.com` | `p=none` to `dmarcreports@lovable.dev` |
| Staging Lambda `AWS_EMAIL_MODE` | `sink` (Class A mailer, not Cognito OTP) |

Verdict: **PARTIAL / not ready** for production Cognito EMAIL_OTP via SES. Public DNS shows Microsoft 365, not Amazon SES. Agent cannot confirm sandbox vs production sending because `ses:GetAccount` is denied.

## Operator next steps (not this agent)

Do **not** add SES DKIM/SPF from the Cloud Agent. After a human SES identity exists:

1. Verify domain `checksops.com` (or mailbox) in SES us-east-1.
2. Publish SES DNS (DKIM CNAMEs, `_amazonses` TXT, SPF include) in a change window that still leaves apex/`www` A on Lovable.
3. Confirm SES production access (out of sandbox) or a documented exception.
4. On pool `us-east-1_h00WorYMT` only, set Email sending = SES / `DEVELOPER` with From such as `ChecksOps <noreply@checksops.com>`. Never run that against `us-east-1_vPmQ7cL1F`.
5. Send a test OTP to an allowlisted operator mailbox **without** importing production users.

IAM fragment the operator can attach to a dedicated SES-ops role (not required on `ChecksOpsCursorCloudStaging`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadSesForEmailOtpPrep",
      "Effect": "Allow",
      "Action": [
        "ses:GetAccount",
        "ses:GetEmailIdentity",
        "ses:ListEmailIdentities",
        "ses:GetIdentityVerificationAttributes",
        "ses:GetIdentityDkimAttributes"
      ],
      "Resource": "*"
    }
  ]
}
```

Do not grant `ses:SendEmail` on the Cloud Agent staging role merely to complete this checklist.
