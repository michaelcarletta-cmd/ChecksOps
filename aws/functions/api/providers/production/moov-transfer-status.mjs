/**
 * Production GET-only Moov transfer reconciliation.
 * Never POST/PATCH/PUT/DELETE Moov. Never INSERT payment_transfers.
 */
import { TENANT_MEMBERSHIP_SQL } from '../../identity.mjs';
import { membershipForTenant } from '../../financial-ownership.mjs';
import { productionMoovFetch } from './moov-client.mjs';
import { loadProductionMoovReadSecrets } from './moov-secrets.mjs';
import { reconcileExistingFromProviderGet, applyProductionMoovWebhook } from '../webhook-apply-production.mjs';
import { inferSweepActivity, normalizeMoovStatus } from '../moov-lifecycle.mjs';

const IN_FLIGHT = ['pending', 'processing', 'submitted', 'queued', 'created'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const fail = (error, statusCode, extra = {}) => ({
  ok: false,
  statusCode,
  error,
  provider: 'moov',
  liveProviderCalled: extra.liveProviderCalled === true,
  liveProviderPosted: false,
  createdPaymentTransfer: false,
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

const loadProductionAccount = async (client, tenantId) => (await client.query(
  `SELECT id, tenant_id, provider_account_id, environment
     FROM public.payment_provider_accounts
    WHERE tenant_id = $1::uuid AND provider = 'moov' AND environment = 'production'
    ORDER BY updated_at DESC NULLS LAST LIMIT 1`,
  [tenantId],
)).rows[0] || null;

const getTransfer = async ({ credentials, accountId, transferId, fetchImpl }) => {
  try {
    const result = await productionMoovFetch({
      credentials,
      path: `/accounts/${accountId}/transfers/${transferId}`,
      method: 'GET',
      mode: 'read',
      scopes: [`/accounts/${accountId}/transfers.read`],
      fetchImpl,
    });
    return { ok: true, json: result.json, liveProviderCalled: true };
  } catch (error) {
    return {
      ok: false,
      status: error.status || 500,
      error: error.message,
      liveProviderCalled: true,
    };
  }
};

export async function handleProductionMoovTransferStatus({
  client,
  mapping,
  body = {},
  fetchImpl = fetch,
  loadSecrets = loadProductionMoovReadSecrets,
} = {}) {
  const memberships = await membershipsOf(client, mapping.application_user_id);
  const claimed = body.tenant_id || body.tenantId || null;
  if (claimed && !UUID_RE.test(String(claimed))) {
    return fail('invalid_uuid', 400, { field: 'tenant_id' });
  }
  const tenantId = claimed
    ? (membershipForTenant(memberships, claimed)?.tenant_id || null)
    : (memberships[0]?.tenant_id || null);
  if (claimed && !tenantId) {
    return fail('cross_tenant_denied', 403, {
      message: 'Requested tenant_id is not a membership of the authenticated user',
    });
  }
  if (!tenantId) return fail('tenant_membership_required', 403);

  const secrets = await loadSecrets();
  if (!secrets?.ok) {
    return fail(secrets?.error || 'production_secret_missing', secrets?.statusCode || 503, {
      ...secrets,
      createdPaymentTransfer: false,
      liveProviderPosted: false,
    });
  }

  const account = await loadProductionAccount(client, tenantId);
  if (!account?.provider_account_id) {
    return fail('moov_account_not_found', 409, { message: 'No production Moov account for this tenant.' });
  }

  await client.query("SELECT set_config('request.moov_get_reconcile', '1', true)");
  await client.query("SELECT set_config('request.provider_webhook', '1', true)");

  const wantedId = body.provider_transfer_id || body.providerTransferId || null;
  const transferRows = (await client.query(
    `SELECT id, tenant_id, provider_transfer_id, status, provider_status, completed_at, environment, amount_cents
       FROM public.payment_transfers
      WHERE tenant_id = $1::uuid
        AND provider = 'moov'
        AND environment = 'production'
        AND provider_transfer_id IS NOT NULL
        AND (
          status = ANY($2::text[])
          OR ($3::text IS NOT NULL AND provider_transfer_id = $3)
        )
      ORDER BY created_at DESC NULLS LAST
      LIMIT 50`,
    [tenantId, IN_FLIGHT, wantedId],
  )).rows;

  const activityRows = (await client.query(
    `SELECT id, provider_transfer_id, status, origin, activity_kind
       FROM public.payment_provider_activity
      WHERE tenant_id = $1::uuid
        AND provider = 'moov'
        AND environment = 'production'
        AND provider_transfer_id IS NOT NULL
        AND (
          status IS NULL
          OR lower(status) = ANY($2::text[])
          OR ($3::text IS NOT NULL AND provider_transfer_id = $3)
        )
      ORDER BY observed_at DESC NULLS LAST
      LIMIT 50`,
    [tenantId, IN_FLIGHT, wantedId],
  )).rows;

  const accountIds = [account.provider_account_id];
  if (secrets.credentials?.platformAccountId
    && secrets.credentials.platformAccountId !== account.provider_account_id) {
    accountIds.push(secrets.credentials.platformAccountId);
  }

  const results = [];
  let updated = 0;
  let observed = 0;
  let liveProviderCalled = false;
  const seen = new Set();

  const refreshOne = async (providerTransferId, { isIntent }) => {
    if (!providerTransferId || seen.has(providerTransferId)) return;
    seen.add(providerTransferId);
    let remote = null;
    for (const accountId of accountIds) {
      const got = await getTransfer({
        credentials: secrets.credentials,
        accountId,
        transferId: providerTransferId,
        fetchImpl,
      });
      liveProviderCalled = liveProviderCalled || got.liveProviderCalled;
      if (got.ok) {
        remote = got.json;
        break;
      }
      if (got.status && got.status !== 404) {
        results.push({
          provider_transfer_id: providerTransferId,
          error: got.error,
          liveProviderCalled: true,
        });
        return;
      }
    }
    if (!remote) {
      results.push({
        provider_transfer_id: providerTransferId,
        skipped: 'provider_transfer_not_found',
        liveProviderCalled,
      });
      return;
    }

    const payload = {
      type: 'transfer.status_refresh',
      accountID: remote.accountID || account.provider_account_id,
      data: remote,
    };
    if (isIntent) {
      const recon = await reconcileExistingFromProviderGet(client, {
        providerTransferId,
        providerStatus: remote.status,
        completedOn: remote.completedOn || remote.completedAt || null,
        eventType: 'transfer.status_refresh',
        sweep: inferSweepActivity(payload),
      });
      if (recon.applied && recon.skipped !== 'idempotent_same_status') updated += 1;
      results.push({
        id: recon.payment_transfer_id || null,
        provider_transfer_id: providerTransferId,
        status: recon.status || normalizeMoovStatus(remote.status),
        skipped: recon.skipped || null,
        live: true,
      });
      return;
    }

    const observedRow = await applyProductionMoovWebhook(client, payload, {
      mappedTenantId: tenantId,
      dryRun: false,
    });
    if (observedRow.observed_id) observed += 1;
    results.push({
      provider_transfer_id: providerTransferId,
      observed: true,
      skipped: observedRow.skipped || null,
      status: remote.status || null,
      createdPaymentTransfer: false,
      live: true,
    });
  };

  for (const row of transferRows) {
    await refreshOne(row.provider_transfer_id, { isIntent: true });
  }
  for (const row of activityRows) {
    await refreshOne(row.provider_transfer_id, { isIntent: false });
  }

  return {
    ok: true,
    statusCode: 200,
    success: true,
    checked: seen.size,
    updated,
    observed,
    results,
    liveProviderCalled,
    liveProviderPosted: false,
    createdPaymentTransfer: false,
    productionExecution: true,
    environment: 'production',
  };
}
