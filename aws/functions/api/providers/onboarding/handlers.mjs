/**
 * Moov onboarding handlers ("Compliance & Docs" + bank setup), written once and
 * parameterized by environment ('sandbox' | 'production') through one context.
 *
 * Every handler:
 *   - requires an explicit tenant_id the caller is a member of (or the platform owner),
 *   - submit = any member of THAT tenant or the platform owner (no role tiers),
 *   - takes the environment from the tenant's moov_environment and server config,
 *   - never returns or logs SSN, EIN (except moov-ein-reveal), DOB, account/routing numbers.
 */
import { evaluateReadiness } from '../readiness.mjs';
import { MoovError, capabilityFlags, moovFetch, moovToken, normalizeOnboardingStatus, safeLastFour, scopes, withMoovContext } from '../parity/moov-client.mjs';
import { MERCHANT_CAPABILITIES, MOOV_CAPABILITIES_API_VERSION, missingRequestedCapabilities } from '../parity/moov-capabilities.mjs';
import { fail, jsonResult } from '../parity/caller.mjs';
import { logPaymentEvent } from '../parity/db.mjs';
import { OnboardingError } from './crypto.mjs';
import {
  isUuid,
  loadOnboardingMoovContext,
  resolveOnboardingAccess,
  resolveOnboardingEnvironment,
} from './context.mjs';
import { createUploadUrl, finalizeDocument, viewUrl } from './documents.mjs';
import { loadSessionFundStepUp, loginSessionBinding, WALLET_FUND_TOTP_ACTION } from '../production/moov-fund-authz.mjs';
import { onboardingDeployment } from './flags.mjs';
import { ensureMoovAccount, syncOnboardingToMoov } from './moov-sync.mjs';
import { isNetworkError, moovErrorCode, moovRejectedFields, onboardingLog, redact, redactText } from './redact.mjs';
import { APP_USER_EMAIL_GUC, APP_USER_ID_GUC } from '../../cognito.mjs';
import {
  buildOnboardingView,
  decryptProfileEin,
  enqueueOutbox,
  loadAccount,
  loadDocument,
  loadDocuments,
  loadDueOutbox,
  lockTenantOnboarding,
  loadProfile,
  loadRepresentatives,
  maskLast4,
  publicRepresentative,
  removeRepresentative,
  upsertProfile,
  upsertRepresentative,
  validateBusiness,
  validateRepresentatives,
} from './store.mjs';

const ok = (body = {}) => jsonResult({ success: true, ...body });

/** Moov's message for a failed call, short, with email addresses and digit runs masked. */
export const moovFailureReason = (error, max = 160) => {
  let body = error?.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { /* plain text */ } }
  const text = typeof body === 'string' ? body
    : typeof body?.error === 'string' ? body.error
      : typeof body?.message === 'string' ? body.message : null;
  if (!text) return null;
  return redactText(text.replace(/[^\s@]+@[^\s@]+/g, '[redacted]'), max);
};

const errorResult = (error) => {
  if (error instanceof OnboardingError) {
    return fail(error.code, error.statusCode, { ...error.extra });
  }
  if (error instanceof MoovError) {
    const code = moovErrorCode(error);
    return fail(code, code === 'moov_rejected' ? 422 : 502, { liveProviderCalled: true });
  }
  return null;
};

// ------------------------------------------------------------ onboarding save

async function saveOnboarding(client, ctx, { business, representatives }, { deps, fetchImpl }) {
  const storedProfile = await loadProfile(client, ctx.tenantId, ctx.environment);
  const { fields, ein } = validateBusiness(business || {}, storedProfile);
  const storedReps = await loadRepresentatives(client, ctx.tenantId, ctx.environment);
  const reps = validateRepresentatives(representatives, new Map(storedReps.map((r) => [String(r.id), r])));

  // 1. ChecksOps first (same transaction): EIN encrypted, SSN last four only.
  const profile = await upsertProfile(client, deps, {
    tenantId: ctx.tenantId, environment: ctx.environment, fields, ein, userId: ctx.userId,
  });
  // Full SSNs stay in this request's memory, keyed by representative row id.
  const ssnByRepresentativeId = new Map();
  if (reps) {
    const kept = new Set();
    for (const rep of reps) {
      const saved = await upsertRepresentative(client, deps, {
        tenantId: ctx.tenantId, environment: ctx.environment, rep, userId: ctx.userId,
      });
      if (!saved) throw new OnboardingError('representative_not_saved', 409);
      kept.add(saved.id);
      if (rep.ssn) ssnByRepresentativeId.set(saved.id, rep.ssn);
    }
    for (const old of storedReps) {
      if (!kept.has(old.id)) await removeRepresentative(client, { tenantId: ctx.tenantId, environment: ctx.environment, id: old.id });
    }
  }
  const outbox = await enqueueOutbox(client, {
    tenantId: ctx.tenantId,
    environment: ctx.environment,
    kind: 'onboarding_sync',
    subjectId: profile.id,
    userId: ctx.userId,
    payload: { profile_id: profile.id },
  });

  // 2. Moov, idempotently, in the same request.
  const sync = await syncOnboardingToMoov(client, ctx, {
    ssnByRepresentativeId, outboxId: outbox.id, deps, fetchImpl,
  });
  ssnByRepresentativeId.clear();

  const view = await buildOnboardingView(client, ctx);
  if (sync.synced) {
    return { ...view, success: true, saved: true, moov_synced: true, pending: view.sync.pending, liveProviderCalled: true };
  }
  return {
    ...view,
    success: true,
    saved: true,
    moov_synced: false,
    pending: true,
    error_code: sync.error_code,
    ...(sync.rejected_fields ? { rejected_fields: sync.rejected_fields } : {}),
    liveProviderCalled: true,
  };
}

