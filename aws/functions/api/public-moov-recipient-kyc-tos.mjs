/**
 * Public recipient KYC + ToS writes.
 * Auth: existing pay-setup secure_token. No Cognito.
 * Server binds the existing Moov account. Browser ids are not authority.
 * SSN/DOB transit to Moov only. Never logged, returned, query-stringed, or stored.
 * Does not consume the token. Does not initiate bank verification or transfers.
 */
import { parseBody, ignoredSpoof } from './data.mjs';
import {
  executionAllowed,
  providerEnabled,
  providerExecutionEnabled,
  providerLiveReadsEnabled,
  providerRecipientKycTosWritesEnabled,
} from './provider-flags.mjs';
import { providerSandboxExecutionEnabled } from './sandbox-flags.mjs';
import { loadProductionMoovReadSecrets } from './providers/production/moov-secrets.mjs';
import {
  fingerprintMoovId,
  productionMoovFetch,
  productionMoovToken,
  redactMoovText,
} from './providers/production/moov-client.mjs';
import {
  redactRecipientKycText,
  redactRecipientKycValue,
  recipientKycResponseHasSecrets,
  stripKycSecretsFromAccount,
} from './providers/recipient-kyc-redact.mjs';
import {
  buildIndividualKycPatch,
  dropTokenFromBody,
  identityRequirementsOutstanding,
  kycStatusFromMoov,
  liveTosAccepted,
  recipientTosDropScopes,
  rejectForgedRecipientTos,
  tosBoundToRecipientAccount,
  tosConfirmedByMoov,
  tosRequirementOutstanding,
} from './providers/moov-recipient-tos-policy.mjs';
import {
  productionRecipientBridgeConfigured,
  recipientSessionTokenShape,
  resolveProductionRecipientByToken,
} from './production-recipient-token.mjs';
import { sanitizePublicError } from './db-health.mjs';

const UNTRUSTED_MOOV_KEYS = [
  'moov_account_id', 'moovAccountId', 'MOOV_ACCOUNT_ID',
  'platform_account_id', 'platformAccountId', 'facilitator_account_id',
  'provider_account_id', 'providerAccountId',
  'accountID',
  'wallet_id', 'walletId', 'provider_wallet_id',
];

const MONEY_MUTATION_KEYS = [
  'create_account', 'add_bank', 'request_capability',
  'fund_wallet', 'create_recipient', 'create_transfer', 'disburse',
  'verify_bank', 'onboard', 'consume_token', 'send_transfer',
  'initiate_microdeposit', 'confirm_microdeposit',
];

const failures = new Map();

const clientIp = (event) => {
  const headers = event?.headers || {};
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [String(k).toLowerCase(), v]));
  return String(lower['x-forwarded-for'] || '').split(',')[0].trim()
    || lower['cf-connecting-ip']
    || event?.requestContext?.http?.sourceIp
    || 'unknown';
};

export const recipientWriteRateLimited = ({ ip, nowMs = Date.now(), windowMs = 10 * 60 * 1000, max = 30 } = {}) => {
  const key = String(ip || 'unknown');
  const hits = (failures.get(key) || []).filter((ts) => nowMs - ts < windowMs);
  failures.set(key, hits);
  return hits.length >= max;
};

export const noteRecipientWriteFailure = ({ ip, nowMs = Date.now() } = {}) => {
  const key = String(ip || 'unknown');
  const hits = failures.get(key) || [];
  hits.push(nowMs);
  failures.set(key, hits);
};

const listOf = (payload) => {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.capabilities)) return payload.capabilities;
  return [];
};

const fail = (error, statusCode, extra = {}) => ({
  ok: false,
  statusCode,
  error,
  provider: 'moov',
  liveProviderCalled: extra.liveProviderCalled === true,
  productionExecution: false,
  productionRead: extra.productionRead === true,
  recipientOnboardingWrite: extra.recipientOnboardingWrite === true,
  public_recipient: true,
  cognito_required: false,
  token_consumed: false,
  ssn_returned: false,
  ...extra,
});

const kycFieldError = (missing = []) => {
  if (missing.includes('name')) return 'First and last name are required.';
  if (missing.includes('email')) return 'Enter a valid email address.';
  if (missing.includes('phone')) return 'Phone number must be 10 digits.';
  if (missing.includes('address')) return 'Enter a complete U.S. residential address.';
  if (missing.includes('birthdate')) return 'Enter a valid date of birth.';
  if (missing.includes('ssn')) return 'SSN must be 9 digits.';
  return 'kyc_fields_incomplete';
};

