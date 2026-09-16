#!/usr/bin/env node
/**
 * Fail-closed ChecksOps release-lock helpers.
 * Does not call AWS, apply SQL, or read secrets.
 *
 * Repository validation protects the release process. It cannot independently
 * prove live AWS truth. Hashing a changed validator with that same validator is
 * not independent security; branch protection and required base-owned checks
 * must be enforced in GitHub.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

export const CLASSIFICATIONS = Object.freeze([
  'PRODUCTION_LOCKED',
  'SOURCE_LOCKED_NOT_ACTIVE',
  'STAGING_LOCKED_NOT_PRODUCTION',
  'UNVERIFIED',
]);

export const SHA256_RE = /^[0-9a-f]{64}$/;
export const GIT_SHA_RE = /^[0-9a-f]{40}$/;
export const UNAPPLIED_SOURCE_RE = /NOT_APPLIED|DO NOT APPLY|DO_NOT_APPLY|\bNOT APPLY\b|\bUNAPPLIED\b/i;
export const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export const CONTROL_PLANE_FILES = Object.freeze([
  '.github/CODEOWNERS',
  '.github/workflows/release-locks.yml',
  'scripts/lib/release-locks.mjs',
  'scripts/validate-release-locks.mjs',
  'scripts/check-pr-path-overlap.mjs',
  'scripts/production-deploy-guard.mjs',
]);

export const CONTROL_PLANE_PREFIXES = Object.freeze([
  'ops/release-locks/',
]);

export const REQUIRED_WORKFLOW_INVOCATIONS = Object.freeze([
  'scripts/validate-release-locks.mjs',
  'scripts/check-pr-path-overlap.mjs',
  'scripts/production-deploy-guard.mjs',
  'ops/release-locks/tests/',
]);

export const DEFAULT_PATHS = {
  schema: 'ops/release-locks/schema/locked-components.schema.json',
  ledgerSchema: 'ops/release-locks/schema/applied-migrations.schema.json',
  allowlistSchema: 'ops/release-locks/schema/overlap-allowlist.schema.json',
  evidenceSchema: 'ops/release-locks/schema/evidence-matrix.schema.json',
  protectedPathsSchema: 'ops/release-locks/schema/protected-paths.schema.json',
  manifest: 'ops/release-locks/locked-components.json',
  protectedPaths: 'ops/release-locks/protected-paths.json',
  ledger: 'ops/release-locks/applied-migrations.ledger.json',
  overlapAllowlist: 'ops/release-locks/overlap-allowlist.json',
  evidence: 'ops/release-locks/evidence-matrix.json',
  workflow: '.github/workflows/release-locks.yml',
};

export function repoRootFrom(metaUrl = import.meta.url) {
  const here = path.dirname(fileURLToPath(metaUrl));
  if (path.basename(here) === 'lib') return path.resolve(here, '..', '..');
  return path.resolve(here, '..');
}

export function sha256Buffer(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

export function isGitSha(value) {
  return typeof value === 'string' && GIT_SHA_RE.test(value);
}

export function isSha256(value) {
  return typeof value === 'string' && SHA256_RE.test(value);
}

export function isControlPlanePath(relPath) {
  const normalized = relPath.split(path.sep).join('/');
  if (CONTROL_PLANE_FILES.includes(normalized)) return true;
  return CONTROL_PLANE_PREFIXES.some((prefix) => (
    normalized === prefix.slice(0, -1) || normalized.startsWith(prefix)
  ));
}

export function findDuplicateJsonKeys(text, source = 'json') {
  const errors = [];
  let i = 0;
  function skipWs() {
    while (i < text.length && /[ \t\r\n]/.test(text[i])) i += 1;
  }
  function parseString() {
    if (text[i] !== '"') throw new Error(`${source}: expected string at ${i}`);
    i += 1;
    let out = '';
    while (i < text.length) {
      const ch = text[i];
      if (ch === '"') {
        i += 1;
        return out;
      }
      if (ch === '\\') {
        out += text[i] + (text[i + 1] || '');
        i += 2;
        continue;
      }
      out += ch;
      i += 1;
    }
    throw new Error(`${source}: unterminated string`);
  }
  function parseObject(pointer) {
    i += 1;
    const seen = new Set();
    skipWs();
    if (text[i] === '}') {
      i += 1;
      return;
    }
    while (i < text.length) {
      skipWs();
      const key = parseString();
      if (seen.has(key)) errors.push(`${source}${pointer}: duplicate key ${key}`);
      seen.add(key);
      skipWs();
      if (text[i] !== ':') throw new Error(`${source}${pointer}: expected colon after ${key}`);
      i += 1;
      parseValue(`${pointer}/${key}`);
      skipWs();
      if (text[i] === ',') {
        i += 1;
        continue;
      }
      if (text[i] === '}') {
        i += 1;
        return;
      }
      throw new Error(`${source}${pointer}: expected comma or end of object`);
    }
  }
  function parseArray(pointer) {
    i += 1;
    let idx = 0;
    skipWs();
    if (text[i] === ']') {
      i += 1;
      return;
    }
    while (i < text.length) {
      parseValue(`${pointer}/${idx}`);
      idx += 1;
      skipWs();
      if (text[i] === ',') {
        i += 1;
        continue;
      }
      if (text[i] === ']') {
        i += 1;
        return;
      }
      throw new Error(`${source}${pointer}: expected comma or end of array`);
    }
  }
  function parseValue(pointer) {
    skipWs();
    const ch = text[i];
    if (ch === '{') return parseObject(pointer);
    if (ch === '[') return parseArray(pointer);
    if (ch === '"') {
      parseString();
      return;
    }
    if (text.startsWith('true', i)) {
      i += 4;
      return;
    }
    if (text.startsWith('false', i)) {
      i += 5;
      return;
    }
    if (text.startsWith('null', i)) {
      i += 4;
      return;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      while (i < text.length && /[0-9eE+\-.]/.test(text[i])) i += 1;
      return;
    }
    throw new Error(`${source}${pointer}: unexpected token at ${i}`);
  }
  parseValue('#');
  skipWs();
  if (i !== text.length) errors.push(`${source}: trailing content after JSON value`);
  return errors;
}

export function parseJsonStrict(text, source = 'json') {
  const dupes = findDuplicateJsonKeys(text, source);
  if (dupes.length) {
    throw new Error(dupes.join('\n'));
  }
  return JSON.parse(text);
}

export function loadJson(filePath) {
  return parseJsonStrict(fs.readFileSync(filePath, 'utf8'), filePath);
}

export function gitShow(root, ref, relPath) {
  try {
    return execFileSync('git', ['show', `${ref}:${relPath}`], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
}

export function resolveTrustedBaseSha(root, env = process.env) {
  for (const key of ['RELEASE_LOCK_BASE_SHA', 'GITHUB_BASE_SHA']) {
    const value = env[key];
    if (typeof value === 'string' && GIT_SHA_RE.test(value.trim())) return value.trim();
  }
  try {
    const sha = execFileSync('git', ['merge-base', 'HEAD', 'origin/main'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
    if (GIT_SHA_RE.test(sha)) return sha;
  } catch {
    // fall through
  }
  return null;
}

export function loadJsonAtRef(root, ref, relPath) {
  const text = gitShow(root, ref, relPath);
  if (text == null) return { exists: false, data: null };
  return { exists: true, data: parseJsonStrict(text, `${ref}:${relPath}`) };
}

export function isGitTracked(root, relPath) {
  try {
    execFileSync('git', ['-C', root, 'ls-files', '--error-unmatch', '--', relPath], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

export function gitTrackedFileErrors(root, relPath, label) {
  if (typeof relPath !== 'string' || !relPath.trim()) {
    return [`${label}: proof/evidence path is empty`];
  }
  const normalized = relPath.split(path.sep).join('/');
  if (
    normalized === '.'
    || normalized === '/'
    || normalized === '*'
    || normalized.includes('..')
    || path.isAbsolute(relPath)
  ) {
    return [`${label}: ${relPath} is not a concrete repository path`];
  }
  const abs = path.join(root, normalized);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    return [`${label}: ${normalized} is not an existing file`];
  }
  if (!isGitTracked(root, normalized)) {
    return [`${label}: ${normalized} is not tracked by git`];
  }
  return [];
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
  const unique = [...new Set(files)].sort();
  const exclude = new Set(group.tree_hash_exclude || []);
  return {
    files: unique,
    missing,
    hashFiles: unique.filter((rel) => !exclude.has(rel)),
  };
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
    const { files, missing, hashFiles } = expandGroupFiles(root, group);
    if (missing.length) {
      errors.push({ group: id, missing });
    }
    groups[id] = {
      files,
      missing,
      tree_hash: missing.length ? null : treeHashForFiles(root, hashFiles),
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
    if (!schema.properties && !schema.type && !schema.$ref) return errors;
  }
  if (schema.$ref) {
    const resolved = resolveRef(rootSchema, schema.$ref);
    return validateAgainstSchema(data, resolved.schema, pointer, rootSchema);
  }
  if (schema.type && !schemaTypeOk(schema.type, data)) {
    errors.push(`${pointer}: expected type ${schema.type}`);
    return errors;
  }
  if (schema.pattern && typeof data === 'string' && !new RegExp(schema.pattern).test(data)) {
    errors.push(`${pointer}: pattern mismatch`);
  }
  if (schema.minLength && typeof data === 'string' && data.length < schema.minLength) {
    errors.push(`${pointer}: shorter than minLength`);
  }
  if (schema.minimum != null && typeof data === 'number' && data < schema.minimum) {
    errors.push(`${pointer}: below minimum`);
  }
  if (schema.type === 'array' || (!schema.type && Array.isArray(data) && schema.items)) {
    if (schema.minItems && data.length < schema.minItems) {
      errors.push(`${pointer}: fewer than minItems`);
    }
    if (schema.maxItems && data.length > schema.maxItems) {
      errors.push(`${pointer}: more than maxItems`);
    }
    if (schema.uniqueItems && Array.isArray(data)) {
      const seen = new Set(data.map((item) => JSON.stringify(item)));
      if (seen.size !== data.length) errors.push(`${pointer}: duplicate items`);
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

export function classificationSetErrors(manifest) {
  const errors = [];
  const list = manifest.classifications || [];
  if (list.length !== CLASSIFICATIONS.length || new Set(list).size !== CLASSIFICATIONS.length) {
    errors.push('classifications must be unique and complete (exactly the four required names)');
  }
  const missing = CLASSIFICATIONS.filter((name) => !list.includes(name));
  if (missing.length) {
    errors.push(`classifications missing ${missing.join(', ')}`);
  }
  return errors;
}

export function hasImmutableProductionIdentifier(fingerprint) {
  if (!fingerprint || typeof fingerprint !== 'object') return false;
  const lambda = Boolean(fingerprint.lambda_version) && isSha256(fingerprint.lambda_code_hash);
  const spa = Boolean(fingerprint.spa_bundle) && isSha256(fingerprint.spa_sha256);
  const cloudfront = Boolean(fingerprint.cloudfront_distribution || fingerprint.cloudfront_id)
    && Boolean(fingerprint.cloudfront_deployment_fingerprint);
  const sql = isSha256(fingerprint.applied_sql_hash) && Boolean(fingerprint.database_evidence_record);
  return lambda || spa || cloudfront || sql;
}

export function productionLockedEvidenceErrors(component, id, root = null) {
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
      if (root && row.path) {
        const abs = path.join(root, row.path);
        if (fs.existsSync(abs)) {
          const body = fs.readFileSync(abs, 'utf8');
          if (UNAPPLIED_SOURCE_RE.test(body) || UNAPPLIED_SOURCE_RE.test(row.path)) {
            errors.push(`${prefix}: SQL source is marked unapplied (${row.path}); cannot classify as applied`);
          }
        }
      } else if (row.path && UNAPPLIED_SOURCE_RE.test(row.path)) {
        errors.push(`${prefix}: SQL source is marked unapplied (${row.path}); cannot classify as applied`);
      }
    }
  }
  if (!isSha256(component.artifact?.hash)) {
    errors.push(`${prefix}: PRODUCTION_LOCKED requires artifact.hash`);
  }
  const validation = component.production_validation || {};
  if (validation.completed !== true) {
    errors.push(`${prefix}: PRODUCTION_LOCKED requires production_validation.completed`);
  }
  if (validation.environment !== 'production') {
    errors.push(`${prefix}: PRODUCTION_LOCKED validation must identify environment=production`);
  }
  if (validation.component !== id) {
    errors.push(`${prefix}: PRODUCTION_LOCKED validation must identify component`);
  }
  if (!isGitSha(validation.git_sha)) {
    errors.push(`${prefix}: PRODUCTION_LOCKED validation must identify git SHA`);
  }
  if (!validation.artifact_identity || typeof validation.artifact_identity !== 'string') {
    errors.push(`${prefix}: PRODUCTION_LOCKED validation must identify artifact identity`);
  }
  if (!ISO_TIMESTAMP_RE.test(String(validation.recorded_at || ''))) {
    errors.push(`${prefix}: PRODUCTION_LOCKED validation must include a validation timestamp`);
  }
  if (!validation.evidence_producer || !validation.evidence_type) {
    errors.push(`${prefix}: PRODUCTION_LOCKED validation must identify evidence producer/type`);
  }
  if (!Array.isArray(validation.evidence_refs) || validation.evidence_refs.length === 0) {
    errors.push(`${prefix}: PRODUCTION_LOCKED requires evidence_refs`);
  } else if (root) {
    for (const ref of validation.evidence_refs) {
      errors.push(...gitTrackedFileErrors(root, ref, `${prefix} evidence_ref`));
    }
  }
  const fingerprint = component.deployment_fingerprint;
  if (!fingerprint || fingerprint.recorded !== true) {
    errors.push(`${prefix}: PRODUCTION_LOCKED requires recorded deployment_fingerprint`);
  }
  if (fingerprint && fingerprint.recorded === true && !hasImmutableProductionIdentifier(fingerprint)) {
    errors.push(`${prefix}: recorded=true or an arbitrary hash is not sufficient production evidence`);
  }
  if (root && fingerprint?.database_evidence_record) {
    errors.push(...gitTrackedFileErrors(root, fingerprint.database_evidence_record, `${prefix} database_evidence_record`));
  }
  if (!isGitSha(component.rollback?.git_sha) || !component.rollback?.artifact) {
    errors.push(`${prefix}: PRODUCTION_LOCKED requires rollback.git_sha and rollback.artifact`);
  }
  if (Array.isArray(component.missing_evidence) && component.missing_evidence.length > 0) {
    errors.push(`${prefix}: PRODUCTION_LOCKED cannot retain missing_evidence`);
  }
  return errors;
}

export function classificationErrors(component, id, root = null) {
  const errors = [];
  const prefix = `components.${id}`;
  if (!CLASSIFICATIONS.includes(component.classification)) {
    errors.push(`${prefix}: unknown classification`);
    return errors;
  }
  if (component.classification === 'PRODUCTION_LOCKED') {
    errors.push(...productionLockedEvidenceErrors(component, id, root));
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

export function ledgerEntryIdentity(entry) {
  return entry?.id || `${entry?.record_kind || 'source'}:${entry?.path}@${entry?.source_sha256}`;
}

export function ledgerErrors(root, ledger, hashesByPath = new Map()) {
  const errors = [];
  if (ledger.fail_closed !== true) {
    errors.push('applied-migrations.ledger.json: fail_closed must be true');
  }
  if (ledger.append_only !== true) {
    errors.push('applied-migrations.ledger.json: append_only must be true');
  }
  const seen = new Set();
  const byId = new Map();
  for (const entry of ledger.entries || []) {
    const key = `${entry.path}@${entry.source_sha256}`;
    if (seen.has(key) && entry.mutation === 'rewrite') {
      errors.push(`ledger: rewrite of ${entry.path} is forbidden`);
    }
    seen.add(key);
    if (entry.mutation && entry.mutation !== 'append') {
      errors.push(`ledger: non-append mutation for ${entry.path}`);
    }
    if (entry.id) {
      if (byId.has(entry.id)) errors.push(`ledger: duplicate entry id ${entry.id}`);
      byId.set(entry.id, entry);
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
    if (entry.applied === true) {
      if (entry.record_kind !== 'apply_evidence') {
        errors.push(`ledger: applied evidence must be a new apply_evidence record (${entry.path})`);
      }
      if (!entry.source_record_id) {
        errors.push(`ledger: applied record ${entry.path} must link source_record_id`);
      }
      if (!entry.proof_path) {
        errors.push(`ledger: applied record ${entry.path} must include proof_path`);
      } else {
        errors.push(...gitTrackedFileErrors(root, entry.proof_path, `ledger ${entry.path} proof_path`));
      }
      if (!entry.applied_environment) {
        errors.push(`ledger: applied record ${entry.path} must include production environment metadata`);
      }
    }
  }
  for (const entry of ledger.entries || []) {
    if (entry.applied === true && entry.source_record_id && !byId.has(entry.source_record_id)) {
      errors.push(`ledger: applied record ${entry.path} source_record_id does not exist`);
    }
  }
  return errors;
}

export function genesisLedgerErrors(root, ledger) {
  const errors = [];
  if (ledger.genesis !== true || ledger.immutable_starting_point !== true) {
    errors.push('genesis ledger must set genesis=true and immutable_starting_point=true as the immutable starting point');
  }
  errors.push(...ledgerErrors(root, ledger));
  for (const entry of ledger.entries || []) {
    if (entry.applied === true) {
      errors.push(`genesis ledger cannot claim applied=true for ${entry.path}`);
    }
    if (entry.record_kind !== 'source') {
      errors.push(`genesis ledger entries must be record_kind=source (${entry.path})`);
    }
  }
  return errors;
}

export function appendOnlyLedgerErrors(root, candidate, baseLedger, { genesis } = {}) {
  if (!baseLedger) {
    if (!genesis) {
      return ['trusted base ledger is missing but genesis was not declared'];
    }
    return genesisLedgerErrors(root, candidate);
  }
  const errors = [];
  for (const [key, value] of Object.entries(baseLedger)) {
    if (key === 'entries') continue;
    if (!Object.prototype.hasOwnProperty.call(candidate, key) || !isDeepStrictEqual(candidate[key], value)) {
      errors.push(`ledger: trusted base field ${key} was removed or modified`);
    }
  }
  const baseEntries = baseLedger.entries || [];
  const candidateEntries = candidate.entries || [];
  if (candidateEntries.length < baseEntries.length) {
    errors.push('ledger: existing entries were deleted; history is append-only');
  }
  const compareLen = Math.min(baseEntries.length, candidateEntries.length);
  for (let i = 0; i < compareLen; i += 1) {
    if (!isDeepStrictEqual(candidateEntries[i], baseEntries[i])) {
      const base = baseEntries[i];
      const next = candidateEntries[i];
      if (base?.applied === false && next?.applied === true) {
        errors.push(`ledger: in-place applied=false to applied=true is forbidden for ${base.path}; append a linked apply_evidence record`);
      } else {
        errors.push(`ledger: existing entry ${i} (${ledgerEntryIdentity(base)}) was mutated or replaced`);
      }
    }
  }
  for (let i = baseEntries.length; i < candidateEntries.length; i += 1) {
    const entry = candidateEntries[i];
    if (entry.mutation !== 'append') {
      errors.push(`ledger: appended entry ${ledgerEntryIdentity(entry)} must have mutation=append`);
    }
  }
  errors.push(...ledgerErrors(root, candidate));
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

export function ownershipBidirectionalErrors(manifest, protectedPaths) {
  return componentIdErrors(manifest, protectedPaths);
}

export function evidenceReferenceErrors(root, manifest, evidence) {
  const errors = [];
  for (const [id, component] of Object.entries(manifest.components || {})) {
    for (const ref of component.production_validation?.evidence_refs || []) {
      if (typeof ref !== 'string' || !ref.includes('/')) continue;
      errors.push(...gitTrackedFileErrors(root, ref, `components.${id} evidence_ref`));
    }
  }
  if (evidence) {
    for (const id of Object.keys(evidence.components || {})) {
      if (!manifest.components?.[id]) {
        errors.push(`evidence-matrix component ${id} is not in the lock manifest`);
      }
    }
    for (const id of Object.keys(manifest.components || {})) {
      if (!evidence.components?.[id]) {
        errors.push(`manifest component ${id} is missing from evidence-matrix`);
      }
    }
  }
  return errors;
}

export function deletionAgainstBaseErrors({ baseManifest, candidateManifest, baseProtected, candidateProtected }) {
  const errors = [];
  if (baseManifest?.components) {
    for (const id of Object.keys(baseManifest.components)) {
      if (!candidateManifest.components?.[id]) {
        errors.push(`component ${id} was deleted; deleting a component is forbidden even if a replacement tree hash is supplied`);
      }
    }
  }
  if (baseProtected?.ownership_groups) {
    for (const id of Object.keys(baseProtected.ownership_groups)) {
      if (!candidateProtected.ownership_groups?.[id]) {
        errors.push(`protected-path group ${id} was deleted; deletion is forbidden even if a replacement tree hash is supplied`);
      }
    }
  }
  return errors;
}

export function unownedWatchErrors(root, protectedPaths, hashes) {
  const errors = [];
  const owned = new Set();
  for (const group of Object.values(hashes.groups || {})) {
    for (const file of group.files || []) owned.add(file);
  }
  for (const watch of protectedPaths.unowned_file_watches || []) {
    const expanded = expandProtectedPath(root, watch);
    if (expanded.missing) continue;
    for (const file of expanded.files) {
      if (!owned.has(file)) {
        errors.push(`unowned file ${file} under ${watch} is not claimed by an ownership group`);
      }
    }
  }
  return errors;
}

export function controlPlaneErrors(protectedPaths) {
  const errors = [];
  const groupId = protectedPaths.control_plane_group;
  const group = protectedPaths.ownership_groups?.[groupId];
  if (!group) {
    errors.push('control_plane_group is missing from ownership_groups');
    return errors;
  }
  if (group.control_plane !== true) {
    errors.push(`ownership group ${groupId} must be marked control_plane`);
  }
  for (const rel of CONTROL_PLANE_FILES) {
    const matches = matchProtectedPath(rel, protectedPaths);
    if (!matches.some((row) => row.groupId === groupId)) {
      errors.push(`control-plane file ${rel} must belong to ${groupId}`);
    }
  }
  return errors;
}

function yamlLinesWithoutComments(text) {
  return text.split('\n').map((line) => line.replace(/(^|\s)#.*$/, '')).join('\n');
}

export function workflowInvocationErrors(text) {
  const errors = [];
  if (!text || typeof text !== 'string') {
    return ['release-locks workflow is missing'];
  }
  const code = yamlLinesWithoutComments(text);
  if (/\bpull_request_target\s*:/.test(code)) {
    errors.push('pull_request_target is forbidden because it can execute untrusted PR code with secrets');
  }
  if (!/\bmerge_group\s*:/.test(code)) {
    errors.push('release-locks workflow must include a merge_group trigger');
  }
  if (!/actions\/checkout@[0-9a-f]{40}/.test(code)) {
    errors.push('actions/checkout must be pinned to a full 40-character commit SHA');
  }
  if (!/actions\/setup-node@[0-9a-f]{40}/.test(code)) {
    errors.push('actions/setup-node must be pinned to a full 40-character commit SHA');
  }
  if (/actions\/checkout@v\d/.test(code)) {
    errors.push('actions/checkout floating tag is forbidden');
  }
  if (/actions\/setup-node@v\d/.test(code)) {
    errors.push('actions/setup-node floating tag is forbidden');
  }
  for (const item of REQUIRED_WORKFLOW_INVOCATIONS) {
    if (!code.includes(item)) {
      errors.push(`release-locks workflow must invoke ${item}`);
    }
  }
  if (!code.includes('node --test ops/release-locks/tests/')) {
    errors.push('release-locks workflow must run required unit tests');
  }
  const namedJob = /(?:^|\n)\s*release-locks\s*:/.test(code);
  const noValidator = !code.includes('scripts/validate-release-locks.mjs');
  if (namedJob && noValidator) {
    errors.push('workflow retains check name release-locks but is a no-op bypass');
  }
  return errors;
}

export function allowlistRepoWide(pathValue) {
  if (typeof pathValue !== 'string') return true;
  const trimmed = pathValue.trim();
  return trimmed === ''
    || trimmed === '/'
    || trimmed === '.'
    || trimmed === './'
    || trimmed === '*'
    || trimmed === '**'
    || trimmed === '**/*';
}

