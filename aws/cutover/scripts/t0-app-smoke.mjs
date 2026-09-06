#!/usr/bin/env node
/**
 * Authenticated application smoke against the production-prep API.
 * Does not print emails, tokens, or passwords.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EXPECTED_EIGHT, TESTER_ID, C1C_ADMIN_ID } from '../../identity/expected-mappings.mjs';

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const API = 'https://kiqojucc02.execute-api.us-east-1.amazonaws.com/prep';
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
  select: 'id,tenant_id',
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

const sampleId = testerRows[0]?.id;
const oneCheck = sampleId ? await call(testerToken, '/data/query', {
  table: 'check_intake_items',
  select: 'id,front_image_path,back_image_path',
  filters: [{ column: 'id', op: 'eq', value: sampleId }],
  limit: 1,
}) : { status: 0, json: {} };
const oneRow = Array.isArray(oneCheck.json.data) ? oneCheck.json.data[0] : oneCheck.json.data;
const frontPath = oneRow?.front_image_path || null;
const objectPath = frontPath ? String(frontPath).split('?')[0] : null;
const signed = objectPath ? await call(testerToken, '/storage/sign', { bucket: 'claim-files', path: objectPath }) : { status: 0, json: {} };
const tenantsDiffer = Boolean(testerTenantData[0]?.id && c1cTenantData[0]?.id && testerTenantData[0].id !== c1cTenantData[0].id);

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
    && signed.json.ok === true,
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
    sampleFound: Boolean(frontPath),
    signed: signed.status === 200 && signed.json.ok === true,
    signError: signed.json.error || null,
    pathLogged: false,
  },
};
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
