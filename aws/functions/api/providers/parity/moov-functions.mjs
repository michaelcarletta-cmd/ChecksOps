/**
 * Ports of production Moov Edge Functions.
 * Source: supabase/functions/moov-* /index.ts and _shared/moovClient.ts
 * Staging binds sandbox credentials only and writes environment='sandbox' rows.
 */
import { evaluateReadiness } from '../readiness.mjs';
import {
  MoovError,
  capabilityFlags,
  facilitatorAccountId,
  lastMoovRequestHeaders,
  moovFetch,
  moovToken,
  normalizeOnboardingStatus,
  normalizeTransferStatus,
  scopes,
  withMoovContext,
} from './moov-client.mjs';
import { fail, jsonResult, moovParityContext, isChecksOpsPlatformOwner } from './caller.mjs';
import { loadMoovAccount, logPaymentEvent, sanitize } from './db.mjs';
import { readWallet, syncWallet } from './moov-wallet.mjs';
import { reconcileStakeholderBankStatuses } from './moov-stakeholder-status.mjs';
import {
  cancelWalletFunding,
  calculatePaymentFunding,
  disburse,
  initiateWalletFunding,
  processFundedPayment,
  tenantFeeCharge,
  transferCreate,
  transferGroupCreate,
  walletFund,
  walletFundOnClear,
} from './moov-money.mjs';
import {
  accountFileUpload,
  accountFileView,
  accountFiles,
  accountOnboard,
  bankAccountAdd,
  bankLinkToken,
  bulkImportPreview,
  feeRollup,
  feeScheduleCancel,
  feeScheduleUpsert,
  homeownerDeductiblePay,
  invoice,
  microDepositConfirm,
  microDepositInitiate,
  onboardingLink,
  plaidBridge,
  platformBank,
  platformTreasury,
  publicInvoice,
  recipientBankAdd,
  recipientBankVerify,
  recipientCreate,
  recipientDisconnect,
  recipientKycUpdate,
  recipientSession,
  recipientTosAccept,
  stakeholderResendVerification,
  sweepConfig,
} from './moov-onboard.mjs';

const wrapPlatformOwnerRead = (handler) => async (event, deps = {}) => {
  const { withIdentity } = await import('../../data.mjs');
  const { loadSandboxCredentials } = await import('../../sandbox-credentials.mjs');
  const loader = typeof deps.loadSandboxCredentials === 'function'
    ? deps.loadSandboxCredentials
    : loadSandboxCredentials;
  return withIdentity(event, async ({ client, mapping, claims, body, spoof }) => {
    const isOwner = await isChecksOpsPlatformOwner(client);
    if (!isOwner) {
      return fail('Platform owner access required', 403, {
        spoofFieldsIgnored: spoof,
        applicationUserId: mapping.application_user_id,
      });
    }
    const loaded = await loader();
    const secrets = loaded.secrets || {};
    const productionRuntime = String(process.env.CHECKSOPS_ENV || '').toLowerCase().startsWith('production');
    const productionReady = Boolean(secrets.MOOV_PUBLIC_KEY && secrets.MOOV_SECRET_KEY);
    const useProduction = productionRuntime && productionReady;
    const moovContext = useProduction
      ? {
        environment: 'production',
        sandboxPublicKey: loaded.moov?.publicKey || null,
        sandboxSecretKey: loaded.moov?.secretKey || null,
        sandboxPlatformAccountId: loaded.moov?.platformAccountId || null,
        sandboxOrigin: loaded.moov?.origin || 'https://checksops.com',
        apiVersion: loaded.moov?.apiVersion || secrets.MOOV_API_VERSION || secrets.MOOV_SANDBOX_API_VERSION || 'v2024.01.00',
        productionPublicKey: secrets.MOOV_PUBLIC_KEY || null,
        productionSecretKey: secrets.MOOV_SECRET_KEY || null,
        productionPlatformAccountId: secrets.MOOV_ACCOUNT_ID
          || process.env.AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID
          || null,
      }
      : {
        environment: 'sandbox',
        sandboxPublicKey: loaded.moov?.publicKey || null,
        sandboxSecretKey: loaded.moov?.secretKey || null,
        sandboxPlatformAccountId: loaded.moov?.platformAccountId || null,
        sandboxOrigin: loaded.moov?.origin || 'https://checksops.com',
        apiVersion: loaded.moov?.apiVersion || secrets.MOOV_SANDBOX_API_VERSION || 'v2024.01.00',
        productionPublicKey: null,
        productionSecretKey: null,
        productionPlatformAccountId: null,
      };
    const ctx = {
      tenantId: null,
      isAdmin: false,
      isPlatformOwner: true,
      environment: moovContext.environment,
      userId: mapping.application_user_id,
      memberships: [],
      moovContext,
      loaded,
    };
    try {
      const fetchImpl = deps.fetchImpl || fetch;
      const result = await withMoovContext({ ...moovContext, fetchImpl }, () => handler.run({
        client, mapping, claims, body, spoof, ctx, fetchImpl, event,
      }));
      return {
        ...result,
        spoofFieldsIgnored: spoof,
        applicationUserId: mapping.application_user_id,
        authUid: mapping.application_user_id,
        cognitoSub: claims.sub,
        productionExecution: false,
        environment: moovContext.environment,
        apiVersion: moovContext.apiVersion,
      };
    } catch (error) {
      const { isProviderNetworkError, providerEgressFailure } = await import('../../sandbox-credentials.mjs');
      if (isProviderNetworkError(error)) {
        return {
          ...providerEgressFailure('moov'),
          spoofFieldsIgnored: spoof,
          applicationUserId: mapping.application_user_id,
        };
      }
      const status = error instanceof MoovError ? (error.status || 502) : 500;
      return fail(error.message, status, {
        spoofFieldsIgnored: spoof,
        applicationUserId: mapping.application_user_id,
        liveProviderCalled: true,
      });
    }
  }, deps);
};

