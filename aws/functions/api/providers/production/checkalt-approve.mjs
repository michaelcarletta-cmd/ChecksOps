import { TENANT_MEMBERSHIP_SQL } from '../../identity.mjs';
import { membershipForTenant } from '../../financial-ownership.mjs';
import { checkAltFetch } from '../parity/checkalt-client.mjs';
import { loadProductionCheckAltConfig, loadProductionTenantAccount } from './checkalt-config.mjs';
import { persistPollOutcome } from './checkalt-idempotency.mjs';
import { loadProductionCheckAltSecrets } from './checkalt-secrets.mjs';
import { authorizeCheckAltProduction } from './checkalt-authz.mjs';
import {
  loadExistingProductionDeposit,
  reconcileProductionCheckAltDeposit,
} from './checkalt-poll.mjs';

const jwtCache = { token: null, expiresAt: null };

const fail = (error, statusCode, extra = {}) => ({
  ok: false,
  statusCode,
  error,
  provider: 'checkalt',
  liveProviderCalled: extra.liveProviderCalled === true,
  createdDeposit: false,
  approvePosted: false,
  action_taken: false,
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

const alreadyResolved = (row, refreshed, extra = {}) => ({
  ok: true,
  statusCode: 200,
  success: true,
  already_resolved: true,
  action_taken: false,
  approvePosted: false,
  liveProviderCalled: refreshed.liveProviderCalled === true,
  createdDeposit: false,
  productionExecution: true,
  productionRecordsMutated: refreshed.productionRecordsMutated === true,
  deposit_id: refreshed.deposit_id || row.id,
  checkalt_reference: row.checkalt_reference,
  status: refreshed.status || row.status,
  previous_status: row.status,
  reconciled: refreshed.reconciled === true,
  message: extra.message
    || (String(refreshed.status) === 'submitted'
      ? 'CheckAlt already approved this deposit. It was removed from Pending Approvals.'
      : 'CheckAlt no longer requires approval. The stale action was not sent.'),
  applicationUserId: extra.applicationUserId || null,
});

/**
 * Refresh CheckAlt item status, persist, then POST /deposit/approve only if
 * the provider still reports pending approval (40). Never treats 127/Approved
 * as settlement.
 */
export async function handleProductionCheckAltApprove({
  client,
  mapping,
  claims,
  body,
  spoof,
  fetchImpl = fetch,
  deps = {},
} = {}) {
  const actionName = body.action === 'reject' ? 'reject' : (body.action === 'approve' ? 'approve' : null);
  if (!actionName) {
    return fail('invalid_action', 400, {
      message: 'action must be approve or reject',
      spoofFieldsIgnored: spoof,
    });
  }
  const depositId = body.deposit_id || body.checkalt_deposit_id || null;
  const reference = body.checkalt_reference || body.referenceNumber || null;
  if (!depositId && !reference) {
    return fail('deposit_locator_required', 400, {
      message: 'Approve/reject requires deposit_id or checkalt_reference.',
      spoofFieldsIgnored: spoof,
    });
  }

  const row = await loadExistingProductionDeposit(client, { depositId, reference });
  if (!row) {
    return fail('deposit_not_found', 404, {
      message: 'No existing checkalt_deposits row. Approve will not insert a deposit.',
      spoofFieldsIgnored: spoof,
    });
  }

  const memberships = await membershipsOf(client, mapping.application_user_id);
  if (!membershipForTenant(memberships, row.tenant_id)) {
    return fail('cross_tenant_denied', 403, {
      message: 'Approve is tenant-safe. The deposit does not belong to the authenticated user.',
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
  if (!authz.ok && (authz.error === 'financial_unauthorized' || authz.error === 'cross_tenant_denied')) {
    return { ...authz, createdDeposit: false, approvePosted: false, action_taken: false, spoofFieldsIgnored: spoof };
  }
  if (!authz.evaluation?.roleOk) {
    return fail('financial_unauthorized', 403, {
      message: 'Operator cannot approve production CheckAlt for another authority path.',
      spoofFieldsIgnored: spoof,
    });
  }

  const secrets = await (deps.loadProductionSecrets || loadProductionCheckAltSecrets)(deps.getSecrets);
  if (!secrets.ok) return { ...secrets, createdDeposit: false, approvePosted: false, spoofFieldsIgnored: spoof };
  const loadedCfg = await loadProductionCheckAltConfig(client, { credentials: secrets.credentials });
  if (!loadedCfg.ok) return { ...loadedCfg, createdDeposit: false, approvePosted: false, spoofFieldsIgnored: spoof };
  const acct = await loadProductionTenantAccount(client, row.tenant_id);

  const refreshed = await reconcileProductionCheckAltDeposit({
    client,
    mapping,
    row,
    cfg: loadedCfg.cfg,
    credentials: loadedCfg.credentials,
    acct,
    fetchImpl,
  });
  if (!refreshed.reconciled) {
    return fail(refreshed.error || 'reconciliation_required', refreshed.statusCode || 409, {
      message: refreshed.message || 'Could not refresh CheckAlt status. Approve/reject was not sent.',
      liveProviderCalled: refreshed.liveProviderCalled === true,
      productionExecution: true,
      spoofFieldsIgnored: spoof,
      deposit_id: row.id,
      status: refreshed.status || row.status,
    });
  }
  if (refreshed.status !== 'pending_approval') {
    return {
      ...alreadyResolved(row, refreshed, { applicationUserId: mapping.application_user_id }),
      spoofFieldsIgnored: spoof,
      applicationUserId: mapping.application_user_id,
      authUid: mapping.application_user_id,
      cognitoSub: claims.sub,
    };
  }

  const payload = {
    fiKey: loadedCfg.cfg.fi_key,
    referenceNumber: Number(row.checkalt_reference),
    action: actionName === 'approve' ? 1 : 2,
  };
  if (actionName === 'reject' && body.reject_notes) payload.rejectNotes = body.reject_notes;
  if (actionName === 'reject') payload.rejectCode = body.reject_code ?? 1721;

  const resp = await checkAltFetch({
    cfg: loadedCfg.cfg,
    credentials: loadedCfg.credentials,
    path: '/fincapture/deposit/approve',
    body: payload,
    fetchImpl,
    jwtCache,
  });
  const raw = await resp.text();
  let json;
  try { json = JSON.parse(raw); } catch { json = { raw: String(raw).slice(0, 500) }; }
  if (!resp.ok || json?.success !== true) {
    return fail('checkalt_approve_failed', 502, {
      message: 'CheckAlt did not confirm the approval. Local status was refreshed first; no fabricated settlement.',
      liveProviderCalled: true,
      productionExecution: true,
      spoofFieldsIgnored: spoof,
      deposit_id: row.id,
      status: refreshed.status,
    });
  }

  const internalStatus = actionName === 'reject' ? 'rejected' : 'submitted';
  const saved = await persistPollOutcome(client, {
    rowId: row.id,
    status: internalStatus,
    reference: row.checkalt_reference,
    providerPayload: json,
  });
  return {
    ok: true,
    statusCode: 200,
    success: true,
    already_resolved: false,
    action_taken: true,
    approvePosted: true,
    liveProviderCalled: true,
    createdDeposit: false,
    productionExecution: true,
    productionRecordsMutated: true,
    deposit_id: saved.id,
    checkalt_reference: saved.checkalt_reference,
    status: saved.status,
    previous_status: row.status,
    status_description: json?.statusDescription ?? null,
    api_status: json?.status ?? json?.statusCode ?? null,
    spoofFieldsIgnored: spoof,
    applicationUserId: mapping.application_user_id,
    authUid: mapping.application_user_id,
    cognitoSub: claims.sub,
  };
}
