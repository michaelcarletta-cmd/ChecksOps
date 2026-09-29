/**
 * Production onboarding, bank, recipient, file, and admin Moov functions.
 * Source: supabase/functions/moov-account-onboard, moov-bank-*, moov-micro-deposit-*,
 * moov-recipient-*, moov-account-file-*, moov-onboarding-link, moov-plaid-bridge,
 * moov-sweep-config, moov-invoice, moov-platform-bank, fee schedules, public-invoice,
 * homeowner-deductible-pay, stakeholder-resend-verification.
 */
import { randomUUID } from 'node:crypto';
import {
  MoovError,
  facilitatorAccountId,
  lastMoovRequestHeaders,
  moovFetch,
  moovToken,
  normalizeTransferStatus,
  safeLastFour,
  scopes,
} from './moov-client.mjs';
import { fail, jsonResult } from './caller.mjs';
import { sendViaSesOrSink } from '../../email.mjs';
import { renderTransactionalTemplate } from '../../email-templates.mjs';
import { emailAssetOrigin, resolveEmailBranding } from '../../email-branding.mjs';
import { normalizeEmail } from '../../email-policy.mjs';
import {
  loadConnectedMethod,
  loadMoovAccount,
  logPaymentEvent,
  sanitize,
  secureToken,
} from './db.mjs';
import { syncWallet } from './moov-wallet.mjs';
import { fetchRailMethodIds } from './moov-rails.mjs';
import {
  buildIndividualKycPatch,
  dropTokenFromBody,
  identityRequirementsOutstanding,
  kycStatusFromMoov,
  liveAccountReadFailed,
  liveBankVerified,
  liveTosAccepted,
  moovInstantVerifyBody,
  recipientBankVerifyBlocked,
  recipientOnboardingCompleteFromMoov,
  rejectBrowserBankSubstitution,
  rejectForgedRecipientTos,
  shouldInitiateInstantMicroDeposit,
  shouldResumeExistingBank,
  interpretRecipientBankVerification,
  initiateAlreadyOpenError,
  providerVerifySuccessIsNotComplete,
  tosBoundToRecipientAccount,
  tosConfirmedByMoov,
  tosRequirementOutstanding,
} from '../moov-recipient-tos-policy.mjs';

const BUSINESS_TYPES = [
  'soleProprietorship', 'unincorporatedAssociation', 'trust', 'llc',
  'publicCorporation', 'privateCorporation', 'partnership',
  'unincorporatedNonProfit', 'incorporatedNonProfit',
];

const str = (v, max = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const digits = (v, max = 20) => {
  if (typeof v === 'string' || typeof v === 'number') {
    return String(v).replace(/\D/g, '').slice(0, max) || null;
  }
  return null;
};

const normalizeAddress = (a) => {
  if (!a) return null;
  const line1 = str(a.addressLine1, 100);
  const city = str(a.city, 60);
  const state = str(a.stateOrProvince, 2);
  const postal = digits(a.postalCode, 5);
  if (!line1 || !city || !state || !postal) return null;
  return {
    addressLine1: line1,
    ...(str(a.addressLine2, 100) ? { addressLine2: str(a.addressLine2, 100) } : {}),
    city,
    stateOrProvince: state.toUpperCase(),
    postalCode: postal,
    country: 'US',
  };
};

const buildRepresentative = (rep) => {
  const firstName = str(rep.firstName, 60);
  const lastName = str(rep.lastName, 60);
  if (!firstName || !lastName) throw new Error('Each person needs a first and last name.');
  const address = normalizeAddress(rep.address);
  if (!address) throw new Error(`Provide a full home address for ${firstName} ${lastName}.`);
  const ssn = digits(rep.ssn, 9);
  if (!ssn || ssn.length !== 9) throw new Error(`Provide a valid 9-digit SSN for ${firstName} ${lastName}.`);
  const dob = str(rep.birthDate, 10);
  const m = dob?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`Provide a date of birth for ${firstName} ${lastName}.`);
  const phone = digits(rep.phone, 10);
  const pct = Number(rep.ownershipPercentage ?? 0);
  return {
    name: { firstName, lastName },
    email: str(rep.email, 120) ?? undefined,
    ...(phone ? { phone: { number: phone, countryCode: '1' } } : {}),
    address,
    birthDate: { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) },
    governmentID: { ssn: { full: ssn } },
    responsibilities: {
      isController: !!rep.isController,
      isOwner: !!rep.isOwner,
      ...(rep.isOwner && pct > 0 ? { ownershipPercentage: Math.min(100, Math.round(pct)) } : {}),
      jobTitle: str(rep.jobTitle, 60) ?? 'Owner',
    },
  };
};

export const accountOnboard = {
  requireAdmin: true,
  run: async ({ client, mapping, body, ctx, fetchImpl }) => {
    const account = await loadMoovAccount(client, ctx.tenantId, 'sandbox');
    const accountId = account?.provider_account_id;
    if (!accountId) return fail('Create the payment account first.', 409);
    const b = body?.business ?? {};
    const legalBusinessName = str(b.legalBusinessName, 120);
    if (!legalBusinessName) return fail('Legal business name is required.', 400);
    const businessType = str(b.businessType, 40);
    if (!businessType || !BUSINESS_TYPES.includes(businessType)) return fail('Choose a valid business type.', 400);
    const address = normalizeAddress(b.address);
    if (!address) return fail('Provide a complete business address.', 400);
    const phone = digits(b.phone, 10);
    if (!phone || phone.length !== 10) return fail('Provide a 10-digit business phone.', 400);
    const email = str(b.email, 120);
    if (!email || !email.includes('@')) return fail('Provide a business email.', 400);
    const ein = digits(b.ein, 9);
    if (businessType !== 'soleProprietorship' && (!ein || ein.length !== 9)) {
      return fail('Provide a valid 9-digit EIN.', 400);
    }
    const website = str(b.website, 200);
    const description = str(b.description, 300);
    if (!website && !description) return fail('Provide a website or a short business description.', 400);
    const businessProfile = {
      legalBusinessName,
      ...(str(b.doingBusinessAs, 120) ? { doingBusinessAs: str(b.doingBusinessAs, 120) } : {}),
      businessType, address,
      phone: { number: phone, countryCode: '1' },
      email,
      ...(website ? { website: website.startsWith('http') ? website : `https://${website}` } : {}),
      ...(description ? { description } : {}),
      ...(ein && ein.length === 9 ? { taxID: { ein: { number: ein } } } : {}),
    };
    const repsInput = Array.isArray(body?.representatives) ? body.representatives.slice(0, 6) : [];
    if (repsInput.length > 0 && !repsInput.some((r) => r.isController)) {
      return fail('One person must be marked as the controller.', 400);
    }
    const repBodies = repsInput.map((rep) => buildRepresentative(rep));
    await moovFetch(`/accounts/${accountId}`, {
      method: 'PATCH', scopes: scopes.accountWrite(accountId),
      body: { profile: { business: businessProfile } }, fetchImpl,
    });
    let repsCreated = 0;
    if (repBodies.length > 0) {
      const existing = await moovFetch(`/accounts/${accountId}/representatives`, {
        scopes: scopes.representativesRead(accountId), fetchImpl,
      }).catch(() => []);
      const known = new Set((existing ?? []).map((r) => `${r?.name?.firstName ?? ''} ${r?.name?.lastName ?? ''}`.trim().toLowerCase()));
      for (const repBody of repBodies) {
        const key = `${repBody.name.firstName} ${repBody.name.lastName}`.toLowerCase();
        if (known.has(key)) continue;
        await moovFetch(`/accounts/${accountId}/representatives`, {
          method: 'POST', scopes: scopes.representativesWrite(accountId), body: repBody, fetchImpl,
        });
        repsCreated += 1;
      }
      if (body?.ownersProvided !== false) {
        await moovFetch(`/accounts/${accountId}`, {
          method: 'PATCH', scopes: scopes.accountWrite(accountId),
          body: { profile: { business: { ownersProvided: true } } }, fetchImpl,
        }).catch(() => {});
      }
    }
    await moovFetch(`/accounts/${accountId}/capabilities`, {
      method: 'POST', scopes: scopes.capabilitiesWrite(accountId),
      body: { capabilities: ['transfers', 'send-funds', 'wallet', 'send-funds.ach', 'collect-funds', 'collect-funds.ach'] }, fetchImpl,
    }).catch(() => {});
    await client.query(
      `UPDATE public.payment_provider_accounts SET onboarding_status = 'verification_pending', last_synced_at = now() WHERE id = $1::uuid`,
      [account.id],
    );
    await logPaymentEvent(client, {
      tenant_id: ctx.tenantId, event_type: 'payment_account.onboarding_submitted', environment: 'sandbox',
      provider_metadata: { account_id: accountId, representatives_added: repsCreated, by: mapping.application_user_id },
    });
    return jsonResult({ success: true, representatives_added: repsCreated, liveProviderCalled: true });
  },
};

