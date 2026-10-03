/**
 * Direct-invoke only. Proves durable bank-verify DynamoDB access without
 * enabling recipient bank-verify writes, or touching money flags.
 * Synthetic keys are prefixed PROBE#m64d2#. Not reachable from HTTP API paths.
 * Lambda must never perform table-admin APIs (operator-only).
 * action=preflight_target is GET-only Moov + GetItem of the real claim key.
 */
import { randomUUID } from 'node:crypto';
import {
  executionAllowed,
  providerEnabled,
  providerExecutionEnabled,
  providerRecipientBankVerifyWritesEnabled,
} from '../provider-flags.mjs';
import { providerSandboxExecutionEnabled } from '../sandbox-flags.mjs';
import {
  BANK_VERIFY_STATE_TABLE_ENV,
  claimPartitionKey,
  createDynamoBankVerifyStore,
  tokenFingerprint,
  ttlEpochSeconds,
} from './recipient-bank-verify-state.mjs';
import { dynamoJsonRequest, dynamoN, dynamoS, fromDynamo } from './dynamodb-json.mjs';
import { loadProductionMoovReadSecrets } from './production/moov-secrets.mjs';
import { productionMoovFetch, redactMoovText } from './production/moov-client.mjs';
import {
  bindLiveRecipientBank,
  interpretRecipientBankVerification,
  kycStatusFromMoov,
  liveTosAccepted,
} from './moov-recipient-tos-policy.mjs';

export const BANK_VERIFY_STATE_PROBE_PK_PREFIX = 'PROBE#m64d2#';
export const BANK_VERIFY_STATE_TABLE_NAME = 'checksops-recipient-bank-verify-state';
export const BANK_VERIFY_STATE_TABLE_ARN = 'arn:aws:dynamodb:us-east-1:806168576068:table/checksops-recipient-bank-verify-state';
export const PREFLIGHT_TARGET = Object.freeze({
  recipientId: '62a858ff-ee6a-49d7-9898-1c8e4a44227b',
  accountId: 'ee8c608e-dc2d-45d3-95e9-3c992f3dfc5f',
  bankId: '72eb66c1-d9a9-4f85-ab50-8871db9ceeea',
  lastFour: '1506',
});

const financialPermissionsActivated = () =>
  String(process.env.AWS_FINANCIAL_PERMISSIONS_ACTIVATED || '') === 'true';

const moneyFlagsOn = () => (
  providerExecutionEnabled()
  || providerEnabled('moov')
  || providerEnabled('checkalt')
  || executionAllowed('moov')
  || financialPermissionsActivated()
  || providerSandboxExecutionEnabled()
);

const tableName = () => String(
  process.env[BANK_VERIFY_STATE_TABLE_ENV] || BANK_VERIFY_STATE_TABLE_NAME
).trim();

const capture = async (label, fn) => {
  try {
    const result = await fn();
    return { ok: true, label, result };
  } catch (error) {
    return {
      ok: false,
      label,
      error: error?.code || 'error',
      status: error?.status || null,
      message: String(error?.message || error).slice(0, 300),
    };
  }
};

export const isBankVerifyStateProbeEvent = (event) => (
  event != null
  && typeof event === 'object'
  && event.checksops_bank_verify_state_probe === true
  && !event.requestContext
  && !event.rawPath
);

const expireSynthetic = (request, table, key, sk, nowMs) => request({
  target: 'DynamoDB_20120810.UpdateItem',
  body: {
    TableName: table,
    Key: { pk: dynamoS(key), sk: dynamoS(sk) },
    UpdateExpression: 'SET #ttl = :ttl',
    ConditionExpression: 'attribute_exists(pk)',
    ExpressionAttributeNames: { '#ttl': 'ttl' },
    ExpressionAttributeValues: { ':ttl': dynamoN(ttlEpochSeconds(nowMs, 60)) },
  },
});

const listOf = (payload) => {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.bankAccounts)) return payload.bankAccounts;
  if (Array.isArray(payload?.capabilities)) return payload.capabilities;
  if (Array.isArray(payload?.paymentMethods)) return payload.paymentMethods;
  return [];
};

