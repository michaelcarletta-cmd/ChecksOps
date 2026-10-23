/**
 * The two Moov invoice tables for the SQL 112 PostgreSQL 16 tests, as the supabase migration
 * 20260819015105 left them (the columns the tests touch only; run as the superuser before the
 * fixture hands schema public to checksops_admin): row-level security enabled with no policy
 * (so a write that passes the grant layer is refused by RLS, which tells the two layers apart),
 * SELECT, INSERT, UPDATE, DELETE to authenticated, ALL to service_role, nothing to checksops.
 */
export const INVOICES = 'public.moov_invoices';
export const CUSTOMERS = 'public.moov_invoice_customers';

export const MOOV_INVOICE_TABLES = `
CREATE TABLE ${CUSTOMERS} (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  moov_account_id text NOT NULL,
  email text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ${INVOICES} (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  amount_cents integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE ${INVOICES} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${CUSTOMERS} ENABLE ROW LEVEL SECURITY;`;

export const SUPABASE_ERA_INVOICE_GRANTS = `
DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
REVOKE ALL ON TABLE ${INVOICES}, ${CUSTOMERS} FROM checksops, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${INVOICES}, ${CUSTOMERS} TO authenticated;
GRANT ALL ON TABLE ${INVOICES}, ${CUSTOMERS} TO service_role;`;

/** Staging-like: service_role's grants only (what a REVOKE from authenticated would leave). */
export const SERVICE_ROLE_ONLY_INVOICE_GRANTS = `
DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
REVOKE ALL ON TABLE ${INVOICES}, ${CUSTOMERS} FROM checksops, authenticated;
GRANT ALL ON TABLE ${INVOICES}, ${CUSTOMERS} TO service_role;`;
