import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { answersFromUnderwriting, buildUnderwritingPayload } from '../../src/lib/underwritingPayload.ts';
import { invokeErrorCode, invokeWithBankStepUp } from '../../src/lib/bankStepUp.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const answers = {
  geographicReach: 'us-only',
  sendAchMonthlyVolume: 'under-10k',
  collectAchMonthlyVolume: '10k-50k',
};

test('Expected Payment Activity sends geographic reach and the ACH send and collect volume ranges', () => {
  const built = buildUnderwritingPayload(answers);
  assert.equal(built.ok, true);
  assert.deepEqual(built.payload, {
    geographicReach: 'us-only',
    sendFunds: { ach: { estimatedActivity: { monthlyVolumeRange: 'under-10k' } } },
    collectFunds: { ach: { estimatedActivity: { monthlyVolumeRange: '10k-50k' } } },
  });
  assert.equal(buildUnderwritingPayload({ ...answers, geographicReach: '' }).ok, false);
  assert.equal(buildUnderwritingPayload({ ...answers, sendAchMonthlyVolume: '5000' }).ok, false);
  assert.equal(buildUnderwritingPayload({ ...answers, collectAchMonthlyVolume: '' }).ok, false);
  // The provider's read fills the form back; anything else stays blank.
  assert.deepEqual(answersFromUnderwriting(built.payload), answers);
  assert.deepEqual(answersFromUnderwriting({ averageTransactionSize: 100 }), { geographicReach: '', sendAchMonthlyVolume: '', collectAchMonthlyVolume: '' });
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