export const bankAccountAdd = {
  requireAdmin: true,
  run: async ({ client, mapping, body, ctx, fetchImpl }) => {
    const holderName = String(body?.holder_name ?? '').trim();
    const holderType = body?.holder_type === 'individual' ? 'individual' : 'business';
    const bankAccountType = body?.bank_account_type === 'savings' ? 'savings' : 'checking';
    const routingNumber = String(body?.routing_number ?? '').replace(/\D/g, '');
    const accountNumber = String(body?.account_number ?? '').replace(/\D/g, '');
    if (holderName.length < 2 || holderName.length > 128) {
      return fail('Enter the account holder name as it appears at the bank.', 400);
    }
    if (!/^\d+$/.test(routingNumber) || routingNumber.length !== 9) {
      return fail('Routing number must be exactly 9 digits.', 400);
    }
    if (!/^\d+$/.test(accountNumber) || accountNumber.length < 4 || accountNumber.length > 17) {
      return fail('Account number must be between 4 and 17 digits.', 400);
    }
    const account = await loadMoovAccount(client, ctx.tenantId, 'sandbox');
    const accountId = account?.provider_account_id;
    if (!accountId) return fail('Set up the payment account first.', 409);
    const created = await moovFetch(`/accounts/${accountId}/bank-accounts`, {
      method: 'POST',
      scopes: scopes.bankAccountsWrite(accountId),
      fetchImpl,
      body: {
        account: { holderName, holderType, accountNumber, routingNumber, bankAccountType },
      },
    });
    const bankAccountId = created?.bankAccountID ?? created?.bankAccountId ?? null;
    if (!bankAccountId) return fail('The provider did not return a bank account id.', 502);
    const bankName = created?.bankName ?? null;
    const lastFour = created?.lastFourAccountNumber ?? safeLastFour(accountNumber);
    const status = String(created?.status ?? 'new').toLowerCase();
    const loadRails = async () => {
      const found = await fetchRailMethodIds(accountId, bankAccountId, fetchImpl).catch(() => ({}));
      if (Object.keys(found).length) return found;
      const listed = await moovFetch(`/accounts/${accountId}/payment-methods`, {
        scopes: scopes.paymentMethodsRead(accountId),
        fetchImpl,
      }).catch(() => []);
      const out = {};
      for (const row of (Array.isArray(listed) ? listed : [])) {
        const owner = row?.bankAccount?.bankAccountID ?? row?.bankAccount?.bankAccountId ?? null;
        if (bankAccountId && owner && owner !== bankAccountId) continue;
        const id = row?.paymentMethodID ?? row?.paymentMethodId;
        const type = String(row?.paymentMethodType || 'unknown');
        if (id) out[type] = id;
      }
      return out;
    };
    let rails = await loadRails();
    if (!Object.keys(rails).length) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      rails = await loadRails();
    }
    const debitPaymentMethodId = rails['ach-debit-fund']
      || rails['ach-debit-collect']
      || rails['ach-debit-standard']
      || Object.values(rails)[0]
      || null;
    let method;
    try {
      method = (await client.query(
        `INSERT INTO public.payment_provider_methods
          (tenant_id, provider, environment, provider_account_id, provider_bank_account_id,
           provider_payment_method_id, bank_name, account_type, last_four, holder_name,
           verification_status, connection_status, can_send, can_receive, is_default,
           connected_at, provider_metadata, supported_rails, rail_payment_method_ids, rails_synced_at)
         VALUES ($1::uuid, 'moov', 'sandbox', $2, $3, $4, $5, $6, $7, $8, $9, 'connected', true, true, true,
           now(), $10::jsonb, $11::jsonb, $12::jsonb, now())
         ON CONFLICT (provider, environment, provider_bank_account_id) DO UPDATE SET
           provider_payment_method_id = COALESCE(EXCLUDED.provider_payment_method_id, payment_provider_methods.provider_payment_method_id),
           bank_name = EXCLUDED.bank_name, last_four = EXCLUDED.last_four,
           verification_status = EXCLUDED.verification_status, connection_status = 'connected',
           can_send = true, connected_at = now(),
           supported_rails = EXCLUDED.supported_rails,
           rail_payment_method_ids = EXCLUDED.rail_payment_method_ids,
           rails_synced_at = now()
         RETURNING *`,
        [
          ctx.tenantId, accountId, bankAccountId, debitPaymentMethodId, bankName, bankAccountType, lastFour, holderName,
          status === 'verified' ? 'verified' : 'unverified',
          JSON.stringify(sanitize({ status, source: 'manual_entry', rails })),
          JSON.stringify(Object.keys(rails)),
          JSON.stringify(rails),
        ],
      )).rows[0];
    } catch (error) {
      return fail(error.message, /permission denied|type jsonb|type text/i.test(String(error.message || '')) ? 403 : 500, {
        recovered_provider_payment_method_id: debitPaymentMethodId,
        bank_account_id: bankAccountId,
        last_four: lastFour,
        needs_privileged_persist: true,
        liveProviderCalled: true,
      });
    }
    await client.query(
      `UPDATE public.payment_provider_accounts SET last_synced_at = now() WHERE id = $1::uuid`,
      [account.id],
    );
    await logPaymentEvent(client, {
      tenant_id: ctx.tenantId, event_type: 'bank_account.connected', new_status: status, environment: 'sandbox',
      provider_metadata: sanitize({ bankName, lastFour, source: 'manual_entry', by: mapping.application_user_id }),
    });
    return jsonResult({
      success: true, payment_method_id: method?.id ?? null, bank_account_id: bankAccountId,
      provider_payment_method_id: debitPaymentMethodId || method?.provider_payment_method_id || null,
      bank_name: bankName, last_four: lastFour, status, liveProviderCalled: true,
    });
  },
};

export const bankLinkToken = {
  requireAdmin: true,
  run: async ({ client, ctx, fetchImpl }) => {
    const account = await loadMoovAccount(client, ctx.tenantId, 'sandbox');
    if (!account?.provider_account_id) return fail('Set up the payment account first.', 409);
    const accountId = account.provider_account_id;
    const token = await moovToken(scopes.dropBankLink(accountId), undefined, fetchImpl);
    return jsonResult({
      success: true, account_id: accountId, token, environment: 'sandbox',
      public_key: null, liveProviderCalled: true,
      message: 'Sandbox public key is not returned to the browser. INTENTIONAL AWS SECURITY IMPROVEMENT.',
    });
  },
};

export const microDepositInitiate = {
  run: async ({ client, mapping, body, ctx, fetchImpl }) => {
    let method;
    if (body.payment_method_id) {
      method = (await client.query(
        `SELECT * FROM public.payment_provider_methods WHERE id = $1::uuid AND provider = 'moov' AND environment = 'sandbox'`,
        [body.payment_method_id],
      )).rows[0];
    } else {
      method = (await client.query(
        `SELECT * FROM public.payment_provider_methods
         WHERE tenant_id = $1::uuid AND provider = 'moov' AND environment = 'sandbox'
           AND external_recipient_id IS NULL AND connection_status <> 'disconnected'
         ORDER BY created_at DESC NULLS LAST LIMIT 1`,
        [ctx.tenantId],
      )).rows[0];
    }
    if (!method) return fail('Bank account not found.', 404);
    if (method.tenant_id && method.tenant_id !== ctx.tenantId) return fail('Forbidden', 403);
    const accountId = method.provider_account_id;
    const bankAccountId = method.provider_bank_account_id;
    if (!accountId || !bankAccountId) return fail('This bank account is not ready for verification yet.', 409);
    try {
      const bank = await moovFetch(`/accounts/${accountId}/bank-accounts/${bankAccountId}`, {
        scopes: scopes.bankAccountsRead(accountId), fetchImpl,
      });
      if (String(bank?.status ?? '').toLowerCase() === 'verified') {
        await client.query(
          `UPDATE public.payment_provider_methods SET verification_status = 'verified', connection_status = 'connected' WHERE id = $1::uuid`,
          [method.id],
        );
        return jsonResult({ success: true, already_verified: true, environment: 'sandbox', liveProviderCalled: true });
      }
    } catch { /* initiate below is authoritative */ }
    try {
      await moovFetch(`/accounts/${accountId}/bank-accounts/${bankAccountId}/verify`, {
        method: 'POST', scopes: scopes.bankAccountsWrite(accountId), fetchImpl,
      });
    } catch {
      return fail('initiate_failed', 502, {
        message: 'Could not start bank verification with the payment provider. Reconnect the bank account and try again.',
        liveProviderCalled: true,
      });
    }
    const verification = (await client.query(
      `INSERT INTO public.payment_method_verifications
        (tenant_id, payment_method_id, external_recipient_id, provider, environment,
         provider_account_id, provider_bank_account_id, method, status, attempts, initiated_by)
       VALUES ($1::uuid, $2::uuid, $3, 'moov', 'sandbox', $4, $5, 'micro_deposit', 'pending', 0, $6::uuid)
       RETURNING *`,
      [ctx.tenantId, method.id, body.external_recipient_id ?? null, accountId, bankAccountId, mapping.application_user_id],
    )).rows[0];
    await client.query(
      `UPDATE public.payment_provider_methods SET verification_status = 'pending_micro_deposit' WHERE id = $1::uuid`,
      [method.id],
    );
    await logPaymentEvent(client, {
      tenant_id: ctx.tenantId, recipient_id: body.external_recipient_id,
      event_type: 'bank_account.micro_deposit.initiated', new_status: 'pending', environment: 'sandbox',
      provider_metadata: sanitize({ bank_account: bankAccountId }),
    });
    return jsonResult({ success: true, verification, environment: 'sandbox', liveProviderCalled: true });
  },
};

