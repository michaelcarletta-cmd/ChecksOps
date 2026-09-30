import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function repoRootFrom(metaUrl = import.meta.url) {
  let dir = path.dirname(fileURLToPath(metaUrl));
  for (let i = 0; i < 10; i += 1) {
    if (fs.existsSync(path.join(dir, 'ops/deployment-guard/protected-targets.json'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const here = path.dirname(fileURLToPath(metaUrl));
  return path.resolve(here, path.basename(here) === 'lib' ? '../../..' : '../..');
}

export const DEFAULT_PATHS = Object.freeze({
  targets: 'ops/deployment-guard/protected-targets.json',
  contracts: 'ops/deployment-guard/accepted-contracts.json',
  composition: 'ops/deployment-guard/accepted-source-composition.json',
  inventory: 'ops/deployment-guard/bypass-inventory.json',
  gaps: 'ops/deployment-guard/enforcement-gaps.json',
  readme: 'ops/deployment-guard/README.md',
});

export const LOCAL_STATE_DIR = '.deployment-guard';
export const LEASE_DIRNAME = 'leases';
export const RECEIPT_DIRNAME = 'receipts';
export const MANIFEST_DIRNAME = 'manifests';

export function localStateDir(root) {
  return path.join(root, LOCAL_STATE_DIR);
}

export function leaseDir(root) {
  return path.join(localStateDir(root), LEASE_DIRNAME);
}

export function receiptDir(root) {
  return path.join(localStateDir(root), RECEIPT_DIRNAME);
}

export function manifestDir(root) {
  return path.join(localStateDir(root), MANIFEST_DIRNAME);
}

export function leaseKey(environment, component) {
  return `${environment}::${component}`;
}

export function leaseFile(root, environment, component) {
  return path.join(leaseDir(root), `${leaseKey(environment, component).replace(/[^a-zA-Z0-9._:-]/g, '_')}.json`);
}
