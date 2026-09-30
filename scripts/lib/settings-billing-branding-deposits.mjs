/**
 * Accepted settings/billing/branding/deposit behavior and SPA composition
 * preflight protection. Historical artifact hashes are provenance, not
 * rollback targets. Never writes AWS.
 */
import { ACCEPTED_PRODUCTION_SPA, SUPERSEDED_PRODUCTION_SPA_BUNDLES, normalizeSpaBundle } from './production-spa-baseline.mjs';

export const SETTINGS_COMPONENT_ID = 'settings-billing-branding-deposits';

export const APPLICATION_CANDIDATE_SHA = '17fa334d69fb9ca673bcde462b5bb0632e42f3dc';
export const TOOLING_FIX_SHA = '6059f03918cdba8858ad53a512aa030051bffb11';
export const WORKSTREAM_ID = 'settings-billing-branding-deposits-51c8';

export const STAGING_ACCEPTANCE = Object.freeze({
  host: 'https://staging.checksops.com/',
  spa_bundle: '/assets/index-CEKjixtZ.js',
  spa_sha256: 'bd36849ef6b63f2d10b03225f2796427440baddd9c9caf508eff76ba2bc18fae',
  index_html_sha256: 'bd9cb1cb5d8d76e3979d96101d0cfae5578beaeaadcd1670ebc2e9176a0fa6ee',
  invalidation_id: 'I9YHW13PUL6USXM8D5QRO07W1X',
  lambda_code_sha256: '//BfiiKna/KRIuX8NEPipSyagIVFxM/5BY7nTaT7OUs=',
  lambda_revision_id: '3698b6c6-3d83-444b-ace3-0eb80e362adc',
  isolated_http_login: 'NOT_ESTABLISHED',
  reference: 'https://staging.checksops.com/ /assets/index-CEKjixtZ.js index_html_sha256=bd9cb1cb5d8d76e3979d96101d0cfae5578beaeaadcd1670ebc2e9176a0fa6ee invalidation=I9YHW13PUL6USXM8D5QRO07W1X commit=17fa334d69fb9ca673bcde462b5bb0632e42f3dc',
});

export const REVIEWED_PRODUCTION_LAMBDA = Object.freeze({
  function_name: 'checksops-production-prep-api',
  codeSha256: 'pxZj4G6pGntJrkcRO5uNNEbiyvDpCOKPiWAboDnPvBA=',
  revisionId: '3bccd144-4e61-422f-8151-9ed0fe713aac',
  lastModified: '2026-09-30T16:25:23.000+0000',
});

export const REVIEWED_PRODUCTION_SPA = Object.freeze({
  ...ACCEPTED_PRODUCTION_SPA,
});

export const COMPOSED_SPA_CANDIDATE = Object.freeze({
  spa_bundle: '/assets/index-CEKjixtZ.js',
  spa_sha256: 'bd36849ef6b63f2d10b03225f2796427440baddd9c9caf508eff76ba2bc18fae',
  index_html_sha256: 'bd9cb1cb5d8d76e3979d96101d0cfae5578beaeaadcd1670ebc2e9176a0fa6ee',
  based_on_live: ACCEPTED_PRODUCTION_SPA.spa_bundle,
});

export const OWNED_LAMBDA_MEMBERS = Object.freeze([
  'app-services.mjs',
  'tenant-settings-handlers.mjs',
  'tenant-email-domain-handlers.mjs',
  'providers/parity/moov-functions.mjs',
  'providers/parity/moov-stakeholder-status.mjs',
]);

export const MUST_PRESERVE_LAMBDA_MEMBERS = Object.freeze(['esign.mjs']);

export const INDEPENDENT_FIXES = Object.freeze([
  'WalletOps Item #4',
  'signature',
  'Claim Ledger',
  'OCR',
]);

export const SETTINGS_SOURCE_FILES = Object.freeze([
  'src/components/settings/CompanyBrandingSettings.tsx',
  'src/components/settings/EmailSenderSettings.tsx',
  'src/components/settings/TenantBillingAccountPanel.tsx',
  'src/components/deposit-ops/BankDepositReconciliation.tsx',
  'src/components/disbursement/StakeholderAccountSettings.tsx',
  'src/lib/tenantLogoUrl.ts',
  'src/pages/WalletOps.tsx',
  'scripts/deployment-guard/preflight.mjs',
  'scripts/deployment-guard/lib/production.mjs',
]);

export const HISTORICAL_SPA_BUNDLES = Object.freeze([
  ...SUPERSEDED_PRODUCTION_SPA_BUNDLES,
  '/assets/index-DvVldu_B.js',
  '/assets/index-CfEPSd2I.js',
]);

