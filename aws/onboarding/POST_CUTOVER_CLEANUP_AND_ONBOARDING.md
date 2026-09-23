# Post-cutover cleanup and multi-tenant onboarding readiness

Scope: dormant Supabase/Lovable remnant classification plus the **existing** tenant onboarding path. The accepted AWS production architecture is unchanged.

## A. Supabase remnants found

| Finding | Classification | Notes |
|---|---|---|
| `src/integrations/supabase/client.ts` + `src/integrations/aws/client.ts` | **2. STILL RUNTIME-REFERENCED** | AWS builds (`VITE_AUTH_PROVIDER=cognito`) swap in the Cognito/AWS adapter. Call sites stay `supabase.from` / `supabase.functions.invoke`. Do not delete. |
| `@supabase/supabase-js` | **2. STILL RUNTIME-REFERENCED** | Types and non-AWS fallback client. |
| `src/integrations/supabase/types.ts` | **2. STILL RUNTIME-REFERENCED** | Generated table types used across the SPA. |
| Hundreds of `supabase.*` call sites in `src/` | **2. STILL RUNTIME-REFERENCED** | Routed to AWS `/data/*`, `/storage/*`, `/functions/v1/*` in Cognito builds. |
| `aws/functions/api/app-services.mjs` Class A names | **2. STILL RUNTIME-REFERENCED** | AWS handlers that preserve Edge Function names. |
| `supabase/functions/**` | **3. DEVELOPMENT/HISTORICAL ONLY** | Original function source / parity reference. AWS does not import these at runtime. Tests still import some `_shared` modules. |
| `supabase/migrations/**` | **3. DEVELOPMENT/HISTORICAL ONLY** | Schema history. RDS is the live catalog. |
| `.env.production` `VITE_SUPABASE_*` | **2. STILL RUNTIME-REFERENCED** | Consumed by legacy `npm run build` (no `--mode aws`). AWS production uses `build:aws`. |
| `scripts/check-publish-keys.mjs` | **3. DEVELOPMENT/HISTORICAL ONLY** | `prebuild` for the legacy bundle only. Not used by `build:aws`. |
| `vite.config.ts` Supabase PWA cache + key define | **2. STILL RUNTIME-REFERENCED** | Non-AWS Vite mode only. AWS mode blanks the keys. |
| `src/lib/supabaseTimed.ts` | **4. UNKNOWN — NEEDS NARROW VERIFICATION** | Wrapper around the shared client. Leave until a caller audit proves unused. |
| `scripts/*` that `createClient` against Supabase | **3. DEVELOPMENT/HISTORICAL ONLY** | One-off prod-era scripts (`moov-e2e-freedom.mjs`, RPC testers). Not the AWS API. |
| `aws/db-copy/**` + `aws/storage/copy-from-supabase.mjs` | **3. DEVELOPMENT/HISTORICAL ONLY** | Cutover copy tooling. Do not run against production. |
| `supabase.json` | **3. DEVELOPMENT/HISTORICAL ONLY** | Windows Scoop CLI manifest, not a live project config. |

## B. Lovable remnants found

| Finding | Classification | Notes |
|---|---|---|
| `src/integrations/lovable/index.ts` + `@lovable.dev/cloud-auth-js` | **1. SAFE TO REMOVE** | No production or SPA importer. Removed this PR. |
| README Lovable editor/deploy instructions | **1. SAFE TO REMOVE** | Replaced with AWS-first project docs. |
| `.env.example` Lovable-as-production comments | **1. SAFE TO REMOVE** | Replaced with AWS-first template. |
| `.lovable/plan/**` | **3. DEVELOPMENT/HISTORICAL ONLY** | Old planning notes. Not runtime. |
| `lovable-tagger` (devDependency) | **3. DEVELOPMENT/HISTORICAL ONLY** | Vite plugin, non-AWS `development` mode only. |
| `index.html` CSP `*.lovable.app` + preview OG image | **4. UNKNOWN — NEEDS NARROW VERIFICATION** | Could still matter if a preview host frames the SPA. Not changed. |
| `src/integrations/supabase/previewAuthStorage.ts` | **2. STILL RUNTIME-REFERENCED** | Used only by the non-AWS `createClient` fallback. Leave until the legacy bundle is retired. |
| `supabase/functions/**` Lovable email/AI gateways | **3. DEVELOPMENT/HISTORICAL ONLY** | AWS mail is SES (`email.mjs` / `email-branding.mjs`). Do not call `connector-gateway.lovable.dev` from AWS. |

## C. Proven dormant remnants safe to remove

- Unused Lovable Cloud Auth helper (`src/integrations/lovable/index.ts`)
- Unused npm dependency `@lovable.dev/cloud-auth-js`
- Lovable-first README / `.env.example` that would send new developers to the old runtime

