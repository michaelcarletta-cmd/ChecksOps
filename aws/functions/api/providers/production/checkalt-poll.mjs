import { TENANT_MEMBERSHIP_SQL } from '../../identity.mjs';
import { membershipForTenant } from '../../financial-ownership.mjs';
import { mapCheckAltStatus } from '../amounts.mjs';
import { checkAltFetch, getDepositItemStatus } from '../parity/checkalt-client.mjs';
import { loadProductionCheckAltConfig, loadProductionTenantAccount } from './checkalt-config.mjs';
import { persistPollOutcome } from './checkalt-idempotency.mjs';
import { loadProductionCheckAltSecrets } from './checkalt-secrets.mjs';
import { authorizeCheckAltProduction } from './checkalt-authz.mjs';

const jwtCache = { token: null, expiresAt: null };

const fail = (error, statusCode, extra = {}) => ({
  ok: false,
  statusCode,
  error,
  provider: 'checkalt',
  liveProviderCalled: false,
  createdDeposit: false,
  productionExecution: extra.productionExecution === true,
  ...extra,
});

const membershipsOf = async (client, userId) => {
  const rows = (await client.query(TENANT_MEMBERSHIP_SQL, [userId])).rows;
  return rows.map((row) => ({
    tenant_id: row.tenant_id,
    role: row.role,
    tenant_name: row.tenant_name,
    tenant_slug: row.tenant_slug,
  }));
};

const resolvePollStatus = (json) => {
  const mapped = mapCheckAltStatus(json || {});
  if (mapped) return mapped;
  const numeric = Number(json?.statusCode ?? json?.status);
  if (numeric === 40) return 'pending_approval';
  if (numeric === 120) return 'rejected';
  if (numeric === 127) return 'submitted';
  if (numeric === 200) return 'cleared';
  const raw = String(json?.status ?? '').toLowerCase();
  if (['submitted', 'pending'].includes(raw)) return 'submitted';
  if (raw === 'pending_approval') return 'pending_approval';
  if (['approved', 'cleared', 'settled'].includes(raw)) return 'cleared';
  if (raw === 'returned') return 'returned';
  if (['rejected', 'declined'].includes(raw)) return 'rejected';
  if (raw === 'duplicate') return 'duplicate';
  return null;
};

const parseJson = async (resp) => {
  const raw = await resp.text();
  let json;
  try { json = JSON.parse(raw); } catch { json = { raw: String(raw).slice(0, 500) }; }
  return json;
};

export async function loadExistingProductionDeposit(client, { depositId, reference, tenantId }) {
  const params = [];
  const clauses = [];
  if (depositId) {
    params.push(depositId);
    clauses.push(`id = $${params.length}::uuid`);
  }
  if (reference) {
    params.push(String(reference));
    clauses.push(`checkalt_reference = $${params.length}`);
  }
  if (!clauses.length) return null;
  if (tenantId) {
    params.push(tenantId);
    clauses.push(`tenant_id = $${params.length}::uuid`);
  }
  return (await client.query(
    `SELECT id, tenant_id, check_intake_item_id, checkalt_reference, status, amount, amount_cents,
            idempotency_key, provider_http_attempted_at, failure_class, last_status_payload,
            last_error, submitted_at, cleared_at, returned_at, last_polled_at, submitted_by
     FROM public.checkalt_deposits
     WHERE ${clauses.join(' AND ')}
     LIMIT 1`,
    params,
  )).rows[0] || null;
}

