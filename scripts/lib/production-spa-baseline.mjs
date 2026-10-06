/**
 * Production SPA baseline helpers.
 *
 * Protects the already-live checksops.com SPA so a stale branch, unreconciled
 * main, or destructive overlay cannot overwrite it. Never writes AWS.
 */
import { isSha256 } from './release-locks.mjs';

export const PRODUCTION_SPA_ID = 'production-spa';

export const ACCEPTED_PRODUCTION_SPA = Object.freeze({
  host: 'https://checksops.com',
  spa_bundle: '/assets/index-HXTuSrE0.js',
  spa_sha256: 'd584fe66e677db7ff0b532fc2a296a578a40f6b4f7b5f7a58f5c8e839d90041d',
  index_html_sha256: 'a33569d86c2483eecdb8550a47013ccb087011d201f718765a567647958d2b52',
  s3_version: 'PzXfOI.HeUgvUqw6Q2L_PzPMmL1EbEXX',
  cloudfront_id: 'E1B0ZWWO5559U5',
  last_modified: 'Fri, 02 Oct 2026 15:03:04 GMT',
  accepted_at: '2026-10-02T15:03:04Z',
  source_lineage: 'b39738cab7c1afd68e97c88781766b6cabe04896',
  banner_overlay: '2277ab9ead9ab8270446468421f9dd8cc3e1a401',
  s3_bucket: 'checksops-production-frontend-806168576068',
});

export const SUPERSEDED_PRODUCTION_SPA_BUNDLES = Object.freeze([
  '/assets/index-BtDKt23D.js',
  '/assets/index-DSbVZXu8.js',
  '/assets/index-BPbQUNFr.js',
  '/assets/index-CTqMys28.js',
  '/assets/index-gYa_BW8r.js',
  '/assets/index-BAD1KYoF.js',
  '/assets/index-C24V_ODo.js',
  '/assets/index-reP2FWHf.js',
  '/assets/index-CiOVNYWh.js',
  '/assets/index-DyoF7zdg.js',
]);

export const SAFE_SPA_DEPLOY_MODE = 'per_object_put';

export const DESTRUCTIVE_SPA_DEPLOY_MODES = Object.freeze([
  's3_sync_delete',
  's3_sync',
  'sync_delete',
  'destructive',
]);

export function normalizeSpaBundle(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  if (trimmed.startsWith('/')) return trimmed;
  if (trimmed.startsWith('assets/')) return `/${trimmed}`;
  return trimmed;
}

export function lockedSpaPins(component) {
  const fp = component?.deployment_fingerprint || {};
  return {
    spa_bundle: normalizeSpaBundle(fp.spa_bundle || component?.artifact?.name),
    spa_sha256: fp.spa_sha256 || component?.artifact?.hash || null,
    index_html_sha256: fp.config_hash || null,
    s3_version: fp.cloudfront_deployment_fingerprint || component?.artifact?.version || null,
  };
}

export function snapshotPins(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  return {
    spa_bundle: normalizeSpaBundle(snapshot.spa_bundle),
    spa_sha256: snapshot.spa_sha256 || snapshot.hash || null,
    index_html_sha256: snapshot.index_html_sha256 || null,
    s3_version: snapshot.s3_version || null,
  };
}

export function pinsEqual(left, right) {
  if (!left || !right) return false;
  return left.spa_bundle === right.spa_bundle
    && left.spa_sha256 === right.spa_sha256
    && left.index_html_sha256 === right.index_html_sha256
    && left.s3_version === right.s3_version;
}

export function candidatePins(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    spa_bundle: normalizeSpaBundle(row.spa_bundle),
    spa_sha256: row.hash || row.spa_sha256 || null,
    index_html_sha256: row.index_html_sha256 || null,
    s3_version: row.s3_version || null,
  };
}

export function isSupersededSpaBundle(bundle) {
  const normalized = normalizeSpaBundle(bundle);
  if (!normalized) return false;
  return SUPERSEDED_PRODUCTION_SPA_BUNDLES.includes(normalized);
}

export function isDestructiveSpaDeploy(row) {
  if (!row || typeof row !== 'object') return false;
  if (row.destructive === true) return true;
  const mode = String(row.deploy_mode || '').trim();
  if (DESTRUCTIVE_SPA_DEPLOY_MODES.includes(mode)) return true;
  return /sync/i.test(mode) && /delete/i.test(mode);
}

export function isUnreconciledMainSource(row, { matchesLockedIdentity, basedOnLocked }) {
  if (matchesLockedIdentity || basedOnLocked) return false;
  if (row?.reconciled_to_production_baseline === true) return false;
  if (row?.unreconciled_main === true) return true;
  const sourceRef = String(row?.source_branch || row?.source_ref || '').trim();
  return sourceRef === 'main' || sourceRef === 'origin/main' || sourceRef === 'refs/heads/main';
}

