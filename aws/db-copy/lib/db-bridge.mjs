/**
 * Read-only production DB bridge helpers for PR #127.
 * Never logs row contents, PII, tokens, or signed URLs.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';

export const DB_BRIDGE_URL =
  'https://nbcqwpysqgyxrrbgtmkw.supabase.co/functions/v1/aws-staging-db-bridge';
export const BASELINE_CUTOFF = '2026-09-01T20:36:44.000Z';
export const BASELINE_DUMP_KEY = 'Migration/checksops_260901(1).backup';
export const BASELINE_DUMP_BYTES = 49100401;
export const REDACTED_SENTINEL = '[redacted]';
export const LIVE_PAGE_SIZE = 500;
export const STAGING_ONLY_TABLES = Object.freeze([
  'identity_accounts',
  'aws_provider_sandbox_operations',
  '_checksops_restore_complete',
  'homeowner_upload_otp_sessions',
]);
export const REQUIRED_HEALTH = Object.freeze({
  ok: true,
  mode: 'read_only',
  writes: false,
  deletes: false,
  rpc: false,
  rawSql: false,
});
export const REQUIRED_ACTIONS = Object.freeze([
  'health',
  'tables',
  'schema',
  'counts',
  'rows',
  'identity_map',
]);
export const FINANCIAL_ROW_METRICS = Object.freeze([
  { metric: 'check_intake_amount', table: 'check_intake_items', column: 'amount' },
  { metric: 'check_intake_pa_fee_amount', table: 'check_intake_items', column: 'pa_fee_amount' },
  { metric: 'deposit_items_amount', table: 'deposit_items', column: 'amount' },
  { metric: 'deposit_batches_total_amount', table: 'deposit_batches', column: 'total_amount' },
  { metric: 'checkalt_deposits_amount', table: 'checkalt_deposits', column: 'amount' },
  { metric: 'disbursement_splits_amount', table: 'disbursement_splits', column: 'amount' },
  { metric: 'disbursement_batches_check_amount', table: 'disbursement_batches', column: 'check_amount' },
  { metric: 'disbursement_batches_amount_reserved_cents', table: 'disbursement_batches', column: 'amount_reserved_cents' },
  { metric: 'claim_check_payments_check_amount', table: 'claim_check_payments', column: 'check_amount' },
  { metric: 'claim_check_payments_payment_amount', table: 'claim_check_payments', column: 'payment_amount' },
  { metric: 'payment_transfers_amount_cents', table: 'payment_transfers', column: 'amount_cents' },
  { metric: 'payment_wallet_ledger_amount_cents', table: 'payment_wallet_ledger', column: 'amount_cents' },
  { metric: 'claim_payments_amount', table: 'claim_payments', column: 'amount' },
  { metric: 'homeowner_ledger_amount', table: 'homeowner_ledger_events', column: 'amount' },
]);

export const sha256Hex = (value) => createHash('sha256').update(String(value)).digest('hex');

export const parseCountTableNames = (sql) => {
  const names = [];
  const first = sql.match(/SELECT '([a-z0-9_]+)' AS table_name/i);
  if (first) names.push(first[1]);
  for (const match of sql.matchAll(/UNION ALL SELECT '([a-z0-9_]+)'/gi)) names.push(match[1]);
  return names;
};

export const loadBusinessTableNames = (countsSqlPath) =>
  parseCountTableNames(fs.readFileSync(countsSqlPath, 'utf8'));

export const isDbBridgeHealthy = (body = {}) => (
  body.ok === true
  && body.mode === 'read_only'
  && body.writes === false
  && body.deletes === false
  && body.rpc === false
  && body.rawSql === false
);

export const healthFailures = (body = {}) => {
  const failures = [];
  for (const [key, expected] of Object.entries(REQUIRED_HEALTH)) {
    if (body[key] !== expected) failures.push({ key, expected, actual: body[key] ?? null });
  }
  return failures;
};

export const actionList = (actions) => {
  if (Array.isArray(actions)) return actions.map(String);
  if (actions && typeof actions === 'object') return Object.keys(actions);
  return [];
};

export const primaryKeyColumns = (tableSchema = {}) => {
  const columns = tableSchema.columns || [];
  const pks = columns.filter((col) => col.primaryKey).map((col) => col.name);
  if (pks.length) return pks;
  if (columns.some((col) => col.name === 'id')) return ['id'];
  return columns[0]?.name ? [columns[0].name] : ['id'];
};

export const redactedColumnNames = (tableSchema = {}) =>
  (tableSchema.columns || []).filter((col) => col.redacted).map((col) => col.name);

export const rowPrimaryKey = (row = {}, pkColumns = ['id']) =>
  pkColumns.map((col) => (row[col] == null ? '' : String(row[col]))).join('|');

export const timestampMs = (value) => {
  if (value == null || value === '') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

export const laterTimestamp = (left, right) => {
  const a = timestampMs(left);
  const b = timestampMs(right);
  if (a == null && b == null) return false;
  if (a == null || b == null) return a !== b;
  return a !== b;
};

export const classifyTableDelta = ({
  baselineKeys = new Map(),
  currentKeys = new Map(),
} = {}) => {
  const inserted = [];
  const updated = [];
  const deleted = [];
  const unchanged = [];
  for (const [pk, current] of currentKeys) {
    const baseline = baselineKeys.get(pk);
    if (!baseline) {
      inserted.push(pk);
      continue;
    }
    const currentUpdated = current?.updated_at ?? current?.updatedAt ?? null;
    const baselineUpdated = baseline?.updated_at ?? baseline?.updatedAt ?? null;
    const currentCreated = current?.created_at ?? current?.createdAt ?? null;
    const baselineCreated = baseline?.created_at ?? baseline?.createdAt ?? null;
    if (laterTimestamp(currentUpdated, baselineUpdated) || laterTimestamp(currentCreated, baselineCreated)) {
      updated.push(pk);
    } else {
      unchanged.push(pk);
    }
  }
  for (const pk of baselineKeys.keys()) {
    if (!currentKeys.has(pk)) deleted.push(pk);
  }
  return { inserted, updated, deleted, unchanged };
};

export const summarizeDelta = (classified = {}) => ({
  inserted: (classified.inserted || []).length,
  updated: (classified.updated || []).length,
  deleted: (classified.deleted || []).length,
  unchanged: (classified.unchanged || []).length,
});

export const reconstructKeys = (classified = {}) => [
  ...(classified.inserted || []),
  ...(classified.updated || []),
];

export const stripRedactedFields = (row = {}, redactedColumns = []) => {
  const out = {};
  const skipped = [];
  const redacted = new Set(redactedColumns);
  for (const [key, value] of Object.entries(row)) {
    if (value === REDACTED_SENTINEL || (redacted.has(key) && value !== null)) {
      skipped.push(key);
      continue;
    }
    out[key] = value;
  }
  return { row: out, skippedSecretColumns: skipped };
};

export const preserveNullnessOnly = (value) => {
  if (value === REDACTED_SENTINEL) return { include: false, value: undefined };
  return { include: true, value };
};

export const approvedBusinessTables = ({
  bridgeTables = [],
  excluded = [],
  viewNames = [],
  businessTableNames = [],
} = {}) => {
  const excludedSet = new Set(excluded);
  const viewSet = new Set(viewNames);
  const businessSet = new Set(businessTableNames);
  const stagingSet = new Set(STAGING_ONLY_TABLES);
  const approved = [];
  const skippedViews = [];
  const skippedExcluded = [];
  const skippedStagingOnly = [];
  const newSinceBaseline = [];
  for (const name of bridgeTables) {
    if (excludedSet.has(name)) {
      skippedExcluded.push(name);
      continue;
    }
    if (viewSet.has(name) || name.endsWith('_view') || name.endsWith('_dashboard') || name === 'geography_columns' || name === 'geometry_columns') {
      skippedViews.push(name);
      continue;
    }
    if (stagingSet.has(name)) {
      skippedStagingOnly.push(name);
      continue;
    }
    if (businessSet.size && !businessSet.has(name)) newSinceBaseline.push(name);
    approved.push(name);
  }
  const missingFromBridge = [...businessSet].filter((name) => (
    !bridgeTables.includes(name) && !excludedSet.has(name)
  ));
  return {
    approved,
    skippedViews,
    skippedExcluded,
    skippedStagingOnly,
    newSinceBaseline,
    missingFromBridge,
  };
};

export const countMapFromRows = (rows = []) => {
  const out = {};
  for (const row of rows) {
    if (row?.table_name) out[row.table_name] = Number(row.row_count);
  }
  return out;
};

export const numericCounts = (counts = {}) => {
  const out = {};
  let sum = 0;
  let zeros = 0;
  let failed = 0;
  for (const [table, value] of Object.entries(counts)) {
    const n = Number(value);
    if (!Number.isFinite(n)) {
      failed += 1;
      continue;
    }
    out[table] = n;
    sum += n;
    if (n === 0) zeros += 1;
  }
  return { counts: out, sumRows: sum, zeroTables: zeros, numericTables: Object.keys(out).length, failed };
};

export const sumColumn = (rows = [], column) =>
  rows.reduce((total, row) => {
    const n = Number(row?.[column]);
    return total + (Number.isFinite(n) ? n : 0);
  }, 0);

export const financialFromRows = (rowsByTable = {}) => {
  const out = {};
  for (const spec of FINANCIAL_ROW_METRICS) {
    out[spec.metric] = sumColumn(rowsByTable[spec.table] || [], spec.column);
  }
  const endorsements = rowsByTable.check_endorsements || [];
  const intake = new Map((rowsByTable.check_intake_items || []).map((row) => [String(row.id), row]));
  out.endorsed_check_intake_amount = endorsements.reduce((total, row) => {
    const intakeRow = intake.get(String(row.check_id));
    const n = Number(intakeRow?.amount);
    return total + (Number.isFinite(n) ? n : 0);
  }, 0);
  return out;
};

export const roundMoney = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
};

export const diffNumericMaps = (left = {}, right = {}, { money = false } = {}) => {
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  const diffs = [];
  for (const key of keys) {
    const a = money ? roundMoney(left[key]) : Number(left[key]);
    const b = money ? roundMoney(right[key]) : Number(right[key]);
    if (a !== b) diffs.push({ key, left: left[key] ?? null, right: right[key] ?? null });
  }
  return diffs;
};

export const sanitizeIdentityMap = (payload = {}) => {
  const profiles = Array.isArray(payload.profiles) ? payload.profiles : [];
  const memberships = Array.isArray(payload.tenantMemberships) ? payload.tenantMemberships : [];
  const roles = Array.isArray(payload.applicationRoles) ? payload.applicationRoles : [];
  const roleCounts = {};
  for (const row of roles) {
    const role = String(row.role || 'unknown');
    roleCounts[role] = (roleCounts[role] || 0) + 1;
  }
  const membershipRoleCounts = {};
  for (const row of memberships) {
    const role = String(row.role || 'unknown');
    membershipRoleCounts[role] = (membershipRoleCounts[role] || 0) + 1;
  }
  return {
    note: payload.note || null,
    profiles: profiles.length,
    profileIdFingerprints: profiles.map((row) => sha256Hex(row.id || row.user_id || '')).sort(),
    tenantMemberships: memberships.length,
    tenantIds: [...new Set(memberships.map((row) => row.tenant_id).filter(Boolean))].length,
    membershipUserFingerprints: [...new Set(memberships.map((row) => sha256Hex(row.user_id || '')))].sort(),
    membershipRoleCounts,
    applicationRoles: roles.length,
    applicationRoleCounts: roleCounts,
    applicationUserFingerprints: [...new Set(roles.map((row) => sha256Hex(row.user_id || '')))].sort(),
  };
};

export const sanitizeColumnList = (spec = {}) =>
  (spec.columns || []).map((col) => ({
    name: col.name,
    type: col.type || null,
    nullable: col.nullable !== false,
    primaryKey: Boolean(col.primaryKey),
    redacted: Boolean(col.redacted),
  }));

export const sanitizeSchemaCatalog = (schemaByTable = {}) => {
  const out = {};
  const redactedByTable = {};
  for (const [table, spec] of Object.entries(schemaByTable)) {
    const columns = (spec.columns || []).map((col) => ({
      name: col.name,
      type: col.type || null,
      nullable: col.nullable !== false,
      primaryKey: Boolean(col.primaryKey),
      hasForeignKey: Boolean(col.foreignKey),
      redacted: Boolean(col.redacted),
    }));
    out[table] = {
      columnCount: columns.length,
      primaryKey: columns.filter((col) => col.primaryKey).map((col) => col.name),
      redactedColumns: columns.filter((col) => col.redacted).map((col) => col.name),
    };
    if (out[table].redactedColumns.length) redactedByTable[table] = out[table].redactedColumns;
  }
  return { tables: out, redactedByTable };
};

export const countDiffVsBaseline = (currentCounts = {}, baselineCounts = {}, skip = new Set()) => {
  const diffs = [];
  const keys = [...new Set([...Object.keys(currentCounts), ...Object.keys(baselineCounts)])].sort();
  for (const table of keys) {
    if (skip.has(table)) continue;
    const current = Number(currentCounts[table]);
    const baseline = Number(baselineCounts[table]);
    if (!Number.isFinite(current) || !Number.isFinite(baseline)) continue;
    if (current !== baseline) {
      diffs.push({
        table,
        baseline,
        current,
        delta: current - baseline,
      });
    }
  }
  return diffs;
};

export const keysToMap = (rows = [], pkColumns = ['id']) => {
  const map = new Map();
  for (const row of rows) {
    const pk = rowPrimaryKey(row, pkColumns);
    if (!pk) continue;
    map.set(pk, {
      created_at: row.created_at ?? row.createdAt ?? null,
      updated_at: row.updated_at ?? row.updatedAt ?? null,
    });
  }
  return map;
};

export const parseCopyKeyset = (sqlText, { pkColumns = ['id'], table } = {}) => {
  const map = new Map();
  if (!sqlText) return map;
  const copyRe = new RegExp(
    `COPY\\s+(?:public\\.)?${table}\\s*\\(([^)]+)\\)\\s+FROM\\s+stdin;`,
    'i',
  );
  const match = sqlText.match(copyRe);
  if (!match) return map;
  const columns = match[1].split(',').map((part) => part.trim().replaceAll('"', ''));
  const pkIdx = pkColumns.map((col) => columns.indexOf(col));
  if (pkIdx.some((idx) => idx < 0)) return map;
  const createdIdx = columns.indexOf('created_at');
  const updatedIdx = columns.indexOf('updated_at');
  const body = sqlText.slice(match.index + match[0].length);
  const lines = body.split('\n');
  for (const line of lines) {
    if (line === '\\.') break;
    if (!line || line.startsWith('--')) continue;
    const fields = splitCopyLine(line);
    const pk = pkIdx.map((idx) => decodeCopyField(fields[idx])).join('|');
    if (!pk) continue;
    map.set(pk, {
      created_at: createdIdx >= 0 ? decodeCopyField(fields[createdIdx]) : null,
      updated_at: updatedIdx >= 0 ? decodeCopyField(fields[updatedIdx]) : null,
    });
  }
  return map;
};

export const splitCopyLine = (line) => {
  const fields = [];
  let current = '';
  let escaped = false;
  for (const ch of line) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '\t') {
      fields.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  fields.push(current);
  return fields;
};

export const decodeCopyField = (raw) => {
  if (raw == null || raw === '\\N') return null;
  return String(raw)
    .replaceAll('\\t', '\t')
    .replaceAll('\\n', '\n')
    .replaceAll('\\\\', '\\');
};

export const batchesOf = (items, size) => {
  const out = [];
  const n = Math.max(1, Number(size) || 1);
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
};

export const gateStatus = (pass, blocked = false) => {
  if (blocked) return 'FAIL';
  return pass ? 'PASS' : 'FAIL';
};

export const skippedMissingTables = (tableSummary = []) =>
  (tableSummary || [])
    .filter((row) => row?.skipped === 'missing_on_rehearsal' && row.table)
    .map((row) => row.table)
    .sort();

export const overlayUpsertedRows = (tableSummary = []) =>
  (tableSummary || []).reduce((sum, row) => sum + Number(row.upserted || 0), 0);

/**
 * Honest rehearsal verdict. Missing production tables on rehearsal are PARTIAL/NO-GO
 * even when the 166-table recon SQL still matches. Cutover is never authorized here.
 */
