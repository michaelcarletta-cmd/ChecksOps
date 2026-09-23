import { FINANCIAL_ROLES, roleAllowsFinancial } from '../../financial-authz.mjs';
import { membershipForTenant } from '../../financial-ownership.mjs';
import { financialPermissionsActivated } from '../../financial-flags.mjs';
import { validateProviderCents } from '../amounts.mjs';
import {
  FREEDOM_PRODUCTION_TENANT_ID,
  denyMoovProductionHold,
  productionMoovExecutionAllowed,
} from './moov-holds.mjs';
import {
  assertProductionMethod,
  isProductionFreedomAccount,
  isProductionFreedomTenant,
  loadProductionConnectedMethod,
  loadProductionMoovAccount,
  loadProductionRecipient,
  loadProductionTenant,
  loadProductionWallet,
} from './moov-methods.mjs';

export const MOOV_TOTP_ACTION = 'disbursement.send';
export const TOTP_STEPUP_TTL_MS = 30 * 60 * 1000;

export const dollarsToPayableCents = (value) => {
  if (value === undefined || value === null || value === '') return null;
  if (Number.isInteger(value) && value > 100) return value;
  const dollars = Number(value);
  if (!Number.isFinite(dollars)) return null;
  return Math.round(dollars * 100);
};

export const destinationFingerprint = ({
  recipientId = null,
  methodId = null,
  providerMethodId = null,
} = {}) => [
  String(recipientId || ''),
  String(methodId || ''),
  String(providerMethodId || ''),
].join('|');

export const stepUpMatchesDisbursement = (row, {
  tenantId,
  transferId,
  batchId,
  amountCents,
  destinationId,
  actionKey = MOOV_TOTP_ACTION,
} = {}) => {
  if (!row || !tenantId || !Number.isInteger(Number(amountCents))) return false;
  if (String(row.tenant_id) !== String(tenantId)) return false;
  if (String(row.action_key) !== String(actionKey)) return false;
  if (row.succeeded !== true) return false;
  const meta = row.metadata || {};
  if (String(meta.operation || actionKey) !== MOOV_TOTP_ACTION) return false;
  if (Number(meta.amount_cents) !== Number(amountCents)) return false;
  const resourceId = transferId || batchId;
  const loggedResource = String(meta.transfer_id || meta.batch_id || meta.disbursement_id || '');
  if (!resourceId || loggedResource !== String(resourceId)) return false;
  if (destinationId && String(meta.destination_id || '') !== String(destinationId)) return false;
  return true;
};

export async function loadTenantRole(client, userId, tenantId) {
  if (!userId || !tenantId) return [];
  const tenant = (await client.query(
    'SELECT role FROM public.tenant_users WHERE user_id = $1::uuid AND tenant_id = $2::uuid',
    [userId, tenantId],
  )).rows.map((row) => String(row.role || '').toLowerCase());
  const platform = (await client.query(
    'SELECT role FROM public.user_roles WHERE user_id = $1::uuid',
    [userId],
  )).rows.map((row) => String(row.role || '').toLowerCase());
  return [...new Set([...tenant, ...platform])];
}

export async function loadRecentDisbursementStepUp(client, {
  userId,
  tenantId,
  transferId,
  batchId,
  amountCents,
  destinationId,
  sinceMs = TOTP_STEPUP_TTL_MS,
} = {}) {
  if (!userId || !tenantId || !Number.isInteger(Number(amountCents))) return [];
  const resourceId = String(transferId || batchId || '');
  if (!resourceId) return [];
  const rows = (await client.query(
    `SELECT id, user_id, tenant_id, action_key, factor_type, succeeded, metadata, created_at
     FROM public.financial_stepup_log
     WHERE user_id = $1::uuid
       AND tenant_id = $2::uuid
       AND action_key = $3
       AND succeeded IS TRUE
       AND created_at >= $4::timestamptz
       AND COALESCE((metadata->>'amount_cents')::bigint, -1) = $5::bigint
       AND COALESCE(metadata->>'operation', $3) = $3
       AND (
         (metadata->>'transfer_id') = $6
         OR (metadata->>'batch_id') = $6
         OR (metadata->>'disbursement_id') = $6
       )
     ORDER BY created_at DESC
     LIMIT 5`,
    [
      userId,
      tenantId,
      MOOV_TOTP_ACTION,
      new Date(Date.now() - sinceMs).toISOString(),
      Number(amountCents),
      resourceId,
    ],
  )).rows;
  return rows.filter((row) => stepUpMatchesDisbursement(row, {
    tenantId,
    transferId,
    batchId,
    amountCents: Number(amountCents),
    destinationId,
  }));
}

