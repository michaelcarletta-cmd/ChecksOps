import { pathToFileURL } from 'node:url';

const API = 'https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging';
const ISSUER = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_vPmQ7cL1F';
const CLIENT = '71bb7a192cbl6o6s8m259tl589';
const TABLES = new Set([
  'tenants', 'profiles', 'tenant_users', 'user_roles', 'claims',
  'check_intake_items', 'check_endorsements', 'deposit_batches', 'deposit_items',
  'checkalt_deposits', 'disbursement_batches', 'disbursement_splits',
  'payment_provider_accounts', 'payment_wallets', 'payment_webhook_events',
  'homeowner_ledger_events',
]);
const KINDS = new Set([
  'permission', 'missing_relation', 'function', 'missing_fk', 'query',
  'wrong_database', 'count_mismatch', 'trigger', 'supabase_dependency',
  'secretsManager', 'networkTls', 'authentication', 'select1', 'unknown',
]);
const PROBES = new Set([
  'privileges', 'sentinel', 'schema_usage', 'auth_users', 'auth_users_fks',
  'triggers', 'functions', 'auth_uid_privilege', 'auth.uid()',
]);
const MESSAGE_PROBES = new Map([
  ['restore sentinel public._checksops_restore_complete is missing', 'sentinel'],
  ['USAGE denied on schema public', 'schema_public_usage'],
  ['USAGE unexpectedly granted on schema storage', 'schema_storage_usage'],
]);

class DiagnosticError extends Error {}
const fail = (classification) => { throw new DiagnosticError(classification); };
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const label = (value, allowed) => allowed.has(value) ? value : 'unknown';
const count = (value) => Number.isSafeInteger(value) && value >= 0;

function issueProbe(item) {
  if (item.probe !== undefined) return label(item.probe, PROBES);
  if (MESSAGE_PROBES.has(item.message)) return MESSAGE_PROBES.get(item.message);
  if (item.kind === 'wrong_database') return 'database_identity';
  if (item.kind === 'trigger') return 'triggers';
  if (item.kind === 'missing_fk' && count(item.restored)) return 'auth_users_fks';
  if (item.kind === 'count_mismatch') return 'restore_count';
  if (item.kind === 'permission') {
    if (typeof item.message === 'string' && item.message.startsWith('connected as ')) return 'role_identity';
    if (typeof item.message === 'string' && item.message.startsWith('RLS enablement is incomplete')) return 'rls_enablement';
    if (TABLES.has(item.table)) {
      if (count(item.rowCount)) return 'rls_fail_closed';
      if (typeof item.canInsert === 'boolean') return 'write_privileges';
      if (item.message === `SELECT denied on public.${item.table}`) return 'select_privilege';
      if (item.message === `FORCE ROW LEVEL SECURITY is set on public.${item.table}`) return 'force_rls';
    }
  }
  return 'unknown';
}

export function summarizeValidation(body, httpStatus) {
  if (!object(body) || body.service !== 'checksops-api' || body.environment !== 'staging'
    || typeof body.ok !== 'boolean' || body.readOnly !== true || body.writesAttempted !== false
    || !Array.isArray(body.issues) || !Array.isArray(body.tables)
    || body.issues.length > 256 || body.tables.length > 16
    || !body.issues.every((item) => object(item) && ['error', 'expected'].includes(item.severity))
    || !body.tables.every(object)
    || httpStatus !== (body.ok ? 200 : 503)) {
    fail('authenticated_validation_contract_rejected');
  }
  const issues = body.issues.filter((item) => item.severity === 'error').map((item) => {
    const result = { kind: label(item.kind, KINDS), severity: 'error', probe: issueProbe(item) };
    if (item.table !== undefined) result.table = label(item.table, TABLES);
    if (['restore_count', 'rls_fail_closed'].includes(result.probe)) {
      if (count(item.rowCount)) result.actualCount = item.rowCount;
      const expected = result.probe === 'rls_fail_closed' ? 0 : item.expectedCount;
      if (count(expected)) result.expectedCount = expected;
    }
    if (result.probe === 'triggers') {
      if (count(body.catalog?.publicTriggers)) result.actualCount = body.catalog.publicTriggers;
      result.expectedCount = 165;
    }
    if (result.probe === 'auth_users_fks') {
      if (count(item.restored)) result.actualCount = item.restored;
      result.expectedCount = 47;
    }
    return result;
  });
  const tableChecks = body.tables.filter((row) => (
    row.present !== true || row.countMatches !== true || Boolean(row.error)
  )).map((row) => ({
    table: label(row.table, TABLES),
    probe: row.present !== true ? 'relation_presence' : row.error ? 'table_query' : 'count_assertion',
  }));
  return { httpStatus, status: body.ok ? 'ok' : 'unhealthy', readOnly: true, issues, tableChecks };
}

function stagingToken(token) {
  try {
    if (typeof token !== 'string' || token.split('.').length !== 3 || /[\r\n]/.test(token)) return false;
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return claims.iss === ISSUER && claims.aud === CLIENT && claims.token_use === 'id'
      && Number.isSafeInteger(claims.exp) && claims.exp > Math.floor(Date.now() / 1000) + 60;
  } catch {
    return false;
  }
}

export async function runDiagnostic({ env = process.env, fetchImpl = fetch } = {}) {
  if (env.GITHUB_REF !== 'refs/heads/main' || env.GITHUB_EVENT_NAME !== 'workflow_dispatch'
    || env.GITHUB_REPOSITORY !== 'michaelcarletta-cmd/ChecksOps') fail('workflow_scope_rejected');
  const refreshToken = env.CHECKSOPS_STAGING_DIAGNOSTIC_REFRESH_TOKEN;
  if (typeof refreshToken !== 'string' || !refreshToken.trim()) fail('staging_identity_unavailable');
  try {
    const refresh = await fetchImpl(`${API}/auth/refresh`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
    if (refresh.status !== 200) fail('staging_identity_rejected');
    const session = await refresh.json();
    const token = session?.authentication?.idToken;
    // Scope check before sending; the existing API verifies the JWT signature.
    if (session?.ok !== true || !stagingToken(token)) fail('staging_identity_rejected');
    const response = await fetchImpl(`${API}/db-readonly-validate`, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: ['Bearer', token].join(' ') },
      redirect: 'error',
      signal: AbortSignal.timeout(60000),
    });
    if (![200, 503].includes(response.status)) fail('validation_http_rejected');
    return summarizeValidation(await response.json(), response.status);
  } catch (error) {
    if (error instanceof DiagnosticError) throw error;
    fail('diagnostic_request_failed');
  }
}

export async function main(options = {}) {
  try {
    const summary = await runDiagnostic(options);
    console.log(JSON.stringify(summary));
    return summary.status === 'ok' ? 0 : 1;
  } catch (error) {
    console.log(JSON.stringify({
      status: 'diagnostic_failed',
      classification: error instanceof DiagnosticError ? error.message : 'diagnostic_request_failed',
    }));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
