# M6.3L.2 — Diagnose production financial TOTP QR

Read-only. Enrollment was **not** mutated. Secret, otpauth URI, and QR payload
were **not** printed or decrypted.

## Return card (2026-09-11T13:21Z row)

```
UNVERIFIED ENROLLMENT EXISTS: YES
SCHEME: otpauth://totp/
ISSUER: ChecksOps Financial
LABEL FORMAT: ChecksOps%20Financial:<urlencoded-email>
              decoded ChecksOps Financial:mcarletta@[redacted]
ISSUER MATCH: YES (path issuer === query issuer, both ChecksOps%20Financial)
ALGORITHM: SHA1 (omitted from URI; RFC 6238 / Google Authenticator default)
DIGITS: 6
PERIOD: 30
BASE32 VALID: YES (generator emits [A-Z2-7]{32} from 20 random bytes; stored
              ciphertext length matches a 32-char UTF-8 secret + GCM tag)
URI ENCODING VALID: YES
QR EXACT: YES (frontend uses server otpauth_uri unchanged)
FRONTEND TRANSFORMATION: none
GOOGLE AUTHENTICATOR COMPATIBLE: YES
MICROSOFT AUTHENTICATOR COMPATIBLE: YES for in-app scan; camera-handoff may
              open the app without adding when issuer contains a space
LIKELY FAILURE: OS camera / handoff opened the authenticator from a valid
              otpauth QR but did not persist the account. Issuer contains a
              space. He already started enroll 3 times; only the latest QR
              matches the stored unverified secret.
SAFE TO RETRY SAME QR: YES only if the current on-screen QR/setup key is kept.
              NO if Set up is clicked again or the page was refreshed.
SAFE TO START NEW ENROLLMENT: YES (unverified rows are overwritten). Prefer
              finishing the current QR if it is still visible.
RECOMMENDED HUMAN ACTION: Do not click Set up again if the QR is still on
              screen. Use the authenticator’s in-app + Scan QR, or type the
              setup key shown under the QR. Then Verify. If the QR is gone,
              click Set up once and immediately use in-app scan / manual key.
              Ignore older screenshots.

STOP FOR REVIEW.
```

## Production row (metadata only)

`mcarletta@freedomadj.com` → app UUID `7dbb3009-f059-4767-b5dc-1c5c72379330`,
identity `status=active`.

| Field | Value |
| --- | --- |
| unverified | YES (`verified_at` null) |
| enrolled_at | `2026-09-11T13:21:38.459Z` |
| key_id | `financial-totp-v1` |
| algorithm / digits / period | SHA1 / 6 / 30 |
| ciphertext_bytes / nonce_bytes | 48 / 12 (not decrypted) |
| failed_attempts / locked | 0 / false |
| enroll_start in current 5-min window | 3 of 5 |

Tester enrollment remains verified. Cognito, Lambda CodeSha256, and money
flags were not changed. Rehearsal oneshot restored to
`Uuqs/fRkCulPrdKUj72FJTlHdTkfhVXc+mttZljUzwk=` / `index.handler`.

## Generator (live Lambda `financial-totp.mjs`)

```
otpauth://totp/${encodeURIComponent("ChecksOps Financial")}:${encodeURIComponent(email)}
  ?secret=${encodeURIComponent(secret)}
  &issuer=${encodeURIComponent("ChecksOps Financial")}
  &digits=6&period=30
```

Secret: RFC 4648 Base32 `A-Z2-7`, 32 characters, 160 bits. No padding.
`algorithm=` is omitted; HMAC-SHA1 is the stored default and the TOTP default.

Frontend `resolveTotpOtpauthUri` returns the server `otpauth_uri` unchanged
when it starts with `otpauth://`. `qrcode` encodes that string. No truncate,
no double-encode.

## Overwrite behavior

`handleMfaAssociate` blocks only **verified** rows (`409 enrollment_reset_required`).
Unverified `ON CONFLICT` replaces ciphertext and resets `verified_at`. Clicking
**Set up ChecksOps Financial authenticator** again **does** mint a new secret
and invalidates any previous QR.

## Compatibility

RFC 6238 TOTP SHA1 / 6 / 30 / Base32 is what Google Authenticator, Microsoft
Authenticator, Authy, 1Password, and iPhone Passwords expect.

Known app behavior: scanning with the **phone camera** (not the authenticator’s
own scanner) often **opens** the app from `otpauth://` without completing
**Add account**, especially when the issuer string contains a space
(`ChecksOps Financial`). That matches “QR scans and opens the app, no new
code appears.”