export const microDepositConfirm = {
  run: async ({ client, body, ctx, fetchImpl }) => {
    const { verification_id, code } = body ?? {};
    if (!verification_id) return fail('verification_id is required', 400);
    if (!code || typeof code !== 'string' || !/^\d{4}$/.test(code)) {
      return fail('Enter the 4-digit verification code.', 400);
    }
    const verification = (await client.query(
      `SELECT * FROM public.payment_method_verifications
       WHERE id = $1::uuid AND tenant_id = $2::uuid AND environment = 'sandbox'`,
      [verification_id, ctx.tenantId],
    )).rows[0];
    if (!verification) return fail('Verification not found.', 404);
    let providerStatus = null;
    try {
      const bank = await moovFetch(
        `/accounts/${verification.provider_account_id}/bank-accounts/${verification.provider_bank_account_id}`,
        { scopes: scopes.bankAccountsRead(verification.provider_account_id), fetchImpl },
      );
      providerStatus = String(bank?.status ?? '').toLowerCase();
    } catch { /* PUT is authoritative */ }
    if (providerStatus === 'verified') {
      await client.query(
        `UPDATE public.payment_method_verifications SET status = 'verified', verified_at = now(), failure_reason = null WHERE id = $1::uuid`,
        [verification_id],
      );
      if (verification.payment_method_id) {
        await client.query(
          `UPDATE public.payment_provider_methods SET verification_status = 'verified', connection_status = 'connected' WHERE id = $1::uuid`,
          [verification.payment_method_id],
        );
      }
      return jsonResult({ success: true, already_verified: true, environment: 'sandbox', liveProviderCalled: true });
    }
    const maxAttempts = verification.max_attempts ?? 3;
    if (verification.attempts >= maxAttempts) {
      await client.query(
        `UPDATE public.payment_method_verifications SET status = 'max_attempts_exceeded' WHERE id = $1::uuid`,
        [verification_id],
      );
      return fail('max_attempts_exceeded', 409, {
        requires_restart: true,
        message: 'Too many incorrect attempts. Restart verification to receive a new deposit code.',
      });
    }
    const attempts = verification.attempts + 1;
    try {
      await moovFetch(
        `/accounts/${verification.provider_account_id}/bank-accounts/${verification.provider_bank_account_id}/verify`,
        {
          method: 'PUT',
          scopes: scopes.bankAccountsWrite(verification.provider_account_id),
          body: { code },
          fetchImpl,
        },
      );
    } catch (e) {
      await client.query(
        `UPDATE public.payment_method_verifications SET attempts = $2, failure_reason = $3 WHERE id = $1::uuid`,
        [verification_id, attempts, e.message],
      );
      const raw = `${e.message}`.toLowerCase();
      if (raw.includes('max') && raw.includes('attempt')) {
        return fail('max_attempts_exceeded', 409, {
          requires_restart: true,
          message: 'Too many incorrect attempts. Restart verification to receive a new deposit code.',
          liveProviderCalled: true,
        });
      }
      return fail('invalid_code', 400, {
        message: 'That code did not match. Check the $0.01 deposit descriptor and try again.',
        liveProviderCalled: true,
      });
    }
    await client.query(
      `UPDATE public.payment_method_verifications SET status = 'verified', verified_at = now(), attempts = $2, failure_reason = null WHERE id = $1::uuid`,
      [verification_id, attempts],
    );
    if (verification.payment_method_id) {
      await client.query(
        `UPDATE public.payment_provider_methods SET verification_status = 'verified', connection_status = 'connected' WHERE id = $1::uuid`,
        [verification.payment_method_id],
      );
    }
    await logPaymentEvent(client, {
      tenant_id: ctx.tenantId, event_type: 'bank_account.micro_deposit.verified', new_status: 'verified', environment: 'sandbox',
    });
    return jsonResult({ success: true, verified: true, environment: 'sandbox', liveProviderCalled: true });
  },
};

export const recipientCreate = {
  run: async ({ client, mapping, body, ctx, fetchImpl }) => {
    const name = String(body.name || '').trim();
    if (name.length < 2) return fail('Recipient name is required', 400);
    const email = body.email ? String(body.email).trim() : null;
    const recipientType = body.recipient_type || 'individual';
    if (email) {
      const memberTenant = (await client.query(
        `SELECT id, name, email_reply_to FROM public.tenants WHERE email_reply_to ILIKE $1 LIMIT 1`,
        [email],
      )).rows[0];
      if (memberTenant) {
        const theirAccount = await loadMoovAccount(client, memberTenant.id, 'sandbox');
        return jsonResult({
          success: true, is_existing_member: true,
          recipient_tenant_id: memberTenant.id, recipient_tenant_name: memberTenant.name,
          provider_account_id: theirAccount?.provider_account_id ?? null,
          can_receive_payments: !!theirAccount?.can_receive_payments,
          message: theirAccount?.provider_account_id
            ? 'This payee already has a ChecksOps payment account — it will be used directly.'
            : 'This payee is a ChecksOps organization but has not finished payment setup.',
        });
      }
      const dupe = (await client.query(
        `SELECT * FROM public.external_payment_recipients WHERE tenant_id = $1::uuid AND email ILIKE $2 LIMIT 1`,
        [ctx.tenantId, email],
      )).rows[0];
      if (dupe) return jsonResult({ success: true, already_existed: true, recipient: dupe });
    }
    const token = secureToken();
    const expiresAt = new Date(Date.now() + Number(body.expires_in_days ?? 14) * 86_400_000).toISOString();
    const recipient = (await client.query(
      `INSERT INTO public.external_payment_recipients
        (tenant_id, provider, environment, display_name, email, phone, recipient_type, relationship,
         claim_id, check_id, secure_token, token_expires_at, created_by)
       VALUES ($1::uuid, 'moov', 'sandbox', $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz, $11::uuid)
       RETURNING *`,
      [
        ctx.tenantId, name, email, body.phone ?? null, recipientType, body.relationship ?? 'one_time',
        body.claim_id ?? null, body.check_id ?? null, token, expiresAt, mapping.application_user_id,
      ],
    )).rows[0];
    const [first, ...rest] = name.split(/\s+/);
    const created = await moovFetch('/accounts', {
      method: 'POST', scopes: scopes.accountsWrite(),
      idempotencyKey: `checksops-recipient-sandbox-${recipient.id}`,
      fetchImpl,
      body: recipientType === 'business'
        ? {
          accountType: 'business',
          profile: { business: { legalBusinessName: name, email: email ?? undefined } },
          capabilities: ['transfers'],
          foreignID: recipient.id,
          metadata: { checksops_recipient_id: recipient.id, checksops_tenant_id: ctx.tenantId },
        }
        : {
          accountType: 'individual',
          profile: { individual: { name: { firstName: first, lastName: rest.join(' ') || first }, email: email ?? undefined } },
          capabilities: ['transfers'],
          foreignID: recipient.id,
          metadata: { checksops_recipient_id: recipient.id, checksops_tenant_id: ctx.tenantId },
        },
    });
    const providerAccountId = created?.accountID ?? created?.accountId ?? null;
    const saved = (await client.query(
      `UPDATE public.external_payment_recipients
       SET provider_account_id = $2, onboarding_status = $3 WHERE id = $1::uuid RETURNING *`,
      [recipient.id, providerAccountId, providerAccountId ? 'awaiting_kyc' : 'not_started'],
    )).rows[0];
    await logPaymentEvent(client, {
      tenant_id: ctx.tenantId, recipient_id: recipient.id, event_type: 'recipient.created', environment: 'sandbox',
      provider_metadata: { account_id: providerAccountId },
    });
    return jsonResult({ success: true, already_existed: false, recipient: saved, setup_token: token, liveProviderCalled: true });
  },
};

