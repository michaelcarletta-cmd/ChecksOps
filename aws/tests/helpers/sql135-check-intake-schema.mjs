/**
 * public.check_intake_items for the SQL 135 PostgreSQL 16 tests (run as the superuser before the
 * release fixture hands schema public to checksops_admin; releaseFixture({ extra: [checkIntakeSchema(mode)] })):
 * the fixture's minimal check_intake_items (helpers/stakeholder-policies-pg.mjs: id, tenant_id, status,
 * deposited_at, payee_line, claim_id; RLS on, the real aws_select_check_intake_items) given the id
 * default gen_random_uuid() of the restored table (the homeowner inserts name no id) and widened with
 * every column the check create names (handleCreateCheck, aws/functions/api/workflow.mjs; check_stage
 * as the public.check_stage enum of supabase migration 20260505161654, the cash-job columns of
 * 20260522142101) and every column SQL 89 grants UPDATE on, the real aws_write_check_intake_items
 * (aws/rls/sql/21_proposed_write_policies.sql), and the grants the repository leaves:
 *
 *   - 'staging': table SELECT for checksops and authenticated, SQL 50's column INSERT block taken
 *     from the real file (twenty columns, to checksops and authenticated; SQL 51 never run), then the
 *     real SQL 89 file (column UPDATE on its 43 columns for checksops only);
 *   - 'production': table SELECT, INSERT and DELETE for checksops (production's ACL checksops=ard
 *     after SQL 89), SELECT for authenticated, then the real SQL 89 file;
 *   - 'none': table SELECT only, then the real SQL 89 file (no INSERT anywhere: SQL 51 run).
 *
 * MEMBER_B (tenant_users owner of TENANT_B) also holds user_roles staff, so aws_can_write_tenant(TENANT_B)
 * is true for them; MEMBER_A (a viewer of TENANT_A, no role) cannot write.
 */
import fs from 'node:fs';
import path from 'node:path';
import { policyBlock } from './stakeholder-policies-pg.mjs';
import { MEMBER_B, REPO_ROOT } from './release-sql-pg.mjs';

export const TABLE = 'public.check_intake_items';
export const SQL50_FILE = path.join(REPO_ROOT, 'aws/workflows/sql/50_tranche5_write_grants.sql');
export const SQL89_FILE = path.join(REPO_ROOT, 'aws/workflows/sql/89_check_intake_items_column_update.sql');
/** The columns SQL 135 grants, in file order (the order handleCreateCheck names them). */
export const INSERT_COLUMNS = Object.freeze([
  'id', 'tenant_id', 'uploaded_by', 'status', 'check_stage', 'ocr_status', 'front_image_path', 'back_image_path',
  'ocr_needs_verification', 'carrier_name', 'check_number', 'payee_line', 'property_address', 'funds_type',
  'review_notes', 'payee_address', 'expiration_days', 'is_multi_payee', 'issue_date', 'amount', 'claim_id',
  'cash_job_id', 'check_source', 'cash_job_payment_class',
]);
/** The cash-job columns handleCreateCheck adds for a check uploaded from a cash job. */
export const CASH_JOB_COLUMNS = Object.freeze(['cash_job_id', 'check_source', 'cash_job_payment_class']);

/** SQL 50's check_intake_items column INSERT grant, exactly as the file has it. */
export function sql50CheckIntakeInsertGrant() {
  const text = fs.readFileSync(SQL50_FILE, 'utf8');
  const start = text.indexOf('GRANT INSERT (\n  id,');
  const tail = ') ON TABLE public.check_intake_items TO checksops, authenticated;';
  const end = text.indexOf(tail, start);
  if (start < 0 || end < 0) throw new Error('SQL 50 layout changed');
  return text.slice(start, end + tail.length);
}

/** The columns SQL 89 grants checksops UPDATE on, read from the file. */
export function sql89Columns() {
  const text = fs.readFileSync(SQL89_FILE, 'utf8');
  const body = text.slice(text.indexOf('GRANT UPDATE ('), text.indexOf(') ON TABLE public.check_intake_items TO checksops;'));
  const columns = [...body.matchAll(/^\s+([a-z_]+),?$/gm)].map((m) => m[1]);
  if (columns.length !== 43) throw new Error(`SQL 89 layout changed (${columns.length} columns)`);
  return columns;
}

const TYPED = Object.freeze({
  uploaded_by: 'uuid',
  check_stage: 'public.check_stage',
  ocr_needs_verification: 'boolean',
  expiration_days: 'integer',
  is_multi_payee: 'boolean',
  issue_date: 'date',
  amount: 'numeric(12,2)',
  cash_job_id: 'uuid',
  check_source: "text NOT NULL DEFAULT 'insurance'",
  reviewed_by: 'uuid',
  reviewed_at: 'timestamptz',
  updated_at: 'timestamptz NOT NULL DEFAULT now()',
});
const EXISTING = new Set(['id', 'tenant_id', 'status', 'deposited_at', 'payee_line', 'claim_id']);

export function checkIntakeSchema(mode = 'staging') {
  if (!['staging', 'production', 'none'].includes(mode)) throw new Error(`unknown mode ${mode}`);
  const columns = [...new Set([...INSERT_COLUMNS, ...sql89Columns()])].filter((c) => !EXISTING.has(c));
  const grants = {
    staging: `GRANT SELECT ON TABLE ${TABLE} TO checksops, authenticated;\n${sql50CheckIntakeInsertGrant()}`,
    production: `GRANT SELECT, INSERT, DELETE ON TABLE ${TABLE} TO checksops;\nGRANT SELECT ON TABLE ${TABLE} TO authenticated;`,
    none: `GRANT SELECT ON TABLE ${TABLE} TO checksops, authenticated;`,
  }[mode];
  return `
CREATE TYPE public.check_stage AS ENUM ('review','loss_draft','endorsing','ready_for_deposit','deposited');
ALTER TABLE ${TABLE}
  ALTER COLUMN id SET DEFAULT gen_random_uuid(),
${columns.map((c) => `  ADD COLUMN ${c} ${TYPED[c] || 'text'}`).join(',\n')};
${policyBlock('21_proposed_write_policies.sql', 'aws_write_check_intake_items')}
REVOKE ALL ON TABLE ${TABLE} FROM PUBLIC, checksops, authenticated;
${grants}
${fs.readFileSync(SQL89_FILE, 'utf8')}
INSERT INTO public.user_roles (user_id, role) VALUES ('${MEMBER_B}', 'staff') ON CONFLICT DO NOTHING;`;
}
