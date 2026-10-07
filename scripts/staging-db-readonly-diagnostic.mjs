import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const ENDPOINT = 'https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging/db-readonly-validate';
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

class DiagnosticError extends Error {}

export const createStagingVerifier = () => {
  const require = createRequire(new URL('../aws/functions/api/package.json', import.meta.url));
  const { CognitoJwtVerifier } = require('aws-jwt-verify');
  return CognitoJwtVerifier.create({
    userPoolId: 'us-east-1_vPmQ7cL1F',
    clientId: '71bb7a192cbl6o6s8m259tl589',
    tokenUse: 'id',
  });
};

const verifyStagingToken = (token) => createStagingVerifier().verify(token);

const safeCount = (value) => Number.isSafeInteger(value) && value >= 0;

// Messages are matched only to fixed assertion labels, never copied to output.
const assertionProbe = (item) => {
  if (PROBES.has(item.probe)) return item.probe;
  if (item.kind === 'wrong_database') return 'database_identity';
  if (item.kind === 'trigger') return 'triggers';
  if (item.kind === 'count_mismatch') return 'row_count';
  if (item.kind === 'missing_fk') return 'auth_users_fks';
  if (item.kind === 'missing_relation') return TABLES.has(item.table) ? 'table_presence' : 'sentinel';
  if (item.kind === 'permission') {
    const message = typeof item.message === 'string' ? item.message : '';
    if (message.startsWith('connected as ')) return 'application_role';
    if (message.startsWith('SELECT denied on public.')) return 'select_privilege';
    if (message.startsWith('write privilege present on public.')) return 'write_privilege';
    if (message.startsWith('FORCE ROW LEVEL SECURITY is set on public.')) return 'force_rls';
    if (message.startsWith('RLS enablement is incomplete on core tables (')) return 'rls_enablement';
    if (TABLES.has(item.table) && Object.hasOwn(item, 'rowCount')) return 'rls_visibility';
    if (message === 'USAGE denied on schema public') return 'public_schema_usage';
    if (message === 'USAGE unexpectedly granted on schema storage') return 'storage_schema_usage';
  }
  return 'unclassified';
};

export const summarizeValidation = (body, httpStatus) => {
  if (!body || body.service !== 'checksops-api' || body.environment !== 'staging'
      || body.readOnly !== true || body.writesAttempted !== false
      || typeof body.ok !== 'boolean' || !Array.isArray(body.issues)
      || !Array.isArray(body.tables) || body.issues.length > 512 || body.tables.length > 16
      || httpStatus !== (body.ok ? 200 : 503)) {
    throw new DiagnosticError('response_contract_mismatch');
  }
  const issues = [];
  for (const item of body.issues) {
    if (!item || !['error', 'expected'].includes(item.severity)) {
      throw new DiagnosticError('response_contract_mismatch');
    }
    if (item.severity !== 'error') continue;
    const entry = {
      kind: KINDS.has(item.kind) ? item.kind : 'unclassified',
      severity: 'error',
      probe: assertionProbe(item),
    };
    if (TABLES.has(item.table)) entry.table = item.table;
    if (entry.table && ['row_count', 'rls_visibility'].includes(entry.probe)
        && safeCount(item.rowCount) && safeCount(item.expectedCount)) {
      entry.expectedCount = entry.probe === 'rls_visibility' ? 0 : item.expectedCount;
      entry.actualCount = item.rowCount;
    }
    if (entry.probe === 'triggers' && safeCount(body.catalog?.publicTriggers)) {
      entry.expectedCount = 165;
      entry.actualCount = body.catalog.publicTriggers;
    }
    if (entry.probe === 'auth_users_fks' && safeCount(item.restored)) {
      entry.expectedCount = 47;
      entry.actualCount = item.restored;
    }
    issues.push(entry);
  }
  for (const row of body.tables) {
    if (!row || !TABLES.has(row.table)) throw new DiagnosticError('response_contract_mismatch');
    if (row.present === true && row.countMatches === true && !row.error) continue;
    if (!issues.some((item) => item.table === row.table)) {
      issues.push({
        kind: 'table_validation', severity: 'error', table: row.table,
        probe: row.present !== true ? 'table_presence' : row.error ? 'table_query' : 'row_count',
      });
    }
  }
  if (body.ok && issues.length) throw new DiagnosticError('response_contract_mismatch');
  if (!body.ok && !issues.length) {
    issues.push({ kind: 'unclassified', severity: 'error', probe: 'validation_contract' });
  }
  return { httpStatus, status: body.ok ? 'ok' : 'unhealthy', issues };
};

export const diagnose = async ({ token, fetchImpl = fetch, verifyToken = verifyStagingToken } = {}) => {
  if (typeof token !== 'string' || !token || token.length > 16384 || /\s/.test(token)) {
    throw new DiagnosticError('staging_identity_unavailable');
  }
  try {
    await verifyToken(token);
  } catch {
    throw new DiagnosticError('staging_identity_rejected');
  }
  let response;
  try {
    response = await fetchImpl(ENDPOINT, {
      method: 'GET',
      headers: { authorization: ['Bearer', token].join(' '), accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw new DiagnosticError('diagnostic_request_failed');
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw new DiagnosticError('response_contract_mismatch');
  }
  return summarizeValidation(body, response.status);
};

export const main = async ({
  token,
  fetchImpl, verifyToken, writeOutput = console.log,
} = {}) => {
  try {
    const summary = await diagnose({ token, fetchImpl, verifyToken });
    writeOutput(JSON.stringify(summary));
    return summary.status === 'ok' ? 0 : 1;
  } catch (error) {
    writeOutput(JSON.stringify({
      status: 'diagnostic_failed',
      classification: error instanceof DiagnosticError ? error.message : 'diagnostic_failed',
    }));
    return 2;
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
