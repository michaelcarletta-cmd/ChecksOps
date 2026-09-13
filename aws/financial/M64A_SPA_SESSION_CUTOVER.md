# M6.4A — Cut live pay-setup SPA to AWS session route

**STOP FOR REVIEW.** Dummy token only. Do not open the real recipient link in this
pass. Do not click KYC, ToS, bank, or Send verification deposit.

## Source

`origin/main` did **not** have an AWS session loader. Live `/pay-setup/:token`
still called Lovable `functions.invoke("moov-recipient-session")` from
`RecipientPaymentSetup-C9fH1ZRX.js` (`index-cU7wOTrI.js`).

This pass adds `src/lib/recipientSessionApi.ts` and changes **only**
`load()` in `src/pages/RecipientPaymentSetup.tsx`. On `checksops.com` that
posts `{ token }` to:

`POST ${origin}/prep/public/moov-recipient-session`

KYC / ToS / bank-add / bank-verify remain `supabase.functions.invoke(...)`.

Build: `vite build` (production `.env.production`, Supabase login unchanged).
Not `--mode aws` (that would switch the whole SPA to Cognito). VitePWA
`dist/sw.js` / `registerSW.js` were **not** uploaded. Live `/sw.js` remains the
M6.3D kill-switch (685 bytes, unregisters Workbox).

## Deploy

| Item | Value |
|---|---|
| Bucket | `checksops-production-frontend-806168576068` |
| Sync | `dist/assets` + cleaned `index.html`; **no** `--delete` |
| Previous HTML | `/assets/index-cU7wOTrI.js` (backed up) |
| Live HTML | `/assets/index-Dn3PuAvp.js` |
| Pay-setup chunk | `/assets/RecipientPaymentSetup-BupFt-C0.js` |
| Invalidation | `I8AOJSK4LFG9KY4PPS6MP44Y2L` `/*` on `E1B0ZWWO5559U5` |
| Lambda | unchanged `BIAPo9QUBVFeeM0s0Uwsbomulbxijvr7RbNraBPhXqE=` |
| Money flags | all execution flags **false** |

## Dummy proof (real token not opened)

Dummy URL: `/pay-setup/` + 64 letter `a`s.

Browser loaded `index-Dn3PuAvp.js` + `RecipientPaymentSetup-BupFt-C0.js`.
Network: `POST /prep/public/moov-recipient-session` HTTP 404
`This link is not valid.` Filter `supabase` matched **0** requests.
Service workers for `checksops.com`: none.

## Return card

```
SPA SOURCE: production vite build of this branch (AWS session loader added; main lacked it)
SPA DEPLOYED: YES
LIVE BUNDLE: /assets/index-Dn3PuAvp.js + RecipientPaymentSetup-BupFt-C0.js
CLOUDFRONT INVALIDATION: I8AOJSK4LFG9KY4PPS6MP44Y2L /*
LIVE SESSION TARGET: POST https://checksops.com/prep/public/moov-recipient-session
LOVABLE SESSION CALLED: NO (dummy page; 0 supabase.co/functions/v1/moov-recipient-session requests)
SERVICE WORKER: kill-switch /sw.js unchanged; no Workbox registered on dummy page
DUMMY TEST: PASS (404 This link is not valid; AWS POST only)
TOKEN/RECIPIENT MUTATIONS: NO
PROVIDER MUTATIONS: NO
MONEY MOVED: NO
SAFE FOR MICHAEL TO OPEN SAME REAL LINK: YES (session read only; do not click KYC/ToS/bank/verify)
GO/NO-GO: GO for Michael to open the existing real link for a session read
```

STOP FOR REVIEW.
