/**
 * Direct-invoke only. Proves durable bank-verify DynamoDB access without
 * enabling recipient bank-verify writes, calling Moov, or touching money flags.
 * Synthetic keys are prefixed PROBE#m64d2#. Not reachable from HTTP API paths.
 * Lambda must never perform table-admin APIs (operator-only).
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
  createDynamoBankVerifyStore,
  tokenFingerprint,
  ttlEpochSeconds,
} from './recipient-bank-verify-state.mjs';
import { dynamoJsonRequest, dynamoN, dynamoS } from './dynamodb-json.mjs';

export const BANK_VERIFY_STATE_PROBE_PK_PREFIX = 'PROBE#m64d2#';
export const BANK_VERIFY_STATE_TABLE_NAME = 'checksops-recipient-bank-verify-state';
export const BANK_VERIFY_STATE_TABLE_ARN = 'arn:aws:dynamodb:us-east-1:806168576068:table/checksops-recipient-bank-verify-state';

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
