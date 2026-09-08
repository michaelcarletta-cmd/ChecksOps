#!/usr/bin/env node
/**
 * Batch 4 live validation + adversarial tenant isolation.
 * Does not print emails, passwords, tokens, or signed URLs.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { EXPECTED_EIGHT, TESTER_ID, C1C_ADMIN_ID } from '../../identity/expected-mappings.mjs';

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const API = 'https://kiqojucc02.execute-api.us-east-1.amazonaws.com/prep';
const POOL = 'us-east-1_h00WorYMT';
const CLIENT = '3ja9fqaq2fjkv3i6up2varcqpe';

const tokensFor = (email) => {
  const pwd = `B4-${randomBytes(24).toString('base64url')}!aA1`;
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
  return {
    challenge: auth.ChallengeName || null,
    idToken: auth.AuthenticationResult?.IdToken || null,
  };
};

const call = async (token, path, body, method = 'POST') => {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
    },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
};

const amzExpires = (url) => {
  if (!url) return null;
  try {
    return Number(new URL(url).searchParams.get('X-Amz-Expires'));
  } catch {
    return null;
  }
};

const tester = EXPECTED_EIGHT.find((row) => row.applicationUserId === TESTER_ID);
const c1c = EXPECTED_EIGHT.find((row) => row.applicationUserId === C1C_ADMIN_ID);
const testerAuth = tokensFor(tester.email);
const c1cAuth = tokensFor(c1c.email);

const site = await fetch('https://checksops.com/login', { redirect: 'manual' });
const readiness = await call(null, '/ops/readiness', undefined, 'GET');
const validate = await call(null, '/db-readonly-validate', undefined, 'GET');
const financial = await call(null, '/financial/status', undefined, 'GET');
const isolationTester = await call(testerAuth.idToken, '/authorization/isolation', {});
const isolationC1c = await call(c1cAuth.idToken, '/authorization/isolation', {
  user_id: TESTER_ID,
  tenant_id: 'spoof-tenant',
});

const testerChecks = await call(testerAuth.idToken, '/data/query', {
  table: 'check_intake_items',
  select: 'id,tenant_id,front_image_path,carrier_name',
  limit: 20,
});
const c1cChecks = await call(c1cAuth.idToken, '/data/query', {
  table: 'check_intake_items',
  select: 'id,tenant_id,front_image_path',
  limit: 20,
});
const testerRows = testerChecks.json.data || testerChecks.json.rows || [];
const c1cRows = c1cChecks.json.data || c1cChecks.json.rows || [];
const freedomCheck = testerRows.find((row) => row.front_image_path) || testerRows[0] || null;
const freedomPath = freedomCheck?.front_image_path
  ? String(freedomCheck.front_image_path).split('?')[0]
  : null;

const testerSign = freedomPath
  ? await call(testerAuth.idToken, '/storage/sign', { bucket: 'claim-files', path: freedomPath, expiresIn: 14400 })
  : { status: 0, json: {} };
const c1cSignFreedom = freedomPath
  ? await call(c1cAuth.idToken, '/storage/sign', { bucket: 'claim-files', path: freedomPath, expiresIn: 14400 })
  : { status: 0, json: {} };

const c1cUpdateFreedom = freedomCheck?.id
  ? await call(c1cAuth.idToken, '/data/write', {
    table: 'check_intake_items',
    op: 'update',
    values: { carrier_name: 'BATCH4_SHOULD_NOT_WRITE' },
    filters: { id: freedomCheck.id },
  })
  : { status: 0, json: { error: 'no_check' } };
const c1cInsertFreedom = await call(c1cAuth.idToken, '/data/write', {
  table: 'check_intake_items',
  op: 'insert',
  values: {
    tenant_id: freedomCheck?.tenant_id,
    carrier_name: 'BATCH4_SHOULD_NOT_INSERT',
  },
});
const c1cDeleteFreedom = freedomCheck?.id
  ? await call(c1cAuth.idToken, '/data/write', {
    table: 'check_intake_items',
    op: 'delete',
    filters: { id: freedomCheck.id },
  })
  : { status: 0, json: { error: 'no_check' } };
const c1cReadWrite = freedomCheck?.id
  ? await call(c1cAuth.idToken, '/data/write', {
    table: 'check_message_reads',
    op: 'upsert',
    values: { check_id: freedomCheck.id },
  })
  : { status: 0, json: { error: 'no_check' } };

const ownWrite = freedomCheck?.id
  ? await call(testerAuth.idToken, '/data/write', {
    table: 'check_message_reads',
    op: 'upsert',
    values: { check_id: freedomCheck.id },
  })
  : { status: 0, json: { error: 'no_check' } };

const denied = (res) => Boolean(res.status >= 400 || res.json?.ok === false || res.json?.error
  || Number(res.json?.count || 0) === 0 && res.json?.ok !== true);

const audit = validate.json.rlsAudit || {};
const flags = financial.json.flags || readiness.json.flags || {};
const report = {
  ok: Boolean(testerAuth.idToken && !testerAuth.challenge)
    && Boolean(c1cAuth.idToken && !c1cAuth.challenge)
    && site.status >= 200 && site.status < 400
    && readiness.json.holds?.ok === true
    && validate.status === 200
    && validate.json.failClosedWithoutIdentity === true
    && (audit.force?.applied === false)
    && (audit.force?.recommended === false)
    && Array.isArray(audit.summary?.missingRls)
    && testerChecks.status === 200
    && testerRows.length > 0
    && c1cRows.length === 0
    && isolationTester.json.checksVisible?.c1c === 0
    && isolationC1c.json.applicationUserId === C1C_ADMIN_ID
    && isolationC1c.json.checksVisible?.freedom === 0
    && testerSign.json.ok === true
    && amzExpires(testerSign.json.signedUrl) <= 300
    && c1cSignFreedom.status === 403
    && denied(c1cUpdateFreedom)
    && denied(c1cInsertFreedom)
    && denied(c1cDeleteFreedom)
    && denied(c1cReadWrite)
    && ownWrite.json.ok === true
    && String(flags.AWS_MOOV_ENABLED || 'false') !== 'true'
    && String(flags.AWS_FINANCIAL_PERMISSIONS_ACTIVATED || 'false') !== 'true',
  loginUsability: {
    testerChallenge: testerAuth.challenge,
    c1cChallenge: c1cAuth.challenge,
    publicLogin: site.status,
  },
  rlsAudit: {
    validateOk: validate.json.ok === true,
    failClosed: validate.json.failClosedWithoutIdentity === true,
    currentUser: validate.json.currentUser || null,
    summary: audit.summary || null,
    force: audit.force || null,
    roles: audit.roles || null,
  },
  isolation: {
    testerChecks: testerRows.length,
    c1cChecks: c1cRows.length,
    testerSeesC1c: isolationTester.json.checksVisible?.c1c ?? null,
    c1cSeesFreedom: isolationC1c.json.checksVisible?.freedom ?? null,
    c1cMapped: isolationC1c.json.applicationUserId === C1C_ADMIN_ID,
    spoofIgnored: Boolean(isolationC1c.json.spoofFieldsIgnored),
  },
  storageTtl: {
    requested: 14400,
    issued: amzExpires(testerSign.json.signedUrl),
    signedUrlLogged: false,
    c1cCrossTenantSign: { status: c1cSignFreedom.status, error: c1cSignFreedom.json.error || null },
  },
  adversarial: {
    update: { status: c1cUpdateFreedom.status, error: c1cUpdateFreedom.json.error || null, count: c1cUpdateFreedom.json.count ?? null, ok: c1cUpdateFreedom.json.ok ?? null },
    insert: { status: c1cInsertFreedom.status, error: c1cInsertFreedom.json.error || null, ok: c1cInsertFreedom.json.ok ?? null },
    delete: { status: c1cDeleteFreedom.status, error: c1cDeleteFreedom.json.error || null, ok: c1cDeleteFreedom.json.ok ?? null },
    messageRead: { status: c1cReadWrite.status, error: c1cReadWrite.json.error || null, ok: c1cReadWrite.json.ok ?? null },
    ownMessageRead: { status: ownWrite.status, ok: ownWrite.json.ok === true },
  },
  holds: {
    moov: flags.AWS_MOOV_ENABLED ?? null,
    checkalt: flags.AWS_CHECKALT_ENABLED ?? null,
    provider: flags.AWS_PROVIDER_EXECUTION_ENABLED ?? null,
    financial: flags.AWS_FINANCIAL_PERMISSIONS_ACTIVATED ?? null,
    readinessOk: readiness.json.holds?.ok === true,
  },
};
mkdirSync('/tmp/security', { recursive: true });
writeFileSync('/tmp/security/batch4-validate.json', `${JSON.stringify(report, null, 2)}\n`);
writeFileSync('/tmp/security/batch4-rls-matrix.json', `${JSON.stringify(audit.matrix || [], null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
