/**
 * Sends the stored onboarding profile to Moov, idempotently:
 *   1. create the Moov account if this tenant/environment has none,
 *   2. PATCH the business profile (EIN decrypted in memory only),
 *   3. upsert representatives keyed by the stored moov_representative_id,
 *   4. request the merchant capabilities,
 *   5. record Moov ids and status in ChecksOps.
 *
 * Full SSNs exist only in `ssnByRepresentativeId` for the current request. A
 * retry from the outbox re-sends everything except SSNs; a representative that
 * still needs one is flagged ssn_resubmit_required so the tenant re-enters it.
 */
import { createHash } from 'node:crypto';
import { MoovError, moovFetch, scopes } from '../parity/moov-client.mjs';
import { MERCHANT_CAPABILITIES, MOOV_CAPABILITIES_API_VERSION } from '../parity/moov-capabilities.mjs';
import { logPaymentEvent } from '../parity/db.mjs';
import { OnboardingError } from './crypto.mjs';
import { isNetworkError, moovErrorCode, moovRejectedFields, onboardingLog } from './redact.mjs';
import {
  completeOutbox,
  decryptProfileEin,
  decryptRepresentativeDob,
  failOutboxAttempt,
  loadAccount,
  loadProfile,
  loadRepresentatives,
  markRepresentativeSsnResubmit,
  markRepresentativeSynced,
  moovAddress,
  setProfileSyncState,
} from './store.mjs';

// One key per distinct account request: Moov answers 409 when a key is reused
// with a different body, which happened after a rejected payload was corrected.
// The same payload keeps the same key, so a retry stays idempotent.
export const accountIdempotencyKey = (environment, tenantId, bodyDigest = '') => (
  `checksops-account-${environment}-${tenantId}${bodyDigest ? `-${bodyDigest}` : ''}`
);
export const accountBodyDigest = (body) => createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 16);

/** The Moov account already filed under this tenant's foreignID, or null. */
async function findMoovAccountByForeignId(tenantId, fetchImpl) {
  const found = await moovFetch(`/accounts?foreignID=${encodeURIComponent(tenantId)}`, {
    method: 'GET', scopes: scopes.accountsRead(), fetchImpl,
  });
  const list = Array.isArray(found) ? found : [];
  const match = list.find((a) => String(a?.foreignID ?? '') === String(tenantId));
  return match?.accountID ?? match?.accountId ?? null;
}

export function businessProfileBody(profile, ein) {
  if (!profile) return null;
  return {
    legalBusinessName: profile.legal_name,
    ...(profile.dba ? { doingBusinessAs: profile.dba } : {}),
    businessType: profile.business_type,
    address: moovAddress(profile.address),
    phone: { number: profile.phone, countryCode: '1' },
    email: profile.email,
    ...(profile.website ? { website: profile.website } : {}),
    ...(profile.description ? { description: profile.description } : {}),
    ...(ein ? { taxID: { ein: { number: ein } } } : {}),
  };
}

export function representativeBody(rep, { dob, ssn }) {
  const m = dob ? String(dob).match(/^(\d{4})-(\d{2})-(\d{2})$/) : null;
  const pct = rep.ownership_pct === null || rep.ownership_pct === undefined ? 0 : Number(rep.ownership_pct);
  return {
    name: { firstName: rep.first_name, lastName: rep.last_name },
    ...(rep.email ? { email: rep.email } : {}),
    ...(rep.phone ? { phone: { number: rep.phone, countryCode: '1' } } : {}),
    address: moovAddress(rep.address),
    ...(m ? { birthDate: { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) } } : {}),
    ...(ssn ? { governmentID: { ssn: { full: ssn } } } : {}),
    responsibilities: {
      isController: rep.is_controller === true,
      isOwner: rep.is_owner === true,
      ...(rep.is_owner === true && pct > 0 ? { ownershipPercentage: Math.min(100, Math.round(pct)) } : {}),
      jobTitle: rep.title || 'Owner',
    },
  };
}

