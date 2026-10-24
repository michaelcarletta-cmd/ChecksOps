/**
 * Moov calls for payee setup (SQL 113), environment-agnostic: the caller binds
 * sandbox or production credentials with withMoovContext.
 *
 * Identity numbers (SSN, EIN), dates of birth, bank account and routing numbers
 * only ever travel in a request body to Moov. Nothing here logs, stores or
 * returns them, and Moov error text (which can echo submitted values) is never
 * passed on: callers map a MoovError to a code (redact.mjs moovErrorCode).
 */
import { MoovError, moovFetch, scopes } from '../parity/moov-client.mjs';
import { MOOV_CAPABILITIES_API_VERSION, RECIPIENT_CAPABILITIES, missingRequestedCapabilities } from '../parity/moov-capabilities.mjs';
import { businessProfileBody, representativeBody } from '../onboarding/moov-sync.mjs';
import { moovErrorCode } from '../onboarding/redact.mjs';
import {
  capabilityRequirementNames,
  liveBankVerified,
  liveTosAccepted,
  tosConfirmedByMoov,
} from '../moov-recipient-tos-policy.mjs';

const lower = (v) => String(v ?? '').trim().toLowerCase();
const asList = (payload, key) => (Array.isArray(payload) ? payload : (payload?.[key] ?? []));

export const payeeIdempotencyKey = (environment, recipientId) => `checksops-payee-${environment}-${recipientId}`;

/** First and last name from the company-entered display name. */
export const splitDisplayName = (name) => {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: 'Payee', lastName: '.' };
  if (parts.length === 1) return { firstName: parts[0].slice(0, 60), lastName: '.' };
  const lastName = parts.pop().slice(0, 60);
  return { firstName: parts.join(' ').slice(0, 60), lastName };
};

/** POST /accounts body for a new payee: no identity data, transfers only. */
export const payeeAccountBody = ({ recipientId, tenantId, displayName, email, recipientType }) => {
  const common = {
    capabilities: [...RECIPIENT_CAPABILITIES],
    foreignID: recipientId,
    metadata: { checksops_recipient_id: recipientId, checksops_tenant_id: tenantId },
  };
  if (recipientType === 'business') {
    return {
      accountType: 'business',
      profile: { business: { legalBusinessName: displayName, email } },
      ...common,
    };
  }
  return {
    accountType: 'individual',
    profile: { individual: { name: splitDisplayName(displayName), email } },
    ...common,
  };
};

async function findAccountByForeignId(foreignId, fetchImpl) {
  const found = await moovFetch(`/accounts?foreignID=${encodeURIComponent(foreignId)}`, {
    scopes: scopes.accountsRead(), fetchImpl,
  });
  const match = asList(found, 'accounts').find((a) => String(a?.foreignID ?? '') === String(foreignId));
  return match?.accountID ?? match?.accountId ?? null;
}

/**
 * Creates the payee's Moov account (foreignID = recipient id, idempotency key
 * from the recipient id). A 409 means Moov already holds it: adopt it by
 * foreignID. Returns { accountId, adopted }.
 */
export async function createPayeeAccount({ environment, recipientId, tenantId, displayName, email, recipientType, fetchImpl }) {
  const body = payeeAccountBody({ recipientId, tenantId, displayName, email, recipientType });
  try {
    const created = await moovFetch('/accounts', {
      method: 'POST',
      scopes: scopes.accountsWrite(),
      idempotencyKey: payeeIdempotencyKey(environment, recipientId),
      apiVersion: MOOV_CAPABILITIES_API_VERSION,
      body,
      fetchImpl,
    });
    const accountId = created?.accountID ?? created?.accountId ?? null;
    return { accountId, adopted: false };
  } catch (error) {
    if (!(error instanceof MoovError) || error.status !== 409) throw error;
    const accountId = await findAccountByForeignId(recipientId, fetchImpl);
    if (!accountId) throw error;
    return { accountId, adopted: true };
  }
}

/**
 * Live account, capabilities and banks. A failed capabilities/bank read is
 * reported (its moovErrorCode), never guessed.
 */
