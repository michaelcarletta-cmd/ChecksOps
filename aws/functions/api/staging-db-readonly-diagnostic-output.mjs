import {
  CORE_TABLES,
  EXPECTED_ROW_COUNTS,
  EXPECTED_PUBLIC_TRIGGERS,
  EXPECTED_SKIPPED_AUTH_USERS_FKS,
} from '../api/db-readonly-validate.mjs';

const TABLES = new Set(CORE_TABLES);
const KINDS = new Set([
  'permission', 'missing_relation', 'function', 'missing_fk', 'query',
  'wrong_database', 'count_mismatch', 'trigger', 'supabase_dependency',
  'secretsManager', 'networkTls', 'authentication', 'select1', 'unknown',
]);
const CHECKS = new Set([
  'database_identity', 'application_role', 'row_count', 'table_presence',
  'table_query', 'privileges', 'sentinel', 'schema_usage', 'auth_users',
  'auth_users_fks', 'triggers', 'functions', 'auth_uid_privilege',
  'auth.uid()', 'unclassified',
]);
const SCHEMAS = ['public', 'auth', 'storage', 'extensions'];
const RLS_MODES = new Set(['off', 'on', 'partial']);
const safeCount = (value) => Number.isSafeInteger(value) && value >= 0;
const safeBoolean = (value) => typeof value === 'boolean' ? value : null;
const countOrNull = (value) => safeCount(value) ? value : null;

const issueCheck = (item) => {
  if (CHECKS.has(item.probe)) return item.probe;
  if (item.kind === 'wrong_database') return 'database_identity';
  if (item.kind === 'count_mismatch') return 'row_count';
  if (item.kind === 'missing_relation') return TABLES.has(item.table) ? 'table_presence' : 'sentinel';
  if (item.kind === 'trigger') return 'triggers';
  if (item.kind === 'missing_fk') return 'auth_users_fks';
  if (item.kind === 'permission') return 'privileges';
  return 'unclassified';
};

const projectIssues = (issues) => (Array.isArray(issues) ? issues : [])
  .slice(0, 512)
  .filter((item) => item && ['error', 'expected'].includes(item.severity))
  .map((item) => {
    const result = {
      check: issueCheck(item),
      classification: KINDS.has(item.kind) ? item.kind : 'unknown',
      status: item.severity === 'error' ? 'fail' : 'expected',
    };
    if (TABLES.has(item.table)) result.table = item.table;
    if (result.check === 'row_count' && result.table
        && safeCount(item.expectedCount) && safeCount(item.rowCount)) {
      result.expectedCount = item.expectedCount;
      result.actualCount = item.rowCount;
    }
    return result;
  });

const projectTables = (tables) => CORE_TABLES.map((table) => {
  const row = Array.isArray(tables) ? tables.find((item) => item?.table === table) : null;
  return {
    table,
    status: row?.present === true && row?.countMatches === true && !row?.error ? 'pass' : 'fail',
    present: row?.present === true,
    countMatches: row?.countMatches === true,
    expectedCount: safeCount(row?.expectedCount) ? row.expectedCount : EXPECTED_ROW_COUNTS[table],
    actualCount: countOrNull(row?.rowCount),
  };
});

const projectPrivileges = (privileges) => (Array.isArray(privileges) ? privileges : [])
  .filter((row) => TABLES.has(row?.table))
  .slice(0, CORE_TABLES.length)
  .map((row) => ({
    table: row.table,
    canSelect: safeBoolean(row.canSelect),
    canInsert: safeBoolean(row.canInsert),
    canUpdate: safeBoolean(row.canUpdate),
    canDelete: safeBoolean(row.canDelete),
    rlsEnabled: safeBoolean(row.rlsEnabled),
    rlsForced: safeBoolean(row.rlsForced),
  }));