## D. Still-runtime-referenced legacy dependency

The SPA still speaks a Supabase-shaped client. That is the accepted AWS adapter, not a second backend. **Do not redesign it in this workstream.**

Legacy `npm run build` still embeds `.env.production` Supabase URL/key. **Do not delete those keys** until the legacy bundle path is formally retired.

## E. Files / config / env / docs removed or rewritten

Removed:

- `src/integrations/lovable/index.ts`
- `package.json` dependency `@lovable.dev/cloud-auth-js`

Rewritten:

- `README.md` — AWS production baseline
- `.env.example` — AWS-first, Supabase marked historical

Added:

- `aws/onboarding/sql/80_new_tenant_fail_closed_defaults.sql` (operator-reviewed default only; not auto-applied)
- this report

## F. Tenant onboarding flow status

| Step | Status |
|---|---|
| Platform-owner UI (`AdminTenants` / `TenantManagement`) | **IMPLEMENTED** |
| AWS `/data/write` tenant **insert** | **REPAIRED this PR** — was `operation_not_allowlisted` (update-only) |
| Tenant admin invite (`tenant-invite-user` → Cognito `AdminCreateUser` + `identity_accounts` + `tenant_users` + SES) | **IMPLEMENTED** / **PRODUCTION ACCEPTED** |
| Roles (`admin` / `operator` / `viewer` + system `user_roles`) | **IMPLEMENTED** |
| Branding + email From (unverified custom From stays Reply-To; platform SES From) | **IMPLEMENTED** |
| Check intake / OCR / claim link / endorsement / public sign | **IMPLEMENTED** on AWS public/workflow handlers |
| CheckAlt / Moov | **TENANT CONFIGURATION REQUIRED** after create (fail-closed) |

## G. Tenant isolation status

Isolation is membership + RLS + server-derived `tenant_id`:

- New tenant insert writes only the new row. No Freedom IDs are copied.
- Credit trigger `trg_init_tenant_credits` creates a **zero** `tenant_credit_balances` row for that tenant only.
- Partner code is assigned by existing insert trigger (unique, not Freedom’s).
- Checks, claims, documents, provider accounts, wallets are not created.
- Moov/CheckAlt handlers load accounts by **request tenant**, not the system tenant.
- Partner sharing remains the existing share-row contract (C1C). A new tenant has no shares.

Historical `system_tenant_id()` column defaults exist in old migrations for some check tables. AWS check writes require an explicit tenant and membership; they do not use that helper. Do not insert checks without `tenant_id`.

## H. New-tenant financial fail-closed status

On insert the write path **forces**:

- `is_system_tenant = false`
- `is_founding_partner = false`
- `moov_allowlisted = false`
- `moov_account_id = NULL`
- `payment_provider = NULL`
- `payment_status = 'not_connected'`
- bank / Plaid / Stripe provider columns NULL

Generic writes still **deny** `moov_allowlisted`, `moov_account_id`, `payment_provider`, CheckAlt, wallet, and money tables.

`loadTenantMoovEnv` returns 403 when `moov_allowlisted === false`.

Note: a historical migration set `moov_allowlisted` DEFAULT true. Application insert overrides it. Operator SQL `80_new_tenant_fail_closed_defaults.sql` sets the column default back to false without touching Freedom’s existing row.

## I. CheckAlt per-tenant readiness / config requirements

A new tenant does **not** receive Freedom’s `checkalt_tenant_accounts` row.

Required before a real deposit:

1. Platform-owner CheckAlt tenant register (`checkalt-register-account`) for **that** tenant
2. Tenant-specific SSO user / deposit account number
3. Production CheckAlt flags + financial authorization (already the accepted Freedom path)
4. First production check + CheckAlt fresh acceptance remain **PENDING REAL INPUT**

Until then, deposit execution is fail-closed. That is configuration, not a defect.

## J. Moov per-tenant readiness / config requirements

A new tenant does **not** receive Freedom’s Moov account, bank method, or wallet.

Required before disbursement:

1. Set `moov_allowlisted` intentionally (not via generic tenant write)
2. Create a **new** Moov connected account for that tenant (`moov-account-create` / onboard)
3. KYB / ToS / bank verify / wallet for that account
4. Capability + payment-method readiness (Freedom’s is already READY; a new tenant starts over)
5. Moov real disbursement remains **PENDING LEGITIMATE FUNDING + OPERATOR AUTHORIZATION**

Moov execution implementation stays COMPLETE/FROZEN. Do not fund a wallet to test.

## K. End-to-end workflow matrix

