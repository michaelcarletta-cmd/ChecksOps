# Mortgage Agents source composition proof

Date: 2026-10-03T17:10:00Z
Workstream: `mortgage-agent-compensation-ad99`
Production: unauthorized / untouched

## Fresh authority

| Item | Value |
| --- | --- |
| `origin/main` | `7c64dae2dee6c78dd296c946c04ea6ccaa793aef` |
| Branding + Homeowner authority | `fd4fa1954bfe4ad45288ac69d407fb69e2e52156` |
| Branding + Homeowner tree | `dd3e2c6cb5cecf7047ab358dee020121dab95852` |
| Prior compensation HEAD | `befa19fbaad14e8cdc94df0e5cf727e016422ce0` |
| SQL 47 | accepted; not reapplied |

Live staging SPA at composition time matched the Branding + Homeowner candidate (`/assets/index-DkLMXa2q.js`). Live staging API remained `HN09hmWB5D22ljOfRhvpcPYPGEqWFuTXB6CR2h13zpU=` Rev `7ce5717c-f8f5-4d1f-a20a-2712cfe957c7` until a later guarded overlay.

## SPA composition

Taken byte-identical from `fd4fa195` (not from an older AdminTenants):

- `src/App.tsx` — `/h/ledger/:token` before `/:slug/*`
- `src/lib/publicTokenRoutes.ts`
- `src/lib/brandingPublicUrl.ts`
- `src/components/settings/EmailSenderSettings.tsx` — Email Branding + `showSendingDomain`
- `src/components/settings/CompanyBrandingSettings.tsx` — Application Sidebar Logo + public URL normalization
- `src/components/branding/TenantLogo.tsx`
- `src/components/white-label/WhiteLabelSettings.tsx` — tenant branding uses `showSendingDomain={false}`
- `src/pages/PublicInvoicePage.tsx`
- `src/pages/payments/InvoicesTab.tsx`
- `src/constants/edgeFunctionConfig.ts`
- `src/integrations/aws/storage.ts`
- `aws/functions/api/email-branding.mjs`
- branding / homeowner tests listed in that commit

`src/pages/admin/AdminTenants.tsx` is the accepted Branding AdminTenants plus three additive Mortgage Agents lines only:

1. `import { MortgageAgentsPanel } from "@/components/admin/MortgageAgentsPanel";`
2. `<TabsTrigger value="mortgage-agents">… Mortgage Agents</TabsTrigger>`
3. `<TabsContent value="mortgage-agents"><MortgageAgentsPanel /></TabsContent>`

Preserved on that surface:

- `EmailSenderSettings showSendingDomain={true}` on Admin Tenants branding
- `resolvePublicBrandingUrl` logo preview
- existing Tenants / Platform Finance / CheckAlt / Referrals / Announcements tabs
- existing tenant detail branding / billing / users controls

No historical SPA (`CR3qA2Sz`, `Cb3o0qxI`) is used. Newer Branding / Homeowner work is not removed.

## API composition

`app-services.mjs`, `tenant-admin.mjs`, and `identity.mjs` stay on the already forward-composed live members from `befa19fba`. They are **not** taken from `fd4fa195`, which would delete live Branding/billing Class A routes and the Cognito hire lock.

Preserved live Class A routes in `app-services.mjs`:

- `save-tenant-billing-account`
- `tenant-company-branding-save`
- `tenant-billing-admin`
- `tenant-billing-authorize`

Additive compensation route:

- `mortgage-agent-compensation` → `handleMortgageAgentCompensation`

Preserved Cognito hire lock in `tenant-admin.mjs`:

- `bindProductionCognitoLock`
- roster upsert into `mortgage_agent_accounts` after hire

`identity.mjs` still returns `mortgageAgentStatus` without granting `tenant_users`.

## Lambda members that would change

Overlay starts from the current live ZIP and replaces only:

| Member | Change |
| --- | --- |
| `app-services.mjs` | keep live Branding/billing routes; add compensation import/route |
| `tenant-admin.mjs` | keep live Cognito lock; add roster upsert |
| `identity.mjs` | add `mortgageAgentStatus` |
| `mortgage-agent-compensation.mjs` | new member |

Unrelated live members remain byte-identical after overlay. The entire Lambda package is not replaced.

## Locks / workstreams

- Production SPA remains `PRODUCTION_LOCKED` (`index-HXTuSrE0.js`).
- This workstream does not write production.
- SQL 47 is already applied; not reapplied.
- Shared SQL executor allowlist is not mutated.
- AdminTenants / `app-services.mjs` remain shared; composition is additive only.

## Stop rule

If either live staging SPA or live staging API fingerprint changes after this proof and before TOCTOU, STOP and recompute. Do not reclaim staging.
