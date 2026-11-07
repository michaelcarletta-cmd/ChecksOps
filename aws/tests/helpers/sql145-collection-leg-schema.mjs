/**
 * The schema SQL 145 (aws_platform_owner_insert_billing_collection_leg) writes and reads, on top of the release
 * fixture (helpers/release-sql-pg.mjs, whose aws/rls helpers are the pre-SQL 90 ones):
 *
 *   - public.payment_transfers as helpers/sql109-payment-schema.mjs builds it (supabase/migrations/20260727224957
 *     plus leg_role / wallet_id, RLS on, the aws/rls select policy and SQL 24's aws_write_payment_transfers) with
 *     the columns the API's collection leg writes that the SQL 109 shape leaves out (platform_fee_cents,
 *     net_amount_cents, speed, source_tenant_account_id, all in that migration) and its unique index
 *     payment_transfers_idempotency_uniq (tenant_id, idempotency_key), the API's ON CONFLICT target;
 *   - SQL 72's aws_member_insert_payment_transfers (with aws/financial/sql/65's aws_financial_execution_active(),
 *     which it calls), verbatim;
 *   - SQL 136's gate public.aws_money_write_allowed() (with SQL 91's two GUC helpers, as
 *     helpers/sql136-money-schema.mjs creates them) and its three RESTRICTIVE policies on payment_transfers,
 *     verbatim;
 *   - public.tenant_maintenance_payments (the fee obligations: id, tenant_id, amount_cents, billing_period; RLS on,
 *     the aws/rls select and write policies), with the obligations the tests collect.
 *
 * SQL90_WRITE_HELPERS is SQL 90's aws_is_tenant_member(uuid) and aws_can_write_tenant(uuid), verbatim: run after the
 * fixture it turns the September state (pre-SQL 90: the platform owner writes any tenant) into production's state since
 * 2026-10-19 (membership only). Run collectionLegSchema() as the superuser before ownership
 * (releaseFixture({ extra: collectionLegSchema() })).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TENANT_A, TENANT_B } from './release-sql-pg.mjs';
import { SQL91_GUC_HELPERS } from './sql136-money-schema.mjs';
import { PAYMENT_SCHEMA } from './sql109-payment-schema.mjs';
import { policyBlock } from './stakeholder-policies-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** The text from `start` through the end of the first `end` after it, exactly as the file has it. */
export function sliceFrom(rel, start, end) {
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const from = text.indexOf(start);
  const to = from < 0 ? -1 : text.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`${start} ... ${end} not found in ${rel}`);
  return text.slice(from, to + end.length);
}

const SQL90 = 'aws/workflows/sql/90_users_only_tenant_roles.sql';
const SQL72 = 'aws/workflows/sql/72_member_payment_writes.sql';
const SQL65 = 'aws/financial/sql/65_checkalt_production_writer.sql';
const SQL136 = 'aws/workflows/sql/136_money_write_restrictive_policies.sql';

/** SQL 90's membership helpers (aws_is_tenant_member, then aws_can_write_tenant without the platform-owner branch). */
export const SQL90_WRITE_HELPERS = sliceFrom(SQL90, 'CREATE OR REPLACE FUNCTION public.aws_is_tenant_member(_tenant_id uuid)',
  "'Write allowed only when auth.uid() is a tenant_users member of _tenant_id. The platform owner, global admin/staff without membership, partners and other tenants are denied; no role tiers (SQL 90).';");

/** The obligations (public.tenant_maintenance_payments) and keys the tests use. */
export const PERIOD = '2026-10';
export const OBLIGATION_A = '14500000-0000-4000-8000-0000000000a1'; // TENANT_A 2026-10, 13900 cents
export const OBLIGATION_A_SEPT = '14500000-0000-4000-8000-0000000000a9'; // TENANT_A 2026-09, 13900 cents
export const OBLIGATION_B = '14500000-0000-4000-8000-0000000000b1'; // TENANT_B 2026-10, 5000 cents
export const AMOUNT_A = 13900;
export const bankKey = (tenant, period = PERIOD) => `billing-${period}-${tenant}-bank`;
export const walletKey = (tenant, period = PERIOD) => `billing-${period}-${tenant}-wallet`;

export function collectionLegSchema() {
  return [
    PAYMENT_SCHEMA,
    `
ALTER TABLE public.payment_transfers
  ADD COLUMN platform_fee_cents bigint NOT NULL DEFAULT 0,
  ADD COLUMN net_amount_cents bigint,
  ADD COLUMN speed text NOT NULL DEFAULT 'standard',
  ADD COLUMN source_tenant_account_id text;
CREATE UNIQUE INDEX payment_transfers_idempotency_uniq ON public.payment_transfers (tenant_id, idempotency_key);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.payment_transfers TO checksops;
CREATE TABLE public.tenant_maintenance_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, amount_cents integer NOT NULL CHECK (amount_cents >= 0),
  billing_period text, status text NOT NULL DEFAULT 'due', provider_transfer_id text, notes text);
ALTER TABLE public.tenant_maintenance_payments ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON public.tenant_maintenance_payments TO checksops;
INSERT INTO public.tenant_maintenance_payments (id, tenant_id, amount_cents, billing_period) VALUES
  ('${OBLIGATION_A}', '${TENANT_A}', ${AMOUNT_A}, '${PERIOD}'),
  ('${OBLIGATION_A_SEPT}', '${TENANT_A}', ${AMOUNT_A}, '2026-09'),
  ('${OBLIGATION_B}', '${TENANT_B}', 5000, '${PERIOD}');`,
    policyBlock('12_final_select_policies.sql', 'aws_select_tenant_maintenance_payments'),
    policyBlock('24_complete_write_policies.sql', 'aws_write_tenant_maintenance_payments'),
    // SQL 72's member insert policy and the activation function it calls.
    sliceFrom(SQL65, 'CREATE OR REPLACE FUNCTION public.aws_financial_execution_active()', '$$;'),
    sliceFrom(SQL72, 'DROP POLICY IF EXISTS aws_member_insert_payment_transfers ON public.payment_transfers;', '  );'),
    // SQL 136's gate and its three restrictive policies on payment_transfers.
    SQL91_GUC_HELPERS,
    sliceFrom(SQL136, 'CREATE OR REPLACE FUNCTION public.aws_money_write_allowed()', '$$;'),
    'GRANT EXECUTE ON FUNCTION public.aws_money_write_allowed() TO checksops, authenticated;',
    sliceFrom(SQL136, 'DROP POLICY IF EXISTS aws_money_write_gate_insert_payment_transfers ON public.payment_transfers;',
      'CREATE POLICY aws_money_write_gate_delete_payment_transfers ON public.payment_transfers\n  AS RESTRICTIVE FOR DELETE TO authenticated\n  USING (public.aws_money_write_allowed());'),
  ];
}