const browserIdMismatch = (body, recipient) => {
  const requestedRecipient = body.recipient_id ?? body.recipientId ?? null;
  if (requestedRecipient && String(requestedRecipient).trim() !== String(recipient.id)) {
    return { error: 'recipient_mismatch', statusCode: 400, message: 'Recipient ids are server-derived. Browser values are rejected.' };
  }
  const requestedTenant = body.tenant_id ?? body.tenantId ?? null;
  if (requestedTenant && String(requestedTenant).trim() !== String(recipient.tenant_id)) {
    return { error: 'tenant_mismatch', statusCode: 400, message: 'Tenant ids are server-derived. Browser values are rejected.' };
  }
  const bound = tosBoundToRecipientAccount({
    recipientAccountId: String(recipient.provider_account_id),
    requestedAccountId: body.account_id ?? body.accountId ?? null,
    environment: recipient.environment,
  });
  if (!bound.ok) {
    return { error: bound.error, statusCode: 400, message: 'Moov account ids are server-derived. Browser values are rejected.' };
  }
  return { error: null, account_id: bound.account_id };
};

async function authorizePublicRecipientWrite(event, deps = {}) {
  const body = parseBody(event);
  const spoof = ignoredSpoof(event, body);
  const ip = clientIp(event);
  const nowMs = deps.nowMs || Date.now();
  const log = deps.log || (() => {});

  if (recipientWriteRateLimited({ ip, nowMs })) {
    return { ok: false, result: fail('recipient_token_rate_limited', 429, {
      message: 'Too many attempts. Try again later.',
      spoofFieldsIgnored: spoof,
    }) };
  }

  const money = MONEY_MUTATION_KEYS.filter((key) => body[key]);
  if (money.length) {
    return { ok: false, result: fail('provider_execution_blocked', 403, {
      fields: money,
      message: 'Bank verification, transfers, and account creation stay blocked.',
      spoofFieldsIgnored: spoof,
    }) };
  }

  const untrusted = UNTRUSTED_MOOV_KEYS.filter((key) => body[key] !== undefined && body[key] !== null);
  if (untrusted.length) {
    return { ok: false, result: fail('untrusted_provider_config', 400, {
      fields: untrusted,
      message: 'Moov account ids are server-derived. Browser values are rejected.',
      spoofFieldsIgnored: spoof,
    }) };
  }

  const rawToken = typeof body.token === 'string' ? body.token.trim() : '';
  if (!rawToken) {
    return { ok: false, result: fail('token_required', 400, {
      message: 'token is required',
      spoofFieldsIgnored: spoof,
    }) };
  }
  const token = recipientSessionTokenShape(rawToken);
  if (!token) {
    noteRecipientWriteFailure({ ip, nowMs });
    return { ok: false, result: fail('This link is not valid.', 404, { spoofFieldsIgnored: spoof }) };
  }

  if (event?.queryStringParameters && Object.keys(event.queryStringParameters).length) {
    const queryKeys = Object.keys(event.queryStringParameters);
    if (queryKeys.some((key) => /ssn|dob|birth|token|account/i.test(key))) {
      return { ok: false, result: fail('sensitive_query_string_refused', 400, {
        message: 'Sensitive fields cannot be sent in the URL.',
        spoofFieldsIgnored: spoof,
      }) };
    }
  }

  if (!providerLiveReadsEnabled() || providerSandboxExecutionEnabled()) {
    return { ok: false, result: fail('production_read_blocked', 403, {
      message: 'Production Moov live reads are not enabled for this public write.',
      spoofFieldsIgnored: spoof,
    }) };
  }
  if (!providerRecipientKycTosWritesEnabled()) {
    return { ok: false, result: fail('recipient_onboarding_writes_blocked', 403, {
      message: 'Recipient KYC and ToS writes are not enabled.',
      spoofFieldsIgnored: spoof,
    }) };
  }
  if (providerExecutionEnabled() || providerEnabled('moov') || executionAllowed('moov')) {
    return { ok: false, result: fail('provider_execution_blocked', 403, {
      message: 'Money-execution flags must stay off. Recipient KYC/ToS uses the narrow onboarding allowlist only.',
      spoofFieldsIgnored: spoof,
    }) };
  }

  if (!deps.resolveRecipientByToken && !productionRecipientBridgeConfigured()) {
    return { ok: false, result: fail('recipient_lookup_unconfigured', 503, {
      message: 'Could not resolve this payment-setup link.',
      spoofFieldsIgnored: spoof,
    }) };
  }

  const resolved = await (deps.resolveRecipientByToken || resolveProductionRecipientByToken)({
    token,
    fetchImpl: deps.fetchImpl || fetch,
  });
  if (!resolved.ok) {
    if (resolved.statusCode === 404 || resolved.statusCode === 410) noteRecipientWriteFailure({ ip, nowMs });
    return { ok: false, result: fail(resolved.error || 'This link is not valid.', resolved.statusCode || 404, {
      message: resolved.message,
      spoofFieldsIgnored: spoof,
    }) };
  }
  const recipient = resolved.recipient;

  if (recipient.token_used_at) {
    noteRecipientWriteFailure({ ip, nowMs });
    return { ok: false, result: fail('This link has already been used. Ask the sender for a new one.', 410, {
      spoofFieldsIgnored: spoof,
    }) };
  }
  if (recipient.token_expires_at && new Date(recipient.token_expires_at).getTime() < nowMs) {
    noteRecipientWriteFailure({ ip, nowMs });
    return { ok: false, result: fail('This link has expired. Ask the sender for a new one.', 410, {
      spoofFieldsIgnored: spoof,
    }) };
  }
  if (String(recipient.environment || '').toLowerCase() !== 'production') {
    return { ok: false, result: fail('This payment setup is not ready yet. Try again shortly.', 409, {
      spoofFieldsIgnored: spoof,
    }) };
  }
  if (!recipient.provider_account_id) {
    return { ok: false, result: fail('This payment setup is not ready yet. Try again shortly.', 409, {
      spoofFieldsIgnored: spoof,
    }) };
  }

  const mismatch = browserIdMismatch(body, recipient);
  if (mismatch.error) {
    return { ok: false, result: fail(mismatch.error, mismatch.statusCode, {
      message: mismatch.message,
      spoofFieldsIgnored: spoof,
    }) };
  }

  const secrets = await (deps.loadProductionReadSecrets || loadProductionMoovReadSecrets)(deps.getSecrets);
  if (!secrets.ok) {
    return { ok: false, result: { ...secrets, public_recipient: true, cognito_required: false, token_consumed: false, ssn_returned: false, spoofFieldsIgnored: spoof } };
  }

  return {
    ok: true,
    body,
    spoof,
    ip,
    nowMs,
    log,
    recipient,
    accountId: mismatch.account_id,
    credentials: secrets.credentials,
    fetchImpl: deps.fetchImpl || fetch,
    moovFetch: deps.productionMoovFetch || productionMoovFetch,
    moovToken: deps.productionMoovToken || productionMoovToken,
  };
}