export const rehearsalVerdict = ({
  failClosed = false,
  restoreOk = false,
  deltaOk = false,
  recon = {},
  skippedMissing = [],
} = {}) => {
  const gates = [
    'countsStatus',
    'financialStatus',
    'fkStatus',
    'tenantStatus',
    'pkStatus',
    'identityStatus',
    'membershipStatus',
    'nullStatus',
  ];
  const gatesPass = gates.every((key) => recon[key] === 'PASS');
  const ddlOutstanding = skippedMissing.length > 0;
  const dbComplete = Boolean(failClosed && restoreOk && deltaOk && gatesPass && !ddlOutstanding);
  return {
    bridge: failClosed ? 'PASS' : 'FAIL',
    database: dbComplete ? 'PASS' : ((restoreOk && deltaOk) ? 'PARTIAL' : 'FAIL'),
    storage: 'PASS',
    overall: dbComplete && failClosed ? 'PASS' : (failClosed ? 'PARTIAL' : 'FAIL'),
    goNoGo: dbComplete && failClosed ? 'GO for data migration readiness' : 'NO-GO',
    productionCutover: 'STOP FOR REVIEW — production cutover not performed',
    note: ddlOutstanding
      ? `Outstanding DDL/overlay for: ${skippedMissing.join(', ')}`
      : 'Migratable application counts, financial aggregates, critical PK fingerprints, membership/roles, and FK checks matched live production on isolated rehearsal.',
  };
};