/**
 * Legacy camelCase bodies identify an existing person by its Moov
 * representative id (never by name). Anything else is a new person.
 */
const legacyRepresentatives = (list, storedReps) => {
  if (!Array.isArray(list)) return list;
  const byMoovId = new Map(storedReps.filter((r) => r.moov_representative_id).map((r) => [String(r.moov_representative_id), r.id]));
  return list.map((rep) => {
    if (rep?.id) return rep;
    const moovId = rep?.representativeID ?? rep?.representativeId ?? rep?.moov_representative_id ?? null;
    return { ...rep, id: moovId ? (byMoovId.get(String(moovId)) ?? undefined) : undefined };
  });
};

/**
 * Bank changes need the once-per-login financial step-up, bound to the same
 * login session as wallet.fund (one code per sign-in covers both).
 */
/**
 * Commits the current transaction (e.g. a reserved micro-deposit attempt) and
 * opens a new one with the same request identity, onboarding write setting
 * and per-tenant lock, so a later failure cannot roll the commit back.
 */
const commitAndContinue = async (client, ctx, mapping) => {
  await client.query('COMMIT');
  await client.query('BEGIN');
  await client.query('SET TRANSACTION READ WRITE');
  await client.query('SELECT set_config($1, $2, true)', [APP_USER_ID_GUC, mapping.application_user_id]);
  await client.query('SELECT set_config($1, $2, true)', [APP_USER_EMAIL_GUC, mapping.email || '']);
  await client.query("SELECT set_config('request.moov_onboarding', '1', true)");
  await lockTenantOnboarding(client, { tenantId: ctx.tenantId, environment: ctx.environment });
};

const requireBankStepUp = async (client, ctx, claims) => {
  const loginSession = loginSessionBinding(claims);
  const stepUp = await loadSessionFundStepUp(client, { userId: ctx.userId, tenantId: ctx.tenantId, loginSession });
  if (stepUp) return null;
  return fail('totp_required', 401, {
    actionKey: WALLET_FUND_TOTP_ACTION,
    message: 'Enter your two-factor code to change bank details.',
  });
};

// ------------------------------------------------------------ outbox retry + status pull

async function drainOutbox(client, ctx, { deps, fetchImpl }) {
  const pending = await loadDueOutbox(client, ctx.tenantId, ctx.environment);
  const results = [];
  for (const item of pending) {
    if (item.kind === 'onboarding_sync') {
      const sync = await syncOnboardingToMoov(client, ctx, { outboxId: item.id, deps, fetchImpl });
      results.push({ id: item.id, kind: item.kind, synced: sync.synced, error_code: sync.error_code ?? null });
    } else if (item.kind === 'document_upload') {
      const row = await loadDocument(client, ctx.tenantId, ctx.environment, item.subject_id);
      if (!row) {
        await client.query(
          `UPDATE public.moov_onboarding_outbox SET status = 'abandoned', last_error_code = 'document_missing', updated_at = now() WHERE id = $1::uuid`,
          [item.id],
        );
        results.push({ id: item.id, kind: item.kind, synced: false, error_code: 'document_missing' });
        continue;
      }
      try {
        const sent = await finalizeDocument(client, ctx, row, { deps, fetchImpl, outboxId: item.id });
        results.push({ id: item.id, kind: item.kind, synced: sent.moov_synced, error_code: sent.error_code ?? null });
      } catch (error) {
        if (!(error instanceof OnboardingError)) throw error;
        await client.query(
          `UPDATE public.moov_onboarding_outbox SET status = 'abandoned', attempts = attempts + 1, last_error_code = $2, updated_at = now() WHERE id = $1::uuid`,
          [item.id, error.code],
        );
        results.push({ id: item.id, kind: item.kind, synced: false, error_code: error.code });
      }
    }
  }
  return results;
}