const publicBank = (bank) => {
  if (!bank || typeof bank !== 'object') return null;
  return {
    bankAccountID: bank.bankAccountID || bank.bankAccountId || null,
    bankName: bank.bankName || bank.bank_name || null,
    lastFourAccountNumber: bank.lastFourAccountNumber || bank.lastFour || null,
    status: bank.status || null,
    verificationStatus: bank.verificationStatus || null,
  };
};

const publicAccount = (account) => {
  if (!account || typeof account !== 'object') return null;
  return {
    accountID: account.accountID || account.accountId || null,
    accountType: account.accountType || null,
    mode: account.mode || null,
    verification_status: kycStatusFromMoov(account),
    tos_accepted: liveTosAccepted(account),
    tos_accepted_date: account?.termsOfService?.acceptedDate
      || account?.termsOfService?.acceptedOn
      || null,
  };
};

const safeMoovGet = async ({ credentials, path, scopes, fetchImpl }) => {
  try {
    const got = await productionMoovFetch({
      credentials,
      path,
      method: 'GET',
      mode: 'read',
      scopes,
      fetchImpl,
    });
    return { ok: true, status: got.status, json: got.json };
  } catch (error) {
    return {
      ok: false,
      status: error?.status || null,
      error: error?.code || 'moov_get_failed',
      message: redactMoovText(String(error?.message || error)).slice(0, 200),
    };
  }
};

const handlePreflightTarget = async ({ request, table, nowMs, deps }) => {
  const ids = {
    recipientId: PREFLIGHT_TARGET.recipientId,
    accountId: PREFLIGHT_TARGET.accountId,
    bankId: PREFLIGHT_TARGET.bankId,
    nowMs,
  };
  const claimPk = claimPartitionKey(ids);
  const claimGet = await capture('GetItemRealClaim', () => request({
    target: 'DynamoDB_20120810.GetItem',
    body: {
      TableName: table,
      ConsistentRead: true,
      Key: { pk: dynamoS(claimPk), sk: dynamoS('STATE') },
    },
  }));
  const claimItem = claimGet.ok && claimGet.result?.Item ? fromDynamo(claimGet.result.Item) : null;

  const secrets = await (deps.loadProductionReadSecrets || loadProductionMoovReadSecrets)(deps.getSecrets);
  const fetchImpl = deps.fetchImpl || fetch;
  const credentials = secrets.ok ? secrets.credentials : null;
  const accountId = PREFLIGHT_TARGET.accountId;
  const bankId = PREFLIGHT_TARGET.bankId;
  const scopes = {
    profile: [`/accounts/${accountId}/profile.read`],
    banks: [`/accounts/${accountId}/bank-accounts.read`],
    caps: [`/accounts/${accountId}/capabilities.read`],
    methods: [`/accounts/${accountId}/payment-methods.read`],
  };

  const accountGet = credentials
    ? await safeMoovGet({ credentials, path: `/accounts/${accountId}`, scopes: scopes.profile, fetchImpl })
    : { ok: false, error: secrets.error || 'production_secret_missing' };
  const capsGet = credentials
    ? await safeMoovGet({ credentials, path: `/accounts/${accountId}/capabilities`, scopes: scopes.caps, fetchImpl })
    : { ok: false };
  const banksGet = credentials
    ? await safeMoovGet({ credentials, path: `/accounts/${accountId}/bank-accounts`, scopes: scopes.banks, fetchImpl })
    : { ok: false };
  const bankGet = credentials
    ? await safeMoovGet({
      credentials,
      path: `/accounts/${accountId}/bank-accounts/${bankId}`,
      scopes: scopes.banks,
      fetchImpl,
    })
    : { ok: false };
  const verifyGet = credentials
    ? await safeMoovGet({
      credentials,
      path: `/accounts/${accountId}/bank-accounts/${bankId}/verify`,
      scopes: scopes.banks,
      fetchImpl,
    })
    : { ok: false };
  const methodsGet = credentials
    ? await safeMoovGet({
      credentials,
      path: `/accounts/${accountId}/payment-methods`,
      scopes: scopes.methods,
      fetchImpl,
    })
    : { ok: false };

  const banks = listOf(banksGet.json).map(publicBank).filter(Boolean);
  const bound = bindLiveRecipientBank({
    banks: listOf(banksGet.json),
    recipientLastFour: PREFLIGHT_TARGET.lastFour,
  });
  const liveBank = publicBank(bankGet.json) || banks.find((row) => row.bankAccountID === bankId) || null;
  const verification = verifyGet.ok ? (verifyGet.json || null) : null;
  const verifyMissing = verifyGet.ok === false && (verifyGet.status === 404 || verifyGet.status === 409);
  const bankState = interpretRecipientBankVerification({
    bank: bankGet.json || listOf(banksGet.json).find((row) => String(row?.bankAccountID || row?.bankAccountId) === bankId) || null,
    verification: verifyMissing ? null : verification,
  });

  const report = {
    ok: false,
    probe: 'm64e2-activation-preflight',
    action: 'preflight_target',
    table,
    tableArn: BANK_VERIFY_STATE_TABLE_ARN,
    bankVerifyWrites: providerRecipientBankVerifyWritesEnabled(),
    moneyFlags: {
      AWS_MOOV_ENABLED: providerEnabled('moov'),
      AWS_PROVIDER_EXECUTION_ENABLED: providerExecutionEnabled(),
      AWS_FINANCIAL_PERMISSIONS_ACTIVATED: financialPermissionsActivated(),
      AWS_CHECKALT_ENABLED: providerEnabled('checkalt'),
      AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: providerSandboxExecutionEnabled(),
    },
    provider_http: Boolean(credentials),
    provider_http_write: false,
    microdeposit_initiated: false,
    mv_code_submitted: false,
    lambda_table_admin: false,
    dynamo_write: false,
    target: PREFLIGHT_TARGET,
    real_target_claim: {
      pk: claimPk,
      exists: Boolean(claimItem),
      get_ok: claimGet.ok === true,
      state: claimItem?.state || null,
      claimant_id: claimItem?.claimant_id || null,
      ttl: claimItem?.ttl ?? null,
    },
    account: publicAccount(accountGet.json),
    account_get_ok: accountGet.ok === true,
    kyc_status: publicAccount(accountGet.json)?.verification_status || null,
    tos_accepted: publicAccount(accountGet.json)?.tos_accepted === true,
    tos_accepted_date: publicAccount(accountGet.json)?.tos_accepted_date || null,
    banks,
    bank_count: banks.length,
    bound_bank: bound.ok ? publicBank(bound.bank) : null,
    bound_error: bound.ok ? null : bound.error,
    live_bank: liveBank,
    verification_get: {
      ok: verifyGet.ok === true,
      status: verifyGet.status || null,
      missing: verifyMissing,
      status_value: verification?.status || null,
    },
    bank_state: bankState,
    payment_method_count: listOf(methodsGet.json).length,
    capabilities_read_ok: capsGet.ok === true,
  };
  report.ok = Boolean(
    claimGet.ok
    && accountGet.ok
    && banksGet.ok
    && !providerRecipientBankVerifyWritesEnabled()
    && !moneyFlagsOn()
  );
  return report;
};

