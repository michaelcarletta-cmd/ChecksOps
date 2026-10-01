/**
 * Faithful port of supabase/functions/_shared/moovCapabilities.ts.
 * Granular Moov capability IDs for API v2025.07.00+.
 * @see https://docs.moov.io/guides/accounts/capabilities/reference/
 */
export const MOOV_CAPABILITIES_API_VERSION = 'v2025.07.00';

export const LEGACY_CAPABILITY_IDS = ['send-funds', 'collect-funds', 'wallet'];

export const MERCHANT_CAPABILITIES = [
  'transfers',
  'collect-funds.ach',
  'send-funds.ach',
  'wallet.balance',
];

export const RECIPIENT_CAPABILITIES = ['transfers'];

export const COLLECT_ACH_CAPABILITIES = ['transfers', 'collect-funds.ach'];

export function capabilityEnabled(caps, wanted) {
  const target = String(wanted ?? '').toLowerCase();
  if (!target) return false;
  return (caps ?? []).some((row) => {
    if (String(row?.status ?? '').toLowerCase() !== 'enabled') return false;
    const name = String(row?.capability ?? '').toLowerCase();
    return name === target || name.startsWith(`${target}.`);
  });
}

export function capabilityFlags(caps) {
  return {
    can_receive_payments: capabilityEnabled(caps, 'transfers') || capabilityEnabled(caps, 'collect-funds'),
    can_send_payments: capabilityEnabled(caps, 'transfers') || capabilityEnabled(caps, 'send-funds'),
    can_ach_debit: capabilityEnabled(caps, 'collect-funds'),
    can_ach_credit: capabilityEnabled(caps, 'send-funds'),
    restricted: (caps ?? []).some((c) => c.status === 'disconnected'),
    disabled: (caps ?? []).length > 0 && (caps ?? []).every((c) => c.status !== 'enabled'),
  };
}

export function missingRequestedCapabilities(caps, required = MERCHANT_CAPABILITIES) {
  const have = new Set(
    (caps ?? []).map((row) => String(row?.capability ?? '').toLowerCase()).filter(Boolean),
  );
  return required.filter((id) => !have.has(String(id).toLowerCase()));
}
