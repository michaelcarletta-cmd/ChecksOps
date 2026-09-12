/**
 * Public recipient instant micro-deposit initiate + MV-code confirm.
 * Auth: existing pay-setup secure_token. No Cognito.
 * Server binds recipient, Moov account, and live bank. Browser ids are not authority.
 * MV codes transit to Moov only. Never logged, stored, or echoed.
 * Independent of transfer/money flags. Does not consume the token.
 */
import { parseBody, ignoredSpoof } from './data.mjs';
import {
  executionAllowed,
  providerEnabled,
  providerExecutionEnabled,
  providerLiveReadsEnabled,
  providerRecipientBankVerifyWritesEnabled,
} from './provider-flags.mjs';
import { providerSandboxExecutionEnabled } from './sandbox-flags.mjs';
import { isProviderNetworkError } from './sandbox-credentials.mjs';
import { loadProductionMoovReadSecrets } from './providers/production/moov-secrets.mjs';
import { fingerprintMoovId, productionMoovFetch, redactMoovText } from './providers/production/moov-client.mjs';
import {
  RECIPIENT_VERIFY_MAX_ATTEMPTS,
  bindLiveRecipientBank,
  identityRequirementsOutstanding,
  initiateAlreadyOpenError,
  interpretRecipientBankVerification,
  liveTosAccepted,
  moovInstantVerifyBody,
  providerVerifySuccessIsNotComplete,
  recipientBankVerifyBlocked,
  recipientBankVerifyIdempotencyKey,
  recipientBankVerifyWriteScopes,
  recipientOnboardingCompleteFromMoov,
  rejectBrowserBankSubstitution,
  shouldInitiateInstantMicroDeposit,
  tosRequirementOutstanding,
} from './providers/moov-recipient-tos-policy.mjs';
import {
  redactRecipientMvText,
  recipientMvResponseHasSecrets,
} from './providers/recipient-mv-redact.mjs';
import {
  productionRecipientBridgeConfigured,
  recipientSessionTokenShape,
  resolveProductionRecipientByToken,
} from './production-recipient-token.mjs';

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
  'onboard', 'consume_token', 'send_transfer',
];

const ipFailures = new Map();
const mvAttempts = new Map();
const initiateLocks = new Map();

export const resetRecipientBankVerifyMemoryForTests = () => {
  ipFailures.clear();
  mvAttempts.clear();
  initiateLocks.clear();
};

const financialPermissionsActivated = () =>
  String(process.env.AWS_FINANCIAL_PERMISSIONS_ACTIVATED || '') === 'true';

const clientIp = (event) => {
  const headers = event?.headers || {};
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [String(k).toLowerCase(), v]));
  return String(lower['x-forwarded-for'] || '').split(',')[0].trim()
    || lower['cf-connecting-ip']
    || event?.requestContext?.http?.sourceIp
    || 'unknown';
};

export const recipientBankVerifyRateLimited = ({ ip, nowMs = Date.now(), windowMs = 10 * 60 * 1000, max = 30 } = {}) => {
  const key = String(ip || 'unknown');
  const hits = (ipFailures.get(key) || []).filter((ts) => nowMs - ts < windowMs);
  ipFailures.set(key, hits);
  return hits.length >= max;
};

export const noteRecipientBankVerifyFailure = ({ ip, nowMs = Date.now() } = {}) => {
  const key = String(ip || 'unknown');
  const hits = ipFailures.get(key) || [];
  hits.push(nowMs);
  ipFailures.set(key, hits);
};

export const mvAttemptState = ({ recipientId, bankId, nowMs = Date.now(), windowMs = 15 * 60 * 1000 } = {}) => {
  const key = `${String(recipientId || '')}:${String(bankId || '')}`;
  const current = mvAttempts.get(key) || { count: 0, windowStart: nowMs, locked: false };
  if (nowMs - current.windowStart >= windowMs) {
    const reset = { count: 0, windowStart: nowMs, locked: false };
    mvAttempts.set(key, reset);
    return { key, ...reset };
  }
  return { key, ...current };
};