export async function readPayeeLive(accountId, fetchImpl) {
  const account = await moovFetch(`/accounts/${accountId}`, { scopes: scopes.accountRead(accountId), fetchImpl });
  let capabilities = [];
  let capabilitiesReadOk = false;
  let capabilitiesReadError = null;
  try {
    capabilities = asList(await moovFetch(`/accounts/${accountId}/capabilities`, {
      scopes: scopes.capabilitiesRead(accountId), fetchImpl,
    }), 'capabilities');
    capabilitiesReadOk = true;
  } catch (error) {
    if (!(error instanceof MoovError)) throw error;
    capabilitiesReadError = moovErrorCode(error);
  }
  let banks = [];
  let banksReadOk = false;
  let banksReadError = null;
  try {
    banks = asList(await moovFetch(`/accounts/${accountId}/bank-accounts`, {
      scopes: scopes.bankAccountsRead(accountId), fetchImpl,
    }), 'bankAccounts');
    banksReadOk = true;
  } catch (error) {
    if (!(error instanceof MoovError)) throw error;
    banksReadError = moovErrorCode(error);
  }
  return { account, capabilities, capabilitiesReadOk, capabilitiesReadError, banks, banksReadOk, banksReadError };
}

export const bankIdOf = (bank) => String(bank?.bankAccountID ?? bank?.bankAccountId ?? '');

export const verificationStatusOf = (account = {}) => lower(
  account?.profile?.individual?.verification?.status
  ?? account?.profile?.business?.verification?.status
  ?? account?.verification?.verificationStatus
  ?? account?.verification?.status
  ?? '',
);

const transfersCapability = (capabilities = []) => (capabilities || [])
  .find((c) => lower(c?.capability) === 'transfers') || null;

/** Requirement names Moov still lists, minus terms (shown separately). Field names only, no values. */
export const outstandingRequirements = (capabilities = []) => capabilityRequirementNames(capabilities)
  .filter((name) => !/tos|terms/i.test(name))
  .slice(0, 40);

/**
 * Moov's verdict for a payee:
 *  'verified'       transfers enabled, nothing outstanding, terms accepted, the
 *                   payee's recorded bank verified and the account not disabled.
 *                   Moov's transfers capability is the gate: a payee who only
 *                   receives funds can have transfers enabled while the identity
 *                   verification still reads 'unverified' (seen in sandbox), so
 *                   only a failed or rejected verification blocks it;
 *  'failed'         Moov failed the verification or disabled the account;
 *  'pending_review' Moov is reviewing (capability pending / in review);
 *  null             setup still in progress.
 */
export function payeeVerdict(live, { bankAccountId = null } = {}) {
  const { account, capabilities = [], capabilitiesReadOk = false, banks = [] } = live || {};
  if (!account) return { status: null, complete: false };
  const verification = verificationStatusOf(account);
  const transfers = transfersCapability(capabilities);
  const capStatus = lower(transfers?.status);
  const disabled = Boolean(account?.disabledOn);
  const tos = tosConfirmedByMoov({ account, capabilities, capabilitiesReadOk });
  const bank = bankAccountId ? (banks || []).find((b) => bankIdOf(b) === String(bankAccountId)) : null;
  const bankVerified = Boolean(bank) && liveBankVerified([bank]);
  const outstanding = capabilitiesReadOk ? capabilityRequirementNames(transfers ? [transfers] : capabilities) : null;
  if (disabled || verification === 'failed' || verification === 'rejected') {
    return { status: 'failed', complete: false, tos, bankVerified, verification, capStatus };
  }
  const complete = capabilitiesReadOk && capStatus === 'enabled' && outstanding.length === 0
    && tos && bankVerified;
  if (complete) return { status: 'verified', complete: true, tos, bankVerified, verification, capStatus };
  const reviewing = capStatus === 'pending' || capStatus === 'in-review' || capStatus === 'in_review'
    || verification === 'pending' || verification === 'review' || verification === 'in-review';
  return { status: reviewing ? 'pending_review' : null, complete: false, tos, bankVerified, verification, capStatus };
}

/** Requests the transfers capability again when Moov lost it (never for a failed account). */
export async function ensurePayeeCapabilities(accountId, live, fetchImpl) {
  if (!live?.capabilitiesReadOk) return false;
  const missing = missingRequestedCapabilities(live.capabilities, RECIPIENT_CAPABILITIES);
  if (missing.length === 0 || verificationStatusOf(live.account) === 'failed') return false;
  await moovFetch(`/accounts/${accountId}/capabilities`, {
    method: 'POST',
    scopes: scopes.capabilitiesWrite(accountId),
    apiVersion: MOOV_CAPABILITIES_API_VERSION,
    body: { capabilities: missing },
    fetchImpl,
  });
  return true;
}

