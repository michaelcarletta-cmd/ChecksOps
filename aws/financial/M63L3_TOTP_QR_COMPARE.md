# M6.3L.3 — Old working TOTP QR vs new financial QR

No production mutation. No secrets or full otpauth URIs printed.
Synthetic RFC 6238 / generated Base32 keys only.

## Return card

```
OLD WORKING FORMAT: otpauth://totp/ChecksOps:<urlencoded-email>
                     ?secret=…&issuer=ChecksOps&digits=6&period=30
NEW FINANCIAL FORMAT: otpauth://totp/ChecksOps%20Financial:<urlencoded-email>
                     ?secret=…&issuer=ChecksOps%20Financial&digits=6&period=30
STRUCTURAL DIFFERENCES: issuer string only (space → %20 in path and query)
QR LIBRARY DIFFERENCE: none (same qrcode, 176px, margin 1, ECC M)
SECRET FORMAT DIFFERENCE: Cognito SecretCode (typically shorter Base32) vs
                     app 32-char Base32 from 20 bytes. Same alphabet. Not
                     required to explain Apple opening-but-not-saving: a
                     32-char secret in the OLD issuer format has no %20.
LABEL DIFFERENCE: none (both encodeURIComponent(email))
ISSUER DIFFERENCE: ChecksOps → ChecksOps Financial (%20)
QUERY PARAMETER DIFFERENCE: none (order secret, issuer, digits, period;
                     algorithm omitted both)
LIKELY REGRESSION: percent-encoded space in issuer
                     (ChecksOps%20Financial) in the otpauth path/query
SMALLEST FIX: set otpauth issuer to ChecksOps-Financial (no whitespace).
                     Keep English UI “ChecksOps Financial authenticator”.
REQUIRES NEW MICHAEL ENROLLMENT: YES after that issuer patch (current
                     unverified QR already has the spaced issuer). Not now.
SAFE TO PATCH: YES after review. Do not deploy until approved.
GO/NO-GO: GO for a no-space issuer patch after review.
          NO-GO for production deploy / regenerate-now.

STOP FOR REVIEW.
```

## What Apple actually scanned

The working flow (e63c4fb1, the QR Michael used successfully) did **not** use
a Cognito-native otpauth URI. `AssociateSoftwareToken` returned `SecretCode`;
**our** builder wrapped it:

```
encodeURIComponent('ChecksOps')  →  ChecksOps   (no %20)
```

The new flow uses the same template with:

```
encodeURIComponent('ChecksOps Financial')  →  ChecksOps%20Financial
```

Frontend `resolveTotpOtpauthUri` returns the server `otpauth_uri` unchanged
when it starts with `otpauth://`. Same `qrcode` settings as the working
enrollment. Apple therefore scanned a URI that differs from the working one
almost only in the issuer token.

## Synthetic comparison (no production secrets)

`aws/tests/totp-otpauth-apple-compat.test.mjs` — 2/2 pass.

| | Old (working) | New (financial) | Proposed |
| --- | --- | --- | --- |
| scheme | `otpauth://totp/` | same | same |
| path issuer | `ChecksOps` | `ChecksOps%20Financial` | `ChecksOps-Financial` |
| `%20` in issuer | no | **yes** | no |
| email label | urlencoded email | same | same |
| query keys | secret, issuer, digits, period | same | same |
| algorithm= | omitted (SHA1 default) | omitted | omitted |
| QR library | qrcode ECC M 176px | same | same |

A 32-character synthetic secret in the **old** issuer format still has no
`%20`. Secret length is therefore not the Apple-breaking change.

## Smallest fix (not applied)

1. `FINANCIAL_TOTP_ISSUER = 'ChecksOps-Financial'` in
   `aws/functions/api/financial-totp.mjs` (and totpQr fallback for consistency).
2. Overlay/redeploy Lambda `financial-totp.mjs` only (QR payload is the server
   URI). Optional SPA rebuild so fallback ISSUER matches.
3. Michael clicks Set up **once** (overwrites unverified row) and scans with
   the same Apple flow that worked for `ChecksOps`.

Do not change Cognito. Do not delete the software token. Do not enable money.
English Security-page copy can stay “ChecksOps Financial authenticator”.
