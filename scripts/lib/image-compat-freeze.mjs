/**
 * Accepted existing-back-image compatibility contract.
 *
 * Future overlays may change one of these files only when the active
 * workstream explicitly requires it, and must start from the current frozen
 * version — never an older pre-compat copy.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const IMAGE_COMPAT_SOURCE_PINS = {
  'src/lib/checkImageInvariants.ts': '41a42c8df6f61b52b2683a300310c3f0498531ee991c5492347e216dc418d802',
  'src/pages/CheckCommandCenter.tsx': '32436906507f3e8f183a0f393dd43ea66bd7eeb4dd2fca33087e737a6b7984d4',
  'aws/functions/api/storage.mjs': 'b6923ff66786f5604bda229c21e9309a3d7e49ba0ee2edaf07106690228eed56',
  'aws/functions/api/storage-paths.mjs': '278329e5230b2ddd6675e4cad9839d2193da8655ca4676573702dca3f90e9d09',
};

export const IMAGE_COMPAT_LIVE_LAMBDA_PINS = {
  'storage.mjs': 'b6923ff66786f5604bda229c21e9309a3d7e49ba0ee2edaf07106690228eed56',
  'storage-paths.mjs': '278329e5230b2ddd6675e4cad9839d2193da8655ca4676573702dca3f90e9d09',
};

export const PRE_COMPAT_PROVENANCE_HASHES = {
  'storage.mjs': 'c3ddf79b01118d2e972adbc42fda8b472c3f87474436f03af56e053aa49285d3',
  'storage-paths.mjs': '74638148e16d47c34e5ec2af6aa3e4adf8aef3d4aeb934141980cae5d1e22fb4',
  'src/lib/checkImageInvariants.ts': '32b6ea2abb96a2484153f72d3c4eb075f25098e16c0efc226b314bdd489a8b45',
  'src/pages/CheckCommandCenter.tsx': '589d8cebc0c6b45491e89fd3161cb553f0f433bfe83de09e0a7e9a2e6ae92b2f',
};

export const IMAGE_COMPAT_MARKERS = {
  'storage.mjs': [
    'CLEAN_STEM_POINTER_LOOKUP_SQL',
    'authorizeCleanStemSibling',
    'authorizeSignedObject',
    'endorsedGeneratedStem',
    'isNarrowCleanStemPath',
    'isExactCleanStemOfGeneratedPointer',
  ],
  'storage-paths.mjs': [
    'endorsedGeneratedStem',
    'isNarrowCleanStemPath',
    'isExactCleanStemOfGeneratedPointer',
    'isGeneratedBackArtifactPath',
    'ENDORSED_FILENAME_RE',
    'checkalt',
    'endorsed_deposit_',
  ],
  'src/lib/checkImageInvariants.ts': [
    'isRecognizedEndorsedGeneratedPath',
    'endorsedGeneratedStem',
    'collectEndorsedCleanStemCandidates',
    'isExactCleanStemOfGeneratedPointer',
    'isGeneratedBackArtifactPath',
    'probeCleanStemPaths',
    'canTryStemProbe',
    'endorsed_stem',
    'checkalt',
    'endorsed_deposit_',
  ],
  'src/pages/CheckCommandCenter.tsx': [
    'resolveCleanBackOriginalPath',
    'probeCleanStemPaths',
    'createSignedUrl',
    'assertCleanBackOriginalPath',
    'linkedClaim.claim_number',
    'Not linked',
  ],
};

const fail = (errors) => ({ ok: false, errors });
const ok = (extra = {}) => ({ ok: true, errors: [], ...extra });

export const sha256Bytes = (buf) => createHash('sha256').update(buf).digest('hex');

export const assertMarkers = (source, markers, label) => {
  const text = String(source || '');
  const missing = (markers || []).filter((marker) => !text.includes(marker));
  return missing.length
    ? fail(missing.map((marker) => `${label} missing image-compat marker: ${marker}`))
    : ok();
};

export const assertNotPreCompatHash = (hash, knownOld, label) => {
  if (hash && knownOld && hash === knownOld) {
    return fail([`${label} is the pre-compat hash ${hash}; start from the frozen accepted version`]);
  }
  return ok();
};

export const assertImageCompatStorage = (source, extra = {}) => {
  const errors = [];
  errors.push(...assertMarkers(source, IMAGE_COMPAT_MARKERS['storage.mjs'], 'storage.mjs').errors);
  errors.push(...assertNotPreCompatHash(extra.hash, PRE_COMPAT_PROVENANCE_HASHES['storage.mjs'], 'storage.mjs').errors);
  if (String(source).includes('CLEAN_STEM_POINTER_LOOKUP_SQL') === false) {
    errors.push('storage.mjs lost CLEAN_STEM_POINTER_LOOKUP_SQL');
  }
  return errors.length ? fail(errors) : ok();
};

export const assertImageCompatStoragePaths = (source, extra = {}) => {
  const errors = [];
  errors.push(...assertMarkers(source, IMAGE_COMPAT_MARKERS['storage-paths.mjs'], 'storage-paths.mjs').errors);
  errors.push(...assertNotPreCompatHash(
    extra.hash,
    PRE_COMPAT_PROVENANCE_HASHES['storage-paths.mjs'],
    'storage-paths.mjs',
  ).errors);
  return errors.length ? fail(errors) : ok();
};

export const assertImageCompatInvariants = (source, extra = {}) => {
  const errors = [];
  errors.push(...assertMarkers(source, IMAGE_COMPAT_MARKERS['src/lib/checkImageInvariants.ts'], 'checkImageInvariants.ts').errors);
  errors.push(...assertNotPreCompatHash(
    extra.hash,
    PRE_COMPAT_PROVENANCE_HASHES['src/lib/checkImageInvariants.ts'],
    'checkImageInvariants.ts',
  ).errors);
  return errors.length ? fail(errors) : ok();
};

export const assertImageCompatClaimCheck = (source, extra = {}) => {
  const errors = [];
  errors.push(...assertMarkers(source, IMAGE_COMPAT_MARKERS['src/pages/CheckCommandCenter.tsx'], 'CheckCommandCenter.tsx').errors);
  errors.push(...assertNotPreCompatHash(
    extra.hash,
    PRE_COMPAT_PROVENANCE_HASHES['src/pages/CheckCommandCenter.tsx'],
    'CheckCommandCenter.tsx',
  ).errors);
  return errors.length ? fail(errors) : ok();
};

export const IMAGE_COMPAT_ENTRY_CONTRACTS = {
  'storage.mjs': assertImageCompatStorage,
  'storage-paths.mjs': assertImageCompatStoragePaths,
};

export const assertImageCompatSourcePins = (root) => {
  const errors = [];
  for (const [rel, expected] of Object.entries(IMAGE_COMPAT_SOURCE_PINS)) {
    const filePath = path.join(root, rel);
    if (!fs.existsSync(filePath)) {
      errors.push(`accepted image file missing: ${rel}`);
      continue;
    }
    const body = fs.readFileSync(filePath);
    const hash = sha256Bytes(body);
    if (hash !== expected) errors.push(`${rel} hash ${hash} != frozen ${expected}`);
    if (rel.endsWith('storage.mjs')) errors.push(...assertImageCompatStorage(body.toString('utf8'), { hash }).errors);
    if (rel.endsWith('storage-paths.mjs')) errors.push(...assertImageCompatStoragePaths(body.toString('utf8'), { hash }).errors);
    if (rel.endsWith('checkImageInvariants.ts')) errors.push(...assertImageCompatInvariants(body.toString('utf8'), { hash }).errors);
    if (rel.endsWith('CheckCommandCenter.tsx')) errors.push(...assertImageCompatClaimCheck(body.toString('utf8'), { hash }).errors);
  }
  return errors.length ? fail(errors) : ok();
};

export const assertImageCompatLambdaPins = (hashes) => {
  const errors = [];
  for (const [name, expected] of Object.entries(IMAGE_COMPAT_LIVE_LAMBDA_PINS)) {
    if (!hashes?.[name]) errors.push(`live package missing ${name}`);
    else if (hashes[name] !== expected) errors.push(`${name} live hash ${hashes[name]} != frozen ${expected}`);
    else if (hashes[name] === PRE_COMPAT_PROVENANCE_HASHES[name]) {
      errors.push(`${name} silently rolled back to pre-compat`);
    }
  }
  return errors.length ? fail(errors) : ok();
};

export const repoRootFrom = (metaUrl) => path.join(path.dirname(fileURLToPath(metaUrl)), '../..');