export function allowlistPathPermitted(rowPath, protectedPaths) {
  if (allowlistRepoWide(rowPath)) return false;
  for (const group of Object.values(protectedPaths.ownership_groups || {})) {
    for (const prefix of group.paths || []) {
      if (rowPath === prefix) return true;
    }
  }
  return false;
}

export function allowlistHasReviewCondition(row) {
  return (typeof row.expires === 'string' && row.expires.trim().length > 0)
    || (typeof row.review_condition === 'string' && row.review_condition.trim().length >= 8);
}

export function allowlistEntryErrors(row, protectedPaths, index) {
  const errors = [];
  const label = `overlap-allowlist.allow[${index}]`;
  if (!Number.isInteger(row.other_pr) || row.other_pr < 1) {
    errors.push(`${label}: concrete PR number is required`);
  }
  if (allowlistRepoWide(row.path)) {
    errors.push(`${label}: empty or repository-wide path is forbidden`);
  } else if (!allowlistPathPermitted(row.path, protectedPaths)) {
    errors.push(`${label}: path must exactly equal a protected path or a specifically permitted protected prefix`);
  }
  if (!allowlistHasReviewCondition(row)) {
    errors.push(`${label}: expiration or review condition is required`);
  }
  if (typeof row.reason !== 'string' || row.reason.trim().length < 20) {
    errors.push(`${label}: meaningful reason (>= 20 characters) is required`);
  }
  return errors;
}

