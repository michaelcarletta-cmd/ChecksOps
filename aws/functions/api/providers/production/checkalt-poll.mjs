import { TENANT_MEMBERSHIP_SQL } from '../../identity.mjs';
import { membershipForTenant } from '../../financial-ownership.mjs';
import { CHECKALT_STATUS_REFRESH_STATUSES, resolveCheckAltProviderStatus } from '../amounts.mjs';
import { checkAltFetch, getDepositItemStatus } from '../parity/checkalt-client.mjs';
import { loadStatusReadCheckAltConfig, loadProductionTenantAccount } from './checkalt-config.mjs';
import { persistStatusReadOutcome } from './checkalt-idempotency.mjs';
import { loadProductionCheckAltSecrets } from './checkalt-secrets.mjs';
import { authorizeCheckAltProduction } from './checkalt-authz.mjs';
import { statusReadOnlyFetch } from './checkalt-status-read.mjs';

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

const resolvePollStatus = (json) => resolveCheckAltProviderStatus(json || {});

export { CHECKALT_STATUS_REFRESH_STATUSES };

export async function loadDepositsForStatusRefresh(client, {
  tenantIds = [],
  limit = 50,
} = {}) {
  const ids = [...new Set((tenantIds || []).filter(Boolean))];
  if (!ids.length) return [];
  return (await client.query(
    `SELECT id, tenant_id, check_intake_item_id, checkalt_reference, status, amount, amount_cents,
            idempotency_key, provider_http_attempted_at, failure_class, last_status_payload,
            last_error, submitted_at, cleared_at, returned_at, last_polled_at, submitted_by
     FROM public.checkalt_deposits
     WHERE tenant_id = ANY($1::uuid[])
       AND status = ANY($2::text[])
       AND checkalt_reference IS NOT NULL
     ORDER BY CASE WHEN status = 'pending_approval' THEN 0 ELSE 1 END,
              submitted_at DESC NULLS LAST
     LIMIT $3`,
    [ids, CHECKALT_STATUS_REFRESH_STATUSES, Math.min(Number(limit) || 50, 100)],
  )).rows;
}

const parseJson = async (resp) => {
  const raw = await resp.text();
  let json;
  try { json = JSON.parse(raw); } catch { json = { raw: String(raw).slice(0, 500) }; }
  return json;
};

/** Known history envelopes from Lovable poll + AWS parity. Do not invent item fields. */
export const historyListOf = (json) => {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== 'object') return [];
  if (Array.isArray(json.depositHistoryList)) return json.depositHistoryList;
  if (Array.isArray(json.depositList)) return json.depositList;
  if (Array.isArray(json.history)) return json.history;
  if (Array.isArray(json.items)) return json.items;
  if (Array.isArray(json.data)) return json.data;
  if (Array.isArray(json.deposits)) return json.deposits;
  return [];
};

export const matchHistoryByReference = (items, reference) => {
  if (reference == null || reference === '') return null;
  const want = String(reference);
  const matches = (items || []).filter((item) => {
    const value = item?.referenceNumber ?? item?.reference;
    return value != null && String(value) === want;
  });
  return matches.length === 1 ? matches[0] : null;
};