/** Creates the Moov account when missing and records it. Returns the account row. */
export async function ensureMoovAccount(client, ctx, { profile = null, ein = null, tosToken = null, fetchImpl } = {}) {
  const existing = await loadAccount(client, ctx.tenantId, ctx.environment);
  if (existing?.provider_account_id) return { account: existing, created: false };
  const tenant = (await client.query(
    `SELECT id, name, legal_business_name, email_reply_to, email_from_address, business_phone
     FROM public.tenants WHERE id = $1::uuid`,
    [ctx.tenantId],
  )).rows[0];
  if (!tenant) throw new OnboardingError('tenant_not_found', 404);
  const business = businessProfileBody(profile, ein) || {
    legalBusinessName: tenant.legal_business_name ?? tenant.name ?? 'ChecksOps Organization',
    ...(tenant.email_reply_to || tenant.email_from_address ? { email: tenant.email_reply_to ?? tenant.email_from_address } : {}),
    ...(tenant.business_phone ? { phone: { number: String(tenant.business_phone).replace(/\D/g, '').slice(-10), countryCode: '1' } } : {}),
  };
  const body = {
    accountType: 'business',
    profile: { business },
    capabilities: [...MERCHANT_CAPABILITIES],
    // Members only (defense in depth; the handler already drops a non-member's token).
    ...(tosToken && ctx.member === true ? { termsOfService: { token: tosToken } } : {}),
    foreignID: ctx.tenantId,
    metadata: { checksops_tenant_id: ctx.tenantId },
  };
  const key = accountIdempotencyKey(ctx.environment, ctx.tenantId, accountBodyDigest(body));
  await client.query(
    `INSERT INTO public.payment_idempotency_keys (tenant_id, provider, scope, idempotency_key, status)
     VALUES ($1::uuid, 'moov', 'account_create', $2, 'in_progress')
     ON CONFLICT DO NOTHING`,
    [ctx.tenantId, key],
  );
  let accountId = null;
  try {
    const created = await moovFetch('/accounts', {
      method: 'POST',
      scopes: scopes.accountsWrite(),
      idempotencyKey: key,
      apiVersion: MOOV_CAPABILITIES_API_VERSION,
      fetchImpl,
      body,
    });
    accountId = created?.accountID ?? created?.accountId ?? null;
  } catch (error) {
    // 409: Moov already holds an account for this tenant (an earlier create whose
    // record never landed here). Adopt it; anything else is a real failure.
    if (!(error instanceof MoovError) || error.status !== 409) throw error;
    accountId = await findMoovAccountByForeignId(ctx.tenantId, fetchImpl);
    if (!accountId) throw error;
  }
  if (!accountId) throw new OnboardingError('moov_account_id_missing', 502);
  const saved = (await client.query(
    `INSERT INTO public.payment_provider_accounts
      (tenant_id, provider, environment, provider_account_id, account_type, display_name,
       onboarding_status, verification_status, provider_metadata, last_synced_at,
       tos_accepted_at, tos_accepted_by, tos_source)
     VALUES ($1::uuid, 'moov', $2, $3, 'business', $4, 'onboarding_incomplete', 'not_started',
             $5::jsonb, now(),
             CASE WHEN $6::boolean THEN now() ELSE NULL END,
             CASE WHEN $6::boolean THEN $7::uuid ELSE NULL END,
             CASE WHEN $6::boolean THEN 'tos_drop' ELSE NULL END)
     ON CONFLICT (tenant_id, provider, environment) DO UPDATE SET
       provider_account_id = EXCLUDED.provider_account_id,
       provider_metadata = public.payment_provider_accounts.provider_metadata || EXCLUDED.provider_metadata,
       last_synced_at = now()
     RETURNING id, tenant_id, environment, provider_account_id, onboarding_status, verification_status,
               capabilities, tos_accepted_at, disabled, restricted, last_synced_at`,
    [
      ctx.tenantId, ctx.environment, accountId, tenant.name ?? null,
      JSON.stringify({ created_via: 'moov_onboarding', account_type: 'business' }),
      Boolean(tosToken), ctx.userId,
    ],
  )).rows[0];
  await client.query(
    `UPDATE public.payment_idempotency_keys SET status = 'completed'
     WHERE tenant_id = $1::uuid AND provider = 'moov' AND scope = 'account_create' AND idempotency_key = $2`,
    [ctx.tenantId, key],
  );
  await logPaymentEvent(client, {
    tenant_id: ctx.tenantId,
    environment: ctx.environment,
    event_type: 'payment_account.created',
    new_status: 'onboarding_incomplete',
    provider_metadata: { account_id: accountId, created_by: ctx.userId },
  });
  return { account: saved, created: true };
}

/**
 * Pushes profile + representatives + capability request. Never throws for a
 * Moov failure: returns { synced:false, error_code } after recording it.
 */
