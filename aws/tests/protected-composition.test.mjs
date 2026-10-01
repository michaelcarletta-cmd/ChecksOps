/**
 * Protected accepted-composition gate for production SPA promote.
 * Source/tests/evidence only. Does not deploy or write AWS.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import { evaluateDeployment } from '../../scripts/deployment-guard/lib/guard.mjs';
import { evaluateAcceptedContracts, loadContractRegistry, passingContractResults } from '../../scripts/deployment-guard/lib/contracts.mjs';
import { evaluateProductionGate } from '../../scripts/deployment-guard/lib/production.mjs';
import { evaluateIndexToctou, evaluateSpaPromote } from '../../scripts/deployment-guard/lib/spa-promote.mjs';
import {
  evaluateMoovSourceContracts,
  evaluateProtectedComposition,
  evaluateWalletOpsSourceContracts,
  loadProtectedCompositionRegistry,
  loadProtectedManifests,
  passingProtectedCompositionResults,
} from '../../scripts/deployment-guard/lib/protected-composition.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NOW = '2026-09-30T19:00:00.000Z';
const LIVE = Object.freeze({
  index_html_sha256: '3cf8cb8cacceptedindexsha',
  entry_bundle: '/assets/index-DbYbvb6d.js',
});
const STALE = Object.freeze({
  index_html_sha256: 'old-index-from-candidate-baseline',
  entry_bundle: '/assets/index-C_fh5VBD.js',
});
const DRIFT = Object.freeze({
  index_html_sha256: 'newer-live-index-after-peer-deploy',
  entry_bundle: '/assets/index-NEWERHASH.js',
});

const SOURCE_PATHS = [
  'src/hooks/useWalletOps.ts',
  'src/hooks/useWallet.ts',
  'src/hooks/usePaymentProviderEligibility.ts',
  'src/lib/payments/wallets.ts',
  'src/lib/payments/loadWalletSnapshot.ts',
  'src/pages/WalletOps.tsx',
  'src/lib/payments/walletRelativeTransfers.ts',
  'src/lib/payments/selectPaymentWallet.ts',
  'src/lib/payments/reconcileWalletFundingTransfer.ts',
  'src/components/settings/ComplianceSettings.tsx',
  'src/components/white-label/WhiteLabelSettings.tsx',
  'src/lib/payments/featureFlags.ts',
  'src/lib/payments/tenantMoovDefaults.ts',
  'src/components/disbursement/StakeholderAccountSettings.tsx',
  'src/components/settings/TenantBankAccountSettings.tsx',
  'src/lib/payments/stakeholderBankDisplay.ts',
  'aws/functions/api/providers/parity/moov-stakeholder-sync.mjs',
  'aws/functions/api/providers/parity/moov-functions.mjs',
  'aws/functions/api/providers/parity/moov-onboard.mjs',
  'supabase/functions/moov-onboarding-link/index.ts',
  'supabase/functions/moov-webhook/index.ts',
  'aws/functions/api/providers/webhook-apply.mjs',
];

function readRepo(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function loadWalletOpsFiles(overrides = {}) {
  const files = {};
  for (const rel of SOURCE_PATHS) files[rel] = readRepo(rel);
  return { ...files, ...overrides };
}

function walletopsManifest() {
  return JSON.parse(readRepo('ops/deployment-guard/protected-composition/walletops-activity-recovery.json'));
}

function replacementTests() {
  const tests = {};
  for (const id of Object.keys(walletopsManifest().required_regression_tests)) {
    tests[id] = { ok: true };
  }
  return tests;
}

function validInput(overrides = {}) {
  const files = loadWalletOpsFiles();
  return {
    workstream_id: 'walletops-guard-protect',
    branch: 'cursor/walletops-guard-protect-2d41',
    commit: SHA,
    operator: 'test-agent',
    target_environment: 'production',
    target_component: 'production-spa',
    deployment_type: 'spa-promote',
    owned_components: ['index.html'],
    owned_members: ['index.html'],
    build_timestamp: NOW,
    clean_build: true,
    dist: { clean_build: true },
    source_composition_manifest: {
      live_baseline: LIVE,
      candidate_delta: ['src/pages/WalletOps.tsx'],
      protected_accepted_composition: ['walletops-activity-recovery'],
    },
    frontend_workstreams: ['walletops-activity-recovery'],
    accepted_composition: true,
    accepted_source_composition: true,
    preflight: { ...LIVE },
    preflight_live_fingerprint: { ...LIVE },
    immediately_before: { ...LIVE },
    production_fingerprint: { ...LIVE },
    immediately_before_fingerprint: { ...LIVE },
    composed_onto: { ...LIVE },
    production_baseline_fingerprint: { ...LIVE },
    staging_acceptance: { ok: true, reference: 'walletops-activity-recovery-staging' },
    approval: { approved: true, workstream_id: 'walletops-guard-protect' },
    contract_results: passingContractResults(loadContractRegistry(ROOT)),
    regression_results: passingProtectedCompositionResults(loadProtectedManifests(ROOT)),
    protected_file_hashes: walletopsManifest().protected_file_hashes,
    candidate_source: { files },
    ...overrides,
  };
}

function codesOf(result) {
  return (result.errors || []).map((row) => row.code);
}

test('registry is multi-manifest and only registers known accepted work', () => {
  const registry = loadProtectedCompositionRegistry(ROOT);
  assert.equal(registry.fail_closed, true);
  const ids = registry.manifests.map((row) => row.id);
  assert.deepEqual(ids, ['walletops-activity-recovery', 'moov']);
  for (const invented of ['signature', 'claim-number', 'OCR', 'billing', 'mortgage-ops']) {
    assert.equal(ids.includes(invented), false, invented);
  }
  const manifest = walletopsManifest();
  assert.equal(manifest.accepted, true);
  assert.equal(manifest.pin_hashed_spa_filenames, false);
  assert.equal(manifest.absence_based_deletion, 'forbidden_unless_superseded');
  assert.ok(manifest.do_not_recreate_provider_transfer_ids.includes('9f9df312-32a9-4999-ace9-fc2b00669c75'));
  assert.equal(Object.keys(manifest.required_regression_tests).length, 9);
  assert.ok(fs.existsSync(path.join(ROOT, manifest.evidence)));
});

test('accepted-contracts production-spa entry points at the WalletOps manifest', () => {
  const registry = loadContractRegistry(ROOT);
  const contract = registry.contracts.find((row) => row.id === 'walletops-activity-recovery');
  assert.ok(contract);
  assert.deepEqual(contract.environments, ['production']);
  assert.deepEqual(contract.components, ['production-spa']);
  assert.deepEqual(contract.deployment_types, ['spa-promote']);
  const staging = evaluateAcceptedContracts({
    registry,
    environment: 'staging',
    component: 'staging-frontend',
    deployment_type: 'spa-promote',
    results: passingContractResults(registry),
  });
  assert.equal(staging.ok, true);
  assert.equal(staging.details.executed.includes('walletops-activity-recovery'), false);
});

test('current accepted WalletOps source satisfies source contracts', () => {
  const results = evaluateWalletOpsSourceContracts(loadWalletOpsFiles());
  for (const [id, result] of Object.entries(results)) {
    assert.equal(result.ok, true, id);
  }
});

test('current accepted Moov source satisfies capability contracts', () => {
  const results = evaluateMoovSourceContracts(loadWalletOpsFiles());
  for (const [id, result] of Object.entries(results)) {
    assert.equal(result.ok, true, id);
  }
});

test('removing Settings Moov last-four / stakeholder sync is rejected', () => {
  const files = loadWalletOpsFiles({
    'src/components/settings/TenantBankAccountSettings.tsx': readRepo('src/components/settings/TenantBankAccountSettings.tsx')
      .replaceAll('decorateStakeholderBank', 'identity')
      .replaceAll('provider_last_four', 'chk_acct')
      .replaceAll('display_last_four_label', 'chk_acct'),
    'src/components/disbursement/StakeholderAccountSettings.tsx': readRepo('src/components/disbursement/StakeholderAccountSettings.tsx')
      .replaceAll('decorateStakeholderBank', 'identity')
      .replaceAll('external_payment_recipients', 'stakeholder_accounts'),
    'aws/functions/api/providers/parity/moov-functions.mjs': readRepo('aws/functions/api/providers/parity/moov-functions.mjs')
      .replaceAll('applyMoovBanksToStakeholders', 'noopBanks')
      .replaceAll('syncLinkedStakeholderBanks', 'noopLinked'),
    'supabase/functions/moov-webhook/index.ts': readRepo('supabase/functions/moov-webhook/index.ts')
      .replaceAll('applyMoovBankVerificationEvent', 'noopWebhook'),
    'aws/functions/api/providers/webhook-apply.mjs': readRepo('aws/functions/api/providers/webhook-apply.mjs')
      .replaceAll('applyMoovBankVerificationEvent', 'noopWebhook'),
  });
  const result = evaluateProtectedComposition(validInput({
    candidate_source: { files },
  }), { root: ROOT });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.REGRESSION_DETECTED);
  assert.match(
    JSON.stringify(result.errors),
    /moov_settings_last_four_from_provider|moov_stakeholder_status_from_linked_tables|moov_sync_writes_stakeholder_banks|moov_webhook_writes_stakeholder_verification/,
  );
});

test('removing Bank verified / Provider linked Moov status is rejected', () => {
  const files = loadWalletOpsFiles({
    'src/components/disbursement/StakeholderAccountSettings.tsx': readRepo('src/components/disbursement/StakeholderAccountSettings.tsx')
      .replaceAll('Bank verified', 'Verified')
      .replaceAll('Provider linked', '')
      .replaceAll('moov-sync', 'noop-sync'),
  });
  const result = evaluateProtectedComposition(validInput({
    candidate_source: { files },
  }), { root: ROOT });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.REGRESSION_DETECTED);
  assert.match(JSON.stringify(result.errors), /moov_bank_verified_status|moov_provider_linked_status|moov_status_refresh/);
});

test('valid candidate that preserves accepted behavior is ALLOW', () => {
  const result = evaluateProtectedComposition(validInput(), { root: ROOT });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.details.protected_composition, 'preserved');
  assert.deepEqual(result.details.manifests, ['walletops-activity-recovery', 'moov']);

  const official = evaluateDeployment(validInput(), { root: ROOT });
  assert.equal(official.ok, true, official.message);
  assert.equal(official.details.evaluation.spa_promote_allowed, true);
  assert.equal(official.details.evaluation.protected_composition.protected_composition, 'preserved');
});

test('1. removing environment-aware wallet selection is rejected', () => {
  const files = loadWalletOpsFiles({
    'src/hooks/useWalletOps.ts': readRepo('src/hooks/useWalletOps.ts')
      .replaceAll('selectPaymentWallet', 'pickFirstWallet')
      .replaceAll('resolveWalletOpsEnvironment', 'guessEnv'),
  });
  const result = evaluateProtectedComposition(validInput({
    candidate_source: { files },
  }), { root: ROOT });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.REGRESSION_DETECTED);
  assert.match(JSON.stringify(result.errors), /environment_aware_wallet_selection/);
});

test('2. restoring duplicate-wallet maybeSingle is rejected', () => {
  const original = readRepo('src/hooks/useWalletOps.ts');
  const files = loadWalletOpsFiles({
    'src/hooks/useWalletOps.ts': original.replace(
      '.eq("wallet_type", "operating")',
      '.eq("wallet_type", "operating").maybeSingle()',
    ),
  });
  const result = evaluateProtectedComposition(validInput({
    candidate_source: { files },
  }), { root: ROOT });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.REGRESSION_DETECTED);
  assert.match(JSON.stringify(result.errors), /no_maybeSingle_unscoped_operating_wallets/);
});

test('3. removing Funding & Billing is rejected', () => {
  const files = loadWalletOpsFiles({
    'src/pages/WalletOps.tsx': readRepo('src/pages/WalletOps.tsx').replace('Funding & Billing', 'Accounts'),
  });
  const result = evaluateProtectedComposition(validInput({
    candidate_source: { files },
  }), { root: ROOT });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.REGRESSION_DETECTED);
  assert.match(JSON.stringify(result.errors), /funding_and_billing_present/);
});

test('4. restoring Payout Preferences is rejected', () => {
  const files = loadWalletOpsFiles({
    'src/pages/WalletOps.tsx': readRepo('src/pages/WalletOps.tsx').replace(
      'title="Recent Wallet Activity"',
      'title="Payout Preferences"',
    ) + '\n<button>Save payout preference</button>\n',
  });
  const result = evaluateProtectedComposition(validInput({
    candidate_source: { files },
  }), { root: ROOT });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.REGRESSION_DETECTED);
  assert.match(JSON.stringify(result.errors), /payout_preferences_absent_from_walletops/);
});

test('5. restoring WalletOps Payment Account management is rejected', () => {
  const files = loadWalletOpsFiles({
    'src/pages/WalletOps.tsx': readRepo('src/pages/WalletOps.tsx').replace(
      'title="Funding & Billing"',
      'title="Payment Account"',
    ) + '\n<PaymentAccountPanel />\n',
  });
  const result = evaluateProtectedComposition(validInput({
    candidate_source: { files },
  }), { root: ROOT });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.REGRESSION_DETECTED);
  assert.match(JSON.stringify(result.errors), /payment_account_management_absent_from_walletops/);
});

test('6. breaking $5 Pending In classification is rejected', () => {
  const files = loadWalletOpsFiles({
    'src/lib/payments/walletRelativeTransfers.ts': readRepo('src/lib/payments/walletRelativeTransfers.ts')
      .replace('if (pending && isWalletDestination && !isWalletSource) kind = "pending_in";', 'if (pending && isWalletDestination && !isWalletSource) kind = "neither";'),
  });
  const result = evaluateProtectedComposition(validInput({
    candidate_source: { files },
    regression_results: {
      ...passingProtectedCompositionResults(loadProtectedManifests(ROOT)),
      'wallet-relative': { ok: false, reason: '$5 wallet funding no longer Pending In' },
    },
  }), { root: ROOT });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.REGRESSION_DETECTED);
  const blob = JSON.stringify(result.errors);
  assert.match(blob, /wallet-relative|pending_wallet_funding_is_pending_in/);
});

test('7. making $139 bank billing Pending Out is rejected', () => {
  const files = loadWalletOpsFiles({
    'src/lib/payments/walletRelativeTransfers.ts': readRepo('src/lib/payments/walletRelativeTransfers.ts')
      .replace('export function isChecksOpsBillingTransfer', 'export function wasChecksOpsBillingTransfer')
      + '\nif (isChecksOpsBillingTransfer(transfer)) kind = "pending_out";\n',
  });
  const result = evaluateProtectedComposition(validInput({
    candidate_source: { files },
    regression_results: {
      ...passingProtectedCompositionResults(loadProtectedManifests(ROOT)),
      'wallet-relative': { ok: false, reason: '$139 bank billing classified as wallet Pending Out' },
    },
  }), { root: ROOT });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.REGRESSION_DETECTED);
  const blob = JSON.stringify(result.errors);
  assert.match(blob, /wallet-relative|bank_billing_is_not_wallet_pending_out/);
});

test('7b. treating an existing production wallet as Pending setup is rejected', () => {
  const files = loadWalletOpsFiles({
    'src/hooks/useWallet.ts': readRepo('src/hooks/useWallet.ts')
      .replaceAll('loadWalletSnapshot', 'syncWalletOnly'),
    'src/lib/payments/loadWalletSnapshot.ts': readRepo('src/lib/payments/loadWalletSnapshot.ts')
      .replaceAll('setup_required: false', 'setup_required: true'),
  });
  const result = evaluateProtectedComposition(validInput({
    candidate_source: { files },
    regression_results: {
      ...passingProtectedCompositionResults(loadProtectedManifests(ROOT)),
      'existing-wallet-not-pending-setup': { ok: false, reason: 'existing wallet labeled pending setup' },
    },
  }), { root: ROOT });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.REGRESSION_DETECTED);
  assert.match(JSON.stringify(result.errors), /existing_wallet_not_pending_setup|existing-wallet-not-pending-setup/);
});

test('8. omitting required protected-composition evidence is rejected', () => {
  const result = evaluateProtectedComposition(validInput({
    regression_results: {},
    contract_results: {},
    candidate_source: { files: {} },
    source_contracts: {},
    protected_file_hashes: {},
  }), { root: ROOT });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.PROTECTED_COMPOSITION_REQUIRED);
  assert.match(result.message, /omitted required regression|omitted source contract|protected file hash omitted/);
});

test('9. stale / obsolete production baseline is PRODUCTION_DRIFT_RECOMPOSITION_REQUIRED', () => {
  const result = evaluateProtectedComposition(validInput({
    composed_onto: { ...STALE },
    production_baseline_fingerprint: { ...STALE },
  }), { root: ROOT });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.PRODUCTION_DRIFT_RECOMPOSITION_REQUIRED);
  assert.match(result.message, /obsolete production fingerprint/);
});

test('10. production drift immediately before apply is PRODUCTION_DRIFT_RECOMPOSITION_REQUIRED', () => {
  const protectedResult = evaluateProtectedComposition(validInput({
    immediately_before: { ...DRIFT },
    immediately_before_fingerprint: { ...DRIFT },
  }), { root: ROOT });
  assert.equal(protectedResult.ok, false);
  assert.equal(protectedResult.code, CODES.PRODUCTION_DRIFT_RECOMPOSITION_REQUIRED);
  assert.match(protectedResult.message, /immediately before apply|BLOCK DEPLOYMENT/);

  const toctou = evaluateIndexToctou({
    preflight: LIVE,
    immediatelyBefore: DRIFT,
    driftCode: CODES.PRODUCTION_DRIFT_RECOMPOSITION_REQUIRED,
  });
  assert.equal(toctou.ok, false);
  assert.equal(toctou.code, CODES.PRODUCTION_DRIFT_RECOMPOSITION_REQUIRED);

  const spa = evaluateSpaPromote(validInput({
    immediately_before: { ...DRIFT },
    immediately_before_fingerprint: { ...DRIFT },
  }), { root: ROOT });
  assert.equal(spa.ok, false);
  assert.equal(spa.code, CODES.PRODUCTION_DRIFT_RECOMPOSITION_REQUIRED);
});

test('staging SPA TOCTOU remains DEPLOYMENT_COLLISION', () => {
  const result = evaluateIndexToctou({
    preflight: LIVE,
    immediatelyBefore: DRIFT,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.DEPLOYMENT_COLLISION);
});

test('production gate SPA fingerprint drift uses PRODUCTION_DRIFT_RECOMPOSITION_REQUIRED', () => {
  const result = evaluateProductionGate({
    target_environment: 'production',
    workstream_id: 'walletops-guard-protect',
    deployment_type: 'spa-promote',
    production_fingerprint: LIVE,
    immediately_before_fingerprint: DRIFT,
    accepted_source_composition: true,
    staging_acceptance: { ok: true, reference: 'staging' },
    approval: { approved: true, workstream_id: 'walletops-guard-protect' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.PRODUCTION_DRIFT_RECOMPOSITION_REQUIRED);
});

test('evaluateSpaPromote restore_previous_index remains STALE_PACKAGE', () => {
  const restore = evaluateSpaPromote(validInput({
    restore_previous_index: true,
    skip_protected_composition: true,
  }), { root: ROOT });
  assert.equal(restore.ok, false);
  assert.equal(restore.code, CODES.STALE_PACKAGE);
});

test('candidate branch HEAD is not treated as whole production source', () => {
  const result = evaluateProtectedComposition(validInput({
    branch_head_is_whole_production: true,
  }), { root: ROOT });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.SOURCE_COMPOSITION_REQUIRED);
});

test('absence from the candidate does not authorize removal', () => {
  const result = evaluateProtectedComposition(validInput({
    absence_authorizes_removal: true,
    absent_behaviors: ['Funding & Billing remains present'],
  }), { root: ROOT });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.REGRESSION_DETECTED);
  assert.match(result.message, /absence from the candidate worktree/);
});

test('shared WalletOps file edits require protected regressions', () => {
  const result = evaluateProtectedComposition(validInput({
    changed_paths: ['src/hooks/useWalletOps.ts'],
    regression_results: {},
    candidate_source: { files: {} },
    source_contracts: passingProtectedCompositionResults(loadProtectedManifests(ROOT)),
    protected_file_hashes: walletopsManifest().protected_file_hashes,
  }), { root: ROOT });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.PROTECTED_COMPOSITION_REQUIRED);
  assert.match(result.message, /shared WalletOps file changed/);
});

test('recreating the recovered provider transfer is rejected', () => {
  const result = evaluateProtectedComposition(validInput({
    recreate_provider_transfer_ids: ['9f9df312-32a9-4999-ace9-fc2b00669c75'],
  }), { root: ROOT });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.REGRESSION_DETECTED);
  assert.match(result.message, /9f9df312-32a9-4999-ace9-fc2b00669c75/);
});

test('hashed SPA filenames are evidence only and must not be required', () => {
  const allowed = evaluateProtectedComposition(validInput({
    candidate_entry: '/assets/index-FUTUREHASH.js',
    candidate_walletops: '/assets/WalletOps-FUTUREHASH.js',
  }), { root: ROOT });
  assert.equal(allowed.ok, true, allowed.message);

  const pinned = evaluateProtectedComposition(validInput({
    required_hashed_spa_filenames: ['/assets/index-DbYbvb6d.js'],
  }), { root: ROOT });
  assert.equal(pinned.ok, false);
  assert.equal(pinned.code, CODES.INVALID_MANIFEST);
});

test('explicit supersession is required to change the protected contract', () => {
  const broken = loadWalletOpsFiles({
    'src/pages/WalletOps.tsx': readRepo('src/pages/WalletOps.tsx').replace('Funding & Billing', 'Gone'),
  });
  const implicit = evaluateProtectedComposition(validInput({
    candidate_source: { files: broken },
  }), { root: ROOT });
  assert.equal(implicit.ok, false);
  assert.equal(implicit.code, CODES.REGRESSION_DETECTED);

  const incomplete = evaluateProtectedComposition(validInput({
    candidate_source: { files: broken },
    supersede: [{ composition_id: 'walletops-activity-recovery', approved: true, evidence: '' }],
  }), { root: ROOT });
  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.code, CODES.PROTECTED_COMPOSITION_REQUIRED);
  assert.match(incomplete.message, /supersession/);

  const explicit = evaluateProtectedComposition(validInput({
    candidate_source: { files: broken },
    supersede: [{
      composition_id: 'walletops-activity-recovery',
      approved: true,
      evidence: 'ops/deployment-guard/walletops-activity-recovery-prod-accepted.json',
      replacement_tests: replacementTests(),
    }],
  }), { root: ROOT });
  assert.equal(explicit.ok, true, explicit.message);
});

test('official evaluateDeployment rejects omitted WalletOps evidence', () => {
  const result = evaluateDeployment(validInput({
    regression_results: {},
    candidate_source: undefined,
    source_contracts: {},
    protected_file_hashes: {},
  }), { root: ROOT });
  assert.equal(result.ok, false);
  assert.ok([
    CODES.PROTECTED_COMPOSITION_REQUIRED,
    CODES.REGRESSION_DETECTED,
  ].includes(result.code));
});

test('docs keep DEPLOYMENT_COLLISION and name the new production SPA codes', () => {
  const agents = readRepo('AGENTS.md');
  const rule = readRepo('.cursor/rules/deployment-guard.mdc');
  const readme = readRepo('ops/deployment-guard/README.md');
  for (const text of [agents, rule, readme]) {
    assert.match(text, /DEPLOYMENT_COLLISION/);
    assert.match(text, /PRODUCTION_DRIFT_RECOMPOSITION_REQUIRED/);
    assert.match(text, /PROTECTED_COMPOSITION_REQUIRED/);
  }
});

test('error-code priority prefers production drift over other composition errors', () => {
  const result = evaluateProtectedComposition(validInput({
    composed_onto: { ...STALE },
    regression_results: {},
    candidate_source: { files: {} },
  }), { root: ROOT });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.PRODUCTION_DRIFT_RECOMPOSITION_REQUIRED);
  assert.ok(codesOf(result).includes(CODES.PROTECTED_COMPOSITION_REQUIRED)
    || codesOf(result).includes(CODES.REGRESSION_DETECTED)
    || codesOf(result).includes(CODES.PRODUCTION_DRIFT_RECOMPOSITION_REQUIRED));
});
