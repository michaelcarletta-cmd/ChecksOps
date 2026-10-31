/**
 * Moov webhook confirmation: the body is a hint, Moov is the truth.
 *
 * Moov signs `timestamp|nonce|webhookID` (hmac.mjs verifyMoovSignature), not the body. Anyone
 * holding one valid set of signed headers could resend them for five minutes with any body. So
 * before any write, the webhook route reads the resource the body names (a transfer, an
 * account, a bank account) back from Moov with the platform's own credentials and builds the
 * payload the existing apply functions read from what Moov returned. Only the resource id and
 * the event type are taken from the body: a forged id makes ChecksOps refresh that resource
 * from Moov, which is what the Refresh buttons already do.
 *
 * Reads only (GET). The calls are the ones the existing code already makes:
 *   - transfer: GET /accounts/{platform}/transfers/{id} (moov-money cancelWalletFunding,
 *     moov-functions transfer status), scope transfers.read of the platform account;
 *   - account: GET /accounts/{id} and /accounts/{id}/capabilities (onboarding pullMoovStatus);
 *   - bank account: GET /accounts/{id}/bank-accounts/{bankAccountID} (onboarding handlers).
 * Credentials: resolveBillingMoovContext (production keys only on the production runtime,
 * MOOV_SANDBOX_* otherwise), from the provider secrets the webhook already loaded.
 */
import { isOnboardingEvent } from './onboarding/webhook-status.mjs';
import { MoovError, moovFetch, scopes, withMoovContext, moovEnvironment } from './parity/moov-client.mjs';
import { loadSandboxCredentials } from '../sandbox-credentials.mjs';
import { resolveBillingMoovContext } from '../tenant-billing-destination.mjs';

/** A confirmation that could not run now; the webhook answers 503 so Moov delivers it again. */
export class MoovConfirmationRetry extends Error {
  constructor(message, { status = null, resource = null } = {}) {
    super(message);
    this.name = 'MoovConfirmationRetry';
    this.code = 'provider_confirmation_unavailable';
    this.status = status;
    this.resource = resource;
  }
}

const idText = (value) => {
  const s = String(value ?? '').trim();
  return s && s.length <= 120 && /^[A-Za-z0-9_-]+$/.test(s) ? s : null;
};

/** The one resource a webhook body names, by kind. Pure; the body is not trusted. */
export function moovWebhookResource(payload = {}) {
  const data = payload?.data ?? payload ?? {};
  const eventType = String(payload?.type ?? payload?.eventType ?? '');
  const accountId = idText(payload?.accountID ?? data?.accountID ?? payload?.accountId);
  if (eventType.startsWith('bankAccount')) {
    const bankAccountId = idText(data?.bankAccountID ?? data?.bankAccountId);
    return accountId && bankAccountId
      ? { kind: 'bank_account', eventType, accountId, bankAccountId }
      : { kind: 'none', eventType };
  }
  const transferId = idText(data?.transferID ?? data?.transferId ?? payload?.transferID ?? payload?.transferId);
  if (transferId) return { kind: 'transfer', eventType, transferId, accountId };
  if (isOnboardingEvent(eventType) && accountId) {
    const capabilityId = String(eventType).startsWith('capability')
      ? (idText(data?.capabilityID ?? data?.capabilityId ?? data?.capability) || null)
      : null;
    return { kind: 'account', eventType, accountId, capabilityId };
  }
  return { kind: 'none', eventType };
}

const accountIdsOf = (transfer) => [
  transfer?.source?.account?.accountID,
  transfer?.destination?.account?.accountID,
].filter(Boolean).map(String);

/** The payload the apply functions read, built from Moov's own record. Pure. */
export function trustedMoovPayload(resource, fetched) {
  const type = resource.eventType;
  if (resource.kind === 'transfer') {
    const { transfer } = fetched;
    // The body's account is kept only when Moov names it on this transfer.
    const accountID = resource.accountId && accountIdsOf(transfer).includes(resource.accountId)
      ? resource.accountId
      : null;
    return { type, accountID, data: { ...transfer, transferID: resource.transferId } };
  }
  if (resource.kind === 'account') {
    const { account, capabilities } = fetched;
    const data = {
      accountID: resource.accountId,
      verification: account?.verification ?? null,
      profile: account?.profile?.business?.verification
        ? { business: { verification: account.profile.business.verification } }
        : null,
      disabledOn: account?.disabledOn ?? null,
    };
    if (resource.capabilityId) {
      const cap = (capabilities ?? []).find((c) => String(c?.capability ?? '') === resource.capabilityId);
      data.capabilityID = resource.capabilityId;
      data.status = cap?.status ? String(cap.status) : null;
    }
    return { type, accountID: resource.accountId, data };
  }
  if (resource.kind === 'bank_account') {
    const { bankAccount } = fetched;
    return {
      type,
      accountID: resource.accountId,
      data: {
        accountID: resource.accountId,
        bankAccountID: resource.bankAccountId,
        status: bankAccount?.status ?? null,
        bankName: bankAccount?.bankName ?? null,
        lastFourAccountNumber: bankAccount?.lastFourAccountNumber ?? null,
      },
    };
  }
  return null;
}