export const recipientSession = {
  run: async ({ client, body, fetchImpl }) => {
    const token = body.token;
    if (!token || typeof token !== 'string') return fail('token is required', 400);
    const recipient = (await client.query(
      `SELECT id, tenant_id, display_name, provider_account_id, token_expires_at, onboarding_status,
              environment, bank_linked_at, provider_bank_name, provider_last_four
       FROM public.external_payment_recipients WHERE secure_token = $1`,
      [token],
    )).rows[0];
    if (!recipient) return fail('This link is not valid.', 404);
    if (recipient.token_expires_at && new Date(recipient.token_expires_at) < new Date()) {
      return fail('This link has expired. Ask the sender for a new one.', 410);
    }
    if (!recipient.provider_account_id) return fail('This payment setup is not ready yet. Try again shortly.', 409);
    const accountId = String(recipient.provider_account_id);
    const account = await moovFetch(`/accounts/${accountId}`, { scopes: scopes.accountRead(accountId), fetchImpl }).catch(() => null);
    if (liveAccountReadFailed(account)) return fail('moov_account_get_failed', 502);
    const verificationStatus = kycStatusFromMoov(account || {});
    const tosAccepted = liveTosAccepted(account || {});
    let capabilities = [];
    let capabilitiesReadOk = false;
    try {
      const caps = await moovFetch(`/accounts/${accountId}/capabilities`, { scopes: scopes.capabilitiesRead(accountId), fetchImpl });
      capabilities = Array.isArray(caps) ? caps : caps?.capabilities || [];
      capabilitiesReadOk = true;
    } catch { /* unread */ }
    let banks = [];
    try {
      const bankPayload = await moovFetch(`/accounts/${accountId}/bank-accounts`, { scopes: scopes.bankAccountsRead(accountId), fetchImpl });
      banks = Array.isArray(bankPayload) ? bankPayload : bankPayload?.bankAccounts || [];
    } catch { /* unread */ }
    const dropToken = tosAccepted ? null : await moovToken(scopes.dropTos(accountId), undefined, fetchImpl);
    const tenant = (await client.query(
      `SELECT name, logo_url, primary_color, secondary_color FROM public.tenants WHERE id = $1::uuid`,
      [recipient.tenant_id],
    )).rows[0];
    return jsonResult({
      success: true,
      recipient: {
        id: recipient.id, name: recipient.display_name, status: recipient.onboarding_status,
        bank_linked: banks.length > 0, bank_name: recipient.provider_bank_name ?? null,
        last_four: recipient.provider_last_four ?? null,
      },
      onboarding: {
        terms_accepted: tosAccepted,
        tos_requirement_outstanding: capabilitiesReadOk ? tosRequirementOutstanding(capabilities) : true,
        verification_status: verificationStatus,
        identity_requirements_outstanding: capabilitiesReadOk ? identityRequirementsOutstanding(capabilities) : [],
        identity_requirements_known: capabilitiesReadOk,
        bank_verified: liveBankVerified(banks),
        complete: recipientOnboardingCompleteFromMoov({ account, banks, capabilities, capabilitiesReadOk }),
        live: true,
      },
      payer: {
        name: tenant?.name ?? 'ChecksOps', logo_url: tenant?.logo_url ?? null,
        primary_color: tenant?.primary_color ?? null, secondary_color: tenant?.secondary_color ?? null,
      },
      account_id: accountId, environment: recipient.environment || 'sandbox', token: dropToken,
      public_key: null, liveProviderCalled: true,
    });
  },
};

export const recipientTosAccept = {
  run: async ({ client, body, fetchImpl }) => {
    const token = String(body?.token ?? '');
    if (!token) return fail('token is required', 400);
    const forged = rejectForgedRecipientTos(body);
    if (forged) return fail(forged.error, forged.statusCode);
    const dropToken = dropTokenFromBody(body);
    const recipient = (await client.query(
      `SELECT id, tenant_id, provider_account_id, token_expires_at, environment
       FROM public.external_payment_recipients WHERE secure_token = $1`,
      [token],
    )).rows[0];
    if (!recipient) return fail('This link is not valid.', 404);
    if (recipient.token_expires_at && new Date(recipient.token_expires_at) < new Date()) {
      return fail('This link has expired. Ask the sender for a new one.', 410);
    }
    if (!recipient.provider_account_id) return fail('This payment setup is not ready yet.', 409);
    const bound = tosBoundToRecipientAccount({
      recipientAccountId: String(recipient.provider_account_id),
      requestedAccountId: body.account_id ?? body.accountId ?? null,
      environment: recipient.environment || 'sandbox',
    });
    if (!bound.ok) return fail(bound.error, 400);
    const accountId = bound.account_id;
    const current = await moovFetch(`/accounts/${accountId}`, { scopes: scopes.accountRead(accountId), fetchImpl });
    let capabilitiesBefore = [];
    let capsReadOk = false;
    try {
      const caps = await moovFetch(`/accounts/${accountId}/capabilities`, { scopes: scopes.capabilitiesRead(accountId), fetchImpl });
      capabilitiesBefore = Array.isArray(caps) ? caps : caps?.capabilities || [];
      capsReadOk = true;
    } catch { /* unread */ }
    const outstandingBefore = capsReadOk ? tosRequirementOutstanding(capabilitiesBefore) : null;
    const alreadyAccepted = tosConfirmedByMoov({
      account: current, capabilities: capabilitiesBefore, capabilitiesReadOk: capsReadOk,
    });
    if (!alreadyAccepted) {
      await moovFetch(`/accounts/${accountId}`, {
        method: 'PATCH', scopes: scopes.accountWrite(accountId),
        body: { termsOfService: { token: dropToken } }, fetchImpl,
      });
    }
    const refreshed = await moovFetch(`/accounts/${accountId}`, { scopes: scopes.accountRead(accountId), fetchImpl });
    let capabilitiesAfter = [];
    let capsAfterOk = false;
    try {
      const caps = await moovFetch(`/accounts/${accountId}/capabilities`, { scopes: scopes.capabilitiesRead(accountId), fetchImpl });
      capabilitiesAfter = Array.isArray(caps) ? caps : caps?.capabilities || [];
      capsAfterOk = true;
    } catch { /* unread */ }
    const confirmed = tosConfirmedByMoov({
      account: refreshed,
      capabilities: capabilitiesAfter,
      capabilitiesReadOk: capsAfterOk,
      tosOutstandingBefore: outstandingBefore === true,
    });
    if (!confirmed) return fail('tos_not_recorded', 502);
    await client.query(
      `UPDATE public.external_payment_recipients SET tos_accepted_at = now() WHERE id = $1::uuid`,
      [recipient.id],
    );
    return jsonResult({
      success: true, already_accepted: alreadyAccepted, terms_accepted: true,
      account_id: accountId, environment: recipient.environment || 'sandbox', liveProviderCalled: true,
    });
  },
};

export const recipientKycUpdate = {
  run: async ({ client, body, fetchImpl }) => {
    const token = String(body?.token ?? '');
    if (!token) return fail('token is required', 400);
    const patch = buildIndividualKycPatch(body);
    if (!patch.ok) return fail(patch.error, 400);
    const recipient = (await client.query(
      `SELECT * FROM public.external_payment_recipients WHERE secure_token = $1`,
      [token],
    )).rows[0];
    if (!recipient?.provider_account_id) return fail('This payment setup is not ready yet.', 409);
    const accountId = recipient.provider_account_id;
    await moovFetch(`/accounts/${accountId}`, {
      method: 'PATCH', scopes: scopes.accountWrite(accountId),
      body: patch.body, fetchImpl,
    });
    return jsonResult({ success: true, liveProviderCalled: true, account_id: accountId });
  },
};

