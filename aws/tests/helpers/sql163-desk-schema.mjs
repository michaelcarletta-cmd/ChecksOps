/**
 * The Mortgage Desk schema SQL 163 reads, on top of helpers/release-sql-pg.mjs releaseFixture: the check, claim, request,
 * homeowner timeline and token columns SQL 163 uses, a tenant-only check_intake_items policy (no mortgage agent clause,
 * as the repository has it), stub is_platform_owner / aws_is_mortgage_ops_agent, and SQL 124's real
 * aws_mortgage_desk_readable_request sliced from its file. Used by sql163-...-pg.test.mjs and release-sql163-executor.test.mjs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHECK_A, CLAIM_A, PLATFORM_OWNER, TENANT_A, TENANT_B } from './release-sql-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SQL124 = fs.readFileSync(path.join(ROOT, 'aws/workflows/sql/124_mortgage_desk_signature_and_reads.sql'), 'utf8');

export const AGENT = 'a1630000-0000-4000-8000-000000000001';
export const OTHER_AGENT = 'a1630000-0000-4000-8000-000000000002';
export const REQ = 'd1630000-0000-4000-8000-000000000001';
export const REQ_QUEUED = 'd1630000-0000-4000-8000-000000000002';
export const REQ_NO_CLAIM = 'd1630000-0000-4000-8000-000000000003';
export const CHECK_NO_CLAIM = 'c1630000-0000-4000-8000-000000000003';
export const TOKEN_1 = 'a'.repeat(48);
export const TOKEN_2 = 'b'.repeat(48);

/** The Desk schema SQL 163 reads, on the release fixture; SQL 124's gate as the file defines it. */
export function deskSchema() {
  const start = SQL124.indexOf('CREATE OR REPLACE FUNCTION public.aws_mortgage_desk_readable_request(_request_id uuid)');
  const endMarker = 'REVOKE ALL ON FUNCTION public.aws_mortgage_desk_readable_request(uuid) FROM PUBLIC;';
  const end = SQL124.indexOf(endMarker);
  assert.ok(start > 0 && end > start, 'SQL 124 layout changed');
  return [`
ALTER TABLE public.check_intake_items ADD COLUMN amount numeric(12,2), ADD COLUMN check_number text, ADD COLUMN carrier_name text,
  ADD COLUMN payee_address text, ADD COLUMN property_address text, ADD COLUMN issue_date date, ADD COLUMN detected_claim_number text,
  ADD COLUMN front_image_path text, ADD COLUMN back_image_path text, ADD COLUMN check_stage text, ADD COLUMN funds_type text,
  ADD COLUMN routing_number text, ADD COLUMN account_number text;
ALTER TABLE public.claims ADD COLUMN policyholder_email text, ADD COLUMN policyholder_name text;
ALTER TABLE public.mortgage_handling_requests ADD COLUMN claim_id uuid, ADD COLUMN homeowner_email text, ADD COLUMN homeowner_name text;
ALTER TABLE public.homeowner_ledger_events ADD COLUMN check_id uuid, ADD COLUMN event_type text, ADD COLUMN occurred_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN actor_label text, ADD COLUMN payload_json jsonb NOT NULL DEFAULT '{}'::jsonb, ADD COLUMN amount numeric(12,2), ADD COLUMN created_by uuid;
ALTER TABLE public.homeowner_ledger_tokens ADD COLUMN created_by uuid, ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.check_intake_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY sql163_tenant_only ON public.check_intake_items FOR SELECT TO checksops USING (public.aws_can_access_tenant(tenant_id));
CREATE OR REPLACE FUNCTION public.is_platform_owner() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT auth.uid() = '${PLATFORM_OWNER}'::uuid $$;
CREATE OR REPLACE FUNCTION public.aws_is_mortgage_ops_agent() RETURNS boolean LANGUAGE sql STABLE
  AS $$ SELECT auth.uid() IN ('${AGENT}'::uuid, '${OTHER_AGENT}'::uuid) $$;
${SQL124.slice(start, end + endMarker.length)}
CREATE ROLE sql163_plain LOGIN NOSUPERUSER NOBYPASSRLS;
UPDATE public.check_intake_items SET amount = 1234.56, check_number = '4182', carrier_name = 'CARRIER', payee_line = 'PAYEE',
  payee_address = '1 Main St', property_address = '1 Main St', issue_date = '2026-11-01', detected_claim_number = 'CL-1',
  front_image_path = 'checks/front.jpg', back_image_path = 'checks/back.jpg', status = 'received', check_stage = 'review', funds_type = 'acv',
  routing_number = '021000021', account_number = '123456789' WHERE id = '${CHECK_A}';
UPDATE public.claims SET policyholder_email = ' Owner@Example.Invalid ', policyholder_name = 'Home Owner' WHERE id = '${CLAIM_A}';
INSERT INTO public.check_intake_items (id, tenant_id, claim_id) VALUES ('${CHECK_NO_CLAIM}', '${TENANT_A}', NULL);
INSERT INTO public.mortgage_handling_requests (id, tenant_id, check_intake_item_id, status, assigned_employee_id, claim_id) VALUES
  ('${REQ}', '${TENANT_A}', '${CHECK_A}', 'in_progress', '${AGENT}', '${CLAIM_A}'),
  ('${REQ_QUEUED}', '${TENANT_A}', '${CHECK_A}', 'requested', '${AGENT}', '${CLAIM_A}'),
  ('${REQ_NO_CLAIM}', '${TENANT_A}', '${CHECK_NO_CLAIM}', 'in_progress', '${AGENT}', NULL);
INSERT INTO public.homeowner_ledger_events (tenant_id, claim_id, event_type, occurred_at, actor_label, payload_json, amount) VALUES
  ('${TENANT_A}', '${CLAIM_A}', 'check_received', '2026-11-01T10:00:00Z', 'Tenant', '{"note":"received","secret":"x"}', 1234.56),
  ('${TENANT_A}', '${CLAIM_A}', 'mortgage_followup', '2026-11-02T10:00:00Z', 'Called Bank', '{"note":"spoke with Sarah","desk_request_id":"${REQ}"}', NULL),
  ('${TENANT_B}', '${CLAIM_A}', 'check_received', '2026-11-03T10:00:00Z', 'Other', '{"note":"other tenant"}', NULL);
`];
}