async function fetchResource(resource, ctx, fetchImpl) {
  if (resource.kind === 'transfer') {
    const platform = ctx.environment === 'production' ? ctx.productionPlatformAccountId : ctx.sandboxPlatformAccountId;
    if (!platform) return { unavailable: 'platform_account_unconfigured' };
    const transfer = await moovFetch(`/accounts/${platform}/transfers/${resource.transferId}`, {
      scopes: scopes.transfersRead(platform), fetchImpl,
    });
    if (transfer?.transferID && String(transfer.transferID) !== resource.transferId) {
      return { refused: 'moov_resource_mismatch' };
    }
    return { transfer };
  }
  if (resource.kind === 'account') {
    const id = resource.accountId;
    const account = await moovFetch(`/accounts/${id}`, { scopes: scopes.accountRead(id), fetchImpl });
    if (account?.accountID && String(account.accountID) !== id) return { refused: 'moov_resource_mismatch' };
    const capabilities = resource.capabilityId
      ? await moovFetch(`/accounts/${id}/capabilities`, { scopes: scopes.capabilitiesRead(id), fetchImpl })
      : null;
    return { account, capabilities };
  }
  const { accountId, bankAccountId } = resource;
  const bankAccount = await moovFetch(`/accounts/${accountId}/bank-accounts/${bankAccountId}`, {
    scopes: scopes.bankAccountsRead(accountId), fetchImpl,
  });
  if (bankAccount?.bankAccountID && String(bankAccount.bankAccountID) !== bankAccountId) {
    return { refused: 'moov_resource_mismatch' };
  }
  return { bankAccount };
}

/**
 * Read the resource a verified webhook names back from Moov.
 *   { ok: true, payload, resource, environment, liveProviderCalled: true }  apply `payload`;
 *   { ok: false, skipped, liveProviderCalled }  apply nothing, keep the receipt (200);
 *   throws MoovConfirmationRetry  network, rate limit or Moov 5xx: roll back, answer 503.
 */
export async function confirmMoovWebhookPayload(payload, {
  environment, secrets = {}, fetchImpl = fetch, loadSandbox = null,
} = {}) {
  const resource = moovWebhookResource(payload);
  if (resource.kind === 'none') return { ok: false, skipped: 'unconfirmable_event', liveProviderCalled: false };

  const resolved = await resolveBillingMoovContext({
    environment,
    deps: { loadSandboxCredentials: loadSandbox || (() => loadSandboxCredentials(async () => secrets)) },
  });
  if (!resolved.ok) {
    return { ok: false, skipped: 'provider_confirmation_unconfigured', reason: resolved.error, liveProviderCalled: false };
  }

  let fetched;
  try {
    fetched = await withMoovContext({ ...resolved.moovContext, fetchImpl }, async () => {
      if (moovEnvironment() !== resolved.environment) throw new Error(`moov_context_unbound:${moovEnvironment()}`);
      return fetchResource(resource, resolved.moovContext, fetchImpl);
    });
  } catch (error) {
    const status = error instanceof MoovError ? Number(error.status) : null;
    if (status === 404) return { ok: false, skipped: 'moov_resource_not_found', liveProviderCalled: true };
    if (status && status >= 400 && status < 500 && status !== 408 && status !== 429) {
      return { ok: false, skipped: 'provider_confirmation_refused', status, liveProviderCalled: true };
    }
    throw new MoovConfirmationRetry(String(error?.message || error).slice(0, 200), { status, resource: resource.kind });
  }
  if (fetched.unavailable) return { ok: false, skipped: 'provider_confirmation_unconfigured', reason: fetched.unavailable, liveProviderCalled: false };
  if (fetched.refused) return { ok: false, skipped: fetched.refused, liveProviderCalled: true };
  return {
    ok: true,
    payload: trustedMoovPayload(resource, fetched),
    resource: resource.kind,
    environment: resolved.environment,
    liveProviderCalled: true,
  };
}
