import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  BASELINE_CUTOFF,
  REDACTED_SENTINEL,
  REQUIRED_ACTIONS,
  STAGING_ONLY_TABLES,
  approvedBusinessTables,
  classifyTableDelta,
  countDiffVsBaseline,
  decodeCopyField,
  financialFromRows,
  healthFailures,
  isDbBridgeHealthy,
  keysToMap,
  parseCopyKeyset,
  parseCountTableNames,
  preserveNullnessOnly,
  primaryKeyColumns,
  reconstructKeys,
  rowPrimaryKey,
  overlayUpsertedRows,
  rehearsalVerdict,
  sanitizeIdentityMap,
  sanitizeSchemaCatalog,
  skippedMissingTables,
  stripRedactedFields,
  summarizeDelta,
} from '../lib/db-bridge.mjs';
import { filterRestoreToc, shouldSkipRestoreTocLine } from '../lib/restore-toc.mjs';
import {
  pickAllowlistedValues,
  WRITE_ALLOWLIST,
} from '../../functions/api/write-allowlist.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const countsSql = fs.readFileSync(path.join(here, '../sql/reconciliation_counts.sql'), 'utf8');

test('db bridge health is fail-closed on write/sql flags', () => {
  assert.equal(isDbBridgeHealthy({
    ok: true, mode: 'read_only', writes: false, deletes: false, rpc: false, rawSql: false,
  }), true);
  assert.equal(isDbBridgeHealthy({
    ok: true, mode: 'read_only', writes: true, deletes: false, rpc: false, rawSql: false,
  }), false);
  assert.equal(healthFailures({
    ok: true, mode: 'read_write', writes: false, deletes: false, rpc: false, rawSql: false,
  }).some((f) => f.key === 'mode'), true);
  assert.deepEqual(REQUIRED_ACTIONS, ['health', 'tables', 'schema', 'counts', 'rows', 'identity_map']);
});

test('reconciliation SQL lists 167 business tables including financial_stepup_log', () => {
  const names = parseCountTableNames(countsSql);
  assert.equal(names.length, 167);
  assert.ok(names.includes('check_intake_items'));
  assert.ok(names.includes('tenants'));
  assert.ok(names.includes('financial_stepup_log'));
  assert.equal(new Set(names).size, 167);
});

test('approved business tables skip views, excluded secrets, and staging-only tables', () => {
  const sorted = approvedBusinessTables({
    bridgeTables: [
      'tenants',
      'check_intake_items',
      'tenant_openai_credentials',
      'identity_accounts',
      'contractor_directory_view',
      'deposit_aging_dashboard',
      'tenant_safe',
    ],
    excluded: ['tenant_openai_credentials'],
    viewNames: ['contractor_directory_view'],
    businessTableNames: parseCountTableNames(countsSql),
  });
  assert.deepEqual(sorted.approved, ['tenants', 'check_intake_items', 'tenant_safe']);
  assert.deepEqual(sorted.skippedExcluded, ['tenant_openai_credentials']);
  assert.ok(sorted.skippedViews.includes('contractor_directory_view'));
  assert.ok(sorted.skippedViews.includes('deposit_aging_dashboard'));
  assert.deepEqual(sorted.skippedStagingOnly, ['identity_accounts']);
  assert.deepEqual(sorted.newSinceBaseline, ['tenant_safe']);
  assert.ok(STAGING_ONLY_TABLES.includes('identity_accounts'));
});