export function pinsComplete(pins, { requireS3Version = true } = {}) {
  if (!pins) return false;
  if (!pins.spa_bundle || !pins.spa_sha256 || !pins.index_html_sha256) return false;
  if (requireS3Version && !pins.s3_version) return false;
  return isSha256(pins.spa_sha256) && isSha256(pins.index_html_sha256);
}

export function isExplicitForwardSupersession(row) {
  return row?.forward_supersession === true;
}

function sourceIdentity(row) {
  const source = row?.source && typeof row.source === 'object' ? row.source : {};
  return {
    git_sha: source.git_sha || row?.git_sha || null,
    tree_hash: source.tree_hash || row?.tree_hash || null,
  };
}

function receiptEvidenceErrors(receipt, now) {
  const prefix = PRODUCTION_SPA_ID;
  if (!receipt || typeof receipt !== 'object') {
    return [`${prefix}: forward supersession requires a signed deployment-guard receipt`];
  }
  if (receipt.consumed === true || receipt.reused === true) {
    return [`${prefix}: forward supersession receipt has already been consumed; refuse reused receipt`];
  }
  if (receipt.valid === false || receipt.forged === true) {
    return [`${prefix}: forward supersession receipt is invalid or forged`];
  }
  const hasMac = /^[0-9a-f]{64}$/.test(String(receipt.mac || ''));
  const hasKms = Boolean(receipt.kms_signature && receipt.kms_key_arn);
  if (!hasMac && !hasKms) {
    return [`${prefix}: forward supersession receipt is invalid or forged`];
  }
  if (receipt.expiry && Date.parse(receipt.expiry) <= now) {
    return [`${prefix}: forward supersession receipt has expired`];
  }
  if (!receipt.workstream_id) {
    return [`${prefix}: forward supersession receipt is invalid or forged`];
  }
  return [];
}

function leaseEvidenceErrors(lease) {
  const prefix = PRODUCTION_SPA_ID;
  if (!lease || typeof lease !== 'object' || lease.present === false) {
    return [`${prefix}: forward supersession requires an active lease`];
  }
  if (lease.expired === true) {
    return [`${prefix}: forward supersession lease is expired`];
  }
  if (!lease.workstream_id) {
    return [`${prefix}: forward supersession requires an active lease`];
  }
  return [];
}

function preservationEvidenceErrors(row) {
  const prefix = PRODUCTION_SPA_ID;
  const errors = [];
  if (row.accepted_feature_contracts_passed !== true) {
    errors.push(`${prefix}: forward supersession is missing accepted-feature/regression contract evidence`);
  }
  if (row.required_live_behavior_preserved !== true) {
    errors.push(`${prefix}: forward supersession is missing preservation evidence that required live behavior is kept`);
  }
  const evidence = row.preservation_evidence;
  if (!evidence || typeof evidence !== 'object') {
    errors.push(`${prefix}: forward supersession is missing preservation evidence`);
    return errors;
  }
  if (!Array.isArray(evidence.passed_contracts) || evidence.passed_contracts.length === 0) {
    errors.push(`${prefix}: forward supersession is missing accepted-feature/regression contract evidence`);
  }
  if (Array.isArray(evidence.live_only_risks) && evidence.live_only_risks.length > 0) {
    errors.push(`${prefix}: forward supersession preservation evidence reports live-only behavior that would be removed`);
  }
  if (evidence.required_live_behavior_preserved === false) {
    errors.push(`${prefix}: forward supersession is missing preservation evidence that required live behavior is kept`);
  }
  return errors;
}

/**
 * Explicit B → C supersession when live has advanced past historical lock A.
 * Never inferred from reconciled_to_production_baseline or a lock-hash edit.
 */