export const evaluateMoovProductionAuthorization = ({
  identityOk,
  membershipOk,
  roles = [],
  totpOk = false,
  flagsOk = false,
  tenantOk = false,
  accountOk = false,
} = {}) => {
  const roleOk = roleAllowsFinancial(roles);
  const canExecute = Boolean(
    identityOk && membershipOk && roleOk && totpOk && flagsOk && tenantOk && accountOk,
  );
  return {
    identityOk: Boolean(identityOk),
    membershipOk: Boolean(membershipOk),
    roleOk,
    totpOk: Boolean(totpOk),
    flagsOk: Boolean(flagsOk),
    tenantOk: Boolean(tenantOk),
    accountOk: Boolean(accountOk),
    financialPermissionActivated: financialPermissionsActivated(),
    financialRoles: [...FINANCIAL_ROLES],
    canExecuteProductionMoov: canExecute,
    canExecuteProduction: false,
    message: !identityOk
      ? 'Cognito identity is required.'
      : !membershipOk
        ? 'Tenant membership of the disbursement is required.'
        : !roleOk
          ? 'Operator/staff cannot execute production Moov. Owner/admin/manager required.'
          : !totpOk
            ? 'A fresh server-bound disbursement.send TOTP is required for this tenant, amount, destination, and transfer.'
            : !flagsOk
              ? 'Production Moov holds remain on.'
              : !tenantOk
                ? 'Only the production Freedom tenant may execute this path.'
                : !accountOk
                  ? 'Production Freedom Moov account is not the authorized payer.'
                  : 'Moov production authorization satisfied. Holds must still be lifted by a human.',
  };
};

const failAuthz = (error, extra = {}) => denyMoovProductionHold(error, {
  message: extra.message || 'Financial authorization denied. Cognito login is not money-movement authority.',
  ...extra,
});

export async function loadApprovedDisbursement(client, { batchId = null, transferId = null } = {}) {
  if (transferId) {
    const transfer = (await client.query(
      `SELECT *
       FROM public.payment_transfers
       WHERE id = $1::uuid
       LIMIT 1`,
      [transferId],
    )).rows[0] || null;
    if (!transfer) return { ok: false, error: 'transfer_not_found', statusCode: 404 };
    return { ok: true, kind: 'transfer', transfer, batch: null, splits: [] };
  }
  if (batchId) {
    const batch = (await client.query(
      `SELECT id, tenant_id, status, delivery_speed, check_intake_item_id,
              approved_amount_cents, approved_at, available_amount, check_amount
       FROM public.disbursement_batches
       WHERE id = $1::uuid`,
      [batchId],
    )).rows[0] || null;
    if (!batch) return { ok: false, error: 'Disbursement batch not found.', statusCode: 404 };
    const splits = (await client.query(
      `SELECT s.id, s.amount, s.status, s.moov_transfer_id, s.stakeholder_account_id, s.recipient_name,
              a.id AS acct_id, a.nickname, a.custname, a.provider, a.provider_environment,
              a.provider_account_id, a.provider_bank_account_id, a.provider_payment_method_id
       FROM public.disbursement_splits s
       LEFT JOIN public.stakeholder_accounts a ON a.id = s.stakeholder_account_id
       WHERE s.batch_id = $1::uuid`,
      [batchId],
    )).rows;
    return { ok: true, kind: 'batch', transfer: null, batch, splits };
  }
  return {
    ok: false,
    error: 'approved_disbursement_required',
    statusCode: 400,
    message: 'Production Moov execution requires a server-side transfer_id or batch_id. Browser amount_cents is not authority.',
  };
}

export const serverAmountFromDisbursement = ({ transfer, batch, splits = [] } = {}) => {
  if (transfer && Number.isInteger(Number(transfer.amount_cents)) && Number(transfer.amount_cents) > 0) {
    return validateProviderCents(Number(transfer.amount_cents));
  }
  const approved = Number(batch?.approved_amount_cents);
  if (Number.isInteger(approved) && approved > 0) {
    return validateProviderCents(approved);
  }
  const payable = (splits || []).filter((split) => (
    !split.moov_transfer_id
    && !['failed', 'cancelled', 'returned', 'canceled'].includes(String(split.status || ''))
  ));
  const cents = payable.reduce((sum, split) => {
    const fromCents = Number(split.amount_cents);
    if (Number.isInteger(fromCents) && fromCents > 0) return sum + fromCents;
    const converted = dollarsToPayableCents(split.amount);
    return sum + (Number.isInteger(converted) ? converted : 0);
  }, 0);
  return validateProviderCents(cents);
};

export const compareOptionalClientAmount = (body, serverCents) => {
  const claimed = body?.amount_cents ?? body?.amountCents ?? null;
  if (claimed === undefined || claimed === null || claimed === '') return null;
  if (Number(claimed) !== Number(serverCents)) {
    return {
      ok: false,
      error: 'amount_mismatch',
      statusCode: 409,
      message: 'Browser amount_cents does not match the server-authoritative disbursement amount and is ignored as authority.',
    };
  }
  return null;
};

