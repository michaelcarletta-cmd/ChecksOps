/**
 * Phase 1 freeze + cross-build overwrite protection.
 * Runs in test:aws-api. Uses local/temp copies only. No AWS mutation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  CROSS_BUILD_LABEL,
  PHASE1_FREEZE_LABEL,
  STALE_BASELINE_LABEL,
  TOCTOU_ABORT,
  assertCandidatePreservesPhase1,
  assertCodeOnlyPromotion,
  assertDeployShaUnchanged,
  assertPromotionScriptsRemainCodeOnly,
  expectFreezeFailure,
  mutateDropS11Remaining,
  mutateDropS14Deposited,
  mutateDropS2Call,
  mutateDropS5Rpc,
  planNarrowOverlay,
  refuseProductionOverlayBypass,
  requireCandidateBaselineSha,
} from './lib/phase1-freeze-safeguard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LIVE_SHA = 'zb7E5ptHPmRsBegkIFgNzq3rzBktHvpNCJ1QMTHM6l0=';
const LATER_SHA = 'laterProductionShaAfterUnrelatedWork=';

test(`${PHASE1_FREEZE_LABEL}: current accepted tree preserves frozen invariants`, () => {
  const result = assertCandidatePreservesPhase1(ROOT);
  if (result.manifest.status !== 'COMPLETE / PASS') {
    throw new Error(`${PHASE1_FREEZE_LABEL}: current tree is not COMPLETE / PASS`);
  }
  if (result.manifest.officialScenarioIds.join(',') !== 'S1,S2,S3,S4,S5,S6,S7,S8,S9,S10,S11,S12,S13,S14,S15') {
    throw new Error(`${PHASE1_FREEZE_LABEL}: official matrix drifted from S1–S15`);
  }
  if (result.manifest.shaPinPolicy !== 'historical_provenance_only') {
    throw new Error(`${PHASE1_FREEZE_LABEL}: closure SHA became a permanent pin`);
  }
});

test(`${PHASE1_FREEZE_LABEL}: removing an S2 protected call fails`, () => {
  const original = fs.readFileSync(path.join(ROOT, 'aws/functions/api/write-check-workflow.mjs'), 'utf8');
  expectFreezeFailure('S2 protected call removed', () => {
    assertCandidatePreservesPhase1(ROOT, {
      'aws/functions/api/write-check-workflow.mjs': mutateDropS2Call(original),
    });
  }, /S2 Material Endorsement Invalidation/);
});

test(`${PHASE1_FREEZE_LABEL}: removing S5 RPC continuity fails`, () => {
  const original = fs.readFileSync(path.join(ROOT, 'aws/functions/api/workflow-rpc.mjs'), 'utf8');
  expectFreezeFailure('S5 RPC continuity removed', () => {
    assertCandidatePreservesPhase1(ROOT, {
      'aws/functions/api/workflow-rpc.mjs': mutateDropS5Rpc(original),
    });
  }, /S5 Audited Claim Association/);
});

test(`${PHASE1_FREEZE_LABEL}: removing S11 remaining-balance behavior fails`, () => {
  const original = fs.readFileSync(path.join(ROOT, 'aws/functions/api/financial-remaining.mjs'), 'utf8');
  expectFreezeFailure('S11 remaining-balance removed', () => {
    assertCandidatePreservesPhase1(ROOT, {
      'aws/functions/api/financial-remaining.mjs': mutateDropS11Remaining(original),
    });
  }, /S11 Partial Disbursement/);
});

test(`${PHASE1_FREEZE_LABEL}: removing S14 deposited-state protection fails`, () => {
  const original = fs.readFileSync(path.join(ROOT, 'aws/functions/api/check-deposited.mjs'), 'utf8');
  expectFreezeFailure('S14 deposited-state removed', () => {
    assertCandidatePreservesPhase1(ROOT, {
      'aws/functions/api/check-deposited.mjs': mutateDropS14Deposited(original),
    });
  }, /S14 Deposit payee_line Protection/);
});

test(`${STALE_BASELINE_LABEL}: candidate based on a stale production SHA is rejected`, () => {
  const plan = planNarrowOverlay({
    liveFiles: { 'workflow-rpc.mjs': 'live' },
    candidateFiles: { 'workflow-rpc.mjs': 'live' },
    liveSha: LATER_SHA,
    baselineSha: LIVE_SHA,
  });
  if (plan.ok) throw new Error(`${STALE_BASELINE_LABEL}: stale SHA was accepted`);
  if (!plan.errors.some((row) => /live .+ differs from candidate baseline/.test(row))) {
    throw new Error(`${STALE_BASELINE_LABEL}: stale SHA error missing`);
  }
});

test(`${CROSS_BUILD_LABEL}: candidate missing a newer live-only file is rejected rather than deleting it`, () => {
  const plan = planNarrowOverlay({
    liveFiles: {
      'workflow-rpc.mjs': 's5',
      'newer-unrelated-prod.mjs': 'added after phase1',
    },
    candidateFiles: {
      'workflow-rpc.mjs': 's5',
    },
    liveSha: LIVE_SHA,
    baselineSha: LIVE_SHA,
    candidateMode: 'full-zip-replace',
  });
  if (plan.ok) throw new Error(`${CROSS_BUILD_LABEL}: live-only file would have been deleted`);
  if (!plan.manifest.unexpectedLiveOnlyDifferences.includes('newer-unrelated-prod.mjs')) {
    throw new Error(`${CROSS_BUILD_LABEL}: live-only difference was not recorded`);
  }
});

test(`${CROSS_BUILD_LABEL}: undeclared overwrite of a newer live modification is rejected`, () => {
  const plan = planNarrowOverlay({
    liveFiles: {
      'ingest-shared-check.mjs': 'live tenant INSERT with moov columns',
      'workflow-rpc.mjs': 's5',
    },
    candidateFiles: {
      'ingest-shared-check.mjs': 'older ingest without moov columns',
      'workflow-rpc.mjs': 's5',
    },
    intendedModifies: ['workflow-rpc.mjs'],
    liveSha: LIVE_SHA,
    baselineSha: LIVE_SHA,
  });
  if (plan.ok) throw new Error(`${CROSS_BUILD_LABEL}: undeclared live overwrite was accepted`);
  if (!plan.errors.some((row) => /overwrite newer live ingest-shared-check\.mjs/.test(row))) {
    throw new Error(`${CROSS_BUILD_LABEL}: undeclared overwrite was not named`);
  }
});

test(`${CROSS_BUILD_LABEL}: explicit narrow overlay preserves unrelated live files`, () => {
  const plan = planNarrowOverlay({
    liveFiles: {
      'workflow-rpc.mjs': 'old s5 missing',
      'ingest-shared-check.mjs': 'live tenant INSERT with moov columns',
      'newer-unrelated-prod.mjs': 'added after phase1',
    },
    candidateFiles: {
      'workflow-rpc.mjs': 'accepted s5 rpc',
    },
    intendedModifies: ['workflow-rpc.mjs'],
    liveSha: LIVE_SHA,
    baselineSha: LIVE_SHA,
    candidateMode: 'narrow-overlay',
  });
  if (!plan.ok) throw new Error(`${CROSS_BUILD_LABEL}: accepted narrow overlay failed: ${plan.errors.join('; ')}`);
  if (plan.overlay['ingest-shared-check.mjs'] !== 'live tenant INSERT with moov columns') {
    throw new Error(`${CROSS_BUILD_LABEL}: unrelated live ingest was overwritten`);
  }
  if (plan.overlay['newer-unrelated-prod.mjs'] !== 'added after phase1') {
    throw new Error(`${CROSS_BUILD_LABEL}: live-only file was dropped`);
  }
  if (plan.overlay['workflow-rpc.mjs'] !== 'accepted s5 rpc') {
    throw new Error(`${CROSS_BUILD_LABEL}: intended file was not applied`);
  }
  if (plan.manifest.filesIntentionallyRemoved.length) {
    throw new Error(`${CROSS_BUILD_LABEL}: narrow overlay implicitly deleted files`);
  }
});

test(`${STALE_BASELINE_LABEL}: production SHA changing between preflight and deploy aborts`, () => {
  expectFreezeFailure('TOCTOU SHA change', () => {
    assertDeployShaUnchanged({ preflightSha: LIVE_SHA, currentSha: LATER_SHA });
  }, new RegExp(TOCTOU_ABORT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test(`${PHASE1_FREEZE_LABEL}: code-only candidate cannot silently change Lambda configuration`, () => {
  expectFreezeFailure('silent configuration change', () => {
    assertCodeOnlyPromotion({ applyConfig: true, updateFunctionConfiguration: true });
  }, /code-only/);
  const plan = planNarrowOverlay({
    liveFiles: { 'workflow-rpc.mjs': 's5' },
    candidateFiles: { 'workflow-rpc.mjs': 's5' },
    liveSha: LIVE_SHA,
    baselineSha: LIVE_SHA,
    applyConfig: true,
    liveConfig: { Environment: { Variables: { AWS_MOOV_ENABLED: 'true' } } },
    candidateConfig: { Environment: { Variables: { AWS_MOOV_ENABLED: 'false' } } },
  });
  if (plan.ok) throw new Error(`${PHASE1_FREEZE_LABEL}: configuration rewrite was accepted`);
});

test(`${PHASE1_FREEZE_LABEL}: SQL files cannot execute as a side effect of code promotion`, () => {
  expectFreezeFailure('SQL side effect', () => {
    assertCodeOnlyPromotion({ executeSql: true, sqlRunner: () => {} });
  }, /automatically replay production SQL/);
  const plan = planNarrowOverlay({
    liveFiles: { 'workflow-rpc.mjs': 's5' },
    candidateFiles: { 'workflow-rpc.mjs': 's5' },
    liveSha: LIVE_SHA,
    baselineSha: LIVE_SHA,
    executeSql: true,
  });
  if (plan.ok) throw new Error(`${PHASE1_FREEZE_LABEL}: SQL side effect was accepted`);
});

test(`${PHASE1_FREEZE_LABEL}: staging overlay cannot target production`, () => {
  expectFreezeFailure('staging overlay pointed at production', () => {
    refuseProductionOverlayBypass('checksops-production-prep-api');
  }, /aws-production-overlay/);
});

test(`${STALE_BASELINE_LABEL}: apply without an explicit candidate baseline SHA fails closed`, () => {
  expectFreezeFailure('missing candidate baseline SHA', () => {
    requireCandidateBaselineSha('');
  }, /candidate baseline SHA is required/);
});

test(`${PHASE1_FREEZE_LABEL}: promotion scripts remain code-only and require SHA recheck`, () => {
  assertPromotionScriptsRemainCodeOnly(ROOT);
});

test(`${CROSS_BUILD_LABEL}: file deletion is explicit; absence from the candidate does not delete live files`, () => {
  const implicit = planNarrowOverlay({
    liveFiles: {
      'workflow-rpc.mjs': 's5',
      'newer-unrelated-prod.mjs': 'keep',
    },
    candidateFiles: {
      'workflow-rpc.mjs': 's5',
    },
    liveSha: LIVE_SHA,
    baselineSha: LIVE_SHA,
    candidateMode: 'narrow-overlay',
  });
  if (!implicit.ok) {
    throw new Error(`${CROSS_BUILD_LABEL}: narrow candidate missing an undeclared live file should preserve it: ${implicit.errors.join('; ')}`);
  }
  if (!Object.prototype.hasOwnProperty.call(implicit.overlay, 'newer-unrelated-prod.mjs')) {
    throw new Error(`${CROSS_BUILD_LABEL}: live-only file was implicitly deleted`);
  }

  const explicit = planNarrowOverlay({
    liveFiles: {
      'workflow-rpc.mjs': 's5',
      'obsolete.mjs': 'remove me',
    },
    candidateFiles: {
      'workflow-rpc.mjs': 's5',
    },
    intendedRemoves: ['obsolete.mjs'],
    liveSha: LIVE_SHA,
    baselineSha: LIVE_SHA,
  });
  if (!explicit.ok) {
    throw new Error(`${CROSS_BUILD_LABEL}: explicit delete failed: ${explicit.errors.join('; ')}`);
  }
  if (Object.prototype.hasOwnProperty.call(explicit.overlay, 'obsolete.mjs')) {
    throw new Error(`${CROSS_BUILD_LABEL}: explicit delete was not applied`);
  }
  if (!explicit.manifest.filesIntentionallyRemoved.includes('obsolete.mjs')) {
    throw new Error(`${CROSS_BUILD_LABEL}: explicit delete was not recorded`);
  }
});

test(`${PHASE1_FREEZE_LABEL}: configuration drift is reported and not normalized`, () => {
  const plan = planNarrowOverlay({
    liveFiles: { 'workflow-rpc.mjs': 's5' },
    candidateFiles: { 'workflow-rpc.mjs': 's5' },
    liveSha: LIVE_SHA,
    baselineSha: LIVE_SHA,
    applyConfig: false,
    liveConfig: { Environment: { Variables: { AWS_MOOV_ENABLED: 'true' } } },
    candidateConfig: { Environment: { Variables: { AWS_MOOV_ENABLED: 'false' } } },
  });
  if (!plan.ok) {
    throw new Error(`${PHASE1_FREEZE_LABEL}: reporting config drift must not fail a code-only overlay: ${plan.errors.join('; ')}`);
  }
});
