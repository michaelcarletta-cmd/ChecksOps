# Pure BYOK: Tenants Pay OpenAI Directly

Each tenant pastes their own OpenAI API key. All AI calls in their tenant use *their* key → bills to *their* OpenAI account → you never see the invoice. The Stripe credit-purchase system gets removed from the tenant-facing UI.

## What the tenant sees

1. **Settings → AI Provider** (new panel)
2. Walkthrough card: "Create OpenAI account → add card → create API key → paste below"
3. Masked input + **Test key** button (validates against `https://api.openai.com/v1/models`)
4. Green status pill once saved + last-validated timestamp
5. **Remove key** button
6. If no key is set: every AI feature shows "AI not configured — add your OpenAI key in Settings" instead of running

## What you (platform owner) see

- No more tenant credit top-ups, no Stripe Checkout for AI
- `TenantCreditManager` panel hidden from tenant view (kept in code for admin-only / legacy reference)
- Your `OPENAI_API_KEY` and `LOVABLE_API_KEY` continue to work for the **main Freedom CRM** (non-tenant) flows — only `/wl/*` white-label tenants are BYOK

## Architecture

### 1. Storage (new table)
```text
tenant_openai_credentials
├── tenant_id (PK, FK → tenants)
├── encrypted_key (bytea, pgsodium/pgcrypto encrypted)
├── key_last_4 (text, for display)
├── status (active | invalid | unverified)
├── last_validated_at (timestamptz)
├── created_at, updated_at
```
Encrypted with `pgp_sym_encrypt` using a DB secret. Decryption only via a `SECURITY DEFINER` function callable from edge functions, never returned to the client.

### 2. Key-resolution helper (new)
`supabase/functions/_shared/ai/tenantKeyResolver.ts`
- `resolveTenantOpenAIKey(supabase, tenantId): Promise<string | null>`
- Edge functions call this at request start, pass result into AI calls

### 3. AI client changes
`openaiClient.ts` — add optional `apiKey?: string` to `callOpenAI`, `callVision`, `callWithTools`. When provided, override `OPENAI_API_KEY` and force `provider = "openai"` (skip Lovable gateway — tenant's key is OpenAI-only). No fallback to platform key.

### 4. Edge functions (new)
- `tenant-set-openai-key` — accepts key, validates via OpenAI `/v1/models`, encrypts, stores
- `tenant-validate-openai-key` — re-tests stored key, updates `status`
- `tenant-remove-openai-key` — deletes row

### 5. AI edge function wiring
All 20+ functions that call AI get a small change at entry:
```ts
const tenantId = await resolveTenantFromRequest(req, supabase);
const tenantKey = tenantId ? await resolveTenantOpenAIKey(supabase, tenantId) : null;
if (tenantId && !tenantKey) return 400 "AI not configured for this tenant";
// pass tenantKey into every call: callOpenAI({ ..., apiKey: tenantKey })
```
Non-tenant (Freedom CRM main app) requests keep using `OPENAI_API_KEY` as today.

### 6. Frontend
- New `src/components/white-label/TenantAIKeySettings.tsx` panel
- Add to `WhiteLabelSettings.tsx` as a new tab/section "AI Provider"
- Hide `TenantCreditManager` from tenant-facing settings (keep it on the admin/platform-owner view only)
- Show "AI not configured" banner across tenant pages when no key is set

## Rollout in 3 commits

**Commit 1 — Foundation (no breaking changes)**
- Migration: `tenant_openai_credentials` table + encrypt/decrypt functions
- 3 edge functions: set / validate / remove
- Settings UI panel
- `apiKey` parameter added to `openaiClient.ts` (optional, backwards compatible)
- *Result: tenants can save keys, but nothing uses them yet*

**Commit 2 — Wire AI flows**
- `tenantKeyResolver.ts` helper
- Update all ~20 AI edge functions to resolve and pass tenant key
- For tenant requests without a key → return clear error; UI shows "Configure AI in Settings"
- *Result: tenant AI calls now bill to the tenant's OpenAI account*

**Commit 3 — Hide credit purchase**
- Remove `TenantCreditManager` from tenant settings view
- Keep table + Stripe functions intact (for refunds/admin)
- Update "Pricing" / marketing copy if any references credits
- *Result: tenants no longer see Stripe; pure BYOK UX*

## Trade-offs to confirm

- **Tenant friction:** they need an OpenAI account + credit card before first AI use (~10 min). No way around this for true zero-money BYOK.
- **No platform fallback:** if a tenant's key is invalid/expired, their AI just stops with a clear error. We do **not** silently use your key.
- **Model choice limited to OpenAI:** Tenants can't use Gemini. The Lovable gateway path is bypassed for tenant flows. (Your main app keeps both.)
- **Existing Stripe credit data preserved** — no destructive cleanup; tables remain for audit/refunds.
