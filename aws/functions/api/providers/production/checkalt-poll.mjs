import { TENANT_MEMBERSHIP_SQL } from '../../identity.mjs';
import { membershipForTenant } from '../../financial-ownership.mjs';
import { CHECKALT_STATUS_REFRESH_STATUSES, resolveCheckAltProviderStatus } from '../amounts.mjs';
import {
  checkAltFetch,
  extractSsoKey,
  getDepositItemStatus,
  getUserAccountInfo,
} from '../parity/checkalt-client.mjs';
import { loadProductionCheckAltConfig, loadProductionTenantAccount } from './checkalt-config.mjs';
import { persistPollOutcome } from './checkalt-idempotency.mjs';
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

/**
 * The FinCapture ssoKey for a tenant depositor, resolved exactly as submit
 * sends it on /deposit/process: the stored CheckAlt-issued sso_key when it
 * differs from sso_user_id, else the ssoKey getUserAccountInformation lists
 * for the deposit account, else sso_key / sso_user_id. Submit, poll and
 * approve share it so item and history lookups name the same depositor as
 * the deposit (CheckAlt answers history with "no records" otherwise).
 * getUserAccountInformation is a read; poll and approve call it through the
 * status-read fetch guard.
 */
export async function resolveSsoKeyWithSource({
  cfg,
  credentials,
  acct,
  fetchImpl = fetch,
  jwtCache: cache = jwtCache,
}) {
  if (!acct) return { ssoKey: null, source: 'none' };
  if (acct.sso_key && acct.sso_key !== acct.sso_user_id) return { ssoKey: acct.sso_key, source: 'stored' };
  try {
    const info = await getUserAccountInfo({
      cfg,
      credentials,
      ssoUserId: acct.sso_user_id,
      fetchImpl,
      jwtCache: cache,
    });
    const extracted = extractSsoKey(info.json, acct.deposit_account_number);
    if (extracted) return { ssoKey: extracted, source: 'lookup' };
  } catch {
    /* depositor lookup is best-effort; sso_user_id is the production fallback */
  }
  return { ssoKey: acct.sso_key || acct.sso_user_id, source: 'fallback' };
}

export async function resolveSsoKey(args) {
  return (await resolveSsoKeyWithSource(args)).ssoKey;
}

// One lookup per tenant account object (the scheduled reconcile and the
// batch poll reuse one acct per tenant).
const resolvedSsoKeys = new WeakMap();
const resolveSsoKeyOnce = async (args) => {
  if (!args.acct || typeof args.acct !== 'object') return resolveSsoKeyWithSource(args);
  if (!resolvedSsoKeys.has(args.acct)) resolvedSsoKeys.set(args.acct, resolveSsoKeyWithSource(args));
  return resolvedSsoKeys.get(args.acct);
};

const DAY_MS = 86_400_000;
export const HISTORY_LOOKBACK_DAYS = 30;
export const HISTORY_SUBMITTED_MARGIN_DAYS = 3;

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * /fincapture/deposit/history window, in the YYYY-MM-DD form the last working
 * Supabase poll and checkalt-deposit-history sent: from a few days before the
 * deposit was submitted (30 days back when that is unknown) to today.
 */
export const historyWindow = (submittedAt, now = Date.now()) => {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const submittedMs = submittedAt ? Date.parse(String(submittedAt)) : NaN;
  const startMs = Number.isFinite(submittedMs)
    ? Math.min(submittedMs - HISTORY_SUBMITTED_MARGIN_DAYS * DAY_MS, nowMs)
    : nowMs - HISTORY_LOOKBACK_DAYS * DAY_MS;
  return { startDate: isoDay(startMs), endDate: isoDay(nowMs) };
};

