import { TENANT_MEMBERSHIP_SQL } from '../../identity.mjs';
import { roleAllowsFinancial } from '../../financial-authz.mjs';
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

const BATCH_POLL_STATUSES = Object.freeze([
  'submitted',
  'pending_approval',
  'submitting',
  'pending',
  'error',
]);

export async function loadBatchPollDeposits(client, tenantIds) {
  if (!tenantIds?.length) return [];
  return (await client.query(
    `SELECT id, tenant_id, check_intake_item_id, checkalt_reference, status, amount, amount_cents,
            idempotency_key, provider_http_attempted_at, failure_class, last_status_payload,
            last_error, submitted_at, cleared_at, returned_at, last_polled_at, submitted_by
     FROM public.checkalt_deposits
     WHERE tenant_id = ANY($1::uuid[])
       AND (
         checkalt_reference IS NOT NULL
         OR status = ANY($2::text[])
       )
     ORDER BY last_polled_at ASC NULLS FIRST, updated_at ASC NULLS LAST, id ASC
     LIMIT 50`,
    [tenantIds, [...BATCH_POLL_STATUSES]],
  )).rows;
}

/**
 * Locked SPA Settings "Poll Now" posts {}. Reconcile existing rows only.
 * Never INSERTs. Never POSTs /fincapture/deposit/process.
 */
export async function handleProductionCheckAltBatchPoll({
  client,
  mapping,
  claims,
  spoof,
  fetchImpl = fetch,
  deps = {},
} = {}) {
  const memberships = await membershipsOf(client, mapping.application_user_id);
  const platformRoles = (await client.query(
    'SELECT role FROM public.user_roles WHERE user_id = $1::uuid',
    [mapping.application_user_id],
  )).rows.map((row) => String(row.role || '').toLowerCase());
  const tenantIds = [...new Set(
    memberships
      .filter((row) => roleAllowsFinancial([row.role, ...platformRoles]))
      .map((row) => row.tenant_id)
      .filter(Boolean),
  )];
  if (!tenantIds.length) {
    return fail('financial_unauthorized', 403, {
      createdDeposit: false,
      polled: 0,
      updated: 0,
      errors: 0,
      message: 'Owner/admin/manager is required to poll production CheckAlt. Operator cannot refresh provider status.',
      spoofFieldsIgnored: spoof,
    });
  }

  const rows = await loadBatchPollDeposits(client, tenantIds);
  if (!rows.length) {
    return {
      ok: true,
      statusCode: 200,
      success: true,
      polled: 0,
      updated: 0,
      errors: 0,
      liveProviderCalled: false,
      createdDeposit: false,
      productionExecution: true,
      productionRecordsMutated: false,
      message: 'No existing CheckAlt deposits to reconcile. A FinCapture process POST was not sent.',
      spoofFieldsIgnored: spoof,
      applicationUserId: mapping.application_user_id,
      authUid: mapping.application_user_id,
      cognitoSub: claims.sub,
    };
  }

  const secrets = await (deps.loadProductionSecrets || loadProductionCheckAltSecrets)(deps.getSecrets);
  if (!secrets.ok) return { ...secrets, createdDeposit: false, polled: 0, updated: 0, errors: 0, spoofFieldsIgnored: spoof };
  const loadedCfg = await loadProductionCheckAltConfig(client, { credentials: secrets.credentials });
  if (!loadedCfg.ok) return { ...loadedCfg, createdDeposit: false, polled: 0, updated: 0, errors: 0, spoofFieldsIgnored: spoof };

  let polled = 0;
  let updated = 0;
  let errors = 0;
  let liveProviderCalled = false;
  for (const row of rows) {
    polled += 1;
    if (!row.checkalt_reference) {
      errors += 1;
      continue;
    }
    const acct = await loadProductionTenantAccount(client, row.tenant_id);
    try {
      const result = await reconcileProductionCheckAltDeposit({
        client,
        mapping,
        row,
        cfg: loadedCfg.cfg,
        credentials: loadedCfg.credentials,
        acct,
        fetchImpl,
      });
      if (result.liveProviderCalled) liveProviderCalled = true;
      if (result.reconciled === true) updated += 1;
      else errors += 1;
    } catch {
      errors += 1;
    }
  }

  return {
    ok: true,
    statusCode: 200,
    success: true,
    polled,
    updated,
    errors,
    liveProviderCalled,
    createdDeposit: false,
    productionExecution: true,
    productionRecordsMutated: updated > 0,
    message: 'Existing CheckAlt deposits reconciled. A FinCapture process POST was not sent.',
    spoofFieldsIgnored: spoof,
    applicationUserId: mapping.application_user_id,
    authUid: mapping.application_user_id,
    cognitoSub: claims.sub,
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
    return handleProductionCheckAltBatchPoll({
      client,
      mapping,
      claims,
      spoof,
      fetchImpl,
      deps,
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