export async function handleBankVerifyStateProbe(event = {}, deps = {}) {
  const request = deps.dynamoRequest || dynamoJsonRequest;
  const nowMs = deps.nowMs || Date.now();
  const table = tableName();

  if (moneyFlagsOn()) {
    return {
      ok: false,
      error: 'provider_execution_blocked',
      statusCode: 403,
      message: 'Money-execution flags must stay off.',
      bankVerifyWrites: providerRecipientBankVerifyWritesEnabled(),
    };
  }

  const action = String(event.action || 'prove').trim();
  if (action === 'preflight_target') {
    return handlePreflightTarget({ request, table, nowMs, deps });
  }
  if (action === 'provision' || action === 'create') {
    return {
      ok: false,
      error: 'operator_table_create_required',
      statusCode: 403,
          message: 'Lambda must not create the DynamoDB table. Apply aws/production/bank-verify-state-table.yaml from an admin principal.',
      bankVerifyWrites: providerRecipientBankVerifyWritesEnabled(),
      provider_http: false,
    };
  }

  const probeId = String(event.probe_id || `synth-${randomUUID()}`);
  const pk = `${BANK_VERIFY_STATE_PROBE_PK_PREFIX}${probeId}`;
  if (!pk.startsWith(BANK_VERIFY_STATE_PROBE_PK_PREFIX) || pk.includes('CLAIM#') || pk.includes('MV#')) {
    return { ok: false, error: 'synthetic_key_required', statusCode: 400 };
  }

  const report = {
    ok: false,
    probe: 'm64d2-bank-verify-state',
    action,
    table,
    tableArn: BANK_VERIFY_STATE_TABLE_ARN,
    bankVerifyWrites: providerRecipientBankVerifyWritesEnabled(),
    moneyFlags: {
      AWS_MOOV_ENABLED: providerEnabled('moov'),
      AWS_PROVIDER_EXECUTION_ENABLED: providerExecutionEnabled(),
      AWS_FINANCIAL_PERMISSIONS_ACTIVATED: financialPermissionsActivated(),
      AWS_CHECKALT_ENABLED: providerEnabled('checkalt'),
      AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: providerSandboxExecutionEnabled(),
    },
    synthetic_pk: pk,
    provider_http: false,
    microdeposit_initiated: false,
    mv_code_submitted: false,
    lambda_table_admin: false,
  };

  if (action === 'prove') {
    report.describe = await capture('DescribeTable', () => request({
      target: 'DynamoDB_20120810.DescribeTable',
      body: { TableName: table },
    }));
  }

  if (action === 'prove' || action === 'cas') {
    const store = deps.bankVerifyStore || createDynamoBankVerifyStore({
      tableName: table,
      dynamoRequest: request,
      nowMsFn: () => nowMs,
    });
    const ids = {
      recipientId: pk,
      accountId: 'probe-account',
      bankId: 'probe-bank',
      tenantId: 'probe-tenant',
      tokenFp: tokenFingerprint(`probe-${probeId}`),
      nowMs,
      claimantId: 'm64d2-probe',
      idempotencyKey: `probe:${probeId}`,
    };
    report.getEmpty = await capture('GetItem', () => store.getClaim(ids));
    report.casWinner = await capture('PutItemCAS', () => store.claimInitiation(ids));
    report.casLoser = await capture('PutItemCASLoser', () => store.claimInitiation({ ...ids, claimantId: 'm64d2-probe-loser' }));
    report.rateLimit = [];
    for (let i = 0; i < 4; i += 1) {
      report.rateLimit.push(await capture(`UpdateItemMV${i + 1}`, () => store.consumeMvAttempt(ids)));
    }
    report.getAfter = await capture('GetItemAfter', () => store.getClaim(ids));
  }

  const claimPk = `CLAIM#${pk}#probe-account#probe-bank`;
  const mvPk = `MV#${pk}#probe-account#probe-bank#${tokenFingerprint(`probe-${probeId}`)}#confirm`;
  const mvSk = `W#${Math.floor(nowMs / (15 * 60 * 1000)) * (15 * 60 * 1000)}`;
  report.cleanupClaim = await capture('ExpireClaimTtl', () => expireSynthetic(request, table, claimPk, 'STATE', nowMs));
  report.cleanupMv = await capture('ExpireMvTtl', () => expireSynthetic(request, table, mvPk, mvSk, nowMs));

  report.ok = Boolean(
    (action === 'cas' || report.describe?.ok)
    && report.casWinner?.ok
    && report.casLoser?.ok
    && report.casLoser?.result?.claimed === false
    && report.rateLimit?.[0]?.ok
    && report.rateLimit?.[3]?.result?.ok === false
  );
  if (report.casWinner?.result?.claimed === true && report.casLoser?.result?.claimed === false) {
    report.putitem_cas_proof = true;
  }
  if (report.getEmpty?.ok || report.getAfter?.ok) report.getitem_proof = true;
  if (Array.isArray(report.rateLimit) && report.rateLimit.filter((row) => row.result?.ok).length === 3
    && report.rateLimit[3]?.result?.ok === false) {
    report.updateitem_rate_limit_proof = true;
  }
  report.synthetic_item_cleaned = Boolean(
    report.cleanupClaim?.ok || report.cleanupClaim?.error === 'ConditionalCheckFailedException'
  ) && Boolean(
    report.cleanupMv?.ok || report.cleanupMv?.error === 'ConditionalCheckFailedException'
  );
  report.synthetic_cleanup_method = 'ttl';
  return report;
}
