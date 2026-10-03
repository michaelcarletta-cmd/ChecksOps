# M6.4 — Resume existing Moov recipient onboarding

**STOP FOR REVIEW.** Do not send a verification deposit. Do not submit an MV
code. Do not enable money flags. Do not create a replacement stakeholder,
recipient, Moov account, or bank. Do not touch sandbox `runvs626@gmail.com`.

Existing target (unchanged):

- stakeholder `724952c9-eb56-4c52-b28e-06907198c406`
- recipient `62a858ff-ee6a-49d7-9898-1c8e4a44227b`
- Moov account `ee8c608e-dc2d-45d3-95e9-3c992f3dfc5f`
- bank Chase last4 `1506`
- email `carlettacrew@gmail.com`

## What this pass proved

The current production pay-setup token is still valid. Live db-bridge
`recipient_session_resolve` returns that recipient, the same Moov account,
environment `production`, unused token, expiry `2026-10-10T17:37:32.008Z`.
Token sha12 `9acf164e4c0a`. RDS still has `secure_token` null for this row
(`updated_at` `2026-09-02T15:05:36.784Z`); live Supabase is the source of
truth.

A fresh resend was **not** required. Rotating the token would not have fixed
the AWS 404.

The AWS 404 was a field-name mismatch: live Lambda posted
`{ action: "recipient_session_resolve", token }` while live db-bridge reads
`body.secure_token`. Dummy 64-hex and the real token both 404ed. After patching
`production-recipient-token.mjs` on live `checksops-production-prep-api` to send
`secure_token` (and `token` as a compatibility alias), the same existing token
resolves:

- `POST /prep/public/moov-recipient-session` HTTP 200
- recipient `62a858ff…227b`
- Moov `ee8c608e…fc5f`
- environment `production`
- Chase last4 `1506`, bank status `new`, `bank_linked` true
- live KYC `unverified`
- remaining identity requirements: `individual.address`, `individual.birthdate`,
  `individual.ssn`
- ToS not accepted; `tos_requirement_outstanding` true
- `liveProviderCalled` true, `productionRead` true, `mutated` false,
  `token_consumed` false
- dummy token still 404 `This link is not valid.`

Live SPA still calls Lovable Edge `moov-recipient-session`. That path still
returns HTTP 502 `moov_account_get_failed` for the same valid token (M6.2M
unchanged). Opening `/pay-setup/:token` in the browser therefore still cannot
load the KYC form. This pass did not invent SSN/DOB/address and did not
submit KYC or ToS.

`Send verification deposit` is gated in the SPA behind KYC + ToS. It is **not**
on screen yet. Live Moov `bank_should_initiate` is already true for the existing
Chase `1506` (`status=new`). Do not click it when it appears.

## Holds kept

- `AWS_MOOV_ENABLED=false`
- `AWS_PROVIDER_EXECUTION_ENABLED=false`
- `AWS_FINANCIAL_PERMISSIONS_ACTIVATED=false`
- `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED=false`
- `AWS_CHECKALT_ENABLED=false`
- `AWS_PROVIDER_LIVE_READS_ENABLED=true`
- `AWS_PROVIDER_WEBHOOK_DRY_RUN=true`
- live `auth-cognito.mjs` SHA `d3c8178fd5fa9709da055e0fbed3ec41dc2243d8f4a729479257a6decb0cd199` unchanged
- rehearsal oneshot restored to `Uuqs/fRkCulPrdKUj72FJTlHdTkfhVXc+mttZljUzwk=`
- sandbox recipient `3269bd10…2562` / `runvs626@gmail.com` not touched
- SQL72 not applied
- no webhook register, no transfer, no micro-deposit, no MV code

Live Lambda code SHA after the one-file patch:
`BIAPo9QUBVFeeM0s0Uwsbomulbxijvr7RbNraBPhXqE=`
(`LastModified` `2026-09-11T20:08:55Z`). Previous SHA
`l9nHBQHn+cwwroKO9+czOXi2WMjoeChOpgVFtR0Tj7A=`.

## Return card

```
CURRENT LINK VALID: YES
RESENT REQUIRED: NO
TARGET TOKEN ROTATED: NO
TARGET EMAIL SENT: NO
CORRECT RECIPIENT: YES (62a858ff-ee6a-49d7-9898-1c8e4a44227b)
CORRECT MOOV ACCOUNT: YES (ee8c608e-dc2d-45d3-95e9-3c992f3dfc5f)
DUPLICATES CREATED: NO
KYC SUBMITTED: NO
LIVE KYC STATUS: unverified
REMAINING KYC REQUIREMENTS: individual.address, individual.birthdate, individual.ssn
TOS COMPLETED: NO
LIVE TOS ACCEPTED: NO
EXISTING BANK: YES (JPMORGAN CHASE BANK, NA last4 1506)
LIVE BANK STATUS: new (unverified; bank_should_initiate true)
SEND VERIFICATION DEPOSIT AVAILABLE: NO (SPA gates it behind KYC + ToS)
MICRO-DEPOSIT INITIATED: NO
MV CODE SUBMITTED: NO
MONEY FLAGS: all false
PROVIDER MONEY CALLS: NO
MONEY MOVED: NO
SAFE TO BEGIN BANK VERIFICATION: NO
GO/NO-GO: NO-GO
```

## Next (not this pass)

1. Keep this same pay-setup token. Do not resend.
2. Live SPA still uses Edge; Edge production Moov GET still 502. Either
   fingerprint/fix Edge `MOOV_*` against AWS app `694a303b…3878`, or cut the
   SPA session load to `/prep/public/moov-recipient-session` **and** give KYC /
   ToS a production write path that is not Edge. Do not flip money flags to do
   that.
3. Human KYC still requires real PII for this existing individual account.
   Do not invent SSN/DOB/address.
4. After KYC + legitimate Moov ToS Drop, stop when **Send verification deposit**
   is visible. Do not click it.

STOP FOR REVIEW.
