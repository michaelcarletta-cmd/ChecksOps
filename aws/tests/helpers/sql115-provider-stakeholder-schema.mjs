/**
 * The provider stakeholder sync for the SQL 115 PostgreSQL 16 tests (run as the superuser before
 * the release fixture hands schema public to checksops_admin; releaseFixture({ extra:
 * [PROVIDER_STAKEHOLDER_SCHEMA] })): the fixture's minimal stakeholder_accounts,
 * payment_provider_accounts, payment_provider_methods and tenant_users widened with the columns
 * public.sync_provider_stakeholder_account(uuid) reads and writes, the one-payout index of
 * supabase migration 20260712161508, and the real function, trigger function and triggers of
 * supabase migration 20260728110453, copied out of that file. The function carries the
 * supabase-era EXECUTE grants (PUBLIC, anon, authenticated, service_role) the restored
 * databases may hold.
 *
 * TENANT_B has one Moov account (production, receiving) and its partner payout; the tests add
 * the sandbox account the way staging did on 2026-10-25.
 */
import fs from 'node:fs';
import path from 'node:path';
import { MEMBER_B, REPO_ROOT, TENANT_B } from './release-sql-pg.mjs';

export const SYNC_FUNCTION = 'public.sync_provider_stakeholder_account(uuid)';
export const SUPABASE_SYNC_FILE = path.join(REPO_ROOT, 'supabase/migrations/20260728110453_fa494314-aebe-4728-9c30-d7b7bd0fb095.sql');
export const PRODUCTION_ACCOUNT = 'c1000000-0000-4000-8000-0000000000b1';
export const SANDBOX_ACCOUNT = 'c1000000-0000-4000-8000-0000000000b2';

const slice = (text, start, end) => {
  const from = text.indexOf(start);
  const to = from < 0 ? -1 : text.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`${start} ... ${end} not found`);
  return text.slice(from, to + end.length);
};

/** The real function, trigger function and triggers of supabase migration 20260728110453. */
export function supabaseSyncObjects() {
  const text = fs.readFileSync(SUPABASE_SYNC_FILE, 'utf8');
  return slice(text, 'CREATE OR REPLACE FUNCTION public.sync_provider_stakeholder_account(_tenant_id uuid)',
    'FOR EACH ROW EXECUTE FUNCTION public.trg_sync_provider_stakeholder_account();\n\nDROP TRIGGER IF EXISTS trg_sync_provider_stakeholder_bank ON public.payment_provider_methods;\nCREATE TRIGGER trg_sync_provider_stakeholder_bank\nAFTER INSERT OR UPDATE ON public.payment_provider_methods\nFOR EACH ROW EXECUTE FUNCTION public.trg_sync_provider_stakeholder_account();');
}

export const PROVIDER_STAKEHOLDER_SCHEMA = `
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE public.tenant_users ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.stakeholder_accounts
  ADD COLUMN IF NOT EXISTS created_by uuid,
  ADD COLUMN IF NOT EXISTS nickname text,
  ADD COLUMN IF NOT EXISTS account_type text,
  ADD COLUMN IF NOT EXISTS custname text,
  ADD COLUMN IF NOT EXISTS origin text,
  ADD COLUMN IF NOT EXISTS is_partner_payout boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS verification_status text,
  ADD COLUMN IF NOT EXISTS verification_source text,
  ADD COLUMN IF NOT EXISTS verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS provider text,
  ADD COLUMN IF NOT EXISTS provider_environment text,
  ADD COLUMN IF NOT EXISTS provider_account_id text,
  ADD COLUMN IF NOT EXISTS provider_bank_account_id text,
  ADD COLUMN IF NOT EXISTS provider_bank_name text,
  ADD COLUMN IF NOT EXISTS provider_last_four text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX IF NOT EXISTS stakeholder_accounts_one_partner_payout
  ON public.stakeholder_accounts (tenant_id)
  WHERE is_partner_payout = true AND is_active = true;
ALTER TABLE public.payment_provider_accounts
  ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'moov',
  ADD COLUMN IF NOT EXISTS display_name text,
  ADD COLUMN IF NOT EXISTS can_receive_payments boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS disabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT payment_provider_accounts_tenant_provider_env_key UNIQUE (tenant_id, provider, environment);
ALTER TABLE public.payment_provider_methods
  ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'moov',
  ADD COLUMN IF NOT EXISTS external_recipient_id uuid,
  ADD COLUMN IF NOT EXISTS can_receive boolean,
  ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS connected_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS provider_bank_account_id text,
  ADD COLUMN IF NOT EXISTS bank_name text;
${supabaseSyncObjects()}
GRANT EXECUTE ON FUNCTION ${SYNC_FUNCTION} TO anon, authenticated, service_role;
INSERT INTO public.payment_provider_accounts (id, tenant_id, provider, environment, provider_account_id, display_name, can_receive_payments, updated_at)
  VALUES ('${PRODUCTION_ACCOUNT}', '${TENANT_B}', 'moov', 'production', 'moov-prod-b', 'B', true, now() - interval '1 day');`;

export { MEMBER_B, TENANT_B };
