/**
 * The Mortgage Desk and loss draft schema SQL 166 reads and writes, on top of helpers/release-sql-pg.mjs releaseFixture:
 * check_messages and the Desk request columns (sql98To100Schema, with their real policies and grants), loss_draft_tracking
 * with its real policies and SQL 50 grants (helpers/sql134-loss-draft-schema.mjs), loss_draft_audit_log as supabase
 * migration 20260308163837 creates it with its real aws_select_ / aws_write_ policies, stub is_platform_owner /
 * aws_is_mortgage_ops_agent, and SQL 122's real aws_mortgage_desk_working_request sliced from its file. Used by
 * sql166-mortgage-desk-set-monitoring-pg.test.mjs and release-sql166-executor.test.mjs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHECK_A, CLAIM_A, PLATFORM_OWNER, TENANT_A, sql98To100Schema } from './release-sql-pg.mjs';
import { LOSS_DRAFT_SCHEMA } from './sql134-loss-draft-schema.mjs';
import { policyBlock } from './stakeholder-policies-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SQL122 = fs.readFileSync(path.join(ROOT, 'aws/workflows/sql/122_mortgage_desk_return_to_tenant.sql'), 'utf8');

export const AGENT = 'a1660000-0000-4000-8000-000000000001';
export const OTHER_AGENT = 'a1660000-0000-4000-8000-000000000002';
/** In progress, assigned to AGENT, on CHECK_A (DRAFT_A, monitored, nothing recorded). */
export const REQ = 'd1660000-0000-4000-8000-000000000001';
export const REQ_QUEUED = 'd1660000-0000-4000-8000-000000000002';
export const REQ_COMPLETED = 'd1660000-0000-4000-8000-000000000003';
/** In progress, assigned to AGENT, on a check with no loss draft. */
export const REQ_NO_DRAFT = 'd1660000-0000-4000-8000-000000000004';
/** In progress, assigned to AGENT, on a check whose loss draft is endorsing (closed). */
export const REQ_CLOSED = 'd1660000-0000-4000-8000-000000000005';
export const CHECK_NO_DRAFT = 'c1660000-0000-4000-8000-000000000004';
export const CHECK_CLOSED = 'c1660000-0000-4000-8000-000000000005';
export const DRAFT_A = 'e1660000-0000-4000-8000-000000000001';
export const DRAFT_CLOSED = 'e1660000-0000-4000-8000-000000000005';

/** The schema SQL 166 needs, on the release fixture; SQL 122's gate as the file defines it. */
export function deskMonitoringSchema() {
  const start = SQL122.indexOf('CREATE OR REPLACE FUNCTION public.aws_mortgage_desk_working_request(_request_id uuid, _statuses text[])');
  const endMarker = 'REVOKE ALL ON FUNCTION public.aws_mortgage_desk_working_request(uuid, text[]) FROM PUBLIC;';
  const end = SQL122.indexOf(endMarker);
  assert.ok(start > 0 && end > start, 'SQL 122 layout changed');
  return [
    ...sql98To100Schema(),
    LOSS_DRAFT_SCHEMA,
    `
CREATE TABLE public.loss_draft_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loss_draft_id uuid NOT NULL REFERENCES public.loss_draft_tracking(id) ON DELETE CASCADE,
  action text NOT NULL,
  actor_id uuid,
  amount numeric(12,2),
  old_values jsonb,
  new_values jsonb,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.loss_draft_audit_log ENABLE ROW LEVEL SECURITY;
${policyBlock('12_final_select_policies.sql', 'aws_select_loss_draft_audit_log')}
${policyBlock('24_complete_write_policies.sql', 'aws_write_loss_draft_audit_log')}
GRANT SELECT ON TABLE public.loss_draft_audit_log TO checksops, authenticated;
CREATE OR REPLACE FUNCTION public.is_platform_owner() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT auth.uid() = '${PLATFORM_OWNER}'::uuid $$;
CREATE OR REPLACE FUNCTION public.aws_is_mortgage_ops_agent() RETURNS boolean LANGUAGE sql STABLE
  AS $$ SELECT auth.uid() IN ('${AGENT}'::uuid, '${OTHER_AGENT}'::uuid) $$;
${SQL122.slice(start, end + endMarker.length)}
CREATE ROLE sql166_plain LOGIN NOSUPERUSER NOBYPASSRLS;
INSERT INTO public.check_intake_items (id, tenant_id, claim_id) VALUES
  ('${CHECK_NO_DRAFT}', '${TENANT_A}', '${CLAIM_A}'),
  ('${CHECK_CLOSED}', '${TENANT_A}', '${CLAIM_A}');
INSERT INTO public.loss_draft_tracking (id, claim_id, check_intake_item_id, monitoring_type, escrow_status) VALUES
  ('${DRAFT_A}', '${CLAIM_A}', '${CHECK_A}', 'monitored', 'pending_send'),
  ('${DRAFT_CLOSED}', '${CLAIM_A}', '${CHECK_CLOSED}', 'not_monitored', 'endorsing');
INSERT INTO public.mortgage_handling_requests (id, tenant_id, check_intake_item_id, status, assigned_employee_id, claim_id) VALUES
  ('${REQ}', '${TENANT_A}', '${CHECK_A}', 'in_progress', '${AGENT}', '${CLAIM_A}'),
  ('${REQ_QUEUED}', '${TENANT_A}', '${CHECK_A}', 'requested', '${AGENT}', '${CLAIM_A}'),
  ('${REQ_COMPLETED}', '${TENANT_A}', '${CHECK_A}', 'completed', '${AGENT}', '${CLAIM_A}'),
  ('${REQ_NO_DRAFT}', '${TENANT_A}', '${CHECK_NO_DRAFT}', 'in_progress', '${AGENT}', '${CLAIM_A}'),
  ('${REQ_CLOSED}', '${TENANT_A}', '${CHECK_CLOSED}', 'in_progress', '${AGENT}', '${CLAIM_A}');
`,
  ];
}