/**
 * Server-minted terms acceptance: a /tos-token minted with the payee's own IP
 * and user agent, then PATCH termsOfService on the payee's account. Confirms
 * from Moov afterwards. Returns { confirmed, alreadyAccepted }.
 */
export async function acceptPayeeTerms(accountId, { ip, userAgent, fetchImpl }) {
  const before = await readPayeeLive(accountId, fetchImpl);
  const alreadyAccepted = liveTosAccepted(before.account);
  if (!alreadyAccepted) {
    const extraHeaders = { ...(ip ? { 'X-Forwarded-For': ip, 'X-Real-IP': ip } : {}), 'User-Agent': userAgent || 'unknown' };
    const minted = await moovFetch('/tos-token', { scopes: ['/ping.read'], extraHeaders, fetchImpl });
    const token = minted?.token ?? minted?.tosToken ?? null;
    if (!token) return { confirmed: false, alreadyAccepted, error: 'terms_token_unavailable' };
    try {
      await moovFetch(`/accounts/${accountId}`, {
        method: 'PATCH', scopes: scopes.accountWrite(accountId), body: { termsOfService: { token } }, extraHeaders, fetchImpl,
      });
    } catch (error) {
      if (!(error instanceof MoovError && /already\s+(been\s+)?accept|terms.*already/i.test(String(error.message)))) throw error;
    }
  }
  const tosOutstandingBefore = before.capabilitiesReadOk
    ? capabilityRequirementNames(before.capabilities).some((n) => /tos|terms/i.test(n))
    : null;
  const after = await readPayeeLive(accountId, fetchImpl);
  const confirmed = tosConfirmedByMoov({
    account: after.account,
    capabilities: after.capabilities,
    capabilitiesReadOk: after.capabilitiesReadOk,
    tosOutstandingBefore: tosOutstandingBefore === true,
  });
  return { confirmed, alreadyAccepted, live: after };
}

export async function patchIndividualIdentity(accountId, patchBody, fetchImpl) {
  await moovFetch(`/accounts/${accountId}`, {
    method: 'PATCH', scopes: scopes.accountWrite(accountId), body: patchBody, fetchImpl,
  });
}

const repKey = (first, last) => `${lower(first)}|${lower(last)}`;

/**
 * KYB: business profile (EIN in memory only), representatives upserted by name
 * against Moov's current list (people no longer submitted are removed), then
 * ownersProvided. `reps` are validateRepresentatives rows (dob, ssn in memory).
 */
export async function submitBusinessIdentity(accountId, { fields, ein, reps }, fetchImpl) {
  await moovFetch(`/accounts/${accountId}`, {
    method: 'PATCH',
    scopes: scopes.accountWrite(accountId),
    body: { profile: { business: businessProfileBody(fields, ein) } },
    fetchImpl,
  });
  const existing = asList(await moovFetch(`/accounts/${accountId}/representatives`, {
    scopes: scopes.representativesRead(accountId), fetchImpl,
  }), 'representatives');
  const byName = new Map(existing.map((r) => [repKey(r?.name?.firstName, r?.name?.lastName), r]));
  const kept = new Set();
  for (const rep of reps) {
    const body = representativeBody(rep, { dob: rep.dob, ssn: rep.ssn });
    const match = byName.get(repKey(rep.first_name, rep.last_name));
    const matchId = match?.representativeID ?? match?.representativeId ?? null;
    if (matchId) {
      await moovFetch(`/accounts/${accountId}/representatives/${matchId}`, {
        method: 'PATCH', scopes: scopes.representativesWrite(accountId), body, fetchImpl,
      });
      kept.add(String(matchId));
    } else {
      const created = await moovFetch(`/accounts/${accountId}/representatives`, {
        method: 'POST', scopes: scopes.representativesWrite(accountId), body, fetchImpl,
      });
      const createdId = created?.representativeID ?? created?.representativeId ?? null;
      if (createdId) kept.add(String(createdId));
    }
  }
  for (const old of existing) {
    const id = String(old?.representativeID ?? old?.representativeId ?? '');
    if (!id || kept.has(id)) continue;
    await moovFetch(`/accounts/${accountId}/representatives/${id}`, {
      method: 'DELETE', scopes: scopes.representativesWrite(accountId), fetchImpl,
    }).catch((error) => {
      if (error instanceof MoovError && error.status === 404) return null;
      throw error;
    });
  }
  await moovFetch(`/accounts/${accountId}`, {
    method: 'PATCH',
    scopes: scopes.accountWrite(accountId),
    body: { profile: { business: { ownersProvided: true } } },
    fetchImpl,
  });
  return { representatives: reps.length };
}

