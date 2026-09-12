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
  BANK_VERIFY_STATES,
  createMemoryBankVerifyStore,
  openRecipientBankVerifyStore,
  tokenFingerprint,
} from './providers/recipient-bank-verify-state.mjs';
import {
  productionRecipientBridgeConfigured,
  recipientSessionTokenShape,
  resolveProductionRecipientByToken,
} from './production-recipient-token.mjs';
import { randomUUID } from 'node:crypto';

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

export const resetRecipientBankVerifyMemoryForTests = () => {
  ipFailures.clear();
};

export const newTestBankVerifyStore = (backing) => createMemoryBankVerifyStore(backing);

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
    token,
    tokenFp: tokenFingerprint(token),
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

const stateUnavailable = (extra = {}) => fail('bank_verify_state_unavailable', 503, {
  message: 'Bank verification state is unavailable. No provider write was sent.',
  liveProviderCalled: extra.liveProviderCalled === true,
  productionRead: extra.productionRead === true,
  spoofFieldsIgnored: extra.spoof,
});

const limiterUnavailable = (extra = {}) => fail('bank_verify_limiter_unavailable', 503, {
  message: 'Verification attempt limiting is unavailable. The code was not submitted.',
  liveProviderCalled: extra.liveProviderCalled === true,
  productionRead: extra.productionRead === true,
  recipientBankVerifyWrite: extra.recipientBankVerifyWrite === true,
  spoofFieldsIgnored: extra.spoof,
});

const openStateStore = (deps = {}) => {
  const opened = openRecipientBankVerifyStore(deps);
  if (!opened.ok) {
    return { ok: false, result: fail(opened.error, opened.statusCode || 503, {
      message: 'Bank verification state is unavailable. No provider write was sent.',
    }) };
  }
  return opened;
};

const persistProviderState = async (store, ids, interpreted, nowMs) => {
  if (interpreted?.verified) {
    await store.transitionClaim({ ...ids, to: BANK_VERIFY_STATES.VERIFIED, nowMs });
    return BANK_VERIFY_STATES.VERIFIED;
  }
  if (interpreted?.initiated) {
    await store.transitionClaim({ ...ids, to: BANK_VERIFY_STATES.VERIFICATION_PENDING, nowMs });
    return BANK_VERIFY_STATES.VERIFICATION_PENDING;
  }
  return (await store.getClaim(ids)).state;
};

