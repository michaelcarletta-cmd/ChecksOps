#!/usr/bin/env node
/**
 * Short-lived deployment lease for a shared target/component.
 * Local repository tooling only. Does not lock AWS resources.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, printResult } from './lib/cli.mjs';
import { acquireLease, inspectLease, releaseLease } from './lib/lease.mjs';
import { gitIdentity } from './lib/identity.mjs';
import { repoRootFrom } from './lib/paths.mjs';

export function main(argv = process.argv.slice(2), root = repoRootFrom(import.meta.url), env = process.env) {
  const { positional, opts } = parseArgs(argv);
  const action = positional[0] || opts.action;
  const git = gitIdentity(root, env);
  const input = {
    workstream_id: opts['workstream-id'] || opts.workstream,
    component: opts.component,
    environment: opts.environment,
    commit: opts.commit || git.commit,
    operator: opts.operator || git.operator,
    ttl_ms: opts.ttl ? Number(opts.ttl) : undefined,
  };
  let result;
  if (action === 'acquire') result = acquireLease(root, input);
  else if (action === 'release') result = releaseLease(root, input);
  else if (action === 'status' || action === 'inspect') result = inspectLease(root, input.environment, input.component);
  else {
    result = {
      ok: false,
      code: 'INVALID_MANIFEST',
      message: 'usage: node scripts/deployment-guard/lease.mjs acquire|release|status --workstream-id ID --environment ENV --component COMP --commit SHA',
      details: {},
      errors: [],
    };
  }
  return printResult(result);
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) process.exitCode = main();