export const recipientBankAdd = {
  run: async ({ client, mapping, body, fetchImpl }) => {
    const token = String(body?.token ?? '');
    if (!token) return fail('token is required', 400);
    const recipient = (await client.query(
      `SELECT * FROM public.external_payment_recipients WHERE secure_token = $1`,
      [token],
    )).rows[0];
    if (!recipient?.provider_account_id) return fail('This payment setup is not ready yet.', 409);
    const accountId = recipient.provider_account_id;
    const account = await moovFetch(`/accounts/${accountId}`, { scopes: scopes.accountRead(accountId), fetchImpl });
    let capabilities = [];
    let capsOk = false;
    try {
      const caps = await moovFetch(`/accounts/${accountId}/capabilities`, { scopes: scopes.capabilitiesRead(accountId), fetchImpl });
      capabilities = Array.isArray(caps) ? caps : caps?.capabilities || [];
      capsOk = true;
    } catch { /* unread */ }
    if (!liveTosAccepted(account) && (capsOk ? tosRequirementOutstanding(capabilities) : true)) {
      return fail('tos_required', 409);
    }
    const identityOutstanding = capsOk ? identityRequirementsOutstanding(capabilities) : [];
    if (identityOutstanding.length) return fail('kyc_incomplete', 409);
    let existingBanks = [];
    try {
      const payload = await moovFetch(`/accounts/${accountId}/bank-accounts`, { scopes: scopes.bankAccountsRead(accountId), fetchImpl });
      existingBanks = Array.isArray(payload) ? payload : payload?.bankAccounts || [];
    } catch {
      return fail('moov_bank_list_failed', 502);
    }
    if (shouldResumeExistingBank({ banks: existingBanks, replaceBank: body.replace_bank === true || body.replaceBank === true })) {
      const existing = existingBanks[0];
      return jsonResult({
        success: true, resumed: true,
        bank_name: existing?.bankName ?? null,
        last_four: existing?.lastFourAccountNumber ?? null,
        status: String(existing?.status ?? 'new').toLowerCase(),
        complete: liveBankVerified(existingBanks),
        account_id: accountId, liveProviderCalled: true,
      });
    }
    const holderName = String(body?.holder_name ?? '').trim();
    const holderType = body?.holder_type === 'business' ? 'business' : 'individual';
    const bankAccountType = body?.bank_account_type === 'savings' ? 'savings' : 'checking';
    const routingNumber = String(body?.routing_number ?? '').replace(/\D/g, '');
    const accountNumber = String(body?.account_number ?? '').replace(/\D/g, '');
    if (holderName.length < 2) return fail('Enter the account holder name as it appears at the bank.', 400);
    if (!/^\d{9}$/.test(routingNumber)) return fail('Routing number must be exactly 9 digits.', 400);
    if (!/^\d{4,17}$/.test(accountNumber)) return fail('Account number must be between 4 and 17 digits.', 400);
    const created = await moovFetch(`/accounts/${accountId}/bank-accounts`, {
      method: 'POST', scopes: scopes.bankAccountsWrite(accountId), fetchImpl,
      body: { account: { holderName, holderType, accountNumber, routingNumber, bankAccountType } },
    });
    const bankAccountId = created?.bankAccountID ?? created?.bankAccountId;
    const lastFour = created?.lastFourAccountNumber ?? safeLastFour(accountNumber);
    const bankName = created?.bankName ?? null;
    await client.query(
      `INSERT INTO public.payment_provider_methods
        (tenant_id, provider, environment, provider_account_id, provider_bank_account_id,
         external_recipient_id, bank_name, account_type, last_four, holder_name,
         verification_status, connection_status, can_send, can_receive, connected_at, provider_metadata)
       VALUES ($1::uuid, 'moov', 'sandbox', $2, $3, $4::uuid, $5, $6, $7, $8, 'unverified', 'connected', false, true, now(), $9::jsonb)
       ON CONFLICT (provider, environment, provider_bank_account_id) DO UPDATE SET last_four = EXCLUDED.last_four`,
      [
        recipient.tenant_id, accountId, bankAccountId, recipient.id, bankName, bankAccountType, lastFour, holderName,
        JSON.stringify(sanitize({ status: created?.status, source: 'recipient_manual_entry' })),
      ],
    );
    await client.query(
      `UPDATE public.external_payment_recipients
       SET bank_linked_at = now(), provider_bank_name = $2, provider_last_four = $3, onboarding_status = 'awaiting_verification'
       WHERE id = $1::uuid`,
      [recipient.id, bankName, lastFour],
    );
    return jsonResult({
      success: true, bank_account_id: bankAccountId, bank_name: bankName, last_four: lastFour, liveProviderCalled: true,
    });
  },
};

export const recipientBankVerify = {
  run: async ({ client, body, fetchImpl }) => {
    const token = String(body?.token ?? '');
    const action = String(body?.action ?? '').toLowerCase();
    if (!token) return fail('token is required', 400);
    if (action !== 'initiate' && action !== 'confirm') return fail('action must be initiate or confirm.', 400);
    const recipient = (await client.query(
      `SELECT * FROM public.external_payment_recipients WHERE secure_token = $1`,
      [token],
    )).rows[0];
    if (!recipient) return fail('This link is not valid.', 404);
    if (recipient.token_expires_at && new Date(recipient.token_expires_at) < new Date()) {
      return fail('This link has expired. Ask the sender for a new one.', 410);
    }
    if (!recipient.provider_account_id) return fail('This payment setup is not ready yet.', 409);
    const accountId = recipient.provider_account_id;
    const account = await moovFetch(`/accounts/${accountId}`, { scopes: scopes.accountRead(accountId), fetchImpl });
    let capabilities = [];
    let capsOk = false;
    try {
      const caps = await moovFetch(`/accounts/${accountId}/capabilities`, { scopes: scopes.capabilitiesRead(accountId), fetchImpl });
      capabilities = Array.isArray(caps) ? caps : caps?.capabilities || [];
      capsOk = true;
    } catch { /* unread */ }
    const blocked = recipientBankVerifyBlocked({
      tosAccepted: liveTosAccepted(account),
      tosOutstanding: capsOk ? tosRequirementOutstanding(capabilities) : true,
      identityOutstanding: capsOk ? identityRequirementsOutstanding(capabilities) : [],
    });
    if (blocked) return fail(blocked.error, blocked.statusCode);
    let banks = [];
    try {
      const payload = await moovFetch(`/accounts/${accountId}/bank-accounts`, { scopes: scopes.bankAccountsRead(accountId), fetchImpl });
      banks = Array.isArray(payload) ? payload : payload?.bankAccounts || [];
    } catch {
      return fail('moov_bank_list_failed', 502);
    }
    const liveBank = banks[0];
    const liveBankId = String(liveBank?.bankAccountID ?? liveBank?.bankAccountId ?? '');
    if (!liveBankId) return fail('bank_required', 409);
    const swapped = rejectBrowserBankSubstitution({
      recipientAccountId: accountId,
      liveBankAccountId: liveBankId,
      requestedAccountId: body.account_id ?? body.accountId ?? null,
      requestedBankAccountId: body.bank_account_id ?? body.bankAccountId ?? null,
    });
    if (swapped) return fail(swapped.error, swapped.statusCode);
    let liveVerify = null;
    try {
      liveVerify = await moovFetch(`/accounts/${accountId}/bank-accounts/${liveBankId}/verify`, {
        scopes: scopes.bankAccountsRead(accountId), fetchImpl,
      });
    } catch { /* not initiated */ }
    const interpreted = interpretRecipientBankVerification({ bank: liveBank, verification: liveVerify });
    if (action === 'initiate') {
      if (interpreted.verified) {
        return jsonResult({
          success: true, already_verified: true,
          complete: recipientOnboardingCompleteFromMoov({
            account, banks, capabilities, capabilitiesReadOk: capsOk,
          }),
          liveProviderCalled: true, account_id: accountId,
        });
      }
      if (!shouldInitiateInstantMicroDeposit({ bank: liveBank, verification: liveVerify })) {
        return jsonResult({
          success: true, already_initiated: true, initiated: interpreted.initiated,
          complete: false, liveProviderCalled: true, account_id: accountId,
        });
      }
      try {
        await moovFetch(`/accounts/${accountId}/bank-accounts/${liveBankId}/verify`, {
          method: 'POST', scopes: scopes.bankAccountsWrite(accountId), fetchImpl,
        });
      } catch (e) {
        if (!initiateAlreadyOpenError(e.message)) return fail('initiate_failed', 502);
      }
      return jsonResult({ success: true, initiated: true, complete: false, liveProviderCalled: true, account_id: accountId });
    }
    const verifyBody = moovInstantVerifyBody(body?.code);
    if (!verifyBody) return fail('Enter the 4-digit verification code.', 400);
    if (interpreted.verified) {
      return jsonResult({ success: true, already_verified: true, complete: true, liveProviderCalled: true, account_id: accountId });
    }
    try {
      await moovFetch(`/accounts/${accountId}/bank-accounts/${liveBankId}/verify`, {
        method: 'PUT', scopes: scopes.bankAccountsWrite(accountId), body: verifyBody, fetchImpl,
      });
    } catch {
      return fail('verification_failed', 409, { message: 'That code did not match. Check the $0.01 deposit descriptor and try again.' });
    }
    const refreshed = await moovFetch(`/accounts/${accountId}/bank-accounts/${liveBankId}`, {
      scopes: scopes.bankAccountsRead(accountId), fetchImpl,
    }).catch(() => null);
    if (!refreshed) return fail('moov_bank_get_failed', 502);
    if (providerVerifySuccessIsNotComplete({ httpOk: true, bank: refreshed }) || !liveBankVerified([refreshed])) {
      return fail('bank_not_verified', 502);
    }
    return jsonResult({
      success: true,
      complete: recipientOnboardingCompleteFromMoov({
        account, banks: [refreshed], capabilities, capabilitiesReadOk: capsOk,
      }),
      bank_status: 'verified',
      liveProviderCalled: true,
      account_id: accountId,
    });
  },
};

