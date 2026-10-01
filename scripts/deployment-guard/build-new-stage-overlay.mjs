#!/usr/bin/env node
/**
 * Build a Lambda overlay that adds only data.new_stage on a freshly
 * downloaded live package. Never writes AWS. Never copies main's
 * workflow.mjs over live — live delete/S3 cleanup must be preserved.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, printResult } from './lib/cli.mjs';
import { CODES, fail, ok } from './lib/errors.mjs';

export const OWNED_MEMBERS = Object.freeze(['workflow.mjs']);

const AWS = process.env.AWS_CLI || process.env.AWS || `${process.env.HOME}/.local/bin/aws`;
const REGION = process.env.AWS_REGION || 'us-east-1';

const TARGETS = Object.freeze({
  staging: 'checksops-staging-api',
  production: 'checksops-production-prep-api',
});

const TRANSITION_NEEDLE = `    return okResult({
      mapping,
      claims,
      spoof,
      data: rows[0],
      extra: {
        action,
        fromStatus: looked.check.status,`;

const TRANSITION_REPLACEMENT = `    return okResult({
      mapping,
      claims,
      spoof,
      data: { ...rows[0], new_stage: rows[0].check_stage },
      extra: {
        action,
        fromStatus: looked.check.status,`;

export function patchLiveWorkflow(source) {
  const text = String(source || '');
  const already = text.includes('new_stage: rows[0].check_stage');
  if (already) {
    return { ok: false, code: 'ALREADY_PATCHED', message: 'live workflow.mjs already has new_stage alias', count: 0, text };
  }
  const count = text.split(TRANSITION_NEEDLE).length - 1;
  if (count !== 1) {
    return {
      ok: false,
      code: 'SOURCE_RECONCILIATION_REQUIRED',
      message: 'handleCheckTransition return site is not unique on live workflow.mjs; do not overlay main source',
      count,
      text,
    };
  }
  return { ok: true, count: 1, text: text.replace(TRANSITION_NEEDLE, TRANSITION_REPLACEMENT) };
}

const sha256File = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export function hashTree(dir) {
  const members = {};
  const walk = (current, prefix = '') => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) walk(abs, rel);
      else members[rel] = sha256File(abs);
    }
  };
  walk(dir);
  return members;
}

export function applyNewStageOverlay(unpackDir) {
  const target = path.join(unpackDir, 'workflow.mjs');
  if (!fs.existsSync(target)) throw new Error('live package is missing workflow.mjs');
  const patched = patchLiveWorkflow(fs.readFileSync(target, 'utf8'));
  if (!patched.ok) {
    const error = new Error(patched.message);
    error.code = patched.code;
    error.details = { count: patched.count };
    throw error;
  }
  fs.writeFileSync(target, patched.text);
  return OWNED_MEMBERS.slice();
}

function awsJson(args) {
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return out.trim() ? JSON.parse(out) : {};
}

export function main(argv = process.argv.slice(2)) {
  const { opts } = parseArgs(argv);
  const environment = String(opts.environment || '').trim();
  const functionName = TARGETS[environment];
  if (!functionName) {
    return printResult(fail(CODES.INVALID_MANIFEST, 'environment must be staging or production', { environment }));
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `new-stage-${environment}-overlay-`));
  const zipPath = path.join(work, 'live.zip');
  const fn = awsJson(['lambda', 'get-function', '--function-name', functionName]);
  const cfg = fn.Configuration || {};
  const loc = fn.Code?.Location;
  if (!loc) {
    return printResult(fail(CODES.STALE_PACKAGE, 'live Code.Location missing', { functionName }));
  }
  execFileSync('curl', ['-fsSL', loc, '-o', zipPath]);
  const unpack = path.join(work, 'unpack');
  fs.mkdirSync(unpack);
  execFileSync('unzip', ['-q', zipPath, '-d', unpack]);
  const liveMembers = hashTree(unpack);
  applyNewStageOverlay(unpack);
  const candidateMembers = hashTree(unpack);
  const outZip = path.join(work, `checksops-${environment}-new-stage-overlay.zip`);
  execFileSync('zip', ['-qr', outZip, '.'], { cwd: unpack });
  const changed = Object.keys(liveMembers)
    .filter((key) => liveMembers[key] !== candidateMembers[key])
    .concat(Object.keys(candidateMembers).filter((key) => !liveMembers[key]))
    .sort();
  const unexpected = changed.filter((key) => !OWNED_MEMBERS.includes(key));
  if (unexpected.length) {
    return printResult(fail(CODES.DEPLOYMENT_COLLISION, 'overlay changed non-owned members', { unexpected }));
  }
  return printResult(ok({
    environment,
    function_name: functionName,
    origin: 'fresh-live-download',
    downloaded_at: new Date().toISOString(),
    zip: outZip,
    sha256: sha256File(outZip),
    owned_members: OWNED_MEMBERS.slice(),
    owned_changed: changed,
    live_members: liveMembers,
    candidate_members: candidateMembers,
    fingerprint: {
      codeSha256: cfg.CodeSha256 || null,
      revisionId: cfg.RevisionId || null,
      lastModified: cfg.LastModified || null,
      codeSize: cfg.CodeSize || null,
    },
    production: environment === 'production',
    note: 'Candidate overlays only workflow.mjs new_stage onto CURRENT live bytes. Other live members are byte-identical.',
  }));
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) process.exitCode = main();