async function pullMoovStatus(client, ctx, { fetchImpl }) {
  const account = await loadAccount(client, ctx.tenantId, ctx.environment);
  if (!account?.provider_account_id) return { status: 'not_started', liveProviderCalled: false };
  const accountId = account.provider_account_id;
  const remote = await moovFetch(`/accounts/${accountId}`, { scopes: scopes.accountRead(accountId), fetchImpl });
  const caps = await moovFetch(`/accounts/${accountId}/capabilities`, { scopes: scopes.capabilitiesRead(accountId), fetchImpl });
  const banks = await moovFetch(`/accounts/${accountId}/bank-accounts`, { scopes: scopes.bankAccountsRead(accountId), fetchImpl });
  const capList = (caps ?? []).map((c) => ({ capability: c.capability, status: c.status }));
  const verification = remote?.profile?.business?.verification?.status ?? remote?.verification?.status ?? null;
  const missing = missingRequestedCapabilities(caps ?? [], MERCHANT_CAPABILITIES);
  if (missing.length > 0 && String(verification || '').toLowerCase() !== 'failed') {
    await moovFetch(`/accounts/${accountId}/capabilities`, {
      method: 'POST',
      scopes: scopes.capabilitiesWrite(accountId),
      apiVersion: MOOV_CAPABILITIES_API_VERSION,
      body: { capabilities: missing },
      fetchImpl,
    });
  }
  const flags = capabilityFlags(caps ?? []);
  const onboarding = normalizeOnboardingStatus({ verificationStatus: verification, capabilities: caps ?? [], disabled: !!remote?.disabledOn });
  // Merge a small, PII-free summary; never overwrite provider_metadata wholesale.
  await client.query(
    `UPDATE public.payment_provider_accounts SET
       onboarding_status = $2, verification_status = COALESCE($3, verification_status), capabilities = $4::jsonb,
       can_send_payments = $5, can_receive_payments = $6, can_ach_credit = $7, can_ach_debit = $8,
       disabled = $9, last_synced_at = now(),
       provider_metadata = COALESCE(provider_metadata, '{}'::jsonb) || $10::jsonb
     WHERE id = $1::uuid AND environment = $11`,
    [
      account.id, onboarding, verification, JSON.stringify(capList),
      flags.can_send_payments, flags.can_receive_payments, flags.can_ach_credit, flags.can_ach_debit,
      Boolean(remote?.disabledOn),
      JSON.stringify({ last_sync: { verification_status: verification, capabilities: capList.length, banks: (banks ?? []).length, at: new Date().toISOString() } }),
      ctx.environment,
    ],
  );
  for (const bank of banks ?? []) {
    const bankId = bank?.bankAccountID ?? bank?.bankAccountId;
    if (!bankId) continue;
    const status = String(bank?.status ?? '').toLowerCase();
    await client.query(
      `UPDATE public.payment_provider_methods
       SET verification_status = CASE WHEN $3 = 'verified' THEN 'verified' ELSE verification_status END,
           connection_status = CASE WHEN $3 IN ('errored', 'unverified_failed') THEN 'failed' ELSE connection_status END,
           routing_last_four = COALESCE(routing_last_four, $4)
       WHERE tenant_id = $1::uuid AND provider = 'moov' AND environment = $5 AND provider_bank_account_id = $2`,
      [ctx.tenantId, bankId, status, safeLastFour(bank?.routingNumber), ctx.environment],
    );
  }
  return { status: onboarding, liveProviderCalled: true };
}

// ------------------------------------------------------------ handlers

const access = {
  read: 'read',
  submit: 'submit',
};