const safePublic = (result) => {
  if (recipientKycResponseHasSecrets(result)) {
    return fail('kyc_secret_leak_blocked', 500, {
      message: 'Identity details cannot be returned.',
    });
  }
  return result;
};

export async function handlePublicMoovRecipientKycUpdate(event, deps = {}) {
  const auth = await authorizePublicRecipientWrite(event, deps);
  if (!auth.ok) return safePublic(auth.result);
  const { body, spoof, log, recipient, accountId, credentials, fetchImpl, moovFetch } = auth;

  const patch = buildIndividualKycPatch(body);
  if (!patch.ok) {
    return safePublic(fail(patch.error, 400, {
      message: kycFieldError(patch.missing),
      missing: patch.missing,
      spoofFieldsIgnored: spoof,
    }));
  }

  try {
    const accountGet = await moovFetch({
      credentials,
      path: `/accounts/${accountId}`,
      method: 'GET',
      mode: 'recipient_onboarding',
      boundAccountId: accountId,
      scopes: [`/accounts/${accountId}/profile.read`],
      fetchImpl,
    });
    const account = accountGet.json || {};
    if (account?.accountType && account.accountType !== 'individual') {
      return safePublic(fail('This recipient requires business verification instead of individual KYC.', 409, {
        liveProviderCalled: true,
        productionRead: true,
        spoofFieldsIgnored: spoof,
      }));
    }

    await moovFetch({
      credentials,
      path: `/accounts/${accountId}`,
      method: 'PATCH',
      mode: 'recipient_onboarding',
      boundAccountId: accountId,
      scopes: [`/accounts/${accountId}/profile.write`],
      body: patch.body,
      fetchImpl,
    });

    const refreshed = await moovFetch({
      credentials,
      path: `/accounts/${accountId}`,
      method: 'GET',
      mode: 'recipient_onboarding',
      boundAccountId: accountId,
      scopes: [`/accounts/${accountId}/profile.read`],
      fetchImpl,
    });
    let identityOutstanding = [];
    try {
      const caps = await moovFetch({
        credentials,
        path: `/accounts/${accountId}/capabilities`,
        method: 'GET',
        mode: 'recipient_onboarding',
        boundAccountId: accountId,
        scopes: [`/accounts/${accountId}/capabilities.read`],
        fetchImpl,
      });
      identityOutstanding = identityRequirementsOutstanding(listOf(caps.json));
    } catch {
      /* unread */
    }

    const verification = kycStatusFromMoov(stripKycSecretsFromAccount(refreshed.json || {}));
    return safePublic({
      ok: true,
      success: true,
      statusCode: 200,
      provider: 'moov',
      liveProviderCalled: true,
      productionExecution: false,
      productionRead: true,
      recipientOnboardingWrite: true,
      public_recipient: true,
      cognito_required: false,
      mutated: true,
      token_consumed: false,
      ssn_returned: false,
      ssn_stored: false,
      verification_status: verification,
      identity_requirements_outstanding: identityOutstanding,
      account_id: accountId,
      account_id_fp: fingerprintMoovId(accountId),
      recipient_id: recipient.id,
      environment: 'production',
      spoofFieldsIgnored: spoof,
    });
  } catch (error) {
    log('recipient_kyc_failed', redactRecipientKycText(redactMoovText(String(error?.message || error))));
    if (error?.code === 'read_only_method_denied' || error?.code === 'read_only_path_denied'
      || error?.code === 'recipient_onboarding_method_denied' || error?.code === 'recipient_onboarding_path_denied') {
      return safePublic(fail(error.code, 403, {
        productionRead: true,
        message: 'This payment-provider path is not allowed.',
        spoofFieldsIgnored: spoof,
      }));
    }
    return safePublic(fail('kyc_update_failed', error?.status && error.status >= 400 ? error.status : 502, {
      liveProviderCalled: true,
      productionRead: true,
      recipientOnboardingWrite: true,
      message: 'Could not save identity details. Try again.',
      provider_error: redactRecipientKycValue(error?.body || null),
      spoofFieldsIgnored: spoof,
    }));
  }
}

