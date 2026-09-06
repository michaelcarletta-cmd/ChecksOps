# SES readiness for production Cognito EMAIL_OTP

Cognito production pool email is now **Amazon SES / `DEVELOPER`**. This pass does not send OTP, import users, or change staging.

## Required for production EMAIL_OTP (not Cognito default)

Cognito production EMAIL_OTP at DNS cut should use:

1. SES account **out of sandbox** (production bounce/complaint handling).
2. Verified identity for the From address (mailbox `support@checksops.com` is in use).
3. Cognito pool `us-east-1_h00WorYMT` `EmailConfiguration.EmailSendingAccount=DEVELOPER` plus `SourceArn` of that SES identity.
4. Cognito IAM to call SES on the pool's service-linked role (console toggle usually attaches this).

Staging uses `COGNITO_DEFAULT`. That is acceptable for UAT intercept mail. Leave it.

## Live evidence 2026-09-05 (re-verified after operator SES attach)

| Probe | Result |
|---|---|
| Production pool `us-east-1_h00WorYMT` email | **`EmailSendingAccount=DEVELOPER`**, `SourceArn=arn:aws:ses:us-east-1:806168576068:identity/Support@checksops.com`. API field `From` is unset (console “Send email from Amazon SES using support@checksops.com” maps to this identity). |
| Production users | **0** (`list-users` empty; `EstimatedNumberOfUsers=0`) |
| Staging pool `us-east-1_vPmQ7cL1F` email | still `COGNITO_DEFAULT` (~13 users). **Unchanged.** |
| Agent SES APIs | **Denied** (`ses:GetEmailIdentity`, `ses:GetIdentityVerificationAttributes`, `sesv2:GetAccount`) |
| Public DNS `checksops.com` TXT | Microsoft 365 (`MS=ms75666337`) + `v=spf1 include:spf.protection.outlook.com ~all` — **no** `include:amazonses.com` |
| `_amazonses.checksops.com` TXT | **absent** |
| SES DKIM CNAMEs | **absent** |
| MX | `checksops-com.mail.protection.outlook.com` |
| Production DNS A | apex + `www` still `185.158.133.1` (Lovable) |

Verdict: **Cognito SES attach is done** on the production pool only. SES sandbox vs production sending is still **unknown** to this agent (`ses:GetAccount` denied). Public SPF is still Outlook-only, so first real OTP deliverability should be tested later with a single allowlisted mailbox (**not** this step; no users, no OTP now).

Do **not** add SES DKIM/SPF from the Cloud Agent. Apex/`www` A records must stay Lovable.

## Operator follow-ups (deliverability proof — not cutover)

See `aws/production/SES_OTP_PROOF.md`. **Next action is 6A only** (read SES Account dashboard in us-east-1). Do not create Cognito users until you approve 6B.

After Step 4–5 prep, a later cutover window can:

1. Confirm SES production access (out of sandbox) in the SES console (**6A**).
2. Optionally publish SES DNS (DKIM / `_amazonses` / SPF `include:amazonses.com`) without moving apex/`www` A.
3. Send one test OTP to an allowlisted operator mailbox **without** importing production users (**6B**, after explicit approval).

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
