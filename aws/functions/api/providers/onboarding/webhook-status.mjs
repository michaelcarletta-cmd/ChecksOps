/**
 * Onboarding status from Moov webhooks (account.*, capability.*, *verification*,
 * representative.*). Updates only rows of the given environment:
 *   - payment_provider_accounts onboarding/verification/capability columns,
 *   - moov_onboarding_profiles last webhook stamp.
 * Sandbox rows are applied by the existing sandbox apply path; production rows
 * only when AWS_MOOV_ONBOARDING_PRODUCTION_ENABLED is true (and not dry-run).
 * No provider call is made here.
 */
import { capabilityFlags, normalizeOnboardingStatus } from '../parity/moov-client.mjs';

export const isOnboardingEvent = (eventType) => {
  const t = String(eventType || '');
  return t.startsWith('account') || t.startsWith('capability') || t.includes('verification') || t.startsWith('representative');
};

const capabilityStatusFromEvent = (eventType, data) => {
  if (data?.status) return String(data.status).toLowerCase();
  if (String(eventType).endsWith('.requested')) return 'pending';
  return null;
};

export async function applyOnboardingWebhookStatus(client, { environment, eventType, providerAccountId, data = {} }) {
  if (!isOnboardingEvent(eventType) || !providerAccountId) {
    return { applied: false, skipped: 'not_onboarding_event', mutations: [] };
  }
  if (environment !== 'sandbox' && environment !== 'production') {
    return { applied: false, skipped: 'environment_unresolved', mutations: [] };
  }
  const account = (await client.query(
    `SELECT id, tenant_id, capabilities, verification_status, disabled
     FROM public.payment_provider_accounts
     WHERE provider = 'moov' AND provider_account_id = $1 AND environment = $2
     LIMIT 1`,
    [String(providerAccountId), environment],
  )).rows[0];
  if (!account) return { applied: false, skipped: 'no_account_for_environment', mutations: [] };

  let caps = Array.isArray(account.capabilities) ? account.capabilities.map((c) => ({ ...c })) : [];
  if (String(eventType).startsWith('capability')) {
    const capability = data?.capabilityID ?? data?.capabilityId ?? data?.capability ?? null;
    const status = capabilityStatusFromEvent(eventType, data);
    if (capability && status) {
      const found = caps.find((c) => c.capability === capability);
      if (found) found.status = status;
      else caps = [...caps, { capability: String(capability), status }];
    }
  }
  const verification = data?.verification?.status
    ?? data?.verificationStatus
    ?? (String(eventType).includes('verification') ? data?.status : null)
    ?? account.verification_status
    ?? null;
  const disabled = data?.disabledOn ? true : account.disabled === true;
  const onboarding = normalizeOnboardingStatus({ verificationStatus: verification, capabilities: caps, disabled });
  const flags = capabilityFlags(caps);

  await client.query(
    `UPDATE public.payment_provider_accounts SET
       capabilities = $2::jsonb, verification_status = COALESCE($3, verification_status),
       onboarding_status = $4, disabled = $5,
       can_send_payments = $6, can_receive_payments = $7, can_ach_credit = $8, can_ach_debit = $9,
       last_webhook_event_at = now(), last_webhook_event_type = $10
     WHERE id = $1::uuid AND environment = $11`,
    [
      account.id, JSON.stringify(caps), verification ? String(verification).slice(0, 40) : null,
      onboarding, disabled, flags.can_send_payments, flags.can_receive_payments,
      flags.can_ach_credit, flags.can_ach_debit, String(eventType).slice(0, 120), environment,
    ],
  );
  await client.query(
    `UPDATE public.moov_onboarding_profiles
     SET last_webhook_event_type = $3, last_webhook_event_at = now(), updated_at = now()
     WHERE tenant_id = $1::uuid AND environment = $2`,
    [account.tenant_id, environment, String(eventType).slice(0, 120)],
  );
  return {
    applied: true,
    environment,
    tenantId: account.tenant_id,
    onboarding_status: onboarding,
    mutations: ['payment_provider_accounts', 'moov_onboarding_profiles'],
  };
}

/** Production apply entry (webhooks.mjs). Onboarding status only; nothing financial. */
export async function applyProductionOnboardingWebhook(client, payload) {
  const eventType = String(payload?.type ?? payload?.eventType ?? 'unknown');
  if (!isOnboardingEvent(eventType)) {
    return { applied: false, skipped: 'production_non_onboarding_event', financialTablesMutated: false, mutations: [] };
  }
  const data = payload?.data ?? payload;
  const providerAccountId = payload?.accountID ?? data?.accountID ?? payload?.accountId ?? null;
  await client.query("SELECT set_config('request.provider_webhook_apply', '1', true)");
  await client.query("SELECT set_config('request.aws_financial_permissions_activated', '0', true)");
  const result = await applyOnboardingWebhookStatus(client, {
    environment: 'production', eventType, providerAccountId, data,
  });
  if (result.applied) {
    await client.query(
      `INSERT INTO public.payment_event_log (provider, environment, tenant_id, event_type, new_status, provider_metadata)
       VALUES ('moov', 'production', $1::uuid, $2, $3, $4::jsonb)`,
      [result.tenantId, eventType.slice(0, 120), result.onboarding_status, JSON.stringify({ account_id: providerAccountId })],
    );
    result.mutations.push('payment_event_log');
  }
  return { ...result, financialTablesMutated: false };
}