export async function handlePublicMoovRecipientTosToken(event, deps = {}) {
  const auth = await authorizePublicRecipientWrite(event, deps);
  if (!auth.ok) return safePublic(auth.result);
  const { spoof, log, accountId, credentials, fetchImpl, moovToken } = auth;

  try {
    const oauth = await moovToken({
      credentials,
      scopes: recipientTosDropScopes(accountId),
      fetchImpl,
      mode: 'read',
    });
    return safePublic({
      ok: true,
      success: true,
      statusCode: 200,
      provider: 'moov',
      liveProviderCalled: true,
      productionExecution: false,
      productionRead: true,
      recipientOnboardingWrite: true,
      public_recipient: true,
      cognito_required: false,
      mutated: false,
      token_consumed: false,
      ssn_returned: false,
      token: oauth,
      account_id: accountId,
      account_id_fp: fingerprintMoovId(accountId),
      drop: 'moov-terms-of-service',
      environment: 'production',
      spoofFieldsIgnored: spoof,
    });
  } catch (error) {
    log('recipient_tos_token_failed', redactRecipientKycText(redactMoovText(String(error?.message || error))));
    return safePublic(fail('tos_token_failed', 502, {
      liveProviderCalled: true,
      message: 'Could not load the payment provider terms component.',
      spoofFieldsIgnored: spoof,
    }));
  }
}

