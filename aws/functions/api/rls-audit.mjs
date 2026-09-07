/**
 * Catalog-only RLS inventory. No tenant row data, bank fields, or secrets.
 * Does not ALTER tables. FORCE is evaluated, not applied here.
 */
import pg from 'pg';
import { loadDatabaseCredentials } from './secrets.mjs';
import { buildClientConfig, sanitizePublicError } from './db-health.mjs';

const { Client } = pg;

export const TENANT_COLUMNS = ['tenant_id', 'org_id', 'deposited_by_tenant_id'];

export const INTENTIONALLY_UNFORCED = [
  'identity_accounts',
  'spatial_ref_sys',
];

const ROLE_SQL = `SELECT rolname, rolsuper, rolbypassrls
FROM pg_roles
WHERE rolname IN ('checksops', 'checksops_admin', 'postgres', 'rdsadmin')
ORDER BY rolname`;

const TABLE_SQL = `SELECT c.relname AS table,
       pg_get_userbyid(c.relowner) AS owner,
       c.relrowsecurity AS rls_enabled,
       c.relforcerowsecurity AS rls_forced,
       EXISTS (
         SELECT 1 FROM information_schema.columns col
         WHERE col.table_schema = 'public'
           AND col.table_name = c.relname
           AND col.column_name = ANY($1::text[])
       ) AS has_tenant_column
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
ORDER BY c.relname`;

const POLICY_SQL = `SELECT tablename, cmd, count(*)::int AS n
FROM pg_policies
WHERE schemaname = 'public'
GROUP BY tablename, cmd
ORDER BY tablename, cmd`;

export const evaluateForceRls = ({ roles = [], tables = [] } = {}) => {
  const checksops = roles.find((row) => row.rolname === 'checksops') || {};
  const admin = roles.find((row) => row.rolname === 'checksops_admin') || {};
  const ownerNames = [...new Set(tables.map((row) => row.owner).filter(Boolean))];
  const appOwnsTables = ownerNames.includes('checksops');
  const adminBypass = admin.rolbypassrls === true || admin.rolsuper === true;
  const appBypass = checksops.rolbypassrls === true || checksops.rolsuper === true;
  const safeForApp = !appOwnsTables && appBypass !== true;
  const safeForBridges = adminBypass === true || !ownerNames.includes('checksops_admin');
  return {
    recommended: false,
    applied: false,
    reason: 'FORCE would apply to table owners used by migration/admin bridges. App role is already subject to RLS because it is not the table owner. Do not FORCE from the production Lambda role.',
    appOwnsTables,
    appBypass: Boolean(appBypass),
    adminBypass: Boolean(adminBypass),
    ownerNames,
    safeForApp,
    safeForBridges,
    wouldBreakExecutionModel: true,
  };
};

export const summarizeRlsMatrix = (tables = [], policies = []) => {
  const policyMap = new Map();
  for (const row of policies) {
    const current = policyMap.get(row.tablename) || { SELECT: 0, INSERT: 0, UPDATE: 0, DELETE: 0, ALL: 0 };
    current[row.cmd] = Number(row.n || 0);
    policyMap.set(row.tablename, current);
  }
  const matrix = tables.map((row) => {
    const cmds = policyMap.get(row.table) || { SELECT: 0, INSERT: 0, UPDATE: 0, DELETE: 0, ALL: 0 };
    const covered = (cmd) => cmds.ALL > 0 || cmds[cmd] > 0;
    const tenantSensitive = row.has_tenant_column === true && !INTENTIONALLY_UNFORCED.includes(row.table);
    return {
      table: row.table,
      owner: row.owner,
      rlsEnabled: row.rls_enabled === true,
      rlsForced: row.rls_forced === true,
      tenantSensitive,
      select: covered('SELECT'),
      insert: covered('INSERT'),
      update: covered('UPDATE'),
      delete: covered('DELETE'),
    };
  });
  const missingRls = matrix.filter((row) => row.tenantSensitive && !row.rlsEnabled).map((row) => row.table);
  const missingForce = matrix.filter((row) => row.rlsEnabled && !row.rlsForced).length;
  const missingSelect = matrix.filter((row) => row.rlsEnabled && row.tenantSensitive && !row.select).map((row) => row.table);
  return {
    tableCount: matrix.length,
    rlsEnabled: matrix.filter((row) => row.rlsEnabled).length,
    rlsForced: matrix.filter((row) => row.rlsForced).length,
    tenantSensitive: matrix.filter((row) => row.tenantSensitive).length,
    missingRls,
    missingSelect,
    unforcedEnabled: missingForce,
    matrix,
  };
};

export const runRlsAudit = async ({
  loadCredentials = loadDatabaseCredentials,
  createClient = (config) => new Client(config),
} = {}) => {
  let client;
  try {
    const credentials = await loadCredentials();
    client = createClient(buildClientConfig(credentials, { queryTimeoutMillis: 12000 }));
    await client.connect();
    const roles = (await client.query(ROLE_SQL)).rows;
    const tables = (await client.query(TABLE_SQL, [TENANT_COLUMNS])).rows;
    const policies = (await client.query(POLICY_SQL)).rows;
    const summary = summarizeRlsMatrix(tables, policies);
    const force = evaluateForceRls({ roles, tables });
    return {
      ok: summary.missingRls.length === 0 && summary.missingSelect.length === 0,
      currentUser: (await client.query('SELECT current_user AS current_user')).rows[0]?.current_user || null,
      roles: roles.map((row) => ({
        rolname: row.rolname,
        rolsuper: row.rolsuper === true,
        rolbypassrls: row.rolbypassrls === true,
      })),
      force,
      summary: {
        tableCount: summary.tableCount,
        rlsEnabled: summary.rlsEnabled,
        rlsForced: summary.rlsForced,
        tenantSensitive: summary.tenantSensitive,
        missingRls: summary.missingRls,
        missingSelect: summary.missingSelect,
        unforcedEnabled: summary.unforcedEnabled,
      },
      matrix: summary.matrix,
    };
  } catch (error) {
    return {
      ok: false,
      error: 'rls_audit_failed',
      message: sanitizePublicError(error),
    };
  } finally {
    if (client) {
      try { await client.end(); } catch { /* ignore */ }
    }
  }
};