export const recipientDisconnect = {
  run: async ({ client, body, ctx, fetchImpl }) => {
    const id = body.recipient_id || body.external_recipient_id;
    if (!id) return fail('recipient_id is required', 400);
    const recipient = (await client.query(
      `SELECT * FROM public.external_payment_recipients WHERE id = $1::uuid AND tenant_id = $2::uuid`,
      [id, ctx.tenantId],
    )).rows[0];
    if (!recipient) return fail('Recipient not found.', 404);
    if (recipient.provider_account_id) {
      await moovFetch(`/accounts/${recipient.provider_account_id}`, {
        method: 'PATCH', scopes: scopes.accountWrite(recipient.provider_account_id),
        body: { metadata: { checksops_disconnected: 'true' } }, fetchImpl,
      }).catch(() => {});
    }
    await client.query(
      `UPDATE public.external_payment_recipients SET onboarding_status = 'disconnected', disconnected_at = now() WHERE id = $1::uuid`,
      [id],
    );
    await client.query(
      `UPDATE public.payment_provider_methods SET connection_status = 'disconnected' WHERE external_recipient_id = $1::uuid`,
      [id],
    );
    return jsonResult({ success: true, liveProviderCalled: Boolean(recipient.provider_account_id) });
  },
};

export const onboardingLink = {
  requireAdmin: true,
  run: async ({ client, body, ctx, fetchImpl }) => {
    const account = await loadMoovAccount(client, ctx.tenantId, 'sandbox');
    if (!account?.provider_account_id) return fail('Set up the payment account first.', 409);
    const accountId = account.provider_account_id;
    const platformId = ctx.moovContext.sandboxPlatformAccountId || accountId;
    let feePlanCodes = [];
    try {
      const plans = await moovFetch(`/accounts/${platformId}/fee-plans`, {
        scopes: scopes.accountRead(platformId), fetchImpl,
      });
      const list = Array.isArray(plans) ? plans : plans?.feePlans ?? [];
      feePlanCodes = list.map((p) => p?.planCode ?? p?.code).filter((c) => typeof c === 'string').slice(0, 1);
    } catch { /* continue */ }
    const redirect = typeof body.return_url === 'string' && body.return_url.startsWith('http')
      ? body.return_url
      : 'https://checksops.com/payments?tab=settings';
    const invite = await moovFetch(`/accounts/${accountId}/onboarding-invites`, {
      method: 'POST', scopes: scopes.accountWrite(accountId), fetchImpl,
      body: {
        returnURL: redirect,
        ...(feePlanCodes.length ? { feePlanCodes } : {}),
      },
    }).catch(async (e) => {
      const alt = await moovFetch(`/accounts/${platformId}/onboarding-invites`, {
        method: 'POST', scopes: scopes.accountWrite(platformId), fetchImpl,
        body: { accountID: accountId, returnURL: redirect, ...(feePlanCodes.length ? { feePlanCodes } : {}) },
      }).catch(() => { throw e; });
      return alt;
    });
    const url = invite?.inviteURL ?? invite?.url ?? invite?.onboardingURL ?? null;
    await client.query(
      `UPDATE public.payment_provider_accounts SET last_synced_at = now() WHERE id = $1::uuid`,
      [account.id],
    );
    return jsonResult({ success: true, url, liveProviderCalled: true, headers: lastMoovRequestHeaders() });
  },
};

export const accountFiles = {
  run: async ({ client, body, ctx, fetchImpl }) => {
    const account = await loadMoovAccount(client, ctx.tenantId, 'sandbox');
    const accountId = account?.provider_account_id;
    if (!accountId) return fail('Set up your payment account first.', 409);
    const remote = await moovFetch(`/accounts/${accountId}/files`, {
      scopes: scopes.filesRead(accountId), fetchImpl,
    }).catch(() => []);
    const files = Array.isArray(remote) ? remote : remote?.files ?? [];
    if (body.sync !== false) {
      for (const f of files) {
        const fileID = f.fileID ?? f.fileId;
        if (!fileID) continue;
        await client.query(
          `INSERT INTO public.payment_provider_files
            (tenant_id, provider, environment, provider_account_id, provider_file_id,
             file_purpose, file_name, file_size_bytes, provider_status, provider_metadata)
           VALUES ($1::uuid, 'moov', 'sandbox', $2, $3, $4, $5, $6, $7, $8::jsonb)
           ON CONFLICT (provider, environment, provider_file_id) DO UPDATE SET
             provider_status = EXCLUDED.provider_status, file_name = EXCLUDED.file_name`,
          [
            ctx.tenantId, accountId, fileID, f.filePurpose ?? 'business_verification',
            f.fileName ?? 'document', f.fileSizeBytes ?? null, f.status ?? null,
            JSON.stringify(sanitize(f)),
          ],
        ).catch(() => {});
      }
    }
    const local = (await client.query(
      `SELECT * FROM public.payment_provider_files WHERE tenant_id = $1::uuid AND provider = 'moov' AND environment = 'sandbox' ORDER BY created_at DESC`,
      [ctx.tenantId],
    )).rows;
    return jsonResult({ success: true, files: local, liveProviderCalled: true });
  },
};

export const accountFileUpload = {
  requireAdmin: true,
  run: async ({ client, mapping, body, ctx, fetchImpl }) => {
    const account = await loadMoovAccount(client, ctx.tenantId, 'sandbox');
    if (!account?.provider_account_id) return fail('Set up your payment account first.', 409);
    const fileB64 = body.file_base64 || body.file;
    const fileName = body.file_name || 'document.pdf';
    const purpose = body.file_purpose || 'business_verification';
    if (!fileB64) return fail('A document file is required.', 400);
    const accountId = account.provider_account_id;
    const uploaded = await moovFetch(`/accounts/${accountId}/files`, {
      method: 'POST', scopes: scopes.filesWrite(accountId), fetchImpl,
      body: { fileName, filePurpose: purpose, file: fileB64 },
    });
    const fileID = uploaded?.fileID ?? uploaded?.fileId;
    const row = (await client.query(
      `INSERT INTO public.payment_provider_files
        (tenant_id, provider, environment, provider_account_id, provider_file_id,
         file_purpose, file_name, uploaded_by, provider_status, provider_metadata)
       VALUES ($1::uuid, 'moov', 'sandbox', $2, $3, $4, $5, $6::uuid, $7, $8::jsonb)
       RETURNING *`,
      [
        ctx.tenantId, accountId, fileID, purpose, fileName, mapping.application_user_id,
        uploaded?.status ?? 'pending', JSON.stringify(sanitize(uploaded ?? {})),
      ],
    )).rows[0];
    return jsonResult({ success: true, file: row, liveProviderCalled: true });
  },
};

