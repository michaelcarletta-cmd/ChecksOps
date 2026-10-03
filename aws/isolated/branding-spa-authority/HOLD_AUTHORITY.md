# Branding SPA — HOLD / accepted production candidate

Date: 2026-10-03T19:45:00Z
Workstream: `branding-preview-logo-embed-ff98`
Production: **HOLD. Do not deploy.**

Branding staging acceptance and the production preflight are accepted. Branding itself is staging-accepted. Do not make additional Branding product changes. Do not promote production until Mortgage Agent Compensation API + SQL 47 are prepared separately.

## Accepted Branding SPA authority

| Item | Authority |
| --- | --- |
| Source commit | `2e94556303ee7933d42738df02f1bc9c8ee2c668` |
| Source tree | `e0b158fb6d714512c74f2c8e48220746822f8c19` |
| Branch | `cursor/branding-preview-logo-embed-ff98` |
| Compose base | MAC `724ffe914` on `c5facdae7` tree `6dc79d8a` |
| Staging SPA at acceptance | `/assets/index-BMa1WD6y.js` index sha `2ced2b30e7ebced14a832a20fe8c2030689e4bdd80f3d5b7a301856500953474` |
| Email preview | SPA-only embed. Accepted. |

## Hold reason

The composed SPA includes the Mortgage Agents UI. Production does not yet have the Mortgage Agent Compensation API or SQL 47. Do not intentionally deploy a frontend whose required backend is absent.

## Email branding — do not regress

Do **not** deploy or overlay `email-branding.mjs`.

Live production sent-email tenant-logo delivery through `/prep/branding/logo/<tenantId>` is working (`200 image/png`). The undeployed source `publicTenantLogoUrl()` path uses `/prep/storage/public`, which currently fails in production (`403 storage_forbidden`). Do not replace the working live member.

## Release lock

Do **not** update the stale `production-spa` lock (`index-HXTuSrE0.js`) merely to enable a deployment. Reconcile `HXTuSrE0` vs live `/assets/index-BgOCQCWm.js` against fresh live authority as part of the eventual guarded production promotion.

Do not reuse expired receipts or leases.

## Do not reclaim

If staging or source advances while this workstream is held, do **not** restore `/assets/index-BMa1WD6y.js` or this commit over newer live state. Forward-compose.

## Until resumed

- No SPA upload
- No Lambda overlay
- No SQL
- No RLS
- No Cognito
- No production writes
