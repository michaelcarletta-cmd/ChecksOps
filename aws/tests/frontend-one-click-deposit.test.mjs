import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { normalizeTotpCode } from '../../src/lib/totpCode.ts';
import {
  resetDepositInFlightForTests,
  runCheckAltDepositClick,
} from '../../src/lib/checkaltDepositOrchestrator.ts';
import { buildFinancialStepUpRequest } from '../../src/lib/financialStepUp.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHECK = 'a3a4a153-46e1-4c28-a273-79a9bd04f3a6';

const ready = (extra = {}) => ({
  ok: true,
  readyForVerification: true,
  needFrontPrep: false,
  needRearPrep: false,
  historicalReference: false,
  liveProviderCalled: false,
  providerHttpAttempted: false,
  ...extra,
});

test('leading-zero six-digit TOTP is preserved as a string', () => {
  const ok = normalizeTotpCode('012345');
  assert.equal(ok.ok, true);
  assert.equal(ok.code, '012345');
  assert.equal(typeof ok.code, 'string');
  assert.equal(normalizeTotpCode(12345).ok, false);
  assert.equal(normalizeTotpCode(12345).error, 'totp_must_be_string');
  assert.equal(normalizeTotpCode(' 654321 ').ok, true);
  assert.equal(normalizeTotpCode(' 654321 ').code, '654321');
});

test('Deposit click with missing official images prepares both then requests verification', async () => {
  resetDepositInFlightForTests();
  const prepared = [];
  const phases = [];
  let submits = 0;
  const result = await runCheckAltDepositClick(CHECK, {
    authProvider: 'cognito',
    apiBaseUrl: '/prep',
    onPhase: (phase) => phases.push(phase),
    preflight: async () => {
      if (prepared.length === 0) {
        return {
          ok: false,
          needFrontPrep: true,
          needRearPrep: true,
          readyForVerification: false,
          liveProviderCalled: false,
          providerHttpAttempted: false,
        };
      }
      return ready();
    },
    prepareCheckAltDeposit: async (id, options) => {
      prepared.push({ id, options });
      return {
        deposit_front_path: `checks/${id}/front.checkalt.jpg`,
        deposit_back_path: `checks/${id}/back.checkalt.jpg`,
      };
    },
    requireStepUp: async () => true,
    submit: async () => {
      submits += 1;
      return { error: null, data: { ok: true } };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(prepared.length, 1);
  assert.equal(prepared[0].options.forceFront, true);
  assert.equal(prepared[0].options.forceRear, true);
  assert.equal(submits, 1);
  assert.ok(phases.includes('preparing'));
  assert.ok(phases.includes('awaiting_verification'));
});

test('existing compliant images skip regenerate and proceed to verification', async () => {
  resetDepositInFlightForTests();
  let prepared = 0;
  const result = await runCheckAltDepositClick(CHECK, {
    authProvider: 'cognito',
    apiBaseUrl: '/prep',
    preflight: async () => ready(),
    prepareCheckAltDeposit: async () => {
      prepared += 1;
      return { deposit_front_path: 'x.checkalt.jpg', deposit_back_path: 'y.checkalt.jpg' };
    },
    requireStepUp: async () => true,
    submit: async () => ({ error: null, data: {} }),
  });
  assert.equal(result.ok, true);
  assert.equal(prepared, 0);
  assert.equal(result.verified, true);
});

test('stale rear fingerprint regenerates rear only', async () => {
  resetDepositInFlightForTests();
  const prepared = [];
  let calls = 0;
  await runCheckAltDepositClick(CHECK, {
    authProvider: 'cognito',
    apiBaseUrl: '/prep',
    preflight: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: false,
          needFrontPrep: false,
          needRearPrep: true,
          readyForVerification: false,
          liveProviderCalled: false,
        };
      }
      return ready();
    },
    prepareCheckAltDeposit: async (_id, options) => {
      prepared.push(options);
      return { deposit_front_path: 'f.checkalt.jpg', deposit_back_path: 'b.checkalt.jpg' };
    },
    requireStepUp: async () => true,
    submit: async () => ({ error: null, data: {} }),
  });
  assert.deepEqual(prepared, [{ forceFront: false, forceRear: true }]);
});

