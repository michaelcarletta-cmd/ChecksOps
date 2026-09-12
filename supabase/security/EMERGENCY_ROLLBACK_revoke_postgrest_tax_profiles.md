# Emergency rollback — `recipient_tax_profiles` Data API revoke

**Not an automatic down migration.** There is no `*.down.sql` next to `20260912114853_revoke_postgrest_tax_profiles.sql`. `supabase migration down` must not be used to restore tenant-member TIN access.

Rollback requires **explicit operator authorization** (named approver, ticket, and written acceptance of the warning below).

## Warning

Restoring the known prior grants and policies **reopens full-TIN exposure** over PostgREST:

- Any authenticated **tenant member** (not only owner/admin) can `GET /rest/v1/recipient_tax_profiles?select=tin`.
- Embeds from `tenants` / `tenant_safe` / `tenants_public` work again.
- Browser publishable keys are enough; no service-role key is required for that leak.

Do not apply the restore SQL “just to make Tax/1099 work” on the Lovable build.

## Safer functional rollback (preferred)

Keep the table **inaccessible** to `anon` / `authenticated`. Temporarily disable Tax/1099 in the product:

1. Leave this containment migration in place (no grant restore).
2. Hide or disable the Tax UI (`canAccessTaxUi` / Payments Tax tab) if a broken invoke is confusing users.
3. On AWS, PR #247’s `tenant-tax-profiles` handler remains the intended interface; do not grant the table back to PostgREST to paper over a missing hosted Edge Function.

This option does **not** re-expose TIN through the Data API.

## Unsafe catalog restore (authorization required)

Use only if operators explicitly accept full-TIN PostgREST exposure. Run as one transaction after recording approval. Do not select `tin`.

Known prior state from `supabase/migrations/20260709195755_af0fb428-7cf4-4ac3-9fc6-d04ed189b490.sql` (and re-granted by `20260731144913_f26320f9-6473-4cc7-bda1-b4e2a0d71d97.sql`):

```sql
-- EMERGENCY UNSAFE RESTORE — reopens full-TIN Data API exposure.
-- Do not apply without explicit operator authorization.
-- Do not SELECT tin. Do not modify row values.

BEGIN;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.recipient_tax_profiles TO authenticated;
GRANT ALL ON public.recipient_tax_profiles TO service_role;

ALTER TABLE public.recipient_tax_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant members read recipient_tax_profiles" ON public.recipient_tax_profiles;
DROP POLICY IF EXISTS "tenant members insert recipient_tax_profiles" ON public.recipient_tax_profiles;
DROP POLICY IF EXISTS "tenant members update recipient_tax_profiles" ON public.recipient_tax_profiles;
DROP POLICY IF EXISTS "tenant members delete recipient_tax_profiles" ON public.recipient_tax_profiles;

CREATE POLICY "tenant members read recipient_tax_profiles"
  ON public.recipient_tax_profiles FOR SELECT
  TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.tenant_users tu
    WHERE tu.tenant_id = recipient_tax_profiles.tenant_id AND tu.user_id = auth.uid()
  ));

CREATE POLICY "tenant members insert recipient_tax_profiles"
  ON public.recipient_tax_profiles FOR INSERT
  TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.tenant_users tu
    WHERE tu.tenant_id = recipient_tax_profiles.tenant_id AND tu.user_id = auth.uid()
  ));

CREATE POLICY "tenant members update recipient_tax_profiles"
  ON public.recipient_tax_profiles FOR UPDATE
  TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.tenant_users tu
    WHERE tu.tenant_id = recipient_tax_profiles.tenant_id AND tu.user_id = auth.uid()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.tenant_users tu
    WHERE tu.tenant_id = recipient_tax_profiles.tenant_id AND tu.user_id = auth.uid()
  ));

CREATE POLICY "tenant members delete recipient_tax_profiles"
  ON public.recipient_tax_profiles FOR DELETE
  TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.tenant_users tu
    WHERE tu.tenant_id = recipient_tax_profiles.tenant_id AND tu.user_id = auth.uid()
  ));

NOTIFY pgrst, 'reload schema';

COMMIT;
```

This restore does **not** recreate unknown extra policies or column grants that might have existed only in production. If preflight found extras, do not use this script; restore from a documented catalog snapshot instead.
