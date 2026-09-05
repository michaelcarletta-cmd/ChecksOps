# CheckAlt UAT — frozen risk A/B + AWS↔Lovable parity (2026-09-05)

**PR:** #125 · **STOP FOR REVIEW — do not merge**  
**Production flags:** OFF · **Negotiable checks:** none · **Image generator:** unchanged this pass

## 1. Risk A/B on frozen exact bytes

Source images (not regenerated):

| Side | Path | Bytes | SHA-256 | Dims |
|---|---|---|---|---|
| Front | `/opt/cursor/artifacts/checkalt-iqa-matrix/outbound-front.jpg` | 179129 | `2c46627eb7d729fbd01737079600bcc6f8b32d38b7a2964deee11e1b81418036` | 1600×733 JPEG |
| Rear | `/opt/cursor/artifacts/checkalt-iqa-matrix/outbound-rear.jpg` | 150243 | `025d4b5c2b6dc1b3c27c6035ea1cf93ff1c9c84202d554b92062db3416c4c109` | 1600×733 JPEG |

Exact Base64 of those bytes was placed in `frontImage` / `rearImage` for both calls (no pixel re-encode). Decoded transmitted strings rewrite to the same SHA-256. No `data:` prefix. No double Base64. JPEG decode OK.

| Test | `performRiskAssessment` | HTTP | Sanitized body (timestamp excluded) |
|---|---|---|---|
| RISK_TRUE | `true` | **500** | `status=500`, `error=Internal Server Error`, `message=Check deposit processing failed. Please retake the check images and resubmit.` |
| RISK_FALSE | `false` | **500** | identical |

Timestamps differed only (provider clock). **Risk flag did not change outcome.** Cannot isolate a risk/IQA stage from the client-visible response.

Auth `/public/fincapture/authenticate` = 200 · register = OK · account binding = OK · no deposit reference returned.

Machine result: `aws/providers/results/checkalt_risk_ab_frozen.json`

## 2. AWS vs Lovable — every concrete difference

Compared against production Lovable paths:

- prepare: `supabase/functions/checkalt-prepare-image/index.ts`
- submit: `supabase/functions/checkalt-submit-deposit/index.ts`
- browser helper: `src/lib/prepareCheckAltDeposit.ts`
- AWS prepare: `aws/functions/api/providers/parity/checkalt-image.mjs`
- AWS process body: `aws/functions/api/providers/checkalt-sandbox.mjs` + UAT oneshot

| Area | Lovable | AWS UAT (#125) | Match? | Plausible CheckAlt impact? |
|---|---|---|---|---|
| Image **source** | Real customer check photos from storage | Synthetic non-negotiable VOID fixture | **DIFF** | **Yes** — IQA is content-sensitive; this is the intentional UAT constraint, not a prep bug |
| Crop | None (landscape rotate only) | None (landscape rotate only) | Match | No |
| Resize / budget constants | 1600 · q78→35 · min 1300 · 450KB | Same | Match | No |
| JPEG encoder | ImageScript `encodeJPEG` | `jpeg-js` | **DIFF** | Low for this failure: both emit valid landscape JPEG under budget; risk-off identical 500 points at acceptance of synthetic content, not encoder metadata |
| Base64 conversion | raw `btoa`/bytes→base64, no data-URI | `Buffer.toString('base64')`, no data-URI | Match | No |
| Request serialization | `JSON.stringify` process body | Same | Match | No |
| Process path | `POST /fincapture/deposit/process` | Same | Match | No |
| Core fields | `fiKey`, `ssoKey`, `depositAccountNumber`, `captureDateTime`, `userAmount`, `frontImage`, `rearImage`, `performRiskAssessment` | Same | Match | No |
| Optional Postman fields (`firstName`, `lastName`, `emailAddress`, `dailyDepositLimit`) | **Omitted** on process | **Omitted** | Match | No — do not flip without evidence |
| `performRiskAssessment` | Always `true` in prod submit | Tested `true` and `false` | Behaves same on UAT | No isolation — both 500 |
| Submit fallback normalize (only if not pre-prepared) | 1200 / q68 / min 600 | AWS submit path always uses 1600 prepare constants | DIFF only on unprepared path | N/A here — UAT used prepare pipeline |
| Browser pre-cap | `browser-image-compression` @ 1600 | `browserCapToDepositTarget` @ 1600 | Encoder/lib DIFF | Low; same target dim |

### Smallest UAT-only fix?

**None identified.** No request-shape or prepare-constant gap vs Lovable. Optional fields are omitted on both sides. Risk flag does not change the 500. Remaining blocker is CheckAlt UAT acceptance of synthetic/non-negotiable images (or undocumented UAT IQA policy).

## 3. Escalation package (sanitized)

See `checkalt_iqa_escalation_package.md` (updated) and this freeze report.

- Endpoint: `POST /fincapture/deposit/process` @ `uatapi.checkalt.com`
- HTTP 500 identical for risk true/false
- Image: 1600×733 JPEG RGB, front 179129 B / rear 150243 B
- Field names as above; no secrets/fiKey/ssoKey/accounts in artifacts
- Prior stages pass: authenticate, register, account binding

**Ask CheckAlt:** UAT synthetic/VOID acceptance policy or official UAT image kit; more specific IQA reject code if available.

## 4. Stop

Do **not** continue MICR/endorsement/DPI/dimension guessing.  
Do **not** merge PR #125.  
Production remains OFF.