export const reconciliationRequired = (row, extra = {}) => ({
  ok: true,
  statusCode: 200,
  success: false,
  error: 'reconciliation_required',
  createdDeposit: false,
  liveProviderCalled: extra.liveProviderCalled === true,
  productionExecution: extra.productionExecution === true,
  productionRecordsMutated: extra.productionRecordsMutated === true,
  deposit_id: row?.id || null,
  checkalt_reference: row?.checkalt_reference || null,
  status: row?.status || null,
  reconciled: false,
  uncertain: true,
  message: extra.message || 'CheckAlt history cannot be tied to this check without checkalt_reference. Amount is not unique. Do not POST again.',
  applicationUserId: extra.applicationUserId || null,
});

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
    return reconciliationRequired(row, {
      liveProviderCalled: false,
      productionExecution: true,
      productionRecordsMutated: false,
      applicationUserId: mapping?.application_user_id,
      message: 'No checkalt_reference is stored. FinCapture process does not send a ChecksOps check id, and history amount is not unique. Manual reconciliation required. A second process POST was not sent.',
    });
  }

  const safeFetch = statusReadOnlyFetch(fetchImpl);
  const item = await getDepositItemStatus({
    cfg,
    credentials,
    tenant: { sso_user_id: ssoKey },
    referenceNumber: reference,
    fetchImpl: safeFetch,
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
      fetchImpl: safeFetch,
      jwtCache,
    });
    const histJson = await parseJson(hist);
    const match = matchHistoryByReference(historyListOf(histJson), reference);
    if (!match) {
      return reconciliationRequired(row, {
        liveProviderCalled: true,
        productionExecution: true,
        productionRecordsMutated: false,
        applicationUserId: mapping?.application_user_id,
        message: 'CheckAlt history has no unique referenceNumber match for this deposit. Amount is not a transaction id. Manual reconciliation required. A second process POST was not sent.',
      });
    }
    json = { ...json, history: match };
    status = resolvePollStatus(match);
  }
  const saved = await persistStatusReadOutcome(client, {
    rowId: row.id,
    status: status || row.status,
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

const authorizePollRow = async ({ client, mapping, memberships, row }) => {
  if (!membershipForTenant(memberships, row.tenant_id)) {
    return fail('cross_tenant_denied', 403, {
      message: 'Poll is tenant-safe. The deposit does not belong to the authenticated user.',
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
  if (!authz.ok && (authz.error === 'financial_unauthorized' || authz.error === 'cross_tenant_denied')) {
    return { ...authz, createdDeposit: false };
  }
  if (!authz.evaluation?.roleOk) {
    return fail('financial_unauthorized', 403, {
      message: 'Operator cannot poll production CheckAlt for another authority path.',
    });
  }
  return { ok: true, authz, check };
};

const loadPollSecrets = async ({ client, deps }) => {
  const secrets = await (deps.loadProductionSecrets || loadProductionCheckAltSecrets)(deps.getSecrets);
  if (!secrets.ok) return secrets;
  const loadedCfg = await loadStatusReadCheckAltConfig(client, { credentials: secrets.credentials });
  if (!loadedCfg.ok) return loadedCfg;
  return { ok: true, cfg: loadedCfg.cfg, credentials: loadedCfg.credentials };
};

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
  const memberships = await membershipsOf(client, mapping.application_user_id);

  if (!depositId && !reference) {
    const requestedTenant = body.tenant_id || null;
    if (requestedTenant && !membershipForTenant(memberships, requestedTenant)) {
      return fail('cross_tenant_denied', 403, {
        message: 'Poll is tenant-safe. The deposit does not belong to the authenticated user.',
        spoofFieldsIgnored: spoof,
      });
    }
    const tenantIds = requestedTenant
      ? [requestedTenant]
      : [...new Set(memberships.map((row) => row.tenant_id).filter(Boolean))];
    if (!tenantIds.length) {
      return fail('financial_unauthorized', 403, {
        message: 'Operator has no tenant membership for a CheckAlt status refresh.',
        spoofFieldsIgnored: spoof,
      });
    }
    const rows = await loadDepositsForStatusRefresh(client, { tenantIds, limit: body.limit });
    if (!rows.length) {
      return {
        ok: true,
        statusCode: 200,
        success: true,
        polled: 0,
        updated: 0,
        errors: 0,
        deposits: [],
        tenant_ids: tenantIds,
        liveProviderCalled: false,
        createdDeposit: false,
        productionExecution: true,
        productionRecordsMutated: false,
        spoofFieldsIgnored: spoof,
        applicationUserId: mapping.application_user_id,
        authUid: mapping.application_user_id,
        cognitoSub: claims.sub,
      };
    }
    const loaded = await loadPollSecrets({ client, deps });
    if (!loaded.ok) return { ...loaded, createdDeposit: false, spoofFieldsIgnored: spoof, polled: 0, updated: 0, errors: 0 };

    let polled = 0;
    let updated = 0;
    let errors = 0;
    const deposits = [];
    for (const row of rows) {
      const authz = await authorizePollRow({ client, mapping, memberships, row });
      if (!authz.ok) {
        errors += 1;
        continue;
      }
      const acct = await loadProductionTenantAccount(client, row.tenant_id);
      const result = await reconcileProductionCheckAltDeposit({
        client,
        mapping,
        row,
        cfg: loaded.cfg,
        credentials: loaded.credentials,
        acct,
        fetchImpl,
      });
      polled += 1;
      if (result.reconciled) updated += 1;
      else errors += 1;
      deposits.push({
        deposit_id: result.deposit_id || row.id,
        status: result.status || row.status,
        previous_status: row.status,
        reconciled: Boolean(result.reconciled),
      });
    }
    return {
      ok: true,
      statusCode: 200,
      success: true,
      polled,
      updated,
      errors,
      deposits,
      tenant_ids: tenantIds,
      liveProviderCalled: polled > 0,
      createdDeposit: false,
      productionExecution: true,
      productionRecordsMutated: updated > 0,
      spoofFieldsIgnored: spoof,
      applicationUserId: mapping.application_user_id,
      authUid: mapping.application_user_id,
      cognitoSub: claims.sub,
    };
  }

  const row = await loadExistingProductionDeposit(client, { depositId, reference });
  if (!row) {
    return fail('deposit_not_found', 404, {
      message: 'No existing checkalt_deposits row. Poll will not insert a new deposit.',
      spoofFieldsIgnored: spoof,
    });
  }

  const authz = await authorizePollRow({ client, mapping, memberships, row });
  if (!authz.ok) return { ...authz, createdDeposit: false, spoofFieldsIgnored: spoof };

  const loaded = await loadPollSecrets({ client, deps });
  if (!loaded.ok) return { ...loaded, createdDeposit: false, spoofFieldsIgnored: spoof };
  const acct = await loadProductionTenantAccount(client, row.tenant_id);

  const result = await reconcileProductionCheckAltDeposit({
    client,
    mapping,
    row,
    cfg: loaded.cfg,
    credentials: loaded.credentials,
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
