#!/usr/bin/env node
/**
 * Production Lambda overlay CLI.
 *
 * Default modes are local/read-only. Apply requires an explicit env flag and
 * still refuses UpdateFunctionConfiguration. This workstream never applies.
 *
 *   node scripts/production-lambda-overlay-guard.mjs --check-candidate \
 *     --live-zip /tmp/live.zip --candidate-zip /tmp/cand.zip --allowlist a.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertNoConfigurationUpdate,
  evaluateDeployGate,
  evaluateOverlayCandidate,
  evaluatePostDeploy,
} from './lib/lambda-overlay-guard.mjs';
import { IMAGE_COMPAT_ENTRY_CONTRACTS } from './lib/image-compat-freeze.mjs';

const usage = () => `production-lambda-overlay-guard
  --check-candidate --live-zip ZIP --candidate-zip ZIP --allowlist a.mjs,b.mjs
  --post-deploy --live-zip ZIP --candidate-zip ZIP --deployed-zip ZIP --allowlist ...
  --forbid-config-update
`;

export const parseAllowlist = (raw) => String(raw || '').split(',').map((s) => s.trim()).filter(Boolean);

export const main = (argv = process.argv.slice(2)) => {
  if (argv.includes('--help') || argv.length === 0) {
    console.log(usage());
    return argv.length === 0 ? 2 : 0;
  }
  if (argv.includes('--forbid-config-update') && argv.includes('--update-function-configuration')) {
    const blocked = assertNoConfigurationUpdate('UpdateFunctionConfiguration');
    console.error(blocked.errors.join('\n'));
    return 1;
  }
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const allowlist = parseAllowlist(arg('--allowlist'));
  const protectedPath = arg('--protected-hashes');
  const protectedHashes = protectedPath ? JSON.parse(fs.readFileSync(protectedPath, 'utf8')) : undefined;
  const entryContracts = argv.includes('--no-image-compat') ? undefined : IMAGE_COMPAT_ENTRY_CONTRACTS;

  if (argv.includes('--check-candidate')) {
    const result = evaluateOverlayCandidate({
      liveZip: arg('--live-zip'),
      candidateZip: arg('--candidate-zip'),
      allowlist,
      protectedHashes,
      entryContracts,
    });
    if (!result.ok) {
      console.error(result.errors.join('\n'));
      return 1;
    }
    console.log(JSON.stringify({ ok: true, changed: result.changed, candidateCodeSha256: result.candidateCodeSha256 }, null, 2));
    return 0;
  }
  if (argv.includes('--deploy-gate')) {
    const captured = JSON.parse(fs.readFileSync(arg('--captured'), 'utf8'));
    const liveNow = JSON.parse(fs.readFileSync(arg('--live-now'), 'utf8'));
    const result = evaluateDeployGate({
      captured,
      liveNow,
      liveZip: arg('--live-zip'),
      candidateZip: arg('--candidate-zip'),
      allowlist,
      protectedHashes,
      applyConfiguration: argv.includes('--update-function-configuration'),
      entryContracts,
    });
    if (!result.ok) {
      console.error(result.errors.join('\n'));
      return 1;
    }
    console.log(JSON.stringify({ ok: true, changed: result.changed }, null, 2));
    return 0;
  }
  if (argv.includes('--post-deploy')) {
    const result = evaluatePostDeploy({
      deployedZip: arg('--deployed-zip'),
      candidateZip: arg('--candidate-zip'),
      liveZipBefore: arg('--live-zip'),
      allowlist,
    });
    if (!result.ok) {
      console.error(result.errors.join('\n'));
      return 1;
    }
    console.log(JSON.stringify({ ok: true, deployedCodeSha256: result.deployedCodeSha256, changedFromLive: result.changedFromLive }, null, 2));
    return 0;
  }
  if (argv.includes('--apply')) {
    if (process.env.CHECKSOPS_PRODUCTION_OVERLAY_APPLY !== '1') {
      console.error('apply is disabled; set CHECKSOPS_PRODUCTION_OVERLAY_APPLY=1 only for an authorized code-only deploy');
      return 1;
    }
    console.error('apply path is not invoked by the freeze workstream');
    return 1;
  }
  console.error(usage());
  return 2;
};

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) process.exitCode = main();
