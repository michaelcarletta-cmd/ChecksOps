/**
 * Production Lambda overlay guard.
 *
 * Future deployments always start from the current live package. Freeze
 * manifests are invariant/provenance sources, not rollback ZIPs. Whole-Lambda
 * CodeSha256 values are TOCTOU / live-base pins for the overlay in progress,
 * not permanent rollback requirements.
 */
import { awsCodeSha256, diffZipContents, overlayZip, sha256File, zipContentHashes, zipReadFile } from './zip-package.mjs';

export const PROTECTED_FILE_LABELS = {
  'esign.mjs': 'signature-request sender contract',
  'identity-env.mjs': 'R2 identity lock',
  'tenant-admin.mjs': 'R2 invite / tenant-admin',
  'workflow.mjs': 'Delete Check / S5 workflow',
  'workflow-rpc.mjs': 'Delete Check / S5 workflow-rpc',
  'endorsement-material-invalidation.mjs': 'S2 endorsement material invalidation',
  'financial-remaining.mjs': 'S14 remaining balance',
  'financial-idempotency.mjs': 'S11 financial idempotency',
  'check-deposited.mjs': 'S14 deposited / payee lock',
  'tenant-billing-destination.mjs': 'Moov monthly billing destination',
  'tenant-billing-engine.mjs': 'Moov monthly billing engine',
  'tenant-billing-handlers.mjs': 'Moov monthly billing handlers',
  'app-services.mjs': 'Moov / Class A app services',
  'scheduled.mjs': 'Moov scheduled billing',
  'allowed-tables.json': 'write allowlist tables',
  'providers/webhook-apply.mjs': 'Moov webhook apply',
  'ocr-parse.mjs': 'R3 OCR parse',
  'ocr-descriptive-persist.mjs': 'R3 OCR persist',
  'check-ocr-provider.mjs': 'R3 OCR provider',
  'storage.mjs': 'deposit-image sign + endorsed-stem clean sibling grant',
  'storage-paths.mjs': 'endorsed-stem path helpers + checkalt protections',
};

export const fail = (errors) => ({ ok: false, errors });
export const ok = (extra = {}) => ({ ok: true, errors: [], ...extra });

export const assertAllowlistOnly = (changed, allowlist) => {
  const allowed = new Set(allowlist);
  const unexpected = changed.filter((name) => !allowed.has(name));
  return unexpected.length
    ? fail(unexpected.map((name) => `unauthorized file differs: ${name}`))
    : ok();
};

export const assertProtectedHashes = (hashes, expected) => {
  const errors = [];
  for (const [name, sha] of Object.entries(expected || {})) {
    if (!hashes[name]) errors.push(`protected file missing: ${name}`);
    else if (hashes[name] !== sha) errors.push(`protected file changed: ${name}`);
  }
  return errors.length ? fail(errors) : ok();
};

export const assertToctou = (captured, live) => {
  const errors = [];
  if (!captured?.CodeSha256 || !captured?.RevisionId) {
    return fail(['TOCTOU capture is missing CodeSha256 or RevisionId']);
  }
  if (live.CodeSha256 !== captured.CodeSha256) {
    errors.push(`TOCTOU CodeSha256 moved: captured ${captured.CodeSha256} live ${live.CodeSha256}; reconcile against the newer live package`);
  }
  if (live.RevisionId !== captured.RevisionId) {
    errors.push(`TOCTOU RevisionId moved: captured ${captured.RevisionId} live ${live.RevisionId}; do not deploy`);
  }
  return errors.length ? fail(errors) : ok();
};

export const assertLiveBase = (baseZip, livePin) => {
  const zipSha = sha256File(baseZip);
  const codeSha = awsCodeSha256(baseZip);
  if (livePin.CodeSha256 && codeSha !== livePin.CodeSha256) {
    return fail([
      `candidate was built from a stale production ZIP (zip CodeSha256 ${codeSha} vs live ${livePin.CodeSha256}); start from current live production`,
    ]);
  }
  return ok({ zipSha, codeSha });
};