/** Same fields as the last working Supabase history call. */
export const buildHistoryRequestBody = ({ cfg, acct, ssoKey, submittedAt, now = Date.now() }) => {
  const { startDate, endDate } = historyWindow(submittedAt, now);
  return {
    fiKey: cfg.fi_key,
    ...(acct?.sso_user_id ? { userId: acct.sso_user_id } : {}),
    ...(ssoKey ? { ssoKey } : {}),
    ...(acct?.deposit_account_number ? { accountNumber: acct.deposit_account_number } : {}),
    startDate,
    endDate,
  };
};

const HISTORY_ENVELOPES = ['depositHistoryList', 'depositList', 'history', 'items', 'data', 'deposits'];

/** Known history envelopes from Lovable poll + AWS parity. Do not invent item fields. */
export const historyListOf = (json) => {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== 'object') return [];
  for (const key of HISTORY_ENVELOPES) {
    if (Array.isArray(json[key])) return json[key];
  }
  return [];
};

const historyEnvelopeOf = (json) => {
  if (Array.isArray(json)) return '[array]';
  if (!json || typeof json !== 'object') return null;
  return HISTORY_ENVELOPES.find((key) => Array.isArray(json[key])) || null;
};

const STATUS_FIELDS = ['status', 'statusCode', 'statusDescription', 'itemStatus'];

const redactor = (secrets) => {
  const values = secrets.filter((value) => value != null && String(value).length >= 4).map(String);
  return (text) => values.reduce((out, value) => out.split(value).join('[redacted]'), text);
};

const scalarOf = (value, redact) => {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return redact(value).slice(0, 80);
  return Array.isArray(value) ? '[array]' : `[${typeof value}]`;
};

const keysOf = (json) => {
  if (Array.isArray(json)) return ['[array]'];
  return json && typeof json === 'object' ? Object.keys(json).slice(0, 40) : [];
};

const statusFieldsOf = (json, redact) => {
  const out = {};
  if (!json || typeof json !== 'object' || Array.isArray(json)) return out;
  for (const key of STATUS_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(json, key)) out[key] = scalarOf(json[key], redact);
  }
  return out;
};

const countReferenceMatches = (items, reference) => (items || []).filter((item) => {
  const value = item?.referenceNumber ?? item?.reference;
  return value != null && String(value) === String(reference);
}).length;

/**
 * Non-secret evidence for a reconciliation_required answer: HTTP statuses,
 * response key names and status-like values only. Never tokens, fiKey,
 * ssoKey, userId or account numbers (any of those values echoed inside a
 * status string is redacted).
 */
export const reconcileDiagnostics = ({
  item,
  hist,
  histJson,
  reference,
  window,
  ssoKeySource,
  secrets = [],
}) => {
  const redact = redactor(secrets);
  const list = historyListOf(histJson);
  const matches = countReferenceMatches(list, reference);
  return {
    item_http_status: Number.isInteger(item?.status) ? item.status : null,
    item_keys: keysOf(item?.json),
    item_status_fields: statusFieldsOf(item?.json, redact),
    history_http_status: Number.isInteger(hist?.status) ? hist.status : null,
    history_keys: keysOf(histJson),
    history_status_fields: statusFieldsOf(histJson, redact),
    history_envelope: historyEnvelopeOf(histJson),
    history_list_length: list.length,
    history_reference_matches: matches,
    history_matched: matches === 1,
    history_window: window || null,
    sso_key_source: ssoKeySource || null,
  };
};

/**
 * Keep the evidence on the deposit without changing its status: merge it into
 * last_status_payload (UPDATE on checkalt_deposits is already granted by SQL
 * 65; persistPollOutcome writes the same column). A savepoint keeps a refused
 * write from aborting the caller's transaction. Approve answers 409 here, so
 * its transaction rolls back and the evidence only reaches its response.
 */
