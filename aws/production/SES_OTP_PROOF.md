# SES EMAIL_OTP proof (prep only)

**STOP FOR REVIEW.** This does **not** switch production auth, import the eight production users, or change DNS A records. A Cognito test user is **not** created in this step. 6A is operator-complete (your report). **6B is not authorized yet.** No OTP has been sent.

Goal: move SES deliverability from **OPERATOR ACTION REQUIRED** → **READY** by proving pool `us-east-1_h00WorYMT` can deliver **one** EMAIL_OTP via SES From `support@checksops.com`.

## Live re-check 2026-09-06 (this agent)

| Check | Result |
|---|---|
| Production pool email | `EmailSendingAccount=DEVELOPER`, `SourceArn=arn:aws:ses:us-east-1:806168576068:identity/Support@checksops.com` |
| Production users | **0** |
| Staging pool email | still `COGNITO_DEFAULT` |
| Apex/`www` A | `185.158.133.1` (Lovable) — **unchanged** |
| Agent SES APIs | still **Denied** (`ses:GetAccount`, `GetEmailIdentity` on `checksops.com` and `support@checksops.com`) |
| Public SPF (recursive DNS) | still `v=spf1 include:spf.protection.outlook.com ~all` — no `include:amazonses.com` |
| `_amazonses` TXT | still empty from this resolver |
| Selector1/2 `_domainkey` CNAME | empty from this resolver |

**Operator-reported (this agent cannot re-read SES):** production access granted in us-east-1; domain `checksops.com` verified with DKIM; From remains `support@checksops.com`.

The SES mailbox simulator **cannot** prove EMAIL_OTP.

## 6A — **done** (operator report)

SES us-east-1 **production access granted**. Identity/domain verified per operator. Do not import users. Do not switch SPA.

## 6B — isolated EMAIL_OTP (STOP — needs your mailbox + explicit go)

A temporary Cognito user **is required**. SES console “send test email” does not exercise Cognito EMAIL_OTP.

**This agent will not create the user or send OTP until you reply with:**

1. The isolated test address (you control the inbox).
2. Confirmation it is **not** one of the eight production mapped emails, not a staging UAT user, and not a customer.
3. The exact phrase: **approve 6B**.

### What will happen (once approved)

Pool **`us-east-1_h00WorYMT` only**. Client `3ja9fqaq2fjkv3i6up2varcqpe`. Staging pool **untouched**.

1. `AdminCreateUser` with `MessageAction=SUPPRESS` and `email_verified=true` — **no invitation email**.
2. `InitiateAuth` `USER_AUTH` with `PREFERRED_CHALLENGE=EMAIL_OTP` — **this sends the one OTP** via SES From `support@checksops.com` / identity `Support@`.
3. You check inbox **and spam**. Reply: arrived yes/no, From address, Cognito error if any. **Do not** enter the code on production SPA (auth is still Supabase).
4. `AdminDeleteUser` for that username.
5. This agent re-checks `list-users` is **[]**.

Example CLI (placeholders only — not executed):

```bash
aws cognito-idp admin-create-user \
  --user-pool-id us-east-1_h00WorYMT \
  --username 'TEST_EMAIL' \
  --user-attributes Name=email,Value='TEST_EMAIL' Name=email_verified,Value=true \
  --message-action SUPPRESS \
  --desired-delivery-mediums EMAIL

aws cognito-idp initiate-auth \
  --client-id 3ja9fqaq2fjkv3i6up2varcqpe \
  --auth-flow USER_AUTH \
  --auth-parameters USERNAME='TEST_EMAIL',PREFERRED_CHALLENGE=EMAIL_OTP

aws cognito-idp admin-delete-user \
  --user-pool-id us-east-1_h00WorYMT \
  --username 'TEST_EMAIL'
```

### Cleanup if anything fails

- Delete the test user if it exists (`AdminDeleteUser`).
- Confirm pool user count is 0.
- Do **not** leave a FORCE_CHANGE_PASSWORD user in the production pool.
- Do **not** create `identity_map` rows.

### Side effects

- One transactional SES message.
- Possible spam-folder placement: public SPF is still Outlook-only from this resolver. Spam still counts as **delivered** for this gate.
- Optional later (not 6B): add `include:amazonses.com` to SPF **without** changing apex/`www` A.

### Will not happen

- Import of the eight production users
- `.env.production` Cognito switch
- Staging pool edits
- Webhooks, flags, grants, DB, storage, bridges, DNS A records

READY for **this SES gate** = successful 6B OTP + test user deleted + pool still 0 users.
