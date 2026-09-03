/**
 * Temporary no-VPC sidecar for real Moov sandbox + CheckAlt UAT HTTP.
 * Reads checksops/staging/providers in-process. Never logs or returns secret values.
 * Production flags are not read or changed here. Delete this Lambda after the run.
 */
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import {
  CHECKALT_UAT_HOST,
  classifyCheckAltSandbox,
  classifyMoovSandbox,
  isApprovedCheckAltMerchant,
  isApprovedCheckAltUatUrl,
  merchantHeaderForCheckAltUat,
} from '../../functions/api/sandbox-credentials.mjs';
import {
  SANDBOX_MIN_CENTS,
  buildMoovSandboxTransferBody,
  collectMoovAccountIds,
  collectMoovPaymentMethods,
  collectMoovTransferIds,
  moovSandboxFetch,
  moovSandboxScopes,
  moovSandboxToken,
  normalizeMoovSandboxTransfer,
  redactProviderId,
} from '../../functions/api/providers/moov-sandbox.mjs';
import {
  CHECKALT_USER_AMOUNT,
  buildCheckAltUatDepositBody,
  checkAltSandboxAuthenticate,
  checkAltSandboxFetch,
  extractCheckAltAmountEcho,
  extractCheckAltReference,
  extractCheckAltSsoAndAccount,
  extractCheckAltStatus,
} from '../../functions/api/providers/checkalt-sandbox.mjs';

const SECRET_ID = process.env.PROVIDER_SECRETS_ARN || 'checksops/staging/providers';
const MOOV_VERSION = 'v2024.01.00';
const MARKER = `AWS-UAT-${Date.now()}`;

const redactId = (value) => redactProviderId(value);

const dropSensitive = (value, depth = 0) => {
  if (value == null || depth > 8) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => dropSensitive(item, depth + 1));
  if (typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (/^(password|secret|token|authorization|accountnumber|routingnumber|ssn|frontimage|rearimage|rawtoken|rawreference|secretstring|access_token)$/i.test(key)) {
      out[key] = item == null ? null : '[redacted]';
      continue;
    }
    out[key] = dropSensitive(item, depth + 1);
  }
  return out;
};

const loadSecrets = async () => {
  const sm = new SecretsManagerClient({});
  const response = await sm.send(new GetSecretValueCommand({ SecretId: SECRET_ID }));
  const parsed = JSON.parse(response.SecretString || '{}');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('provider secret JSON is invalid');
  }
  return parsed;
};

const credentialsFromSecrets = (secrets) => {
  const moovSnap = classifyMoovSandbox(secrets);
  const checkaltSnap = classifyCheckAltSandbox(secrets);
  return {
    snapshot: {
      moov: moovSnap,
      checkalt: checkaltSnap,
      productionKeyNamesPresent: ['MOOV_PUBLIC_KEY', 'MOOV_SECRET_KEY', 'CHECKALT_USERNAME', 'CHECKALT_PASSWORD']
        .filter((key) => Boolean(secrets[key])),
    },
    moov: moovSnap.available
      ? {
        environment: 'sandbox',
        host: 'https://api.moov.io',
        publicKey: secrets.MOOV_SANDBOX_PUBLIC_KEY,
        secretKey: secrets.MOOV_SANDBOX_SECRET_KEY,
        platformAccountId: secrets.MOOV_SANDBOX_PLATFORM_ACCOUNT_ID || null,
        origin: secrets.MOOV_SANDBOX_ALLOWED_ORIGIN || 'https://checksops.com',
        webhookSecret: secrets.MOOV_SANDBOX_WEBHOOK_SECRET || null,
        apiVersion: MOOV_VERSION,
      }
      : null,
    checkalt: checkaltSnap.available
      ? {
        environment: 'uat',
        baseUrl: CHECKALT_UAT_HOST,
        username: secrets.CHECKALT_UAT_USER_ID,
        userId: secrets.CHECKALT_UAT_USER_ID,
        password: secrets.CHECKALT_UAT_PASSWORD,
        fiKey: secrets.CHECKALT_UAT_FI_KEY || null,
        merchant: merchantHeaderForCheckAltUat(secrets.CHECKALT_UAT_MERCHANT),
        webhookSecret: secrets.CHECKALT_SANDBOX_WEBHOOK_SECRET || null,
        authPath: '/public/jwtauth/authenticate',
      }
      : null,
  };
};