const persistReconcileDiagnostics = async (client, rowId, diagnostics) => {
  if (!client || typeof client.query !== 'function' || !rowId) return false;
  const payload = JSON.stringify({
    last_reconcile_unresolved: { ...diagnostics, at: new Date().toISOString() },
  });
  try {
    await client.query('SAVEPOINT checkalt_reconcile_diagnostics');
  } catch {
    return false;
  }
  try {
    await client.query(
      `UPDATE public.checkalt_deposits
       SET last_status_payload = COALESCE(last_status_payload, '{}'::jsonb) || $1::jsonb
       WHERE id = $2::uuid`,
      [payload, rowId],
    );
    await client.query('RELEASE SAVEPOINT checkalt_reconcile_diagnostics');
    return true;
  } catch {
    try { await client.query('ROLLBACK TO SAVEPOINT checkalt_reconcile_diagnostics'); } catch { /* ignore */ }
    return false;
  }
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
  ...(extra.diagnostics ? { diagnostics: extra.diagnostics } : {}),
  ...(extra.diagnostics ? { diagnosticsPersisted: extra.diagnosticsPersisted === true } : {}),
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
  now = Date.now(),
} = {}) {
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

  const guardedFetch = statusReadOnlyFetch(fetchImpl);
  // HTTP status per path, for diagnostics only (getDepositItemStatus does not return it).
  const httpStatusByPath = {};
  const safeFetch = async (url, options) => {
    const resp = await guardedFetch(url, options);
    const text = String(url || '');
    const at = text.indexOf('/fincapture/');
    if (at >= 0) httpStatusByPath[text.slice(at).split('?')[0]] = resp?.status;
    return resp;
  };
  const { ssoKey, source: ssoKeySource } = await resolveSsoKeyOnce({
    cfg,
    credentials,
    acct,
    fetchImpl: safeFetch,
    jwtCache,
  });
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
    const historyBody = buildHistoryRequestBody({
      cfg,
      acct,
      ssoKey,
      submittedAt: row.submitted_at,
      now,
    });
    const hist = await checkAltFetch({
      cfg,
      credentials,
      path: '/fincapture/deposit/history',
      body: historyBody,
      fetchImpl: safeFetch,
      jwtCache,
    });
    const histJson = await parseJson(hist);
    const match = matchHistoryByReference(historyListOf(histJson), reference);
    if (!match) {
      const diagnostics = reconcileDiagnostics({
        item: { status: httpStatusByPath['/fincapture/deposit/item'], json: item.json },
        hist,
        histJson,
        reference,
        window: { startDate: historyBody.startDate, endDate: historyBody.endDate },
        ssoKeySource,
        secrets: [
          cfg?.fi_key,
          ssoKey,
          acct?.sso_key,
          acct?.sso_user_id,
          acct?.deposit_account_number,
          credentials?.username,
          credentials?.password,
        ],
      });
      const diagnosticsPersisted = await persistReconcileDiagnostics(client, row.id, diagnostics);
      console.warn(JSON.stringify({
        service: 'checksops-api',
        event: 'checkalt_reconcile_unresolved',
        deposit_id: row.id,
        diagnostics_persisted: diagnosticsPersisted,
        ...diagnostics,
      }));
      return reconciliationRequired(row, {
        liveProviderCalled: true,
        productionExecution: true,
        productionRecordsMutated: false,
        applicationUserId: mapping?.application_user_id,
        message: 'CheckAlt history has no unique referenceNumber match for this deposit. Amount is not a transaction id. Manual reconciliation required. A second process POST was not sent.',
        diagnostics,
        diagnosticsPersisted,
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
  const loadedCfg = await loadProductionCheckAltConfig(client, { credentials: secrets.credentials });
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
    const acctCache = new Map();
    for (const row of rows) {
      const authz = await authorizePollRow({ client, mapping, memberships, row });
      if (!authz.ok) {
        errors += 1;
        continue;
      }
      let acct = acctCache.get(row.tenant_id);
      if (!acct) {
        acct = await loadProductionTenantAccount(client, row.tenant_id);
        acctCache.set(row.tenant_id, acct);
      }
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
