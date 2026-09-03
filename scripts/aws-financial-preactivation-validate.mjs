#!/usr/bin/env node
/**
 * Live financial pre-activation validation against staging API + Cognito.
 * Uses sandbox simulation only. Does not call CheckAlt, Moov, Plaid, Actum,
 * or QuickBooks. Does not touch production Supabase, DNS, or webhooks.
 */
import fs from 'node:fs';

const API = process.env.CHECKSOPS_API_URL || 'https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging';
const FREEDOM_EMAIL = 'checksops-tester@freedomadj.com';
const C1C_EMAIL = 'payments@condition1commercial.com';
const FREEDOM_TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const C1C_TENANT = '4f172140-f57a-4744-8050-95f4f07b13b4';
const MARKER = `AWS T6 FINANCIAL ${Date.now()}`;

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
  const flags = await api('/financial/status', { method: 'GET' });
  record('financial/status production execution blocked', flags.status === 200
    && flags.json.flags?.AWS_PROVIDER_EXECUTION_ENABLED === false
    && flags.json.flags?.AWS_MOOV_ENABLED === false
    && flags.json.flags?.AWS_CHECKALT_ENABLED === false
    && flags.json.flags?.AWS_FINANCIAL_PERMISSIONS_ACTIVATED === false
    && flags.json.flags?.AWS_FINANCIAL_SANDBOX_SIMULATION_ENABLED === true
    && flags.json.liveProviderTransactions === false
    && flags.json.productionWebhooksRedirected === false, {
    detail: `status=${flags.status} sim=${flags.json.flags?.AWS_FINANCIAL_SANDBOX_SIMULATION_ENABLED} exec=${flags.json.flags?.AWS_PROVIDER_EXECUTION_ENABLED}`,
  });
  record('Moov unit is integer cents', flags.json.amountUnits?.moov?.scale === 'integer_cents'
    && flags.json.amountUnits?.checkalt?.example?.userAmount === 12345, {
    detail: `moov=${flags.json.amountUnits?.moov?.scale}`,
  });

  const unauth = await api('/financial/prepare', { body: { operation_type: 'checkalt_deposit', check_id: FREEDOM_TENANT } });
  record('unauthenticated prepare 401', unauth.status === 401, { detail: `status=${unauth.status} error=${unauth.json.error}` });

  const freedom = await login(FREEDOM_EMAIL);
  const c1c = await login(C1C_EMAIL);

  const created = await api('/workflow/checks', {
    token: freedom,
    body: {
      carrier_name: MARKER,
      review_notes: MARKER,
      tenant_id: C1C_TENANT,
      user_id: '00000000-0000-0000-0000-000000000099',
    },
  });
  const check = created.json.data;
  record('T5 create synthetic check', created.status === 200 && check?.tenant_id === FREEDOM_TENANT && !check?.claim_id, {
    detail: `status=${created.status} id=${check?.id}`,
  });

  const review = await api('/workflow/transition', {
    token: freedom,
    body: { check_id: check?.id, action: 'start_review' },
  });
  const ready = await api('/workflow/transition', {
    token: freedom,
    body: { check_id: check?.id, action: 'mark_ready_for_deposit' },
  });
  record('check reaches READY FOR PROVIDER', ready.status === 200
    && ready.json.data?.status === 'approved_for_deposit'
    && ready.json.data?.check_stage === 'ready_for_deposit', {
    detail: `review=${review.status} ready=${ready.status} status=${ready.json.data?.status}`,
  });

  const browserAmount = await api('/financial/prepare', {
    token: freedom,
    body: { operation_type: 'checkalt_deposit', check_id: check?.id, amount: 9.99, amount_cents: 999 },
  });
  record('browser amount rejected', browserAmount.status === 400 && browserAmount.json.error === 'untrusted_amount', {
    detail: `status=${browserAmount.status} error=${browserAmount.json.error}`,
  });

  const c1cPrepare = await api('/financial/prepare', {
    token: c1c,
    body: { operation_type: 'checkalt_deposit', check_id: check?.id },
  });
  record('C1C cannot prepare Freedom check', c1cPrepare.status === 403, {
    detail: `status=${c1cPrepare.status} error=${c1cPrepare.json.error}`,
  });

  const prepared = await api('/financial/prepare', {
    token: freedom,
    body: {
      operation_type: 'checkalt_deposit',
      check_id: check?.id,
      tenant_id: C1C_TENANT,
      user_id: '00000000-0000-0000-0000-000000000099',
      wallet_id: '11111111-1111-4111-8111-111111111111',
      marker: MARKER,
    },
  });
  const op = prepared.json.operation;
  record('Freedom prepare CheckAlt deposit simulation', prepared.status === 200
    && op?.status === 'ready_for_provider'
    && op?.amount_cents === 12345
    && op?.live_provider_called === false
    && prepared.json.liveProviderCalled === false, {
    detail: `status=${prepared.status} cents=${op?.amount_cents} source=${op?.amount_source}`,
  });

  const replayPrepare = await api('/financial/prepare', {
    token: freedom,
    body: { operation_type: 'checkalt_deposit', check_id: check?.id, marker: MARKER },
  });
  record('repeat prepare is idempotent', replayPrepare.status === 200 && replayPrepare.json.duplicate === true && replayPrepare.json.operation?.id === op?.id, {
    detail: `duplicate=${replayPrepare.json.duplicate} id=${replayPrepare.json.operation?.id}`,
  });

  const [firstSubmit, secondSubmit] = await Promise.all([
    api('/financial/simulate-submit', { token: freedom, body: { operation_id: op?.id } }),
    api('/financial/simulate-submit', { token: freedom, body: { operation_id: op?.id } }),
  ]);
  record('parallel submit does not create a second transaction', firstSubmit.status === 200 && secondSubmit.status === 200
    && firstSubmit.json.operation?.id === secondSubmit.json.operation?.id
    && [firstSubmit.json.operation?.status, secondSubmit.json.operation?.status].every((status) => status === 'provider_pending' || status === 'submitting')
    && firstSubmit.json.liveProviderCalled === false, {
    detail: `a=${firstSubmit.json.operation?.status} b=${secondSubmit.json.duplicate} live=${firstSubmit.json.liveProviderCalled}`,
  });

  const webhook = await api('/financial/simulate-webhook', {
    token: freedom,
    body: {
      operation_id: op?.id,
      event_type: 'deposit.cleared',
      external_event_id: `${MARKER}-cleared`,
      tenant_id: C1C_TENANT,
    },
  });
  record('synthetic CheckAlt webhook confirms deposit', webhook.status === 200
    && webhook.json.applied === true
    && webhook.json.mapped_tenant_id === FREEDOM_TENANT
    && webhook.json.tenantFromPayloadIgnored === true
    && webhook.json.operation?.status === 'provider_confirmed'
    && webhook.json.liveProviderCalled === false, {
    detail: `status=${webhook.status} op=${webhook.json.operation?.status} tenant=${webhook.json.mapped_tenant_id}`,
  });

  const dupWh = await api('/financial/simulate-webhook', {
    token: freedom,
    body: {
      operation_id: op?.id,
      event_type: 'deposit.cleared',
      external_event_id: `${MARKER}-cleared`,
    },
  });
  record('duplicate webhook ignored', dupWh.status === 200 && dupWh.json.duplicate === true && dupWh.json.applied === false, {
    detail: `duplicate=${dupWh.json.duplicate}`,
  });

  const disburse = await api('/financial/prepare', {
    token: freedom,
    body: { operation_type: 'disbursement', check_id: check?.id, marker: MARKER },
  });
  const disburseOp = disburse.json.operation;
  record('sandbox disbursement prepare', disburse.status === 200 && disburseOp?.provider === 'moov' && disburseOp?.amount_cents === 12345, {
    detail: `status=${disburse.status} id=${disburseOp?.id}`,
  });
  const disburseSubmit = await api('/financial/simulate-submit', { token: freedom, body: { operation_id: disburseOp?.id } });
  const disburseWh = await api('/financial/simulate-webhook', {
    token: freedom,
    body: { operation_id: disburseOp?.id, event_type: 'transfer.completed', external_event_id: `${MARKER}-xfer` },
  });
  record('sandbox disbursement confirmed', disburseSubmit.status === 200 && disburseWh.json.operation?.status === 'provider_confirmed'
    && disburseWh.json.liveProviderCalled === false, {
    detail: `submit=${disburseSubmit.json.operation?.status} wh=${disburseWh.json.operation?.status}`,
  });

  const ooo = await api('/financial/prepare', {
    token: freedom,
    body: { operation_type: 'ach', check_id: check?.id, marker: MARKER },
  });
  const oooWh = await api('/financial/simulate-webhook', {
    token: freedom,
    body: { operation_id: ooo.json.operation?.id, event_type: 'transfer.completed', out_of_order: true },
  });
  record('out-of-order webhook ignored', oooWh.status === 200 && oooWh.json.outOfOrder === true && oooWh.json.applied === false
    && ooo.json.operation?.status === 'ready_for_provider', {
    detail: `applied=${oooWh.json.applied} status=${ooo.json.operation?.status}`,
  });

  const failPrep = await api('/financial/prepare', {
    token: freedom,
    body: { operation_type: 'pay_homeowner', check_id: check?.id, marker: MARKER },
  });
  const fail400 = await api('/financial/simulate-failure', {
    token: freedom,
    body: { operation_id: failPrep.json.operation?.id, failure_class: 'provider_400' },
  });
  record('simulated provider 400', fail400.status === 200 && fail400.json.operation?.status === 'provider_failed'
    && fail400.json.liveProviderCalled === false, {
    detail: `status=${fail400.json.operation?.status}`,
  });

  const hungPrep = await api('/financial/prepare', {
    token: freedom,
    body: { operation_type: 'wallet_fund', check_id: check?.id, marker: MARKER },
  });
  const hung = await api('/financial/simulate-submit', {
    token: freedom,
    body: { operation_id: hungPrep.json.operation?.id, failure_class: 'db_after_provider' },
  });
  record('provider accepted / DB update failed is reconcilable', hung.status === 200 && hung.json.reconciliationNeeded === true
    && hung.json.operation?.provider_reference, {
    detail: `ref=${hung.json.operation?.provider_reference}`,
  });
  const recon = await api('/financial/reconcile', {
    token: freedom,
    body: { operation_id: hungPrep.json.operation?.id },
  });
  record('reconciliation reports without auto-correct', recon.status === 200 && recon.json.autoCorrected === false
    && (recon.json.findings || []).some((row) => row.finding_type === 'internal_pending_provider_succeeded'), {
    detail: `findings=${(recon.json.findings || []).map((row) => row.finding_type).join(',')}`,
  });

  const live = await api('/functions/v1/checkalt-submit-deposit', { token: freedom, body: { check_id: check?.id } });
  record('live CheckAlt submit still provider_disabled', live.status === 403 && live.json.error === 'provider_disabled', {
    detail: `status=${live.status} error=${live.json.error}`,
  });
  const moovLive = await api('/functions/v1/moov-transfer-create', { token: freedom, body: { amount_cents: 100 } });
  record('live Moov transfer still provider_disabled', moovLive.status === 403 && moovLive.json.error === 'provider_disabled', {
    detail: `status=${moovLive.status}`,
  });

  const cleanup = await api('/financial/cleanup', { token: freedom, body: { marker: MARKER } });
  record('simulated operations cleaned up', cleanup.status === 200 && cleanup.json.deleted >= 1, {
    detail: `deleted=${cleanup.json.deleted}`,
  });
  if (check?.id) {
    const del = await api(`/workflow/checks/${check.id}`, { method: 'DELETE', token: freedom });
    record('synthetic check deleted', del.status === 200 || del.status === 204 || del.json.ok === true, {
      detail: `status=${del.status}`,
    });
  }

  const failed = results.filter((row) => !row.ok);
  const out = { ok: failed.length === 0, passed: results.filter((row) => row.ok).length, failed: failed.length, marker: MARKER, results };
  fs.mkdirSync('/opt/cursor/artifacts', { recursive: true });
  fs.writeFileSync('/opt/cursor/artifacts/financial-preactivation-validation.json', JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ ok: out.ok, passed: out.passed, failed: out.failed }, null, 2));
  if (!out.ok) process.exit(1);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