const historyItems = (data) => {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  return data.depositHistoryList || data.depositList || data.items || data.deposits || [];
};

const validateMoov = async (loaded, productionAccountIds, productionWalletIds) => {
  const report = {
    authentication: null,
    isolation: null,
    reads: null,
    transfer: null,
    retrieve: null,
    duplicate: null,
    rapidRetry: null,
    providerTransactionCount: null,
    webhook: {
      secretConfigured: Boolean(loaded.moov?.webhookSecret),
      executed: false,
      reason: loaded.moov?.webhookSecret ? 'not_posted_from_sidecar' : 'sandbox_webhook_secret_unavailable',
    },
    failure: null,
    cancel: null,
    apiVersion: MOOV_VERSION,
    pinnedVersionUnchanged: true,
    stopped: false,
  };
  if (!loaded.moov) {
    report.authentication = { ok: false, error: 'sandbox_credentials_unavailable' };
    report.stopped = true;
    return report;
  }
  const auth = await moovSandboxToken({
    credentials: loaded.moov,
    scopes: moovSandboxScopes.accountsRead(),
  });
  report.authentication = {
    ok: auth.ok === true,
    tokenPresent: Boolean(auth.accessTokenPresent || auth.token),
    tokenType: auth.tokenType || null,
    grantedScope: auth.grantedScope || null,
    error: auth.ok ? null : auth.error,
    httpStatus: auth.httpStatus || auth.statusCode || null,
  };
  if (!auth.ok) {
    report.stopped = true;
    return report;
  }
  let listed = await moovSandboxFetch({
    credentials: loaded.moov,
    path: '/accounts?count=50',
    scopes: moovSandboxScopes.accountsRead(),
    token: auth.token,
  });
  if (!listed.ok) {
    listed = await moovSandboxFetch({
      credentials: loaded.moov,
      path: '/accounts',
      scopes: moovSandboxScopes.accountsRead(),
      token: auth.token,
    });
  }
  const listedDataKeys = listed.data && typeof listed.data === 'object' && !Array.isArray(listed.data)
    ? Object.keys(listed.data).sort()
    : (Array.isArray(listed.data) ? ['<array>'] : []);
  const listedIds = collectMoovAccountIds(listed.data);
  const overlapping = listedIds.filter((id) => productionAccountIds.includes(id));
  const isolatedIds = listedIds.filter((id) => !productionAccountIds.includes(id));
  if (loaded.moov.platformAccountId && productionAccountIds.includes(loaded.moov.platformAccountId)) {
    overlapping.push(loaded.moov.platformAccountId);
  }
  let productionVisibleToSandbox = 0;
  const productionProbes = [];
  for (const prodId of productionAccountIds.slice(0, 8)) {
    const probe = await moovSandboxFetch({
      credentials: loaded.moov,
      path: `/accounts/${prodId}`,
      scopes: moovSandboxScopes.accountRead(prodId),
    });
    const visible = probe.ok === true;
    if (visible) productionVisibleToSandbox += 1;
    productionProbes.push({
      httpStatus: probe.statusCode || probe.httpStatus || null,
      visible,
    });
  }
  report.isolation = {
    listedAccountCount: listedIds.length,
    isolatedAccountCount: isolatedIds.length,
    overlappingAccountCount: overlapping.length,
    productionOverlap: overlapping.length > 0 || productionVisibleToSandbox > 0,
    sandboxIdentityProven: listed.ok === true && overlapping.length === 0 && isolatedIds.length > 0 && productionVisibleToSandbox === 0,
    listedOk: listed.ok === true,
    listedHttpStatus: listed.statusCode || listed.httpStatus || null,
    listedError: listed.ok ? null : listed.error,
    listedMessage: listed.ok ? null : listed.message,
    listedDataKeys,
    productionAccountsVisibleToSandbox: productionVisibleToSandbox,
    productionAccountProbes: productionProbes,
  };
  if (productionVisibleToSandbox > 0 || overlapping.length > 0) {
    report.stopped = true;
    report.isolation.stopReason = 'production_provider_id_refused';
    return report;
  }
  if (!listed.ok || isolatedIds.length === 0) {
    report.stopped = true;
    report.isolation.stopReason = listed.ok ? 'no_isolated_sandbox_account' : (listed.error || 'moov_list_failed');
    return report;
  }
  const accountId = isolatedIds[0];
  if (productionWalletIds.length && productionWalletIds.includes(accountId)) {
    report.stopped = true;
    report.isolation.productionOverlap = true;
    report.isolation.stopReason = 'production_provider_id_refused';
    return report;
  }
  const account = await moovSandboxFetch({
    credentials: loaded.moov,
    path: `/accounts/${accountId}`,
    scopes: moovSandboxScopes.accountRead(accountId),
  });
  const wallets = await moovSandboxFetch({
    credentials: loaded.moov,
    path: `/accounts/${accountId}/wallets`,
    scopes: moovSandboxScopes.accountRead(accountId),
  });
  const methods = await moovSandboxFetch({
    credentials: loaded.moov,
    path: `/accounts/${accountId}/payment-methods`,
    scopes: moovSandboxScopes.paymentMethodsRead(accountId),
  });
  const caps = await moovSandboxFetch({
    credentials: loaded.moov,
    path: `/accounts/${accountId}/capabilities`,
    scopes: moovSandboxScopes.capabilitiesRead(accountId),
  });
  const isolatedMethods = collectMoovPaymentMethods(methods.data);
  for (const extraId of isolatedIds.slice(1, 4)) {
    const extra = await moovSandboxFetch({
      credentials: loaded.moov,
      path: `/accounts/${extraId}/payment-methods`,
      scopes: moovSandboxScopes.paymentMethodsRead(extraId),
    });
    isolatedMethods.push(...collectMoovPaymentMethods(extra.data));
  }
  const uniqueMethods = [];
  const seen = new Set();
  for (const row of isolatedMethods) {
    if (!row.id || seen.has(row.id) || productionWalletIds.includes(row.id) || productionAccountIds.includes(row.id)) continue;
    seen.add(row.id);
    uniqueMethods.push(row);
  }
  report.reads = {
    account: { ok: account.ok === true, redactedId: redactId(accountId), httpStatus: account.statusCode || account.httpStatus || null },
    wallets: { ok: wallets.ok === true, count: Array.isArray(wallets.data) ? wallets.data.length : null },
    paymentMethods: { ok: methods.ok === true, count: uniqueMethods.length },
    capabilities: { ok: caps.ok === true, count: Array.isArray(caps.data) ? caps.data.length : (caps.data ? 1 : null) },
  };
  const source = uniqueMethods[0];
  const destination = uniqueMethods.find((row) => row.id !== source?.id) || null;
  if (!source?.id || !destination?.id) {
    report.transfer = {
      ok: false,
      error: 'sandbox_account_unmapped',
      amountCents: SANDBOX_MIN_CENTS,
      message: 'Isolated sandbox account does not expose two payment methods. No transfer was created. Production IDs were not used.',
    };
    return report;
  }
  const transferBody = buildMoovSandboxTransferBody({
    sourcePaymentMethodId: source.id,
    destinationPaymentMethodId: destination.id,
    amountCents: SANDBOX_MIN_CENTS,
    description: `${MARKER} 1cent`,
  });
  const idempotencyKey = `${MARKER}-moov-1cent`;
  const created = await moovSandboxFetch({
    credentials: loaded.moov,
    path: `/accounts/${accountId}/transfers`,
    method: 'POST',
    scopes: moovSandboxScopes.transfersWrite(accountId),
    body: transferBody,
    idempotencyKey,
  });
  const normalized = created.ok ? normalizeMoovSandboxTransfer(created.data || {}) : null;
  report.transfer = {
    ok: created.ok === true,
    error: created.ok ? null : created.error,
    httpStatus: created.httpStatus || created.statusCode || null,
    amountCents: SANDBOX_MIN_CENTS,
    amountUsd: '$0.01',
    providerReference: redactId(normalized?.provider_transfer_id),
    status: normalized?.status || null,
    message: created.ok ? null : created.message,
  };
  if (!created.ok) {
    report.failure = {
      providerRejected: true,
      httpStatus: created.httpStatus || created.statusCode || null,
      error: created.error,
      reconciliation: 'report-only; no AWS money ledger write was attempted',
    };
    return report;
  }
  const retrieved = await moovSandboxFetch({
    credentials: loaded.moov,
    path: `/accounts/${accountId}/transfers/${normalized.provider_transfer_id}`,
    scopes: moovSandboxScopes.transfersRead(accountId),
  });
  report.retrieve = {
    ok: retrieved.ok === true,
    providerReference: redactId(normalized.provider_transfer_id),
    status: retrieved.data?.status || null,
    amountValue: retrieved.data?.amount?.value ?? null,
  };
  const duplicate = await moovSandboxFetch({
    credentials: loaded.moov,
    path: `/accounts/${accountId}/transfers`,
    method: 'POST',
    scopes: moovSandboxScopes.transfersWrite(accountId),
    body: transferBody,
    idempotencyKey,
  });
  const duplicateId = duplicate.ok
    ? (duplicate.data?.transferID || duplicate.data?.transferId || duplicate.data?.id)
    : null;
  report.duplicate = {
    ok: duplicate.ok === true,
    sameProviderObject: Boolean(duplicateId && duplicateId === normalized.provider_transfer_id),
    providerReference: redactId(duplicateId),
    httpStatus: duplicate.httpStatus || duplicate.statusCode || null,
  };
  const rapid = await moovSandboxFetch({
    credentials: loaded.moov,
    path: `/accounts/${accountId}/transfers`,
    method: 'POST',
    scopes: moovSandboxScopes.transfersWrite(accountId),
    body: transferBody,
    idempotencyKey,
  });
  const rapidId = rapid.ok ? (rapid.data?.transferID || rapid.data?.transferId || rapid.data?.id) : null;
  report.rapidRetry = {
    ok: rapid.ok === true,
    sameProviderObject: Boolean(rapidId && rapidId === normalized.provider_transfer_id),
    providerReference: redactId(rapidId),
  };
  const listedTransfers = await moovSandboxFetch({
    credentials: loaded.moov,
    path: `/accounts/${accountId}/transfers`,
    scopes: moovSandboxScopes.transfersRead(accountId),
  });
  const listedTransferIds = collectMoovTransferIds(listedTransfers.data);
  const matching = listedTransferIds.filter((id) => id === normalized.provider_transfer_id);
  report.providerTransactionCount = {
    matchingCreatedId: matching.length,
    listedCount: listedTransferIds.length,
    expected: 1,
    oneChecksOpsOpOneProviderObject: matching.length === 1
      && report.duplicate.sameProviderObject === true
      && report.rapidRetry.sameProviderObject === true,
  };
  const cancelled = await moovSandboxFetch({
    credentials: loaded.moov,
    path: `/accounts/${accountId}/transfers/${normalized.provider_transfer_id}/cancel`,
    method: 'POST',
    scopes: moovSandboxScopes.transfersWrite(accountId),
  });
  report.cancel = {
    attempted: true,
    ok: cancelled.ok === true,
    httpStatus: cancelled.httpStatus || cancelled.statusCode || null,
    error: cancelled.ok ? null : cancelled.error,
    supported: cancelled.ok === true || cancelled.httpStatus === 409,
  };
  const invalid = await moovSandboxFetch({
    credentials: loaded.moov,
    path: `/accounts/${accountId}/transfers`,
    method: 'POST',
    scopes: moovSandboxScopes.transfersWrite(accountId),
    body: buildMoovSandboxTransferBody({
      sourcePaymentMethodId: '00000000-0000-4000-8000-000000000000',
      destinationPaymentMethodId: destination.id,
      amountCents: SANDBOX_MIN_CENTS,
      description: `${MARKER} failure`,
    }),
    idempotencyKey: `${MARKER}-moov-fail`,
  });
  report.failure = {
    providerRejected: invalid.ok !== true,
    httpStatus: invalid.httpStatus || invalid.statusCode || null,
    error: invalid.ok ? 'unexpected_success' : invalid.error,
    reconciliation: 'report-only; sidecar does not write payment_transfers or homeowner_ledger_events',
  };
  return report;
};

