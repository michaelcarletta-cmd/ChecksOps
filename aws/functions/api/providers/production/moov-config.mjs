const failConfig = (error, extra = {}) => ({
  ok: false,
  statusCode: extra.statusCode || 409,
  error,
  liveProviderCalled: false,
  productionExecution: false,
  message: extra.message || 'Production Moov configuration is incomplete. Fail closed.',
  ...extra,
});

export const publicProductionMoovAccount = (account) => {
  if (!account) return null;
  return {
    id: account.id,
    tenant_id: account.tenant_id,
    provider: 'moov',
    environment: account.environment,
    account_type: account.account_type,
    onboarding_status: account.onboarding_status,
    verification_status: account.verification_status,
    can_send_payments: account.can_send_payments,
    can_receive_payments: account.can_receive_payments,
    can_ach_credit: account.can_ach_credit,
    can_ach_debit: account.can_ach_debit,
    disabled: Boolean(account.disabled),
    restricted: Boolean(account.restricted),
    provider_account_id_present: Boolean(account.provider_account_id),
  };
};

export async function loadProductionTenantAccount(client, tenantId) {
  if (!tenantId) return null;
  const row = (await client.query(
    `SELECT id, tenant_id, provider, environment, provider_account_id, account_type,
            onboarding_status, verification_status, tos_accepted_at, tos_source,
            can_send_payments, can_receive_payments, can_ach_credit, can_ach_debit,
            disabled, restricted, capabilities, provider_metadata
     FROM public.payment_provider_accounts
     WHERE tenant_id = $1::uuid AND provider = 'moov' AND environment = 'production'
     LIMIT 1`,
    [tenantId],
  )).rows[0];
  return row || null;
}

export async function loadProductionPaymentMethod(client, { methodId, tenantId } = {}) {
  if (!methodId) return null;
  const row = (await client.query(
    `SELECT id, tenant_id, external_recipient_id, provider, environment,
            provider_account_id, provider_bank_account_id, provider_payment_method_id,
            verification_status, connection_status, can_send, can_receive
     FROM public.payment_provider_methods
     WHERE id = $1::uuid AND provider = 'moov' AND environment = 'production'
     LIMIT 1`,
    [methodId],
  )).rows[0];
  if (!row) return null;
  if (tenantId && row.tenant_id && String(row.tenant_id) !== String(tenantId)) return null;
  return row;
}

export async function loadProductionRecipient(client, { recipientId, tenantId } = {}) {
  if (!recipientId) return null;
  const row = (await client.query(
    `SELECT id, tenant_id, provider, environment, provider_account_id, onboarding_status
     FROM public.external_payment_recipients
     WHERE id = $1::uuid AND provider = 'moov' AND environment = 'production'
     LIMIT 1`,
    [recipientId],
  )).rows[0];
  if (!row) return null;
  if (tenantId && String(row.tenant_id) !== String(tenantId)) return null;
  return row;
}

export async function loadTenantMoovRecipients(client, tenantId) {
  if (!tenantId) return [];
  return (await client.query(
    `SELECT id, tenant_id, provider, environment, onboarding_status,
            recipient_type, display_name, provider_account_id, bank_linked_at, provider_last_four
     FROM public.external_payment_recipients
     WHERE tenant_id = $1::uuid AND provider = 'moov'
     ORDER BY environment, created_at
     LIMIT 50`,
    [tenantId],
  )).rows;
}

export async function loadTenantMoovPaymentMethods(client, tenantId) {
  if (!tenantId) return [];
  return (await client.query(
    `SELECT id, tenant_id, provider, environment, verification_status, connection_status,
            can_send, can_receive, external_recipient_id
     FROM public.payment_provider_methods
     WHERE tenant_id = $1::uuid AND provider = 'moov'
     LIMIT 50`,
    [tenantId],
  )).rows;
}

export async function loadProductionWallet(client, tenantId) {
  if (!tenantId) return null;
  return (await client.query(
    `SELECT id, tenant_id, provider, environment, provider_wallet_id, provider_account_id,
            wallet_type, status, available_cents, pending_cents, currency
     FROM public.payment_wallets
     WHERE tenant_id = $1::uuid AND provider = 'moov' AND environment = 'production'
     ORDER BY updated_at DESC NULLS LAST
     LIMIT 1`,
    [tenantId],
  )).rows[0] || null;
}

export function assertProductionRail({ account, sourceMethod, destMethod, recipient } = {}) {
  if (!account?.provider_account_id) {
    return failConfig('sender_account_missing', {
      message: 'Tenant production Moov account is missing. Browser cannot choose the sender.',
    });
  }
  if (account.disabled || account.restricted) {
    return failConfig('sender_account_disabled', {
      message: 'Production Moov sender account is disabled or restricted.',
    });
  }
  if (!sourceMethod?.provider_payment_method_id) {
    return failConfig('source_method_missing', {
      message: 'Server-derived source payment method is required.',
    });
  }
  if (sourceMethod.verification_status && sourceMethod.verification_status !== 'verified') {
    return failConfig('source_method_unverified', {
      message: 'Source bank is not verified.',
    });
  }
  if (!destMethod?.provider_payment_method_id) {
    return failConfig('destination_method_missing', {
      message: 'Server-derived destination payment method is required.',
    });
  }
  if (recipient && String(recipient.tenant_id) !== String(account.tenant_id)
    && destMethod.external_recipient_id && String(destMethod.external_recipient_id) !== String(recipient.id)) {
    return failConfig('recipient_method_mismatch', {
      message: 'Destination payment method is not owned by the server-loaded recipient.',
    });
  }
  return { ok: true };
}
