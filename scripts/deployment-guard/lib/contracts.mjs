import fs from 'node:fs';
import path from 'node:path';
import { CODES, errorEntry, failMany, ok } from './errors.mjs';

export function loadContractRegistry(root, rel = 'ops/deployment-guard/accepted-contracts.json') {
  const abs = path.join(root, rel);
  return JSON.parse(fs.readFileSync(abs, 'utf8'));
}

export function passingContractResults(registry) {
  const out = {};
  for (const row of registry.contracts || []) {
    if (row.accepted === true && row.enabled !== false) out[row.id] = { ok: true };
  }
  return out;
}

export function relevantContracts(registry, { environment, component, deployment_type } = {}) {
  const contracts = registry.contracts || [];
  return contracts.filter((row) => {
    if (row.enabled === false) return false;
    const envs = row.environments || ['staging', 'production'];
    if (environment && !envs.includes(environment)) return false;
    const components = row.components || [];
    if (component && components.length && !components.includes(component) && !components.includes('*')) return false;
    const types = row.deployment_types || [];
    if (deployment_type && types.length && !types.includes(deployment_type) && !types.includes('*')) return false;
    return true;
  });
}

export function evaluateAcceptedContracts({
  registry,
  environment,
  component,
  deployment_type,
  results = {},
  previously_accepted = null,
}) {
  const relevant = relevantContracts(registry, { environment, component, deployment_type });
  const acceptedIds = new Set(
    (previously_accepted || relevant.filter((row) => row.accepted === true).map((row) => row.id)),
  );
  const errors = [];
  const missing = [];

  for (const id of acceptedIds) {
    const contract = (registry.contracts || []).find((row) => row.id === id);
    if (!contract || contract.enabled === false) {
      missing.push(id);
      errors.push(errorEntry(CODES.REGRESSION_DETECTED, `previously accepted contract disappeared: ${id}`, {
        contract_id: id,
      }));
      continue;
    }
    const result = results[id];
    if (result == null) {
      errors.push(errorEntry(CODES.REGRESSION_DETECTED, `accepted contract ${id} was not executed before deployment`, {
        contract_id: id,
        test: contract.test,
      }));
    } else if (result !== true && result !== 'pass' && result?.ok !== true) {
      errors.push(errorEntry(CODES.REGRESSION_DETECTED, `accepted contract ${id} failed`, {
        contract_id: id,
        result,
      }));
    }
  }

  if (errors.length) return failMany(errors, CODES.REGRESSION_DETECTED);
  return ok({
    executed: [...acceptedIds],
    relevant: relevant.map((row) => row.id),
    missing,
  });
}