| Step | Status |
|---|---|
| Check upload | **IMPLEMENTED** / **PRODUCTION ACCEPTED** |
| OCR / Textract | **IMPLEMENTED** / **PRODUCTION ACCEPTED** |
| Review / edit | **IMPLEMENTED** / **PRODUCTION ACCEPTED** |
| Claim link | **IMPLEMENTED** / **PRODUCTION ACCEPTED** |
| Endorsement request | **IMPLEMENTED** / **PRODUCTION ACCEPTED** |
| SES email | **IMPLEMENTED** / **PRODUCTION ACCEPTED** (tenant custom From needs verified SES identity) |
| Public sign / endorse | **IMPLEMENTED** / **PRODUCTION ACCEPTED** |
| Return endorsement | **IMPLEMENTED** / **PRODUCTION ACCEPTED** |
| Apply / render endorsement to check rear | **IMPLEMENTED** / **PRODUCTION ACCEPTED** |
| Ready to deposit | **IMPLEMENTED** / **PRODUCTION ACCEPTED** |
| CheckAlt deposit | **TENANT CONFIGURATION REQUIRED** + **PENDING REAL-TRANSACTION ACCEPTANCE** |
| Funds received | **PENDING REAL-TRANSACTION ACCEPTANCE** |
| Disbursement readiness | **TENANT CONFIGURATION REQUIRED** |
| Moov | **IMPLEMENTED** (execution frozen) + **TENANT CONFIGURATION REQUIRED** + **PENDING LEGITIMATE FUNDING + OPERATOR AUTHORIZATION** |
| First new production check intake | **PENDING REAL INPUT** |

## L. Actual defects found

1. **AWS tenant create was blocked.** `WRITE_ALLOWLIST.tenants` allowed update only. `AdminTenants` / `TenantManagement` `.insert()` could not create a customer on AWS.
2. **Platform owner could not update a tenant they are not a member of.** Create does not auto-insert `tenant_users` for the platform mailbox (correct). Update now allows `is_master_owner()` / `is_platform_owner()`.
3. **`moov_allowlisted` default true** (historical migration) would fail-open Moov for SQL-created tenants. Insert now forces false; operator SQL restores the default.

Not defects:

- First production check / CheckAlt / Moov real money acceptance
- New-tenant provider onboarding work

## M. Repairs required BEFORE onboarding additional tenants

- [x] AWS platform-owner tenant insert (this PR)
- [x] Fail-closed provider columns on insert (this PR)
- [x] Platform-owner branding/email update without membership (this PR)
- [ ] Invite the new tenant administrator (`tenant-invite-user`) after create
- [ ] Confirm the new tenant cannot read Freedom checks/claims/documents (staging membership test)
- [ ] Do **not** copy Freedom CheckAlt/Moov IDs
- [ ] Operator review of `80_new_tenant_fail_closed_defaults.sql` if the live DEFAULT is still true

## N. Improvements that can wait until AFTER onboarding

- Delete the entire `supabase/functions` tree (still used as reference + some unit imports)
- Retire `npm run build` / `.env.production` Supabase keys
- Remove Lovable CSP / preview auth storage after the legacy bundle is gone
- Allowlist `is_test_account` / `is_founding_partner` admin toggles (currently denied — good fail-closed)
- Dedicated AWS write for `moov_allowlisted` (keep it out of generic tenant writes)
- README/historical cutover docs that still say “production is Lovable”

## O. Production changes made

None to live AWS resources, DNS, flags, Freedom provider identities, or production data. Code-only: tenant write path + dormant Lovable helper + developer docs.

## P. Staging tests performed

Unit tests for tenant insert isolation, allowlist denial of provider columns, tenant/email/class-A handlers, and `validate-release-locks` passed. Full `npm run test:aws-api` was 1104 pass / 9 fail / 3 skip: the 9 failures are disposable local PostgreSQL 16 `initdb` matrices, not this change. No money movement. No production tenant created.

## Q. Regression results

`app-metadata-writes` and `api-write` tenant isolation cases must stay green. Provider columns remain denied on `/data/write`.

## R. SUPABASE RUNTIME REMOVAL — PENDING

The AWS adapter still uses the Supabase client shape. Residual `supabase/` sources and the legacy bundle path remain. Runtime **calls** on Cognito builds go to AWS, not hosted Supabase.

## S. MULTI-TENANT ONBOARDING — READY (with configuration)

Ready to create an isolated tenant and invite its admin on AWS **after this PR is deployed**. Not ready to take CheckAlt/Moov money for that tenant until that tenant is configured and approved.

## T. Exact blockers if treating “ready” as “can deposit and disburse on day one”

1. New tenant has no CheckAlt depositor/account (expected).
2. New tenant has `moov_allowlisted=false` and no Moov account (expected).
3. First production check / CheckAlt / Moov funding acceptances are still pending real input (known, not defects).
4. This PR must be deployed before AWS UI create works.