export const noteMvAttempt = ({ recipientId, bankId, nowMs = Date.now(), max = RECIPIENT_VERIFY_MAX_ATTEMPTS } = {}) => {
  const state = mvAttemptState({ recipientId, bankId, nowMs });
  const count = state.count + 1;
  const locked = count >= max;
  mvAttempts.set(state.key, { count, windowStart: state.windowStart, locked });
  return { count, locked, remaining: Math.max(0, max - count) };
};

export const withRecipientBankInitiateLock = async (key, fn) => {
  const lockKey = String(key || 'unknown');
  const previous = initiateLocks.get(lockKey) || Promise.resolve();
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const chained = previous.then(() => held);
  initiateLocks.set(lockKey, chained);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (initiateLocks.get(lockKey) === chained) initiateLocks.delete(lockKey);
  }
};

const listOf = (payload) => {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.bankAccounts)) return payload.bankAccounts;
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
  recipientBankVerifyWrite: extra.recipientBankVerifyWrite === true,
  public_recipient: true,
  cognito_required: false,
  token_consumed: false,
  mv_code_returned: false,
  mv_code_stored: false,
  ...extra,
});

const browserIdMismatch = (body, recipient) => {
  const requestedRecipient = body.recipient_id ?? body.recipientId ?? null;
  if (requestedRecipient && String(requestedRecipient).trim() !== String(recipient.id)) {
    return { error: 'recipient_mismatch', statusCode: 400, message: 'Recipient ids are server-derived. Browser values are rejected.' };
  }
  const requestedTenant = body.tenant_id ?? body.tenantId ?? null;
  if (requestedTenant && String(requestedTenant).trim() !== String(recipient.tenant_id)) {
    return { error: 'tenant_mismatch', statusCode: 400, message: 'Tenant ids are server-derived. Browser values are rejected.' };
  }
  const requestedAccount = body.account_id ?? body.accountId ?? body.accountID ?? null;
  if (requestedAccount && String(requestedAccount).trim() !== String(recipient.provider_account_id)) {
    return { error: 'bank_account_mismatch', statusCode: 400, message: 'Moov account ids are server-derived. Browser values are rejected.' };
  }
  return { error: null, account_id: String(recipient.provider_account_id) };
};

