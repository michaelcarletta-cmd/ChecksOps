#!/usr/bin/env node
/**
 * Batch 5 adversarial + application regression. No emails/tokens/URLs printed.
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
  const pwd = `B5-${randomBytes(24).toString('base64url')}!aA1`;
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
  return { challenge: auth.ChallengeName || null, idToken: auth.AuthenticationResult?.IdToken || null };
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

const publicGet = async (url) => {
  const response = await fetch(url, { redirect: 'manual' });
  return { status: response.status };
};

const amzExpires = (url) => {
  if (!url) return null;
  try {
    return Number(new URL(url).searchParams.get('X-Amz-Expires'));
  } catch {
    return null;
  }
};

const denied = (res) => Boolean(res.status >= 400 || res.json?.ok === false || res.json?.error
  || (Number(res.json?.count || 0) === 0 && res.json?.ok !== true));

const tester = EXPECTED_EIGHT.find((row) => row.applicationUserId === TESTER_ID);
const c1c = EXPECTED_EIGHT.find((row) => row.applicationUserId === C1C_ADMIN_ID);
const testerAuth = tokensFor(tester.email);
const c1cAuth = tokensFor(c1c.email);

const site = await publicGet('https://checksops.com/');
const login = await publicGet('https://checksops.com/login');
const endorse = await publicGet('https://checksops.com/endorse');
const signPage = await publicGet('https://checksops.com/sign');
const health = await call(null, '/health', undefined, 'GET');
const dbHealth = await call(null, '/db-health', undefined, 'GET');
const readiness = await call(null, '/ops/readiness', undefined, 'GET');
const financial = await call(null, '/financial/status', undefined, 'GET');
const coreValidate = await call(null, '/db-readonly-validate', undefined, 'GET');
const prefer = await call(null, '/auth/mfa/set-preference', {});
const signing = await call(null, '/public/signature-document', { token: 'short' });
const identity = await call(testerAuth.idToken, '/identity/me', undefined, 'GET');
const isolationTester = await call(testerAuth.idToken, '/authorization/isolation', {});
const isolationC1c = await call(c1cAuth.idToken, '/authorization/isolation', {
  user_id: TESTER_ID,
  tenant_id: 'spoof-tenant',
});
const testerChecks = await call(testerAuth.idToken, '/data/query', {
  table: 'check_intake_items',
  select: 'id,tenant_id,front_image_path',
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
const rel = freedomCheck?.front_image_path ? String(freedomCheck.front_image_path).split('?')[0] : null;
const testerSign = rel
  ? await call(testerAuth.idToken, '/storage/sign', { bucket: 'claim-files', path: rel, expiresIn: 14400 })
  : { status: 0, json: {} };
const c1cSign = rel
  ? await call(c1cAuth.idToken, '/storage/sign', { bucket: 'claim-files', path: rel, expiresIn: 14400 })
  : { status: 0, json: {} };
const c1cUpdate = freedomCheck?.id
  ? await call(c1cAuth.idToken, '/data/write', {
    table: 'check_intake_items',
    op: 'update',
    values: { carrier_name: 'BATCH5_SHOULD_NOT_WRITE' },
    filters: { id: freedomCheck.id },
  })
  : { status: 0, json: { error: 'no_check' } };
const c1cInsert = await call(c1cAuth.idToken, '/data/write', {
  table: 'check_intake_items',
  op: 'insert',
  values: { tenant_id: freedomCheck?.tenant_id, carrier_name: 'BATCH5_SHOULD_NOT_INSERT' },
});
const c1cDelete = freedomCheck?.id
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
const prepare = await call(testerAuth.idToken, '/financial/prepare', {});
const writeOk = freedomCheck?.id
  ? await call(testerAuth.idToken, '/data/write', {
    table: 'check_message_reads',
    op: 'upsert',
    values: { check_id: freedomCheck.id },
  })
  : { status: 0, json: {} };

const issuedTtl = amzExpires(testerSign.json.signedUrl);
const flags = financial.json.flags || readiness.json.flags || {};
const audit = coreValidate.json.rlsAudit || {};

const report = {
  ok: Boolean(testerAuth.idToken && !testerAuth.challenge && c1cAuth.idToken && !c1cAuth.challenge)
    && site.status === 200
    && login.status === 200
    && endorse.status === 200
    && signPage.status === 200
    && health.status === 200
    && dbHealth.status === 200
    && readiness.json.holds?.ok === true
    && coreValidate.json.failClosedWithoutIdentity === true
    && prefer.status === 403
    && identity.json.privilegedAuth?.preferredMfaAtLogin === false
    && isolationTester.json.checksVisible?.c1c === 0
    && isolationC1c.json.applicationUserId === C1C_ADMIN_ID
    && isolationC1c.json.checksVisible?.freedom === 0
    && testerRows.length > 0
    && c1cRows.length === 0
    && testerSign.json.ok === true
    && issuedTtl <= 300
    && c1cSign.status === 403
    && denied(c1cUpdate)
    && denied(c1cInsert)
    && denied(c1cDelete)
    && denied(c1cReadWrite)
    && Boolean(prepare.json.error || prepare.status >= 400)
    && writeOk.json.ok === true
    && String(flags.AWS_MOOV_ENABLED || 'false') !== 'true'
    && String(flags.AWS_FINANCIAL_PERMISSIONS_ACTIVATED || 'false') !== 'true',
  public: {
    site: site.status,
    login: login.status,
    endorse: endorse.status,
    sign: signPage.status,
    health: health.status,
    dbHealth: dbHealth.status,
  },
  auth: {
    testerChallenge: testerAuth.challenge,
    c1cChallenge: c1cAuth.challenge,
    setPreference: prefer.status,
    signingMissingToken: signing.status,
    privilegedPreferredMfa: identity.json.privilegedAuth?.preferredMfaAtLogin ?? null,
  },
  isolation: {
    testerChecks: testerRows.length,
    c1cChecks: c1cRows.length,
    testerSeesC1c: isolationTester.json.checksVisible?.c1c ?? null,
    c1cSeesFreedom: isolationC1c.json.checksVisible?.freedom ?? null,
    spoofIgnored: Boolean(isolationC1c.json.spoofFieldsIgnored),
    c1cSign: { status: c1cSign.status, error: c1cSign.json.error || null },
    ttl: issuedTtl,
    ownWrite: writeOk.json.ok === true,
    financialPrepare: { status: prepare.status, error: prepare.json.error || null },
  },
  adversarial: {
    update: { status: c1cUpdate.status, error: c1cUpdate.json.error || null, ok: c1cUpdate.json.ok ?? null },
    insert: { status: c1cInsert.status, error: c1cInsert.json.error || null, ok: c1cInsert.json.ok ?? null },
    delete: { status: c1cDelete.status, error: c1cDelete.json.error || null, ok: c1cDelete.json.ok ?? null },
    messageRead: { status: c1cReadWrite.status, error: c1cReadWrite.json.error || null, ok: c1cReadWrite.json.ok ?? null },
  },
  rls: {
    failClosed: coreValidate.json.failClosedWithoutIdentity === true,
    forceApplied: audit.force?.applied ?? null,
  },
  holds: {
    readinessOk: readiness.json.holds?.ok === true,
    moov: flags.AWS_MOOV_ENABLED ?? null,
    checkalt: flags.AWS_CHECKALT_ENABLED ?? null,
    provider: flags.AWS_PROVIDER_EXECUTION_ENABLED ?? null,
    financial: flags.AWS_FINANCIAL_PERMISSIONS_ACTIVATED ?? null,
  },
};
mkdirSync('/tmp/security', { recursive: true });
writeFileSync('/tmp/security/batch5-validate.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