export const REGRESSION_MARKERS = Object.freeze({
  walletops_hides_payment_account: { file: 'src/pages/WalletOps.tsx', must_not: 'title="Payment Account"' },
  walletops_hides_payout_preferences: { file: 'src/pages/WalletOps.tsx', must_not: 'title="Payout Preferences"' },
  walletops_keeps_go_to_payment_account: { file: 'src/pages/WalletOps.tsx', must: 'Go to Payment Account' },
  email_sender_identity: { file: 'src/components/settings/EmailSenderSettings.tsx', must: 'Sender identity' },
  branding_invoice_accent: { file: 'src/components/settings/CompanyBrandingSettings.tsx', must: 'invoice_accent_color' },
  deposits_exclusion: { file: 'src/components/deposit-ops/BankDepositReconciliation.tsx', must: 'rejected,returned,error,declined' },
  stakeholder_bank_verified: { file: 'src/components/disbursement/StakeholderAccountSettings.tsx', must: 'Bank verified' },
  stakeholder_provider_linked: { file: 'src/components/disbursement/StakeholderAccountSettings.tsx', must: 'Provider linked' },
  preflight_forwards_composition: { file: 'scripts/deployment-guard/preflight.mjs', must: 'accepted_source_composition: input.accepted_source_composition' },
  production_gate_validates_composition: { file: 'scripts/deployment-guard/lib/production.mjs', must: 'evaluateAcceptedSourceComposition' },
});

export function isHistoricalSpaBundle(bundle) {
  const normalized = normalizeSpaBundle(bundle);
  return Boolean(normalized && HISTORICAL_SPA_BUNDLES.includes(normalized));
}

export function fingerprintDiffs(reviewed, live, fields) {
  const diffs = [];
  for (const field of fields) {
    const expected = reviewed?.[field];
    const actual = live?.[field];
    if (expected !== actual) {
      diffs.push({ field, reviewed: expected ?? null, live: actual ?? null });
    }
  }
  return diffs;
}

export function evaluateReviewedBaselineMatch({ kind, reviewed, live }) {
  if (!live || typeof live !== 'object') {
    return {
      ok: false,
      code: 'DEPLOYMENT_COLLISION',
      message: `${kind} live fingerprint is missing; stop and do not apply`,
      diffs: [],
    };
  }
  const fields = kind === 'lambda'
    ? ['codeSha256', 'revisionId']
    : ['spa_bundle', 'spa_sha256', 'index_html_sha256', 's3_version'];
  const diffs = fingerprintDiffs(reviewed, live, fields);
  if (diffs.length) {
    return {
      ok: false,
      code: 'DEPLOYMENT_COLLISION',
      message: `${kind} live fingerprint differs from the reviewed baseline; stop and do not restore or overwrite newer work`,
      diffs,
    };
  }
  return { ok: true, code: null, message: 'reviewed baseline matches live', diffs: [] };
}

export function evaluateHistoricalRestore({ candidateBundle, restoreHistorical = false } = {}) {
  if (restoreHistorical === true || isHistoricalSpaBundle(candidateBundle)) {
    return {
      ok: false,
      code: 'STALE_PACKAGE',
      message: 'historical artifact hashes are provenance, not rollback targets; refuse restore of an older SPA or Lambda package',
      candidate_bundle: candidateBundle || null,
    };
  }
  return { ok: true, code: null, message: 'candidate is not a historical restore' };
}

export function evaluateReconcileWithLiveSource(row = {}) {
  const errors = [];
  if (row.reconcile_with_live_source === false) {
    errors.push('future builds must reconcile these fixes with current live source');
  }
  if (row.source_conflict === true) {
    errors.push('source conflict; stop');
  }
  if (row.overwrite_independent_fixes === true) {
    errors.push(`must preserve ${INDEPENDENT_FIXES.join(', ')}, and other independent fixes`);
  }
  if (row.homeowner_association === true) {
    errors.push('homeowner association is not authorized from this lock');
  }
  return errors;
}

export function compareSettingsCandidate(component, row) {
  const errors = [];
  const prefix = SETTINGS_COMPONENT_ID;
  if (row == null) return errors;
  if (typeof row !== 'object') {
    errors.push(`${prefix}: candidate row must be an object`);
    return errors;
  }
  if (row.deploy === true && component?.classification !== 'PRODUCTION_LOCKED') {
    errors.push(`${prefix}: candidate deploys a component that is not PRODUCTION_LOCKED`);
  }
  if (row.restore_historical === true || isHistoricalSpaBundle(row.spa_bundle) || isHistoricalSpaBundle(row.restore_bundle)) {
    errors.push(`${prefix}: historical artifact hashes are provenance, not rollback targets`);
  }
  for (const error of evaluateReconcileWithLiveSource(row)) {
    errors.push(`${prefix}: ${error}`);
  }
  if (row.missing_invariants === true) {
    errors.push(`${prefix}: missing accepted settings/billing/branding/deposit or composition-preflight invariants`);
  }
  return errors;
}
