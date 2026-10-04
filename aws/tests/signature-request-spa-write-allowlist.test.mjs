/**
 * Pins the narrow Signature Request SPA repair: restore only
 * signature_requests and signature_signers on the client AWS_WRITE_TABLES
 * allowlist. Does not broaden writes or touch API/SQL.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const sha256 = (rel) => createHash('sha256').update(read(rel), 'utf8').digest('hex');

const CLIENT_REL = 'src/integrations/aws/client.ts';
const FROZEN = Object.freeze([
  'aws/functions/api/write-allowlist.mjs',
  'aws/functions/api/write-check-workflow.mjs',
  'aws/functions/api/esign.mjs',
  'aws/functions/api/signature-submit.mjs',
  'aws/workflows/sql/73_homeowner_ledger_view_last_viewed_best_effort.sql',
  'aws/workflows/sql/74_homeowner_signing_rls_boundary.sql',
]);

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

test('this workstream does not touch API write-allowlist, signature submit, or SQL73/SQL74', () => {
  const parent = '784469e85c1b46b8cf2735aa2d6833a00fe2bbc6';
  const changed = execFileSync(
    'git',
    ['diff', '--name-only', parent, 'HEAD'],
    { cwd: ROOT, encoding: 'utf8' },
  )
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (const rel of FROZEN) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), rel);
    assert.ok(!changed.includes(rel), `${rel} must stay untouched`);
  }
  assert.ok(!changed.includes('aws/functions/api/write-signature.mjs'));
  assert.ok(!changed.includes('aws/functions/api/homeowner.mjs'));
  assert.deepEqual(changed.sort(), [
    'aws/tests/signature-request-spa-write-allowlist.test.mjs',
    CLIENT_REL,
  ]);
});

test('source write-allowlist is not broadened by this SPA repair', () => {
  const allowlist = read('aws/functions/api/write-allowlist.mjs');
  assert.doesNotMatch(allowlist, /signature_requests/);
  assert.doesNotMatch(allowlist, /signature_signers/);
  const sql73 = sha256('aws/workflows/sql/73_homeowner_ledger_view_last_viewed_best_effort.sql');
  const sql74 = sha256('aws/workflows/sql/74_homeowner_signing_rls_boundary.sql');
  assert.equal(sql73.length, 64);
  assert.equal(sql74.length, 64);
});
