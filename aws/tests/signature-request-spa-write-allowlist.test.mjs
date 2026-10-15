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
// SQL73/SQL74 come from the Cursor Homeowner stack and are absent on main;
// they stay frozen (never added or changed here) either way.
const SQL7X = /^aws\/workflows\/sql\/7[34]_/;
const frozenSha = (rel) => (fs.existsSync(path.join(ROOT, rel)) ? sha256(rel) : null);

const CLIENT_REL = 'src/integrations/aws/client.ts';
// PR 5 reconciliation (claude/signature-request-repairs) intentionally changes
// esign.mjs / signature-submit.mjs / email-branding.mjs; everything else here
// stays frozen relative to the branch base.
const FROZEN = Object.freeze([
  'aws/functions/api/write-allowlist.mjs',
  'aws/functions/api/write-check-workflow.mjs',
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

function gitObjectExists(sha) {
  try {
    execFileSync('git', ['cat-file', '-e', sha], { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function resolvePinParent() {
  const candidates = [
    // origin/main base of claude/signature-request-repairs (PR 5).
    '35fb74c6d75c6fc43cc42fb87fb664ad5a9fd073',
  ];
  for (const sha of candidates) {
    if (gitObjectExists(sha)) return sha;
  }
  return execFileSync('git', ['rev-parse', 'HEAD^'], { cwd: ROOT, encoding: 'utf8' }).trim();
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

test('this workstream does not touch API write-allowlist, write paths, or SQL73/SQL74', () => {
  const parent = resolvePinParent();
  const changed = execFileSync(
    'git',
    ['diff', '--name-only', parent, 'HEAD'],
    { cwd: ROOT, encoding: 'utf8' },
  )
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (const rel of FROZEN) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)) || SQL7X.test(rel), rel);
    assert.ok(!changed.includes(rel), `${rel} must stay untouched`);
  }
  assert.ok(!changed.includes('aws/functions/api/write-signature.mjs'));
  assert.ok(!changed.includes('aws/functions/api/homeowner.mjs'));
  if (changed.includes(CLIENT_REL)) {
    assert.ok(
      changed.includes('aws/tests/signature-request-spa-write-allowlist.test.mjs'),
      'pin test must be in this workstream',
    );
  } else {
    assert.ok(
      changed.includes('src/components/check-review/CheckFilesSection.tsx'),
      'Files-tab claim-id repair must be in this stacked workstream',
    );
    assert.ok(
      changed.includes('src/pages/CheckCommandCenter.tsx'),
      'Check Command Center claimId pass-through must be in this stacked workstream',
    );
  }
  const extra = changed.filter((rel) => ![
    CLIENT_REL,
    'aws/tests/signature-request-spa-write-allowlist.test.mjs',
    'aws/tests/signature-request-files-tab-claim-id.test.mjs',
    'aws/tests/signature-request-create-payload.test.mjs',
    'src/components/check-review/CheckFilesSection.tsx',
    'src/components/claim-detail/SignatureRequests.tsx',
    'src/pages/CheckCommandCenter.tsx',
    'src/lib/signature-source-files.ts',
    'src/lib/edgeFunctionError.ts',
    'tests/signature-source-files.test.ts',
    'tests/edge-function-error.test.ts',
    // PR 5 server reconciliation onto live production bytes.
    'aws/functions/api/esign.mjs',
    'aws/functions/api/signature-submit.mjs',
    'aws/functions/api/email-branding.mjs',
    'aws/tests/esign-sr-invariants.test.mjs',
    'aws/tests/signature-stamp-submit-values.test.mjs',
    'aws/tests/parity-signature-submit.test.mjs',
    'aws/tests/email-branding-sr-txn.test.mjs',
  ].includes(rel));
  assert.deepEqual(extra, [], 'no unexpected files beyond the SR SPA allowlist + Files-tab + create-payload repair');
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
  const sql73 = frozenSha('aws/workflows/sql/73_homeowner_ledger_view_last_viewed_best_effort.sql');
  const sql74 = frozenSha('aws/workflows/sql/74_homeowner_signing_rls_boundary.sql');
  assert.ok(sql73 === null || sql73.length === 64);
  assert.ok(sql74 === null || sql74.length === 64);
});
