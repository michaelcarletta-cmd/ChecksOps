#!/usr/bin/env node
/**
 * Authenticated application smoke against the production-prep API.
 * Does not print emails, tokens, or passwords.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { EXPECTED_EIGHT, TESTER_ID, C1C_ADMIN_ID } from '../../identity/expected-mappings.mjs';

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const API = process.env.T0_API_BASE || 'https://checksops.com/prep';
const POOL = 'us-east-1_h00WorYMT';
const CLIENT = '3ja9fqaq2fjkv3i6up2varcqpe';

const tokenFor = (email) => {
  const pwd = `T0-${randomBytes(24).toString('base64url')}!aA1`;
  execFileSync(AWS, [
    '--region', 'us-east-1', 'cognito-idp', 'admin-set-user-password',
    '--user-pool-id', POOL, '--username', email, '--password', pwd, '--permanent',
  ], { stdio: 'ignore' });
  const auth = JSON.parse(execFileSync(AWS, [
    '--region', 'us-east-1', '--output', 'json',
    'cognito-idp', 'initiate-auth',
    '--client-id', CLIENT,
    '--auth-flow', 'USER_PASSWORD_AUTH',
    '--auth-parameters', `USERNAME=${email},PASSWORD=${pwd}`,
  ], { encoding: 'utf8' }));
  return auth.AuthenticationResult?.IdToken;
};

const call = async (token, path, body, method = 'POST') => {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
};

const tester = EXPECTED_EIGHT.find((row) => row.applicationUserId === TESTER_ID);
const c1c = EXPECTED_EIGHT.find((row) => row.applicationUserId === C1C_ADMIN_ID);
const testerToken = tokenFor(tester.email);
const c1cToken = tokenFor(c1c.email);

const testerChecks = await call(testerToken, '/data/query', {
  table: 'check_intake_items',
  select: 'id,tenant_id,front_image_path,created_at',
  limit: 200,
});
const c1cChecks = await call(c1cToken, '/data/query', {
  table: 'check_intake_items',
  select: 'id,tenant_id',
  limit: 200,
});
const testerRows = testerChecks.json.data || testerChecks.json.rows || [];
const c1cRows = c1cChecks.json.data || c1cChecks.json.rows || [];
const testerTenants = [...new Set(testerRows.map((row) => row.tenant_id).filter(Boolean))];
const c1cTenants = [...new Set(c1cRows.map((row) => row.tenant_id).filter(Boolean))];
const overlap = testerTenants.filter((id) => c1cTenants.includes(id));
const testerTenantRows = await call(testerToken, '/data/query', { table: 'tenants', select: 'id,slug', limit: 20 });
const c1cTenantRows = await call(c1cToken, '/data/query', { table: 'tenants', select: 'id,slug', limit: 20 });
const testerTenantData = testerTenantRows.json.data || [];
const c1cTenantData = c1cTenantRows.json.data || [];

const prepare = await call(testerToken, '/financial/prepare', {});
const simulate = await call(testerToken, '/financial/simulate-submit', {});
const reconcile = await call(testerToken, '/financial/reconcile', {});
const readiness = await call(testerToken, '/ops/readiness', undefined, 'GET');

const sorted = [...testerRows].sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
const historicalRow = sorted[0] || null;
const currentRow = sorted[sorted.length - 1] || null;
const signPath = (row) => {
  const raw = row?.front_image_path;
  return raw ? String(raw).split('?')[0] : null;
};
const historicalPath = signPath(historicalRow);
const currentPath = signPath(currentRow);
const historicalSigned = historicalPath
  ? await call(testerToken, '/storage/sign', { bucket: 'claim-files', path: historicalPath })
  : { status: 0, json: {} };
const currentSigned = currentPath
  ? await call(testerToken, '/storage/sign', { bucket: 'claim-files', path: currentPath })
  : { status: 0, json: {} };
const tenantsDiffer = Boolean(testerTenantData[0]?.id && c1cTenantData[0]?.id && testerTenantData[0].id !== c1cTenantData[0].id);

const writeRes = historicalRow?.id
  ? await call(testerToken, '/data/write', {
    table: 'check_message_reads',
    op: 'upsert',
    values: { check_id: historicalRow.id },
  })
  : { status: 0, json: { error: 'no_check' } };
const writeOk = writeRes.status === 200 && writeRes.json.ok === true && !writeRes.json.error;
const writeCount = Number(writeRes.json.count || (Array.isArray(writeRes.json.data) ? writeRes.json.data.length : 0));

const report = {
  ok: Boolean(testerToken && c1cToken)
    && testerChecks.status === 200
    && c1cChecks.status === 200
    && testerChecks.json.applicationUserId === TESTER_ID
    && c1cChecks.json.applicationUserId === C1C_ADMIN_ID
    && testerRows.length > 0
    && tenantsDiffer
    && Boolean(prepare.json.error || prepare.status >= 400)
    && Boolean(simulate.json.error || simulate.status >= 400)
    && historicalSigned.json.ok === true
    && currentSigned.json.ok === true
    && writeOk,
  authentication: { tester: Boolean(testerToken), c1c: Boolean(c1cToken) },
  dbReads: {
    testerStatus: testerChecks.status,
    testerError: testerChecks.json.error || null,
    testerKeys: Object.keys(testerChecks.json || {}),
    testerRowField: Array.isArray(testerChecks.json.rows) ? testerChecks.json.rows.length
      : Array.isArray(testerChecks.json.data) ? testerChecks.json.data.length
      : null,
    c1cStatus: c1cChecks.status,
    c1cError: c1cChecks.json.error || null,
    testerAppUser: testerChecks.json.applicationUserId || null,
    c1cAppUser: c1cChecks.json.applicationUserId || null,
    testerExpected: TESTER_ID,
    c1cExpected: C1C_ADMIN_ID,
    testerMapped: testerChecks.json.applicationUserId === TESTER_ID,
    c1cMapped: c1cChecks.json.applicationUserId === C1C_ADMIN_ID,
    testerChecks: testerRows.length,
    c1cChecks: c1cRows.length,
    testerTenants: testerTenants.length,
    c1cTenants: c1cTenants.length,
  },
  tenantIsolation: {
    overlapTenants: overlap.length,
    testerTenantRows: testerTenantData.length,
    c1cTenantRows: c1cTenantData.length,
    testerCheckTenantIds: testerTenants.length,
    c1cChecks: c1cRows.length,
    tenantsDiffer,
    pass: testerChecks.json.applicationUserId === TESTER_ID
      && c1cChecks.json.applicationUserId === C1C_ADMIN_ID
      && tenantsDiffer
      && testerRows.length > 0
      && c1cRows.length === 0,
  },
  financialBlocked: {
    prepare: { status: prepare.status, error: prepare.json.error || null },
    simulate: { status: simulate.status, error: simulate.json.error || null },
    reconcile: { status: reconcile.status, error: reconcile.json.error || reconcile.json.ok === false || null },
  },
  historicalImage: {
    sampleFound: Boolean(historicalPath),
    signed: historicalSigned.status === 200 && historicalSigned.json.ok === true,
    signError: historicalSigned.json.error || null,
    pathLogged: false,
  },
  currentImage: {
    sampleFound: Boolean(currentPath),
    signed: currentSigned.status === 200 && currentSigned.json.ok === true,
    signError: currentSigned.json.error || null,
    distinctFromHistorical: Boolean(historicalRow?.id && currentRow?.id && historicalRow.id !== currentRow.id),
    pathLogged: false,
  },
  nonFinancialWrite: {
    table: 'check_message_reads',
    op: 'upsert',
    status: writeRes.status,
    ok: writeOk,
    rows: Number.isFinite(writeCount) ? writeCount : null,
    error: writeRes.json.error || null,
  },
  readiness: {
    status: readiness.status,
    holdsOk: readiness.json.holds?.ok === true,
  },
};
mkdirSync('/tmp/t0', { recursive: true });
writeFileSync('/tmp/t0/app-smoke-predns.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