export const ONBOARDING_HANDLERS = {
  'moov-onboarding-get': {
    access: access.read,
    run: async ({ client, ctx }) => jsonResult({ success: true, ...(await buildOnboardingView(client, ctx)) }),
  },

  'moov-onboarding-save': {
    access: access.submit,
    moov: true,
    run: async ({ client, ctx, body, deps, fetchImpl }) => jsonResult(await saveOnboarding(client, ctx, {
      business: body.business, representatives: body.representatives,
    }, { deps, fetchImpl })),
  },

  'moov-account-onboard': {
    // Legacy name: thin alias of moov-onboarding-save (camelCase body accepted).
    access: access.submit,
    moov: true,
    run: async ({ client, ctx, body, deps, fetchImpl }) => {
      const storedReps = await loadRepresentatives(client, ctx.tenantId, ctx.environment);
      const result = await saveOnboarding(client, ctx, {
        business: body.business,
        representatives: legacyRepresentatives(body.representatives, storedReps),
      }, { deps, fetchImpl });
      return jsonResult({ ...result, representatives_added: result.representatives.length });
    },
  },

  'moov-ein-reveal': {
    access: access.submit,
    run: async ({ client, ctx, deps }) => {
      // Owner decision (2026-10-17): members of this tenant only. The platform
      // owner may submit Compliance & Docs on a tenant's behalf, but it does not
      // see the EIN or accept the Moov terms unless it is itself a member.
      if (ctx.member !== true) return fail('tenant_member_required', 403, { message: 'Only a member of this organization can do this.' });
      const profile = await loadProfile(client, ctx.tenantId, ctx.environment);
      if (!profile?.ein_ciphertext) return fail('ein_not_on_file', 404);
      const ein = await decryptProfileEin(deps, profile);
      // Audit is mandatory: if it cannot be written, the EIN is not returned.
      await client.query(
        `INSERT INTO public.payment_event_log (provider, environment, tenant_id, event_type, provider_metadata)
         VALUES ('moov', $1, $2::uuid, 'onboarding.ein_revealed', $3::jsonb)`,
        [ctx.environment, ctx.tenantId, JSON.stringify({
          by: ctx.userId, member: ctx.member, platform_owner: ctx.platformOwner, ein_last4: profile.ein_last4,
        })],
      );
      return jsonResult({ success: true, ein, ein_masked: maskLast4(profile.ein_last4) });
    },
  },

  'moov-document-upload-url': {
    access: access.submit,
    run: async ({ client, ctx, body, deps }) => jsonResult({ success: true, ...(await createUploadUrl(client, ctx, body, deps)) }),
  },

  'moov-document-finalize': {
    access: access.submit,
    moov: true,
    run: async ({ client, ctx, body, deps, fetchImpl }) => {
      if (!isUuid(body.document_id)) return fail('invalid_uuid', 400, { field: 'document_id' });
      const row = await loadDocument(client, ctx.tenantId, ctx.environment, body.document_id);
      if (!row || row.status === 'rejected') return fail('document_not_found', 404);
      const result = await finalizeDocument(client, ctx, row, { deps, fetchImpl });
      return jsonResult({ success: true, ...result, liveProviderCalled: true });
    },
  },

  'moov-document-view': {
    access: access.read,
    run: async ({ client, ctx, body, deps }) => {
      const id = body.document_id ?? body.file_id;
      if (!isUuid(id)) return fail('invalid_uuid', 400, { field: 'document_id' });
      const row = await loadDocument(client, ctx.tenantId, ctx.environment, id);
      if (!row) return fail('document_not_found', 404);
      return jsonResult({ success: true, document_id: row.id, ...(await viewUrl(row, deps)) });
    },
  },

  'moov-account-file-view': {
    // Legacy name: thin alias of moov-document-view (file_id = document_id).
    access: access.read,
    run: async (args) => ONBOARDING_HANDLERS['moov-document-view'].run(args),
  },

  'moov-account-file-upload': {
    access: access.read,
    run: async () => fail('use_moov_document_upload_url', 410, {
      message: 'Upload compliance documents with moov-document-upload-url, PUT the file to the returned URL, then call moov-document-finalize.',
      replacement: ['moov-document-upload-url', 'moov-document-finalize'],
    }),
  },

  'moov-account-files': {
    access: access.read,
    run: async ({ client, ctx }) => {
      const [account, docs, reps] = [
        await loadAccount(client, ctx.tenantId, ctx.environment),
        await loadDocuments(client, ctx.tenantId, ctx.environment),
        await loadRepresentatives(client, ctx.tenantId, ctx.environment),
      ];
      return ok({
        account_connected: Boolean(account?.provider_account_id),
        representatives: reps.map(publicRepresentative),
        files: docs.map((d) => ({
          id: d.id,
          file_name: d.file_name,
          file_purpose: d.purpose,
          mime_type: d.content_type,
          file_size_bytes: d.size_bytes === null ? null : Number(d.size_bytes),
          requirement_id: null,
          provider_file_id: d.moov_file_id ?? null,
          provider_representative_id: null,
          review_status: d.moov_status ?? (d.status === 'sent' ? 'pending' : d.status),
          review_reason: null,
          created_at: d.created_at,
          last_synced_at: d.sent_at ?? null,
          storage_path: null,
        })),
        liveProviderCalled: false,
      });
    },
  },

  'moov-account-create': {
    access: access.submit,
    moov: true,
    run: async ({ client, ctx, body, fetchImpl }) => {
      // Accepting the Moov terms is the tenant members' own: a token sent by a
      // non-member (the platform owner acting on the tenant's behalf) is dropped.
      const tosToken = ctx.member === true
        && typeof body.terms_of_service_token === 'string' && body.terms_of_service_token.length >= 8
        ? body.terms_of_service_token
        : null;
      const { account, created } = await ensureMoovAccount(client, ctx, { tosToken, fetchImpl });
      return ok({ already_existed: !created, account, liveProviderCalled: created });
    },
  },

  'moov-bank-account-add': {
    access: access.submit,
    moov: true,
    run: async ({ client, ctx, body, claims, fetchImpl }) => {
      const stepUp = await requireBankStepUp(client, ctx, claims);
      if (stepUp) return stepUp;
      const holderName = String(body?.holder_name ?? '').trim();
      const holderType = body?.holder_type === 'individual' ? 'individual' : 'business';
      const bankAccountType = body?.bank_account_type === 'savings' ? 'savings' : 'checking';
      const routingNumber = String(body?.routing_number ?? '').replace(/\D/g, '');
      const accountNumber = String(body?.account_number ?? '').replace(/\D/g, '');
      if (holderName.length < 2 || holderName.length > 128) return fail('Enter the account holder name as it appears at the bank.', 400, { field: 'holder_name' });
      if (routingNumber.length !== 9) return fail('Routing number must be exactly 9 digits.', 400, { field: 'routing_number' });
      if (accountNumber.length < 4 || accountNumber.length > 17) return fail('Account number must be between 4 and 17 digits.', 400, { field: 'account_number' });
      const account = await loadAccount(client, ctx.tenantId, ctx.environment);
      const accountId = account?.provider_account_id;
      if (!accountId) return fail('Set up the payment account first.', 409, { error_code: 'moov_account_missing' });
      const created = await moovFetch(`/accounts/${accountId}/bank-accounts`, {
        method: 'POST',
        scopes: scopes.bankAccountsWrite(accountId),
        fetchImpl,
        body: { account: { holderName, holderType, accountNumber, routingNumber, bankAccountType } },
      });
      const bankAccountId = created?.bankAccountID ?? created?.bankAccountId ?? null;
      if (!bankAccountId) return fail('moov_bank_account_id_missing', 502);
      const lastFour = created?.lastFourAccountNumber ?? safeLastFour(accountNumber);
      const routingLastFour = routingNumber.slice(-4);
      const status = String(created?.status ?? 'new').toLowerCase();
      const method = (await client.query(
        `INSERT INTO public.payment_provider_methods
          (tenant_id, provider, environment, provider_account_id, provider_bank_account_id,
           bank_name, account_type, last_four, routing_last_four, holder_name, verification_status, connection_status,
           can_send, can_receive, is_default, connected_at, provider_metadata)
         VALUES ($1::uuid, 'moov', $2, $3, $4, $5, $6, $7, $8, $9, $10, 'connected', true, true, true, now(), $11::jsonb)
         ON CONFLICT (provider, environment, provider_bank_account_id) DO UPDATE SET
           bank_name = EXCLUDED.bank_name, last_four = EXCLUDED.last_four, routing_last_four = EXCLUDED.routing_last_four,
           verification_status = EXCLUDED.verification_status, connection_status = 'connected', connected_at = now()
         RETURNING id`,
        [
          ctx.tenantId, ctx.environment, accountId, bankAccountId, created?.bankName ?? null, bankAccountType,
          lastFour, routingLastFour, holderName, status === 'verified' ? 'verified' : 'pending',
          JSON.stringify({ status, source: 'manual_entry' }),
        ],
      )).rows[0];
      await client.query(
        'UPDATE public.payment_provider_accounts SET last_synced_at = now() WHERE id = $1::uuid',
        [account.id],
      );
      await logPaymentEvent(client, {
        tenant_id: ctx.tenantId, environment: ctx.environment, event_type: 'bank_account.connected', new_status: status,
        provider_metadata: { last_four: lastFour, source: 'manual_entry', by: ctx.userId },
      });
      return ok({
        payment_method_id: method?.id ?? null,
        bank_account_id: bankAccountId,
        bank_name: created?.bankName ?? null,
        last_four: lastFour,
        routing_masked: maskLast4(routingLastFour),
        status,
        liveProviderCalled: true,
      });
    },
  },

  'moov-bank-link-token': {
    access: access.submit,
    moov: true,
    run: async ({ client, ctx, claims, fetchImpl }) => {
      // Links a bank through Moov Drops: same step-up as any bank change.
      const stepUp = await requireBankStepUp(client, ctx, claims);
      if (stepUp) return stepUp;
      const account = await loadAccount(client, ctx.tenantId, ctx.environment);
      if (!account?.provider_account_id) return fail('Set up the payment account first.', 409);
      const token = await moovToken(scopes.dropBankLink(account.provider_account_id), undefined, fetchImpl);
      return ok({ account_id: account.provider_account_id, token, public_key: null, liveProviderCalled: true });
    },
  },

  'moov-micro-deposit-initiate': {
    access: access.submit,
    moov: true,
    run: async ({ client, ctx, body, claims, fetchImpl }) => {
      const stepUp = await requireBankStepUp(client, ctx, claims);
      if (stepUp) return stepUp;
      const params = [ctx.tenantId, ctx.environment];
      let sql = `SELECT * FROM public.payment_provider_methods
        WHERE tenant_id = $1::uuid AND provider = 'moov' AND environment = $2
          AND external_recipient_id IS NULL AND connection_status <> 'disconnected'`;
      if (body.payment_method_id) {
        if (!isUuid(body.payment_method_id)) return fail('invalid_uuid', 400, { field: 'payment_method_id' });
        params.push(body.payment_method_id);
        sql += ` AND id = $${params.length}::uuid`;
      }
      sql += ' ORDER BY created_at DESC NULLS LAST LIMIT 1';
      const method = (await client.query(sql, params)).rows[0];
      if (!method) return fail('Bank account not found.', 404);
      const accountId = method.provider_account_id;
      const bankAccountId = method.provider_bank_account_id;
      if (!accountId || !bankAccountId) return fail('This bank account is not ready for verification yet.', 409);
      const bank = await moovFetch(`/accounts/${accountId}/bank-accounts/${bankAccountId}`, {
        scopes: scopes.bankAccountsRead(accountId), fetchImpl,
      });
      if (String(bank?.status ?? '').toLowerCase() === 'verified') {
        await client.query(
          `UPDATE public.payment_provider_methods SET verification_status = 'verified', connection_status = 'connected' WHERE id = $1::uuid`,
          [method.id],
        );
        return ok({ already_verified: true, liveProviderCalled: true });
      }
      await moovFetch(`/accounts/${accountId}/bank-accounts/${bankAccountId}/verify`, {
        method: 'POST', scopes: scopes.bankAccountsWrite(accountId), fetchImpl,
      });
      const verification = (await client.query(
        `INSERT INTO public.payment_method_verifications
          (tenant_id, payment_method_id, provider, environment, provider_account_id, provider_bank_account_id,
           method, status, attempts, initiated_by)
         VALUES ($1::uuid, $2::uuid, 'moov', $3, $4, $5, 'micro_deposit', 'pending', 0, $6::uuid)
         RETURNING id, status, attempts, created_at`,
        [ctx.tenantId, method.id, ctx.environment, accountId, bankAccountId, ctx.userId],
      )).rows[0];
      await client.query(
        `UPDATE public.payment_provider_methods SET verification_status = 'pending_micro_deposit' WHERE id = $1::uuid`,
        [method.id],
      );
      await logPaymentEvent(client, {
        tenant_id: ctx.tenantId, environment: ctx.environment,
        event_type: 'bank_account.micro_deposit.initiated', new_status: 'pending',
      });
      return ok({ verification, liveProviderCalled: true });
    },
  },

  'moov-micro-deposit-confirm': {
    access: access.submit,
    moov: true,
    run: async ({ client, ctx, body, claims, mapping, fetchImpl }) => {
      const stepUp = await requireBankStepUp(client, ctx, claims);
      if (stepUp) return stepUp;
      const { code } = body ?? {};
      const byVerification = isUuid(body?.verification_id);
      if (!byVerification && !isUuid(body?.payment_method_id)) {
        return fail('verification_id or payment_method_id is required', 400, { field: 'payment_method_id' });
      }
      if (typeof code !== 'string' || !/^\d{4}$/.test(code)) return fail('Enter the 4-digit verification code.', 400, { field: 'code' });
      // Either that verification row, or the latest open one for this tenant's
      // bank (banks[].id = payment_provider_methods id).
      const verification = (await client.query(
        byVerification
          ? `SELECT * FROM public.payment_method_verifications
             WHERE id = $1::uuid AND tenant_id = $2::uuid AND environment = $3
             FOR UPDATE`
          : `SELECT * FROM public.payment_method_verifications
             WHERE payment_method_id = $1::uuid AND tenant_id = $2::uuid AND environment = $3
               AND status = 'pending'
             ORDER BY created_at DESC NULLS LAST LIMIT 1
             FOR UPDATE`,
        [byVerification ? body.verification_id : body.payment_method_id, ctx.tenantId, ctx.environment],
      )).rows[0];
      if (!verification) return fail('Verification not found.', 404);
      const verificationId = verification.id;
      const markVerified = async (attempts) => {
        await client.query(
          `UPDATE public.payment_method_verifications SET status = 'verified', verified_at = now(), attempts = $2, failure_reason = NULL WHERE id = $1::uuid`,
          [verificationId, attempts],
        );
        if (verification.payment_method_id) {
          await client.query(
            `UPDATE public.payment_provider_methods SET verification_status = 'verified', connection_status = 'connected' WHERE id = $1::uuid`,
            [verification.payment_method_id],
          );
        }
      };
      const acct = verification.provider_account_id;
      const bankId = verification.provider_bank_account_id;
      const bank = await moovFetch(`/accounts/${acct}/bank-accounts/${bankId}`, { scopes: scopes.bankAccountsRead(acct), fetchImpl });
      if (String(bank?.status ?? '').toLowerCase() === 'verified') {
        await markVerified(verification.attempts);
        return ok({ already_verified: true, liveProviderCalled: true });
      }
      const maxAttempts = verification.max_attempts ?? 3;
      // Reserve the attempt atomically (row locked above) before calling Moov.
      const reserved = (await client.query(
        `UPDATE public.payment_method_verifications SET attempts = attempts + 1
         WHERE id = $1::uuid AND attempts < COALESCE(max_attempts, 3)
         RETURNING attempts`,
        [verificationId],
      )).rows[0];
      if (!reserved) {
        return fail('max_attempts_exceeded', 409, { requires_restart: true });
      }
      const attempts = Number(reserved.attempts);
      // The reserved attempt is committed before Moov is called, so it counts
      // even if the request later fails (network error, unknown error, crash).
      await commitAndContinue(client, ctx, mapping);
      try {
        await moovFetch(`/accounts/${acct}/bank-accounts/${bankId}/verify`, {
          method: 'PUT', scopes: scopes.bankAccountsWrite(acct), body: { code }, fetchImpl,
        });
      } catch (error) {
        const errorCode = error instanceof MoovError ? moovErrorCode(error) : (isNetworkError(error) ? 'moov_unreachable' : 'moov_failed');
        if (!(error instanceof MoovError)) {
          onboardingLog('moov_micro_deposit_confirm_failed', { tenant: ctx.tenantId, environment: ctx.environment, error_code: errorCode });
          await client.query(
            'UPDATE public.payment_method_verifications SET failure_reason = $2 WHERE id = $1::uuid',
            [verificationId, errorCode],
          );
          return jsonResult({ success: false, verified: false, error_code: errorCode, attempts, requires_restart: attempts >= maxAttempts, liveProviderCalled: true });
        }
        await client.query(
          `UPDATE public.payment_method_verifications SET failure_reason = $2,
             status = CASE WHEN attempts >= COALESCE(max_attempts, 3) THEN 'max_attempts_exceeded' ELSE status END
           WHERE id = $1::uuid`,
          [verificationId, errorCode],
        );
        // Recorded attempt must persist, so this is an ok:false-free result.
        return jsonResult({ success: false, verified: false, error_code: 'invalid_code', attempts, requires_restart: attempts >= maxAttempts, liveProviderCalled: true });
      }
      await markVerified(attempts);
      await logPaymentEvent(client, {
        tenant_id: ctx.tenantId, environment: ctx.environment,
        event_type: 'bank_account.micro_deposit.verified', new_status: 'verified',
      });
      return ok({ verified: true, liveProviderCalled: true });
    },
  },

  'moov-tos-token': {
    // The server accepts the Moov terms itself (moov-tos-accept with accepted:true
    // mints the terms token with the caller's IP and user agent), so no Moov
    // access token (profile.write) is ever handed to the browser.
    access: access.submit,
    run: async ({ client, ctx }) => {
      // Owner decision (2026-10-17): members of this tenant only. The platform
      // owner may submit Compliance & Docs on a tenant's behalf, but it does not
      // see the EIN or accept the Moov terms unless it is itself a member.
      if (ctx.member !== true) return fail('tenant_member_required', 403, { message: 'Only a member of this organization can do this.' });
      const account = await loadAccount(client, ctx.tenantId, ctx.environment);
      return ok({
        token: null,
        public_key: null,
        account_id: account?.provider_account_id ?? null,
        server_accept: true,
        accept_with: 'moov-tos-accept',
        message: 'Call moov-tos-accept with { accepted: true }; the server records the acceptance with Moov.',
        liveProviderCalled: false,
      });
    },
  },

  'moov-tos-accept': {
    access: access.submit,
    moov: true,
    run: async ({ client, ctx, body, event, fetchImpl }) => {
      // Owner decision (2026-10-17): members of this tenant only. The platform
      // owner may submit Compliance & Docs on a tenant's behalf, but it does not
      // see the EIN or accept the Moov terms unless it is itself a member.
      if (ctx.member !== true) return fail('tenant_member_required', 403, { message: 'Only a member of this organization can do this.' });
      const clientToken = typeof body.terms_of_service_token === 'string' && body.terms_of_service_token.length >= 8
        ? body.terms_of_service_token
        : null;
      if (!clientToken && body.accepted !== true) return fail('Terms must be explicitly accepted.', 400);
      const account = await loadAccount(client, ctx.tenantId, ctx.environment);
      if (!account?.provider_account_id) return fail('Set up the payment account first.', 409);
      if (account.tos_accepted_at) return ok({ already_accepted: true, accepted_at: account.tos_accepted_at });
      const accountId = account.provider_account_id;
      const lower = Object.fromEntries(Object.entries(event?.headers || {}).map(([k, v]) => [String(k).toLowerCase(), v]));
      const ip = String(lower['x-forwarded-for'] || '').split(',')[0].trim() || lower['x-real-ip'] || '';
      const extraHeaders = { ...(ip ? { 'X-Forwarded-For': ip, 'X-Real-IP': ip } : {}), 'User-Agent': lower['user-agent'] || 'unknown' };
      let token = clientToken;
      if (!token) {
        const minted = await moovFetch('/tos-token', { scopes: ['/ping.read'], extraHeaders, fetchImpl });
        token = minted?.token ?? minted?.tosToken ?? null;
      }
      if (!token) return fail('tos_token_unavailable', 502);
      try {
        await moovFetch(`/accounts/${accountId}`, {
          method: 'PATCH', scopes: scopes.accountWrite(accountId), body: { termsOfService: { token } }, extraHeaders, fetchImpl,
        });
      } catch (error) {
        if (!(error instanceof MoovError && /already\s+(been\s+)?accept|terms.*already/i.test(String(error.message)))) throw error;
      }
      const acceptedAt = new Date().toISOString();
      await client.query(
        `UPDATE public.payment_provider_accounts
         SET tos_accepted_at = $2::timestamptz, tos_accepted_by = $3::uuid, tos_source = 'tos_drop'
         WHERE id = $1::uuid`,
        [account.id, acceptedAt, ctx.userId],
      );
      await logPaymentEvent(client, {
        tenant_id: ctx.tenantId, environment: ctx.environment, event_type: 'payment_account.terms_accepted',
        provider_metadata: { account_id: accountId },
      });
      return ok({ accepted_at: acceptedAt, liveProviderCalled: true });
    },
  },

  'moov-underwriting': {
    access: (body) => (String(body?.action ?? '').toLowerCase() === 'save' ? access.submit : access.read),
    moov: true,
    run: async ({ client, ctx, body, fetchImpl }) => {
      const account = await loadAccount(client, ctx.tenantId, ctx.environment);
      if (!account?.provider_account_id) return fail('Set up your payment account first.', 409);
      const id = account.provider_account_id;
      if (String(body.action ?? '').toLowerCase() === 'save') {
        if (!body.answers || typeof body.answers !== 'object') return fail('answers are required', 400, { field: 'answers' });
        let saved;
        try {
          saved = await moovFetch(`/accounts/${id}/underwriting`, {
            method: 'PUT', scopes: scopes.accountWrite(id), body: body.answers, fetchImpl,
          });
        } catch (error) {
          if (error instanceof MoovError) {
            onboardingLog('moov_underwriting_failed', {
              tenant: ctx.tenantId, environment: ctx.environment, error_code: moovErrorCode(error),
              status: error.status ?? null, reason: moovFailureReason(error), rejected_fields: moovRejectedFields(error),
            });
          }
          throw error;
        }
        await logPaymentEvent(client, {
          tenant_id: ctx.tenantId, environment: ctx.environment, event_type: 'payment_account.underwriting_saved',
          provider_metadata: { account_id: id, by: ctx.userId },
        });
        return ok({ underwriting: redact(saved), liveProviderCalled: true });
      }
      const data = await moovFetch(`/accounts/${id}/underwriting`, { scopes: scopes.accountRead(id), fetchImpl });
      return ok({ underwriting: redact(data), liveProviderCalled: true });
    },
  },

  'moov-sync': {
    // Retries the outbox (everything except SSNs), then pulls status from Moov.
    access: access.submit,
    moov: true,
    run: async ({ client, ctx, deps, fetchImpl }) => {
      const retried = await drainOutbox(client, ctx, { deps, fetchImpl });
      let pulled = { status: null, liveProviderCalled: false };
      let pullError = null;
      try {
        pulled = await pullMoovStatus(client, ctx, { fetchImpl });
      } catch (error) {
        if (!(error instanceof MoovError) && !isNetworkError(error)) throw error;
        pullError = moovErrorCode(error);
        onboardingLog('moov_onboarding_status_pull_failed', { tenant: ctx.tenantId, environment: ctx.environment, error_code: pullError });
      }
      const view = await buildOnboardingView(client, ctx);
      return ok({
        ...view,
        status: pulled.status ?? view.account.status,
        retried,
        pending: view.sync.pending,
        ...(pullError ? { error_code: pullError } : {}),
        liveProviderCalled: pulled.liveProviderCalled || retried.length > 0,
      });
    },
  },

  'moov-readiness': {
    access: access.read,
    moov: true,
    run: async ({ client, ctx, fetchImpl }) => {
      const account = await loadAccount(client, ctx.tenantId, ctx.environment);
      const accountId = account?.provider_account_id || null;
      if (!accountId) {
        return ok({
          readiness: evaluateReadiness({ environment: ctx.environment, accountId: null, capabilities: [], banks: [], termsAccepted: false }),
          liveProviderCalled: false,
        });
      }
      const remote = await moovFetch(`/accounts/${accountId}`, { scopes: scopes.accountRead(accountId), fetchImpl });
      const caps = await moovFetch(`/accounts/${accountId}/capabilities`, { scopes: scopes.capabilitiesRead(accountId), fetchImpl });
      const banks = await moovFetch(`/accounts/${accountId}/bank-accounts`, { scopes: scopes.bankAccountsRead(accountId), fetchImpl });
      const remoteTos = remote?.termsOfService?.acceptedOn ?? remote?.termsOfService?.acceptedDate ?? null;
      const result = evaluateReadiness({
        environment: ctx.environment,
        accountId,
        capabilities: (caps ?? []).map((c) => ({ capability: c.capability, status: c.status, requirements: c.requirements ?? null })),
        banks: (banks ?? []).map((b) => ({ status: b.status })),
        verificationStatus: remote?.profile?.business?.verification?.status ?? remote?.verification?.status ?? null,
        disabled: !!remote?.disabledOn,
        termsAccepted: !!(account?.tos_accepted_at || remoteTos),
        feePlanUnavailable: true,
      });
      result.source = 'live_provider';
      // Read-only: readiness is computed for the caller, never written.
      return ok({ readiness: result, liveProviderCalled: true });
    },
  },
};

