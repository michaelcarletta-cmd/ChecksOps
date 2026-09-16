#!/usr/bin/env node
/**
 * Fail-closed ChecksOps release-lock helpers.
 * Does not call AWS, apply SQL, or read secrets.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLASSIFICATIONS = Object.freeze([
  'PRODUCTION_LOCKED',
  'SOURCE_LOCKED_NOT_ACTIVE',
  'STAGING_LOCKED_NOT_PRODUCTION',
  'UNVERIFIED',
]);

export const SHA256_RE = /^[0-9a-f]{64}$/;
export const GIT_SHA_RE = /^[0-9a-f]{40}$/;

export function repoRootFrom(metaUrl = import.meta.url) {
  const here = path.dirname(fileURLToPath(metaUrl));
  // scripts/lib -> repo root; scripts -> repo root
  if (path.basename(here) === 'lib') return path.resolve(here, '..', '..');
  return path.resolve(here, '..');
}

export function sha256Buffer(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

export function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function isGitSha(value) {
  return typeof value === 'string' && GIT_SHA_RE.test(value);
}

export function isSha256(value) {
  return typeof value === 'string' && SHA256_RE.test(value);
}

function walkFiles(absDir) {
  const out = [];
  if (!fs.existsSync(absDir)) return out;
  const stack = [absDir];
  while (stack.length) {
    const current = stack.pop();
    const st = fs.statSync(current);
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(current)) {
        if (name === '.git' || name === 'node_modules') continue;
        stack.push(path.join(current, name));
      }
      continue;
    }
    if (st.isFile()) out.push(current);
  }
  return out;
}

export function expandProtectedPath(root, relPath) {
  const abs = path.join(root, relPath);
  if (!fs.existsSync(abs)) {
    return { missing: true, files: [] };
  }
  const st = fs.statSync(abs);
  if (st.isDirectory()) {
    return {
      missing: false,
      files: walkFiles(abs)
        .map((file) => path.relative(root, file).split(path.sep).join('/'))
        .sort(),
    };
  }
  return { missing: false, files: [relPath.split(path.sep).join('/')] };
}

export function expandGroupFiles(root, group) {
  const files = [];
  const missing = [];
  for (const rel of group.paths || []) {
    const expanded = expandProtectedPath(root, rel);
    if (expanded.missing) missing.push(rel);
    else files.push(...expanded.files);
  }
  return { files: [...new Set(files)].sort(), missing };
}

export function treeHashForFiles(root, files) {
  const lines = files.map((rel) => {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) {
      throw new Error(`protected file missing: ${rel}`);
    }
    return `${rel}\0${sha256File(abs)}`;
  });
  return sha256Buffer(Buffer.from(`${lines.join('\n')}\n`, 'utf8'));
}

export function computeOwnershipHashes(root, protectedPaths) {
  const groups = {};
  const errors = [];
  for (const [id, group] of Object.entries(protectedPaths.ownership_groups || {})) {
    const { files, missing } = expandGroupFiles(root, group);
    if (missing.length) {
      errors.push({ group: id, missing });
    }
    groups[id] = {
      files,
      missing,
      tree_hash: missing.length ? null : treeHashForFiles(root, files),
    };
  }
  return { groups, errors };
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function schemaTypeOk(schemaType, value) {
  const actual = typeOf(value);
  const allowed = Array.isArray(schemaType) ? schemaType : [schemaType];
  const mapped = allowed.map((item) => (item === 'integer' ? 'number' : item));
  if (schemaType === 'integer' || (Array.isArray(schemaType) && schemaType.includes('integer'))) {
    if (typeof value === 'number' && !Number.isInteger(value)) return false;
  }
  return mapped.includes(actual);
}

export function validateAgainstSchema(data, schema, pointer = '#', rootSchema = schema) {
  const errors = [];
  if (schema.const !== undefined && data !== schema.const) {
    errors.push(`${pointer}: expected const ${JSON.stringify(schema.const)}`);
    return errors;
  }
  if (schema.enum && !schema.enum.includes(data)) {
    errors.push(`${pointer}: value not in enum`);
    return errors;
  }
  if (schema.anyOf) {
    const ok = schema.anyOf.some((option) => validateAgainstSchema(data, option, pointer, rootSchema).length === 0);
    if (!ok) errors.push(`${pointer}: no anyOf branch matched`);
    return errors;
  }
  if (schema.$ref) {
    const resolved = resolveRef(rootSchema, schema.$ref);
    return validateAgainstSchema(data, resolved.schema, pointer, rootSchema);
  }
  if (schema.type && !schemaTypeOk(schemaTypeNormalized(schema.type), data)) {
    errors.push(`${pointer}: expected type ${schema.type}`);
    return errors;
  }
  if (schema.pattern && typeof data === 'string' && !new RegExp(schema.pattern).test(data)) {
    errors.push(`${pointer}: pattern mismatch`);
  }
  if (schema.minLength && typeof data === 'string' && data.length < schema.minLength) {
    errors.push(`${pointer}: shorter than minLength`);
  }
  if (schema.type === 'array' || (!schema.type && Array.isArray(data) && schema.items)) {
    if (schema.minItems && data.length < schema.minItems) {
      errors.push(`${pointer}: fewer than minItems`);
    }
    if (schema.maxItems && data.length > schema.maxItems) {
      errors.push(`${pointer}: more than maxItems`);
    }
    if (schema.items && Array.isArray(data)) {
      data.forEach((item, idx) => {
        errors.push(...validateAgainstSchema(item, schema.items, `${pointer}/${idx}`, rootSchema));
      });
    }
  }
  if (schema.type === 'object' || (schema.properties && data && typeof data === 'object' && !Array.isArray(data))) {
    if (schema.required) {
      for (const key of schema.required) {
        if (data == null || !Object.prototype.hasOwnProperty.call(data, key)) {
          errors.push(`${pointer}: missing required ${key}`);
        }
      }
    }
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const props = schema.properties || {};
      for (const [key, value] of Object.entries(data)) {
        if (props[key]) {
          errors.push(...validateAgainstSchema(value, props[key], `${pointer}/${key}`, rootSchema));
        } else if (schema.additionalProperties === false) {
          errors.push(`${pointer}: additional property ${key}`);
        } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
          errors.push(...validateAgainstSchema(value, schema.additionalProperties, `${pointer}/${key}`, rootSchema));
        }
      }
    }
  }
  return errors;
}

function schemaTypeNormalized(schemaType) {
  return schemaType;
}

function resolveRef(rootSchema, ref) {
  if (!ref.startsWith('#/')) {
    return { schema: {} };
  }
  const parts = ref.slice(2).split('/');
  let current = rootSchema;
  for (const part of parts) {
    current = current?.[part];
  }
  return { schema: current || {} };
}

export function validateSchemaDocument(data, schema) {
  return validateAgainstSchema(data, schema, '#', schema);
}

export function productionLockedEvidenceErrors(component, id) {
  const errors = [];
  const prefix = `components.${id}`;
  if (!isGitSha(component.source?.git_sha)) {
    errors.push(`${prefix}: PRODUCTION_LOCKED requires source.git_sha`);
  }
  if (!isSha256(component.source?.tree_hash)) {
    errors.push(`${prefix}: PRODUCTION_LOCKED requires source.tree_hash`);
  }
  if (component.production_active !== true) {
    errors.push(`${prefix}: PRODUCTION_LOCKED requires production_active=true`);
  }
  if (!Array.isArray(component.required_sql) || component.required_sql.length === 0) {
    errors.push(`${prefix}: PRODUCTION_LOCKED requires required_sql with applied production hashes`);
  } else {
    for (const row of component.required_sql) {
      if (row.applied !== true) {
        errors.push(`${prefix}: PRODUCTION_LOCKED SQL not applied: ${row.path}`);
      }
      if (row.applied_environment !== 'production') {
        errors.push(`${prefix}: PRODUCTION_LOCKED SQL must be applied in production: ${row.path}`);
      }
      if (!isSha256(row.applied_sha256) || row.applied_sha256 !== row.source_sha256) {
        errors.push(`${prefix}: PRODUCTION_LOCKED SQL hash mismatch or missing applied_sha256: ${row.path}`);
      }
    }
  }
  if (!isSha256(component.artifact?.hash)) {
    errors.push(`${prefix}: PRODUCTION_LOCKED requires artifact.hash`);
  }
  if (component.production_validation?.completed !== true) {
    errors.push(`${prefix}: PRODUCTION_LOCKED requires production_validation.completed`);
  }
  if (!component.deployment_fingerprint || component.deployment_fingerprint.recorded !== true) {
    errors.push(`${prefix}: PRODUCTION_LOCKED requires recorded deployment_fingerprint`);
  }
  if (!isGitSha(component.rollback?.git_sha) || !component.rollback?.artifact) {
    errors.push(`${prefix}: PRODUCTION_LOCKED requires rollback.git_sha and rollback.artifact`);
  }
  if (Array.isArray(component.missing_evidence) && component.missing_evidence.length > 0) {
    errors.push(`${prefix}: PRODUCTION_LOCKED cannot retain missing_evidence`);
  }
  return errors;
}

export function classificationErrors(component, id) {
  const errors = [];
  const prefix = `components.${id}`;
  if (!CLASSIFICATIONS.includes(component.classification)) {
    errors.push(`${prefix}: unknown classification`);
    return errors;
  }
  if (component.classification === 'PRODUCTION_LOCKED') {
    errors.push(...productionLockedEvidenceErrors(component, id));
  }
  if (component.classification !== 'PRODUCTION_LOCKED' && component.production_active === true) {
    errors.push(`${prefix}: production_active=true is forbidden unless PRODUCTION_LOCKED`);
  }
  if (component.classification === 'SOURCE_LOCKED_NOT_ACTIVE') {
    if (!isGitSha(component.source?.git_sha) || !isSha256(component.source?.tree_hash)) {
      errors.push(`${prefix}: SOURCE_LOCKED_NOT_ACTIVE requires pinned source git_sha and tree_hash`);
    }
    for (const row of component.required_sql || []) {
      if (row.applied_environment === 'production' || row.applied === true) {
        errors.push(`${prefix}: SOURCE_LOCKED_NOT_ACTIVE cannot claim production-applied SQL (${row.path})`);
      }
    }
  }
  if (component.classification === 'STAGING_LOCKED_NOT_PRODUCTION') {
    if (component.production_active === true) {
      errors.push(`${prefix}: STAGING_LOCKED_NOT_PRODUCTION cannot be production_active`);
    }
    const stagingProof = (component.required_sql || []).some((row) => row.applied_environment === 'staging')
      || (component.production_validation?.evidence_refs || []).some((ref) => /staging/i.test(ref));
    if (!stagingProof) {
      errors.push(`${prefix}: STAGING_LOCKED_NOT_PRODUCTION requires staging SQL or staging evidence_refs`);
    }
    for (const row of component.required_sql || []) {
      if (row.applied_environment === 'production') {
        errors.push(`${prefix}: staging-only component claims production SQL apply (${row.path})`);
      }
    }
  }
  if (component.classification === 'UNVERIFIED') {
    if (!Array.isArray(component.missing_evidence) || component.missing_evidence.length === 0) {
      errors.push(`${prefix}: UNVERIFIED requires missing_evidence`);
    }
    if (component.production_validation?.completed === true) {
      errors.push(`${prefix}: UNVERIFIED cannot claim production_validation.completed`);
    }
  }
  return errors;
}

export function sqlHashErrors(root, component, id) {
  const errors = [];
  for (const row of component.required_sql || []) {
    const abs = path.join(root, row.path);
    if (!fs.existsSync(abs)) {
      errors.push(`components.${id}: required SQL missing: ${row.path}`);
      continue;
    }
    const digest = sha256File(abs);
    if (row.source_sha256 !== digest) {
      errors.push(`components.${id}: SQL source hash changed for ${row.path} (recorded ${row.source_sha256}, actual ${digest})`);
    }
  }
  return errors;
}

export function treeHashErrors(hashes, component, id) {
  const errors = [];
  const group = hashes.groups[component.ownership_group];
  if (!group) {
    errors.push(`components.${id}: ownership_group ${component.ownership_group} missing from protected-paths`);
    return errors;
  }
  if (group.missing.length) {
    errors.push(`components.${id}: protected paths missing: ${group.missing.join(', ')}`);
  }
  if (group.tree_hash && component.source?.tree_hash !== group.tree_hash) {
    errors.push(
      `components.${id}: protected source tree changed without an explicit manifest source.tree_hash update (recorded ${component.source?.tree_hash}, actual ${group.tree_hash})`,
    );
  }
  return errors;
}

export function ledgerErrors(root, ledger, hashesByPath) {
  const errors = [];
  if (ledger.fail_closed !== true) {
    errors.push('applied-migrations.ledger.json: fail_closed must be true');
  }
  if (ledger.append_only !== true) {
    errors.push('applied-migrations.ledger.json: append_only must be true');
  }
  const seen = new Set();
  for (const entry of ledger.entries || []) {
    const key = `${entry.path}@${entry.source_sha256}`;
    if (seen.has(key) && entry.mutation === 'rewrite') {
      errors.push(`ledger: rewrite of ${entry.path} is forbidden`);
    }
    seen.add(key);
    if (entry.mutation && entry.mutation !== 'append') {
      errors.push(`ledger: non-append mutation for ${entry.path}`);
    }
    const abs = path.join(root, entry.path);
    if (!fs.existsSync(abs)) {
      errors.push(`ledger: SQL file missing ${entry.path}`);
      continue;
    }
    const digest = hashesByPath.get(entry.path) || sha256File(abs);
    if (entry.source_sha256 !== digest) {
      errors.push(`ledger: source hash changed after recording ${entry.path}`);
    }
    if (entry.applied === true && !isSha256(entry.applied_sha256)) {
      errors.push(`ledger: applied=true without applied_sha256 for ${entry.path}`);
    }
    if (entry.applied_environment === 'production' && entry.applied !== true) {
      errors.push(`ledger: production environment recorded without applied=true for ${entry.path}`);
    }
  }
  return errors;
}

export function componentIdErrors(manifest, protectedPaths) {
  const errors = [];
  const groups = new Set(Object.keys(protectedPaths.ownership_groups || {}));
  const ids = Object.keys(manifest.components || {});
  for (const id of ids) {
    const component = manifest.components[id];
    if (component.id !== id) {
      errors.push(`components.${id}: id field must equal object key`);
    }
    if (component.ownership_group !== id) {
      errors.push(`components.${id}: ownership_group must equal component id`);
    }
    if (!groups.has(component.ownership_group)) {
      errors.push(`components.${id}: unknown ownership_group`);
    }
  }
  for (const group of groups) {
    if (!manifest.components[group]) {
      errors.push(`protected ownership group ${group} has no manifest component`);
    }
  }
  return errors;
}

export function validateReleaseLocks({
  root,
  manifest,
  schema,
  protectedPaths,
  ledger,
}) {
  const errors = [];
  if (manifest.fail_closed !== true) {
    errors.push('manifest.fail_closed must be true');
  }
  errors.push(...validateSchemaDocument(manifest, schema));
  errors.push(...componentIdErrors(manifest, protectedPaths));
  const hashes = computeOwnershipHashes(root, protectedPaths);
  for (const err of hashes.errors) {
    errors.push(`protected-paths ${err.group}: missing ${err.missing.join(', ')}`);
  }
  for (const [id, component] of Object.entries(manifest.components || {})) {
    errors.push(...classificationErrors(component, id));
    errors.push(...sqlHashErrors(root, component, id));
    errors.push(...treeHashErrors(hashes, component, id));
  }
  const pathHashes = new Map();
  errors.push(...ledgerErrors(root, ledger, pathHashes));
  return { errors, hashes };
}

export function matchProtectedPath(relPath, protectedPaths) {
  const matches = [];
  const normalized = relPath.split(path.sep).join('/');
  for (const [groupId, group] of Object.entries(protectedPaths.ownership_groups || {})) {
    for (const prefix of group.paths || []) {
      const dir = prefix.endsWith('/') ? prefix : null;
      if (dir && (normalized === prefix.slice(0, -1) || normalized.startsWith(dir))) {
        matches.push({ groupId, prefix });
      } else if (!dir && normalized === prefix) {
        matches.push({ groupId, prefix });
      }
    }
  }
  return matches;
}

export const DEFAULT_PATHS = {
  schema: 'ops/release-locks/schema/locked-components.schema.json',
  manifest: 'ops/release-locks/locked-components.json',
  protectedPaths: 'ops/release-locks/protected-paths.json',
  ledger: 'ops/release-locks/applied-migrations.ledger.json',
  overlapAllowlist: 'ops/release-locks/overlap-allowlist.json',
  evidence: 'ops/release-locks/evidence-matrix.json',
};