test('image compliance failure after prep never submits', async () => {
  resetDepositInFlightForTests();
  let submits = 0;
  let prepared = 0;
  const result = await runCheckAltDepositClick(CHECK, {
    authProvider: 'cognito',
    apiBaseUrl: '/prep',
    preflight: async () => {
      if (prepared === 0) {
        return {
          ok: false,
          needFrontPrep: true,
          needRearPrep: true,
          readyForVerification: false,
          liveProviderCalled: false,
        };
      }
      return {
        ok: false,
        error: 'checkalt_image_noncompliant',
        attention: 'front',
        message: 'Check image preparation failed. Please retake the front image.',
        readyForVerification: false,
        liveProviderCalled: false,
      };
    },
    prepareCheckAltDeposit: async () => {
      prepared += 1;
      return { deposit_front_path: 'f.checkalt.jpg', deposit_back_path: 'b.checkalt.jpg' };
    },
    requireStepUp: async () => true,
    submit: async () => {
      submits += 1;
      return { error: null, data: {} };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.verified, false);
  assert.equal(submits, 0);
  assert.match(result.message, /retake the front/i);
});

test('image prep failure and unsigned payee never submit', async () => {
  resetDepositInFlightForTests();
  let submits = 0;
  const prepFail = await runCheckAltDepositClick(CHECK, {
    authProvider: 'cognito',
    apiBaseUrl: '/prep',
    preflight: async () => ({
      ok: false,
      needFrontPrep: true,
      needRearPrep: true,
      attention: 'front',
      liveProviderCalled: false,
    }),
    prepareCheckAltDeposit: async () => {
      throw new Error('encode failed');
    },
    requireStepUp: async () => true,
    submit: async () => {
      submits += 1;
      return { error: null, data: {} };
    },
  });
  assert.equal(prepFail.ok, false);
  assert.match(prepFail.message, /retake the front/i);

  resetDepositInFlightForTests();
  const unsigned = await runCheckAltDepositClick(CHECK, {
    authProvider: 'cognito',
    apiBaseUrl: '/prep',
    preflight: async () => ({
      ok: false,
      error: 'endorsements_incomplete',
      attention: 'endorsement',
      message: 'Endorsement is incomplete. A required payee has not signed.',
      liveProviderCalled: false,
    }),
    requireStepUp: async () => true,
    submit: async () => {
      submits += 1;
      return { error: null, data: {} };
    },
  });
  assert.equal(unsigned.ok, false);
  assert.equal(unsigned.attention, 'endorsement');
  assert.equal(submits, 0);
});

test('TOTP failure never submits; valid TOTP binds deposit.submit to the check', async () => {
  resetDepositInFlightForTests();
  let submits = 0;
  const denied = await runCheckAltDepositClick(CHECK, {
    authProvider: 'cognito',
    apiBaseUrl: '/prep',
    preflight: async () => ready(),
    requireStepUp: async () => false,
    submit: async () => {
      submits += 1;
      return { error: null, data: {} };
    },
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.verified, false);
  assert.equal(submits, 0);

  resetDepositInFlightForTests();
  const built = [];
  await runCheckAltDepositClick(CHECK, {
    authProvider: 'cognito',
    apiBaseUrl: '/prep',
    preflight: async () => ready(),
    requireStepUp: async (request) => {
      built.push(request);
      return true;
    },
    submit: async () => ({ error: null, data: {} }),
  });
  assert.equal(built[0].actionKey, 'deposit.submit');
  assert.equal(built[0].checkId, CHECK);
  const request = buildFinancialStepUpRequest({
    actionKey: 'deposit.submit',
    checkId: CHECK,
    amount: 99,
    tenant_id: 'other',
  });
  assert.equal(request.ok, true);
  assert.equal(request.ignored.browserAmount, true);
  assert.equal(request.ignored.browserTenantNotAuthoritative, true);
});

test('double Deposit click cannot produce duplicate provider execution', async () => {
  resetDepositInFlightForTests();
  let started;
  const first = runCheckAltDepositClick(CHECK, {
    authProvider: 'cognito',
    apiBaseUrl: '/prep',
    preflight: () => new Promise((resolve) => {
      started = resolve;
    }),
    requireStepUp: async () => true,
    submit: async () => ({ error: null, data: {} }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  const second = await runCheckAltDepositClick(CHECK, {
    authProvider: 'cognito',
    apiBaseUrl: '/prep',
    preflight: async () => ready(),
    requireStepUp: async () => true,
    submit: async () => ({ error: null, data: {} }),
  });
  assert.equal(second.ok, false);
  assert.equal(second.error, 'deposit_in_progress');
  started(ready());
  const done = await first;
  assert.equal(done.ok, true);
});

test('historical CheckAlt reference does not regenerate images and still requires verification', async () => {
  resetDepositInFlightForTests();
  let prepared = 0;
  let verified = false;
  const result = await runCheckAltDepositClick(CHECK, {
    authProvider: 'cognito',
    apiBaseUrl: '/prep',
    preflight: async () => ready({ historicalReference: true }),
    prepareCheckAltDeposit: async () => {
      prepared += 1;
      return { deposit_front_path: 'f.checkalt.jpg', deposit_back_path: 'b.checkalt.jpg' };
    },
    requireStepUp: async () => {
      verified = true;
      return true;
    },
    submit: async () => ({ error: null, data: {} }),
  });
  assert.equal(prepared, 0);
  assert.equal(verified, true);
  assert.equal(result.historicalReference, true);
});

test('wrong check, amount, tenant, and expired step-up cannot authorize deposit.submit', async () => {
  const { stepUpMatchesCheck, TOTP_STEPUP_TTL_MS } = await import(
    '../functions/api/providers/production/checkalt-authz.mjs'
  );
  const TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
  const row = {
    tenant_id: TENANT,
    action_key: 'deposit.submit',
    succeeded: true,
    metadata: { check_id: CHECK, amount_cents: 1234, operation: 'deposit.submit' },
  };
  assert.equal(stepUpMatchesCheck(row, {
    tenantId: TENANT, checkId: CHECK, amountCents: 1234, actionKey: 'deposit.submit',
  }), true);
  assert.equal(stepUpMatchesCheck(row, {
    tenantId: TENANT, checkId: '623442f0-a408-4db5-85be-14bae231a722', amountCents: 1234, actionKey: 'deposit.submit',
  }), false);
  assert.equal(stepUpMatchesCheck(row, {
    tenantId: TENANT, checkId: CHECK, amountCents: 9999, actionKey: 'deposit.submit',
  }), false);
  assert.equal(stepUpMatchesCheck(row, {
    tenantId: '4f172140-f57a-4744-8050-95f4f07b13b4', checkId: CHECK, amountCents: 1234, actionKey: 'deposit.submit',
  }), false);
  assert.equal(TOTP_STEPUP_TTL_MS, 30 * 60 * 1000);
});

test('Command Center and deposit ops no longer require a separate Prepare click', () => {
  const ccc = fs.readFileSync(path.join(ROOT, 'src/pages/CheckCommandCenter.tsx'), 'utf8');
  const card = fs.readFileSync(path.join(ROOT, 'src/components/checks/CheckAltImageComplianceCard.tsx'), 'utf8');
  const ops = fs.readFileSync(path.join(ROOT, 'src/components/deposit-ops/DepositOperationsConsole.tsx'), 'utf8');
  const dialog = fs.readFileSync(path.join(ROOT, 'src/components/auth/StepUpDialog.tsx'), 'utf8');
  assert.match(ccc, /runCheckAltDepositClick/);
  assert.doesNotMatch(ccc, /guardFinancial\("deposit.submit"/);
  assert.doesNotMatch(card, /Prepare official/);
  assert.match(ops, /runCheckAltDepositClick/);
  assert.match(dialog, /Deposit Verification/);
  assert.match(dialog, /normalizeTotpCode/);
  assert.match(ccc, /Preparing check for deposit/);
  assert.match(ccc, /DEPOSIT_PHASE_LABEL/);
  const preflight = fs.readFileSync(path.join(ROOT, 'aws/functions/api/providers/production/checkalt-preflight.mjs'), 'utf8');
  assert.doesNotMatch(preflight, /markHttpAttempted|deposit\/process|authenticate/);
});

test('Poll Now is a status read and does not prompt TOTP', () => {
  const settings = fs.readFileSync(path.join(ROOT, 'src/components/settings/CheckAltSettings.tsx'), 'utf8');
  const poll = settings.split('Bulk "Poll Now"')[1]?.split('if (isLoading)')[0] || '';
  assert.match(poll, /checkalt-poll-status/);
  assert.doesNotMatch(poll, /guardFinancial|requireStepUp/);
  const handler = fs.readFileSync(
    path.join(ROOT, 'aws/functions/api/providers/production/checkalt-poll.mjs'),
    'utf8',
  );
  assert.match(handler, /requireStepUp:\s*false/);
  assert.doesNotMatch(handler, /deposit\/process/);
});
