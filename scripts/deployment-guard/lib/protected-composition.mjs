/**
 * Protected accepted-composition gate.
 *
 * Production SPA promote must prove current live baseline + candidate delta
 * still contain every enabled accepted composition. Chat instructions are
 * not the protection. Hashed SPA filenames are evidence only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CODES, errorEntry, failMany, ok } from './errors.mjs';

export const PROTECTED_COMPOSITION_DIR = 'ops/deployment-guard/protected-composition';
export const PROTECTED_COMPOSITION_REGISTRY = `${PROTECTED_COMPOSITION_DIR}/registry.json`;

const MAYBE_SINGLE_OPERATING = /\.eq\(\s*["']wallet_type["']\s*,\s*["']operating["']\s*\)[\s\S]{0,120}\.maybeSingle\s*\(/;

function fingerprintKey(fp = {}) {
  return JSON.stringify({
    index_html_sha256: fp.index_html_sha256 || null,
    entry_bundle: fp.entry_bundle || null,
    version_id: fp.version_id || fp.s3_version_id || null,
  });
}

function resultOk(result) {
  return result === true || result === 'pass' || result?.ok === true;
}

function asList(value) {
  return Array.isArray(value) ? value : [];
}

export function loadProtectedCompositionRegistry(root, rel = PROTECTED_COMPOSITION_REGISTRY) {
  return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
}

export function loadProtectedManifest(root, rel) {
  return JSON.parse(fs.readFileSync(path.join(root, PROTECTED_COMPOSITION_DIR, rel), 'utf8'));
}

export function loadProtectedManifests(root, registry = null) {
  const list = registry || loadProtectedCompositionRegistry(root);
  return (list.manifests || []).map((row) => ({
    ...loadProtectedManifest(root, row.path),
    registry: row,
  }));
}

export function relevantProtectedManifests(manifests, {
  environment,
  component,
  deployment_type,
} = {}) {
  return (manifests || []).filter((row) => {
    if (row.enabled === false || row.accepted === false) return false;
    const envs = row.environments || row.registry?.environments || ['production'];
    if (environment && !envs.includes(environment) && !envs.includes('*')) return false;
    const components = row.components || row.registry?.components || [];
    if (component && components.length && !components.includes(component) && !components.includes('*')) return false;
    const types = row.deployment_types || row.registry?.deployment_types || [];
    if (deployment_type && types.length && !types.includes(deployment_type) && !types.includes('*')) return false;
    return true;
  });
}

export function passingProtectedCompositionResults(manifests) {
  const out = {};
  for (const manifest of manifests || []) {
    for (const id of Object.keys(manifest.required_regression_tests || {})) {
      out[id] = { ok: true };
    }
    for (const id of asList(manifest.source_contracts)) {
      out[id] = { ok: true };
    }
  }
  return out;
}

export function evaluateWalletOpsSourceContracts(files = {}) {
  const useWalletOps = String(files['src/hooks/useWalletOps.ts'] || '');
  const wallets = String(files['src/lib/payments/wallets.ts'] || '');
  const page = String(files['src/pages/WalletOps.tsx'] || '');
  const select = String(files['src/lib/payments/selectPaymentWallet.ts'] || '');
  const relative = String(files['src/lib/payments/walletRelativeTransfers.ts'] || '');
  const eligibility = String(files['src/hooks/usePaymentProviderEligibility.ts'] || '');
  const compliance = String(files['src/components/settings/ComplianceSettings.tsx'] || '');
  const whiteLabel = String(files['src/components/white-label/WhiteLabelSettings.tsx'] || '');
  const walletAndSelect = `${useWalletOps}\n${wallets}\n${select}`;

  const checks = {
    environment_aware_wallet_selection: /selectPaymentWallet/.test(useWalletOps)
      && /resolveWalletOpsEnvironment/.test(walletAndSelect),
    production_host_selects_production_wallet: /checksops\.com/.test(select)
      && /return "production"/.test(select),
    staging_host_selects_sandbox_wallet: /staging\.checksops\.com/.test(select)
      && /return "sandbox"/.test(select),
    ambiguous_wallet_fails_safe: /ambiguous_wallet/.test(select)
      && /wanted\.length > 1/.test(select),
    no_maybeSingle_unscoped_operating_wallets: !MAYBE_SINGLE_OPERATING.test(useWalletOps)
      && !MAYBE_SINGLE_OPERATING.test(wallets),
    no_rows_0_wallet_pick: !/Never picks rows\[0\]/.test(select) || !/\brows\s*\[\s*0\s*\]\s*;/.test(select),
    funding_and_billing_present: /Funding & Billing/.test(page),
    recent_activity_present: /Recent Wallet Activity/.test(page),
    payout_preferences_absent_from_walletops: !/title="Payout Preferences"/.test(page)
      && !/Save payout preference/.test(page),
    payment_account_management_absent_from_walletops: !/title="Payment Account"/.test(page)
      && !/PaymentAccountPanel/.test(page),
    payment_account_present_in_compliance: /Payment Account Setup/.test(compliance)
      || /PaymentAccountPanel/.test(compliance)
      || /ComplianceSettings/.test(whiteLabel),
    pending_wallet_funding_is_pending_in: /pending && isWalletDestination && !isWalletSource/.test(relative)
      && /kind = ["']pending_in["']/.test(relative),
    completed_funding_remains_activity: /isWalletDestination && !row\.isWalletSource/.test(page)
      || /completed \$5 funding leaves Pending In/.test(relative),
    bank_billing_is_not_wallet_pending_out: /isChecksOpsBillingTransfer/.test(relative)
      && !/if \(isChecksOpsBillingTransfer\(transfer\)\) kind = ["']pending_out["']/.test(relative),
  };

  if (Object.keys(files).length && select && /rows\s*\[\s*0\s*\]/.test(select) && /selectPaymentWallet/.test(select)) {
    const body = select.slice(select.indexOf('export function selectPaymentWallet'));
    if (/return wanted\[0\]/.test(body) === false && /rows\[0\]/.test(body)) {
      checks.no_rows_0_wallet_pick = false;
    }
  }
  if (select && /return rows\s*\[\s*0\s*\]/.test(select)) {
    checks.no_rows_0_wallet_pick = false;
    checks.ambiguous_wallet_fails_safe = false;
  }

  const out = {};
  for (const [id, okFlag] of Object.entries(checks)) {
    out[id] = { ok: Boolean(okFlag) };
  }
  if (eligibility && !/tenantMoovEnvironment/.test(eligibility)) {
    out.environment_aware_wallet_selection = { ok: false };
  }
  return out;
}

function supersessionFor(input, compositionId) {
  const rows = asList(input.supersede || input.supersessions);
  return rows.find((row) => row && row.composition_id === compositionId) || null;
}

function validSupersession(row, manifest) {
  if (!row || row.approved !== true) return false;
  if (!String(row.evidence || '').trim()) return false;
  const replacement = row.replacement_tests || {};
  const required = Object.keys(manifest.required_regression_tests || {});
  if (!required.length) return Boolean(Object.keys(replacement).length);
  return required.every((id) => resultOk(replacement[id]));
}

export function evaluateProtectedComposition(input = {}, ctx = {}) {
  const environment = input.target_environment || input.environment;
  const deploymentType = input.deployment_type;
  if (environment !== 'production' || deploymentType !== 'spa-promote') {
    return ok({ protected_composition: 'not_applicable', environment, deployment_type: deploymentType });
  }

  const errors = [];
  let manifests = ctx.manifests || input.protected_manifests || null;
  if (!manifests) {
    if (!ctx.root) {
      return failMany([errorEntry(
        CODES.PROTECTED_COMPOSITION_REQUIRED,
        'production SPA requires protected-composition manifests; candidate omitted accepted composition evidence',
      )], CODES.PROTECTED_COMPOSITION_REQUIRED);
    }
    try {
      manifests = loadProtectedManifests(ctx.root);
    } catch (error) {
      return failMany([errorEntry(
        CODES.PROTECTED_COMPOSITION_REQUIRED,
        `failed to load protected-composition registry: ${error.message}`,
      )], CODES.PROTECTED_COMPOSITION_REQUIRED);
    }
  }

  const relevant = relevantProtectedManifests(manifests, {
    environment,
    component: input.target_component,
    deployment_type: deploymentType,
  });
  if (!relevant.length) {
    return failMany([errorEntry(
      CODES.PROTECTED_COMPOSITION_REQUIRED,
      'production SPA has no enabled protected-composition manifests; refuse rather than deploy unprotected',
    )], CODES.PROTECTED_COMPOSITION_REQUIRED);
  }

  if (input.branch_head_is_whole_production === true) {
    errors.push(errorEntry(
      CODES.SOURCE_COMPOSITION_REQUIRED,
      'candidate branch HEAD is not equivalent to whole production source; compose onto the live baseline',
    ));
  }

  const live = input.production_fingerprint || input.live_production_fingerprint || null;
  const composedOnto = input.composed_onto || input.production_baseline_fingerprint || input.baseline_fingerprint || null;
  if (!live?.index_html_sha256 || !live?.entry_bundle) {
    errors.push(errorEntry(
      CODES.PROTECTED_COMPOSITION_REQUIRED,
      'production SPA must freshly fingerprint live production (index.html + entry) before composition',
    ));
  }
  if (!composedOnto?.index_html_sha256 || !composedOnto?.entry_bundle) {
    errors.push(errorEntry(
      CODES.PROTECTED_COMPOSITION_REQUIRED,
      'candidate must identify the live production baseline it was composed onto',
    ));
  } else if (live?.index_html_sha256 && fingerprintKey(live) !== fingerprintKey(composedOnto)) {
    errors.push(errorEntry(
      CODES.PRODUCTION_DRIFT_RECOMPOSITION_REQUIRED,
      'candidate was composed onto an obsolete production fingerprint; recompose onto the NEW live baseline',
      { live, composed_onto: composedOnto },
    ));
  }

  const preflight = input.preflight || input.preflight_live_fingerprint || input.production_fingerprint;
  const immediatelyBefore = input.immediately_before || input.immediately_before_fingerprint;
  if (preflight?.index_html_sha256 && immediatelyBefore?.index_html_sha256
    && fingerprintKey(preflight) !== fingerprintKey(immediatelyBefore)) {
    errors.push(errorEntry(
      CODES.PRODUCTION_DRIFT_RECOMPOSITION_REQUIRED,
      'production changed immediately before apply; BLOCK DEPLOYMENT and do not write production objects',
      { preflight, immediately_before: immediatelyBefore },
    ));
  }

  const regression = {
    ...(input.contract_results || {}),
    ...(input.regression_results || {}),
    ...(input.protected_composition_results || {}),
  };
  const sourceResults = { ...(input.source_contracts || {}) };
  const candidateFiles = input.candidate_source?.files || input.source_files || null;
  if (candidateFiles && Object.keys(candidateFiles).length) {
    Object.assign(sourceResults, evaluateWalletOpsSourceContracts(candidateFiles));
  }

  const changedPaths = asList(input.changed_paths || input.owned_components);
  const recreate = new Set(asList(input.recreate_provider_transfer_ids));
  const retryUnseen = input.retry_unseen_provider_transfers === true
    || input.recreate_unseen_provider_transfers === true;
  const absent = new Set(asList(input.absent_behaviors || input.absent_from_candidate));
  const candidateHashes = input.protected_file_hashes || input.v2_hashes || {};

  if (input.required_hashed_spa_filenames?.length) {
    errors.push(errorEntry(
      CODES.INVALID_MANIFEST,
      'protected composition must not require hashed SPA filenames; protect behavior and tests instead',
      { required_hashed_spa_filenames: input.required_hashed_spa_filenames },
    ));
  }

  for (const manifest of relevant) {
    const superseded = supersessionFor(input, manifest.id);
    if (superseded) {
      if (!validSupersession(superseded, manifest)) {
        errors.push(errorEntry(
          CODES.PROTECTED_COMPOSITION_REQUIRED,
          `supersession of ${manifest.id} requires approved=true, evidence, and passing replacement tests`,
          { composition_id: manifest.id, supersede: superseded },
        ));
        continue;
      }
      continue;
    }

    const tests = manifest.required_regression_tests || {};
    const sharedTouched = asList(manifest.shared_files).some((file) => changedPaths.includes(file));
    for (const [testId, testPath] of Object.entries(tests)) {
      const result = regression[testId];
      if (result == null) {
        errors.push(errorEntry(
          CODES.PROTECTED_COMPOSITION_REQUIRED,
          sharedTouched
            ? `shared WalletOps file changed; required protected regression ${testId} was not executed`
            : `protected composition ${manifest.id} omitted required regression ${testId}`,
          { composition_id: manifest.id, test: testId, path: testPath, shared_file_touch: sharedTouched },
        ));
      } else if (!resultOk(result)) {
        errors.push(errorEntry(
          CODES.REGRESSION_DETECTED,
          `protected composition ${manifest.id} regression ${testId} failed`,
          { composition_id: manifest.id, test: testId, result },
        ));
      }
    }

    for (const checkId of asList(manifest.source_contracts)) {
      const result = sourceResults[checkId];
      if (result == null) {
        errors.push(errorEntry(
          CODES.PROTECTED_COMPOSITION_REQUIRED,
          `protected composition ${manifest.id} omitted source contract ${checkId}`,
          { composition_id: manifest.id, source_contract: checkId },
        ));
      } else if (!resultOk(result)) {
        errors.push(errorEntry(
          CODES.REGRESSION_DETECTED,
          `protected composition ${manifest.id} source contract failed: ${checkId}`,
          { composition_id: manifest.id, source_contract: checkId, result },
        ));
      }
    }

    for (const transferId of asList(manifest.do_not_recreate_provider_transfer_ids)) {
      if (recreate.has(transferId) || retryUnseen) {
        errors.push(errorEntry(
          CODES.REGRESSION_DETECTED,
          `recovered provider transfer ${transferId} must not be recreated/retried because a later candidate cannot see it`,
          { composition_id: manifest.id, provider_transfer_id: transferId },
        ));
      }
    }

    const protectedHashes = manifest.protected_file_hashes || {};
    for (const [file, expected] of Object.entries(protectedHashes)) {
      const actual = candidateHashes[file];
      if (!actual) {
        errors.push(errorEntry(
          CODES.PROTECTED_COMPOSITION_REQUIRED,
          `protected file hash omitted for ${file}`,
          { composition_id: manifest.id, file, expected },
        ));
      } else if (actual !== expected) {
        errors.push(errorEntry(
          CODES.REGRESSION_DETECTED,
          `protected V2/financial file hash changed: ${file}`,
          { composition_id: manifest.id, file, expected, actual },
        ));
      }
    }

    if (manifest.pin_hashed_spa_filenames === true) {
      errors.push(errorEntry(
        CODES.INVALID_MANIFEST,
        `${manifest.id} must not pin hashed SPA filenames as a required deploy identity`,
        { composition_id: manifest.id },
      ));
    }

    if (manifest.absence_based_deletion === 'forbidden_unless_superseded') {
      const missingBehaviors = asList(manifest.behaviors).filter((behavior) => absent.has(behavior));
      if (missingBehaviors.length || input.absence_authorizes_removal === true) {
        errors.push(errorEntry(
          CODES.REGRESSION_DETECTED,
          'absence from the candidate worktree does not authorize removal of accepted production functionality',
          { composition_id: manifest.id, missing_behaviors: missingBehaviors },
        ));
      }
    }
  }

  if (errors.length) {
    const code = errors.some((row) => row.code === CODES.PRODUCTION_DRIFT_RECOMPOSITION_REQUIRED)
      ? CODES.PRODUCTION_DRIFT_RECOMPOSITION_REQUIRED
      : errors.some((row) => row.code === CODES.REGRESSION_DETECTED)
        ? CODES.REGRESSION_DETECTED
        : errors[0].code;
    return failMany(errors, code);
  }

  return ok({
    protected_composition: 'preserved',
    manifests: relevant.map((row) => row.id),
    regressions: Object.keys(regression),
  });
}
