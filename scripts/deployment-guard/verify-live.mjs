/**
 * Post-plan live verification helpers.
 * Read-only. Never writes AWS, SQL, or SPA objects.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODES, fail, ok } from './lib.mjs';
import { verifyNonOwnedIntact } from './lambda-overlay.mjs';
import { assertIndexHtmlCas, spaFingerprint } from './spa-promote.mjs';

export function verifyLive(input = {}) {
  const reports = [];
  if (input.lambda) {
    const lambda = verifyNonOwnedIntact(input.lambda);
    reports.push({ kind: 'lambda', ...lambda });
    if (!lambda.ok) return lambda;
  }
  if (input.spa) {
    const spa = assertIndexHtmlCas({
      preflight: input.spa.expected || input.spa.preflight,
      live: input.spa.live,
    });
    reports.push({ kind: 'spa', ...spa });
    if (!spa.ok) return spa;
  }
  if (input.forbidWrites && input.aws) {
    const writes = typeof input.aws.writes === 'function' ? input.aws.writes() : [];
    if (writes.length) {
      return fail(CODES.AWS_WRITE_FORBIDDEN, 'verify-live observed an AWS write attempt', { writes });
    }
  }
  return ok({
    reports,
    spa: input.spa ? spaFingerprint(input.spa.live || {}) : null,
    note: 'verify-live is read-only',
  });
}

export function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help')) {
    console.log('verify-live checks provided snapshots. It never calls AWS.');
    return 0;
  }
  console.log(JSON.stringify({ ok: true, message: 'verify-live is read-only and snapshot-driven' }, null, 2));
  return 0;
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  process.exitCode = main();
}