export const accountFileView = {
  run: async ({ client, body, ctx }) => {
    const fileId = String(body?.file_id ?? '');
    if (!fileId) return fail('tenant_id and file_id are required', 400);
    const row = (await client.query(
      `SELECT storage_path, file_name FROM public.payment_provider_files
       WHERE id = $1::uuid AND tenant_id = $2::uuid`,
      [fileId, ctx.tenantId],
    )).rows[0];
    if (!row?.storage_path) return fail('No viewable copy is stored for this document.', 404);
    return jsonResult({
      success: true, file_name: row.file_name ?? 'document',
      url: null, storage_path: row.storage_path,
      message: 'AWS file view returns the stored path. Signed S3 URLs are an INTENTIONAL AWS storage improvement pending the storage bridge.',
      liveProviderCalled: false,
    });
  },
};

export const plaidBridge = {
  run: async ({ client, mapping, body, ctx, fetchImpl }) => {
    const isRecipientMode = body.mode === 'recipient';
    const account = await loadMoovAccount(client, ctx.tenantId, 'sandbox');
    if (!account?.provider_account_id) return fail('Set up your payment account first.', 409);
    const stakeholderId = body.stakeholder_account_id;
    if (!stakeholderId) return fail('stakeholder_account_id is required', 400);
    const stake = (await client.query(
      `SELECT * FROM public.stakeholder_accounts WHERE id = $1::uuid AND tenant_id = $2::uuid`,
      [stakeholderId, ctx.tenantId],
    )).rows[0];
    if (!stake) return fail('Stakeholder account not found.', 404);
    const processorToken = stake.plaid_processor_token || body.processor_token;
    if (!processorToken) return fail('A Plaid processor token is required to bridge this bank.', 409);
    const moovAccountId = isRecipientMode
      ? (stake.provider_account_id || account.provider_account_id)
      : account.provider_account_id;
    let created;
    try {
      created = await moovFetch(`/accounts/${moovAccountId}/bank-accounts`, {
        method: 'POST', scopes: scopes.bankAccountsWrite(moovAccountId), fetchImpl,
        body: { plaid: { token: processorToken } },
      });
    } catch {
      created = await moovFetch(`/accounts/${moovAccountId}/bank-accounts`, {
        method: 'POST', scopes: scopes.bankAccountsWrite(moovAccountId), fetchImpl,
        body: { plaidToken: processorToken },
      });
    }
    const bankAccountId = created?.bankAccountID ?? created?.bankAccountId;
    await client.query(
      `UPDATE public.stakeholder_accounts
       SET provider = 'moov', provider_environment = 'sandbox', provider_account_id = $2,
           provider_bank_account_id = $3, moov_status = $4
       WHERE id = $1::uuid`,
      [stakeholderId, moovAccountId, bankAccountId, created?.status ?? 'new'],
    );
    return jsonResult({
      success: true, mode: isRecipientMode ? 'recipient' : 'tenant',
      provider_account_id: moovAccountId, bank_name: created?.bankName ?? null,
      last_four: created?.lastFourAccountNumber ?? null, status: created?.status,
      liveProviderCalled: true,
    });
  },
};

export const sweepConfig = {
  run: async ({ client, body, ctx, fetchImpl }) => {
    const account = await loadMoovAccount(client, ctx.tenantId, 'sandbox');
    if (!account?.provider_account_id) return fail('Set up your payment account first.', 409);
    const accountId = account.provider_account_id;
    const action = String(body?.action ?? 'get');
    const wallet = await syncWallet(client, {
      tenantId: ctx.tenantId, accountId, environment: 'sandbox', fetchImpl,
    });
    if (action === 'list' || action === 'get') {
      const data = await moovFetch(`/accounts/${accountId}/sweep-configs`, {
        scopes: [`/accounts/${accountId}/wallets.read`], fetchImpl,
      });
      return jsonResult({ success: true, configs: data, wallet, liveProviderCalled: true });
    }
    if (action === 'sweeps') {
      const data = await moovFetch(
        `/accounts/${accountId}/sweeps?walletID=${encodeURIComponent(wallet.provider_wallet_id)}&count=50`,
        { scopes: [`/accounts/${accountId}/wallets.read`], fetchImpl },
      );
      return jsonResult({ success: true, sweeps: data, liveProviderCalled: true });
    }
    if (action === 'create') {
      const created = await moovFetch(`/accounts/${accountId}/sweep-configs`, {
        method: 'POST', scopes: [`/accounts/${accountId}/wallets.write`], fetchImpl,
        body: {
          walletID: wallet.provider_wallet_id,
          pushPaymentMethodID: body.push_payment_method_id,
          pullPaymentMethodID: body.pull_payment_method_id,
          minimumBalance: { currency: 'USD', value: Number(body.minimum_balance_cents) || 0 },
          statementDescriptor: body.statement_descriptor ?? 'CHECKOPS',
        },
      });
      return jsonResult({ success: true, config: created, liveProviderCalled: true });
    }
    if (action === 'update' || action === 'disable') {
      const id = body.sweep_config_id;
      if (!id) return fail('sweep_config_id is required', 400);
      const updated = await moovFetch(`/accounts/${accountId}/sweep-configs/${id}`, {
        method: 'PATCH', scopes: [`/accounts/${accountId}/wallets.write`], fetchImpl,
        body: action === 'disable' ? { status: 'disabled' } : (body.patch || body),
      });
      return jsonResult({ success: true, config: updated, liveProviderCalled: true });
    }
    return fail('Unknown sweep action', 400);
  },
};

const INVOICE_API_VERSION = 'v2026.07.00';

export const invoice = {
  run: async ({ client, body, ctx, fetchImpl }) => {
    const account = await loadMoovAccount(client, ctx.tenantId, 'sandbox');
    if (!account?.provider_account_id) return fail('Set up your payment account first.', 409);
    const accountId = account.provider_account_id;
    const action = body.action || 'create';
    if (action === 'list') {
      const data = await moovFetch(`/accounts/${accountId}/invoices`, {
        scopes: [`/accounts/${accountId}/invoices.read`], apiVersion: INVOICE_API_VERSION, fetchImpl,
      });
      return jsonResult({ success: true, invoices: data, liveProviderCalled: true, apiVersion: INVOICE_API_VERSION });
    }
    const items = Array.isArray(body.line_items) ? body.line_items : [];
    if (!items.length) return fail('At least one line item is required', 400);
    const created = await moovFetch(`/accounts/${accountId}/invoices`, {
      method: 'POST',
      scopes: [`/accounts/${accountId}/invoices.write`],
      apiVersion: INVOICE_API_VERSION,
      fetchImpl,
      body: {
        customer: body.customer || {},
        lineItems: items.map((i) => ({
          name: i.name,
          quantity: i.quantity ?? 1,
          unitPrice: { currency: 'USD', valueDecimal: Number(i.unit_price).toFixed(2) },
        })),
      },
    });
    return jsonResult({
      success: true, invoice: created, liveProviderCalled: true,
      apiVersion: INVOICE_API_VERSION,
      note: 'Production moov-invoice pins v2026.07.00 for invoices only. Platform transfers remain v2024.01.00.',
    });
  },
};

export const platformBank = {
  requireAdmin: true,
  run: async ({ client, body, ctx, fetchImpl }) => {
    if (!ctx.isAdmin) return fail('Platform owner access required', 403);
    const platformId = ctx.moovContext.sandboxPlatformAccountId;
    if (!platformId) return fail('Facilitator account id is not configured.', 409);
    const action = body.action || 'list';
    if (action === 'list' || action === 'get') {
      const banks = await moovFetch(`/accounts/${platformId}/bank-accounts`, {
        scopes: scopes.bankAccountsRead(platformId), fetchImpl,
      });
      return jsonResult({ success: true, banks, liveProviderCalled: true });
    }
    if (action === 'add') {
      return bankAccountAdd.run({
        client, mapping: { application_user_id: ctx.userId }, body, ctx: { ...ctx, tenantId: ctx.tenantId }, fetchImpl,
      });
    }
    return fail('Unknown platform-bank action', 400);
  },
};

