#!/usr/bin/env node
/**
 * Production SPA complete-graph promotion CLI.
 *
 * Default is local/read-only verification. Promote requires an explicit env
 * flag. This workstream never republishes production.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertNoSyncDelete,
  evaluateLiveGraph,
  localManifest,
  simulatePromotion,
  walkRemoteGraph,
} from './lib/spa-promote-guard.mjs';

const usage = () => `production-spa-promote-guard
  --preflight --dist DIR
  --simulate --dist DIR [--upload-index-early]
  --forbid-sync-delete -- s3 sync --delete ...
`;

export const main = (argv = process.argv.slice(2)) => {
  if (argv.includes('--help') || argv.length === 0) {
    console.log(usage());
    return argv.length === 0 ? 2 : 0;
  }
  if (argv.includes('--forbid-sync-delete')) {
    const rest = argv.slice(argv.indexOf('--forbid-sync-delete') + 1);
    const stripped = rest[0] === '--' ? rest.slice(1) : rest;
    const result = assertNoSyncDelete(stripped);
    if (!result.ok) {
      console.error(result.errors.join('\n'));
      return 1;
    }
    console.log(JSON.stringify({ ok: true, sync_delete: false }, null, 2));
    return 0;
  }
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (argv.includes('--preflight')) {
    const result = localManifest(arg('--dist'));
    if (!result.ok) {
      console.error(result.errors.join('\n'));
      return 1;
    }
    console.log(JSON.stringify({
      ok: true,
      stats: result.stats,
      surfaces: result.surfaces,
    }, null, 2));
    return 0;
  }
  if (argv.includes('--simulate')) {
    const dist = arg('--dist');
    const candidate = localManifest(dist);
    let sequence;
    if (argv.includes('--upload-index-early')) {
      sequence = ['index.html', ...Object.keys(candidate.objects).filter((k) => k !== 'index.html')];
    }
    const result = simulatePromotion({ distDir: dist, uploadSequence: sequence, argv });
    if (!result.ok) {
      console.error(result.errors.join('\n'));
      return 1;
    }
    console.log(JSON.stringify({ ok: true, stats: result.stats, surfaces: result.surfaces }, null, 2));
    return 0;
  }
  if (argv.includes('--walk-remote')) {
    const result = evaluateLiveGraph(walkRemoteGraph({
      fetchObject: () => ({ missing: true }),
    }));
    console.error('walk-remote requires an injected fetcher; use the library');
    return result.ok ? 0 : 1;
  }
  if (argv.includes('--promote')) {
    if (process.env.CHECKSOPS_PRODUCTION_SPA_PROMOTE !== '1') {
      console.error('promote is disabled; this workstream does not republish the SPA');
      return 1;
    }
    console.error('promote path is not invoked by the freeze workstream');
    return 1;
  }
  console.error(usage());
  return 2;
};

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) process.exitCode = main();