const wrap = (handler) => {
  if (handler.platformOwnerOnly === true) return wrapPlatformOwnerRead(handler);
  return wrapTenantParity(handler);
};

const wrapTenantParity = (handler) => async (event, deps = {}) => {
  const { withIdentityWrite } = await import('../../data.mjs');
  const { loadSandboxCredentials } = await import('../../sandbox-credentials.mjs');
  const loader = typeof deps.loadSandboxCredentials === 'function'
    ? deps.loadSandboxCredentials
    : loadSandboxCredentials;
  return withIdentityWrite(event, async ({ client, mapping, claims, body, spoof }) => {
    const ctx = await moovParityContext({
      client,
      mapping,
      body,
      requireAdmin: handler.requireAdmin === true,
      loadSandbox: loader,
    });
    if (ctx.error) return { ...ctx, spoofFieldsIgnored: spoof, applicationUserId: mapping.application_user_id };
    try {
      const fetchImpl = deps.fetchImpl || fetch;
      const result = await withMoovContext({ ...ctx.moovContext, fetchImpl }, () => handler.run({
        client, mapping, claims, body, spoof, ctx, fetchImpl, event,
        send: deps.sendViaSesOrSink,
      }));
      return {
        ...result,
        spoofFieldsIgnored: spoof,
        applicationUserId: mapping.application_user_id,
        authUid: mapping.application_user_id,
        cognitoSub: claims.sub,
        productionExecution: ctx.environment === 'production',
        environment: ctx.environment,
        apiVersion: ctx.moovContext.apiVersion,
      };
    } catch (error) {
      const { isProviderNetworkError, providerEgressFailure } = await import('../../sandbox-credentials.mjs');
      if (isProviderNetworkError(error)) {
        return {
          ...providerEgressFailure('moov'),
          spoofFieldsIgnored: spoof,
          applicationUserId: mapping.application_user_id,
        };
      }
      const status = error instanceof MoovError ? (error.status || 502) : 500;
      return fail(error.message, status, {
        spoofFieldsIgnored: spoof,
        applicationUserId: mapping.application_user_id,
        liveProviderCalled: true,
      });
    }
  }, deps);
};

