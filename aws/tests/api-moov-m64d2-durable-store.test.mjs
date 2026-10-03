import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { handler } from '../functions/api/index.mjs';
import {
  BANK_VERIFY_STATE_PROBE_PK_PREFIX,
  handleBankVerifyStateProbe,
  isBankVerifyStateProbeEvent,
} from '../functions/api/providers/recipient-bank-verify-state-probe.mjs';
import { createMemoryBankVerifyStore } from '../functions/api/providers/recipient-bank-verify-state.mjs';

const INDEX = readFileSync(new URL('../functions/api/index.mjs', import.meta.url), 'utf8');
const CFN = readFileSync(new URL('../production/api-cfn.yaml', import.meta.url), 'utf8');
const TABLE = readFileSync(new URL('../production/bank-verify-state-table.yaml', import.meta.url), 'utf8');

test('state probe is direct-invoke only and not an HTTP bank-verify write', () => {
  assert.equal(isBankVerifyStateProbeEvent({ checksops_bank_verify_state_probe: true }), true);
  assert.equal(isBankVerifyStateProbeEvent({
    checksops_bank_verify_state_probe: true,
    rawPath: '/prep/public/moov-recipient-bank-verify-initiate',
    requestContext: { http: { method: 'POST', path: '/prep/public/moov-recipient-bank-verify-initiate' } },
  }), false);
  assert.match(INDEX, /isBankVerifyStateProbeEvent/);
  assert.doesNotMatch(INDEX, /path === '\/public\/bank-verify-state-probe'/);
  assert.match(TABLE, /PAY_PER_REQUEST/);
  assert.match(TABLE, /SSEEnabled: true/);
  assert.match(TABLE, /PointInTimeRecoveryEnabled: true/);
  assert.match(TABLE, /dynamodb:GetItem/);
  assert.match(TABLE, /dynamodb:PutItem/);
  assert.match(TABLE, /dynamodb:UpdateItem/);
  assert.doesNotMatch(TABLE, /dynamodb:Scan/);
  assert.doesNotMatch(TABLE, /Resource: '\*'/);
  assert.match(CFN, /AWS_PROVIDER_RECIPIENT_BANK_VERIFY_WRITES_ENABLED: "false"/);
});

test('state probe refuses money flags and never calls a provider', async () => {
  const prev = process.env.AWS_MOOV_ENABLED;
  process.env.AWS_MOOV_ENABLED = 'true';
  try {
    const blocked = await handleBankVerifyStateProbe({
      checksops_bank_verify_state_probe: true,
      action: 'prove',
      probe_id: 'unit',
    });
    assert.equal(blocked.error, 'provider_execution_blocked');
    assert.equal(blocked.bankVerifyWrites, false);
  } finally {
    if (prev === undefined) delete process.env.AWS_MOOV_ENABLED;
    else process.env.AWS_MOOV_ENABLED = prev;
  }
});

test('state probe CAS and MV limiter use synthetic keys only', async () => {
  const store = createMemoryBankVerifyStore();
  const dynamoRequest = async () => ({});
  const result = await handleBankVerifyStateProbe({
    checksops_bank_verify_state_probe: true,
    action: 'cas',
    probe_id: 'unit-cas',
  }, { bankVerifyStore: store, dynamoRequest, nowMs: 1_700_000_000_000 });
  assert.equal(result.synthetic_pk.startsWith(BANK_VERIFY_STATE_PROBE_PK_PREFIX), true);
  assert.equal(result.casWinner.result.claimed, true);
  assert.equal(result.casLoser.result.claimed, false);
  assert.equal(result.rateLimit[0].result.ok, true);
  assert.equal(result.rateLimit[3].result.ok, false);
  assert.equal(result.putitem_cas_proof, true);
  assert.equal(result.updateitem_rate_limit_proof, true);
  assert.equal(result.provider_http, false);
  assert.equal(result.bankVerifyWrites, false);
});

test('HTTP initiate events are not treated as the DynamoDB probe', async () => {
  const keys = ['AWS_PROVIDER_RECIPIENT_BANK_VERIFY_WRITES_ENABLED', 'AWS_PROVIDER_LIVE_READS_ENABLED'];
  const prev = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.AWS_PROVIDER_RECIPIENT_BANK_VERIFY_WRITES_ENABLED = 'false';
  process.env.AWS_PROVIDER_LIVE_READS_ENABLED = 'true';
  try {
    const result = await handler({
      rawPath: '/prep/public/moov-recipient-bank-verify-initiate',
      requestContext: {
        stage: 'prep',
        http: { method: 'POST', path: '/prep/public/moov-recipient-bank-verify-initiate' },
      },
      body: JSON.stringify({ token: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }),
    });
    const parsed = JSON.parse(result.body);
    assert.equal(parsed.error, 'recipient_bank_verify_writes_blocked');
    assert.equal(parsed.liveProviderCalled, false);
  } finally {
    for (const key of keys) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
});