const countMatchingDeposits = (items, marker) => items.filter((row) => {
  const blob = JSON.stringify(dropSensitive(row));
  return blob.includes(marker) || String(extractCheckAltReference(row) || '').includes(marker);
}).length;

const validateCheckAlt = async (loaded) => {
  const report = {
    authentication: null,
    hostApproved: isApprovedCheckAltUatUrl(CHECKALT_UAT_HOST),
    merchantHeader: 'lockbox5',
    merchantApproved: true,
    account: null,
    depositAccount: null,
    registeredTestAccount: false,
    amountUnit: CHECKALT_USER_AMOUNT,
    deposits: [],
    duplicate: null,
    providerDepositCount: null,
    processApprovalHistory: null,
    failure: null,
    webhook: {
      secretConfigured: Boolean(loaded.checkalt?.webhookSecret),
      executed: false,
      reason: loaded.checkalt?.webhookSecret ? 'not_posted_from_sidecar' : 'sandbox_webhook_secret_unavailable',
    },
    stopped: false,
    negotiableCheckSubmitted: false,
  };
  if (!loaded.checkalt) {
    report.authentication = { ok: false, error: 'sandbox_credentials_unavailable' };
    report.stopped = true;
    return report;
  }
  if (!isApprovedCheckAltUatUrl(loaded.checkalt.baseUrl) || loaded.checkalt.baseUrl !== CHECKALT_UAT_HOST) {
    report.authentication = { ok: false, error: 'uat_host_refused' };
    report.stopped = true;
    return report;
  }
  if (!isApprovedCheckAltMerchant(loaded.checkalt.merchant) || merchantHeaderForCheckAltUat(loaded.checkalt.merchant) !== 'lockbox5') {
    report.authentication = { ok: false, error: 'uat_merchant_refused' };
    report.merchantApproved = false;
    report.stopped = true;
    return report;
  }
  const auth = await checkAltSandboxAuthenticate({ credentials: loaded.checkalt });
  report.authentication = {
    ok: auth.ok === true,
    tokenPresent: Boolean(auth.tokenPresent || auth.rawToken),
    authPath: auth.authPath || null,
    httpStatus: auth.httpStatus || auth.statusCode || null,
    error: auth.ok ? null : auth.error,
  };
  if (!auth.ok) {
    report.stopped = true;
    return report;
  }
  const user = await checkAltSandboxFetch({
    credentials: loaded.checkalt,
    path: '/fincapture/useraccount/getUserAccountInformation',
    body: { fiKey: loaded.checkalt.fiKey, userId: loaded.checkalt.userId },
    token: auth.rawToken,
  });
  const extractedFromUser = extractCheckAltSsoAndAccount(user.data, {});
  const depositAccount = await checkAltSandboxFetch({
    credentials: loaded.checkalt,
    path: '/fincapture/useraccount/getDepositAccountInformation',
    body: {
      fiKey: loaded.checkalt.fiKey,
      userId: loaded.checkalt.userId,
      ...(extractedFromUser.depositAccountNumber ? { accountNumber: extractedFromUser.depositAccountNumber } : {}),
    },
    token: auth.rawToken,
  });
  const extracted = extractCheckAltSsoAndAccount(user.data, depositAccount.data);
  report.account = {
    ok: user.ok === true,
    httpStatus: user.statusCode || user.httpStatus || null,
    hasSsoKey: extracted.hasSsoKey,
    accountCount: extracted.accountCount,
    userObjectKeys: extracted.userObjectKeys,
    accountObjectKeys: extracted.accountObjectKeys,
    isValidUser: user.data?.isValidUser ?? null,
    error: user.ok ? null : user.error,
  };
  report.depositAccount = {
    ok: depositAccount.ok === true,
    httpStatus: depositAccount.statusCode || depositAccount.httpStatus || null,
    hasDepositAccount: extracted.hasDepositAccount,
    error: depositAccount.ok ? null : depositAccount.error,
    message: depositAccount.message || null,
  };
  if (!extracted.hasDepositAccount || !extracted.hasSsoKey) {
    report.stopped = true;
    report.failure = {
      error: 'account_unregistered',
      registeredTestAccount: false,
      reason: 'UAT user has no ssoKey/deposit account for FinCapture capture. Registration skipped; inventing bank numbers is refused.',
    };
    return report;
  }
  const beforeHistory = await checkAltSandboxFetch({
    credentials: loaded.checkalt,
    path: '/fincapture/deposit/history',
    body: { fiKey: loaded.checkalt.fiKey, ssoKey: extracted.ssoKey || loaded.checkalt.userId },
    token: auth.rawToken,
  });
  const beforeItems = historyItems(beforeHistory.data);
  const fixtures = [
    { fixture: 'min', cents: 1, dollars: '$0.01' },
    { fixture: 'dollar', cents: 100, dollars: '$1.00' },
    { fixture: 'cert', cents: 12345, dollars: '$123.45' },
  ];
  for (const item of fixtures) {
    const packed = buildCheckAltUatDepositBody({
      credentials: loaded.checkalt,
      amountCents: item.cents,
      reference: `${MARKER}-${item.fixture}`,
      ssoKey: extracted.ssoKey,
      depositAccountNumber: extracted.depositAccountNumber,
    });
    const submitted = await checkAltSandboxFetch({
      credentials: loaded.checkalt,
      path: '/fincapture/deposit/process',
      body: packed.request,
      token: auth.rawToken,
    });
    const reference = extractCheckAltReference(submitted.data);
    const echo = extractCheckAltAmountEcho(submitted.data);
    const inferred = echo.echoedUserAmount == null
      ? 'not_echoed'
      : (Number(echo.echoedUserAmount) === item.cents ? 'integer_cents' : 'unconfirmed');
    report.deposits.push({
      fixture: item.fixture,
      checksOpsCents: item.cents,
      sentUserAmount: packed.meta.userAmount,
      expectedUsd: item.dollars,
      ok: submitted.ok === true,
      httpStatus: submitted.statusCode || submitted.httpStatus || null,
      error: submitted.ok ? null : submitted.error,
      message: submitted.message || echo.statusDescription || null,
      providerReference: redactId(reference),
      rawReference: reference,
      amountEcho: echo,
      inferredScale: inferred,
      negotiableCheck: false,
      imageKind: 'synthetic_void_png',
    });
  }
  const first = report.deposits[0];
  const firstPacked = buildCheckAltUatDepositBody({
    credentials: loaded.checkalt,
    amountCents: 1,
    reference: `${MARKER}-min`,
    ssoKey: extracted.ssoKey,
    depositAccountNumber: extracted.depositAccountNumber,
  });
  const duplicate = await checkAltSandboxFetch({
    credentials: loaded.checkalt,
    path: '/fincapture/deposit/process',
    body: firstPacked.request,
    token: auth.rawToken,
  });
  const duplicateRef = extractCheckAltReference(duplicate.data);
  report.duplicate = {
    ok: duplicate.ok === true || duplicate.httpStatus === 409,
    httpStatus: duplicate.statusCode || duplicate.httpStatus || null,
    error: duplicate.ok ? null : duplicate.error,
    sameProviderObject: Boolean(first?.rawReference && duplicateRef && duplicateRef === first.rawReference),
    providerReference: redactId(duplicateRef),
    message: 'Second process used the same synthetic payload. Provider-side uniqueness is counted from history, not assumed.',
  };
  const afterHistory = await checkAltSandboxFetch({
    credentials: loaded.checkalt,
    path: '/fincapture/deposit/history',
    body: { fiKey: loaded.checkalt.fiKey, ssoKey: extracted.ssoKey || loaded.checkalt.userId },
    token: auth.rawToken,
  });
  const afterItems = historyItems(afterHistory.data);
  const createdRefs = report.deposits.map((row) => row.rawReference).filter(Boolean);
  const uniqueRefs = [...new Set(createdRefs)];
  report.providerDepositCount = {
    historyBeforeCount: beforeItems.length,
    historyAfterCount: afterItems.length,
    historyDelta: afterItems.length - beforeItems.length,
    matchingMarker: countMatchingDeposits(afterItems, MARKER),
    uniqueProcessReferences: uniqueRefs.length,
    processAttempts: report.deposits.length + 1,
  };
  let itemStatus = null;
  const firstRaw = first?.rawReference || null;
  if (firstRaw) {
    const item = await checkAltSandboxFetch({
      credentials: loaded.checkalt,
      path: '/fincapture/deposit/item',
      body: { fiKey: loaded.checkalt.fiKey, referenceNumber: firstRaw },
      token: auth.rawToken,
    });
    itemStatus = {
      ok: item.ok === true,
      status: extractCheckAltStatus(item.data),
      httpStatus: item.statusCode || item.httpStatus || null,
    };
  }
  let approved = { attempted: false, reason: 'not_required_or_no_reference' };
  const needsApprove = /pending|awaiting|approval/i.test(String(report.deposits[0]?.amountEcho?.statusDescription || ''));
  if (needsApprove && firstRaw) {
    const approve = await checkAltSandboxFetch({
      credentials: loaded.checkalt,
      path: '/fincapture/deposit/approve',
      body: { fiKey: loaded.checkalt.fiKey, referenceNumber: firstRaw },
      token: auth.rawToken,
    });
    approved = {
      attempted: true,
      ok: approve.ok === true,
      httpStatus: approve.statusCode || approve.httpStatus || null,
      error: approve.ok ? null : approve.error,
    };
  }
  report.processApprovalHistory = {
    historyOk: afterHistory.ok === true,
    item: itemStatus,
    approve: approved,
  };
  const inferred = report.deposits.map((row) => row.inferredScale);
  report.amountUnitDetermination = {
    field: 'userAmount',
    sent: report.deposits.map((row) => ({
      checksOpsCents: row.checksOpsCents,
      sentUserAmount: row.sentUserAmount,
      expectedUsd: row.expectedUsd,
      echoedUserAmount: row.amountEcho?.echoedUserAmount ?? null,
      inferredScale: row.inferredScale,
      ok: row.ok,
    })),
    documentedProductionEvidence: CHECKALT_USER_AMOUNT.evidence,
    liveUatScale: inferred.every((value) => value === 'integer_cents')
      ? 'integer_cents'
      : (inferred.some((value) => value === 'integer_cents') ? 'partial_integer_cents' : 'not_echoed_or_unconfirmed'),
  };
  if (!report.deposits.some((row) => row.ok)) {
    report.failure = {
      providerRejected: true,
      firstError: report.deposits[0]?.error || null,
      firstMessage: report.deposits[0]?.message || null,
      reconciliation: 'report-only; checkalt_deposits production table was not written',
    };
  }
  return report;
};