const projectCatalog = (validation) => {
  const catalog = validation.catalog || {};
  const summary = validation.rlsAudit?.summary || {};
  return {
    sentinelPresent: safeBoolean(catalog.sentinelPresent),
    schemaUsage: Object.fromEntries(SCHEMAS.map((schema) => [
      schema,
      safeBoolean(catalog.schemaUsage?.[schema]),
    ])),
    authUsersPresent: safeBoolean(catalog.authUsersPresent),
    restoredAuthUsersForeignKeys: countOrNull(catalog.restoredAuthUsersForeignKeys),
    expectedSkippedAuthUsersForeignKeys: EXPECTED_SKIPPED_AUTH_USERS_FKS,
    publicTriggers: countOrNull(catalog.publicTriggers),
    expectedPublicTriggers: EXPECTED_PUBLIC_TRIGGERS,
    publicFunctions: countOrNull(catalog.publicFunctions),
    supabaseAuthUidFunctions: countOrNull(catalog.supabaseAuthUidFunctions),
    supabaseNetFunctions: countOrNull(catalog.supabaseNetFunctions),
    supabaseCronFunctions: countOrNull(catalog.supabaseCronFunctions),
    supabaseVaultFunctions: countOrNull(catalog.supabaseVaultFunctions),
    supabasePgmqFunctions: countOrNull(catalog.supabasePgmqFunctions),
    canExecuteAuthUid: safeBoolean(catalog.canExecuteAuthUid),
    rlsMode: RLS_MODES.has(validation.rlsMode) ? validation.rlsMode : 'unknown',
    rlsSummary: {
      tableCount: countOrNull(summary.tableCount),
      rlsEnabled: countOrNull(summary.rlsEnabled),
      rlsForced: countOrNull(summary.rlsForced),
      tenantSensitive: countOrNull(summary.tenantSensitive),
      missingRls: countOrNull(summary.missingRls),
      missingSelect: countOrNull(summary.missingSelect),
      unforcedEnabled: countOrNull(summary.unforcedEnabled),
    },
  };
};

export const projectValidation = (validation = {}) => {
  const issues = projectIssues(validation.issues);
  if (validation.ok === false && !issues.some((item) => item.status === 'fail')) {
    issues.push({ check: 'unclassified', classification: 'unknown', status: 'fail' });
  }
  const tables = projectTables(validation.tables);
  const ok = validation.ok === true
    && tables.every((row) => row.status === 'pass')
    && !issues.some((item) => item.status === 'fail');
  return {
    schema: 'checksops-staging-db-readonly-diagnostic/v1',
    environment: 'staging',
    status: ok ? 'ok' : 'unhealthy',
    readOnly: true,
    writesAttempted: false,
    issues,
    tables,
    privileges: projectPrivileges(validation.privileges),
    catalog: projectCatalog(validation),
  };
};

export const summarizeInvocation = ({ metadata, payload, expectedVersion }) => {
  if (!metadata || metadata.FunctionError || metadata.ExecutedVersion !== expectedVersion) {
    return {
      schema: 'checksops-staging-db-readonly-diagnostic/v1',
      environment: 'staging',
      status: 'diagnostic_failed',
      classification: metadata?.ExecutedVersion !== expectedVersion
        ? 'target_version_mismatch'
        : 'invocation_failed',
      readOnly: true,
      writesAttempted: false,
    };
  }

  let response;
  try {
    response = typeof payload === 'string' ? JSON.parse(payload) : payload;
  } catch {
    response = null;
  }
  if (!response || response.schema !== 'checksops-staging-db-readonly-diagnostic/v1'
      || response.environment !== 'staging'
      || !['ok', 'unhealthy'].includes(response.status)
      || response.readOnly !== true || response.writesAttempted !== false
      || !Array.isArray(response.issues) || !Array.isArray(response.tables)
      || response.tables.length !== CORE_TABLES.length
      || !response.tables.every((row, index) => row?.table === CORE_TABLES[index])
      || response.issues.length > 512) {
    return {
      schema: 'checksops-staging-db-readonly-diagnostic/v1',
      environment: 'staging',
      status: 'diagnostic_failed',
      classification: 'response_contract_mismatch',
      readOnly: true,
      writesAttempted: false,
    };
  }
  return projectValidation({
    ok: response.status === 'ok',
    readOnly: response.readOnly,
    writesAttempted: response.writesAttempted,
    issues: response.issues.map((item) => ({
      kind: item.classification,
      severity: item.status === 'fail' ? 'error' : 'expected',
      probe: item.check,
      table: item.table,
      expectedCount: item.expectedCount,
      rowCount: item.actualCount,
    })),
    tables: response.tables.map((row) => ({
      ...row,
      error: row.status === 'fail' && row.present && row.countMatches ? true : null,
    })),
    privileges: response.privileges,
    catalog: response.catalog,
    rlsMode: response.catalog?.rlsMode,
    rlsAudit: { summary: response.catalog?.rlsSummary },
  });
};
