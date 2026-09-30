# Signature workflow — accepted production behavior

This file is repository evidence for the Signature workflow that was
manually proven on production. It does **not** deploy, upload, invalidate,
or modify AWS.

Accepted SHAs below are **provenance / acceptance evidence**. They are
**not** permanent deployment targets. A future agent must read the current
live package first and overlay onto that live baseline. Restoring
`index-C9QrEEkl.js`, `Sign-DfWZrlqT.js`, `CheckFilesSection-BJZPqPpX.js`,
or Lambda `pxZj4G6p…` merely because those bytes match this record is
forbidden after legitimate newer work is live.

Rule: **preserve accepted behavior, not blindly restore accepted bytes.**

## Provenance snapshot (2026-09-30)

| Component | Identity |
|---|---|
| Entry | `index-C9QrEEkl.js` |
| Public Sign | `assets/Sign-DfWZrlqT.js` SHA256 `9f228f47e57f3f79723dc30aa5f0aed2b6facf70e1c5015d7b04dfba028d805b` |
| Authenticated Files | `assets/CheckFilesSection-BJZPqPpX.js` SHA256 `df1b95f4a85d04901d2d707e2feae7f3c77e605744cc5ffe9011d2872a4fb969` |
| Production Lambda | `checksops-production-prep-api` CodeSha256 `pxZj4G6pGntJrkcRO5uNNEbiyvDpCOKPiWAboDnPvBA=` |

The iPhone Sign preview responsive fix was isolated to the public Sign
asset (`Sign-DfWZrlqT.js` only). `index-C9QrEEkl.js`, Files, and Lambda
were not rewritten for that repair.

## Manually proven path

The following production path was proven end-to-end:

1. Check-scoped Signature upload (`check-intake/{checkId}/files/...`)
2. Field placement
3. Class A create/send (`functions.invoke("send-signature-request", ...)`)
4. Database commit of request, signers, and fields
5. Email delivery (or documented manual-bypass copy)
6. Public `/sign` signing
7. Persisted signature values (`data:image/...`)
8. PDF stamping / Retry regeneration of the real final signed PDF
9. Visible signed final PDF attachment

## Frozen behavior (not frozen forever-bytes)

- Class A create/send; `optionalUuid(field.id)`; token / `token_hash` mint
- No `access_token = NULL`
- No unused `claims.latest_signature_request_id` writes
- Submit-time `data:image/...` passed directly into finalization
- Deterministic field mapping; no first-signature-wins fallback
- Real signed-PDF regeneration; no `certificate_pdf_path`; no dummy
  “Signature certificate (staging retry)”
- Generic frontend inserts to `signature_requests` / `signature_signers`
  remain prohibited on the Signature Files wizard
- Existing storage / write allowlists
- Narrow Sign preview does not independently set `70vh` + `minHeight:400px`

## Future deploy

1. Read current live SPA/Lambda first.
2. Never restore an old dist or old Lambda ZIP because its SHA matches this record.
3. Require a narrow overlay onto the **current live** baseline.
4. Stop on unexpected drift unless the Signature contract is explicitly reconciled.
5. Refuse a deploy that silently drops any frozen invariant.

This evidence file does not authorize any write.