export const compareOptionalClientDestination = (body, destination) => {
  const claimedRecipient = body?.external_recipient_id || body?.destination_recipient_id || body?.recipient_id || null;
  const claimedMethod = body?.destination_payment_method_id || body?.payment_method_id || body?.provider_payment_method_id || null;
  if (claimedRecipient && destination?.recipientId && String(claimedRecipient) !== String(destination.recipientId)) {
    return {
      ok: false,
      error: 'destination_tamper',
      statusCode: 403,
      message: 'Browser recipient identifier does not match the authorized production destination.',
    };
  }
  if (claimedMethod && destination?.methodId && String(claimedMethod) !== String(destination.methodId)
    && String(claimedMethod) !== String(destination.providerMethodId || '')) {
    return {
      ok: false,
      error: 'destination_tamper',
      statusCode: 403,
      message: 'Browser payment-method identifier does not match the authorized production destination.',
    };
  }
  return null;
};

export async function resolveProductionDestination(client, {
  tenantId,
  transfer,
  splits = [],
} = {}) {
  if (transfer?.destination_recipient_id || transfer?.destination_payment_method_id) {
    const recipient = transfer.destination_recipient_id
      ? await loadProductionRecipient(client, {
        tenantId,
        recipientId: transfer.destination_recipient_id,
      })
      : null;
    if (transfer.destination_recipient_id && !recipient) {
      return { ok: false, error: 'destination_tamper', statusCode: 403, message: 'Authorized recipient is not owned by this tenant.' };
    }
    const method = await loadProductionConnectedMethod(client, {
      tenantId,
      providerAccountId: recipient?.provider_account_id || null,
      methodId: transfer.destination_payment_method_id || null,
      externalRecipientId: recipient?.id || null,
    });
    const checked = assertProductionMethod(method, { tenantId, label: 'destination method' });
    if (!checked.ok) return checked;
    return {
      ok: true,
      recipientId: recipient?.id || transfer.destination_recipient_id || null,
      methodId: checked.method.id,
      providerMethodId: checked.providerMethodId,
      destinationAccountId: recipient?.provider_account_id || checked.method.provider_account_id || null,
      label: recipient?.display_name || 'recipient',
    };
  }

  const payable = (splits || []).filter((split) => (
    !split.moov_transfer_id
    && !['failed', 'cancelled', 'returned', 'canceled'].includes(String(split.status || ''))
  ));
  if (payable.length !== 1) {
    return {
      ok: false,
      error: payable.length === 0 ? 'production_method_missing' : 'destination_tamper',
      statusCode: 409,
      message: payable.length === 0
        ? 'This batch has no unpaid production split to send.'
        : 'Production execution sends one authorized destination per request. Split batches must be executed per split.',
    };
  }
  const split = payable[0];
  if (split.provider && split.provider !== 'moov') {
    return { ok: false, error: 'sandbox_method_refused', statusCode: 409, message: 'Destination is not a Moov payout method.' };
  }
  if (split.provider_environment && split.provider_environment !== 'production') {
    return { ok: false, error: 'sandbox_method_refused', statusCode: 409, message: 'Sandbox stakeholder methods cannot be used in production.' };
  }
  let method = null;
  if (split.provider_payment_method_id || split.acct_id) {
    method = await loadProductionConnectedMethod(client, {
      tenantId,
      providerAccountId: split.provider_account_id || null,
      methodId: split.provider_payment_method_id || null,
    });
  }
  if (!method && split.provider_account_id) {
    method = await loadProductionConnectedMethod(client, {
      tenantId,
      providerAccountId: split.provider_account_id,
    });
  }
  const checked = assertProductionMethod(method || {
    environment: split.provider_environment || null,
    provider_payment_method_id: split.provider_payment_method_id || null,
    tenant_id: tenantId,
    connection_status: 'connected',
    id: split.acct_id || null,
    provider_account_id: split.provider_account_id || null,
  }, { tenantId, label: 'destination method' });
  if (!checked.ok) return checked;
  return {
    ok: true,
    recipientId: split.stakeholder_account_id || null,
    methodId: checked.method.id,
    providerMethodId: checked.providerMethodId,
    destinationAccountId: split.provider_account_id || checked.method.provider_account_id || null,
    label: split.nickname || split.custname || split.recipient_name || 'recipient',
    split,
  };
}

