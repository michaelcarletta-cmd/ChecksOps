

# White-Label Product Extraction: Check Command Center

## Overview

Extract the Check Command Center into a standalone, white-label-ready product that can be licensed to other insurance companies, PA firms, or contractors -- each with their own branding, users, and data isolation. The same pattern will be reusable for future feature extractions (Referral Marketplace, Guided Claims, etc.).

## Architecture

```text
┌─────────────────────────────────────────────────┐
│           Freedom Claims (Main App)             │
│  Uses Check Command Center as internal feature  │
└─────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────┐
│     White-Label Check Command Center            │
│  ┌───────────┐  ┌───────────┐  ┌───────────┐   │
│  │ Tenant A  │  │ Tenant B  │  │ Tenant C  │   │
│  │ (Branding)│  │ (Branding)│  │ (Branding)│   │
│  └───────────┘  └───────────┘  └───────────┘   │
│         Shared backend, isolated data           │
└─────────────────────────────────────────────────┘
```

## What Gets Built

### 1. Multi-Tenant Data Layer

- New `tenants` table: id, name, slug, logo_url, primary_color, secondary_color, custom_domain, stripe_customer_id, subscription_status, plan_tier, created_at
- New `tenant_users` table: tenant_id, user_id, role (admin/operator/viewer)
- Add `tenant_id` column to check-related tables (`claim_checks`, `deposit_items`, `deposit_batches`, `check_endorsements`) with RLS policies ensuring complete data isolation
- Security-definer helper `current_tenant_id()` for RLS policies

### 2. White-Label Theming

- New `TenantThemeProvider` component that reads tenant branding (logo, colors) from context and applies CSS custom properties
- Tenant-aware login page at `/wl/:slug/login` with tenant branding
- Tenant dashboard at `/wl/:slug/checks` rendering the Check Command Center with tenant context

### 3. Check Command Center Refactor

- Extract the core Check Command Center logic into reusable components under `src/components/check-center/` (already partially done with `check-review/`)
- Create a `WhiteLabelCheckCenter` wrapper that injects tenant context and strips Freedom Claims-specific references
- The internal Freedom Claims route continues working as-is -- it just uses the same shared components

### 4. Tenant Admin Portal

- Admin page for Freedom Claims staff to manage tenants: create, configure branding, manage users, view usage
- Tenant self-service settings: upload logo, set colors, manage their own users
- Usage dashboard showing check volume per tenant

### 5. Stripe Subscription for Tenants

- Product tiers (e.g., Starter $199/mo, Pro $499/mo, Enterprise custom)
- Stripe Checkout integration for tenant signup
- Webhook handler to activate/suspend tenant access based on subscription status
- Usage-based billing option for per-check fees

### 6. Custom Domain Support

- Tenants can map their own domain (e.g., `checks.theircompany.com`)
- Routing logic to resolve tenant from custom domain or `/wl/:slug` path

## Implementation Order

1. **Database**: Create tenants, tenant_users tables with RLS; add tenant_id to check tables
2. **Tenant context**: Build TenantProvider, theme provider, tenant-aware auth
3. **Component extraction**: Refactor CheckCommandCenter into shared components
4. **White-label routes**: `/wl/:slug/login`, `/wl/:slug/checks`
5. **Tenant admin**: Management UI for creating and configuring tenants
6. **Stripe billing**: Subscription products, checkout, webhooks
7. **Custom domains**: Domain mapping and resolution logic

## Technical Notes

- The existing Check Command Center (2,730 lines) will be broken into smaller composable components that both the internal and white-label versions consume
- RLS policies use `current_tenant_id()` so tenants can never see each other's data
- The main Freedom Claims app gets a special "system" tenant automatically
- Future features (Referral Marketplace, Guided Claims) follow the same tenant pattern once established