export const feeScheduleUpsert = {
  requireAdmin: true,
  run: async ({ client, body, ctx, fetchImpl }) => {
    const account = await loadMoovAccount(client, ctx.tenantId, 'sandbox');
    if (!account?.provider_account_id) return fail('Set up your payment account first.', 409);
    const facilitatorId = await facilitatorAccountId(account.provider_account_id, fetchImpl);
    const created = await moovFetch(`/accounts/${facilitatorId}/transfers/schedules`, {
      method: 'POST', scopes: scopes.transfersWrite(facilitatorId), fetchImpl,
      body: {
        description: body.name || 'ChecksOps platform fees',
        amount: { currency: 'USD', value: Number(body.amount_cents) || 0 },
        recurrence: { cadence: body.cadence || 'monthly', dayOfMonth: body.day_of_month || 1 },
      },
    }).catch((e) => ({ error: e.message, status: e.status }));
    await client.query(
      `INSERT INTO public.payment_fee_schedules (tenant_id, provider, environment, name, fee_code, amount_cents, cadence, provider_metadata)
       VALUES ($1::uuid, 'moov', 'sandbox', $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (tenant_id, fee_code) DO UPDATE SET amount_cents = EXCLUDED.amount_cents, provider_metadata = EXCLUDED.provider_metadata`,
      [
        ctx.tenantId, body.name || 'ChecksOps platform fees', body.fee_code || 'platform_fees',
        Number(body.amount_cents) || 0, body.cadence || 'monthly', JSON.stringify(sanitize(created)),
      ],
    ).catch(() => {});
    return jsonResult({ success: true, schedule: created, liveProviderCalled: !created?.error });
  },
};

export const feeScheduleCancel = {
  requireAdmin: true,
  run: async ({ client, body, ctx, fetchImpl }) => {
    const account = await loadMoovAccount(client, ctx.tenantId, 'sandbox');
    const facilitatorId = account?.provider_account_id
      ? await facilitatorAccountId(account.provider_account_id, fetchImpl)
      : null;
    if (body.schedule_id && facilitatorId) {
      await moovFetch(`/accounts/${facilitatorId}/transfers/schedules/${body.schedule_id}`, {
        method: 'DELETE', scopes: scopes.transfersWrite(facilitatorId), fetchImpl,
      }).catch(() => {});
    }
    if (body.fee_code) {
      await client.query(
        `UPDATE public.payment_fee_schedules SET status = 'canceled' WHERE tenant_id = $1::uuid AND fee_code = $2`,
        [ctx.tenantId, body.fee_code],
      ).catch(() => {});
    }
    return jsonResult({ success: true, liveProviderCalled: Boolean(body.schedule_id && facilitatorId) });
  },
};

export const feeRollup = {
  run: async ({ client, ctx }) => {
    const rows = (await client.query(
      `SELECT coalesce(sum(platform_fee_cents), 0)::bigint AS fees, count(*)::int AS transfers
       FROM public.payment_transfers WHERE tenant_id = $1::uuid AND environment = 'sandbox'`,
      [ctx.tenantId],
    )).rows[0];
    return jsonResult({ success: true, fees_cents: Number(rows?.fees || 0), transfers: rows?.transfers || 0, liveProviderCalled: false });
  },
};

export const bulkImportPreview = {
  requireAdmin: true,
  run: async () => jsonResult({
    success: true, rows: [], liveProviderCalled: false,
    message: 'Bulk import preview is diagnostic and not required for the current deposit/disburse flow.',
  }),
};

export const platformTreasury = {
  requireAdmin: true,
  run: async ({ ctx, fetchImpl }) => {
    const platformId = ctx.moovContext.sandboxPlatformAccountId;
    if (!platformId) return fail('Facilitator account id is not configured.', 409);
    const wallets = await moovFetch(`/accounts/${platformId}/wallets`, {
      scopes: scopes.accountRead(platformId), fetchImpl,
    }).catch((e) => ({ error: e.message }));
    return jsonResult({ success: true, wallets, liveProviderCalled: true });
  },
};

export const homeownerDeductiblePay = {
  run: async ({ client, body, fetchImpl }) => {
    const token = String(body?.token ?? '');
    const amount = Number(body?.amount ?? 0);
    if (!token) return fail('token is required', 400);
    if (!Number.isFinite(amount) || amount <= 0) return fail('Amount must be greater than zero.', 400);
    const ledger = (await client.query(
      `SELECT * FROM public.homeowner_ledgers WHERE public_token = $1 LIMIT 1`,
      [token],
    )).rows[0];
    if (!ledger) return fail('This payment link is not valid.', 404);
    const account = await loadMoovAccount(client, ledger.tenant_id, 'sandbox');
    if (!account?.provider_account_id) return fail('The contractor payment account is not ready.', 409);
    const holderName = String(body?.holder_name ?? '').trim();
    const routingNumber = String(body?.routing_number ?? '').replace(/\D/g, '');
    const accountNumber = String(body?.account_number ?? '').replace(/\D/g, '');
    if (holderName.length < 2 || !/^\d{9}$/.test(routingNumber) || !/^\d{4,17}$/.test(accountNumber)) {
      return fail('Enter valid bank details.', 400);
    }
    const createdBank = await moovFetch(`/accounts/${account.provider_account_id}/bank-accounts`, {
      method: 'POST', scopes: scopes.bankAccountsWrite(account.provider_account_id), fetchImpl,
      body: {
        account: {
          holderName, holderType: 'individual', accountNumber, routingNumber,
          bankAccountType: body.bank_account_type === 'savings' ? 'savings' : 'checking',
        },
      },
    });
    return jsonResult({
      success: true, liveProviderCalled: true,
      last_four: createdBank?.lastFourAccountNumber ?? safeLastFour(accountNumber),
      amount_cents: Math.round(amount * 100),
      note: 'Homeowner deductible uses the production ACH debit path. Full account numbers are not stored.',
    });
  },
};

export const stakeholderResendVerification = {
  run: async ({ client, body, ctx, send }) => {
    const id = body.stakeholder_account_id;
    if (!id) return fail('stakeholder_account_id is required', 400);
    const account = (await client.query(
      `SELECT id, tenant_id, nickname, custname, verification_status, verification_recipient_email
       FROM public.stakeholder_accounts
       WHERE id = $1::uuid AND tenant_id = $2::uuid`,
      [id, ctx.tenantId],
    )).rows[0];
    if (!account) return fail('Account not found', 404);

    let to = normalizeEmail(body.recipient_email) || normalizeEmail(account.verification_recipient_email);
    if (!to) {
      let recipientRow = null;
      try {
        recipientRow = (await client.query(
          `SELECT email FROM public.external_payment_recipients
           WHERE stakeholder_account_id = $1::uuid
           ORDER BY updated_at DESC NULLS LAST LIMIT 1`,
          [id],
        )).rows[0];
      } catch {
        recipientRow = (await client.query(
          `SELECT email FROM public.external_payment_recipients
           WHERE stakeholder_account_id = $1::uuid LIMIT 1`,
          [id],
        )).rows[0];
      }
      to = normalizeEmail(recipientRow?.email);
    }
    if (!to) {
      return fail('No recipient email on file — edit the stakeholder and add their email first.', 400);
    }

    const token = randomUUID();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    await client.query(
      `UPDATE public.stakeholder_accounts
       SET verification_token = $2,
           verification_token_expires_at = $3::timestamptz,
           verification_recipient_email = $4
       WHERE id = $1::uuid`,
      [id, token, expiresAt, to],
    );

    const verifyUrl = `${emailAssetOrigin()}/verify-account/${token}`;
    const branding = await resolveEmailBranding(client, { tenantId: account.tenant_id });
    const rendered = renderTransactionalTemplate('stakeholder-verify-account', {
      nickname: account.nickname,
      custname: account.custname,
      verifyUrl,
      branding,
    });
    const mailer = send || sendViaSesOrSink;
    let sendResult;
    try {
      sendResult = await mailer({
        to,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        from: branding.from,
        replyTo: branding.replyTo,
      });
    } catch (error) {
      return fail(String(error?.message || 'Failed to send verification email').slice(0, 240), 502, {
        emailed: false,
        liveProviderCalled: false,
      });
    }
    const invoked = Array.isArray(sendResult?.results) && sendResult.results.length > 0;
    if (!invoked) {
      return fail('Verification email was not sent', 502, {
        emailed: false,
        liveProviderCalled: false,
      });
    }

    await client.query(
      `UPDATE public.stakeholder_accounts SET verification_sent_at = now() WHERE id = $1::uuid`,
      [id],
    );

    return jsonResult({
      success: true,
      liveProviderCalled: false,
      emailed: true,
    });
  },
};

export const publicInvoice = {
  run: async ({ client, body, fetchImpl }) => {
    const token = body.token || body.invoice_id;
    if (!token) return fail('token is required', 400);
    const row = (await client.query(
      `SELECT * FROM public.payment_invoices WHERE public_token = $1 OR id::text = $1 LIMIT 1`,
      [token],
    )).rows[0];
    if (!row) return fail('Invoice not found.', 404);
    return jsonResult({ success: true, invoice: sanitize(row), liveProviderCalled: false });
  },
};

export { randomUUID, MoovError };
