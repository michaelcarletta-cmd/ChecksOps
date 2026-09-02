#!/usr/bin/env node
/**
 * Live Tranche 4 provider validation against staging API + Cognito.
 * Uses local DB snapshots and synthetic webhook fixtures only.
 * Does not call Moov, CheckAlt, Plaid, Actum, or QuickBooks.
 * Does not touch production Supabase.
 */
import fs from 'node:fs';
import { createHmac } from 'node:crypto';

const API = process.env.CHECKSOPS_API_URL || 'https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging';
const FREEDOM_EMAIL = 'checksops-tester@freedomadj.com';
const C1C_EMAIL = 'payments@condition1commercial.com';
const FREEDOM_TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const C1C_TENANT = '4f172140-f57a-4744-8050-95f4f07b13b4';
const NINTH = 'dd24eea5-5d12-47d1-999e-d5930c278b7d';
const WEBHOOK_SECRET = process.env.AWS_MOOV_WEBHOOK_SECRET || 'checksops-staging-t4-webhook';

const passwords = JSON.parse(fs.readFileSync(process.env.COGNITO_PASSWORD_FILE || '/tmp/cognito-login-passwords.json', 'utf8'));
const results = [];
const record = (name, ok, extra = {}) => {
  results.push({ name, ok, ...extra });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra.detail ? ` — ${extra.detail}` : ''}`);
};

const api = async (path, { method = 'POST', token, body, headers = {} } = {}) => {
  const next = { 'content-type': 'application/json', ...headers };
  if (token) next.authorization = `Bearer ${token}`;
  const response = await fetch(`${API}${path}`, {
    method,
    headers: next,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  let json = {};
  try { json = await response.json(); } catch { json = {}; }
  return { status: response.status, json };
};

const login = async (email) => {
  const { status, json } = await api('/auth/login', {
    body: { email, password: passwords[email] || passwords[email.toLowerCase()] },
  });
  if (status !== 200 || !json.authentication?.idToken) {
    throw new Error(`login failed for ${email}: ${status} ${json.error || json.message || ''}`);
  }
  return json.authentication.idToken;
};

const signedMoov = (payload) => {
  const webhookId = payload.eventID;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = `n-${webhookId}`;
  const rawBody = JSON.stringify(payload);
  const signature = createHmac('sha512', WEBHOOK_SECRET).update(`${timestamp}|${nonce}|${webhookId}`).digest('hex');
  return {
    rawBody,
    headers: {
      'x-webhook-id': webhookId,
      'x-timestamp': timestamp,
      'x-nonce': nonce,
      'x-signature': signature,
    },
  };
};

const main = async () => {
  const flags = await api('/providers/status', { method: 'GET' });
  record('providers/status flags default false', flags.status === 200
    && flags.json.flags?.AWS_PROVIDER_EXECUTION_ENABLED === false
    && flags.json.flags?.AWS_MOOV_ENABLED === false
    && flags.json.productionWebhooksRedirected === false, {
    detail: `status=${flags.status} exec=${flags.json.flags?.AWS_PROVIDER_EXECUTION_ENABLED}`,
  });
  record('providers/status does not leak webhook secret', !JSON.stringify(flags.json).includes(WEBHOOK_SECRET), {});

  const unauth = await api('/providers/moov/status', { body: {} });
  record('unauthenticated moov status 401', unauth.status === 401, { detail: `status=${unauth.status} error=${unauth.json.error}` });

  const freedom = await login(FREEDOM_EMAIL);
  const c1c = await login(C1C_EMAIL);

  const freedomMoov = await api('/providers/moov/status', {
    token: freedom,
    body: { tenant_id: C1C_TENANT, user_id: NINTH, provider_account_id: 'spoof-moov-account' },
    headers: { 'x-user-id': NINTH, 'x-tenant-id': C1C_TENANT },
  });
  record('Freedom spoofed C1C tenant denied', freedomMoov.status === 403 && freedomMoov.json.error === 'cross_tenant_denied', {
    detail: `status=${freedomMoov.status} error=${freedomMoov.json.error}`,
  });

  const freedomOwn = await api('/providers/moov/status', { token: freedom, body: { tenant_id: FREEDOM_TENANT } });
  record('Freedom Moov local status', freedomOwn.status === 200 && freedomOwn.json.liveProviderCalled === false, {
    detail: `status=${freedomOwn.status} account=${freedomOwn.json.account?.provider_account_id || 'none'} ready=${freedomOwn.json.readiness?.overall}`,
  });

  const freedomSpoofAcct = await api('/providers/moov/status', {
    token: freedom,
    body: { provider_account_id: 'acct-not-owned-by-freedom' },
  });
  record('Freedom spoofed Moov account id denied', freedomSpoofAcct.status === 403 && freedomSpoofAcct.json.error === 'spoofed_provider_id', {
    detail: `status=${freedomSpoofAcct.status} error=${freedomSpoofAcct.json.error}`,
  });

  const freedomCheckalt = await api('/providers/checkalt/status', { token: freedom, body: {} });
  record('Freedom CheckAlt local status', freedomCheckalt.status === 200 && freedomCheckalt.json.liveProviderCalled === false, {
    detail: `status=${freedomCheckalt.status} deposits=${freedomCheckalt.json.deposits?.length ?? 'n/a'}`,
  });

  const c1cMoov = await api('/providers/moov/status', { token: c1c, body: { tenant_id: C1C_TENANT } });
  record('C1C Moov local status', c1cMoov.status === 200 && c1cMoov.json.liveProviderCalled === false, {
    detail: `status=${c1cMoov.status} account=${c1cMoov.json.account?.provider_account_id || 'none'}`,
  });

  const c1cCross = await api('/providers/moov/status', { token: c1c, body: { tenant_id: FREEDOM_TENANT } });
  record('C1C requesting Freedom tenant denied', c1cCross.status === 403 && c1cCross.json.error === 'cross_tenant_denied', {
    detail: `status=${c1cCross.status} error=${c1cCross.json.error}`,
  });

  const transfer = await api('/functions/v1/moov-transfer-create', { token: freedom, body: { amount: 1 } });
  record('Moov transfer disabled', transfer.status === 403 && transfer.json.error === 'provider_disabled', {
    detail: `status=${transfer.status}`,
  });
  const deposit = await api('/functions/v1/checkalt-submit-deposit', { token: freedom, body: {} });
  record('CheckAlt submit disabled', deposit.status === 403 && deposit.json.error === 'provider_disabled', {
    detail: `status=${deposit.status}`,
  });
  const plaid = await api('/functions/v1/plaid-disburse', { token: freedom, body: {} });
  record('Plaid disburse disabled', plaid.status === 403 && plaid.json.error === 'provider_disabled', {
    detail: `status=${plaid.status}`,
  });
  const actum = await api('/functions/v1/actum-charge', { token: freedom, body: {} });
  record('unknown Actum charge disabled', actum.status === 403 && actum.json.error === 'provider_disabled', {
    detail: `status=${actum.status}`,
  });
  const qb = await api('/functions/v1/quickbooks-payment', { token: freedom, body: {} });
  record('QuickBooks payment disabled', qb.status === 403 && qb.json.error === 'provider_disabled', {
    detail: `status=${qb.status}`,
  });

  const malformed = await api('/webhooks/moov', { method: 'POST', body: '{not-json' });
  record('malformed webhook rejected', malformed.status === 400 && malformed.json.error === 'malformed_webhook', {
    detail: `status=${malformed.status}`,
  });
  const badSig = signedMoov({ eventID: `evt-bad-${Date.now()}`, type: 'account.updated', accountID: 'x' });
  badSig.headers['x-signature'] = '00'.repeat(32);
  const invalid = await api('/webhooks/moov', { method: 'POST', body: badSig.rawBody, headers: badSig.headers });
  record('invalid webhook signature rejected', invalid.status === 401 && invalid.json.error === 'invalid_signature', {
    detail: `status=${invalid.status}`,
  });

  const eventId = `evt-t4-${Date.now()}`;
  const good = signedMoov({
    eventID: eventId,
    type: 'account.updated',
    accountID: freedomOwn.json.account?.provider_account_id || 'unmapped-staging',
    tenant_id: C1C_TENANT,
    account_number: '123456789',
  });
  const first = await api('/webhooks/moov', { method: 'POST', body: good.rawBody, headers: good.headers });
  record('valid synthetic webhook accepted once', first.status === 200 && first.json.accepted === true && first.json.duplicate === false && first.json.applied === false, {
    detail: `status=${first.status} dry_run=${first.json.dry_run} lookup=${first.json.lookup}`,
  });
  const second = await api('/webhooks/moov', { method: 'POST', body: good.rawBody, headers: good.headers });
  record('duplicate webhook ignored', second.status === 200 && second.json.duplicate === true && second.json.applied === false, {
    detail: `status=${second.status}`,
  });
  record('webhook did not trust payload tenant_id', first.json.payload?.tenant_id === '[ignored-untrusted]', {
    detail: `mapped=${first.json.mapped_tenant_id || 'null'}`,
  });
  record('webhook redacted account_number', first.json.payload?.account_number === '[redacted]', {});

  const failed = results.filter((row) => !row.ok);
  console.log(`\n${results.filter((row) => row.ok).length}/${results.length} PASS`);
  if (failed.length) {
    process.exitCode = 1;
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
