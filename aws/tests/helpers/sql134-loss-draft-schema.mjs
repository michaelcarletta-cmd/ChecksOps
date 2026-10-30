/**
 * public.loss_draft_tracking and public.loss_draft_releases for the SQL 134 PostgreSQL 16 tests (run
 * as the superuser before the release fixture hands schema public to checksops_admin;
 * releaseFixture({ extra: [LOSS_DRAFT_SCHEMA] })): the fixture's minimal loss_draft_tracking (id,
 * claim_id; helpers/stakeholder-policies-pg.mjs) widened with check_intake_item_id, the metadata
 * columns SQL 50 grants and the escrow and draw columns of supabase migration 20260308163837, and
 * loss_draft_releases as that migration creates it (id gen_random_uuid(), no sequence). Row-level
 * security on both with the real aws_select_ (aws/rls/sql/12_final_select_policies.sql) and aws_write_
 * (aws/rls/sql/24_complete_write_policies.sql) policies, and the grants the restored database and SQL
 * 50 leave: table-level SELECT for checksops and authenticated on both, and SQL 50's loss_draft_tracking
 * block taken from the real file (table SELECT, INSERT, DELETE and its column UPDATE list), no column
 * grant on any SQL 134 column and no INSERT on loss_draft_releases.
 *
 * CHECK_B (TENANT_B) carries two drafts: DRAFT_B on CLAIM_B (TENANT_B's claim) and DRAFT_NULL with no
 * claim. MEMBER_B (tenant_users owner of TENANT_B) also holds user_roles staff, so
 * aws_can_write_tenant(TENANT_B) is true for them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { policyBlock } from './stakeholder-policies-pg.mjs';
import { MEMBER_B, REPO_ROOT, TENANT_B } from './release-sql-pg.mjs';

export const TRACKING = 'public.loss_draft_tracking';
export const RELEASES = 'public.loss_draft_releases';
export const CHECK_B = '55555555-5555-4555-8555-5555555555b1';
export const CLAIM_B = '66666666-6666-4666-8666-6666666666b1';
export const DRAFT_B = '77777777-7777-4777-8777-7777777777b1';
export const DRAFT_NULL = '77777777-7777-4777-8777-7777777777b2';
/** The columns SQL 134 grants, in file order. */
export const UPDATE_COLUMNS = Object.freeze(['total_escrowed', 'draw_amount_requested', 'draw_stage', 'draw_amount_released', 'holdback_amount']);
export const INSERT_COLUMNS = Object.freeze(['loss_draft_id', 'draw_number', 'amount_requested', 'amount_released', 'release_date', 'released_at', 'status', 'notes', 'created_by']);

/** SQL 50's loss_draft_tracking grants, exactly as the file has them. */
export function sql50LossDraftTrackingGrants() {
  const text = fs.readFileSync(path.join(REPO_ROOT, 'aws/workflows/sql/50_tranche5_write_grants.sql'), 'utf8');
  const start = text.indexOf('GRANT SELECT, INSERT, DELETE ON TABLE public.loss_draft_tracking TO checksops, authenticated;');
  const end = text.indexOf(') ON TABLE public.loss_draft_tracking TO checksops, authenticated;', start);
  if (start < 0 || end < 0) throw new Error('SQL 50 layout changed');
  return text.slice(start, end + ') ON TABLE public.loss_draft_tracking TO checksops, authenticated;'.length);
}

export const LOSS_DRAFT_SCHEMA = `
ALTER TABLE ${TRACKING}
  ADD COLUMN IF NOT EXISTS check_intake_item_id uuid,
  ADD COLUMN IF NOT EXISTS mortgage_servicer text,
  ADD COLUMN IF NOT EXISTS mortgage_company_id uuid,
  ADD COLUMN IF NOT EXISTS loan_number text,
  ADD COLUMN IF NOT EXISTS lender_website_url text,
  ADD COLUMN IF NOT EXISTS loss_draft_contact text,
  ADD COLUMN IF NOT EXISTS loss_draft_email text,
  ADD COLUMN IF NOT EXISTS loss_draft_phone text,
  ADD COLUMN IF NOT EXISTS loss_draft_fax text,
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS monitoring_type text NOT NULL DEFAULT 'monitored',
  ADD COLUMN IF NOT EXISTS escrow_status text NOT NULL DEFAULT 'pending_send',
  ADD COLUMN IF NOT EXISTS tracking_number_sent text,
  ADD COLUMN IF NOT EXISTS tracking_number_return text,
  ADD COLUMN IF NOT EXISTS shipping_method_sent text,
  ADD COLUMN IF NOT EXISTS shipping_method_return text,
  ADD COLUMN IF NOT EXISTS check_sent_date date,
  ADD COLUMN IF NOT EXISTS check_received_date date,
  ADD COLUMN IF NOT EXISTS check_received_back_date date,
  ADD COLUMN IF NOT EXISTS follow_up_date date,
  ADD COLUMN IF NOT EXISTS last_contact_at timestamptz,
  ADD COLUMN IF NOT EXISTS draw_stage integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS draw_amount_requested numeric(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS draw_amount_released numeric(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS holdback_amount numeric(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_escrowed numeric(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE ${RELEASES} (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loss_draft_id uuid NOT NULL REFERENCES ${TRACKING}(id) ON DELETE CASCADE,
  draw_number integer NOT NULL,
  amount_requested numeric(12,2) NOT NULL DEFAULT 0,
  amount_released numeric(12,2) DEFAULT 0,
  holdback_amount numeric(12,2) DEFAULT 0,
  release_date date,
  requested_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  status text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested','approved','partial','denied','released')),
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE ${TRACKING} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${RELEASES} ENABLE ROW LEVEL SECURITY;
${policyBlock('12_final_select_policies.sql', 'aws_select_loss_draft_tracking')}
${policyBlock('24_complete_write_policies.sql', 'aws_write_loss_draft_tracking')}
${policyBlock('12_final_select_policies.sql', 'aws_select_loss_draft_releases')}
${policyBlock('24_complete_write_policies.sql', 'aws_write_loss_draft_releases')}
REVOKE ALL ON TABLE ${TRACKING}, ${RELEASES} FROM PUBLIC, checksops, authenticated;
GRANT SELECT ON TABLE ${TRACKING}, ${RELEASES} TO checksops, authenticated;
${sql50LossDraftTrackingGrants()}
INSERT INTO public.user_roles (user_id, role) VALUES ('${MEMBER_B}', 'staff') ON CONFLICT DO NOTHING;
INSERT INTO public.claims (id, org_id) VALUES ('${CLAIM_B}', '${TENANT_B}');
INSERT INTO public.check_intake_items (id, tenant_id, claim_id) VALUES ('${CHECK_B}', '${TENANT_B}', '${CLAIM_B}');
INSERT INTO ${TRACKING} (id, claim_id, check_intake_item_id, monitoring_type, escrow_status) VALUES
  ('${DRAFT_B}', '${CLAIM_B}', '${CHECK_B}', 'monitored', 'check_received_back'),
  ('${DRAFT_NULL}', NULL, '${CHECK_B}', 'monitored', 'check_received_back');`;
