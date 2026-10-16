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

test('a second check in the same login submits without another code; the server can still ask again', async () => {
  const OTHER = '623442f0-a408-4db5-85be-14bae231a722';
  // A stand-in for useStepUp: one prompt per login unless forced.
  let loginVerified = false;
  const prompts = [];
  const requireStepUp = async (request, options) => {
    if (loginVerified && !options?.force) return true;
    prompts.push({ checkId: request.checkId, force: options?.force === true });
    loginVerified = true;
    return true;
  };
  const deposit = (checkId, submit) => {
    resetDepositInFlightForTests();
    return runCheckAltDepositClick(checkId, {
      authProvider: 'cognito',
      apiBaseUrl: '/prep',
      preflight: async () => ready(),
      requireStepUp,
      submit,
    });
  };
  const submitted = [];
  const ok = async (id) => {
    submitted.push(id);
    return { error: null, data: {} };
  };
  assert.equal((await deposit(CHECK, ok)).submitted, true);
  assert.equal((await deposit(OTHER, ok)).submitted, true);
  assert.deepEqual(prompts, [{ checkId: CHECK, force: false }]);
  assert.deepEqual(submitted, [CHECK, OTHER]);

  // The server has no step-up for this login (for example a new sign-in): ask once, retry once.
  let calls = 0;
  const needsCode = async (id) => {
    calls += 1;
    submitted.push(id);
    return calls === 1 ? { error: new Error('step_up_required') } : { error: null, data: {} };
  };
  const retried = await deposit(OTHER, needsCode);
  assert.equal(retried.submitted, true);
  assert.equal(calls, 2);
  assert.deepEqual(prompts.at(-1), { checkId: OTHER, force: true });

  // Declining the new code never submits again.
  let declinedCalls = 0;
  resetDepositInFlightForTests();
  const declined = await runCheckAltDepositClick(CHECK, {
    authProvider: 'cognito',
    apiBaseUrl: '/prep',
    preflight: async () => ready(),
    requireStepUp: async (_request, options) => !options?.force,
    submit: async () => {
      declinedCalls += 1;
      return { error: new Error('step_up_required') };
    },
  });
  assert.equal(declined.ok, false);
  assert.equal(declined.error, 'totp_required');
  assert.equal(declinedCalls, 1);

  // Other refusals are not turned into a code prompt.
  let refusedPrompts = 0;
  resetDepositInFlightForTests();
  const refused = await runCheckAltDepositClick(CHECK, {
    authProvider: 'cognito',
    apiBaseUrl: '/prep',
    preflight: async () => ready(),
    requireStepUp: async (_request, options) => {
      if (options?.force) refusedPrompts += 1;
      return true;
    },
    submit: async () => ({ error: new Error('financial_unauthorized') }),
  });
  assert.equal(refused.ok, false);
  assert.equal(refusedPrompts, 0);
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