const accountCreate = {
  requireAdmin: true,
  run: async ({ client, mapping, body, ctx, fetchImpl }) => {
    const tenantId = ctx.tenantId;
    const environment = ctx.environment || 'sandbox';
    const existing = await loadMoovAccount(client, tenantId, environment);
    if (existing?.provider_account_id) {
      return jsonResult({ success: true, already_existed: true, account: existing, liveProviderCalled: false });
    }
    const tenant = (await client.query(
      `SELECT id, name, legal_business_name, email_from_address, email_reply_to, business_phone, business_address
       FROM public.tenants WHERE id = $1::uuid`,
      [tenantId],
    )).rows[0];
    if (!tenant) return fail('Organization not found', 404);
    const tosToken = typeof body.terms_of_service_token === 'string' && body.terms_of_service_token.length >= 8
      ? body.terms_of_service_token
      : null;
    const addr = (() => {
      const raw = String(tenant.business_address ?? '').trim();
      if (!raw) return null;
      const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
      if (parts.length >= 3) {
        const tail = parts[parts.length - 1].split(/\s+/);
        const postalCode = tail.length > 1 ? tail[tail.length - 1] : '';
        const stateOrProvince = tail.length > 1 ? tail.slice(0, -1).join(' ') : tail[0] ?? '';
        return {
          addressLine1: parts.slice(0, parts.length - 2).join(', '),
          city: parts[parts.length - 2] ?? '',
          stateOrProvince,
          postalCode,
          country: 'US',
        };
      }
      return null;
    })();
    const idempotencyKey = `checksops-account-${environment}-${tenantId}`;
    try {
      await client.query(
        `INSERT INTO public.payment_idempotency_keys
          (tenant_id, provider, scope, idempotency_key, status)
         VALUES ($1::uuid, 'moov', 'account_create', $2, 'in_progress')`,
        [tenantId, idempotencyKey],
      );
    } catch { /* duplicate ok */ }
    const created = await moovFetch('/accounts', {
      method: 'POST',
      scopes: scopes.accountsWrite(),
      idempotencyKey,
      fetchImpl,
      body: {
        accountType: 'business',
        profile: {
          business: {
            legalBusinessName: tenant.legal_business_name ?? tenant.name ?? 'ChecksOps Organization',
            email: tenant.email_reply_to ?? tenant.email_from_address ?? undefined,
            phone: tenant.business_phone
              ? { number: String(tenant.business_phone).replace(/\D/g, '').slice(-10) }
              : undefined,
            address: addr ?? undefined,
          },
        },
        capabilities: ['transfers', 'send-funds', 'wallet', 'send-funds.ach'],
        ...(tosToken ? { termsOfService: { token: tosToken } } : {}),
        foreignID: tenantId,
        metadata: { checksops_tenant_id: tenantId },
      },
    });
    const accountId = created?.accountID ?? created?.accountId;
    if (!accountId) return fail('Payment provider did not return an account id', 502);
    const saved = (await client.query(
      `INSERT INTO public.payment_provider_accounts
        (tenant_id, provider, environment, provider_account_id, account_type, display_name,
         onboarding_status, verification_status, provider_metadata, last_synced_at,
         tos_accepted_at, tos_accepted_by, tos_source)
       VALUES ($1::uuid, 'moov', $2, $3, 'business', $4, 'onboarding_incomplete', 'not_started', $5::jsonb, now(),
         ${tosToken ? 'now()' : 'NULL'}, ${tosToken ? '$6::uuid' : 'NULL'}, ${tosToken ? "'tos_drop'" : 'NULL'})
       ON CONFLICT (tenant_id, provider, environment) DO UPDATE SET
         provider_account_id = EXCLUDED.provider_account_id,
         provider_metadata = EXCLUDED.provider_metadata,
         last_synced_at = now()
       RETURNING *`,
      tosToken
        ? [tenantId, environment, accountId, tenant.name ?? null, JSON.stringify(sanitize(created)), mapping.application_user_id]
        : [tenantId, environment, accountId, tenant.name ?? null, JSON.stringify(sanitize(created))],
    )).rows[0];
    await logPaymentEvent(client, {
      tenant_id: tenantId,
      event_type: 'payment_account.created',
      new_status: 'onboarding_incomplete',
      environment,
      provider_metadata: { account_id: accountId, created_by: mapping.application_user_id },
    });
    return jsonResult({
      success: true,
      already_existed: false,
      account: saved,
      liveProviderCalled: true,
      request: { path: '/accounts', method: 'POST', headers: lastMoovRequestHeaders(), pinnedVersion: 'v2024.01.00' },
    });
  },
};

