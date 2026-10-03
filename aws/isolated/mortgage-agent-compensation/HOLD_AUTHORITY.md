# Mortgage Agent Compensation — HOLD / accepted composition dependency

Date: 2026-10-03T17:44:00Z
Workstream: `mortgage-agent-compensation-ad99`
Production: unauthorized
Deployment: **HOLD. No further deployment.**

SQL 47 and Mortgage Agent Management/Compensation staging acceptance are accepted. This candidate is **not** the next standalone production candidate. Branding is forward-composing a later Email Branding preview-logo / Email Brand Color repair onto this source.

## Authority to preserve

Later candidates must preserve these behaviors. Do not rebuild, re-upload, reclaim staging, modify SQL 47, or change the accepted staging API/SPA from this workstream.

| Item | Authority |
| --- | --- |
| Source commit | `c5facdae7e88d400848ee8b009e59a22906de82d` |
| Source tree | `6dc79d8add4bb4526820b21e20626ee4901172fc` |
| SQL 47 | Accepted staging behavior. Do not reapply or edit. |
| Staging API / Lambda | Current Mortgage Agent composition. Owned members only: `app-services.mjs`, `tenant-admin.mjs`, `identity.mjs`, `mortgage-agent-compensation.mjs`. |
| Staging SPA at acceptance | `/assets/index-BmT-cuwB.js` index sha `d2900734d11423b106ac955ee2ade19c27048a1ce8a6c3ee50c19ed2130dcc88` |
| Acceptance | All 15 staging results in `STAGING_UI_API_ACCEPTANCE.md` |

Docs-only follow-up `e5487998fc0ea2d86d93137903c864aea02a3ab1` is not the composition tree. Branding must compose onto `c5facdae7` / `6dc79d8a`.

## Do not reclaim staging

If Branding advances the live SPA away from `/assets/index-BmT-cuwB.js`, this workstream must **not** reclaim staging. Forward-compose. Do not restore a historical SPA.

## Deferred

One platform-owner UI acceptance of the populated Mortgage Agents tab using the legitimate `checksopsadmin@gmail.com` EMAIL_OTP account remains desirable later. Do not manufacture access or change permissions to accomplish that.

## Hold-time read-only fingerprints (2026-10-03T17:44Z)

No writes were performed for this hold.

| Target | Fingerprint |
| --- | --- |
| Staging SPA | `/assets/index-BmT-cuwB.js` sha `d2900734…` Last-Modified 17:16:17Z |
| `checksops-staging-api` | `I+u0Z80Fov6w81Ho6DZETeRDgHMdHlQp/SUsd6ofzYw=` Rev `8ae6edfd-89fa-4685-95b1-cd90a648794d` |
| Shared executor | `JTTXtiCukqvKyJCBwJvQ6ayat3ErrqyItuThOx+3xDI=` |
| Production SPA | `/assets/index-BgOCQCWm.js` sha `3832fadc…` 11:41:40Z |
| Production prep-api | `S2CV0j3zWfYfyfSvmIq0axMhnSib1UntZZVqOvzxBbc=` |
| Production SQL47 apply | `B8q1Z7a2doe6dfpqjdHfT1wv/VkEwWOmLOekxjLLsVQ=` |

## Stop

Production remains unauthorized. No promotion. No rebuild. No SQL 47 change.
