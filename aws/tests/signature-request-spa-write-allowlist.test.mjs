/**
 * Pins the narrow Signature Request SPA repair: restore only
 * signature_requests and signature_signers on the client AWS_WRITE_TABLES
 * allowlist. Does not broaden writes or touch API/SQL.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const CLIENT_REL = 'src/integrations/aws/client.ts';
const BASELINE_WITHOUT_SIGNATURE_TABLES = Object.freeze([
  'check_message_reads',
  'notification_preferences',
  'check_intake_items',
  'check_payees',
  'check_endorsements',
  'check_endorsement_events',
  'check_audit_log',
  'check_messages',
  'check_files',
  'claim_checks',
  'loss_draft_tracking',
  'mortgage_handling_requests',
  'loss_draft_audit_log',
  'audit_logs',
  'user_sessions',
  'homeowner_intro_requests',
  'check_cases',
  'contractor_profiles',
  'notifications',
  'tenant_documents',
  'mortgage_request_library_documents',
  'loss_draft_documents',
  'mortgage_companies',
  'shared_check_messages',
  'profiles',
  'company_branding',
  'referral_alerts',
  'tenants',
  'privacy_notice_acknowledgments',
  'tenant_users',
  'claims',
]);

const RESTORED = Object.freeze(['signature_requests', 'signature_signers']);

function parseWriteTables(source) {
  const match = source.match(/const AWS_WRITE_TABLES = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(match, 'AWS_WRITE_TABLES Set not found');
  return [...match[1].matchAll(/"([^"]+)"/g)].map((row) => row[1]);
}

test('client AWS_WRITE_TABLES restores only signature_requests and signature_signers', () => {
  const tables = parseWriteTables(read(CLIENT_REL));
  assert.deepEqual(tables, [...BASELINE_WITHOUT_SIGNATURE_TABLES, ...RESTORED]);
  assert.deepEqual(
    tables.filter((table) => !BASELINE_WITHOUT_SIGNATURE_TABLES.includes(table)),
    [...RESTORED],
  );
  assert.equal(tables.filter((table) => table.startsWith('signature_')).length, 2);
});

test('source write-allowlist is not broadened by this SPA repair', async () => {
  // Main's server allowlist already carries both tables (insert-only); the
  // SPA repair must not widen them or expose token columns.
  const { WRITE_ALLOWLIST } = await import('../functions/api/write-allowlist.mjs');
  for (const table of RESTORED) {
    const spec = WRITE_ALLOWLIST[table];
    assert.ok(spec, `${table} must stay on the server allowlist`);
    assert.deepEqual([...spec.ops], ['insert']);
    for (const column of ['access_token', 'token_hash', 'tenant_id']) {
      assert.ok(!spec.columns.has(column), `${table}.${column} must stay server-derived`);
    }
  }
});