const readiness = {
  run: async ({ client, ctx, fetchImpl }) => {
    const environment = ctx.environment || 'sandbox';
    const account = await loadMoovAccount(client, ctx.tenantId, environment);
    const accountId = account?.provider_account_id || null;
    if (!accountId) {
      return jsonResult({
        success: true,
        readiness: evaluateReadiness({
          environment,
          accountId: null,
          capabilities: [],
          banks: [],
          termsAccepted: false,
        }),
        liveProviderCalled: false,
        source: 'live_provider_when_account_exists',
      });
    }
    const remote = await moovFetch(`/accounts/${accountId}`, {
      scopes: scopes.accountRead(accountId),
      fetchImpl,
    }).catch(() => null);
    const caps = await moovFetch(`/accounts/${accountId}/capabilities`, {
      scopes: scopes.capabilitiesRead(accountId),
      fetchImpl,
    }).catch(() => []);
    const capList = (caps ?? []).map((c) => ({
      capability: c.capability,
      status: c.status,
      requirements: c.requirements ?? null,
    }));
    const banks = await moovFetch(`/accounts/${accountId}/bank-accounts`, {
      scopes: scopes.bankAccountsRead(accountId),
      fetchImpl,
    }).catch(() => []);
    let feePlanCode = null;
    let feePlanUnavailable = false;
    try {
      const plans = await moovFetch(`/accounts/${accountId}/fee-plans`, {
        scopes: scopes.accountWrite(accountId),
        fetchImpl,
      });
      const list = Array.isArray(plans) ? plans : plans?.feePlans ?? [];
      const code = list.map((p) => p?.planCode ?? p?.code).find((c) => typeof c === 'string');
      feePlanCode = code ?? null;
      feePlanUnavailable = !feePlanCode;
    } catch {
      feePlanUnavailable = true;
    }
    const remoteTos = remote?.termsOfService?.acceptedOn ?? remote?.termsOfService?.acceptedDate ?? null;
    const termsAccepted = !!(account?.tos_accepted_at || remoteTos);
    const verificationStatus = remote?.profile?.business?.verification?.status ?? remote?.verification?.status ?? null;
    const result = evaluateReadiness({
      environment,
      accountId,
      capabilities: capList,
      banks: (banks ?? []).map((b) => ({ status: b.status })),
      verificationStatus,
      disabled: !!remote?.disabledOn,
      termsAccepted,
      feePlanCode,
      feePlanUnavailable,
    });
    result.source = 'live_provider';
    result.liveProviderCalled = true;
    await client.query(
      `UPDATE public.payment_provider_accounts
       SET readiness = $2::jsonb, readiness_checked_at = now(), fee_plan_code = $3,
           fee_plan_status = $4
       WHERE id = $1::uuid`,
      [account.id, JSON.stringify(sanitize(result)), feePlanCode, feePlanCode ? 'assigned' : (feePlanUnavailable ? 'provider_managed' : 'unknown')],
    );
    return jsonResult({ success: true, readiness: result, liveProviderCalled: true });
  },
};

const tosToken = {
  requireAdmin: true,
  run: async ({ client, ctx, fetchImpl }) => {
    const environment = ctx.environment || 'sandbox';
    const account = await loadMoovAccount(client, ctx.tenantId, environment);
    const accountId = account?.provider_account_id || null;
    const sessionScopes = accountId
      ? [`/accounts/${accountId}/profile.write`, `/accounts/${accountId}/profile.read`, '/ping.read']
      : ['/ping.read'];
    const token = await moovToken(sessionScopes, undefined, fetchImpl);
    return jsonResult({
      success: true,
      token,
      environment,
      account_id: accountId,
      public_key: null,
      liveProviderCalled: true,
      message: 'Sandbox public key is not returned to the browser. INTENTIONAL AWS SECURITY IMPROVEMENT.',
    });
  },
};

