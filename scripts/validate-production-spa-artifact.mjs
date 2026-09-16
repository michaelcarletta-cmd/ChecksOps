#!/usr/bin/env node
/**
 * Fail-closed validation of a compiled production SPA artifact.
 * Inspects dist output, not source .env files.
 *
 * Auth/API proof (this PR): Cognito mode, production pool/client, /prep,
 * no blank-Supabase init, no staging auth/API, /freedom/login can mount.
 * Money/M75 markers are preserved so a later deploy script cannot drop them.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PRODUCTION_COGNITO_CLIENT_ID,
  PRODUCTION_COGNITO_POOL_ID,
  scanProductionSpaArtifact,
} from './lib/production-spa-auth-api-gate.mjs';

export const REQUIRED_PRODUCTION_MARKERS = Object.freeze({
  authProvider: 'cognito',
  userPoolId: PRODUCTION_COGNITO_POOL_ID,
  clientId: PRODUCTION_COGNITO_CLIENT_ID,
  apiTarget: '/prep',
});

export const FORBIDDEN_PRODUCTION_MARKERS = Object.freeze({
  stagingPoolId: 'us-east-1_vPmQ7cL1F',
  rawExecuteApi: 'kiqojucc02.execute-api',
});

export { scanProductionSpaArtifact };

const argDir = (() => {
  const idx = process.argv.indexOf('--dir');
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return 'dist';
})();

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const requireProof = process.argv.includes('--require-proof');
  const result = scanProductionSpaArtifact(argDir, {
    requireProof,
    requireMoneyUi: !process.argv.includes('--auth-only'),
  });
  if (!result.ok) {
    console.error(JSON.stringify({
      error: 'production_spa_artifact_rejected',
      ...result,
    }, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
}
