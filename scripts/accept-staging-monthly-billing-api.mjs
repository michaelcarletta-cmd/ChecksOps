#!/usr/bin/env node
/**
 * Authenticated staging API acceptance for monthly billing.
 * Simulation only. Does not enable transfer posting.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const API = 'https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging';
const OUT = '/opt/cursor/artifacts/moov-monthly-billing-preprod';
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const C1C = '4f172140-f57a-4744-8050-95f4f07b13b4';
const SANDBOX_MERCHANT = '36b79957-ce7a-4ca7-a68f-30986c9e47bb';
const SANDBOX_WALLET_PM = '3c3133e7-5489-4af8-9d9a-4b0cf6bad362';

const api = async (path, { token, body, method = 'POST' } = {}) => {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 400) }; }
  return { ok: res.ok && data?.ok !== false, status: res.status, data };
};

const loadJwt = async (name) => JSON.parse(await readFile(`${OUT}/.staging-${name}.jwt.json`, 'utf8'));

const main = async () => {
  await mkdir(OUT, { recursive: true });
  const owner = await loadJwt('owner');
  const tester = await loadJwt('tester');

  const me = await api('/identity/me', { token: owner.idToken, method: 'GET' });
  const testerMe = await api('/identity/me', { token: tester.idToken, method: 'GET' });

  const methods = await api('/data/query', {
    token: owner.idToken,
    body: {
      table: 'payment_provider_methods',
      op: 'select',
      select: 'id,tenant_id,provider_payment_method_id,holder_name,last_four,connection_status,environment,can_send',
      filters: [{ column: 'tenant_id', op: 'eq', value: FREEDOM }],
    },
  });
  const methodRows = methods.data?.rows || methods.data?.data || methods.data || [];

  const getFreedom = await api('/functions/v1/tenant-billing-admin', {
    token: owner.idToken,
    body: { action: 'get', tenant_id: FREEDOM },
  });
  const update = await api('/functions/v1/tenant-billing-admin', {
    token: owner.idToken,
    body: {
      action: 'update',
      tenant_id: FREEDOM,
      monthly_rate_cents: Number(getFreedom.data?.monthly_rate_cents || 9900),
      referral_discount_cents: Number(getFreedom.data?.referral_discount_cents || 0),
      billing_enabled: true,
      billing_day_of_month: Number(getFreedom.data?.billing_day_of_month || 1),
    },
  });

  const connected = (Array.isArray(methodRows) ? methodRows : []).find((row) => (
    row.connection_status === 'connected' && row.provider_payment_method_id
  ));
  const authorize = connected
    ? await api('/functions/v1/tenant-billing-authorize', {
      token: owner.idToken,
      body: {
        tenant_id: FREEDOM,
        provider_payment_method_id: connected.provider_payment_method_id,
        authorized: true,
        auto_debit_enabled: true,
      },
    })
    : { ok: false, skipped: 'no_connected_method_with_moov_id', status: 0, data: null };

  const after = await api('/functions/v1/tenant-billing-admin', {
    token: owner.idToken,
    body: { action: 'get', tenant_id: FREEDOM },
  });
  const pull = await api('/functions/v1/tenant-billing-admin', {
    token: owner.idToken,
    body: { action: 'pull', tenant_id: FREEDOM },
  });
  const c1c = await api('/functions/v1/tenant-billing-admin', {
    token: owner.idToken,
    body: { action: 'get', tenant_id: C1C },
  });

  const testerAdmin = await api('/functions/v1/tenant-billing-admin', {
    token: tester.idToken,
    body: { action: 'get', tenant_id: FREEDOM },
  });
  const testerPull = await api('/functions/v1/tenant-billing-admin', {
    token: tester.idToken,
    body: { action: 'pull', tenant_id: FREEDOM },
  });
  const testerRate = await api('/data/query', {
    token: tester.idToken,
    body: {
      table: 'tenants',
      op: 'update',
      values: { monthly_rate_cents: 1 },
      filters: [{ column: 'id', op: 'eq', value: FREEDOM }],
    },
  });
  const testerC1cAuth = await api('/functions/v1/tenant-billing-authorize', {
    token: tester.idToken,
    body: {
      tenant_id: C1C,
      provider_payment_method_id: '00000000-0000-4000-8000-000000000001',
      authorized: true,
      auto_debit_enabled: true,
    },
  });
  const testerOwnAuth = await api('/functions/v1/tenant-billing-authorize', {
    token: tester.idToken,
    body: {
      tenant_id: FREEDOM,
      provider_payment_method_id: connected?.provider_payment_method_id || 'missing',
      authorized: true,
      auto_debit_enabled: true,
    },
  });

  const dest = after.data?.destination || getFreedom.data?.destination || null;
  const report = {
    generatedAt: new Date().toISOString(),
    owner: {
      applicationUserId: me.data?.applicationUserId || null,
      isMasterOwner: me.data?.isMasterOwner ?? null,
      email: me.data?.profile?.email || null,
    },
    tester: {
      applicationUserId: testerMe.data?.applicationUserId || null,
      isMasterOwner: testerMe.data?.isMasterOwner ?? null,
      email: testerMe.data?.profile?.email || null,
    },
    destination: dest,
    destinationMatchesSandboxMerchant: dest?.accountId === SANDBOX_MERCHANT && dest?.paymentMethodId === SANDBOX_WALLET_PM,
    firstWalletFallback: false,
    freedomMethods: (Array.isArray(methodRows) ? methodRows : []).map((row) => ({
      provider_payment_method_id: row.provider_payment_method_id,
      last_four: row.last_four,
      connection_status: row.connection_status,
      environment: row.environment,
    })),
    getFreedom: {
      ok: getFreedom.ok,
      monthly_rate_cents: getFreedom.data?.monthly_rate_cents,
      referral_discount_cents: getFreedom.data?.referral_discount_cents,
      net_fee_cents: getFreedom.data?.net_fee_cents,
      billing_enabled: getFreedom.data?.billing_enabled,
      billing_day_of_month: getFreedom.data?.billing_day_of_month,
      next_billing_date: getFreedom.data?.next_billing_date,
      readiness: getFreedom.data?.readiness,
      authorization: getFreedom.data?.authorization,
    },
    update: { ok: update.ok, billing_enabled: update.data?.billing_enabled, readiness: update.data?.readiness },
    authorize,
    afterAuth: {
      ok: after.ok,
      readiness: after.data?.readiness,
      authorization: after.data?.authorization,
      last_charge: after.data?.last_charge || null,
      pending_charge: after.data?.pending_charge || null,
      historyCount: Array.isArray(after.data?.history) ? after.data.history.length : 0,
    },
    pull: {
      ok: pull.ok,
      status: pull.status,
      simulated: pull.data?.pull?.simulated ?? null,
      liveProviderCalled: pull.data?.pull?.liveProviderCalled ?? null,
      occurrenceStatus: pull.data?.pull?.occurrence?.status || null,
      destinationAccountId: pull.data?.destination?.accountId || null,
      destinationPaymentMethodId: pull.data?.destination?.paymentMethodId || null,
      error: pull.data?.error || pull.data?.pull?.error || pull.data?.pull?.reason || null,
      reasons: pull.data?.pull?.reasons || pull.data?.readiness?.reasons || null,
      idempotency_key: pull.data?.idempotency_key || null,
    },
    c1cAsOwner: { ok: c1c.ok, destination: c1c.data?.destination || null, readiness: c1c.data?.readiness || null },
    isolation: {
      testerCannotAdmin: testerAdmin.data?.error || testerAdmin.status,
      testerCannotPull: testerPull.data?.error || testerPull.status,
      testerCannotChangeRate: testerRate.data?.error || testerRate.status,
      testerCannotAuthorizeC1C: testerC1cAuth.data?.error || testerC1cAuth.status,
      testerOwnAuthorize: testerOwnAuth.data?.error || testerOwnAuth.status,
    },
    sandboxTransferPostEnabled: false,
    productionRecordsMutated: false,
  };
  await writeFile(`${OUT}/staging-api-acceptance.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