const tosAccept = {
  requireAdmin: true,
  run: async ({ client, mapping, body, ctx, fetchImpl, event }) => {
    const clientToken = typeof body.terms_of_service_token === 'string' && body.terms_of_service_token.length >= 8
      ? body.terms_of_service_token
      : null;
    if (!clientToken && body.accepted !== true) return fail('Terms must be explicitly accepted.', 400);
    const account = await loadMoovAccount(client, ctx.tenantId, ctx.environment || 'sandbox');
    if (!account?.provider_account_id) return fail('Set up the payment account first.', 409);
    if (account.tos_accepted_at) {
      return jsonResult({ success: true, already_accepted: true, accepted_at: account.tos_accepted_at });
    }
    const accountId = account.provider_account_id;
    const headers = event?.headers || {};
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [String(k).toLowerCase(), v]));
    const ipCandidates = [
      String(lower['x-forwarded-for'] || '').split(',')[0].trim(),
      lower['cf-connecting-ip'] || '',
      lower['x-real-ip'] || '',
    ].filter((ip, i, arr) => ip && arr.indexOf(ip) === i);
    const acceptedUserAgent = lower['user-agent'] || 'unknown';
    const headersFor = (ip) => ({
      ...(ip ? { 'X-Forwarded-For': ip, 'X-Real-IP': ip } : {}),
      'User-Agent': acceptedUserAgent,
    });
    let applied = false;
    let lastError = null;
    for (const ip of ipCandidates.length ? ipCandidates : ['']) {
      try {
        let tosTok = clientToken;
        if (!tosTok) {
          const minted = await moovFetch('/tos-token', {
            scopes: ['/ping.read'],
            extraHeaders: headersFor(ip),
            fetchImpl,
          });
          const value = minted?.token ?? minted?.tosToken ?? null;
          if (typeof value === 'string' && value.length >= 8) tosTok = value;
        }
        if (!tosTok) {
          lastError = 'Could not generate the terms acceptance token.';
          continue;
        }
        await moovFetch(`/accounts/${accountId}`, {
          method: 'PATCH',
          scopes: scopes.accountWrite(accountId),
          body: { termsOfService: { token: tosTok } },
          extraHeaders: headersFor(ip),
          fetchImpl,
        });
        applied = true;
        break;
      } catch (err) {
        lastError = err.message;
        if (/already\s+(been\s+)?accept|terms.*already/i.test(err.message)) {
          applied = true;
          break;
        }
        if (clientToken) break;
      }
    }
    if (!applied) return fail(lastError || 'Could not record terms acceptance with the payment provider.', 502);
    const acceptedAt = new Date().toISOString();
    await client.query(
      `UPDATE public.payment_provider_accounts
       SET tos_accepted_at = $2::timestamptz, tos_accepted_by = $3::uuid, tos_source = 'tos_drop'
       WHERE id = $1::uuid`,
      [account.id, acceptedAt, mapping.application_user_id],
    );
    await logPaymentEvent(client, {
      tenant_id: ctx.tenantId,
      event_type: 'payment_account.terms_accepted',
      environment: 'sandbox',
      provider_metadata: { account_id: accountId },
    });
    return jsonResult({ success: true, accepted_at: acceptedAt, liveProviderCalled: true });
  },
};

const transferStatus = {
  run: async ({ client, ctx, fetchImpl }) => {
    const account = await loadMoovAccount(client, ctx.tenantId, ctx.environment || 'sandbox');
    const rows = (await client.query(
      `SELECT id, tenant_id, provider_transfer_id, status, amount_cents, description, wallet_id
       FROM public.payment_transfers
       WHERE tenant_id = $1::uuid AND environment = 'sandbox'
         AND status IN ('pending','processing','submitted','queued','created')
         AND provider_transfer_id IS NOT NULL
       ORDER BY created_at DESC NULLS LAST LIMIT 50`,
      [ctx.tenantId],
    )).rows;
    if (!rows.length) {
      return jsonResult({ success: true, checked: 0, updated: 0, results: [], liveProviderCalled: false });
    }
    const platformAccount = await facilitatorAccountId(account?.provider_account_id || undefined, fetchImpl).catch(() => null);
    if (!platformAccount) {
      return jsonResult({
        success: false,
        error: "Couldn't reach the bank to check transfer status. Try Refresh balances, then check again.",
        checked: 0,
        updated: 0,
        results: [],
        liveProviderCalled: false,
      });
    }
    const results = [];
    let updated = 0;
    for (const row of rows) {
      try {
        const remote = await moovFetch(
          `/accounts/${platformAccount}/transfers/${row.provider_transfer_id}`,
          { scopes: scopes.transfersRead(platformAccount), fetchImpl },
        );
        const status = normalizeTransferStatus(remote?.status);
        await client.query(
          `UPDATE public.payment_transfers SET status = $2, provider_status = $3 WHERE id = $1::uuid`,
          [row.id, status, remote?.status || null],
        );
        updated += 1;
        results.push({ id: row.id, status, live: true });
      } catch (e) {
        results.push({ id: row.id, status: row.status, error: e.message });
      }
    }
    return jsonResult({ success: true, checked: rows.length, updated, results, liveProviderCalled: true });
  },
};