export async function authorizeMoovProduction({
  client,
  mapping,
  memberships,
  resource,
  destination,
  amountCents,
} = {}) {
  const userId = mapping?.application_user_id;
  if (!userId) return failAuthz('identity_required', { statusCode: 401 });
  const tenantId = resource?.batch?.tenant_id || resource?.transfer?.tenant_id;
  const ownership = membershipForTenant(memberships, tenantId);
  if (!tenantId || !ownership) {
    return failAuthz('cross_tenant_denied', {
      message: 'Authenticated user is not a member of the disbursement tenant. Browser tenant_id is ignored.',
    });
  }
  if (String(tenantId) !== FREEDOM_PRODUCTION_TENANT_ID) {
    return failAuthz('cross_tenant_denied', {
      message: 'Production Moov execution is limited to the Freedom production tenant.',
    });
  }
  const tenant = await loadProductionTenant(client, tenantId);
  if (!isProductionFreedomTenant(tenant)) {
    return failAuthz('cross_tenant_denied', {
      message: 'Tenant is not the production Freedom Moov tenant.',
    });
  }
  const account = await loadProductionMoovAccount(client, tenantId);
  if (!isProductionFreedomAccount(account)) {
    return failAuthz('production_account_missing', {
      statusCode: 409,
      message: 'Production Freedom Moov account is missing or is not the authorized payer.',
    });
  }
  if (account.onboarding_status !== 'active' || !account.can_send_payments) {
    return failAuthz('payer_setup_required', {
      statusCode: 409,
      message: `Your payment account is not ready to send payments yet (${account.onboarding_status}).`,
    });
  }
  const roles = await loadTenantRole(client, userId, tenantId);
  const transferId = resource?.transfer?.id || null;
  const batchId = resource?.batch?.id || null;
  const totpRows = await loadRecentDisbursementStepUp(client, {
    userId,
    tenantId,
    transferId,
    batchId,
    amountCents,
    destinationId: destination?.recipientId || destination?.methodId || null,
  });
  const totpRow = totpRows[0] || null;
  const evaluation = evaluateMoovProductionAuthorization({
    identityOk: true,
    membershipOk: true,
    roles,
    totpOk: Boolean(totpRow),
    flagsOk: productionMoovExecutionAllowed(),
    tenantOk: true,
    accountOk: true,
  });
  if (!evaluation.canExecuteProductionMoov) {
    const error = !evaluation.roleOk
      ? 'financial_unauthorized'
      : !evaluation.totpOk
        ? 'step_up_required'
        : 'production_execution_blocked';
    return failAuthz(error, {
      evaluation,
      tenantRole: ownership.role,
      tranche4HardBlock: error === 'production_execution_blocked',
    });
  }
  return {
    ok: true,
    evaluation,
    membership: ownership,
    roles,
    totpRow,
    amountCents,
    tenant,
    account,
    tenantId,
  };
}

export async function resolveDisbursementStepUpBinding({
  client,
  mapping,
  memberships,
  body,
} = {}) {
  const loaded = await loadApprovedDisbursement(client, {
    batchId: body.batch_id || body.batchId || null,
    transferId: body.transfer_id || body.transferId || body.disbursement_id || null,
  });
  if (!loaded.ok) return failAuthz(loaded.error, { statusCode: loaded.statusCode || 400, message: loaded.message });
  const tenantId = loaded.batch?.tenant_id || loaded.transfer?.tenant_id;
  if (!membershipForTenant(memberships, tenantId)) {
    return failAuthz('cross_tenant_denied', {
      message: 'TOTP step-up tenant is taken from the disbursement. Browser tenant_id is ignored.',
    });
  }
  const amount = serverAmountFromDisbursement(loaded);
  if (amount.error) {
    return failAuthz('invalid_amount', { statusCode: 400, message: amount.message || 'Server-derived disbursement amount is required.' });
  }
  const destination = await resolveProductionDestination(client, {
    tenantId,
    transfer: loaded.transfer,
    splits: loaded.splits,
  });
  if (!destination.ok) return failAuthz(destination.error, { statusCode: destination.statusCode || 409, message: destination.message });
  const mismatch = compareOptionalClientAmount(body, amount.cents);
  if (mismatch) return failAuthz(mismatch.error, { statusCode: mismatch.statusCode, message: mismatch.message });
  return {
    ok: true,
    tenantId,
    amountCents: amount.cents,
    actionKey: MOOV_TOTP_ACTION,
    transferId: loaded.transfer?.id || null,
    batchId: loaded.batch?.id || null,
    destinationId: destination.recipientId || destination.methodId,
    destination,
    metadata: {
      transfer_id: loaded.transfer?.id || null,
      batch_id: loaded.batch?.id || null,
      disbursement_id: loaded.transfer?.id || loaded.batch?.id || null,
      amount_cents: amount.cents,
      destination_id: destination.recipientId || destination.methodId,
      destination_fingerprint: destinationFingerprint(destination),
      operation: MOOV_TOTP_ACTION,
      source: 'app_financial_totp',
    },
  };
}

export { loadProductionWallet };