async function authorizePublicRecipientBankVerify(event, deps = {}) {
  const body = parseBody(event);
  const spoof = ignoredSpoof(event, body);
  const ip = clientIp(event);
  const nowMs = deps.nowMs || Date.now();
  const log = deps.log || (() => {});

  if (recipientBankVerifyRateLimited({ ip, nowMs })) {
    return { ok: false, result: fail('recipient_token_rate_limited', 429, {
      message: 'Too many attempts. Try again later.',
      spoofFieldsIgnored: spoof,
    }) };
  }

  const money = MONEY_MUTATION_KEYS.filter((key) => body[key]);
  if (money.length) {
    return { ok: false, result: fail('provider_execution_blocked', 403, {
      fields: money,
      message: 'Transfers, bank-add, and account creation stay blocked.',
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
    noteRecipientBankVerifyFailure({ ip, nowMs });
    return { ok: false, result: fail('This link is not valid.', 404, { spoofFieldsIgnored: spoof }) };
  }

  if (event?.queryStringParameters && Object.keys(event.queryStringParameters).length) {
    const queryKeys = Object.keys(event.queryStringParameters);
    if (queryKeys.some((key) => /code|token|account|bank/i.test(key))) {
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
  if (!providerRecipientBankVerifyWritesEnabled()) {
    return { ok: false, result: fail('recipient_bank_verify_writes_blocked', 403, {
      message: 'Recipient bank verification writes are not enabled.',
      spoofFieldsIgnored: spoof,
    }) };
  }
  if (
    providerExecutionEnabled()
    || providerEnabled('moov')
    || executionAllowed('moov')
    || financialPermissionsActivated()
  ) {
    return { ok: false, result: fail('provider_execution_blocked', 403, {
      message: 'Money-execution flags must stay off. Bank verification uses the narrow allowlist only.',
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
    if (resolved.statusCode === 404 || resolved.statusCode === 410) noteRecipientBankVerifyFailure({ ip, nowMs });
    return { ok: false, result: fail(resolved.error || 'This link is not valid.', resolved.statusCode || 404, {
      message: resolved.message,
      spoofFieldsIgnored: spoof,
    }) };
  }
  const recipient = resolved.recipient;

  if (recipient.token_used_at) {
    noteRecipientBankVerifyFailure({ ip, nowMs });
    return { ok: false, result: fail('This link has already been used. Ask the sender for a new one.', 410, {
      spoofFieldsIgnored: spoof,
    }) };
  }
  if (recipient.token_expires_at && new Date(recipient.token_expires_at).getTime() < nowMs) {
    noteRecipientBankVerifyFailure({ ip, nowMs });
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
    return { ok: false, result: { ...secrets, public_recipient: true, cognito_required: false, token_consumed: false, mv_code_returned: false, mv_code_stored: false, spoofFieldsIgnored: spoof } };
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
  };
}

const safePublic = (result) => {
  if (recipientMvResponseHasSecrets(result)) {
    return fail('mv_secret_leak_blocked', 500, {
      message: 'Verification codes cannot be returned.',
    });
  }
  return result;
};

const moovGet = async ({ moovFetch, credentials, fetchImpl, accountId, bankId, path, scopes }) => {
  const got = await moovFetch({
    credentials,
    path,
    method: 'GET',
    mode: 'recipient_bank_verify',
    boundAccountId: accountId,
    boundBankId: bankId || null,
    scopes,
    fetchImpl,
  });
  return got.json;
};

const readLiveVerification = async ({ moovFetch, credentials, fetchImpl, accountId, bankId }) => {
  try {
    return await moovGet({
      moovFetch, credentials, fetchImpl, accountId, bankId,
      path: `/accounts/${accountId}/bank-accounts/${bankId}/verify`,
      scopes: [`/accounts/${accountId}/bank-accounts.read`],
    });
  } catch (error) {
    if (error?.status === 404) return null;
    try {
      return await moovGet({
        moovFetch, credentials, fetchImpl, accountId, bankId,
        path: `/accounts/${accountId}/bank-accounts/${bankId}/verification`,
        scopes: [`/accounts/${accountId}/bank-accounts.read`],
      });
    } catch (inner) {
      if (inner?.status === 404) return null;
      throw inner;
    }
  }
};

const loadBoundBank = async ({ moovFetch, credentials, fetchImpl, recipient, accountId, body }) => {
  const account = await moovGet({
    moovFetch, credentials, fetchImpl, accountId,
    path: `/accounts/${accountId}`,
    scopes: [`/accounts/${accountId}/profile.read`],
  });
  let capabilities = [];
  let capsOk = false;
  try {
    const caps = await moovGet({
      moovFetch, credentials, fetchImpl, accountId,
      path: `/accounts/${accountId}/capabilities`,
      scopes: [`/accounts/${accountId}/capabilities.read`],
    });
    capabilities = listOf(caps);
    capsOk = true;
  } catch { /* unread capabilities fail closed for ToS/KYC gates */ }
  const blocked = recipientBankVerifyBlocked({
    tosAccepted: liveTosAccepted(account),
    tosOutstanding: capsOk ? tosRequirementOutstanding(capabilities) : true,
    identityOutstanding: capsOk ? identityRequirementsOutstanding(capabilities) : [],
  });
  if (blocked) return { error: blocked };

  let banks = [];
  try {
    banks = listOf(await moovGet({
      moovFetch, credentials, fetchImpl, accountId,
      path: `/accounts/${accountId}/bank-accounts`,
      scopes: [`/accounts/${accountId}/bank-accounts.read`],
    }));
  } catch {
    return { error: { error: 'moov_bank_list_failed', statusCode: 502, message: 'Could not load existing bank accounts. Verification was not started.' } };
  }

  const bound = bindLiveRecipientBank({
    banks,
    recipientLastFour: recipient.provider_last_four,
    requestedBankAccountId: body.bank_account_id ?? body.bankAccountId ?? null,
  });
  if (!bound.ok) return { error: bound };

  const swapped = rejectBrowserBankSubstitution({
    recipientAccountId: accountId,
    liveBankAccountId: bound.bankId,
    requestedAccountId: body.account_id ?? body.accountId ?? null,
    requestedBankAccountId: body.bank_account_id ?? body.bankAccountId ?? null,
  });
  if (swapped) return { error: swapped };

  const liveVerify = await readLiveVerification({
    moovFetch, credentials, fetchImpl, accountId, bankId: bound.bankId,
  });
  return {
    account,
    banks,
    capabilities,
    capsOk,
    bank: bound.bank,
    bankId: bound.bankId,
    liveVerify,
    interpreted: interpretRecipientBankVerification({ bank: bound.bank, verification: liveVerify }),
  };
};

const mapConfirmError = (error) => {
  const raw = `${error?.message ?? ''} ${JSON.stringify(error?.body ?? '')}`.toLowerCase();
  if (raw.includes('max') && raw.includes('attempt')) {
    return {
      code: 'max_attempts_exceeded',
      message: 'Too many incorrect attempts. Restart verification to receive a new deposit code.',
    };
  }
  if (raw.includes('expired')) {
    return {
      code: 'verification_expired',
      message: 'This verification expired. Restart verification to receive a new deposit code.',
    };
  }
  if (error?.status === 404) {
    return {
      code: 'verification_not_found',
      message: 'No open verification for this bank account. Start verification to receive a deposit code.',
    };
  }
  if (error?.status === 409 || error?.status === 422 || error?.status === 400) {
    return {
      code: 'invalid_code',
      message: 'That code did not match. Check the $0.01 deposit descriptor and try again.',
    };
  }
  return {
    code: 'provider_error',
    message: 'The payment provider could not complete verification. Please try again shortly.',
  };
};

export async function handlePublicMoovRecipientBankVerifyInitiate(event, deps = {}) {
  const auth = await authorizePublicRecipientBankVerify(event, deps);
  if (!auth.ok) return safePublic(auth.result);
  const { body, spoof, log, recipient, accountId, credentials, fetchImpl, moovFetch } = auth;
  const lockFn = deps.withInitiateLock || withRecipientBankInitiateLock;

  try {
    return await lockFn(`${recipient.id}:${accountId}`, async () => {
      const loaded = await loadBoundBank({ moovFetch, credentials, fetchImpl, recipient, accountId, body });
      if (loaded.error) {
        return safePublic(fail(loaded.error.error, loaded.error.statusCode, {
          message: loaded.error.message,
          liveProviderCalled: true,
          productionRead: true,
          spoofFieldsIgnored: spoof,
        }));
      }
      const { account, banks, capabilities, capsOk, bank, bankId, liveVerify, interpreted } = loaded;

      if (interpreted.verified) {
        return safePublic({
          ok: true,
          success: true,
          statusCode: 200,
          already_verified: true,
          initiated: false,
          mutated: false,
          complete: recipientOnboardingCompleteFromMoov({ account, banks, capabilities, capabilitiesReadOk: capsOk }),
          bank_status: interpreted.bank_status,
          bank_id: bankId,
          bank_id_fp: fingerprintMoovId(bankId),
          account_id: accountId,
          account_id_fp: fingerprintMoovId(accountId),
          recipient_id: recipient.id,
          provider: 'moov',
          liveProviderCalled: true,
          productionExecution: false,
          productionRead: true,
          recipientBankVerifyWrite: true,
          public_recipient: true,
          token_consumed: false,
          mv_code_returned: false,
          mv_code_stored: false,
          environment: 'production',
          spoofFieldsIgnored: spoof,
        });
      }

      if (!shouldInitiateInstantMicroDeposit({ bank, verification: liveVerify })) {
        return safePublic({
          ok: true,
          success: true,
          statusCode: 200,
          already_initiated: true,
          initiated: interpreted.initiated,
          can_confirm: interpreted.can_confirm,
          mutated: false,
          bank_status: interpreted.bank_status,
          verification_status: interpreted.verification_status,
          complete: false,
          bank_id: bankId,
          bank_id_fp: fingerprintMoovId(bankId),
          account_id: accountId,
          account_id_fp: fingerprintMoovId(accountId),
          recipient_id: recipient.id,
          provider: 'moov',
          liveProviderCalled: true,
          productionExecution: false,
          productionRead: true,
          recipientBankVerifyWrite: true,
          public_recipient: true,
          token_consumed: false,
          mv_code_returned: false,
          mv_code_stored: false,
          environment: 'production',
          spoofFieldsIgnored: spoof,
        });
      }

      let uncertain = false;
      try {
        await moovFetch({
          credentials,
          path: `/accounts/${accountId}/bank-accounts/${bankId}/verify`,
          method: 'POST',
          mode: 'recipient_bank_verify',
          boundAccountId: accountId,
          boundBankId: bankId,
          idempotencyKey: recipientBankVerifyIdempotencyKey({ recipientId: recipient.id, bankId }),
          scopes: recipientBankVerifyWriteScopes(accountId),
          fetchImpl,
        });
      } catch (error) {
        if (isProviderNetworkError(error) || error?.code === 'ETIMEDOUT' || String(error?.message || '') === 'fetch failed') {
          uncertain = true;
        } else if (!initiateAlreadyOpenError(String(error?.message || '')) && error?.status !== 409) {
          log('recipient_bank_verify_initiate_failed', redactRecipientMvText(redactMoovText(String(error?.message || error))));
          return safePublic(fail('initiate_failed', 502, {
            liveProviderCalled: true,
            productionRead: true,
            recipientBankVerifyWrite: true,
            message: 'Could not start bank verification with the payment provider.',
            spoofFieldsIgnored: spoof,
          }));
        }
      }

      let refreshedBank = bank;
      let refreshedVerify = liveVerify;
      try {
        refreshedBank = await moovGet({
          moovFetch, credentials, fetchImpl, accountId, bankId,
          path: `/accounts/${accountId}/bank-accounts/${bankId}`,
          scopes: [`/accounts/${accountId}/bank-accounts.read`],
        }) || bank;
        refreshedVerify = await readLiveVerification({
          moovFetch, credentials, fetchImpl, accountId, bankId,
        });
      } catch (error) {
        if (uncertain) {
          return safePublic(fail('initiate_uncertain', 502, {
            liveProviderCalled: true,
            productionRead: true,
            recipientBankVerifyWrite: true,
            mutated: false,
            message: 'The payment provider did not confirm initiation. Verification was not retried.',
            spoofFieldsIgnored: spoof,
          }));
        }
        throw error;
      }

      const after = interpretRecipientBankVerification({ bank: refreshedBank, verification: refreshedVerify });
      if (uncertain && !after.initiated && !after.verified) {
        return safePublic(fail('initiate_uncertain', 502, {
          liveProviderCalled: true,
          productionRead: true,
          recipientBankVerifyWrite: true,
          mutated: false,
          message: 'The payment provider did not confirm initiation. Verification was not retried.',
          spoofFieldsIgnored: spoof,
        }));
      }

      return safePublic({
        ok: true,
        success: true,
        statusCode: 200,
        initiated: after.initiated || true,
        can_confirm: after.can_confirm,
        already_initiated: Boolean(uncertain && after.initiated),
        mutated: !uncertain,
        bank_status: after.bank_status,
        verification_status: after.verification_status,
        complete: false,
        bank_id: bankId,
        bank_id_fp: fingerprintMoovId(bankId),
        account_id: accountId,
        account_id_fp: fingerprintMoovId(accountId),
        recipient_id: recipient.id,
        provider: 'moov',
        liveProviderCalled: true,
        productionExecution: false,
        productionRead: true,
        recipientBankVerifyWrite: true,
        public_recipient: true,
        token_consumed: false,
        mv_code_returned: false,
        mv_code_stored: false,
        environment: 'production',
        spoofFieldsIgnored: spoof,
      });
    });
  } catch (error) {
    log('recipient_bank_verify_initiate_failed', redactRecipientMvText(redactMoovText(String(error?.message || error))));
    if (error?.code === 'recipient_bank_verify_method_denied' || error?.code === 'recipient_bank_verify_path_denied'
      || error?.code === 'read_only_method_denied' || error?.code === 'read_only_path_denied') {
      return safePublic(fail(error.code, 403, {
        productionRead: true,
        message: 'This payment-provider path is not allowed.',
        spoofFieldsIgnored: spoof,
      }));
    }
    return safePublic(fail('initiate_failed', error?.status && error.status >= 400 ? error.status : 502, {
      liveProviderCalled: true,
      productionRead: true,
      recipientBankVerifyWrite: true,
      message: 'Could not start bank verification with the payment provider.',
      spoofFieldsIgnored: spoof,
    }));
  }
}

export async function handlePublicMoovRecipientBankVerifyConfirm(event, deps = {}) {
  const auth = await authorizePublicRecipientBankVerify(event, deps);
  if (!auth.ok) return safePublic(auth.result);
  const { body, spoof, log, recipient, accountId, credentials, fetchImpl, moovFetch } = auth;
  const noteAttempt = deps.noteMvAttempt || noteMvAttempt;
  const attemptState = deps.mvAttemptState || mvAttemptState;

  const verifyBody = moovInstantVerifyBody(body?.code ?? body?.verification_code);
  if (!verifyBody) {
    return safePublic(fail('Enter the 4-digit verification code.', 400, {
      spoofFieldsIgnored: spoof,
    }));
  }

  try {
    const loaded = await loadBoundBank({ moovFetch, credentials, fetchImpl, recipient, accountId, body });
    if (loaded.error) {
      return safePublic(fail(loaded.error.error, loaded.error.statusCode, {
        message: loaded.error.message,
        liveProviderCalled: true,
        productionRead: true,
        spoofFieldsIgnored: spoof,
      }));
    }
    const { account, banks, capabilities, capsOk, bankId, interpreted } = loaded;
    const prior = attemptState({ recipientId: recipient.id, bankId, nowMs: auth.nowMs });
    if (prior.locked || prior.count >= RECIPIENT_VERIFY_MAX_ATTEMPTS) {
      return safePublic(fail('max_attempts_exceeded', 409, {
        requires_restart: true,
        message: 'Too many incorrect attempts. Restart verification to receive a new deposit code.',
        liveProviderCalled: true,
        productionRead: true,
        spoofFieldsIgnored: spoof,
      }));
    }

    if (interpreted.verified) {
      return safePublic({
        ok: true,
        success: true,
        statusCode: 200,
        already_verified: true,
        complete: recipientOnboardingCompleteFromMoov({ account, banks, capabilities, capabilitiesReadOk: capsOk }),
        bank_status: 'verified',
        bank_id: bankId,
        bank_id_fp: fingerprintMoovId(bankId),
        account_id: accountId,
        account_id_fp: fingerprintMoovId(accountId),
        recipient_id: recipient.id,
        provider: 'moov',
        liveProviderCalled: true,
        productionExecution: false,
        productionRead: true,
        recipientBankVerifyWrite: true,
        public_recipient: true,
        token_consumed: false,
        mv_code_returned: false,
        mv_code_stored: false,
        mutated: false,
        environment: 'production',
        spoofFieldsIgnored: spoof,
      });
    }

    if (!interpreted.can_confirm) {
      return safePublic(fail('verification_not_found', 409, {
        message: 'No open verification for this bank account. Start verification to receive a deposit code.',
        liveProviderCalled: true,
        productionRead: true,
        spoofFieldsIgnored: spoof,
      }));
    }

    try {
      await moovFetch({
        credentials,
        path: `/accounts/${accountId}/bank-accounts/${bankId}/verify`,
        method: 'PUT',
        mode: 'recipient_bank_verify',
        boundAccountId: accountId,
        boundBankId: bankId,
        body: verifyBody,
        scopes: recipientBankVerifyWriteScopes(accountId),
        fetchImpl,
      });
    } catch (error) {
      const mapped = mapConfirmError(error);
      const attempts = noteAttempt({ recipientId: recipient.id, bankId, nowMs: auth.nowMs });
      log('recipient_bank_verify_confirm_failed', mapped.code);
      const exhausted = attempts.locked
        || mapped.code === 'max_attempts_exceeded'
        || mapped.code === 'verification_expired';
      return safePublic(fail(exhausted
        ? (mapped.code === 'verification_expired' ? 'verification_expired' : 'max_attempts_exceeded')
        : 'verification_failed', 409, {
        requires_restart: attempts.locked || mapped.code === 'max_attempts_exceeded' || mapped.code === 'verification_expired',
        message: mapped.message,
        attempts_remaining: attempts.remaining,
        liveProviderCalled: true,
        productionRead: true,
        recipientBankVerifyWrite: true,
        spoofFieldsIgnored: spoof,
      }));
    }

    const refreshed = await moovGet({
      moovFetch, credentials, fetchImpl, accountId, bankId,
      path: `/accounts/${accountId}/bank-accounts/${bankId}`,
      scopes: [`/accounts/${accountId}/bank-accounts.read`],
    });
    if (!refreshed) {
      return safePublic(fail('moov_bank_get_failed', 502, {
        message: 'The payment provider did not confirm bank verification.',
        liveProviderCalled: true,
        productionRead: true,
        spoofFieldsIgnored: spoof,
      }));
    }
    if (providerVerifySuccessIsNotComplete({ httpOk: true, bank: refreshed })) {
      return safePublic(fail('bank_not_verified', 502, {
        message: 'The payment provider did not mark this bank as verified.',
        complete: false,
        liveProviderCalled: true,
        productionRead: true,
        spoofFieldsIgnored: spoof,
      }));
    }

    const complete = recipientOnboardingCompleteFromMoov({
      account,
      banks: [refreshed, ...banks.slice(1)],
      capabilities,
      capabilitiesReadOk: capsOk,
    });
    return safePublic({
      ok: true,
      success: true,
      statusCode: 200,
      already_verified: false,
      bank_status: String(refreshed?.status ?? 'verified').toLowerCase(),
      complete,
      bank_id: bankId,
      bank_id_fp: fingerprintMoovId(bankId),
      account_id: accountId,
      account_id_fp: fingerprintMoovId(accountId),
      recipient_id: recipient.id,
      provider: 'moov',
      liveProviderCalled: true,
      productionExecution: false,
      productionRead: true,
      recipientBankVerifyWrite: true,
      public_recipient: true,
      token_consumed: false,
      mv_code_returned: false,
      mv_code_stored: false,
      mutated: true,
      environment: 'production',
      spoofFieldsIgnored: spoof,
    });
  } catch (error) {
    log('recipient_bank_verify_confirm_failed', redactRecipientMvText(redactMoovText(String(error?.message || error))));
    if (error?.code === 'recipient_bank_verify_method_denied' || error?.code === 'recipient_bank_verify_path_denied') {
      return safePublic(fail(error.code, 403, {
        productionRead: true,
        message: 'This payment-provider path is not allowed.',
        spoofFieldsIgnored: spoof,
      }));
    }
    return safePublic(fail('verification_failed', error?.status && error.status >= 400 ? error.status : 502, {
      liveProviderCalled: true,
      message: 'The payment provider could not complete verification. Please try again shortly.',
      spoofFieldsIgnored: spoof,
    }));
  }
}