const selftest = {
  requireAdmin: true,
  run: async ({ ctx, fetchImpl }) => {
    const listed = await moovFetch('/accounts', { method: 'GET', scopes: scopes.accountsRead(), fetchImpl }).catch((e) => ({ error: e.message, status: e.status }));
    const platformId = ctx.moovContext.sandboxPlatformAccountId;
    let platform = null;
    if (platformId) {
      platform = await moovFetch(`/accounts/${platformId}`, {
        method: 'GET',
        scopes: scopes.accountRead(platformId),
        fetchImpl,
      }).catch((e) => ({ error: e.message, status: e.status }));
    }
    return jsonResult({
      success: true,
      liveProviderCalled: true,
      listed_ok: !listed?.error,
      platform_account_configured: Boolean(platformId),
      platform_account_read: platform && !platform.error,
      note: 'GET /accounts is diagnostic. Production transfers use stored account IDs plus facilitator.',
    });
  },
};

const sync = {
  run: async ({ client, ctx, fetchImpl }) => {
    const account = await loadMoovAccount(client, ctx.tenantId, ctx.environment || 'sandbox');
    if (!account?.provider_account_id) {
      const stakeholders = await reconcileStakeholderBankStatuses(client, {
        tenantId: ctx.tenantId,
        fetchImpl,
      }).catch(() => []);
      return jsonResult({
        success: true,
        status: 'not_started',
        account: account ?? null,
        liveProviderCalled: stakeholders.some((row) => !row.skipped && !row.error),
        stakeholders,
      });
    }
    const accountId = account.provider_account_id;
    const remote = await moovFetch(`/accounts/${accountId}`, { scopes: scopes.accountRead(accountId), fetchImpl });
    const caps = await moovFetch(`/accounts/${accountId}/capabilities`, { scopes: scopes.capabilitiesRead(accountId), fetchImpl }).catch(() => []);
    const banks = await moovFetch(`/accounts/${accountId}/bank-accounts`, { scopes: scopes.bankAccountsRead(accountId), fetchImpl }).catch(() => []);
    const flags = capabilityFlags(caps);
    const verification = remote?.profile?.business?.verification?.status ?? remote?.verification?.status ?? null;
    const onboarding = normalizeOnboardingStatus({
      verificationStatus: verification,
      capabilities: caps,
      disabled: !!remote?.disabledOn,
    });
    await client.query(
      `UPDATE public.payment_provider_accounts SET
         onboarding_status = $2, verification_status = $3, capabilities = $4::jsonb,
         can_send_payments = $5, can_receive_payments = $6, can_ach_credit = $7, can_ach_debit = $8,
         last_synced_at = now(), provider_metadata = $9::jsonb
       WHERE id = $1::uuid`,
      [
        account.id, onboarding, verification, JSON.stringify(caps || []),
        flags.can_send_payments, flags.can_receive_payments, flags.can_ach_credit, flags.can_ach_debit,
        JSON.stringify(sanitize({ remote, banks })),
      ],
    );
    const stakeholders = await reconcileStakeholderBankStatuses(client, {
      tenantId: ctx.tenantId,
      fetchImpl,
    }).catch(() => []);
    return jsonResult({
      success: true,
      status: onboarding,
      liveProviderCalled: true,
      identity_status: verification,
      bank_verified: Array.isArray(banks)
        ? banks.some((row) => String(row?.status || row?.verificationStatus || '').toLowerCase() === 'verified')
        : false,
      stakeholders,
    });
  },
};

