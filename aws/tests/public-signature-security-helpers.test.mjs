import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const sourceOf = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const WRITE_SQL = sourceOf('aws/storage/sql/02_public_signature_write_helpers.sql');
const AGENT_SQL = sourceOf('aws/rls/sql/39_mortgage_agent_signature_send.sql');
const WRITE_HELPERS = sourceOf('aws/rls/sql/20_write_helpers.sql');
const ESIGN = sourceOf('aws/functions/api/esign.mjs');
const STORAGE = sourceOf('aws/functions/api/storage.mjs');
const SUBMIT = sourceOf('aws/functions/api/signature-submit.mjs');

test('public write helpers are separate token-scoped SECURITY DEFINER functions', () => {
  for (const name of [
    'aws_public_signature_mark_viewed',
    'aws_public_signature_submit',
    'aws_public_signature_attach_signed',
    'aws_public_signature_set_completion_error',
  ]) {
    assert.match(WRITE_SQL, new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}`));
    assert.match(WRITE_SQL, new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}[^;]* FROM PUBLIC`));
    assert.match(WRITE_SQL, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}[^;]* TO checksops`));
  }
  assert.match(WRITE_SQL, /SECURITY DEFINER/);
  assert.match(WRITE_SQL, /SET search_path = public/);
  assert.equal(WRITE_SQL.includes('GRANT EXECUTE') && WRITE_SQL.includes('TO authenticated'), false);
  assert.equal(WRITE_SQL.includes('EXECUTE FUNCTION'), false);
  assert.equal(/p_signer_id|p_request_id|p_claim_id|p_tenant_id/.test(
    WRITE_SQL.slice(WRITE_SQL.indexOf('aws_public_signature_mark_viewed')),
  ) && WRITE_SQL.includes('p_signer_id uuid'), false);
  assert.equal(WRITE_SQL.includes("p_token_hash !~ '^[0-9a-f]{64}$'"), true);
  assert.match(WRITE_SQL, /token_hash = p_token_hash/);
  assert.match(WRITE_SQL, /signer_order_blocked/);
  assert.match(WRITE_SQL, /path_mismatch/);
  assert.match(WRITE_SQL, /Never mutate document_path/);
});

test('public helpers do not grant generic SQL or table writers', () => {
  assert.equal(/CREATE OR REPLACE FUNCTION public\.aws_exec/i.test(WRITE_SQL), false);
  assert.equal(WRITE_SQL.includes('row_security = off') && WRITE_SQL.includes('SECURITY DEFINER'), true);
  assert.equal(STORAGE.includes('SET LOCAL row_security'), false);
  assert.equal(SUBMIT.includes('SET LOCAL row_security'), false);
  assert.equal(STORAGE.includes('DISABLE ROW LEVEL SECURITY'), false);
});

test('mortgage agent send rule is assigned-context only and does not change tenant write', () => {
  assert.match(AGENT_SQL, /aws_mortgage_agent_can_manage_signature/);
  assert.match(AGENT_SQL, /aws_mortgage_agent_can_initiate_signature/);
  assert.match(AGENT_SQL, /assigned_employee_id = auth\.uid\(\)/);
  assert.match(AGENT_SQL, /has_role\(auth\.uid\(\), 'mortgage_agent'/);
  assert.equal(AGENT_SQL.includes('CREATE OR REPLACE FUNCTION public.aws_can_write_tenant'), false);
  assert.match(WRITE_HELPERS, /has_role\(auth\.uid\(\), 'admin'/);
  assert.match(WRITE_HELPERS, /has_role\(auth\.uid\(\), 'staff'/);
  assert.equal(WRITE_HELPERS.includes("has_role(auth.uid(), 'mortgage_agent'"), false);
  assert.match(ESIGN, /aws_can_write_tenant/);
  assert.match(ESIGN, /aws_mortgage_agent_can_manage_signature/);
  assert.equal(ESIGN.includes('aws_can_write_tenant = true'), false);
});
