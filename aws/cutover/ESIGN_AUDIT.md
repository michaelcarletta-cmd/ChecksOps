# E-sign dependency audit (first-party)

Production `send-signature-request` is **not** DocuSign/HelloSign. It is first-party `signature_requests` + hashed signer tokens + email via the **Lovable Resend connector**.

Public signing is already AWS: `/public/signature-document` and `/public/signature-submit`.

## AWS adapter (this PR)

| Piece | Replacement |
|---|---|
| Staff invoke | Class A `send-signature-request` via Cognito `withIdentityWrite` |
| Token hash | SHA-256 (`hashToken`) |
| Email | `sendViaSesOrSink` (staging default **sink**) |
| Sign URL | `SIGN_BASE_URL` default `https://staging.checksops.com` |
| Lovable connector | **not used** |
| Money movement | none |

Manual bypass (`skipEmail`) still returns signer links.

## Remaining

- Apply no production DNS/auth change for signing hosts until cutover.
- Staging email stays sink/allowlist.
- Vendor DocuSign/HelloSign is **N/A** for ChecksOps.
