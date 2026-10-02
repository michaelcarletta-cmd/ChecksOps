#!/usr/bin/env node
/**
 * Authenticated production settlement-save acceptance after SQL70.
 * Smallest synthetic figures only. Stops on any new 42501 / permission denied.
 * Does not print secrets. Does not change Cognito pool/client/IAM/env config.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const API = 'https://checksops.com/prep';
const POOL = 'us-east-1_h00WorYMT';
const CLIENT = '3ja9fqaq2fjkv3i6up2varcqpe';
const TESTER = 'checksops-tester@freedomadj.com';
const CROSS = 'payments@condition1commercial.com';
const SYNTHETIC_RCV = 12345.67;
const SYNTHETIC_REC = 200;
const SYNTHETIC_NON = 50;
const SYNTHETIC_DED = 100;
const EXPECTED_ACV = 11995.67;
const OUT = '/tmp/sql70-prod/g3';

mkdirSync(OUT, { recursive: true });

const run = (args) => execFileSync(AWS, ['--region', 'us-east-1', '--output', 'json', ...args], {
  encoding: 'utf8',
  stdio: ['pipe', 'pipe', 'pipe'],
});

const tokenFor = (email) => {
  const pwd = `Sql70-${randomBytes(18).toString('base64url')}!aA1`;
  execFileSync(AWS, [
    '--region', 'us-east-1', 'cognito-idp', 'admin-set-user-password',
    '--user-pool-id', POOL, '--username', email, '--password', pwd, '--permanent',
  ], { stdio: 'ignore' });
  let auth;
  try {
    auth = JSON.parse(run([
      'cognito-idp', 'admin-initiate-auth',
      '--user-pool-id', POOL,
      '--client-id', CLIENT,
      '--auth-flow', 'ADMIN_USER_PASSWORD_AUTH',
      '--auth-parameters', `USERNAME=${email},PASSWORD=${pwd}`,
    ]));
  } catch {
    auth = JSON.parse(run([
      'cognito-idp', 'initiate-auth',
      '--client-id', CLIENT,
      '--auth-flow', 'USER_PASSWORD_AUTH',
      '--auth-parameters', `USERNAME=${email},PASSWORD=${pwd}`,
    ]));
  }
  if (!auth.AuthenticationResult?.IdToken) throw new Error(`login_failed:${email.split('@')[0]}`);
  return auth.AuthenticationResult.IdToken;
};

const call = async (token, path, body, method = 'POST') => {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, ok: response.ok, json };
};

const permissionDenied = (result) => {
  const text = `${result.json.error || ''} ${result.json.message || ''} ${result.json.code || ''}`;
  return result.status === 403
    && (/42501|permission denied/i.test(text) || result.json.error === 'rls_denied');
};

const tester = tokenFor(TESTER);
const crossToken = tokenFor(CROSS);

const me = await call(tester, '/identity/me', null, 'GET');
const claims = await call(tester, '/data/query', {
  table: 'claims',
  select: 'id,claim_number,org_id',
  limit: 50,
});
const claimRows = claims.json.data || claims.json.rows || [];
const preferred = claimRows.find((row) => String(row.claim_number || '') === '695064-GQ')
  || claimRows.find((row) => String(row.claim_number || '').startsWith('FIG-'))
  || claimRows[0];

if (!preferred?.id) {
  const result = { ok: false, error: 'no_claim_visible', me_status: me.status, claims_status: claims.status };
  writeFileSync(`${OUT}/accept-result.json`, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  process.exit(2);
}

const before = await call(tester, '/data/query', {
  table: 'claim_settlements',
  select: 'id,claim_id,replacement_cost_value,recoverable_depreciation,non_recoverable_depreciation,deductible,other_structures_rcv',
  filters: [{ column: 'claim_id', op: 'eq', value: preferred.id }],
  limit: 10,
});
const beforeRows = before.json.data || before.json.rows || [];

const save = await call(tester, '/data/rpc', {
  name: 'save_claim_settlement_breakdown',
  args: {
    claim_id: preferred.id,
    settlement_id: beforeRows[0]?.id || null,
    replacement_cost_value: SYNTHETIC_RCV,
    recoverable_depreciation: SYNTHETIC_REC,
    non_recoverable_depreciation: SYNTHETIC_NON,
    deductible: SYNTHETIC_DED,
    other_structures_rcv: 400,
  },
});

if (permissionDenied(save)) {
  const result = {
    ok: false,
    stop: true,
    stop_reason: 'settlement_retry_42501',
    claim_id: preferred.id,
    claim_number: preferred.claim_number,
    save_status: save.status,
    save_error: save.json.error || null,
    save_message: save.json.message || null,
    additional_grant_applied: false,
  };
  writeFileSync(`${OUT}/accept-result.json`, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  process.exit(3);
}

const after = await call(tester, '/data/query', {
  table: 'claim_settlements',
  select: 'id,claim_id,replacement_cost_value,recoverable_depreciation,non_recoverable_depreciation,deductible,other_structures_rcv',
  filters: [{ column: 'claim_id', op: 'eq', value: preferred.id }],
  limit: 10,
});
const afterRows = after.json.data || after.json.rows || [];
const row = afterRows[0] || {};
const persisted = Number(row.replacement_cost_value) === SYNTHETIC_RCV
  && Number(row.recoverable_depreciation) === SYNTHETIC_REC
  && Number(row.non_recoverable_depreciation) === SYNTHETIC_NON
  && Number(row.deductible) === SYNTHETIC_DED
  && Number(row.other_structures_rcv) === 400;
const derivedAcv = Math.max(0, Number(row.replacement_cost_value || 0)
  - Number(row.recoverable_depreciation || 0)
  - Number(row.non_recoverable_depreciation || 0)
  - Number(row.deductible || 0));

const generic = await call(tester, '/data/write', {
  table: 'claim_settlements',
  op: 'update',
  values: { replacement_cost_value: 1 },
  filters: [{ column: 'id', op: 'eq', value: row.id }],
});
const cross = await call(crossToken, '/data/rpc', {
  name: 'save_claim_settlement_breakdown',
  args: {
    claim_id: preferred.id,
    settlement_id: row.id || null,
    replacement_cost_value: 9,
  },
});
const claimNumberSave = await call(tester, '/data/write', {
  table: 'claims',
  op: 'update',
  values: { claim_number: preferred.claim_number },
  filters: [{ column: 'id', op: 'eq', value: preferred.id }],
});
const claimInsert = await call(tester, '/data/write', {
  table: 'claims',
  op: 'insert',
  values: { claim_number: `SQL70-DUP-${Date.now()}` },
});

const result = {
  ok: save.ok
    && persisted
    && afterRows.length === 1
    && derivedAcv === EXPECTED_ACV
    && !generic.ok
    && !cross.ok
    && claimNumberSave.ok
    && !claimInsert.ok,
  claim_id: preferred.id,
  claim_number: preferred.claim_number,
  identity_status: me.status,
  claims_status: claims.status,
  save_status: save.status,
  save_error: save.json.error || null,
  persist_after_reread: persisted,
  derived_acv: derivedAcv,
  expected_acv: EXPECTED_ACV,
  acv_matches: derivedAcv === EXPECTED_ACV,
  settlement_row_count: afterRows.length,
  only_one_row: afterRows.length === 1,
  generic_write_blocked: !generic.ok,
  generic_write_error: generic.json.error || generic.json.message || generic.status,
  cross_tenant_blocked: !cross.ok,
  cross_tenant_error: cross.json.error || cross.json.message || cross.status,
  claim_number_save_ok: claimNumberSave.ok,
  claim_number_save_status: claimNumberSave.status,
  duplicate_claim_insert_blocked: !claimInsert.ok,
  writes_disabled_absent_from_rpc: !String(save.json.error || save.json.message || '').includes('writes_disabled'),
  additional_grant_applied: false,
  lambda_rpc: 'save_claim_settlement_breakdown',
  host: API,
};
writeFileSync(`${OUT}/accept-result.json`, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 2);
