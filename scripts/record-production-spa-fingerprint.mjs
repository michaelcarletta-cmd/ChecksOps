#!/usr/bin/env node
/**
 * Record Git commit → SPA bundle → Cognito pool/client → API target → timestamp.
 * Does not upload or deploy.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { scanProductionSpaArtifact } from './validate-production-spa-artifact.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const argValue = (name, fallback) => {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
};

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const walk = (dir, acc = []) => {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
};

export const recordProductionSpaFingerprint = ({
  distDir = 'dist',
  outPath = null,
  deployed = false,
  deployMeta = null,
} = {}) => {
  const resolved = path.isAbsolute(distDir) ? distDir : path.join(ROOT, distDir);
  const validation = scanProductionSpaArtifact(resolved);
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  const files = walk(resolved).sort();
  const assets = {};
  for (const file of files) {
    const rel = path.relative(resolved, file).replaceAll('\\', '/');
    assets[rel] = sha256(file);
  }
  const indexJs = Object.keys(assets).find((rel) => /^assets\/index-[A-Za-z0-9_-]+\.js$/.test(rel));
  const fingerprint = {
    gitCommit: git.status === 0 ? git.stdout.trim() : null,
    recordedAt: new Date().toISOString(),
    deployed,
    deployTarget: deployMeta,
    authProvider: validation.authProvider,
    cognito: {
      userPoolId: validation.userPoolId,
      clientId: validation.clientId,
    },
    apiTarget: validation.apiTarget,
    moneyCounts: validation.moneyCounts,
    spaBundle: indexJs ? path.basename(indexJs) : null,
    bundle: {
      fileCount: files.length,
      assets,
    },
    artifactValidation: {
      ok: validation.ok,
      missing: validation.missing,
      forbidden: validation.forbidden,
    },
  };
  if (outPath) {
    const dest = path.isAbsolute(outPath) ? outPath : path.join(ROOT, outPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, `${JSON.stringify(fingerprint, null, 2)}\n`);
  }
  return fingerprint;
};

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const validation = scanProductionSpaArtifact(argValue('--dir', 'dist'));
  if (!validation.ok) {
    console.error(JSON.stringify({ error: 'production_spa_artifact_rejected', ...validation }, null, 2));
    process.exit(1);
  }
  const fingerprint = recordProductionSpaFingerprint({
    distDir: argValue('--dir', 'dist'),
    outPath: argValue('--out', null),
    deployed: false,
  });
  console.log(JSON.stringify(fingerprint, null, 2));
}
