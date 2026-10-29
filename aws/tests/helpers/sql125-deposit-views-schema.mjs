/**
 * The deposit views for the SQL 125 PostgreSQL 16 tests (run as the superuser before the release
 * fixture hands schema public to checksops_admin; releaseFixture({ extra: [depositViewsSchema()] })).
 * Everything the four views read, copied out of the supabase migrations that define it, so the
 * view renderings the SQL 125 spec pins are the ones those files leave:
 *
 *   - the deposit_item_status enum (20260308165627; the fixture's own deposit_provider stays, the
 *     views only select that column);
 *   - deposit_items and deposit_exceptions (20260308165627) and deposit_attachments
 *     (20260308171300) as created, replacing the fixture's two-column deposit_items stand-in, then
 *     every ALTER TABLE ... ADD COLUMN on the three tables in file order;
 *   - the four views as created: deposit_aging_dashboard (20260308173238), deposit_reminder_queue
 *     (20260308173916), deposit_owner_performance and deposit_queue_scored (20260308181449). No
 *     later migration replaces or alters them.
 *
 * The three tables carry RLS with their aws_select_ policies of 12_final_select_policies.sql
 * (deposit_items through aws_can_access_check_non_partner, the other two through
 * aws_can_access_deposit_item); checksops holds SELECT on the tables and the views, as the
 * restored databases do (aws/db-copy/sql/02_grant_readonly_application_role.sql).
 *
 * Rows: one deposit item on TENANT_A's CHECK_A and one on CHECK_B, a check of TENANT_B, each with
 * an open exception and a deposit slip, owned by the tenant's member.
 */
import fs from 'node:fs';
import path from 'node:path';
import { policyBlock } from './stakeholder-policies-pg.mjs';
import { CHECK_A, MEMBER_A, MEMBER_B, REPO_ROOT, TENANT_B } from './release-sql-pg.mjs';

export const CHECK_B = '55555555-5555-4555-8555-5555555555b2';
export const ITEM_A = 'd1000000-0000-4000-8000-0000000000a1';
export const ITEM_B = 'd1000000-0000-4000-8000-0000000000b1';
export const DEPOSIT_VIEWS = Object.freeze([
  'public.deposit_queue_scored',
  'public.deposit_owner_performance',
  'public.deposit_reminder_queue',
  'public.deposit_aging_dashboard',
]);
export const DEPOSIT_TABLES = Object.freeze(['public.deposit_items', 'public.deposit_exceptions', 'public.deposit_attachments']);

const MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase/migrations');
const file = (name) => fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
export const SUPABASE_VIEW_FILES = Object.freeze({
  'public.deposit_aging_dashboard': '20260308173238_65274e91-0f07-4481-abd4-2dab4169c2ba.sql',
  'public.deposit_reminder_queue': '20260308173916_7c2f2843-4ab8-4961-a557-8f23f60bb963.sql',
  'public.deposit_owner_performance': '20260308181449_0a4c9354-18c2-48d2-8021-f944324ad69c.sql',
  'public.deposit_queue_scored': '20260308181449_0a4c9354-18c2-48d2-8021-f944324ad69c.sql',
});
const TABLES_FILE = '20260308165627_d781122a-6208-4ec3-bda2-6d05768d8357.sql';
const ATTACHMENTS_FILE = '20260308171300_8356e49b-2407-4961-a2d1-94c4e8f1bc6e.sql';

const slice = (text, start, end) => {
  const from = text.indexOf(start);
  const to = from < 0 ? -1 : text.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`${start} ... ${end} not found`);
  return text.slice(from, to + end.length);
};

/** The view's CREATE statement exactly as its supabase migration has it. */
export function supabaseViewStatement(view) {
  const name = view.replace(/^public\./, '');
  const text = file(SUPABASE_VIEW_FILES[view]);
  const head = [`CREATE OR REPLACE VIEW public.${name} AS`, `CREATE OR REPLACE VIEW ${name} AS`].find((h) => text.includes(h));
  if (!head) throw new Error(`${view} not created in ${SUPABASE_VIEW_FILES[view]}`);
  return slice(text, head, ';');
}

/** Every ALTER TABLE ... ADD COLUMN on the three deposit tables, in supabase file order. */
export function supabaseDepositColumnStatements() {
  const re = /ALTER TABLE (?:IF EXISTS )?(?:public\.)?(?:deposit_items|deposit_exceptions|deposit_attachments)\b[^;]*;/g;
  return fs.readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()
    .flatMap((name) => [...file(name).matchAll(re)].map((m) => m[0]))
    .filter((statement) => /ADD COLUMN/i.test(statement));
}

export function depositViewsSchema() {
  const tables = file(TABLES_FILE);
  return [
    'DROP TABLE public.deposit_items CASCADE;',
    slice(tables, 'DO $$ BEGIN\n  CREATE TYPE public.deposit_item_status', 'END $$;'),
    slice(tables, 'CREATE TABLE IF NOT EXISTS public.deposit_items (', '\n);'),
    slice(tables, 'CREATE TABLE IF NOT EXISTS public.deposit_exceptions (', '\n);'),
    slice(file(ATTACHMENTS_FILE), 'CREATE TABLE IF NOT EXISTS public.deposit_attachments (', '\n);'),
    ...supabaseDepositColumnStatements(),
    ...DEPOSIT_VIEWS.map(supabaseViewStatement),
    ...DEPOSIT_TABLES.map((t) => `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`),
    ...DEPOSIT_TABLES.map((t) => policyBlock('12_final_select_policies.sql', `aws_select_${t.replace(/^public\./, '')}`)),
    `GRANT SELECT ON ${[...DEPOSIT_TABLES, ...DEPOSIT_VIEWS].join(', ')} TO checksops;`,
    `INSERT INTO public.check_intake_items (id, tenant_id) VALUES ('${CHECK_B}', '${TENANT_B}');
INSERT INTO public.deposit_items (id, check_id, status, amount, check_number, owner_id, created_at, cleared_at) VALUES
  ('${ITEM_A}', '${CHECK_A}', 'succeeded', 1200.00, 'A-1001', '${MEMBER_A}', now() - interval '6 days', now() - interval '5 days'),
  ('${ITEM_B}', '${CHECK_B}', 'succeeded', 3400.00, 'B-2002', '${MEMBER_B}', now() - interval '6 days', now() - interval '5 days');
INSERT INTO public.deposit_exceptions (deposit_item_id, exception_type, description, severity) VALUES
  ('${ITEM_A}', 'amount_mismatch', 'A open', 'critical'), ('${ITEM_B}', 'amount_mismatch', 'B open', 'critical');
INSERT INTO public.deposit_attachments (deposit_item_id, attachment_type, file_name, file_path) VALUES
  ('${ITEM_A}', 'deposit_slip', 'a.pdf', 'a/a.pdf'), ('${ITEM_B}', 'deposit_slip', 'b.pdf', 'b/b.pdf');`,
  ].join('\n\n');
}
