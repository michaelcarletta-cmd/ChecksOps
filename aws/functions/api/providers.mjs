import { ignoredSpoof, parseBody, withIdentity } from './data.mjs';
import { TENANT_MEMBERSHIP_SQL } from './identity.mjs';
import {
  denyProviderExecution,
  executionAllowed,
  flagSnapshot,
  isProductionChecksOpsRuntime,
  moovTransferPostEnabled,
  providerEnabled,
  providerExecutionEnabled,
  providerLiveReadsEnabled,
} from './provider-flags.mjs';
import { providerPermissionSnapshot } from './provider-authz.mjs';
import { providerSecretsConfigured } from './provider-secrets.mjs';
import {
  ACTUM_BOUNDARY,
  FUNCTION_BY_NAME,
  OP_CLASS,
  PROVIDER_FUNCTIONS,
  classifyFunction,
} from './providers/catalog.mjs';
import { actumExecutionStub, actumInterface } from './providers/actum.mjs';
import {
  checkAltAmountPreview,
  checkaltExecutionStub,
  publicCheckAltAccount,
  publicCheckAltDeposit,
} from './providers/checkalt.mjs';
import {
  localMoovReadiness,
  moovExecutionStub,
  publicMoovAccount,
  publicMoovTransfer,
  publicMoovWallet,
} from './providers/moov.mjs';
import { plaidExecutionStub, publicPlaidStatus } from './providers/plaid.mjs';
import { quickbooksExecutionStub, quickbooksInterface } from './providers/quickbooks.mjs';
import { handleProviderWebhook } from './providers/webhooks.mjs';
import { handleProviderEgress } from './providers/egress.mjs';
import { providerSandboxExecutionEnabled } from './sandbox-flags.mjs';
import { hasParityHandler, runParityHandler } from './providers/parity/dispatch.mjs';
import { hasProductionCheckAltHandler, runProductionCheckAltHandler } from './providers/production/checkalt-dispatch.mjs';
import {
  checkaltStatusReadOnlyMode,
  denyCheckAltMutationUnderStatusRead,
  isCheckAltMutationFunction,
  isCheckAltStatusReadFunction,
} from './providers/production/checkalt-status-read.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isUuid = (value) => UUID_RE.test(String(value || ''));