const publicBankVerifyResult = ({
  spoof,
  recipient,
  accountId,
  bankId,
  interpreted = {},
  extra = {},
}) => ({
  ok: extra.ok !== false,
  success: extra.ok !== false,
  statusCode: extra.statusCode || (extra.ok === false ? 400 : 200),
  initiated: extra.initiated ?? interpreted.initiated ?? false,
  can_confirm: extra.can_confirm ?? interpreted.can_confirm ?? false,
  already_initiated: extra.already_initiated === true,
  already_verified: extra.already_verified === true,
  mutated: extra.mutated === true,
  complete: extra.complete === true,
  bank_status: extra.bank_status ?? interpreted.bank_status ?? null,
  verification_status: extra.verification_status ?? interpreted.verification_status ?? null,
  state: extra.state || null,
  bank_id: bankId,
  bank_id_fp: fingerprintMoovId(bankId),
  account_id: accountId,
  account_id_fp: fingerprintMoovId(accountId),
  recipient_id: recipient.id,
  provider: 'moov',
  liveProviderCalled: true,
  productionExecution: false,
  productionRead: true,
  recipientBankVerifyWrite: extra.recipientBankVerifyWrite !== false,
  public_recipient: true,
  token_consumed: false,
  mv_code_returned: false,
  mv_code_stored: false,
  environment: 'production',
  spoofFieldsIgnored: spoof,
  ...extra,
});

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
  const { body, spoof, log, recipient, accountId, credentials, fetchImpl, moovFetch, tokenFp, nowMs } = auth;
  const opened = openStateStore(deps);
  if (!opened.ok) return safePublic(opened.result);
  const store = opened.store;

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
    const { account, banks, capabilities, capsOk, bank, bankId, liveVerify, interpreted } = loaded;
    const ids = { recipientId: recipient.id, accountId, bankId };
    const idempotencyKey = recipientBankVerifyIdempotencyKey({ recipientId: recipient.id, bankId });
    const bound = {
      spoof, recipient, accountId, bankId, interpreted,
    };

    try {
      if (interpreted.verified) {
        const state = await persistProviderState(store, ids, interpreted, nowMs);
        return safePublic(publicBankVerifyResult({
          ...bound,
          extra: {
            already_verified: true,
            initiated: false,
            mutated: false,
            complete: recipientOnboardingCompleteFromMoov({ account, banks, capabilities, capabilitiesReadOk: capsOk }),
            state,
          },
        }));
      }

      if (!shouldInitiateInstantMicroDeposit({ bank, verification: liveVerify })) {
        const state = await persistProviderState(store, ids, interpreted, nowMs);
        return safePublic(publicBankVerifyResult({
          ...bound,
          extra: {
            already_initiated: true,
            initiated: interpreted.initiated,
            can_confirm: interpreted.can_confirm,
            mutated: false,
            complete: false,
            state,
          },
        }));
      }

      const claim = await store.claimInitiation({
        ...ids,
        claimantId: randomUUID(),
        idempotencyKey,
        tokenFp,
        nowMs,
      });
      if (!claim.claimed) {
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
        } catch {
          refreshedBank = bank;
          refreshedVerify = liveVerify;
        }
        const after = interpretRecipientBankVerification({ bank: refreshedBank, verification: refreshedVerify });
        const state = await persistProviderState(store, ids, after, nowMs);
        if (after.verified) {
          return safePublic(publicBankVerifyResult({
            ...bound,
            interpreted: after,
            extra: {
              already_verified: true,
              initiated: false,
              mutated: false,
              complete: recipientOnboardingCompleteFromMoov({ account, banks, capabilities, capabilitiesReadOk: capsOk }),
              state,
            },
          }));
        }
        if (after.initiated) {
          return safePublic(publicBankVerifyResult({
            ...bound,
            interpreted: after,
            extra: {
              already_initiated: true,
              initiated: true,
              mutated: false,
              complete: false,
              state,
            },
          }));
        }
        return safePublic(fail('initiate_uncertain', 502, {
          liveProviderCalled: true,
          productionRead: true,
          recipientBankVerifyWrite: true,
          mutated: false,
          already_initiated: false,
          state: state === BANK_VERIFY_STATES.NOT_STARTED
            ? (claim.item?.state || BANK_VERIFY_STATES.INITIATION_CLAIMED)
            : state,
          message: 'Another initiation already claimed this bank. The payment provider was not posted again.',
          spoofFieldsIgnored: spoof,
        }));
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
          idempotencyKey,
          scopes: recipientBankVerifyWriteScopes(accountId),
          fetchImpl,
        });
      } catch (error) {
        if (isProviderNetworkError(error) || error?.code === 'ETIMEDOUT' || String(error?.message || '') === 'fetch failed') {
          uncertain = true;
        } else if (!initiateAlreadyOpenError(String(error?.message || '')) && error?.status !== 409) {
          log('recipient_bank_verify_initiate_failed', redactRecipientMvText(redactMoovText(String(error?.message || error))));
          await store.transitionClaim({ ...ids, to: BANK_VERIFY_STATES.UNCERTAIN, nowMs });
          return safePublic(fail('initiate_failed', 502, {
            liveProviderCalled: true,
            productionRead: true,
            recipientBankVerifyWrite: true,
            state: BANK_VERIFY_STATES.UNCERTAIN,
            message: 'Could not start bank verification with the payment provider.',
            spoofFieldsIgnored: spoof,
          }));
        }
      }

      if (deps.crashAfterPost) {
        const killed = new Error('lambda_killed');
        killed.code = 'lambda_killed';
        throw killed;
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
      } catch {
        await store.transitionClaim({ ...ids, to: BANK_VERIFY_STATES.UNCERTAIN, nowMs });
        return safePublic(fail('initiate_uncertain', 502, {
          liveProviderCalled: true,
          productionRead: true,
          recipientBankVerifyWrite: true,
          mutated: false,
          state: BANK_VERIFY_STATES.UNCERTAIN,
          message: 'The payment provider did not confirm initiation. Verification was not retried.',
          spoofFieldsIgnored: spoof,
        }));
      }

      const after = interpretRecipientBankVerification({ bank: refreshedBank, verification: refreshedVerify });
      if (uncertain && !after.initiated && !after.verified) {
        await store.transitionClaim({ ...ids, to: BANK_VERIFY_STATES.UNCERTAIN, nowMs });
        return safePublic(fail('initiate_uncertain', 502, {
          liveProviderCalled: true,
          productionRead: true,
          recipientBankVerifyWrite: true,
          mutated: false,
          state: BANK_VERIFY_STATES.UNCERTAIN,
          message: 'The payment provider did not confirm initiation. Verification was not retried.',
          spoofFieldsIgnored: spoof,
        }));
      }

      const state = await persistProviderState(store, ids, after.verified || after.initiated
        ? after
        : { ...after, initiated: true }, nowMs);
      return safePublic(publicBankVerifyResult({
        ...bound,
        interpreted: after,
        extra: {
          initiated: after.initiated || true,
          can_confirm: after.can_confirm,
          already_initiated: Boolean(uncertain && after.initiated),
          mutated: !uncertain,
          complete: false,
          state,
        },
      }));
    } catch (error) {
      if (error?.code === 'bank_verify_state_unavailable') {
        return safePublic(stateUnavailable({ liveProviderCalled: true, productionRead: true, spoof }));
      }
      throw error;
    }
  } catch (error) {
    log('recipient_bank_verify_initiate_failed', redactRecipientMvText(redactMoovText(String(error?.message || error))));
    if (error?.code === 'lambda_killed') {
      return safePublic(fail('initiate_uncertain', 502, {
        liveProviderCalled: true,
        productionRead: true,
        recipientBankVerifyWrite: true,
        mutated: false,
        state: BANK_VERIFY_STATES.INITIATION_CLAIMED,
        message: 'The payment provider did not confirm initiation. Verification was not retried.',
        spoofFieldsIgnored: spoof,
      }));
    }
    if (error?.code === 'bank_verify_state_unavailable') {
      return safePublic(stateUnavailable({ liveProviderCalled: true, productionRead: true, spoof }));
    }
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
  const { body, spoof, log, recipient, accountId, credentials, fetchImpl, moovFetch, tokenFp, nowMs } = auth;
  const opened = openStateStore(deps);
  if (!opened.ok) return safePublic(opened.result);
  const store = opened.store;

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
    const ids = { recipientId: recipient.id, accountId, bankId };

    if (interpreted.verified) {
      await persistProviderState(store, ids, interpreted, nowMs);
      return safePublic({
        ok: true,
        success: true,
        statusCode: 200,
        already_verified: true,
        complete: recipientOnboardingCompleteFromMoov({ account, banks, capabilities, capabilitiesReadOk: capsOk }),
        bank_status: 'verified',
        state: BANK_VERIFY_STATES.VERIFIED,
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

    let attempts;
    try {
      attempts = await store.consumeMvAttempt({
        recipientId: recipient.id,
        accountId,
        bankId,
        tokenFp,
        nowMs,
      });
    } catch (error) {
      if (error?.code === 'bank_verify_state_unavailable') {
        return safePublic(limiterUnavailable({
          liveProviderCalled: true,
          productionRead: true,
          recipientBankVerifyWrite: true,
          spoof,
        }));
      }
      throw error;
    }
    if (!attempts.ok) {
      if (attempts.error === 'bank_verify_limiter_unavailable') {
        return safePublic(limiterUnavailable({
          liveProviderCalled: true,
          productionRead: true,
          recipientBankVerifyWrite: true,
          spoof,
        }));
      }
      return safePublic(fail('max_attempts_exceeded', 409, {
        requires_restart: true,
        message: 'Too many incorrect attempts. Restart verification to receive a new deposit code.',
        attempts_remaining: 0,
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

    await store.transitionClaim({ ...ids, to: BANK_VERIFY_STATES.VERIFIED, nowMs });
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
      state: BANK_VERIFY_STATES.VERIFIED,
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
    if (error?.code === 'bank_verify_state_unavailable') {
      return safePublic(limiterUnavailable({
        liveProviderCalled: true,
        productionRead: true,
        recipientBankVerifyWrite: true,
        spoof,
      }));
    }
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
