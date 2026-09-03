#!/usr/bin/env node
/**
 * Live provider sandbox / UAT validation against AWS staging.
 * Isolation is proven before any provider HTTP.
 * Uses sandbox-only routes. Does not call production provider credentials.
 * Does not touch production Supabase, DNS, or production webhooks.
 */
import fs from 'node:fs';

const API = process.env.CHECKSOPS_API_URL || 'https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging';
const FREEDOM_EMAIL = 'checksops-tester@freedomadj.com';
const C1C_EMAIL = 'payments@condition1commercial.com';
const C1C_TENANT = '4f172140-f57a-4744-8050-95f4f07b13b4';
const MARKER = `AWS PROVIDER UAT ${Date.now()}`;

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

const redactRef = (value) => {
  if (!value) return null;
  const text = String(value);
  if (text.length <= 8) return `${text.slice(0, 2)}…`;
  return `${text.slice(0, 6)}…${text.slice(-4)}`;
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
    detail: `status=${status.status} sandboxFlag=${status.json.flags?.AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED} moovAvail=${status.json.capability?.moov?.available} checkaltAvail=${status.json.capability?.checkalt?.available}`,
  });
  record('Moov refuses production keys', status.json.capability?.moov?.refuseProductionKeys === true, {
    detail: `available=${status.json.capability?.moov?.available} reason=${status.json.capability?.moov?.reason}`,
  });
  record('CheckAlt UAT host is exact allowlist', status.json.isolation?.approvedCheckAltHost === 'https://uatapi.checkalt.com'
    && status.json.capability?.checkalt?.refuseUnapprovedHost === true
    && status.json.capability?.checkalt?.refuseNegotiableCheck === true, {
    detail: `available=${status.json.capability?.checkalt?.available} reason=${status.json.capability?.checkalt?.reason} host=${status.json.isolation?.approvedCheckAltHost}`,
  });
  record('CheckAlt userAmount unit is integer cents', status.json.amountUnits?.checkalt?.scale === 'integer_cents'
    && status.json.amountUnits?.checkalt?.examples?.[2]?.userAmount === 12345, {
    detail: `scale=${status.json.amountUnits?.checkalt?.scale}`,
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

  const isolation = await api('/sandbox/isolation', { token: freedom, body: {} });
  record('isolation gate before provider HTTP', isolation.status === 200
    && isolation.json.productionExecution === false
    && isolation.json.productionIdOverlap === false
    && isolation.json.stopHttpUnlessProven === true, {
    detail: `status=${isolation.status} moovHttp=${isolation.json.httpAllowed?.moov} checkaltHttp=${isolation.json.httpAllowed?.checkalt} overlap=${isolation.json.productionIdOverlap} envs=${JSON.stringify(isolation.json.productionProviderEnvironments)}`,
  });
  const moovHttp = isolation.json.httpAllowed?.moov === true;
  const checkaltHttp = isolation.json.httpAllowed?.checkalt === true;
  if (!moovHttp) {
    record('Moov HTTP stopped — environment not proven', isolation.json.httpAllowed?.reason?.moov !== 'sandbox_keys_isolated', {
      detail: isolation.json.httpAllowed?.reason?.moov,
    });
  }
  if (!checkaltHttp) {
    record('CheckAlt HTTP stopped — UAT not proven', isolation.json.httpAllowed?.reason?.checkalt !== 'uat_host_approved', {
      detail: isolation.json.httpAllowed?.reason?.checkalt,
    });
  }

  const browserAmount = await api('/sandbox/moov/transfer', {
    token: freedom,
    body: { amount: 9.99, amount_cents: 999 },
  });
  record('browser amount rejected', browserAmount.status === 400 && browserAmount.json.error === 'untrusted_amount', {
    detail: `status=${browserAmount.status} error=${browserAmount.json.error}`,
  });

  let moovOpId = null;
  let checkaltOpId = null;

  if (!moovHttp) {
    const moovProbe = await api('/sandbox/moov/probe', { token: freedom, body: { marker: MARKER } });
    record('Moov probe fail-closed without proven sandbox', [403, 409].includes(moovProbe.status)
      && ['sandbox_credentials_unavailable', 'sandbox_execution_disabled', 'production_provider_id_refused'].includes(moovProbe.json.error)
      && moovProbe.json.productionExecution === false, {
      detail: `status=${moovProbe.status} error=${moovProbe.json.error}`,
    });

    const transfer1 = await api('/sandbox/moov/transfer', { token: freedom, body: { marker: MARKER } });
    const transfer2 = await api('/sandbox/moov/transfer', { token: freedom, body: { marker: MARKER } });
    moovOpId = transfer1.json.operation?.id;
    record('Moov transfer fail-closed (no proven sandbox)', transfer1.status === 200
      && transfer1.json.failClosed === true
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
  } else {
    const moovProbe = await api('/sandbox/moov/probe', { token: freedom, body: { marker: MARKER } });
    record('Moov sandbox HTTP probe', moovProbe.status === 200
      && moovProbe.json.ok === true
      && moovProbe.json.environment === 'sandbox'
      && moovProbe.json.sandboxHttpCalled === true
      && moovProbe.json.productionExecution === false, {
      detail: `status=${moovProbe.status} env=${moovProbe.json.environment} version=${moovProbe.json.apiVersion}`,
    });

    const transfer1 = await api('/sandbox/moov/transfer', { token: freedom, body: { marker: MARKER, fixture: 'min' } });
    const transfer2 = await api('/sandbox/moov/transfer', { token: freedom, body: { marker: MARKER, fixture: 'min' } });
    const transfer3 = await api('/sandbox/moov/transfer', { token: freedom, body: { marker: MARKER, fixture: 'min' } });
    moovOpId = transfer1.json.operation?.id;
    record('Moov $0.01 sandbox transfer', transfer1.status === 200
      && transfer1.json.ok === true
      && transfer1.json.amount?.cents === 1
      && transfer1.json.sandboxHttpCalled === true
      && transfer1.json.productionExecution === false
      && Boolean(transfer1.json.providerReference), {
      detail: `status=${transfer1.status} cents=${transfer1.json.amount?.cents} ref=${redactRef(transfer1.json.providerReference)}`,
    });
    record('Moov provider-side idempotency (one transfer)', transfer2.status === 200
      && transfer2.json.duplicate === true
      && transfer2.json.operation?.id === transfer1.json.operation?.id
      && transfer3.json.operation?.id === transfer1.json.operation?.id
      && transfer2.json.providerReference === transfer1.json.providerReference, {
      detail: `id=${transfer1.json.operation?.id} ref=${redactRef(transfer1.json.providerReference)}`,
    });

    const retrieve = await api('/sandbox/moov/retrieve', {
      token: freedom,
      body: { operation_id: transfer1.json.operation?.id },
    });
    record('Moov retrieve by provider reference', retrieve.status === 200
      && retrieve.json.ok === true
      && retrieve.json.operation?.id === transfer1.json.operation?.id, {
      detail: `status=${retrieve.status} providerStatus=${retrieve.json.providerStatus}`,
    });
  }

  if (!checkaltHttp) {
    const checkalt = await api('/sandbox/checkalt/probe', { token: freedom, body: { marker: MARKER } });
    record('CheckAlt probe fail-closed without proven UAT', [403, 409].includes(checkalt.status)
      && ['sandbox_credentials_unavailable', 'sandbox_execution_disabled'].includes(checkalt.json.error)
      && checkalt.json.negotiableCheckSubmitted !== true, {
      detail: `status=${checkalt.status} error=${checkalt.json.error} limitation=${checkalt.json.limitation || checkalt.json.capability?.reason}`,
    });

    const deposit1 = await api('/sandbox/checkalt/deposit', { token: freedom, body: { marker: MARKER } });
    const deposit2 = await api('/sandbox/checkalt/deposit', { token: freedom, body: { marker: MARKER } });
    checkaltOpId = deposit1.json.operation?.id;
    record('CheckAlt deposit not submitted (UAT not proven)', deposit1.status === 200
      && deposit1.json.failClosed === true
      && deposit1.json.negotiableCheckSubmitted === false
      && deposit1.json.sandboxHttpCalled === false, {
      detail: `status=${deposit1.status} error=${deposit1.json.error}`,
    });
    record('CheckAlt deposit idempotent fail-closed', deposit2.status === 200
      && deposit2.json.duplicate === true
      && deposit2.json.operation?.id === deposit1.json.operation?.id, {
      detail: `dup=${deposit2.json.duplicate} id=${deposit2.json.operation?.id}`,
    });
  } else {
    const checkalt = await api('/sandbox/checkalt/probe', { token: freedom, body: { marker: MARKER } });
    record('CheckAlt UAT authentication', checkalt.status === 200
      && checkalt.json.ok === true
      && checkalt.json.environment === 'uat'
      && checkalt.json.host === 'https://uatapi.checkalt.com'
      && checkalt.json.sandboxHttpCalled === true
      && checkalt.json.negotiableCheckSubmitted === false, {
      detail: `status=${checkalt.status} host=${checkalt.json.host} merchant=${checkalt.json.merchant}`,
    });

    const account = await api('/sandbox/checkalt/account', { token: freedom, body: {} });
    record('CheckAlt UAT account/deposit-account', account.status === 200
      && account.json.ok === true
      && account.json.sandboxHttpCalled === true, {
      detail: `status=${account.status} user=${account.json.userAccount?.ok} deposit=${account.json.depositAccount?.ok}`,
    });

    const depositMin = await api('/sandbox/checkalt/deposit', {
      token: freedom,
      body: { marker: `${MARKER}-min`, fixture: 'min' },
    });
    const depositMinDup = await api('/sandbox/checkalt/deposit', {
      token: freedom,
      body: { marker: `${MARKER}-min`, fixture: 'min' },
    });
    const depositMinRetry = await api('/sandbox/checkalt/deposit', {
      token: freedom,
      body: { marker: `${MARKER}-min`, fixture: 'min' },
    });
    checkaltOpId = depositMin.json.operation?.id;
    record('CheckAlt UAT $0.01 synthetic deposit', depositMin.status === 200
      && depositMin.json.ok === true
      && depositMin.json.amount?.cents === 1
      && depositMin.json.amount?.userAmount === 1
      && depositMin.json.negotiableCheckSubmitted === false
      && depositMin.json.sandboxHttpCalled === true, {
      detail: `status=${depositMin.status} userAmount=${depositMin.json.amount?.userAmount} ref=${redactRef(depositMin.json.providerReference)}`,
    });
    record('CheckAlt provider-side idempotency (one UAT deposit)', depositMinDup.status === 200
      && depositMinDup.json.duplicate === true
      && depositMinDup.json.operation?.id === depositMin.json.operation?.id
      && depositMinRetry.json.operation?.id === depositMin.json.operation?.id
      && depositMinDup.json.providerReference === depositMin.json.providerReference, {
      detail: `id=${depositMin.json.operation?.id} ref=${redactRef(depositMin.json.providerReference)}`,
    });

    const depositDollar = await api('/sandbox/checkalt/deposit', {
      token: freedom,
      body: { marker: `${MARKER}-dollar`, fixture: 'dollar' },
    });
    record('CheckAlt UAT $1.00 synthetic deposit', depositDollar.status === 200
      && depositDollar.json.ok === true
      && depositDollar.json.amount?.cents === 100
      && depositDollar.json.amount?.userAmount === 100, {
      detail: `status=${depositDollar.status} userAmount=${depositDollar.json.amount?.userAmount} ref=${redactRef(depositDollar.json.providerReference)}`,
    });

    const depositCert = await api('/sandbox/checkalt/deposit', {
      token: freedom,
      body: { marker: `${MARKER}-cert`, fixture: 'cert' },
    });
    record('CheckAlt UAT $123.45 synthetic deposit', depositCert.status === 200
      && depositCert.json.ok === true
      && depositCert.json.amount?.cents === 12345
      && depositCert.json.amount?.userAmount === 12345, {
      detail: `status=${depositCert.status} userAmount=${depositCert.json.amount?.userAmount} ref=${redactRef(depositCert.json.providerReference)}`,
    });

    const history = await api('/sandbox/checkalt/status', {
      token: freedom,
      body: { operation_id: depositMin.json.operation?.id },
    });
    record('CheckAlt UAT history/status', history.status === 200
      && history.json.ok === true
      && history.json.operation?.id === depositMin.json.operation?.id, {
      detail: `status=${history.status} providerStatus=${history.json.providerStatus}`,
    });
  }

  const plaid = await api('/sandbox/plaid/probe', { token: freedom, body: {} });
  record('Plaid probe fail-closed, no money movement', [403, 409].includes(plaid.status)
    && plaid.json.moneyMovement !== true, {
    detail: `status=${plaid.status} error=${plaid.json.error}`,
  });

  const c1cTransfer = await api('/sandbox/moov/retrieve', {
    token: c1c,
    body: { operation_id: moovOpId, tenant_id: C1C_TENANT },
  });
  record('C1C cannot retrieve Freedom sandbox operation', !moovOpId
    || c1cTransfer.status === 403
    || c1cTransfer.json.error === 'cross_tenant_denied'
    || c1cTransfer.json.error === 'operation_not_found', {
    detail: `status=${c1cTransfer.status} error=${c1cTransfer.json.error}`,
  });

  const c1cDeposit = await api('/sandbox/checkalt/status', {
    token: c1c,
    body: { operation_id: checkaltOpId, tenant_id: C1C_TENANT },
  });
  record('C1C cannot retrieve Freedom CheckAlt operation', !checkaltOpId
    || c1cDeposit.status === 403
    || c1cDeposit.json.error === 'cross_tenant_denied'
    || c1cDeposit.json.error === 'operation_not_found', {
    detail: `status=${c1cDeposit.status} error=${c1cDeposit.json.error}`,
  });

  const unsigned = await api('/sandbox/webhooks/moov', {
    body: { type: 'transfer.completed', tenant_id: C1C_TENANT, accountID: 'acct_prod_must_not_map' },
    headers: { 'x-webhook-id': 'wh-unsigned', 'x-timestamp': String(Math.floor(Date.now() / 1000)) },
  });
  record('unsigned sandbox webhook rejected', unsigned.status === 401, {
    detail: `status=${unsigned.status} error=${unsigned.json.error}`,
  });

  const signedWebhook = await api('/sandbox/webhooks/moov', {
    body: { type: 'transfer.updated', tenant_id: C1C_TENANT, accountID: 'acct_spoof' },
    headers: {
      'x-webhook-id': `wh-uat-${Date.now()}`,
      'x-timestamp': String(Math.floor(Date.now() / 1000)),
      'x-signature': 'test',
    },
  });
  record('signed sandbox webhook ignored spoofed tenant', [200, 202, 401, 403].includes(signedWebhook.status)
    && signedWebhook.json.productionExecution !== true
    && signedWebhook.json.applied !== true, {
    detail: `status=${signedWebhook.status} error=${signedWebhook.json.error} applied=${signedWebhook.json.applied}`,
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
