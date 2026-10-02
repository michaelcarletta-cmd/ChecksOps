#!/usr/bin/env node
/**
 * Forward-compose the Mortgage Ops queue chunk from the live production
 * Branding composition (index-BgOCQCWm.js + MortgageOpsQueue-BD_nUT7A.js).
 * Does not write production. Staging upload is a separate guarded step.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROD_INDEX_ASSET,
  PROD_QUEUE_ASSET,
  assertProductionIndexAuthority,
  patchProductionMortgageOpsQueue,
} from './lib/mortgage-ops-repair-overlay.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export function composeFromProduction({
  indexPath,
  queuePath,
  outDir,
} = {}) {
  const index = readFileSync(indexPath, 'utf8');
  assertProductionIndexAuthority(index, path.basename(indexPath));
  const queue = readFileSync(queuePath, 'utf8');
  const patched = patchProductionMortgageOpsQueue(queue);
  mkdirSync(outDir, { recursive: true });
  const outQueue = path.join(outDir, PROD_QUEUE_ASSET);
  writeFileSync(outQueue, patched);
  return {
    based_on_baseline: PROD_INDEX_ASSET,
    queue_asset: PROD_QUEUE_ASSET,
    out_queue: outQueue,
    removed_complete_billing: !patched.includes('bill-mortgage-handling'),
  };
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  const indexPath = process.argv[2] || path.join(ROOT, 'tests/fixtures/current-live-index-BgOCQCWm.snippet.js');
  const queuePath = process.argv[3] || path.join(ROOT, 'tests/fixtures/current-live-MortgageOpsQueue-BD_nUT7A.js');
  const outDir = process.argv[4] || path.join(ROOT, 'tmp/mortgage-ops-spa-compose');
  const result = composeFromProduction({ indexPath, queuePath, outDir });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