export const ONBOARDING_FUNCTION_NAMES = Object.freeze(Object.keys(ONBOARDING_HANDLERS));
export const NEW_ONBOARDING_FUNCTION_NAMES = Object.freeze([
  'moov-onboarding-get',
  'moov-onboarding-save',
  'moov-ein-reveal',
  'moov-document-upload-url',
  'moov-document-finalize',
  'moov-document-view',
]);
export const isOnboardingFunction = (name) => Object.prototype.hasOwnProperty.call(ONBOARDING_HANDLERS, name);

/**
 * Entry point used by providers.mjs. The caller already decided the deployment
 * gate (sandbox execution, or production + AWS_MOOV_ONBOARDING_PRODUCTION_ENABLED).
 */
export async function handleMoovOnboarding(name, event, deps = {}) {
  const spec = ONBOARDING_HANDLERS[name];
  if (!spec) return null;
  const { withIdentityWrite } = await import('../../data.mjs');
  return withIdentityWrite(event, async ({ client, mapping, claims, body, spoof }) => {
    const base = { spoofFieldsIgnored: spoof, applicationUserId: mapping.application_user_id };
    const deployment = onboardingDeployment();
    if (!deployment) return { ...fail('provider_disabled', 403, { provider: 'moov' }), ...base };
    const wanted = typeof spec.access === 'function' ? spec.access(body) : spec.access;
    const who = await resolveOnboardingAccess(client, { userId: mapping.application_user_id, body, access: wanted });
    if (who.error) return { ...who, ...base };
    const env = await resolveOnboardingEnvironment(client, who.tenantId, deployment);
    if (env.error) return { ...env, ...base };
    if (wanted === 'submit' && who.canSubmit) {
      // Write handlers only: lets SQL 91 write policies accept this request's
      // onboarding writes, and serializes them per tenant + environment.
      await client.query("SELECT set_config('request.moov_onboarding', '1', true)");
      await lockTenantOnboarding(client, { tenantId: who.tenantId, environment: env.environment });
    }
    const ctx = {
      tenantId: who.tenantId,
      environment: env.environment,
      member: who.member,
      platformOwner: who.platformOwner,
      canSubmit: who.canSubmit,
      userId: mapping.application_user_id,
    };
    const fetchImpl = deps.fetchImpl || fetch;
    const args = { client, mapping, claims, body, spoof, ctx, deps, fetchImpl, event };
    try {
      let result;
      if (spec.moov) {
        const moovContext = await loadOnboardingMoovContext(ctx.environment, deps);
        if (moovContext.error) return { ...moovContext, ...base, environment: ctx.environment };
        result = await withMoovContext({ ...moovContext, fetchImpl }, () => spec.run(args));
      } else {
        result = await spec.run(args);
      }
      return {
        ...result,
        ...base,
        authUid: mapping.application_user_id,
        cognitoSub: claims.sub,
        environment: ctx.environment,
        productionExecution: ctx.environment === 'production',
      };
    } catch (error) {
      const mapped = errorResult(error);
      if (mapped) return { ...mapped, ...base, environment: ctx.environment };
      if (isNetworkError(error)) {
        return { ...fail('moov_unreachable', 502), ...base, environment: ctx.environment };
      }
      onboardingLog('moov_onboarding_handler_failed', { fn: name, tenant: ctx.tenantId, environment: ctx.environment, error: error?.code || error?.name || 'error' });
      throw error;
    }
  }, deps);
}