export const handler = async (event = {}) => {
  const productionAccountIds = [...new Set((event.productionAccountIds || [])
    .map((row) => row?.provider_account_id || row)
    .filter(Boolean)
    .map((id) => String(id)))];
  const productionWalletIds = [...new Set((event.productionWalletIds || [])
    .map((row) => row?.provider_wallet_id || row)
    .filter(Boolean)
    .map((id) => String(id)))];
  const secrets = await loadSecrets();
  const keyNames = Object.keys(secrets).sort();
  const loaded = credentialsFromSecrets(secrets);
  const moov = await validateMoov(loaded, productionAccountIds, productionWalletIds);
  const checkalt = await validateCheckAlt(loaded);
  return dropSensitive({
    ok: true,
    marker: MARKER,
    productionExecution: false,
    productionFlagsTouched: false,
    productionWebhooksRedirected: false,
    dnsChanged: false,
    frontendDeployed: false,
    secretPresence: {
      keyNames,
      requiredPresent: [
        'MOOV_SANDBOX_PUBLIC_KEY',
        'MOOV_SANDBOX_SECRET_KEY',
        'CHECKALT_UAT_BASE_URL',
        'CHECKALT_UAT_USER_ID',
        'CHECKALT_UAT_PASSWORD',
        'CHECKALT_UAT_FI_KEY',
        'CHECKALT_UAT_MERCHANT',
      ].every((key) => Boolean(secrets[key])),
      productionKeyNamesPresent: loaded.snapshot.productionKeyNamesPresent,
      checkaltHostApproved: loaded.snapshot.checkalt.dedicatedUatUrlApproved,
      checkaltMerchantApproved: loaded.snapshot.checkalt.merchantApproved,
    },
    capability: {
      moov: loaded.snapshot.moov,
      checkalt: loaded.snapshot.checkalt,
    },
    productionIdCounts: {
      accounts: productionAccountIds.length,
      wallets: productionWalletIds.length,
    },
    moov,
    checkalt,
  });
};
