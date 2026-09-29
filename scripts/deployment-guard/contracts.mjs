/**
 * Extensible accepted-feature contract registry.
 *
 * Do not hardcode only today's features. A previously accepted contract that
 * disappears or fails is REGRESSION_DETECTED.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODES, fail, loadGuardConfig, ok, repoRootFrom } from './lib.mjs';

export function loadContractRegistry(root = repoRootFrom(import.meta.url)) {
  return loadGuardConfig(root).contracts;
}

export function contractIds(registry) {
  return (registry.contracts || []).map((row) => row.id);
}

export function evaluateContracts({
  registry,
  results = {},
  previouslyAccepted = null,
  root = repoRootFrom(import.meta.url),
  exists = (rel) => fs.existsSync(path.join(root, rel)),
} = {}) {
  if (!registry || registry.fail_closed !== true) {
    return fail(CODES.REGRESSION_DETECTED, 'accepted contract registry is missing or not fail-closed');
  }
  const contracts = registry.contracts || [];
  const ids = new Set();
  for (const row of contracts) {
    if (!row.id || !row.title) {
      return fail(CODES.REGRESSION_DETECTED, 'contract is missing id or title');
    }
    if (ids.has(row.id)) {
      return fail(CODES.REGRESSION_DETECTED, `duplicate contract id ${row.id}`);
    }
    ids.add(row.id);
    if (row.accepted === true) {
      if (row.test && !exists(row.test)) {
        return fail(CODES.REGRESSION_DETECTED, `accepted contract ${row.id} test disappeared: ${row.test}`, {
          contract: row.id,
        });
      }
      const result = results[row.id];
      if (!result || result.pass !== true) {
        return fail(CODES.REGRESSION_DETECTED, `accepted contract failed or was not run: ${row.id}`, {
          contract: row.id,
          result: result || null,
        });
      }
    }
  }
  if (Array.isArray(previouslyAccepted)) {
    for (const id of previouslyAccepted) {
      if (!ids.has(id)) {
        return fail(CODES.REGRESSION_DETECTED, `previously accepted contract disappeared from the registry: ${id}`, {
          contract: id,
        });
      }
    }
  }
  return ok({
    ran: contracts.filter((row) => row.accepted === true).map((row) => row.id),
    skipped: contracts.filter((row) => row.accepted !== true).map((row) => row.id),
  });
}

export function passingResultsFor(registry) {
  const results = {};
  for (const row of registry.contracts || []) {
    if (row.accepted === true) results[row.id] = { pass: true, skipped: false };
  }
  return results;
}

export function main(argv = process.argv.slice(2), extras = {}) {
  const root = extras.root || repoRootFrom(import.meta.url);
  const registry = extras.registry || loadContractRegistry(root);
  const result = evaluateContracts({
    registry,
    results: extras.results || passingResultsFor(registry),
    previouslyAccepted: extras.previouslyAccepted,
    root,
  });
  const out = JSON.stringify(result, null, 2);
  if (!result.ok) {
    console.error(out);
    return 1;
  }
  if (!argv.includes('--quiet')) console.log(out);
  return 0;
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  process.exitCode = main();
}
