/**
 * Production SPA complete-graph promotion guard.
 *
 * Upload every referenced asset except index.html first. Switch index.html
 * only after the recursive dependency graph exists and matches. Never use
 * `s3 sync --delete`. A failed asset preflight leaves the old index live.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  graphStats,
  looksLikeHtml,
  requiredSurfaces,
  sha256Bytes,
  walkGraph,
  walkLocalDirectory,
} from './spa-dependency-graph.mjs';

export const fail = (errors) => ({ ok: false, errors });
export const ok = (extra = {}) => ({ ok: true, errors: [], ...extra });

export const assertNoSyncDelete = (argv = []) => {
  const tokens = argv.flatMap((item) => String(item).split(/\s+/));
  const hasSync = tokens.includes('sync') || tokens.some((t) => t === 's3' && tokens.includes('sync'));
  const joined = tokens.join(' ');
  if (/\bs3\s+sync\b/.test(joined) && tokens.includes('--delete')) {
    return fail(['s3 sync --delete is prohibited; it can remove accepted historical hashed assets']);
  }
  if (hasSync && tokens.includes('--delete')) {
    return fail(['s3 sync --delete is prohibited; it can remove accepted historical hashed assets']);
  }
  return ok();
};

export const localManifest = (rootDir) => {
  const graph = walkLocalDirectory(rootDir);
  const stats = graphStats(graph);
  const errors = [];
  if (stats.missing_count) errors.push(`missing referenced assets: ${stats.missing.join(', ')}`);
  if (stats.html_fallback_count) errors.push('local graph resolved HTML where JS/CSS was required');
  const surfaces = requiredSurfaces(graph.objects);
  for (const [name, row] of Object.entries(surfaces)) {
    if (!row.present) errors.push(`required surface missing from candidate: ${name}`);
  }
  return {
    ok: errors.length === 0,
    errors,
    graph,
    stats,
    surfaces,
    objects: Object.fromEntries(graph.objects.filter((row) => !row.missing).map((row) => [row.key, {
      sha256: row.sha256,
      bytes: row.bytes,
    }])),
  };
};

export const planUploadOrder = (manifest) => {
  const keys = Object.keys(manifest.objects).filter((key) => key !== 'index.html').sort();
  return { assetsFirst: keys, indexLast: 'index.html' };
};

export const assertIndexLast = (uploadSequence) => {
  const indexAt = uploadSequence.indexOf('index.html');
  if (indexAt === -1) return fail(['index.html was never scheduled']);
  const assetsAfter = uploadSequence.slice(indexAt + 1).filter((key) => key !== 'index.html');
  if (assetsAfter.length) {
    return fail([`index.html uploaded before required assets finished: ${assetsAfter.join(', ')}`]);
  }
  return ok();
};

export const assertAssetsVerifiedBeforeIndex = ({ verifiedKeys, requiredKeys, indexUploaded }) => {
  if (indexUploaded) {
    const missing = requiredKeys.filter((key) => key !== 'index.html' && !verifiedKeys.includes(key));
    if (missing.length) {
      return fail([`index.html must not switch while assets are unverified: ${missing.join(', ')}`]);
    }
  }
  return ok();
};

export const verifyRemoteObject = ({ key, bytes, contentType, expectedSha }) => {
  if (!bytes) return fail([`${key}: object missing`]);
  if (key !== 'index.html' && looksLikeHtml(bytes, contentType)) {
    return fail([`${key}: resolved to HTML fallback instead of the asset`]);
  }
  const sha = sha256Bytes(bytes);
  if (expectedSha && sha !== expectedSha) return fail([`${key}: SHA256 mismatch`]);
  return ok({ sha });
};

export const evaluateLiveGraph = (graph) => {
  const stats = graphStats(graph);
  const errors = [];
  if (stats.missing_count) errors.push(`live graph missing: ${stats.missing.join(', ')}`);
  const html = graph.objects.filter((row) => row.htmlFallback);
  if (html.length) errors.push(`live graph HTML fallback: ${html.map((row) => row.key).join(', ')}`);
  const surfaces = requiredSurfaces(graph.objects);
  for (const [name, row] of Object.entries(surfaces)) {
    if (!row.present) errors.push(`live required surface missing: ${name}`);
  }
  return { ok: errors.length === 0, errors, stats, surfaces };
};

/**
 * Dry-run / local promotion simulation. Never talks to AWS.
 * A real promote implementation must call this plan and refuse to PUT
 * index.html until every other required key is verified.
 */
export const simulatePromotion = ({
  distDir,
  liveIndexSha,
  uploadSequence,
  remote = {},
  argv = [],
}) => {
  const errors = [...assertNoSyncDelete(argv).errors];
  const candidate = localManifest(distDir);
  errors.push(...candidate.errors);
  const order = planUploadOrder(candidate);
  const sequence = uploadSequence || [...order.assetsFirst, order.indexLast];
  errors.push(...assertIndexLast(sequence).errors);

  const verified = [];
  let indexUploaded = false;
  for (const key of sequence) {
    if (key === 'index.html') {
      errors.push(...assertAssetsVerifiedBeforeIndex({
        verifiedKeys: verified,
        requiredKeys: Object.keys(candidate.objects),
        indexUploaded: true,
      }).errors);
      indexUploaded = true;
    }
    const expected = candidate.objects[key];
    if (!expected) {
      errors.push(`${key}: not in candidate graph`);
      continue;
    }
    const localBytes = fs.readFileSync(path.join(distDir, key));
    const remoteObj = remote[key];
    if (remoteObj) {
      errors.push(...verifyRemoteObject({
        key,
        bytes: remoteObj.bytes,
        contentType: remoteObj.contentType,
        expectedSha: expected.sha256,
      }).errors);
    } else if (key !== 'index.html' || indexUploaded) {
      errors.push(...verifyRemoteObject({
        key,
        bytes: localBytes,
        expectedSha: expected.sha256,
      }).errors);
    }
    if (key !== 'index.html') verified.push(key);
  }
  return {
    ok: errors.length === 0,
    errors,
    liveIndexSha,
    uploadSequence: sequence,
    stats: candidate.stats,
    surfaces: candidate.surfaces,
    objects: candidate.objects,
  };
};

export const walkRemoteGraph = ({ fetchObject, startKey = 'index.html' }) => walkGraph({
  startKey,
  readObject: fetchObject,
});