/**
 * Adds the payee's bank. A 409 (Moov already holds this bank) adopts the
 * existing one matched by last four and routing number.
 */
export async function addPayeeBank(accountId, { holderName, holderType, bankAccountType, routingNumber, accountNumber }, fetchImpl) {
  try {
    return await moovFetch(`/accounts/${accountId}/bank-accounts`, {
      method: 'POST',
      scopes: scopes.bankAccountsWrite(accountId),
      body: { account: { holderName, holderType, accountNumber, routingNumber, bankAccountType } },
      fetchImpl,
    });
  } catch (error) {
    if (!(error instanceof MoovError) || error.status !== 409) throw error;
    const banks = asList(await moovFetch(`/accounts/${accountId}/bank-accounts`, {
      scopes: scopes.bankAccountsRead(accountId), fetchImpl,
    }), 'bankAccounts');
    const match = banks.find((b) => String(b?.lastFourAccountNumber ?? '') === accountNumber.slice(-4)
      && String(b?.routingNumber ?? '') === routingNumber);
    if (!match) throw error;
    return match;
  }
}

export async function readBank(accountId, bankAccountId, fetchImpl) {
  return moovFetch(`/accounts/${accountId}/bank-accounts/${bankAccountId}`, {
    scopes: scopes.bankAccountsRead(accountId), fetchImpl,
  });
}

export async function readBankVerification(accountId, bankAccountId, fetchImpl) {
  try {
    return await moovFetch(`/accounts/${accountId}/bank-accounts/${bankAccountId}/verify`, {
      scopes: scopes.bankAccountsRead(accountId), fetchImpl,
    });
  } catch (error) {
    if (error instanceof MoovError) return null;
    throw error;
  }
}

export async function initiateBankVerification(accountId, bankAccountId, fetchImpl) {
  await moovFetch(`/accounts/${accountId}/bank-accounts/${bankAccountId}/verify`, {
    method: 'POST', scopes: scopes.bankAccountsWrite(accountId), fetchImpl,
  });
}

export async function confirmBankVerification(accountId, bankAccountId, verifyBody, fetchImpl) {
  await moovFetch(`/accounts/${accountId}/bank-accounts/${bankAccountId}/verify`, {
    method: 'PUT', scopes: scopes.bankAccountsWrite(accountId), body: verifyBody, fetchImpl,
  });
}

/** Best-effort: removes a bank at Moov (a replaced or disconnected payee's). */
export async function disableBank(accountId, bankAccountId, fetchImpl) {
  await moovFetch(`/accounts/${accountId}/bank-accounts/${bankAccountId}`, {
    method: 'DELETE', scopes: scopes.bankAccountsWrite(accountId), fetchImpl,
  });
}

/**
 * Best-effort disconnect at Moov: every bank on the account is removed, then
 * the account is disconnected (DELETE /accounts/{id}) so it can no longer be
 * paid. Each failure is reported, never thrown.
 */
export async function disconnectPayeeAtMoov(accountId, fetchImpl) {
  const out = { banks_disabled: 0, bank_errors: 0, account_disconnected: false };
  try {
    const banks = asList(await moovFetch(`/accounts/${accountId}/bank-accounts`, {
      scopes: scopes.bankAccountsRead(accountId), fetchImpl,
    }), 'bankAccounts');
    for (const bank of banks) {
      const id = bankIdOf(bank);
      if (!id) continue;
      try {
        await disableBank(accountId, id, fetchImpl);
        out.banks_disabled += 1;
      } catch {
        out.bank_errors += 1;
      }
    }
  } catch {
    out.bank_errors += 1;
  }
  try {
    await moovFetch(`/accounts/${accountId}`, {
      method: 'DELETE',
      scopes: [`/accounts/${accountId}/profile.disconnect`],
      apiVersion: MOOV_CAPABILITIES_API_VERSION,
      fetchImpl,
    });
    out.account_disconnected = true;
  } catch {
    out.account_disconnected = false;
  }
  return out;
}