export async function syncOnboardingToMoov(client, ctx, {
  ssnByRepresentativeId = new Map(),
  outboxId = null,
  deps = {},
  fetchImpl,
} = {}) {
  const { tenantId, environment } = ctx;
  const profile = await loadProfile(client, tenantId, environment);
  if (!profile) return { synced: false, error_code: 'onboarding_profile_missing', skipped: true };
  const reps = await loadRepresentatives(client, tenantId, environment);
  const delivered = new Set();
  let accountId = null;
  // Which Moov call failed, for the redacted failure log.
  let step = 'account';
  try {
    const ein = await decryptProfileEin(deps, profile);
    const { account } = await ensureMoovAccount(client, ctx, { profile, ein, fetchImpl });
    accountId = account.provider_account_id;
    step = 'business_profile';
    await moovFetch(`/accounts/${accountId}`, {
      method: 'PATCH',
      scopes: scopes.accountWrite(accountId),
      body: { profile: { business: businessProfileBody(profile, ein) } },
      fetchImpl,
    });

    // People removed in ChecksOps are removed at Moov too; self-healing on retry.
    const removed = (await client.query(
      `SELECT id, moov_representative_id FROM public.moov_onboarding_representatives
       WHERE tenant_id = $1::uuid AND environment = $2
         AND removed_at IS NOT NULL AND moov_representative_id IS NOT NULL`,
      [tenantId, environment],
    )).rows;
    step = 'representative_remove';
    for (const gone of removed) {
      await moovFetch(`/accounts/${accountId}/representatives/${gone.moov_representative_id}`, {
        method: 'DELETE', scopes: scopes.representativesWrite(accountId), fetchImpl,
      }).catch((error) => {
        if (error instanceof MoovError && error.status === 404) return null;
        throw error;
      });
      await client.query(
        `UPDATE public.moov_onboarding_representatives
         SET moov_representative_id = NULL, moov_synced_at = now(), updated_at = now()
         WHERE id = $1::uuid`,
        [gone.id],
      );
    }

    step = 'representative';
    for (const rep of reps) {
      const ssn = ssnByRepresentativeId.get(rep.id) || null;
      if (!rep.moov_representative_id && !ssn) {
        // Cannot create a representative at Moov without the SSN, and the SSN is never stored.
        await markRepresentativeSsnResubmit(client, { id: rep.id, errorCode: 'ssn_resubmit_required' });
        continue;
      }
      const dob = await decryptRepresentativeDob(deps, rep);
      const body = representativeBody(rep, { dob, ssn });
      let moovRepId = rep.moov_representative_id;
      if (moovRepId) {
        await moovFetch(`/accounts/${accountId}/representatives/${moovRepId}`, {
          method: 'PATCH', scopes: scopes.representativesWrite(accountId), body, fetchImpl,
        });
      } else {
        const created = await moovFetch(`/accounts/${accountId}/representatives`, {
          method: 'POST',
          scopes: scopes.representativesWrite(accountId),
          idempotencyKey: `checksops-representative-${environment}-${rep.id}`,
          body,
          fetchImpl,
        });
        moovRepId = created?.representativeID ?? created?.representativeId ?? null;
        if (!moovRepId) throw new OnboardingError('moov_representative_id_missing', 502);
      }
      // Recorded immediately so a later failure never re-POSTs this person.
      await markRepresentativeSynced(client, { id: rep.id, moovRepresentativeId: moovRepId, ssnDelivered: Boolean(ssn) });
      if (ssn) delivered.add(rep.id);
    }

    if (reps.length > 0) {
      step = 'owners_provided';
      await moovFetch(`/accounts/${accountId}`, {
        method: 'PATCH',
        scopes: scopes.accountWrite(accountId),
        body: { profile: { business: { ownersProvided: true } } },
        fetchImpl,
      });
    }

    step = 'capabilities';
    await moovFetch(`/accounts/${accountId}/capabilities`, {
      method: 'POST',
      scopes: scopes.capabilitiesWrite(accountId),
      apiVersion: MOOV_CAPABILITIES_API_VERSION,
      body: { capabilities: [...MERCHANT_CAPABILITIES] },
      fetchImpl,
    });

    await client.query(
      `UPDATE public.payment_provider_accounts
       SET onboarding_status = CASE WHEN onboarding_status = 'active' THEN onboarding_status ELSE 'verification_pending' END,
           last_synced_at = now()
       WHERE tenant_id = $1::uuid AND provider = 'moov' AND environment = $2`,
      [tenantId, environment],
    );
    await setProfileSyncState(client, { tenantId, environment, pending: false, errorCode: null, moovAccountId: accountId });
    if (outboxId) await completeOutbox(client, { id: outboxId });
    await logPaymentEvent(client, {
      tenant_id: tenantId,
      environment,
      event_type: 'payment_account.onboarding_submitted',
      provider_metadata: { account_id: accountId, representatives: reps.length, by: ctx.userId },
    });
    return { synced: true, accountId };
  } catch (error) {
    if (!(error instanceof MoovError) && !(error instanceof OnboardingError) && !isNetworkError(error)) throw error;
    const code = error instanceof OnboardingError ? error.code : moovErrorCode(error);
    for (const rep of reps) {
      if (ssnByRepresentativeId.has(rep.id) && !delivered.has(rep.id)) {
        await markRepresentativeSsnResubmit(client, { id: rep.id, errorCode: code });
      }
    }
    await setProfileSyncState(client, { tenantId, environment, pending: true, errorCode: code, moovAccountId: accountId });
    if (outboxId) await failOutboxAttempt(client, { id: outboxId, errorCode: code });
    const rejectedFields = moovRejectedFields(error);
    onboardingLog('moov_onboarding_sync_failed', {
      tenant: tenantId, environment, error_code: code, status: error?.status ?? null,
      step, rejected_fields: rejectedFields,
    });
    return { synced: false, error_code: code, accountId, ...(rejectedFields.length ? { rejected_fields: rejectedFields } : {}) };
  }
}