const functionNameFromPath = (path) => {
  const match = String(path || '').match(/^\/functions(?:\/v1)?\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
};

const membershipsOf = async (client, userId) => {
  const rows = (await client.query(TENANT_MEMBERSHIP_SQL, [userId])).rows;
  return rows.map((row) => ({
    tenant_id: row.tenant_id,
    role: row.role,
    tenant_name: row.tenant_name,
    tenant_slug: row.tenant_slug,
  }));
};

const claimedTenant = (body) => body?.tenant_id || body?.tenantId || null;

const denyIfSpoofedTenant = (claimed, memberships) => {
  if (!claimed) return null;
  if (!isUuid(claimed)) return { ok: false, statusCode: 400, error: 'invalid_uuid', field: 'tenant_id' };
  if (!memberships.some((row) => row.tenant_id === claimed)) {
    return {
      ok: false,
      statusCode: 403,
      error: 'cross_tenant_denied',
      message: 'Requested tenant_id is not a membership of the authenticated user',
    };
  }
  return null;
};

const requireOwnedRow = (row, field) => {
  if (row) return null;
  return {
    ok: false,
    statusCode: 403,
    error: 'spoofed_provider_id',
    field,
    message: 'Provider identifier is not owned by the authenticated tenant',
  };
};

const okStatus = ({ mapping, claims, spoof, provider, data }) => ({
  ok: true,
  statusCode: 200,
  provider,
  liveProviderCalled: false,
  executionEnabled: executionAllowed(provider),
  applicationUserId: mapping.application_user_id,
  authUid: mapping.application_user_id,
  cognitoSub: claims.sub,
  spoofFieldsIgnored: spoof,
  authorizationSource: 'rls',
  ...data,
});

export const handleProviderFlags = async () => ({
  ok: true,
  statusCode: 200,
  service: 'checksops-api',
  environment: process.env.CHECKSOPS_ENV || 'unknown',
  productionSupabaseChanged: false,
  productionWebhooksRedirected: false,
  liveProviderTransactions: false,
  flags: flagSnapshot(),
  permissions: providerPermissionSnapshot(),
  secrets: await providerSecretsConfigured(),
  inventoryCount: PROVIDER_FUNCTIONS.length + 1,
  actum: ACTUM_BOUNDARY,
});

const loadMoovAccount = async (client, { providerAccountId } = {}) => {
  const params = [];
  let sql = `SELECT id, tenant_id, provider, provider_account_id, environment, account_type,
    onboarding_status, verification_status, tos_accepted_at, tos_source, tos_accepted_by,
    can_send_payments, can_receive_payments, can_ach_credit, can_ach_debit,
    disabled, restricted, fee_plan_code, display_name, last_synced_at,
    capabilities, readiness, provider_metadata
    FROM public.payment_provider_accounts
    WHERE provider = 'moov'`;
  if (providerAccountId) {
    params.push(providerAccountId);
    sql += ` AND provider_account_id = $${params.length}`;
  }
  sql += ' ORDER BY updated_at DESC NULLS LAST LIMIT 5';
  return (await client.query(sql, params)).rows;
};

const loadMoovWallets = async (client, { walletId, providerWalletId, providerAccountId } = {}) => {
  const params = [];
  let sql = `SELECT id, tenant_id, provider, provider_wallet_id, provider_account_id, wallet_type,
    status, available_cents, pending_cents, currency, environment, last_synced_at
    FROM public.payment_wallets WHERE provider = 'moov'`;
  if (walletId) {
    params.push(walletId);
    sql += ` AND id = $${params.length}::uuid`;
  }
  if (providerWalletId) {
    params.push(providerWalletId);
    sql += ` AND provider_wallet_id = $${params.length}`;
  }
  if (providerAccountId) {
    params.push(providerAccountId);
    sql += ` AND provider_account_id = $${params.length}`;
  }
  sql += ' ORDER BY updated_at DESC NULLS LAST LIMIT 20';
  return (await client.query(sql, params)).rows;
};

const loadMoovTransfers = async (client, { transferId, providerTransferId } = {}) => {
  const params = [];
  let sql = `SELECT id, tenant_id, provider, provider_transfer_id, status, provider_status,
    amount_cents, currency, speed, selected_rail, wallet_id, created_at
    FROM public.payment_transfers WHERE provider = 'moov'`;
  if (transferId) {
    params.push(transferId);
    sql += ` AND id = $${params.length}::uuid`;
  }
  if (providerTransferId) {
    params.push(providerTransferId);
    sql += ` AND provider_transfer_id = $${params.length}`;
  }
  sql += ' ORDER BY created_at DESC NULLS LAST LIMIT 20';
  return (await client.query(sql, params)).rows;
};

export const handleMoovStatus = async (event, deps = {}) => withIdentity(event, async ({ client, mapping, claims, body, spoof }) => {
  const memberships = await membershipsOf(client, mapping.application_user_id);
  const tenantError = denyIfSpoofedTenant(claimedTenant(body), memberships);
  if (tenantError) return { ...tenantError, spoofFieldsIgnored: spoof };

  const providerAccountId = body.provider_account_id || body.account_id || body.moov_account_id || null;
  const walletId = body.wallet_id || null;
  const providerWalletId = body.provider_wallet_id || null;
  const transferId = body.transfer_id || null;
  const providerTransferId = body.provider_transfer_id || null;

  const accounts = await loadMoovAccount(client, { providerAccountId });
  if (providerAccountId) {
    const denied = requireOwnedRow(accounts[0], 'provider_account_id');
    if (denied) return { ...denied, spoofFieldsIgnored: spoof };
  }

  const wallets = await loadMoovWallets(client, { walletId, providerWalletId, providerAccountId: accounts[0]?.provider_account_id });
  if (walletId || providerWalletId) {
    const denied = requireOwnedRow(wallets[0], walletId ? 'wallet_id' : 'provider_wallet_id');
    if (denied) return { ...denied, spoofFieldsIgnored: spoof };
  }

  const transfers = await loadMoovTransfers(client, { transferId, providerTransferId });
  if (transferId || providerTransferId) {
    const denied = requireOwnedRow(transfers[0], transferId ? 'transfer_id' : 'provider_transfer_id');
    if (denied) return { ...denied, spoofFieldsIgnored: spoof };
  }

  const account = accounts[0] || null;
  return okStatus({
    mapping,
    claims,
    spoof,
    provider: 'moov',
    data: {
      memberships,
      account: publicMoovAccount(account),
      readiness: localMoovReadiness(account),
      wallets: wallets.map(publicMoovWallet),
      transfers: transfers.map(publicMoovTransfer),
      idempotency: {
        model: 'payment_idempotency_keys + payment_transfers.idempotency_key + payment_webhook_events unique(provider, external_event_id)',
        awsReceipts: 'aws_provider_webhook_receipts unique(provider, external_event_id)',
      },
    },
  });
}, deps);

export const handleCheckAltStatus = async (event, deps = {}) => withIdentity(event, async ({ client, mapping, claims, body, spoof }) => {
  const memberships = await membershipsOf(client, mapping.application_user_id);
  const tenantError = denyIfSpoofedTenant(claimedTenant(body), memberships);
  if (tenantError) return { ...tenantError, spoofFieldsIgnored: spoof };

  const depositId = body.deposit_id || body.checkalt_deposit_id || null;
  const reference = body.checkalt_reference || body.referenceNumber || null;
  const accounts = (await client.query(
    `SELECT id, tenant_id, enabled, registered_at, auto_approve_enabled,
            deposit_account_number, sso_user_id
     FROM public.checkalt_tenant_accounts
     ORDER BY updated_at DESC NULLS LAST LIMIT 5`,
  )).rows;

  let depositsSql = `SELECT id, tenant_id, check_intake_item_id, checkalt_reference, status,
    amount, submitted_at, approved_at, cleared_at, returned_at, last_polled_at
    FROM public.checkalt_deposits`;
  const params = [];
  const clauses = [];
  if (depositId) {
    if (!isUuid(depositId)) return { ok: false, statusCode: 400, error: 'invalid_uuid', field: 'deposit_id', spoofFieldsIgnored: spoof };
    params.push(depositId);
    clauses.push(`id = $${params.length}::uuid`);
  }
  if (reference) {
    params.push(reference);
    clauses.push(`checkalt_reference = $${params.length}`);
  }
  if (clauses.length) depositsSql += ` WHERE ${clauses.join(' AND ')}`;
  depositsSql += ' ORDER BY created_at DESC NULLS LAST LIMIT 20';
  const deposits = (await client.query(depositsSql, params)).rows;
  if (depositId || reference) {
    const denied = requireOwnedRow(deposits[0], depositId ? 'deposit_id' : 'checkalt_reference');
    if (denied) return { ...denied, spoofFieldsIgnored: spoof };
  }

  return okStatus({
    mapping,
    claims,
    spoof,
    provider: 'checkalt',
    data: {
      memberships,
      account: publicCheckAltAccount(accounts[0] || null),
      deposits: deposits.map(publicCheckAltDeposit),
      amountFormatting: checkAltAmountPreview(body.amount ?? deposits[0]?.amount ?? 123.45),
    },
  });
}, deps);

export const handlePlaidStatus = async (event, deps = {}) => withIdentity(event, async ({ client, mapping, claims, body, spoof }) => {
  const memberships = await membershipsOf(client, mapping.application_user_id);
  const tenantError = denyIfSpoofedTenant(claimedTenant(body), memberships);
  if (tenantError) return { ...tenantError, spoofFieldsIgnored: spoof };

  let splits = [];
  try {
    const transferId = body.plaid_transfer_id || body.transfer_id || null;
    const params = [];
    let sql = `SELECT id, tenant_id, amount, status, plaid_transfer_id
      FROM public.disbursement_splits`;
    if (transferId) {
      params.push(transferId);
      sql += ` WHERE plaid_transfer_id = $${params.length}`;
    }
    sql += ' ORDER BY created_at DESC NULLS LAST LIMIT 10';
    splits = (await client.query(sql, params)).rows;
    if (transferId) {
      const denied = requireOwnedRow(splits[0], 'plaid_transfer_id');
      if (denied) return { ...denied, spoofFieldsIgnored: spoof };
    }
  } catch {
    splits = [];
  }

  return okStatus({
    mapping,
    claims,
    spoof,
    provider: 'plaid',
    data: {
      memberships,
      ...publicPlaidStatus({ transfers: splits }),
    },
  });
}, deps);

export const handleActumStatus = async (event, deps = {}) => withIdentity(event, async ({ mapping, claims, spoof }) => (
  okStatus({
    mapping,
    claims,
    spoof,
    provider: 'actum',
    data: actumInterface(),
  })
), deps);

export const handleQuickBooksStatus = async (event, deps = {}) => withIdentity(event, async ({ mapping, claims, spoof }) => (
  okStatus({
    mapping,
    claims,
    spoof,
    provider: 'quickbooks',
    data: quickbooksInterface(),
  })
), deps);

const dispatchKnownFunction = (spec, body) => {
  if (!spec) {
    return denyProviderExecution(null, 'unknown_function', { error: 'provider_disabled' });
  }
  if (spec.aws === 'db_status') {
    return { route: spec.provider };
  }
  if (spec.provider === 'moov') return moovExecutionStub(spec.name);
  if (spec.provider === 'checkalt') return checkaltExecutionStub(spec.name);
  if (spec.provider === 'plaid') return plaidExecutionStub(spec.name);
  if (spec.provider === 'quickbooks') return quickbooksExecutionStub(spec.name);
  if (spec.provider === 'actum') return actumExecutionStub(spec.name);
  return denyProviderExecution(spec.provider, spec.name);
};

export const handleFunctionInvoke = async (event, name, deps = {}) => {
  // Class A ordinary services are owned by app-services.mjs — never stub them here.
  try {
    const { CLASS_A_FUNCTIONS } = await import('./app-services.mjs');
    if (CLASS_A_FUNCTIONS?.has?.(name)) return null;
  } catch {
    /* app-services optional during early boot */
  }

  const spec = classifyFunction(name) || (name === 'actum' ? ACTUM_BOUNDARY : null);
  if (!spec) {
    return denyProviderExecution(null, name, {
      message: 'Unknown or disabled provider function',
    });
  }

  if (hasProductionCheckAltHandler(name) || isCheckAltStatusReadFunction(name)) {
    const production = await runProductionCheckAltHandler(name, event, deps);
    if (production) return production;
  }

  if (checkaltStatusReadOnlyMode() && isCheckAltMutationFunction(name)) {
    return denyCheckAltMutationUnderStatusRead(name);
  }

  const productionMoov = isProductionChecksOpsRuntime()
    && spec.provider === 'moov'
    && executionAllowed('moov');

  if (executionAllowed(spec.provider) && spec.aws !== 'db_status' && spec.aws !== 'webhook' && !productionMoov) {
    return denyProviderExecution(spec.provider, spec.name, {
      error: 'production_execution_blocked',
      message: 'Production provider flags stay false. Staging never uses production Moov/CheckAlt keys. Enable AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED for sandbox/UAT ports only.',
      tranche4HardBlock: true,
    });
  }

  if (productionMoov && (spec.class === OP_CLASS.MONEY_MOVEMENT || spec.class === OP_CLASS.DISBURSEMENT)
    && !moovTransferPostEnabled()) {
    return denyProviderExecution('moov', spec.name, {
      error: 'moov_transfer_post_disabled',
      message: 'Moov is generally available for onboarding. Real-money transfers stay held by AWS_MOOV_TRANSFER_POST_ENABLED.',
    });
  }

  if ((providerSandboxExecutionEnabled() || productionMoov) && hasParityHandler(name)) {
    return runParityHandler(name, event, deps);
  }

  if (spec.aws === 'db_status') {
    if (spec.provider === 'moov') return handleMoovStatus(event, deps);
    if (spec.provider === 'checkalt') return handleCheckAltStatus(event, deps);
    if (spec.provider === 'plaid') return handlePlaidStatus(event, deps);
  }

  if (spec.aws === 'webhook') {
    return {
      ok: false,
      statusCode: 405,
      error: 'use_webhook_route',
      message: `Use POST /webhooks/${spec.provider} for webhook ingestion`,
    };
  }

  if (!providerEnabled(spec.provider) || !providerExecutionEnabled()) {
    return dispatchKnownFunction(spec, parseBody(event));
  }

  return dispatchKnownFunction(spec, parseBody(event));
};

export const handleWebhookRoute = (event, provider, deps = {}) => handleProviderWebhook(event, provider, deps);

export const providerRoute = (path, method) => {
  if (method === 'GET' && (path === '/providers/status' || path === '/providers/health')) {
    return { kind: 'flags' };
  }
  if (method === 'GET' && path === '/providers/egress') return { kind: 'egress' };
  if (method === 'POST' && path === '/providers/moov/status') return { kind: 'moov' };
  if (method === 'POST' && path === '/providers/checkalt/status') return { kind: 'checkalt' };
  if (method === 'POST' && path === '/providers/plaid/status') return { kind: 'plaid' };
  if (method === 'POST' && path === '/providers/actum/status') return { kind: 'actum' };
  if (method === 'POST' && path === '/providers/quickbooks/status') return { kind: 'quickbooks' };
  if (method === 'POST' && path === '/webhooks/moov') return { kind: 'webhook', provider: 'moov' };
  if (method === 'POST' && path === '/webhooks/checkalt') return { kind: 'webhook', provider: 'checkalt' };
  if (method === 'POST' && path === '/webhooks/plaid') return { kind: 'webhook', provider: 'plaid' };
  const fnName = functionNameFromPath(path);
  if (fnName && (method === 'POST' || method === 'GET')) return { kind: 'function', name: fnName };
  return null;
};

export const handleProviderRequest = async (event, path, method, deps = {}) => {
  const route = providerRoute(path, method);
  if (!route) return null;
  if (route.kind === 'flags') return handleProviderFlags();
  if (route.kind === 'egress') return handleProviderEgress(event, deps);
  if (route.kind === 'moov') return handleMoovStatus(event, deps);
  if (route.kind === 'checkalt') return handleCheckAltStatus(event, deps);
  if (route.kind === 'plaid') return handlePlaidStatus(event, deps);
  if (route.kind === 'actum') return handleActumStatus(event, deps);
  if (route.kind === 'quickbooks') return handleQuickBooksStatus(event, deps);
  if (route.kind === 'webhook') return handleWebhookRoute(event, route.provider, deps);
  if (route.kind === 'function') return handleFunctionInvoke(event, route.name, deps);
  return null;
};

export const unusedLiveReadGuard = () => {
  if (providerLiveReadsEnabled()) {
    return { warning: 'AWS_PROVIDER_LIVE_READS_ENABLED is unused in Tranche 4; adapters never call providers.' };
  }
  return null;
};

export { FUNCTION_BY_NAME, PROVIDER_FUNCTIONS, functionNameFromPath };