export async function reconcileProductionCheckAltDeposit({
  client,
  mapping,
  row,
  cfg,
  credentials,
  acct,
  fetchImpl = fetch,
} = {}) {
  const ssoKey = acct?.sso_key || acct?.sso_user_id || null;
  const reference = row.checkalt_reference;
  if (!reference) {
    let historyJson = null;
    if (ssoKey && cfg?.fi_key) {
      const hist = await checkAltFetch({
        cfg,
        credentials,
        path: '/fincapture/deposit/history',
        body: { fiKey: cfg.fi_key, ssoKey },
        fetchImpl,
        jwtCache,
      });
      historyJson = await parseJson(hist);
      const items = historyJson?.items || historyJson?.data || historyJson?.deposits || [];
      const match = Array.isArray(items)
        ? items.find((item) => String(item?.checkId || item?.check_id || '') === String(row.check_intake_item_id)
          || Number(item?.userAmount) === Number(row.amount_cents))
        : null;
      if (match?.referenceNumber != null || match?.reference != null) {
        const foundRef = String(match.referenceNumber ?? match.reference);
        const status = resolvePollStatus(match) || 'submitted';
        const saved = await persistPollOutcome(client, {
          rowId: row.id,
          status,
          reference: foundRef,
          providerPayload: match,
        });
        return {
          ok: true,
          statusCode: 200,
          success: true,
          liveProviderCalled: true,
          createdDeposit: false,
          productionExecution: true,
          productionRecordsMutated: true,
          deposit_id: saved.id,
          checkalt_reference: saved.checkalt_reference,
          status: saved.status,
          reconciled: true,
          message: 'Located the existing FinCapture transaction. A new deposit was not created.',
          applicationUserId: mapping?.application_user_id,
        };
      }
    }
    return {
      ok: true,
      statusCode: 200,
      success: false,
      liveProviderCalled: Boolean(historyJson),
      createdDeposit: false,
      productionExecution: true,
      productionRecordsMutated: true,
      deposit_id: row.id,
      checkalt_reference: null,
      status: row.status,
      reconciled: true,
      uncertain: true,
      message: 'Provider HTTP was attempted without a stored reference. History did not match. Do not POST again.',
      applicationUserId: mapping?.application_user_id,
    };
  }

  const item = await getDepositItemStatus({
    cfg,
    credentials,
    tenant: { sso_user_id: ssoKey },
    referenceNumber: reference,
    fetchImpl,
    jwtCache,
  });
  let json = item.json;
  let status = resolvePollStatus(json);
  if (!status) {
    const hist = await checkAltFetch({
      cfg,
      credentials,
      path: '/fincapture/deposit/history',
      body: { fiKey: cfg.fi_key, ...(ssoKey ? { ssoKey } : {}) },
      fetchImpl,
      jwtCache,
    });
    const histJson = await parseJson(hist);
    const items = histJson?.items || histJson?.data || histJson?.deposits || [];
    const match = Array.isArray(items)
      ? items.find((entry) => String(entry?.referenceNumber ?? entry?.reference) === String(reference))
      : null;
    if (match) {
      json = { ...json, history: match };
      status = resolvePollStatus(match);
    }
  }
  const saved = await persistPollOutcome(client, {
    rowId: row.id,
    status: status || row.status,
    reference,
    providerPayload: json,
  });
  return {
    ok: true,
    statusCode: 200,
    success: true,
    liveProviderCalled: true,
    createdDeposit: false,
    productionExecution: true,
    productionRecordsMutated: true,
    deposit_id: saved.id,
    checkalt_reference: saved.checkalt_reference,
    status: saved.status,
    previous_status: row.status,
    reconciled: true,
    applicationUserId: mapping?.application_user_id,
  };
}

export async function handleProductionCheckAltPoll({
  client,
  mapping,
  claims,
  body,
  spoof,
  fetchImpl = fetch,
  deps = {},
} = {}) {
  const depositId = body.deposit_id || body.checkalt_deposit_id || null;
  const reference = body.checkalt_reference || body.referenceNumber || null;
  if (!depositId && !reference) {
    return fail('deposit_locator_required', 400, {
      message: 'Production poll requires deposit_id or checkalt_reference. It never creates a deposit.',
    });
  }

  const row = await loadExistingProductionDeposit(client, { depositId, reference });
  if (!row) {
    return fail('deposit_not_found', 404, {
      message: 'No existing checkalt_deposits row. Poll will not insert a new deposit.',
      spoofFieldsIgnored: spoof,
    });
  }

  const memberships = await membershipsOf(client, mapping.application_user_id);
  if (!membershipForTenant(memberships, row.tenant_id)) {
    return fail('cross_tenant_denied', 403, {
      message: 'Poll is tenant-safe. The deposit does not belong to the authenticated user.',
      spoofFieldsIgnored: spoof,
    });
  }

  const check = (await client.query(
    `SELECT id, tenant_id, amount, status FROM public.check_intake_items WHERE id = $1::uuid`,
    [row.check_intake_item_id],
  )).rows[0] || { id: row.check_intake_item_id, tenant_id: row.tenant_id, amount: row.amount };

  const authz = await authorizeCheckAltProduction({
    client,
    mapping,
    memberships,
    check,
    requireStepUp: false,
  });
  if (!authz.ok && authz.error === 'financial_unauthorized') {
    return { ...authz, createdDeposit: false, spoofFieldsIgnored: spoof };
  }
  if (!authz.ok && authz.error === 'cross_tenant_denied') {
    return { ...authz, createdDeposit: false, spoofFieldsIgnored: spoof };
  }
  if (!authz.evaluation?.roleOk) {
    return fail('financial_unauthorized', 403, {
      message: 'Operator cannot poll production CheckAlt for another authority path.',
      spoofFieldsIgnored: spoof,
    });
  }

  const secrets = await (deps.loadProductionSecrets || loadProductionCheckAltSecrets)(deps.getSecrets);
  if (!secrets.ok) return { ...secrets, createdDeposit: false, spoofFieldsIgnored: spoof };
  const loadedCfg = await loadProductionCheckAltConfig(client, { credentials: secrets.credentials });
  if (!loadedCfg.ok) return { ...loadedCfg, createdDeposit: false, spoofFieldsIgnored: spoof };
  const acct = await loadProductionTenantAccount(client, row.tenant_id);

  const result = await reconcileProductionCheckAltDeposit({
    client,
    mapping,
    row,
    cfg: loadedCfg.cfg,
    credentials: loadedCfg.credentials,
    acct,
    fetchImpl,
  });
  return {
    ...result,
    spoofFieldsIgnored: spoof,
    applicationUserId: mapping.application_user_id,
    authUid: mapping.application_user_id,
    cognitoSub: claims.sub,
    createdDeposit: false,
  };
}