export function allowlistErrors(allowlist, protectedPaths) {
  const errors = [];
  if (!allowlist || allowlist.fail_closed !== true) {
    errors.push('overlap-allowlist.json: fail_closed must be true');
  }
  (allowlist.allow || []).forEach((row, index) => {
    errors.push(...allowlistEntryErrors(row, protectedPaths, index));
  });
  return errors;
}

export function allowlistCovers(row, rel, protectedPaths, otherPr) {
  if (row.other_pr !== otherPr) return false;
  if (allowlistEntryErrors(row, protectedPaths, 0).length) return false;
  if (row.path.endsWith('/')) {
    return rel === row.path.slice(0, -1) || rel.startsWith(row.path);
  }
  return rel === row.path;
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

export function validateReleaseLocks({
  root,
  manifest,
  schema,
  protectedPaths,
  ledger,
  allowlist = null,
  evidence = null,
  schemas = {},
  base = {},
  workflowText = null,
  genesis = false,
}) {
  const errors = [];
  if (manifest.fail_closed !== true) {
    errors.push('manifest.fail_closed must be true');
  }
  errors.push(...classificationSetErrors(manifest));
  errors.push(...validateSchemaDocument(manifest, schema));
  if (schemas.ledger && ledger) errors.push(...validateSchemaDocument(ledger, schemas.ledger));
  if (schemas.allowlist && allowlist) errors.push(...validateSchemaDocument(allowlist, schemas.allowlist));
  if (schemas.evidence && evidence) errors.push(...validateSchemaDocument(evidence, schemas.evidence));
  if (schemas.protectedPaths && protectedPaths) {
    errors.push(...validateSchemaDocument(protectedPaths, schemas.protectedPaths));
  }
  errors.push(...componentIdErrors(manifest, protectedPaths));
  const hashes = computeOwnershipHashes(root, protectedPaths);
  for (const err of hashes.errors) {
    errors.push(`protected-paths ${err.group}: missing ${err.missing.join(', ')}`);
  }
  for (const [id, component] of Object.entries(manifest.components || {})) {
    errors.push(...classificationErrors(component, id, root));
    errors.push(...sqlHashErrors(root, component, id));
    errors.push(...treeHashErrors(hashes, component, id));
  }
  errors.push(...appendOnlyLedgerErrors(root, ledger, base.ledger, { genesis }));
  if (allowlist) errors.push(...allowlistErrors(allowlist, protectedPaths));
  errors.push(...evidenceReferenceErrors(root, manifest, evidence));
  errors.push(...deletionAgainstBaseErrors({
    baseManifest: base.manifest,
    candidateManifest: manifest,
    baseProtected: base.protectedPaths,
    candidateProtected: protectedPaths,
  }));
  errors.push(...unownedWatchErrors(root, protectedPaths, hashes));
  errors.push(...controlPlaneErrors(protectedPaths));
  if (workflowText != null) errors.push(...workflowInvocationErrors(workflowText));
  return { errors, hashes, genesis };
}

export function collectPaginated({ fetchPage, pageSize = 100, maxPages = 50 }) {
  const items = [];
  let page = 1;
  let provenComplete = false;
  while (page <= maxPages) {
    const result = fetchPage(page, pageSize);
    if (!result || result.ok === false) {
      throw new Error(`pagination failed closed: ${result?.error || 'GitHub API failure'}`);
    }
    if (!Array.isArray(result.items)) {
      throw new Error('pagination not proven complete: invalid page payload');
    }
    items.push(...result.items);
    if (result.hasNext === true) {
      page += 1;
      continue;
    }
    if (result.hasNext === false) {
      provenComplete = true;
      break;
    }
    if (result.items.length < pageSize) {
      provenComplete = true;
      break;
    }
    throw new Error('pagination not proven complete: full page without a proven next-link result');
  }
  if (!provenComplete) {
    throw new Error('pagination not proven complete');
  }
  return { items, pages: page, complete: true };
}

export function parseGhApiIncludeOutput(raw) {
  const normalized = String(raw).replace(/\r\n/g, '\n');
  let rest = normalized;
  let status = 0;
  let headers = {};
  let body = '';
  while (rest.startsWith('HTTP/')) {
    const headerEnd = rest.indexOf('\n\n');
    const headerBlock = headerEnd >= 0 ? rest.slice(0, headerEnd) : rest;
    const lines = headerBlock.split('\n');
    const statusMatch = lines[0].match(/\s(\d{3})(?:\s|$)/);
    status = statusMatch ? Number(statusMatch[1]) : 0;
    headers = {};
    for (const line of lines.slice(1)) {
      const idx = line.indexOf(':');
      if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }
    if (headerEnd < 0) {
      body = '';
      break;
    }
    rest = rest.slice(headerEnd + 2);
    if (!rest.startsWith('HTTP/')) {
      body = rest;
      break;
    }
  }
  return { status, headers, body };
}
