#!/usr/bin/env node
/**
 * Generate a machine-readable deployment manifest. No anonymous deployment.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, printResult, readInput } from './lib/cli.mjs';
import { buildManifest, gitIdentity } from './lib/identity.mjs';
import { repoRootFrom } from './lib/paths.mjs';

export function main(argv = process.argv.slice(2), root = repoRootFrom(import.meta.url), env = process.env) {
  const { opts } = parseArgs(argv);
  const input = readInput(opts, {});
  const git = gitIdentity(root, env);
  const result = buildManifest({
    ...input,
    workstream_id: opts['workstream-id'] || input.workstream_id,
    branch: opts.branch || input.branch || git.branch,
    commit: opts.commit || input.commit || git.commit,
    operator: opts.operator || input.operator || git.operator,
    target_environment: opts.environment || input.target_environment,
    deployment_type: opts.type || input.deployment_type,
    owned_components: input.owned_components || input.owned_members,
    preflight_live_fingerprint: input.preflight_live_fingerprint || input.preflight,
    build_timestamp: opts['build-timestamp'] || input.build_timestamp || new Date().toISOString(),
    target_component: opts.component || input.target_component,
  });
  return printResult(result);
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) process.exitCode = main();
