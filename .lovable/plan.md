# Per-Tenant Email Architecture

## Sender strategy
- **Platform fallback (ships now):** All tenant emails send from `notify.checksops.com` (already verified via Lovable Emails). From-line shows the tenant's brand name; Reply-To routes to the tenant's inbox.
- **Per-tenant custom domain (Phase 2, opt-in):** Tenants can later verify their own sending domain (e.g. `mail.acmerestoration.com`) via a third-party connector (Resend or Mailgun). When verified, sends switch to their domain automatically.

Note: I'll use the existing `notify.checksops.com` sender rather than provisioning a second `notify.claims.checksops.com` — same effect, no extra DNS. Say the word if you want the `claims.` subdomain instead.

---

## Phase 1 — Ship now

### Schema (migration on `company_branding`)
Add per-tenant email columns:
- `email_from_name` (text) — display name in From
- `email_reply_to` (text) — Reply-To address
- `email_sending_mode` (`platform` | `custom`, default `platform`)
- `email_sending_domain` (text, nullable) — Phase 2 use
- `email_from_address` (text, nullable) — Phase 2 use
- `email_domain_status` (`unverified` | `pending` | `verified` | `failed`, default `unverified`)
- `email_dns_records` (jsonb, nullable) — SPF/DKIM/DMARC records shown to tenant
- `email_provider` (`lovable` | `resend` | `mailgun`, default `lovable`)
- `email_verified_at` (timestamptz, nullable)

### Backend: tenant-aware resolver
New shared helper `supabase/functions/_shared/tenantEmailSender.ts`:
- `resolveTenantSender(tenantId)` → returns `{ fromName, fromAddress, replyTo, provider }`
- If `email_sending_mode='custom'` AND `email_domain_status='verified'` → use tenant domain via chosen provider
- Otherwise → `"<TenantName> <notify@checksops.com>"` with tenant's Reply-To

### Update send paths
- `send-transactional-email`: accept `tenantId` in payload, call resolver, pass result to Mailgun/queue
- `auth-email-hook`: look up tenant from user's `tenant_users`, resolve sender the same way
- Any direct `resend`/`mailgun` calls in existing functions: route through resolver

### Settings UI
`src/components/settings/EmailSenderSettings.tsx` (admin-only, scoped to current tenant):
- Toggle: "Use ChecksOps default sender" / "Use my own domain (Phase 2)"
- Fields: From Name, Reply-To email
- Preview card showing example From line
- Custom-domain section stubbed with "Coming soon" until Phase 2 lands

---

## Phase 2 — Custom domains (when a tenant asks)

1. Connect Resend or Mailgun via `standard_connectors--connect`
2. In settings UI: input sending domain → call edge function `verify-tenant-domain` which creates the domain on the provider and returns DNS records (DKIM CNAMEs, SPF, DMARC)
3. UI displays records with copy buttons
4. "Check verification" button polls provider; on success sets `email_domain_status='verified'`
5. Resolver automatically switches that tenant to their own domain
6. Nightly cron re-checks verified domains; flips to `failed` if DNS drift is detected

---

## Files to touch (Phase 1)
- `supabase/migrations/…_tenant_email_settings.sql` — new columns
- `supabase/functions/_shared/tenantEmailSender.ts` — new
- `supabase/functions/send-transactional-email/index.ts` — use resolver
- `supabase/functions/auth-email-hook/index.ts` — use resolver
- `src/components/settings/EmailSenderSettings.tsx` — new
- `src/pages/…settings route` — mount new panel

## Out of scope right now
- Any provider connector work (Resend/Mailgun) — deferred to Phase 2
- Rewriting locked functions (`send-email`, `check-endorsement`) unless you unlock them
