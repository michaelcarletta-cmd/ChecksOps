#!/usr/bin/env node
/**
 * Live provider sandbox validation against AWS staging.
 * Uses sandbox-only routes. Does not call production provider credentials.
 * Does not touch production Supabase, DNS, or production webhooks.
 */
import fs from 'node:fs';

const API = process.env.CHECKSOPS_API_URL || 'https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging';
const FREEDOM_EMAIL = 'checksops-tester@freedomadj.com';
const C1C_EMAIL = 'payments@condition1commercial.com';
const C1C_TENANT = '4f172140-f57a-4744-8050-95f4f07b13b4';
const MARKER = `AWS PROVIDER SANDBOX ${Date.now()}`;

const passwords = JSON.parse(fs.readFileSync(process.env.COGNITO_PASSWORD_FILE || '/tmp/cognito-login-passwords.json', 'utf8'));
const results = [];
const record = (name, ok, extra = {}) => {
  results.push({ name, ok, ...extra });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra.detail ? ` — ${extra.detail}` : ''}`);
};

const api = async (path, { method = 'POST', token, body, headers: extra } = {}) => {
  const headers = { 'content-type': 'application/json', ...(extra || {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
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

const main = async () => {
  const status = await api('/sandbox/status', { method: 'GET' });
  record('sandbox/status production execution blocked', status.status === 200
    && status.json.flags?.AWS_PROVIDER_EXECUTION_ENABLED === false
    && status.json.flags?.AWS_MOOV_ENABLED === false
    && status.json.flags?.AWS_CHECKALT_ENABLED === false
    && status.json.flags?.AWS_FINANCIAL_PERMISSIONS_ACTIVATED === false
    && status.json.productionExecution === false
    && status.json.cutover?.executed === false, {
    detail: `status=${status.status} sandboxFlag=${status.json.flags?.AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED} moovAvail=${status.json.capability?.moov?.available}`,
  });
  record('Moov sandbox unavailable without substituting production keys', status.json.capability?.moov?.available === false
    && status.json.capability?.moov?.refuseProductionKeys === true, {
    detail: status.json.capability?.moov?.reason,
  });
  record('CheckAlt has no safe FinCapture sandbox', status.json.capability?.checkalt?.available === false
    && status.json.capability?.checkalt?.refuseNegotiableCheck === true, {
    detail: status.json.capability?.checkalt?.reason,
  });
  record('Plaid sandbox not configured and not on money path', status.json.capability?.plaid?.available === false
    && status.json.capability?.plaid?.relevantToMoneyPath === false, {
    detail: status.json.capability?.plaid?.reason,
  });
  record('sandbox min amount is 1 cent', status.json.amountUnits?.sandboxMinCents === 1
    && status.json.amountUnits?.moov?.scale === 'integer_cents', {
    detail: `min=${status.json.amountUnits?.sandboxMinCents}`,
  });

  const unauth = await api('/sandbox/moov/probe', { body: {} });
  record('unauthenticated sandbox probe 401', unauth.status === 401, {
    detail: `status=${unauth.status} error=${unauth.json.error}`,
  });

  const freedom = await login(FREEDOM_EMAIL);
  const c1c = await login(C1C_EMAIL);

  const browserAmount = await api('/sandbox/moov/transfer', {
    token: freedom,
    body: { amount: 9.99, amount_cents: 999 },
  });
  record('browser amount rejected', browserAmount.status === 400 && browserAmount.json.error === 'untrusted_amount', {
    detail: `status=${browserAmount.status} error=${browserAmount.json.error}`,
  });

  const moovProbe = await api('/sandbox/moov/probe', { token: freedom, body: { marker: MARKER } });
  record('Moov probe fail-closed without sandbox keys', [403, 409].includes(moovProbe.status)
    && ['sandbox_credentials_unavailable', 'sandbox_execution_disabled'].includes(moovProbe.json.error)
    && moovProbe.json.productionExecution === false, {
    detail: `status=${moovProbe.status} error=${moovProbe.json.error}`,
  });

  const transfer1 = await api('/sandbox/moov/transfer', { token: freedom, body: { marker: MARKER } });
  const transfer2 = await api('/sandbox/moov/transfer', { token: freedom, body: { marker: MARKER } });
  record('Moov transfer fail-closed', transfer1.status === 200
    && transfer1.json.failClosed === true
    && transfer1.json.error === 'sandbox_credentials_unavailable'
    && transfer1.json.productionExecution === false
    && transfer1.json.sandboxHttpCalled === false, {
    detail: `status=${transfer1.status} error=${transfer1.json.error} id=${transfer1.json.operation?.id}`,
  });
  record('repeat transfer is idempotent (one ChecksOps op)', transfer2.status === 200
    && transfer2.json.duplicate === true
    && transfer2.json.operation?.id === transfer1.json.operation?.id
    && transfer2.json.sandboxHttpCalled === false, {
    detail: `dup=${transfer2.json.duplicate} id1=${transfer1.json.operation?.id} id2=${transfer2.json.operation?.id}`,
  });

  const checkalt = await api('/sandbox/checkalt/probe', { token: freedom, body: { marker: MARKER } });
  record('CheckAlt probe documents missing sandbox', [403, 409].includes(checkalt.status)
    && ['sandbox_credentials_unavailable', 'sandbox_execution_disabled'].includes(checkalt.json.error)
    && checkalt.json.negotiableCheckSubmitted !== true, {
    detail: `status=${checkalt.status} error=${checkalt.json.error} limitation=${checkalt.json.limitation || checkalt.json.capability?.reason}`,
  });

  const deposit1 = await api('/sandbox/checkalt/deposit', { token: freedom, body: { marker: MARKER } });
  const deposit2 = await api('/sandbox/checkalt/deposit', { token: freedom, body: { marker: MARKER } });
  record('CheckAlt deposit not submitted (no sandbox)', deposit1.status === 200
    && deposit1.json.failClosed === true
    && deposit1.json.negotiableCheckSubmitted === false
    && deposit1.json.error === 'sandbox_credentials_unavailable', {
    detail: `status=${deposit1.status} error=${deposit1.json.error}`,
  });
  record('CheckAlt deposit idempotent fail-closed', deposit2.status === 200
    && deposit2.json.duplicate === true
    && deposit2.json.operation?.id === deposit1.json.operation?.id, {
    detail: `dup=${deposit2.json.duplicate} id=${deposit2.json.operation?.id}`,
  });

  const plaid = await api('/sandbox/plaid/probe', { token: freedom, body: {} });
  record('Plaid probe fail-closed, no money movement', [403, 409].includes(plaid.status)
    && plaid.json.moneyMovement !== true, {
    detail: `status=${plaid.status} error=${plaid.json.error}`,
  });

  const c1cTransfer = await api('/sandbox/moov/retrieve', {
    token: c1c,
    body: { operation_id: transfer1.json.operation?.id, tenant_id: C1C_TENANT },
  });
  record('C1C cannot retrieve Freedom sandbox operation', !transfer1.json.operation?.id
    || c1cTransfer.status === 403
    || c1cTransfer.json.error === 'cross_tenant_denied'
    || c1cTransfer.json.error === 'operation_not_found', {
    detail: `status=${c1cTransfer.status} error=${c1cTransfer.json.error}`,
  });

  const unsigned = await api('/sandbox/webhooks/moov', {
    body: { type: 'transfer.completed', tenant_id: C1C_TENANT, accountID: 'acct_prod_must_not_map' },
    headers: { 'x-webhook-id': 'wh-unsigned', 'x-timestamp': String(Math.floor(Date.now() / 1000)) },
  });
  record('unsigned sandbox webhook rejected', unsigned.status === 401, {
    detail: `status=${unsigned.status} error=${unsigned.json.error}`,
  });

  const reconcile = await api('/sandbox/reconcile', { token: freedom, body: {} });
  record('sandbox reconcile is report-only', reconcile.status === 200
    && reconcile.json.autoCorrected === false
    && reconcile.json.productionExecution === false, {
    detail: `status=${reconcile.status} findings=${reconcile.json.findings?.length}`,
  });

  const cleanup = await api('/sandbox/cleanup', { token: freedom, body: { marker: MARKER } });
  record('sandbox cleanup staging-only', cleanup.status === 200 && cleanup.json.productionExecution === false, {
    detail: `deleted=${cleanup.json.deleted}`,
  });

  const failed = results.filter((row) => !row.ok);
  console.log(`\n${results.filter((row) => row.ok).length}/${results.length} PASS`);
  if (failed.length) {
    console.error('FAILED', failed.map((row) => row.name));
    process.exit(1);
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