const walletSync = {
  run: async ({ client, ctx, body, fetchImpl }) => {
    const walletType = body.wallet_type || 'operating';
    if (!['operating', 'trust'].includes(walletType)) {
      return fail("wallet_type must be 'operating' or 'trust'", 400);
    }
    const account = await loadMoovAccount(client, ctx.tenantId, ctx.environment || 'sandbox');
    if (!account?.provider_account_id) return fail('Set up your payment account first.', 409);
    const ledgerLimit = Math.min(Number(body.ledger_limit) || 50, 200);
    let wallet;
    try {
      wallet = await syncWallet(client, {
        tenantId: ctx.tenantId,
        accountId: account.provider_account_id,
        environment: 'sandbox',
        walletType,
        skipProviderFetch: !body?.force && account.onboarding_status !== 'active',
        fetchImpl,
      });
    } catch (error) {
      const local = await readWallet(client, ctx.tenantId, 'sandbox', walletType);
      if (!local) throw error;
      wallet = { ...local, status: 'sync_failed' };
    }
    const ledger = (await client.query(
      `SELECT * FROM public.payment_wallet_ledger
       WHERE wallet_id = $1::uuid ORDER BY created_at DESC NULLS LAST LIMIT $2`,
      [wallet.id, ledgerLimit],
    )).rows;
    const subLedgers = (await client.query(
      `SELECT * FROM public.payment_wallet_sub_ledgers
       WHERE wallet_id = $1::uuid ORDER BY created_at DESC NULLS LAST`,
      [wallet.id],
    )).rows;
    return jsonResult({
      success: true,
      wallet,
      ledger,
      sub_ledgers: subLedgers,
      liveProviderCalled: account.onboarding_status === 'active',
    });
  },
};

const HANDLERS = {
  'moov-account-create': accountCreate,
  'moov-readiness': readiness,
  'moov-tos-token': tosToken,
  'moov-tos-accept': tosAccept,
  'moov-transfer-status': transferStatus,
  'moov-selftest': selftest,
  'moov-sync': sync,
  'moov-account-discover': selftest,
  'moov-account-files': accountFiles,
  'moov-wallet-sync': walletSync,
  'moov-underwriting': {
    run: async ({ client, ctx, body, fetchImpl }) => {
      const account = await loadMoovAccount(client, ctx.tenantId, ctx.environment || 'sandbox');
      if (!account?.provider_account_id) return fail('Set up your payment account first.', 409);
      const id = account.provider_account_id;
      if (body.action === 'save' && body.answers) {
        const saved = await moovFetch(`/accounts/${id}/underwriting`, {
          method: 'PUT',
          scopes: scopes.accountWrite(id),
          body: body.answers,
          fetchImpl,
        });
        return jsonResult({ success: true, underwriting: saved, liveProviderCalled: true });
      }
      const data = await moovFetch(`/accounts/${id}/underwriting`, { scopes: scopes.accountRead(id), fetchImpl });
      return jsonResult({ success: true, underwriting: data, liveProviderCalled: true });
    },
  },
  'moov-account-onboard': accountOnboard,
  'moov-account-file-upload': accountFileUpload,
  'moov-account-file-view': accountFileView,
  'moov-onboarding-link': onboardingLink,
  'moov-wallet-fund': walletFund,
  'moov-bank-account-add': bankAccountAdd,
  'moov-bank-link-token': bankLinkToken,
  'moov-micro-deposit-initiate': microDepositInitiate,
  'moov-micro-deposit-confirm': microDepositConfirm,
  'moov-plaid-bridge': plaidBridge,
  'moov-platform-bank': platformBank,
  'moov-recipient-create': recipientCreate,
  'moov-recipient-session': recipientSession,
  'moov-recipient-tos-accept': recipientTosAccept,
  'moov-recipient-kyc-update': recipientKycUpdate,
  'moov-recipient-bank-add': recipientBankAdd,
  'moov-recipient-bank-verify': recipientBankVerify,
  'moov-recipient-disconnect': recipientDisconnect,
  'moov-transfer-create': transferCreate,
  'moov-transfer-group-create': transferGroupCreate,
  'moov-disburse': disburse,
  'moov-tenant-fee-charge': tenantFeeCharge,
  'moov-fee-schedule-upsert': feeScheduleUpsert,
  'moov-fee-schedule-cancel': feeScheduleCancel,
  'moov-fee-rollup': feeRollup,
  'moov-sweep-config': sweepConfig,
  'moov-invoice': invoice,
  'moov-bulk-import-preview': bulkImportPreview,
  'initiate-wallet-funding': initiateWalletFunding,
  'cancel-wallet-funding': cancelWalletFunding,
  'calculate-payment-funding': calculatePaymentFunding,
  'process-funded-payment': processFundedPayment,
  'wallet-fund-on-clear': walletFundOnClear,
  'platform-treasury': platformTreasury,
  'homeowner-deductible-pay': homeownerDeductiblePay,
  'stakeholder-resend-verification': stakeholderResendVerification,
  'public-invoice': publicInvoice,
};

export const MOOV_PARITY_HANDLERS = Object.fromEntries(
  Object.entries(HANDLERS).map(([name, handler]) => [name, wrap(handler)]),
);