export async function handlePublicMoovRecipientTosAccept(event, deps = {}) {
  const auth = await authorizePublicRecipientWrite(event, deps);
  if (!auth.ok) return safePublic(auth.result);
  const { body, spoof, log, accountId, credentials, fetchImpl, moovFetch } = auth;

  const forged = rejectForgedRecipientTos(body);
  if (forged) {
    return safePublic(fail(forged.error, forged.statusCode, {
      message: forged.message,
      spoofFieldsIgnored: spoof,
    }));
  }
  const dropToken = dropTokenFromBody(body);

  try {
    const current = await moovFetch({
      credentials,
      path: `/accounts/${accountId}`,
      method: 'GET',
      mode: 'recipient_onboarding',
      boundAccountId: accountId,
      scopes: [`/accounts/${accountId}/profile.read`],
      fetchImpl,
    });
    let capabilitiesBefore = [];
    let capsReadOk = false;
    try {
      const caps = await moovFetch({
        credentials,
        path: `/accounts/${accountId}/capabilities`,
        method: 'GET',
        mode: 'recipient_onboarding',
        boundAccountId: accountId,
        scopes: [`/accounts/${accountId}/capabilities.read`],
        fetchImpl,
      });
      capabilitiesBefore = listOf(caps.json);
      capsReadOk = true;
    } catch { /* unread */ }
    const outstandingBefore = capsReadOk ? tosRequirementOutstanding(capabilitiesBefore) : null;
    const alreadyAccepted = tosConfirmedByMoov({
      account: current.json || {},
      capabilities: capabilitiesBefore,
      capabilitiesReadOk: capsReadOk,
    });

    if (!alreadyAccepted) {
      await moovFetch({
        credentials,
        path: `/accounts/${accountId}`,
        method: 'PATCH',
        mode: 'recipient_onboarding',
        boundAccountId: accountId,
        scopes: [`/accounts/${accountId}/profile.write`],
        body: { termsOfService: { token: dropToken } },
        fetchImpl,
      });
    }

    const refreshed = await moovFetch({
      credentials,
      path: `/accounts/${accountId}`,
      method: 'GET',
      mode: 'recipient_onboarding',
      boundAccountId: accountId,
      scopes: [`/accounts/${accountId}/profile.read`],
      fetchImpl,
    });
    let capabilitiesAfter = [];
    let capsAfterOk = false;
    try {
      const caps = await moovFetch({
        credentials,
        path: `/accounts/${accountId}/capabilities`,
        method: 'GET',
        mode: 'recipient_onboarding',
        boundAccountId: accountId,
        scopes: [`/accounts/${accountId}/capabilities.read`],
        fetchImpl,
      });
      capabilitiesAfter = listOf(caps.json);
      capsAfterOk = true;
    } catch { /* unread */ }

    const confirmed = tosConfirmedByMoov({
      account: refreshed.json || {},
      capabilities: capabilitiesAfter,
      capabilitiesReadOk: capsAfterOk,
      tosOutstandingBefore: outstandingBefore === true,
    });
    if (!confirmed) {
      return safePublic(fail('tos_not_recorded', 502, {
        liveProviderCalled: true,
        productionRead: true,
        recipientOnboardingWrite: true,
        message: 'The payment provider did not record terms acceptance. Please accept the hosted terms again.',
        spoofFieldsIgnored: spoof,
      }));
    }

    return safePublic({
      ok: true,
      success: true,
      statusCode: 200,
      provider: 'moov',
      liveProviderCalled: true,
      productionExecution: false,
      productionRead: true,
      recipientOnboardingWrite: true,
      public_recipient: true,
      cognito_required: false,
      mutated: !alreadyAccepted,
      token_consumed: false,
      ssn_returned: false,
      already_accepted: alreadyAccepted,
      terms_accepted: true,
      account_id: accountId,
      account_id_fp: fingerprintMoovId(accountId),
      environment: 'production',
      spoofFieldsIgnored: spoof,
    });
  } catch (error) {
    log('recipient_tos_accept_failed', redactRecipientKycText(redactMoovText(String(error?.message || error))));
    if (error?.code === 'read_only_method_denied' || error?.code === 'read_only_path_denied'
      || error?.code === 'recipient_onboarding_method_denied' || error?.code === 'recipient_onboarding_path_denied') {
      return safePublic(fail(error.code, 403, {
        productionRead: true,
        message: 'This payment-provider path is not allowed.',
        spoofFieldsIgnored: spoof,
      }));
    }
    return safePublic(fail('tos_accept_failed', error?.status && error.status >= 400 ? error.status : 502, {
      liveProviderCalled: true,
      message: 'Could not record terms acceptance. Try again.',
      provider_error: redactRecipientKycValue(error?.body || null),
      spoofFieldsIgnored: spoof,
    }));
  }
}

export { liveTosAccepted };
