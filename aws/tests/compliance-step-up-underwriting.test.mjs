import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildUnderwritingPayload } from '../../src/lib/underwritingPayload.ts';
import { invokeErrorCode, invokeWithBankStepUp } from '../../src/lib/bankStepUp.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const answers = {
  averageTransactionSize: '1,250.50',
  maxTransactionSize: '$25000',
  averageMonthlyTransactionVolume: '100000',
  businessToBusinessPercentage: '80',
  consumerToBusinessPercentage: '20',
  hasPhysicalGoods: false,
  isShippingProduct: false,
  shipmentDurationDays: '0',
  returnPolicy: 'none',
};

test('Expected Payment Activity sends whole cents and nested percentages and fulfillment', () => {
  const built = buildUnderwritingPayload(answers);
  assert.equal(built.ok, true);
  assert.deepEqual(built.payload, {
    averageTransactionSize: 125050,
    maxTransactionSize: 2500000,
    averageMonthlyTransactionVolume: 10000000,
    volumeByCustomerType: { businessToBusinessPercentage: 80, consumerToBusinessPercentage: 20 },
    fulfillment: { hasPhysicalGoods: false, isShippingProduct: false, shipmentDurationDays: 0, returnPolicy: 'none' },
  });
  assert.equal(buildUnderwritingPayload({ ...answers, consumerToBusinessPercentage: '30' }).ok, false);
  assert.equal(buildUnderwritingPayload({ ...answers, averageTransactionSize: '' }).ok, false);
  assert.equal(buildUnderwritingPayload({ ...answers, maxTransactionSize: '10' }).ok, false);
  assert.equal(buildUnderwritingPayload({ ...answers, shipmentDurationDays: '2.5' }).ok, false);
  const panel = read('src/components/payments/UnderwritingQuestionnairePanel.tsx');
  assert.match(panel, /answers: built\.payload/);
  assert.equal(/action: "save", answers \}/.test(panel), false);
});

test('bank changes ask for the two-factor code on totp_required and retry once', async () => {
  const awsError = { message: 'totp_required', context: { status: 401, body: { error: 'totp_required' } } };
  assert.equal(await invokeErrorCode({ data: null, error: awsError }), 'totp_required');
  assert.equal(await invokeErrorCode({ data: { error: 'x' }, error: null }), 'x');
  let calls = 0;
  let asked = null;
  const result = await invokeWithBankStepUp(
    async () => (++calls === 1 ? { data: null, error: awsError } : { data: { ok: true }, error: null }),
    async (request, options) => { asked = { request, options }; return true; },
    'tenant-1',
  );
  assert.equal(calls, 2);
  assert.deepEqual(result.data, { ok: true });
  assert.equal(asked.request.actionKey, 'wallet.fund');
  assert.equal(asked.request.tenantId, 'tenant-1');
  assert.deepEqual(asked.options, { force: true });
  await assert.rejects(
    invokeWithBankStepUp(async () => ({ data: null, error: awsError }), async () => false, 'tenant-1'),
    /Two-factor confirmation is required/,
  );
  let other = 0;
  await invokeWithBankStepUp(async () => { other += 1; return { data: null, error: { context: { body: { error: 'moov_rejected' } } } }; }, async () => { throw new Error('not asked'); }, 't');
  assert.equal(other, 1);
  for (const rel of ['src/components/payments/MoovBankLink.tsx', 'src/components/payments/MicroDepositVerification.tsx']) {
    const src = read(rel);
    assert.match(src, /invokeWithBankStepUp\(/, rel);
    assert.match(src, /useStepUp\(\)/, rel);
  }
  assert.equal((read('src/components/payments/MicroDepositVerification.tsx').match(/invokeWithBankStepUp\(/g) || []).length, 2);
});

test('Compliance screens do not name the payment provider', () => {
  for (const rel of [
    'src/components/settings/ComplianceSettings.tsx',
    'src/components/settings/compliance/BankSection.tsx',
    'src/components/settings/compliance/DocumentsSection.tsx',
    'src/components/settings/compliance/RepresentativesSection.tsx',
  ]) {
    const visible = read(rel)
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*|import )/.test(line))
      .join('\n')
      .replace(/\b(use|type |Document)?Moov[A-Z]\w*/g, '')
      .replace(/moov\.io\/legal/g, '');
    assert.equal(/\bMoov\b/.test(visible), false, rel);
  }
  const compliance = read('src/components/settings/ComplianceSettings.tsx');
  assert.match(compliance, /ChecksOps Terms of Service/);
  assert.match(compliance, /href="\/terms"/);
});