export function evaluateForwardSupersession(component, row, opts = {}) {
  const errors = [];
  const prefix = PRODUCTION_SPA_ID;
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  if (!isExplicitForwardSupersession(row)) {
    errors.push(`${prefix}: forward supersession intent is missing; ordinary deployment cannot supersede an orphaned live SPA`);
    return { authorized: false, errors };
  }
  if (row.deploy !== true) {
    errors.push(`${prefix}: forward supersession requires deploy=true`);
  }
  const productionIntent = row.production_deploy_intent === true || opts.productionIntent === true;
  if (!productionIntent) {
    errors.push(`${prefix}: forward supersession requires explicit production deployment intent`);
  }

  const locked = lockedSpaPins(component);
  const current = candidatePins(row);
  const live = snapshotPins(row.live_production);
  const preflight = snapshotPins(row.preflight_production);
  const reconciled = snapshotPins(row.reconciled_against_live);
  const historical = snapshotPins(row.historical_locked_baseline) || snapshotPins(row.based_on_baseline);

  if (!pinsComplete(locked)) {
    errors.push(`${prefix}: forward supersession requires the current historical locked fingerprint`);
  }
  if (!pinsComplete(live)) {
    errors.push(`${prefix}: forward supersession requires the exact fresh live production fingerprint`);
  }
  if (!pinsComplete(historical)) {
    errors.push(`${prefix}: forward supersession requires the exact historical locked fingerprint`);
  } else if (!pinsEqual(historical, locked)) {
    errors.push(`${prefix}: historical_locked_baseline does not match the current Release Lock`);
  }
  if (!pinsComplete(reconciled)) {
    errors.push(`${prefix}: forward supersession requires reconciled_against_live matching the fresh live fingerprint`);
  } else if (live && !pinsEqual(reconciled, live)) {
    errors.push(`${prefix}: candidate reconciled against a different live fingerprint; refuse deployment`);
  }
  if (!pinsComplete(preflight)) {
    errors.push(`${prefix}: production SPA deploy requires preflight_production and live_production TOCTOU snapshots`);
  } else if (live && !pinsEqual(preflight, live)) {
    errors.push(`${prefix}: live changed after supersession preflight; refuse deployment`);
  }
  if (live && pinsEqual(live, locked)) {
    errors.push(`${prefix}: live already matches the locked baseline; use ordinary deployment, not forward supersession`);
  }

  if (!pinsComplete(current, { requireS3Version: false })) {
    errors.push(`${prefix}: forward supersession candidate is missing a new known source composition identity`);
  } else {
    if (live && current.spa_bundle === live.spa_bundle) {
      errors.push(`${prefix}: forward supersession candidate must not redeploy the unexplained live bundle`);
    }
    if (current.spa_bundle === locked.spa_bundle) {
      errors.push(`${prefix}: forward supersession candidate must not restore the historical locked baseline`);
    }
    if (isSupersededSpaBundle(current.spa_bundle)) {
      errors.push(`${prefix}: stale SPA candidate is older than the accepted production baseline`);
    }
  }

  const source = sourceIdentity(row);
  if (!isGitShaSafe(source.git_sha) || !isSourceTreeHash(source.tree_hash)) {
    errors.push(`${prefix}: forward supersession is missing source identity (git SHA/tree)`);
  }
  if (row.accepted_source_composition !== true) {
    errors.push(`${prefix}: forward supersession is missing accepted source composition evidence`);
  }

  errors.push(...preservationEvidenceErrors(row));
  errors.push(...leaseEvidenceErrors(row.lease || opts.lease));
  errors.push(...receiptEvidenceErrors(row.receipt || opts.receipt, now));

  return { authorized: errors.length === 0, errors };
}

