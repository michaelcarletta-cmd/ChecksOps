/**
 * Authoritative Moov provider-environment resolution for WalletOps / fund reads.
 *
 * Production-prep uses the request/runtime environment from moovParityContext
 * (tenant mapping + executionAllowed). There is never a production → sandbox
 * account fallback.
 */

export function requireMoovProviderEnvironment(ctx) {
  const environment = String(ctx?.environment || '').toLowerCase();
  if (environment === 'production' || environment === 'sandbox') {
    return { ok: true, environment };
  }
  return {
    ok: false,
    error: 'provider_environment_unresolved',
    statusCode: 503,
    message: 'Payment provider environment could not be resolved.',
  };
}

export function failClosedMissingAccount(account, environment) {
  if (account?.provider_account_id) return null;
  if (environment === 'production') {
    return {
      error: 'production_provider_context_unresolved',
      statusCode: 503,
      message: 'Production payment account could not be resolved.',
    };
  }
  return {
    error: 'Set up your payment account first.',
    statusCode: 409,
  };
}
