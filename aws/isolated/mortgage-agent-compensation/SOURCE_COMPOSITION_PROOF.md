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

Fresh live ZIP `HN09hmWB5D22ljOfRhvpcPYPGEqWFuTXB6CR2h13zpU=` Rev `7ce5717c-f8f5-4d1f-a20a-2712cfe957c7` has 6478 members.

Overlay starts from that ZIP and changes only:

| Member | Op | Live SHA-256 | Source SHA-256 |
| --- | --- | --- | --- |
| `app-services.mjs` | replace | `6c7ac74f…c7be8875` | `cce9d0ff…1bcc0c5` (add compensation import/route only) |
| `tenant-admin.mjs` | replace | `2e4a30da…17eb8244` | `8fc1f049…0c950bff` (add roster upsert only) |
| `identity.mjs` | replace | `481c4fdc…54f1c715` | `30abd75f…022515b` (add `mortgageAgentStatus` only) |
| `mortgage-agent-compensation.mjs` | add | absent | `c5f618df…5aae8d` |

Preserved live Branding/billing/Cognito members (copied into source for composition completeness; **not** overlay-owned):

| Member | Live SHA-256 |
| --- | --- |
| `tenant-settings-handlers.mjs` | `6e78cfdfaabedb5b2a6f34ee25699eae2f42bc79957346d812c0427afab8b3d6` |
| `tenant-billing-handlers.mjs` | `8aeb8b7f431742249ace72ee32c1cbc1bf62789565a1eaa9a0249aa00c48586c` |
| `tenant-billing-engine.mjs` | `65b75735825f9a06955d5daba603f74835d106cabf52eb449153c856a59dae2f` |
| `tenant-billing-destination.mjs` | `7f9f24569d8d3112bcb829380de17b56ac5076fe8a8b38fd6a7633b44bcdfd80` |
| `tenant-collection-v2.mjs` | `8a66f54d3c2785162a1643218e18b4d3c251230cf2a7f98a1ecb4ede8939fb66` |
| `identity-env.mjs` | `e814546feded3a323461b3a7a8369e3d8a09f9a5d306d68973e15389b871f443` |

Unrelated live members remain byte-identical after overlay. The entire Lambda package is not replaced.

## Locks / workstreams

- Production SPA remains `PRODUCTION_LOCKED` (`index-HXTuSrE0.js`).
- This workstream does not write production.
- SQL 47 is already applied; not reapplied.
- Shared SQL executor allowlist is not mutated.
- AdminTenants / `app-services.mjs` remain shared; composition is additive only.

## After guarded staging writes

TOCTOU matched this proof. Overlay and SPA promote used official guarded scripts + receipts. SQL 47 was not reapplied. Staging was not reclaimed.

| Target | Before | After |
| --- | --- | --- |
| `checksops-staging-api` | `HN09hmWB5D22ljOfRhvpcPYPGEqWFuTXB6CR2h13zpU=` Rev `7ce5717c-f8f5-4d1f-a20a-2712cfe957c7` (6478 members) | `I+u0Z80Fov6w81Ho6DZETeRDgHMdHlQp/SUsd6ofzYw=` Rev `8ae6edfd-89fa-4685-95b1-cd90a648794d` (6479 members) |
| Staging SPA | `/assets/index-DkLMXa2q.js` index sha `13255a4e…` | `/assets/index-BmT-cuwB.js` index sha `d2900734…` |
| Shared executor | `JTTXtiCukqvKyJCBwJvQ6ayat3ErrqyItuThOx+3xDI=` | unchanged |
| Production prep-api / SQL47 apply / SPA | unchanged | unchanged |

Overlay unexpectedChanged / unexpectedAdded / unexpectedDeleted: empty.

Acceptance: `STAGING_UI_API_ACCEPTANCE.md`.

## Stop rule

If either live staging SPA or live staging API fingerprint changes after this proof and before TOCTOU, STOP and recompute. Do not reclaim staging.
