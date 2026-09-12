/** Browser-supplied financial identifiers are never authority. */

export const UNTRUSTED_MOOV_ACCOUNT_KEYS = [
  'moov_account_id', 'moovAccountId', 'MOOV_ACCOUNT_ID',
  'platform_account_id', 'platformAccountId', 'facilitator_account_id',
  'provider_account_id', 'providerAccountId',
  'accountID', 'accountId',
  'wallet_id', 'walletId', 'provider_wallet_id',
];

export const UNTRUSTED_MUTATION_KEYS = [
  'create_account', 'accept_tos', 'add_bank', 'request_capability',
  'fund_wallet', 'create_recipient', 'create_transfer', 'disburse',
  'verify_bank', 'onboard',
];

export const presentKeys = (body = {}, keys = []) => (
  keys.filter((key) => body[key] !== undefined && body[key] !== null && body[key] !== false)
);

export const rejectUntrustedMoovAccountFields = (body = {}, extra = {}) => {
  const present = presentKeys(body, UNTRUSTED_MOOV_ACCOUNT_KEYS);
  if (!present.length) return null;
  return {
    ok: false,
    statusCode: 400,
    error: 'untrusted_provider_config',
    provider: 'moov',
    fields: present,
    liveProviderCalled: false,
    productionExecution: false,
    message: 'Moov account ids are server-derived. Browser values are rejected.',
    ...extra,
  };
};

export const rejectBrowserTosForge = (body = {}) => {
  const token = typeof body.terms_of_service_token === 'string' ? body.terms_of_service_token.trim() : '';
  if (body.accepted === true && token.length < 8) {
    return {
      ok: false,
      statusCode: 400,
      error: 'tos_acceptance_forged',
      provider: 'moov',
      liveProviderCalled: false,
      message: 'ToS acceptance requires a Moov.js-issued token. Browser accepted=true is not authority.',
    };
  }
  return null;
};
