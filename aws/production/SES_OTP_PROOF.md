# SES EMAIL_OTP proof (prep only)

**STOP FOR REVIEW.** This does **not** switch production auth, import the eight production users, change DNS A records, or send OTP until you approve a later isolated test user.

Goal: move SES deliverability from **OPERATOR ACTION REQUIRED** → **READY** by proving pool `us-east-1_h00WorYMT` can deliver **one** EMAIL_OTP via SES identity `support@checksops.com`.

This Cloud Agent **cannot** `ses:GetAccount` / `ses:GetEmailIdentity`. Sandbox vs production sending must be read in the console (**6A**). A Cognito test user is **not** created in this step (**6B** is explained only).

## Already verified (do not redo)

| Check | Live |
|---|---|
| Production pool email | `EmailSendingAccount=DEVELOPER`, `SourceArn=…/identity/Support@checksops.com` |
| Production users | **0** |
| Staging pool email | still `COGNITO_DEFAULT` |
| Apex/`www` A | `185.158.133.1` (Lovable) |
| Public SPF | Outlook only (`include:spf.protection.outlook.com ~all`) — no `amazonses.com` |
| `_amazonses` TXT | absent |

The SES mailbox simulator **cannot** prove EMAIL_OTP: you never receive the code.

## 6A — Read SES sandbox vs production (console only)

Region must be **N. Virginia (us-east-1)**. Cognito is in that region. Do **not** Request production access in this step. Do **not** change identities, DNS, or Cognito.

1. Open https://us-east-1.console.aws.amazon.com/ses/home?region=us-east-1#/account
2. Confirm the top-right region is **N. Virginia**.
3. **Account dashboard** (left nav).
4. Read sending status:
   - **Sandbox:** a yellow/info banner such as “Your Amazon SES account is in the sandbox”, and/or **Production access** = disabled / Get set up still offered.
   - **Production:** no sandbox banner; **Production access** enabled. You can send to unverified recipients (From identity must still be verified).
5. Left nav → **Verified identities** (or **Identities**).
6. Open `support@checksops.com` (casing may show `Support@`).
7. Confirm **Identity status** = **Verified** and sending from this identity is allowed.
8. Stop. Do **not** click Request production access, do **not** send a test email from the SES console yet, do **not** create Cognito users.

Reply with exactly:

- Region: `us-east-1`
- Account: **sandbox** or **production access**
- Identity `support@checksops.com`: **Verified** or not
- Whether you already see a production-access request pending

## What a later isolated Cognito test user would do (6B — not authorized yet)

Do **not** run this until 6A is reported and you explicitly approve 6B. This agent will not `AdminCreateUser` / `InitiateAuth` on its own.

**Purpose:** trigger **one** EMAIL_OTP from pool `us-east-1_h00WorYMT` through SES. Not a production login. Not an identity import. Not a SPA switch.

**Mailbox rules**

- Use a throwaway operator inbox you control (for example a plus-address on your own domain).
- **Forbidden:** the eight production mapped emails; staging UAT users; any customer mailbox.
- **If 6A = sandbox:** SES will only deliver to **verified SES identities**. Either:
  - verify that operator mailbox in SES us-east-1 first (email confirmation; no apex/`www` A change), **or**
  - request SES production access (separate operator decision; not 6A), **or**
  - send the OTP to `support@checksops.com` only if that mailbox is already the verified identity **and** you can read it.
- **If 6A = production access:** the operator mailbox does not need to be an SES identity.

**Exact Cognito actions (when you later approve)**

1. `AdminCreateUser` on **`us-east-1_h00WorYMT` only** (`MessageAction=SUPPRESS` so Cognito does **not** send an invitation).
2. Username/email = the isolated test address. No `identity_map` row. No production client env change.
3. Public `InitiateAuth` `USER_AUTH` with preferred challenge `EMAIL_OTP` on client `3ja9fqaq2fjkv3i6up2varcqpe`. **This sends the OTP** via SES From the configured identity (`support@checksops.com` / `Support@`).
4. You report: arrived (inbox or spam), From address, and that Cognito did not error. You do **not** need to submit the code to production SPA (there is no production Cognito login).
5. `AdminDeleteUser` for that one test user. Pool must return to **0** users.

**Side effects to expect**

- One transactional email through SES.
- Brief Cognito user in `FORCE_CHANGE_PASSWORD` / unconfirmed until deleted.
- Possible spam-folder placement while SPF is Outlook-only. Finding the message in spam still counts as SES delivery for this gate. Changing SPF/DKIM is optional and must **not** move apex/`www` A.

**Will not happen**

- Import of the eight production users
- Staging pool `us-east-1_vPmQ7cL1F` edits
- `.env.production` Cognito switch
- Webhooks, flags, grants, DB, storage, bridges

READY for this gate requires: 6A production access **or** sandbox + verified recipient, plus a successful 6B OTP in the operator mailbox, then the test user deleted.