function isGitShaSafe(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

function isSourceTreeHash(value) {
  return isSha256(value || '') || isGitShaSafe(value);
}

export function compareProductionSpaCandidate(component, row, opts = {}) {
  const errors = [];
  const prefix = PRODUCTION_SPA_ID;
  if (!row || typeof row !== 'object') {
    errors.push(`${prefix}: PRODUCTION_LOCKED component missing from candidate fingerprint`);
    return errors;
  }

  const locked = lockedSpaPins(component);
  const current = candidatePins(row);
  const basedOn = snapshotPins(row.based_on_baseline);
  const matchesLockedIdentity = Boolean(
    current?.spa_bundle
    && current?.spa_sha256
    && current.spa_bundle === locked.spa_bundle
    && current.spa_sha256 === locked.spa_sha256,
  );
  const basedOnLocked = pinsEqual(basedOn, locked);
  const explicitSupersession = isExplicitForwardSupersession(row);
  const supersession = explicitSupersession
    ? evaluateForwardSupersession(component, row, opts)
    : { authorized: false, errors: [] };

  if (row.deploy === true) {
    const preflight = snapshotPins(row.preflight_production);
    const live = snapshotPins(row.live_production);
    if (!preflight || !live) {
      errors.push(`${prefix}: production SPA deploy requires preflight_production and live_production TOCTOU snapshots`);
    } else {
      if (!pinsEqual(preflight, live) && !explicitSupersession) {
        errors.push(`${prefix}: production changed after preflight (TOCTOU); refuse deployment`);
      }
      const liveMatchesLocked = pinsEqual(live, locked);
      if (!liveMatchesLocked) {
        if (explicitSupersession) {
          errors.push(...supersession.errors);
        } else {
          errors.push(`${prefix}: live production SPA does not match locked baseline; refuse deployment (do not auto-fix)`);
        }
      } else if (explicitSupersession) {
        errors.push(...supersession.errors);
      }
    }
    if (isDestructiveSpaDeploy(row)) {
      errors.push(`${prefix}: destructive frontend deployment is forbidden (no s3 sync --delete)`);
    } else if (!row.deploy_mode) {
      errors.push(`${prefix}: production SPA deploy requires deploy_mode=${SAFE_SPA_DEPLOY_MODE}`);
    } else if (row.deploy_mode !== SAFE_SPA_DEPLOY_MODE) {
      errors.push(`${prefix}: production SPA deploy_mode must be ${SAFE_SPA_DEPLOY_MODE}`);
    }
  } else if (explicitSupersession) {
    errors.push(...supersession.errors);
  }

  if (supersession.authorized) {
    if (component.artifact?.hash && !isSha256(row.hash || row.spa_sha256 || '')) {
      errors.push(`${prefix}: candidate omitted artifact hash`);
    }
    return errors;
  }

  if (isSupersededSpaBundle(current?.spa_bundle) || isSupersededSpaBundle(basedOn?.spa_bundle)) {
    errors.push(`${prefix}: stale SPA candidate is older than the accepted production baseline`);
  }

  if (isUnreconciledMainSource(row, { matchesLockedIdentity, basedOnLocked })) {
    errors.push(`${prefix}: unreconciled main/source is not the accepted production SPA baseline; refuse deployment`);
  }

  if (!matchesLockedIdentity) {
    if (!basedOn) {
      errors.push(`${prefix}: candidate is missing the accepted production baseline (based_on_baseline required when identity differs)`);
    } else if (!basedOnLocked) {
      errors.push(`${prefix}: based_on_baseline does not match the locked production SPA; refuse deployment`);
    }
    if (row.contains_accepted_baseline === false) {
      errors.push(`${prefix}: candidate drops accepted production baseline/source`);
    }
  }

  if (component.artifact?.hash && !isSha256(row.hash || row.spa_sha256 || '')) {
    errors.push(`${prefix}: candidate omitted artifact hash`);
  }

  return errors;
}

/**
 * Build the lock payload for C. Never writes. Never points the lock at unexplained live B.
 */
export function planProductionSpaLockAdvance({
  currentComponent,
  deployed,
  liveBefore,
  verified = null,
  failed = false,
} = {}) {
  const prefix = PRODUCTION_SPA_ID;
  if (failed === true || verified?.ok === false) {
    return {
      advance: false,
      component: currentComponent,
      errors: [`${prefix}: failed deployment must not advance the Release Lock`],
    };
  }
  const locked = lockedSpaPins(currentComponent);
  const deployedPins = candidatePins(deployed);
  const livePins = snapshotPins(liveBefore);
  if (!pinsComplete(deployedPins, { requireS3Version: false })) {
    return {
      advance: false,
      component: currentComponent,
      errors: [`${prefix}: lock advance requires the newly deployed candidate identity`],
    };
  }
  if (livePins && deployedPins.spa_bundle === livePins.spa_bundle) {
    return {
      advance: false,
      component: currentComponent,
      errors: [`${prefix}: refusing to lock the unexplained live bundle; lock may only advance to the proven candidate`],
    };
  }
  if (deployedPins.spa_bundle === locked.spa_bundle) {
    return {
      advance: false,
      component: currentComponent,
      errors: [`${prefix}: lock advance requires a new composition, not the historical locked baseline`],
    };
  }
  const source = sourceIdentity(deployed);
  if (!isGitShaSafe(source.git_sha) || !isSourceTreeHash(source.tree_hash)) {
    return {
      advance: false,
      component: currentComponent,
      errors: [`${prefix}: lock advance requires the deployed candidate git SHA/tree`],
    };
  }
  if (verified && verified.ok === true) {
    const after = snapshotPins(verified.after_production || verified.live_production || verified);
    if (after?.spa_bundle && after.spa_bundle !== deployedPins.spa_bundle) {
      return {
        advance: false,
        component: currentComponent,
        errors: [`${prefix}: verified production fingerprint does not match the deployed candidate; lock unchanged`],
      };
    }
    if (after?.spa_sha256 && after.spa_sha256 !== deployedPins.spa_sha256) {
      return {
        advance: false,
        component: currentComponent,
        errors: [`${prefix}: verified production fingerprint does not match the deployed candidate; lock unchanged`],
      };
    }
  } else if (verified != null && verified.ok !== true) {
    return {
      advance: false,
      component: currentComponent,
      errors: [`${prefix}: lock must not advance before successful guarded deployment verification`],
    };
  }

  const s3Version = deployed.s3_version
    || verified?.after_production?.s3_version
    || verified?.s3_version
    || null;
  const recordedAt = verified?.recorded_at || new Date().toISOString();
  const next = {
    ...currentComponent,
    source: {
      git_sha: source.git_sha,
      tree_hash: source.tree_hash,
      merged: deployed.source?.merged === true,
      merged_pr: deployed.source?.merged_pr ?? currentComponent.source?.merged_pr ?? null,
    },
    artifact: {
      ...currentComponent.artifact,
      type: 'spa',
      name: deployedPins.spa_bundle,
      hash: deployedPins.spa_sha256,
      version: s3Version,
    },
    production_validation: {
      ...currentComponent.production_validation,
      completed: true,
      environment: 'production',
      component: PRODUCTION_SPA_ID,
      git_sha: source.git_sha,
      artifact_identity: deployedPins.spa_bundle,
      recorded_at: recordedAt,
      evidence_producer: currentComponent.production_validation?.evidence_producer || 'forward-supersession-verified-deploy',
      evidence_type: 'forward supersession of orphaned live SPA',
      evidence_refs: currentComponent.production_validation?.evidence_refs || [],
    },
    deployment_fingerprint: {
      ...currentComponent.deployment_fingerprint,
      recorded: true,
      spa_bundle: deployedPins.spa_bundle,
      spa_sha256: deployedPins.spa_sha256,
      config_hash: deployedPins.index_html_sha256,
      cloudfront_deployment_fingerprint: s3Version,
      notes: `Forward-supersession lock. Previous lock ${locked.spa_bundle} is historical. Orphaned live ${livePins?.spa_bundle || 'unknown'} was the regression baseline, not lock authority.`,
    },
    rollback: {
      git_sha: currentComponent.source?.git_sha || null,
      artifact: locked.spa_bundle,
      notes: `Immediate previous locked baseline is ${locked.spa_bundle}. Do not restore it over the new composition unless a separately authorized guarded rollback names that exact artifact. Do not lock the unexplained pre-supersession live bundle.`,
    },
    missing_evidence: [],
    notes: `Authoritative production frontend baseline after verified forward supersession to ${deployedPins.spa_bundle}.`,
  };
  return { advance: verified?.ok === true, component: next, errors: [] };
}

export function applyProductionSpaLockAdvance(manifest, plan, { verified = null, failed = false } = {}) {
  if (!manifest || typeof manifest !== 'object' || !manifest.components?.[PRODUCTION_SPA_ID]) {
    return {
      advanced: false,
      manifest,
      errors: [`${PRODUCTION_SPA_ID}: lock manifest is missing production-spa`],
    };
  }
  if (failed === true || verified?.ok !== true || !plan?.advance || !plan.component) {
    return {
      advanced: false,
      manifest,
      component: manifest.components[PRODUCTION_SPA_ID],
      errors: [`${PRODUCTION_SPA_ID}: failed or unverified deployment must not advance the Release Lock`],
    };
  }
  return {
    advanced: true,
    manifest: {
      ...manifest,
      components: {
        ...manifest.components,
        [PRODUCTION_SPA_ID]: plan.component,
      },
    },
    component: plan.component,
    errors: [],
  };
}

export function acceptedBaselineCandidate({ deploy = true } = {}) {
  const pins = {
    spa_bundle: ACCEPTED_PRODUCTION_SPA.spa_bundle,
    spa_sha256: ACCEPTED_PRODUCTION_SPA.spa_sha256,
    index_html_sha256: ACCEPTED_PRODUCTION_SPA.index_html_sha256,
    s3_version: ACCEPTED_PRODUCTION_SPA.s3_version,
  };
  return {
    environment: 'production',
    approved: true,
    components: {
      [PRODUCTION_SPA_ID]: {
        deploy,
        hash: ACCEPTED_PRODUCTION_SPA.spa_sha256,
        spa_bundle: ACCEPTED_PRODUCTION_SPA.spa_bundle,
        index_html_sha256: ACCEPTED_PRODUCTION_SPA.index_html_sha256,
        s3_version: ACCEPTED_PRODUCTION_SPA.s3_version,
        based_on_baseline: { ...pins },
        preflight_production: { ...pins },
        live_production: { ...pins },
        deploy_mode: SAFE_SPA_DEPLOY_MODE,
        contains_accepted_baseline: true,
        reconciled_to_production_baseline: true,
      },
    },
  };
}