test('keyset delta classifies insert/update/delete/unchanged', () => {
  const baseline = keysToMap([
    { id: 'a', created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z' },
    { id: 'b', created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z' },
    { id: 'c', created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z' },
  ]);
  const current = keysToMap([
    { id: 'a', created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z' },
    { id: 'b', created_at: '2026-08-01T00:00:00Z', updated_at: '2026-09-03T00:00:00Z' },
    { id: 'd', created_at: '2026-09-04T00:00:00Z', updated_at: '2026-09-04T00:00:00Z' },
  ]);
  const delta = classifyTableDelta({ baselineKeys: baseline, currentKeys: current });
  assert.deepEqual(delta.unchanged, ['a']);
  assert.deepEqual(delta.updated, ['b']);
  assert.deepEqual(delta.deleted, ['c']);
  assert.deepEqual(delta.inserted, ['d']);
  assert.deepEqual(summarizeDelta(delta), { inserted: 1, updated: 1, deleted: 1, unchanged: 1 });
  assert.deepEqual(reconstructKeys(delta), ['d', 'b']);
});

test('redacted sentinel is omitted and null-ness is preserved', () => {
  const stripped = stripRedactedFields({
    id: 'x',
    api_key: REDACTED_SENTINEL,
    webhook_secret: null,
    name: 'ok',
  }, ['api_key', 'webhook_secret']);
  assert.equal('api_key' in stripped.row, false);
  assert.equal(stripped.row.webhook_secret, null);
  assert.equal(stripped.row.name, 'ok');
  assert.ok(stripped.skippedSecretColumns.includes('api_key'));
  assert.deepEqual(preserveNullnessOnly(REDACTED_SENTINEL), { include: false, value: undefined });
  assert.deepEqual(preserveNullnessOnly(null), { include: true, value: null });
});

test('identity_map sanitizer keeps counts and fingerprints, never emails', () => {
  const sanitized = sanitizeIdentityMap({
    note: 'auth schema is not exposed',
    profiles: [{ id: '11111111-1111-1111-1111-111111111111', email: 'hidden@example.com', full_name: 'Hidden' }],
    tenantMemberships: [{ tenant_id: 't1', user_id: '11111111-1111-1111-1111-111111111111', role: 'admin' }],
    applicationRoles: [{ user_id: '11111111-1111-1111-1111-111111111111', role: 'admin' }],
  });
  const blob = JSON.stringify(sanitized);
  assert.equal(sanitized.profiles, 1);
  assert.equal(sanitized.tenantMemberships, 1);
  assert.equal(sanitized.applicationRoles, 1);
  assert.doesNotMatch(blob, /hidden@example.com/i);
  assert.doesNotMatch(blob, /Hidden/);
  assert.equal(sanitized.profileIdFingerprints[0].length, 64);
});

test('schema sanitizer reports redacted column names only', () => {
  const sanitized = sanitizeSchemaCatalog({
    tenants: {
      columns: [
        { name: 'id', type: 'uuid', nullable: false, primaryKey: true, foreignKey: null, redacted: false },
        { name: 'webhook_secret', type: 'text', nullable: true, primaryKey: false, redacted: true },
      ],
    },
  });
  assert.deepEqual(sanitized.tables.tenants.primaryKey, ['id']);
  assert.deepEqual(sanitized.redactedByTable.tenants, ['webhook_secret']);
  assert.deepEqual(primaryKeyColumns({
    columns: [
      { name: 'id', type: 'uuid', primaryKey: true },
      { name: 'webhook_secret', redacted: true },
    ],
  }), ['id']);
});

test('COPY keyset parser extracts pk and timestamps without keeping other fields', () => {
  const sql = [
    'COPY public.tenants (id, name, created_at, updated_at) FROM stdin;',
    'aaa\tSecret Tenant\t2026-08-01 00:00:00+00\t2026-08-02 00:00:00+00',
    '\\.',
    '',
  ].join('\n');
  const map = parseCopyKeyset(sql, { table: 'tenants', pkColumns: ['id'] });
  assert.equal(map.size, 1);
  assert.equal(map.get('aaa').created_at, '2026-08-01 00:00:00+00');
  assert.equal(decodeCopyField('\\N'), null);
  assert.equal(rowPrimaryKey({ zip: '73099' }, ['zip']), '73099');
});

test('financial aggregates from reconstruct rows are report-only sums', () => {
  const fin = financialFromRows({
    check_intake_items: [
      { id: 'c1', amount: 10.5, pa_fee_amount: 1 },
      { id: 'c2', amount: 2, pa_fee_amount: 0 },
    ],
    check_endorsements: [{ id: 'e1', check_id: 'c1' }],
    deposit_items: [{ amount: 3 }],
    deposit_batches: [{ total_amount: 3 }],
    checkalt_deposits: [{ amount: 1 }],
    disbursement_splits: [{ amount: 4 }],
    disbursement_batches: [{ check_amount: 4, amount_reserved_cents: 0 }],
    claim_check_payments: [],
    payment_transfers: [],
    payment_wallet_ledger: [],
    claim_payments: [{ amount: 5 }],
    homeowner_ledger_events: [{ amount: 6 }],
  });
  assert.equal(fin.check_intake_amount, 12.5);
  assert.equal(fin.endorsed_check_intake_amount, 10.5);
  assert.equal(fin.claim_payments_amount, 5);
});

test('count diffs vs Sept 1 baseline skip PostGIS catalog noise', () => {
  const diffs = countDiffVsBaseline(
    { tenants: 6, spatial_ref_sys: 8500, check_intake_items: 194 },
    { tenants: 6, spatial_ref_sys: 0, check_intake_items: 182 },
    new Set(['spatial_ref_sys']),
  );
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].table, 'check_intake_items');
  assert.equal(diffs[0].delta, 12);
  assert.ok(BASELINE_CUTOFF.startsWith('2026-09-01'));
});

test('restore TOC filter skips policies, ACLs, excluded schemas, and auth FKs', () => {
  const toc = [
    '; archive',
    '1; 1259 10 TABLE public tenants postgres',
    '2; 0 0 ACL public tenants postgres',
    '3; 0 0 POLICY public tenants tenants_policy postgres',
    '4; 1259 11 TABLE auth users supabase_auth_admin',
    '5; 2606 12 FK CONSTRAINT public audit_logs audit_logs_user_id_fkey postgres',
    '6; 1259 13 TABLE public check_intake_items postgres',
  ].join('\n');
  const filtered = filterRestoreToc(toc, new Set(['audit_logs_user_id_fkey']));
  assert.equal(shouldSkipRestoreTocLine('2; 0 0 ACL public tenants postgres'), true);
  assert.ok(filtered.kept.includes('TABLE public tenants'));
  assert.ok(filtered.kept.includes('check_intake_items'));
  assert.equal(filtered.kept.includes('ACL'), false);
  assert.equal(filtered.kept.includes('POLICY'), false);
  assert.equal(filtered.kept.includes('auth users'), false);
  assert.equal(filtered.kept.includes('audit_logs_user_id_fkey'), false);
});

test('skipped overlay tables force PARTIAL / NO-GO even when recon gates pass', () => {
  assert.deepEqual(skippedMissingTables([
    { table: 'tenants', upserted: 6 },
    { table: 'financial_stepup_log', skipped: 'missing_on_rehearsal' },
  ]), ['financial_stepup_log']);
  assert.equal(overlayUpsertedRows([
    { table: 'tenants', upserted: 6 },
    { table: 'claims', upserted: 183 },
    { table: 'financial_stepup_log', skipped: 'missing_on_rehearsal' },
  ]), 189);

  const passingRecon = {
    countsStatus: 'PASS',
    financialStatus: 'PASS',
    fkStatus: 'PASS',
    tenantStatus: 'PASS',
    pkStatus: 'PASS',
    identityStatus: 'PASS',
    membershipStatus: 'PASS',
    nullStatus: 'PASS',
  };
  const withDdlGap = rehearsalVerdict({
    failClosed: true,
    restoreOk: true,
    deltaOk: true,
    recon: passingRecon,
    skippedMissing: ['financial_stepup_log'],
  });
  assert.equal(withDdlGap.bridge, 'PASS');
  assert.equal(withDdlGap.database, 'PARTIAL');
  assert.equal(withDdlGap.overall, 'PARTIAL');
  assert.equal(withDdlGap.goNoGo, 'NO-GO');
  assert.match(withDdlGap.productionCutover, /STOP FOR REVIEW/);

  const complete = rehearsalVerdict({
    failClosed: true,
    restoreOk: true,
    deltaOk: true,
    recon: passingRecon,
    skippedMissing: [],
  });
  assert.equal(complete.database, 'PASS');
  assert.equal(complete.goNoGo, 'GO for data migration readiness');
});

test('staging financial_stepup_log SQL matches production columns and omits preferred_auth_method', () => {
  const sql = fs.readFileSync(path.join(here, '../../write-path/sql/37_financial_stepup_log.sql'), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.financial_stepup_log/);
  for (const col of ['user_id', 'tenant_id', 'action_key', 'factor_type', 'succeeded', 'metadata', 'created_at', 'updated_at']) {
    assert.match(sql, new RegExp(`\\b${col}\\b`));
  }
  assert.match(sql, /idx_financial_stepup_log_user/);
  assert.match(sql, /idx_financial_stepup_log_tenant/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /aws_select_financial_stepup_log/);
  assert.match(sql, /aws_write_financial_stepup_log/);
  assert.match(sql, /GRANT SELECT, INSERT/);
  assert.equal(/preferred_auth_method/.test(sql), false);
  assert.equal(/user_passkeys/.test(sql), false);
  assert.equal(/64_financial_activation/.test(sql), false);
});

test('financial_stepup_log write allowlist is insert-only and ignores spoofed user_id', () => {
  assert.equal(WRITE_ALLOWLIST.financial_stepup_log.ops.has('insert'), true);
  assert.equal(WRITE_ALLOWLIST.financial_stepup_log.ops.has('update'), false);
  const denied = pickAllowlistedValues('financial_stepup_log', {
    user_id: '00000000-0000-0000-0000-000000000099',
    tenant_id: 'abd3c2a0-6dc0-4680-92dd-a013e1141c91',
    action_key: 'disburse',
    factor_type: 'totp',
    succeeded: true,
    amount: 12,
  });
  assert.equal(denied.error, 'column_not_allowlisted');
  const ok = pickAllowlistedValues('financial_stepup_log', {
    user_id: '00000000-0000-0000-0000-000000000099',
    tenant_id: 'abd3c2a0-6dc0-4680-92dd-a013e1141c91',
    action_key: 'disburse',
    factor_type: 'totp',
    succeeded: true,
  });
  assert.equal(ok.error, undefined);
  assert.equal(ok.values.user_id, undefined);
  assert.equal(ok.values.action_key, 'disburse');
});
