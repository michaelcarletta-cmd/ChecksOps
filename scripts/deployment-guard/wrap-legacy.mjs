#!/usr/bin/env node
/**
 * Required wrapper for inventoried NEEDS_GUARD / LEGACY/BYPASS scripts.
 * Usage:
 *   node scripts/deployment-guard/wrap-legacy.mjs --input guard.json -- node path/to/legacy.mjs
 *
 * This wrapper evaluates the guard and then execs the legacy script only if
 * the guard passed. It still does not deploy on its own. This workstream
 * never invokes the child against live AWS.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, printResult, readInput } from './lib/cli.mjs';
import { requireDeploymentGuard } from './require-guard.mjs';
import { repoRootFrom } from './lib/paths.mjs';

export function main(argv = process.argv.slice(2), root = repoRootFrom(import.meta.url), env = process.env) {
  const { opts, positional } = parseArgs(argv);
  const input = readInput(opts, {});
  try {
    const evaluation = requireDeploymentGuard(input, { root, env });
    if (env.CHECKSOPS_DEPLOYMENT_GUARD_EXEC_LEGACY === '1' && positional.length) {
      const child = spawnSync(positional[0], positional.slice(1), { cwd: root, env, stdio: 'inherit' });
      return child.status ?? 1;
    }
    return printResult({
      ok: true,
      code: null,
      message: null,
      details: {
        ...evaluation.details,
        legacy_exec_skipped: true,
        note: 'Guard passed. Legacy child is not executed unless CHECKSOPS_DEPLOYMENT_GUARD_EXEC_LEGACY=1.',
      },
      errors: [],
    });
  } catch (error) {
    return printResult({
      ok: false,
      code: error.code || 'INVALID_MANIFEST',
      message: error.message,
      details: error.details || {},
      errors: [{ code: error.code, message: error.message, details: error.details || {} }],
    });
  }
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) process.exitCode = main();
