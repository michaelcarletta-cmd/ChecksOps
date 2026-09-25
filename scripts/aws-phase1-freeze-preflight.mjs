#!/usr/bin/env node
/**
 * Local Phase 1 freeze preflight. No AWS, SQL, or deploy.
 *
 *   node scripts/aws-phase1-freeze-preflight.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertCandidatePreservesPhase1 } from './lib/phase1-freeze.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = assertCandidatePreservesPhase1(ROOT);
console.log(JSON.stringify({
  ok: true,
  status: result.manifest.status,
  scenarios: result.manifest.scenariosClosed,
  safeguards: result.manifest.mandatorySafeguardSuites,
  shaPinPolicy: result.manifest.shaPinPolicy,
}, null, 2));