export const assertNoConfigurationUpdate = (operation) => {
  if (operation === 'UpdateFunctionConfiguration') {
    return fail(['UpdateFunctionConfiguration is not authorized by the overlay guard']);
  }
  return ok();
};

export const evaluateOverlayCandidate = ({
  liveZip,
  candidateZip,
  allowlist,
  protectedHashes,
  entryContracts,
}) => {
  const errors = [];
  const diff = diffZipContents(liveZip, candidateZip);
  if (diff.onlyLeft.length || diff.onlyRight.length) {
    errors.push(`package entry set changed: onlyLive=${diff.onlyLeft.join(',')} onlyCandidate=${diff.onlyRight.join(',')}`);
  }
  errors.push(...assertAllowlistOnly(diff.changed, allowlist).errors);
  const candidateHashes = zipContentHashes(candidateZip);
  if (protectedHashes) {
    for (const [name, sha] of Object.entries(protectedHashes)) {
      if (allowlist.includes(name)) continue;
      if (candidateHashes[name] !== sha) errors.push(`protected invariant broken: ${name}`);
    }
  }
  if (entryContracts) {
    for (const [name, assertFn] of Object.entries(entryContracts)) {
      if (!(name in candidateHashes)) continue;
      const body = zipReadFile(candidateZip, name);
      const result = assertFn(body, { hash: candidateHashes[name], changed: diff.changed.includes(name) });
      if (result && result.ok === false) errors.push(...result.errors);
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    changed: diff.changed,
    candidateCodeSha256: awsCodeSha256(candidateZip),
    candidateZipSha256: sha256File(candidateZip),
  };
};

export const buildOverlayCandidate = ({ liveZip, destZip, replacements, allowlist, protectedHashes, livePin, entryContracts }) => {
  const base = assertLiveBase(liveZip, livePin || {});
  if (!base.ok) return base;
  overlayZip({ baseZip: liveZip, destZip, replacements });
  return evaluateOverlayCandidate({
    liveZip,
    candidateZip: destZip,
    allowlist,
    protectedHashes,
    entryContracts,
  });
};

export const evaluateDeployGate = ({
  captured,
  liveNow,
  liveZip,
  candidateZip,
  allowlist,
  protectedHashes,
  applyConfiguration = false,
  entryContracts,
}) => {
  const errors = [];
  errors.push(...assertToctou(captured, liveNow).errors);
  errors.push(...assertLiveBase(liveZip, liveNow).errors);
  const evaluated = evaluateOverlayCandidate({ liveZip, candidateZip, allowlist, protectedHashes, entryContracts });
  errors.push(...evaluated.errors);
  if (applyConfiguration) errors.push(...assertNoConfigurationUpdate('UpdateFunctionConfiguration').errors);
  return {
    ok: errors.length === 0,
    errors,
    changed: evaluated.changed,
    candidateCodeSha256: evaluated.candidateCodeSha256,
    candidateZipSha256: evaluated.candidateZipSha256,
  };
};

export const evaluatePostDeploy = ({ deployedZip, candidateZip, liveZipBefore, allowlist }) => {
  const vsCandidate = diffZipContents(candidateZip, deployedZip);
  const vsLive = diffZipContents(liveZipBefore, deployedZip);
  const errors = [];
  if (vsCandidate.changed.length || vsCandidate.onlyLeft.length || vsCandidate.onlyRight.length) {
    errors.push('deployed package does not equal candidate');
  }
  errors.push(...assertAllowlistOnly(vsLive.changed, allowlist).errors);
  if (awsCodeSha256(deployedZip) !== awsCodeSha256(candidateZip)) {
    errors.push('deployed CodeSha256 does not equal candidate CodeSha256');
  }
  return {
    ok: errors.length === 0,
    errors,
    deployedCodeSha256: awsCodeSha256(deployedZip),
    changedFromLive: vsLive.changed,
  };
};
