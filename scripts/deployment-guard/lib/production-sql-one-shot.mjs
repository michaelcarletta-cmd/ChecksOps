/**
 * One-shot orchestration of a production SQL apply on the SQL53 runner.
 *
 * Runs, in order, with a fail-closed stop at every step:
 *   1. source: the transfer tarball's sha256 against its .sha256 sidecar and
 *      --expected-tarball-sha256, the tarball name and SOURCE_COMMIT against
 *      --commit, every file of the extracted tree against the tarball (content,
 *      no extra files, no symlink leaving the tree), and the migration file
 *      against the pin; the tree check repeats right before steps 5 and 7
 *   2. inspect: the registered per-migration tool's read-only --inspect
 *   3. contracts: every accepted contract the registry requires for a
 *      production sql-apply, run on this tree with node --test
 *   4. manifest: built from the pin, the inspect and the contract results
 *   5. preflight: preflight.mjs --acquire-lease --receipt (issues the receipt)
 *   6. evaluate: the tool without --apply (must report <tool>_apply_allowed true)
 *   7. apply: the tool with --apply; the only child that gets
 *      CHECKSOPS_DEPLOYMENT_GUARD_APPLY=1 and CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT
 *   8. post-apply inspect
 *
 * Phase `inspect` stops after step 3 and writes nothing. The per-migration
 * tools stay the only code that connects to the database; this module only
 * runs them as child processes through an injectable runner. It never reads,
 * writes or accepts a receipt: the receipt path comes only from the preflight
 * child's own output and is handed only to the apply child. Children get only
 * CHILD_ENV_ALLOWLIST; the manifest's temp directory is deleted after the run.
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';
import { loadContractRegistry, relevantContracts } from './contracts.mjs';
import { CODES, fail, ok } from './errors.mjs';
import { LOCAL_STATE_DIR, receiptDir } from './paths.mjs';
import { hashSqlDefinition } from './sql-apply.mjs';
import { MEMBER_STAKEHOLDER_MIGRATIONS } from './sql-member-stakeholder-production-apply.mjs';
import { SQL71_PRODUCTION_PIN_REL } from './sql71-review-amount-production-apply.mjs';
import { SQL80_PRODUCTION_PIN_REL } from './sql80-checkalt-production-apply.mjs';
import { SQL81_PRODUCTION_PIN_REL } from './sql81-checkalt-production-apply.mjs';
import { SQL82_PRODUCTION_PIN_REL } from './sql82-homeowner-ledger-production-apply.mjs';
import { SQL83_PRODUCTION_PIN_REL } from './sql83-homeowner-signing-production-apply.mjs';
import { SQL84_PRODUCTION_PIN_REL } from './sql84-mortgage-return-to-queue-production-apply.mjs';
import { SQL85_PRODUCTION_PIN_REL } from './sql85-mortgage-compensation-adjust-production-apply.mjs';
import { SQL86_PRODUCTION_PIN_REL } from './sql86-mortgage-compensation-owner-only-production-apply.mjs';
import { SQL87_PRODUCTION_PIN_REL } from './sql87-resolve-check-case-tenant-scope-production-apply.mjs';
import { SQL88_PRODUCTION_PIN_REL } from './sql88-claim-id-assign-case-tenant-scope-production-apply.mjs';
import { SQL89_PRODUCTION_PIN_REL } from './sql89-check-intake-column-update-production-apply.mjs';
import { LIBRARY_PRODUCTION } from './sql29-sql30-library-production-apply.mjs';
import { RELEASE_PRODUCTION } from './release-sql-production-apply.mjs';

export const ONE_SHOT_COMPONENT = 'production-sql';
export const ONE_SHOT_DEPLOYMENT_TYPE = 'sql-apply';
export const ONE_SHOT_PHASES = Object.freeze(['inspect', 'apply']);

/**
 * The one-shot refuses to start when any variable with this prefix (or
 * CHECKSOPS_SKIP_DEPLOYMENT_GUARD) is set: APPLY, RECEIPT, BYPASS, ROOT
 * (redirects the guard root), EXEC_LEGACY, and the KMS key variables. The KMS
 * variables are read only by the GitHub-hosted Lambda/SPA/staging-executor
 * scripts, never by preflight.mjs or the production SQL tools, so there is no
 * legitimate exception to make here.
 */
export const GUARD_ENV_PREFIX = 'CHECKSOPS_DEPLOYMENT_GUARD_';
export const GUARD_ENV_KEYS = Object.freeze([
  'CHECKSOPS_DEPLOYMENT_GUARD_APPLY',
  'CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT',
  'CHECKSOPS_DEPLOYMENT_GUARD_BYPASS',
  'CHECKSOPS_DEPLOYMENT_GUARD_ROOT',
  'CHECKSOPS_DEPLOYMENT_GUARD_EXEC_LEGACY',
  'CHECKSOPS_DEPLOYMENT_GUARD_KMS_KEY_ARN',
  'CHECKSOPS_SKIP_DEPLOYMENT_GUARD',
]);
const isGuardEnvKey = (key) => key.startsWith(GUARD_ENV_PREFIX) || key === 'CHECKSOPS_SKIP_DEPLOYMENT_GUARD';

/** Variables that change what code node or the dynamic loader runs; set means refuse. */
export const LOADER_ENV_KEYS = Object.freeze([
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_REPL_EXTERNAL_MODULE',
  'NODE_PRESERVE_SYMLINKS',
  'NODE_PRESERVE_SYMLINKS_MAIN',
  'NODE_ICU_DATA',
  'NODE_COMPILE_CACHE',
  'OPENSSL_CONF',
  'OPENSSL_MODULES',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
]);
const isLoaderEnvKey = (key) => LOADER_ENV_KEYS.includes(key) || key.startsWith('DYLD_');

/**
 * The only variables a child inherits. The tools resolve the admin secret with
 * the instance role (IMDS) in us-east-1 through the Secrets Manager VPC endpoint,
 * and connect with the repository's RDS CA bundle; nothing else is needed.
 */
export const CHILD_ENV_ALLOWLIST = Object.freeze([
  'PATH',
  'HOME',
  'USER',
  'LANG',
  'LC_ALL',
  'TZ',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_ENDPOINT_URL_SECRETS_MANAGER',
]);

export const ONE_SHOT_FLAGS = Object.freeze([
  'migration',
  'commit',
  'workstream-id',
  'approval-statement',
  'approval-statement-b64',
  'approval-scope',
  'phase',
  'source-tarball',
  'expected-tarball-sha256',
  'operator',
  'runner',
]);

const MEMBER_TOOL = 'scripts/deployment-guard/sql-member-stakeholder-production-apply.mjs';
const SQL71_TOOL = 'scripts/deployment-guard/sql71-review-amount-production-apply.mjs';
const SQL80_TOOL = 'scripts/deployment-guard/sql80-checkalt-production-apply.mjs';
const SQL81_TOOL = 'scripts/deployment-guard/sql81-checkalt-production-apply.mjs';
const SQL82_TOOL = 'scripts/deployment-guard/sql82-homeowner-ledger-production-apply.mjs';
const SQL83_TOOL = 'scripts/deployment-guard/sql83-homeowner-signing-production-apply.mjs';
const SQL84_TOOL = 'scripts/deployment-guard/sql84-mortgage-return-to-queue-production-apply.mjs';
const SQL85_TOOL = 'scripts/deployment-guard/sql85-mortgage-compensation-adjust-production-apply.mjs';
const SQL86_TOOL = 'scripts/deployment-guard/sql86-mortgage-compensation-owner-only-production-apply.mjs';
const SQL87_TOOL = 'scripts/deployment-guard/sql87-resolve-check-case-tenant-scope-production-apply.mjs';
const SQL88_TOOL = 'scripts/deployment-guard/sql88-claim-id-assign-case-tenant-scope-production-apply.mjs';
const SQL89_TOOL = 'scripts/deployment-guard/sql89-check-intake-column-update-production-apply.mjs';
const SQL29_TOOL = 'scripts/deployment-guard/sql29-mortgage-ops-library-parity-production-apply.mjs';
const SQL30_TOOL = 'scripts/deployment-guard/sql30-tenant-documents-doc-type-production-apply.mjs';
const PREFLIGHT = 'scripts/deployment-guard/preflight.mjs';

const memberTool = (key) => Object.freeze({
  key,
  script: MEMBER_TOOL,
  args: Object.freeze(['--migration', key]),
  pin_rel: MEMBER_STAKEHOLDER_MIGRATIONS[key].pin_rel,
  allowed_key: 'member_stakeholder_production_apply_allowed',
});

/**
 * Registered production SQL tools. Adding a migration means adding its
 * reviewed tool here; the one-shot never applies SQL itself.
 */
export const ONE_SHOT_TOOLS = Object.freeze({
  // SQL 29 and SQL 30 (Mortgage Ops library parity, tenant_documents doc_type CHECK;
  // ops/production-sql-29-30-apply.md). Pin, file hash and fingerprints come from the pin
  // (source_sha256 included), so a reviewed change to either file only touches its pin and
  // the tool's staging binding, never this registry.
  //   Order (runs_before, informational; each tool and successor enforces it itself):
  //   SQL 29 before SQL 90 and SQL 94: the tool refuses with sql90_not_applied once SQL 90's
  //   aws_is_tenant_member(uuid) exists, and the one-shot also requires the inspect's
  //   sql90_applied to be false (inspect_requires). SQL 30 before SQL 90 (a SQL 90
  //   predecessor) and SQL 94 (the tool refuses SQL 94's CHECK with
  //   check_is_supported_predecessor). SQL 29 and SQL 30 are independent of each other;
  //   release order runs SQL 29, then SQL 30.
  sql29: Object.freeze({
    key: 'sql29',
    script: SQL29_TOOL,
    args: Object.freeze([]),
    pin_rel: LIBRARY_PRODUCTION.sql29.pin_rel,
    allowed_key: LIBRARY_PRODUCTION.sql29.allowed_key,
    runs_before: Object.freeze(['sql90', 'sql94']),
    inspect_requires: Object.freeze([Object.freeze(['sql90_applied', false])]),
  }),
  sql30: Object.freeze({
    key: 'sql30',
    script: SQL30_TOOL,
    args: Object.freeze([]),
    pin_rel: LIBRARY_PRODUCTION.sql30.pin_rel,
    allowed_key: LIBRARY_PRODUCTION.sql30.allowed_key,
    runs_before: Object.freeze(['sql90', 'sql94']),
  }),
  sql71: Object.freeze({
    key: 'sql71',
    script: SQL71_TOOL,
    args: Object.freeze([]),
    pin_rel: SQL71_PRODUCTION_PIN_REL,
    allowed_key: 'sql71_production_apply_allowed',
  }),
  sql77: memberTool('sql77'),
  sql78: memberTool('sql78'),
  sql79: memberTool('sql79'),
  sql80: Object.freeze({
    key: 'sql80',
    script: SQL80_TOOL,
    args: Object.freeze([]),
    pin_rel: SQL80_PRODUCTION_PIN_REL,
    allowed_key: 'sql80_production_apply_allowed',
  }),
  sql81: Object.freeze({
    key: 'sql81',
    script: SQL81_TOOL,
    args: Object.freeze([]),
    pin_rel: SQL81_PRODUCTION_PIN_REL,
    allowed_key: 'sql81_production_apply_allowed',
  }),
  sql82: Object.freeze({
    key: 'sql82',
    script: SQL82_TOOL,
    args: Object.freeze([]),
    pin_rel: SQL82_PRODUCTION_PIN_REL,
    allowed_key: 'sql82_production_apply_allowed',
  }),
  sql83: Object.freeze({
    key: 'sql83',
    script: SQL83_TOOL,
    args: Object.freeze([]),
    pin_rel: SQL83_PRODUCTION_PIN_REL,
    allowed_key: 'sql83_production_apply_allowed',
  }),
  sql84: Object.freeze({
    key: 'sql84',
    script: SQL84_TOOL,
    args: Object.freeze([]),
    pin_rel: SQL84_PRODUCTION_PIN_REL,
    allowed_key: 'sql84_production_apply_allowed',
  }),
  sql85: Object.freeze({
    key: 'sql85',
    script: SQL85_TOOL,
    args: Object.freeze([]),
    pin_rel: SQL85_PRODUCTION_PIN_REL,
    allowed_key: 'sql85_production_apply_allowed',
  }),
  sql86: Object.freeze({
    key: 'sql86',
    script: SQL86_TOOL,
    args: Object.freeze([]),
    pin_rel: SQL86_PRODUCTION_PIN_REL,
    allowed_key: 'sql86_production_apply_allowed',
  }),
  sql87: Object.freeze({
    key: 'sql87',
    script: SQL87_TOOL,
    args: Object.freeze([]),
    pin_rel: SQL87_PRODUCTION_PIN_REL,
    allowed_key: 'sql87_production_apply_allowed',
  }),
  sql88: Object.freeze({
    key: 'sql88',
    script: SQL88_TOOL,
    args: Object.freeze([]),
    pin_rel: SQL88_PRODUCTION_PIN_REL,
    allowed_key: 'sql88_production_apply_allowed',
  }),
  sql89: Object.freeze({
    key: 'sql89',
    script: SQL89_TOOL,
    args: Object.freeze([]),
    pin_rel: SQL89_PRODUCTION_PIN_REL,
    allowed_key: 'sql89_production_apply_allowed',
  }),
  // SQL 90-106 and 108 (release 2026-10-17): one tool per migration on the shared release engine.
  ...Object.fromEntries(Object.values(RELEASE_PRODUCTION).map((tool) => [tool.key, Object.freeze({
    key: tool.key,
    script: tool.cli,
    args: Object.freeze([]),
    pin_rel: tool.pin_rel,
    allowed_key: tool.allowed_key,
  })])),
  // SQL 103 (ops/production-sql-103-apply.md): the shared release tool, like SQL 90-102, with
  // its order. Pin, file hash and fingerprints come from the pin, never this registry.
  //   Order (runs_before, informational): SQL 103 immediately before SQL 29. SQL 29's guard
  //   (function_acl_replaceable) refuses the trigger function's live checksops EXECUTE entry
  //   until SQL 103 has left the owner as the only grantee; SQL 103 itself has no predecessor
  //   and is refused as already in place once the owner is the only grantee (after SQL 29).
  sql103: Object.freeze({
    key: 'sql103',
    script: RELEASE_PRODUCTION.sql103.cli,
    args: Object.freeze([]),
    pin_rel: RELEASE_PRODUCTION.sql103.pin_rel,
    allowed_key: RELEASE_PRODUCTION.sql103.allowed_key,
    runs_before: Object.freeze(['sql29']),
  }),
  // SQL 106 (ops/production-sql-106-apply.md): the shared release tool, with its order. Pin, file
  // hash and fingerprints come from the pin, never this registry.
  //   Order (runs_before, informational): SQL 106 before SQL 97. SQL 97's guard is BEFORE INSERT
  //   only; its inspect lists any non-owner UPDATE / DELETE / TRUNCATE grant on financial_stepup_log
  //   (release_sql_inspect.table_privileges[0].other_write_grants) and its runbook stops the apply
  //   unless that is [], which it is once SQL 106 ran. SQL 106 has no predecessor and leaves SQL
  //   97's fingerprint unchanged, so it also runs where SQL 97 is already applied (staging).
  sql106: Object.freeze({
    key: 'sql106',
    script: RELEASE_PRODUCTION.sql106.cli,
    args: Object.freeze([]),
    pin_rel: RELEASE_PRODUCTION.sql106.pin_rel,
    allowed_key: RELEASE_PRODUCTION.sql106.allowed_key,
    runs_before: Object.freeze(['sql97']),
  }),
});

/** Inspect fields copied into the summary and the `applied` block when the tool prints them. */
export const INSPECT_RECORD_KEYS = Object.freeze([
  // SQL 88: existing cross-tenant links, counts only (informational), first.
  'cross_tenant_links',
  'read_only',
  'live_definition_sha256',
  'live_matches_expected',
  'already_applied',
  'predecessors',
  'predecessors_applied',
  'missing_dependencies',
  'apply_preconditions_met',
  'precondition_failures',
  'current_user',
  'session_user',
  'owner_roles',
  'authenticated_member_of_owner',
  'table_owner',
  'table_owners',
  'table_acl',
  'table_acls',
  'table_acl_entries',
  'policy_entries',
  'function_present',
  'function_owner',
  'function_acl',
  'function_acl_entries',
  'table_write_entries',
  'function_states',
  'pre_state_recorded',
  'row_security_off_supported',
  'ledger_view_raw_endorse_token_link',
  'sql47_prerequisites_present',
  'missing_prerequisites',
  'per_check_unique_present',
  'billing_duplicates',
  'earn_owner',
  'updatable_columns',
  'amount_update_granted',
  'routing_number_update_granted',
  'account_number_update_granted',
  'sql52_prerequisite_met',
  'table_level_update',
  'column_update_entries',
  'case_owner',
  'other_callers',
  'table_privileges',
  'columns_to_grant',
  'columns_losing_update',
  'sql89_columns_missing',
  'unsafe_update_functions',
  'ingest_function_security_definer',
  // SQL 29 / SQL 30: prerequisites, the SQL 90 marker and the catalog state reports (no rows).
  'prerequisites_missing',
  'sql90_applied',
  'sql29',
  'sql30',
  // SQL 90-102: aggregate counts, successor markers and the per-object state report (no rows).
  'counts',
  'successors_applied',
  'release_sql_inspect',
]);

const GIT_SHA_RE = /^[0-9a-f]{40}$/;
const WORKSTREAM_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const TIMEOUT_MS = Object.freeze({ inspect: 5 * 60_000, contract: 10 * 60_000, preflight: 2 * 60_000, apply: 10 * 60_000 });

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// --- arguments --------------------------------------------------------------

/** Strict base64 (alphabet and padding), decoded as UTF-8 that round-trips. */
export function decodeApprovalB64(value) {
  const text = String(value || '');
  if (!text || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) return null;
  const buf = Buffer.from(text, 'base64');
  const decoded = buf.toString('utf8');
  return Buffer.from(decoded, 'utf8').equals(buf) ? decoded : null;
}

/**
 * Validates flags, the caller's environment and node's own flags; refuses
 * anything that could carry a receipt or change what code runs.
 */
export function validateOneShotArgs(opts = {}, env = {}, { execArgv = [] } = {}) {
  const unknown = Object.keys(opts).filter((key) => !ONE_SHOT_FLAGS.includes(key));
  if (unknown.length) {
    return fail(CODES.INVALID_MANIFEST, 'unknown flag; the one-shot takes no receipt, manifest or input file', { unknown, allowed: [...ONE_SHOT_FLAGS] });
  }
  const presetGuardEnv = Object.keys(env).filter(isGuardEnvKey);
  if (presetGuardEnv.length) {
    return fail(CODES.DEPLOYMENT_GUARD_REQUIRED, 'CHECKSOPS_DEPLOYMENT_GUARD_* variables must not be set for the one-shot; the receipt comes only from its own preflight step', { preset: presetGuardEnv });
  }
  const loaderEnv = Object.keys(env).filter(isLoaderEnvKey);
  if (loaderEnv.length || execArgv.length) {
    return fail(CODES.DEPLOYMENT_GUARD_REQUIRED, 'node loader variables or node flags are set; run the one-shot as plain `node <script>`', { preset: loaderEnv, exec_argv: [...execArgv] });
  }
  const errors = [];
  const tool = typeof opts.migration === 'string' && Object.hasOwn(ONE_SHOT_TOOLS, opts.migration) ? ONE_SHOT_TOOLS[opts.migration] : null;
  if (!tool) errors.push(`--migration must be one of ${Object.keys(ONE_SHOT_TOOLS).join(', ')}`);
  if (!tool || opts['approval-scope'] !== opts.migration) errors.push('--approval-scope must name the migration the owner approved and equal --migration');
  if (!ONE_SHOT_PHASES.includes(opts.phase)) errors.push('--phase must be inspect or apply');
  if (!GIT_SHA_RE.test(String(opts.commit || ''))) errors.push('--commit must be a 40-character lowercase git SHA');
  if (!WORKSTREAM_RE.test(String(opts['workstream-id'] || ''))) errors.push('--workstream-id must match ^[A-Za-z0-9._:-]{8,128}$');
  let statement = null;
  const plain = opts['approval-statement'];
  const b64 = opts['approval-statement-b64'];
  if (plain !== undefined && b64 !== undefined) {
    errors.push('pass exactly one of --approval-statement and --approval-statement-b64');
  } else if (b64 !== undefined) {
    statement = typeof b64 === 'string' ? decodeApprovalB64(b64) : null;
    if (statement === null) errors.push('--approval-statement-b64 must be valid base64 of UTF-8 text');
  } else {
    statement = typeof plain === 'string' ? plain : null;
  }
  if (typeof statement !== 'string' || statement.trim() === '') errors.push("--approval-statement (the owner's exact words) is required and must be non-empty");
  if (typeof opts['source-tarball'] !== 'string' || !opts['source-tarball']) errors.push('--source-tarball <path to source-<commit>.tar.gz> is required');
  if (!SHA256_RE.test(String(opts['expected-tarball-sha256'] || ''))) errors.push('--expected-tarball-sha256 (TARBALL_SHA256 from the transfer run log) must be a 64-character lowercase sha256');
  if (typeof opts.operator !== 'string' || !opts.operator.trim()) errors.push('--operator <login> is required');
  if (opts.runner !== undefined && (typeof opts.runner !== 'string' || !opts.runner.trim())) errors.push('--runner needs a value');
  if (errors.length) return fail(CODES.INVALID_MANIFEST, errors[0], { errors });
  return ok({
    tool,
    phase: opts.phase,
    commit: opts.commit,
    workstream_id: opts['workstream-id'],
    approval_statement: statement,
    approval_scope: opts['approval-scope'],
    source_tarball: path.resolve(opts['source-tarball']),
    expected_tarball_sha256: opts['expected-tarball-sha256'],
    operator: opts.operator,
    runner: opts.runner || null,
  });
}

/** Only the allowlisted variables; never a guard or loader variable. */
export function childBaseEnv(env = {}) {
  const out = {};
  for (const key of CHILD_ENV_ALLOWLIST) if (typeof env[key] === 'string') out[key] = env[key];
  return out;
}

// --- tarball ----------------------------------------------------------------

const cString = (buf) => {
  const end = buf.indexOf(0);
  return buf.subarray(0, end === -1 ? buf.length : end).toString('utf8');
};

function parseOctal(field) {
  if (field[0] & 0x80) throw new Error('base-256 tar size is not supported');
  const text = cString(field).trim();
  if (!/^[0-7]*$/.test(text)) throw new Error(`bad octal field ${JSON.stringify(text)}`);
  return text ? parseInt(text, 8) : 0;
}

function parsePax(buf) {
  const out = {};
  let rest = buf.toString('utf8');
  while (rest.length) {
    const space = rest.indexOf(' ');
    const len = Number(rest.slice(0, space));
    if (!Number.isInteger(len) || len <= 0) break;
    const record = rest.slice(space + 1, len - 1);
    const eq = record.indexOf('=');
    out[record.slice(0, eq)] = record.slice(eq + 1);
    rest = rest.slice(len);
  }
  return out;
}

/** Repository-relative entry path; refuses absolute and parent-escaping names. */
export function normalizeTarPath(name) {
  let rel = String(name).replace(/\/+$/, '');
  while (rel.startsWith('./')) rel = rel.slice(2);
  if (rel === '.' || rel === '') return '';
  if (rel.startsWith('/') || rel.split('/').some((part) => part === '..')) {
    throw new Error(`unsafe tar entry ${JSON.stringify(name)}`);
  }
  return rel;
}

/**
 * Reads the tarball once into memory, so the bytes that are hashed are exactly
 * the bytes that are indexed (no window to swap the file between the two).
 */
export async function readTarball(file) {
  const raw = fs.readFileSync(file);
  return { sha256: sha256(raw), index: await readTarIndex(raw) };
}

/** Streams a .tar.gz (path or Buffer) and returns every entry with the sha256 of each regular file. */
export async function readTarIndex(source) {
  const entries = new Map();
  let buf = Buffer.alloc(0);
  let cur = null;
  let next = {};
  let zeroBlocks = 0;
  let ended = false;

  const finish = (entry) => {
    const { type } = entry;
    if (type === 'L') { next.path = cString(Buffer.concat(entry.meta)); return; }
    if (type === 'K') { next.linkpath = cString(Buffer.concat(entry.meta)); return; }
    if (type === 'x') { const pax = parsePax(Buffer.concat(entry.meta)); if (pax.path) next.path = pax.path; if (pax.linkpath) next.linkpath = pax.linkpath; return; }
    if (type === 'g') return;
    const rel = normalizeTarPath(next.path ?? entry.name);
    const linkname = next.linkpath ?? entry.linkname;
    next = {};
    if (!rel) return;
    if (type === '0' || type === '\0' || type === '7') entries.set(rel, { type: 'file', size: entry.size, sha256: entry.hash.digest('hex') });
    else if (type === '5') entries.set(rel, { type: 'dir' });
    else if (type === '2') entries.set(rel, { type: 'symlink', linkname });
    else throw new Error(`unsupported tar entry type ${JSON.stringify(type)} for ${rel}`);
  };

  const input = Buffer.isBuffer(source) ? Readable.from([source]) : fs.createReadStream(source);
  const stream = input.pipe(zlib.createGunzip());
  for await (const chunk of stream) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    let off = 0;
    for (;;) {
      if (ended) { off = buf.length; break; }
      if (cur) {
        const take = Math.min(cur.remaining, buf.length - off);
        if (take > 0) {
          const slice = buf.subarray(off, off + take);
          if (cur.hash) cur.hash.update(slice);
          if (cur.meta) cur.meta.push(Buffer.from(slice));
          cur.remaining -= take;
          off += take;
        }
        if (cur.remaining > 0 || buf.length - off < cur.pad) break;
        off += cur.pad;
        finish(cur);
        cur = null;
        continue;
      }
      if (buf.length - off < 512) break;
      const header = buf.subarray(off, off + 512);
      off += 512;
      if (header.every((byte) => byte === 0)) {
        zeroBlocks += 1;
        if (zeroBlocks >= 2) ended = true;
        continue;
      }
      zeroBlocks = 0;
      const expected = parseOctal(header.subarray(148, 156));
      let sum = 0;
      for (let i = 0; i < 512; i += 1) sum += (i >= 148 && i < 156) ? 0x20 : header[i];
      if (sum !== expected) throw new Error('tar header checksum mismatch');
      const type = String.fromCharCode(header[156]);
      const magic = header.subarray(257, 263).toString('latin1');
      const prefix = magic === 'ustar\0' ? cString(header.subarray(345, 500)) : '';
      const baseName = cString(header.subarray(0, 100));
      const size = parseOctal(header.subarray(124, 136));
      const isMeta = ['L', 'K', 'x', 'g'].includes(type);
      const isFile = type === '0' || type === '\0' || type === '7';
      cur = {
        type,
        name: prefix ? `${prefix}/${baseName}` : baseName,
        linkname: cString(header.subarray(157, 257)),
        size,
        remaining: size,
        pad: (512 - (size % 512)) % 512,
        hash: isFile ? createHash('sha256') : null,
        meta: isMeta ? [] : null,
      };
      if (!isFile && !isMeta && size !== 0 && type !== '5') throw new Error(`unexpected data for tar entry type ${JSON.stringify(type)}`);
    }
    buf = buf.subarray(off);
  }
  if (cur) throw new Error('tar archive is truncated');
  return entries;
}

function walkTree(root, rel = '', out = new Map()) {
  for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (!rel && entry.name === LOCAL_STATE_DIR) continue; // lease, receipt and consumed-id state
    if (entry.isDirectory()) { out.set(child, 'dir'); walkTree(root, child, out); }
    else if (entry.isSymbolicLink()) out.set(child, 'symlink');
    else if (entry.isFile()) out.set(child, 'file');
    else out.set(child, 'other');
  }
  return out;
}

/**
 * The running tree must be exactly the tarball: same bytes for every file, same
 * symlinks, and no file the tarball does not contain (outside .deployment-guard/).
 */
export async function compareTreeToTarball(root, tarball) {
  let index;
  try {
    ({ index } = await readTarball(tarball));
  } catch (error) {
    return fail(CODES.STALE_PACKAGE, 'source tarball could not be read', { message: String(error?.message || error).slice(0, 300) });
  }
  return compareTreeToIndex(root, index);
}

const within = (base, target) => target === base || target.startsWith(`${base}${path.sep}`);

/**
 * The tree against an index read once from the verified tarball bytes; re-checks
 * use the same cached index, never the tarball file on disk again. Symlinks
 * must stay inside the tree both lexically and after resolving every link
 * (kernel realpath, fs.realpathSync.native), e.g. `s -> .` plus `t -> s/..` is refused.
 */
export async function compareTreeToIndex(root, index) {
  const differing = [];
  const missing = [];
  const escaping = [];
  const rootAbs = path.resolve(root);
  let rootReal;
  try { rootReal = fs.realpathSync.native(rootAbs); } catch { return fail(CODES.STALE_PACKAGE, 'source tree root is missing', { root: rootAbs }); }
  let files = 0;
  for (const [rel, entry] of index) {
    const abs = path.join(root, rel);
    if (entry.type === 'symlink') {
      const target = path.resolve(path.dirname(path.join(rootAbs, rel)), String(entry.linkname || ''));
      if (!entry.linkname || path.isAbsolute(entry.linkname) || !within(rootAbs, target)) {
        escaping.push(rel);
        continue;
      }
    }
    let stat;
    try { stat = fs.lstatSync(abs); } catch { missing.push(rel); continue; }
    if (entry.type === 'file') {
      files += 1;
      if (!stat.isFile() || sha256(fs.readFileSync(abs)) !== entry.sha256) differing.push(rel);
    } else if (entry.type === 'symlink') {
      if (!stat.isSymbolicLink() || fs.readlinkSync(abs) !== entry.linkname) { differing.push(rel); continue; }
      let real = null;
      try { real = fs.realpathSync.native(abs); } catch { /* dangling or looping: refused below */ }
      if (real === null || !within(rootReal, real)) escaping.push(rel);
    } else if (!stat.isDirectory()) {
      differing.push(rel);
    }
  }
  const extra = [...walkTree(root)].filter(([rel]) => !index.has(rel)).map(([rel]) => rel);
  if (differing.length || missing.length || extra.length || escaping.length || files === 0) {
    return fail(CODES.SOURCE_RECONCILIATION_REQUIRED, 'the running source tree is not exactly the transfer tarball', {
      tarball_files: files,
      differing: differing.slice(0, 20),
      missing: missing.slice(0, 20),
      extra: extra.slice(0, 20),
      escaping_symlinks: escaping.slice(0, 20),
      counts: { differing: differing.length, missing: missing.length, extra: extra.length, escaping_symlinks: escaping.length },
    });
  }
  return ok({ tarball_files: files, tarball_entries: index.size });
}

/** SOURCE_COMMIT as written by sql53-temporary-transfer (`<sha>\n`), or null. */
export function readSourceCommit(root) {
  const file = path.join(root, 'SOURCE_COMMIT');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

/**
 * Step 1: tarball sha256 == the transfer run's printed hash (and the sidecar),
 * tree == tarball, SOURCE_COMMIT == --commit, migration bytes == pin.
 */
export async function verifySource({ root, commit, tarball, expectedSha256, pin, tool }, deps = {}) {
  const expectedName = `source-${commit}.tar.gz`;
  if (path.basename(tarball) !== expectedName) {
    return fail(CODES.STALE_PACKAGE, 'source tarball name does not match --commit', { expected: expectedName, actual: path.basename(tarball) });
  }
  if (!fs.existsSync(tarball) || !fs.existsSync(`${tarball}.sha256`)) {
    return fail(CODES.STALE_PACKAGE, 'source tarball or its .sha256 sidecar is missing', { tarball });
  }
  const sidecar = fs.readFileSync(`${tarball}.sha256`, 'utf8').trim().split('\n');
  const match = sidecar.length === 1 ? /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(sidecar[0]) : null;
  if (!match || path.basename(match[2]) !== expectedName) {
    return fail(CODES.STALE_PACKAGE, 'the .sha256 sidecar must be one "<sha256>  source-<commit>.tar.gz" line');
  }
  let read;
  try {
    read = await (deps.readTarball || readTarball)(tarball);
  } catch (error) {
    return fail(CODES.STALE_PACKAGE, 'source tarball could not be read', { message: String(error?.message || error).slice(0, 300) });
  }
  const { sha256: tarballSha, index } = read;
  if (tarballSha !== match[1]) {
    return fail(CODES.STALE_PACKAGE, 'source tarball sha256 differs from its sidecar', { computed: tarballSha, sidecar: match[1] });
  }
  if (tarballSha !== expectedSha256) {
    return fail(CODES.STALE_PACKAGE, 'source tarball sha256 differs from --expected-tarball-sha256 (the transfer run log)', { computed: tarballSha, expected: expectedSha256 });
  }
  const tree = await (deps.compareTreeToIndex || compareTreeToIndex)(root, index);
  if (!tree.ok) return tree;
  const sourceCommit = (deps.readSourceCommit || readSourceCommit)(root);
  if (sourceCommit !== `${commit}\n`) {
    return fail(CODES.STALE_PACKAGE, 'SOURCE_COMMIT in the tree is not --commit (tarballs built before SOURCE_COMMIT existed must be re-staged)', {
      source_commit: sourceCommit === null ? null : sourceCommit.slice(0, 80),
      commit,
    });
  }
  const bindings = [
    ['migration', tool.key],
    ['target_environment', 'production'],
    ['target_component', ONE_SHOT_COMPONENT],
    ['deployment_type', ONE_SHOT_DEPLOYMENT_TYPE],
  ].filter(([key, value]) => pin[key] !== value).map(([key]) => key);
  if (bindings.length || !SHA256_RE.test(String(pin.source_sha256 || ''))) {
    return fail(CODES.SQL_COLLISION, 'production pin does not name this migration and target', { mismatched: bindings });
  }
  const migrationFile = path.join(root, pin.filename);
  if (!fs.existsSync(migrationFile)) return fail(CODES.STALE_PACKAGE, 'pinned migration file is missing', { filename: pin.filename });
  const migrationSha = hashSqlDefinition(fs.readFileSync(migrationFile, 'utf8'));
  if (migrationSha !== pin.source_sha256) {
    return fail(CODES.SOURCE_RECONCILIATION_REQUIRED, 'migration file bytes differ from the production pin', {
      source_sha256: migrationSha,
      pinned_source_sha256: pin.source_sha256,
    });
  }
  // The verified index travels beside the result (not in the printed details) for the re-checks.
  return Object.assign(ok({
    tarball: path.basename(tarball),
    tarball_sha256: tarballSha,
    tarball_sha256_matches_sidecar: true,
    tarball_sha256_matches_expected: true,
    tree_matches_tarball: true,
    source_commit: commit,
    tarball_files: tree.details.tarball_files,
    filename: pin.filename,
    migration_source_sha256: migrationSha,
    migration_matches_pin: true,
  }), { index });
}

// --- child processes ----------------------------------------------------------

/** One JSON document from a tool's output (the tools print exactly one). */
export function parseJsonOutput(text) {
  const value = String(text || '').trim();
  if (!value) return null;
  try { return JSON.parse(value); } catch { /* fall through */ }
  const start = value.startsWith('{') ? 0 : value.indexOf('\n{');
  if (start === -1) return null;
  try { return JSON.parse(value.slice(start).trim()); } catch { return null; }
}

function runTool(ctx, step, args, { env, timeout }) {
  const res = ctx.run({ step, command: ctx.nodePath, args, cwd: ctx.root, env, timeout });
  const json = parseJsonOutput(res.status === 0 ? res.stdout : res.stderr) || parseJsonOutput(res.stdout) || parseJsonOutput(res.stderr);
  return { status: res.status, json, stderr_tail: String(res.stderr || '').slice(-1500), error: res.error ? String(res.error.message || res.error) : null };
}

// Recorded inspect fields are summaries: billing_duplicates keeps its counts (and the
// reason when unreadable), never check_ids.
const INSPECT_RECORD_FIELDS = Object.freeze({
  billing_duplicates: Object.freeze(['readable', 'groups', 'extra_events', 'reason']),
  // SQL 87: counts only, never the callers' names.
  other_callers: Object.freeze(['function_count', 'view_or_rule_count', 'policy_count', 'dependent_function_count', 'other_dependent_count', 'trigger_count', 'total']),
  // SQL 88: per-category counts and their total (never ids).
  cross_tenant_links: Object.freeze(['readable', 'total', 'categories', 'unreadable_categories']),
});

const pickFields = (value, fields) => (value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(fields.filter((field) => field in value).map((field) => [field, value[field]]))
  : value);

export const pickInspect = (details = {}) => Object.fromEntries(INSPECT_RECORD_KEYS
  .filter((key) => key in (details || {}))
  .map((key) => [key, INSPECT_RECORD_FIELDS[key] ? pickFields(details[key], INSPECT_RECORD_FIELDS[key]) : details[key]]));

/** An --inspect child's JSON as recorded: its status, plus only the picked inspect fields. */
export const inspectResultRecord = (json) => {
  if (!json || typeof json !== 'object') return json ?? null;
  const details = json.details && typeof json.details === 'object' ? json.details : {};
  return {
    ok: json.ok,
    code: json.code ?? null,
    message: json.message ?? null,
    details: {
      ...pickInspect(details),
      ...(details.state_error ? { state_error: details.state_error } : {}),
      ...(details.source_error ? { source_error: details.source_error } : {}),
    },
  };
};

const childFailure = (step, out, { inspect = false } = {}) => fail(out.json?.code || CODES.DEPLOYMENT_GUARD_REQUIRED, `${step} did not succeed`, {
  step,
  exit_status: out.status,
  result: inspect ? inspectResultRecord(out.json) : out.json,
  ...(out.json ? {} : { stderr_tail: out.stderr_tail }),
  ...(out.error ? { spawn_error: out.error } : {}),
});

/** Step 2 checks: everything the procedure says to proceed on. */
export function preApplyInspectFailures(details, pin, tool) {
  const d = details || {};
  return [
    ['read_only', d.read_only === true],
    ['migration', d.migration === tool.key],
    ['filename', d.filename === pin.filename],
    ['source_ok', d.source_ok === true],
    ['pin_execute', d.pin_execute === true],
    ['state_readable', !d.state_error],
    ['missing_dependencies', d.missing_dependencies === undefined || (Array.isArray(d.missing_dependencies) && d.missing_dependencies.length === 0)],
    ['predecessors_applied', d.predecessors_applied === undefined || d.predecessors_applied === true],
    ['expected_live_definition_sha256', d.expected_live_definition_sha256 === pin.expected_live_definition_sha256],
    ['intended_replacement_sha256', d.intended_replacement_sha256 === pin.intended_replacement_sha256],
    ['live_definition_sha256', typeof d.live_definition_sha256 === 'string' && d.live_definition_sha256 === pin.expected_live_definition_sha256],
    ['live_matches_expected', d.live_matches_expected === true],
    ['already_applied', d.already_applied === false],
    ['precondition_failures', Array.isArray(d.precondition_failures) && d.precondition_failures.length === 0],
    ['apply_preconditions_met', d.apply_preconditions_met === true],
    // Tool-specific ordering gates, e.g. SQL 29: sql90_applied must be false.
    ...(tool.inspect_requires || []).map(([field, value]) => [field, d[field] === value]),
  ].filter(([, passed]) => !passed).map(([name]) => name);
}

export function postApplyInspectFailures(details, pin, tool) {
  const d = details || {};
  return [
    ['read_only', d.read_only === true],
    ['migration', d.migration === tool.key],
    ['state_readable', !d.state_error],
    ['live_definition_sha256', d.live_definition_sha256 === pin.intended_replacement_sha256],
    ['already_applied', d.already_applied === true],
  ].filter(([, passed]) => !passed).map(([name]) => name);
}

/** TAP summary counts from node --test --test-reporter=tap. */
export function parseTapSummary(text) {
  const counts = {};
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    // The reporter's own summary is last; an earlier line could come from test output.
    const matches = [...String(text || '').matchAll(new RegExp(`^# ${key} (\\d+)\\s*$`, 'gm'))];
    counts[key] = matches.length ? Number(matches.at(-1)[1]) : null;
  }
  return counts;
}

/** Contracts the registry requires for a production sql-apply (the same set preflight enforces). */
export function requiredContracts(root, registry = loadContractRegistry(root)) {
  return relevantContracts(registry, { environment: 'production', component: ONE_SHOT_COMPONENT, deployment_type: ONE_SHOT_DEPLOYMENT_TYPE })
    .filter((row) => row.accepted === true);
}

function safeTestPath(root, rel) {
  const value = String(rel || '');
  if (!value || path.isAbsolute(value) || value.split(/[\\/]/).includes('..') || !/\.(?:mjs|js)$/.test(value)) return false;
  return fs.existsSync(path.join(root, value));
}

/** Step 3: run every required contract test on this tree; any failure stops. */
export function runContracts(ctx, { runnerLabel, runnerBasis, commit, runId }) {
  const contracts = requiredContracts(ctx.root, ctx.registry);
  if (!contracts.length) return fail(CODES.REGRESSION_DETECTED, 'no accepted contracts are registered for production sql-apply; refusing');
  const results = {};
  for (const contract of contracts) {
    if (!safeTestPath(ctx.root, contract.test)) {
      return fail(CODES.REGRESSION_DETECTED, `accepted contract ${contract.id} has no runnable test in this tree`, { contract_id: contract.id, test: contract.test });
    }
    const res = ctx.run({
      step: `contract:${contract.id}`,
      command: ctx.nodePath,
      args: ['--test', '--test-reporter=tap', contract.test],
      cwd: ctx.root,
      env: ctx.baseEnv,
      timeout: TIMEOUT_MS.contract,
    });
    const counts = parseTapSummary(res.stdout);
    const passed = res.status === 0
      && Number.isInteger(counts.tests) && counts.tests > 0
      && counts.pass === counts.tests
      && counts.fail === 0 && counts.cancelled === 0 && counts.skipped === 0 && counts.todo === 0;
    if (!passed) {
      return fail(CODES.REGRESSION_DETECTED, `accepted contract ${contract.id} failed on the runner`, {
        contract_id: contract.id,
        test: contract.test,
        exit_status: res.status,
        counts,
        output_tail: `${String(res.stdout || '').slice(-1500)}${String(res.stderr || '').slice(-1500)}`,
      });
    }
    results[contract.id] = {
      ok: true,
      test: contract.test,
      evidence: `${counts.pass}/${counts.tests} on ${runnerLabel} (${runnerBasis}) at ${commit} (production-sql-one-shot ${runId}, node --test)`,
    };
  }
  return ok({ contract_results: results });
}

// --- manifest -----------------------------------------------------------------

export function buildOneShotManifest({ args, pin, inspect, contractResults, oneUseId, buildTimestamp }) {
  const live = inspect.live_definition_sha256;
  return {
    workstream_id: args.workstream_id,
    branch: 'main',
    commit: args.commit,
    operator: args.operator,
    target_environment: 'production',
    target_component: ONE_SHOT_COMPONENT,
    deployment_type: ONE_SHOT_DEPLOYMENT_TYPE,
    owned_components: [pin.filename],
    filename: pin.filename,
    migration_id: pin.migration_id,
    source_sha256: pin.source_sha256,
    expected_live_definition_sha256: pin.expected_live_definition_sha256,
    intended_replacement_sha256: pin.intended_replacement_sha256,
    live_definition_sha256: live,
    preflight_live_fingerprint: { sql: live },
    production_fingerprint: { sql: live },
    immediately_before_fingerprint: { sql: live },
    staging_acceptance: pin.staging_acceptance,
    approval: {
      approved: true,
      workstream_id: args.workstream_id,
      approved_by: 'owner',
      statement: args.approval_statement,
    },
    authorization_phrase: pin.authorization_phrase,
    one_use_id: oneUseId,
    build_timestamp: buildTimestamp,
    contract_results: contractResults,
  };
}

// --- orchestration --------------------------------------------------------------

export const ONE_SHOT_EXCEPTION = 'ONE_SHOT_EXCEPTION';

/**
 * Runs the steps; an unexpected exception anywhere still returns one failure
 * summary (with the steps so far), so the caller always prints JSON.
 */
export async function runProductionSqlOneShot(opts = {}, ctxIn = {}) {
  const runId = ctxIn.runId || randomUUID();
  const steps = [];
  const summary = { ok: false, tool: 'production-sql-one-shot', run_id: runId, steps };
  try {
    return await runSteps(opts, ctxIn, steps, summary);
  } catch (error) {
    if (summary.manifest_file) summary.manifest_deleted = !fs.existsSync(path.dirname(summary.manifest_file));
    const last = steps.at(-1)?.step || 'arguments';
    const message = `unexpected exception after step ${last}: ${String(error?.message || error).slice(0, 300)}`;
    const details = {
      ...summary,
      ok: false,
      stopped_at: `${last} (exception)`,
      error: { code: ONE_SHOT_EXCEPTION, message, details: { stack: String(error?.stack || '').split('\n').slice(0, 6) } },
      ...(summary.apply_child_started ? { warning: 'The apply child was started. Its outcome is unknown: run the tool\'s read-only --inspect before anything else.' } : {}),
    };
    return { ok: false, code: ONE_SHOT_EXCEPTION, message, details, errors: [{ code: ONE_SHOT_EXCEPTION, message, details: {} }] };
  }
}

async function runSteps(opts, ctxIn, steps, summary) {
  const env = ctxIn.env || {};
  const now = ctxIn.now || (() => new Date());
  const runId = summary.run_id;
  const done = (result, extra = {}) => {
    const details = { ...summary, ...extra, ok: result.ok === true };
    if (!result.ok) {
      details.stopped_at = extra.stopped_at || steps.at(-1)?.step || 'arguments';
      details.error = { code: result.code, message: result.message, details: result.details };
    }
    return { ok: result.ok === true, code: result.code ?? null, message: result.message ?? null, details, errors: result.errors || [] };
  };
  const stop = (step, result) => { steps.push({ step, ok: false, code: result.code }); return done(result); };

  const parsed = validateOneShotArgs(opts, env, { execArgv: ctxIn.execArgv || [] });
  if (!parsed.ok) return stop('arguments', parsed);
  const args = parsed.details;
  const { tool } = args;
  const root = ctxIn.root;
  Object.assign(summary, {
    phase: args.phase,
    migration: tool.key,
    commit: args.commit,
    workstream_id: args.workstream_id,
    approval_statement: args.approval_statement,
    approval_scope: args.approval_scope,
    operator: args.operator,
  });
  const runnerLabel = args.runner || os.hostname();
  const runnerBasis = args.runner ? 'operator-supplied --runner (not verified by the one-shot)' : 'os.hostname() of the host that ran the one-shot';
  const ctx = {
    root,
    run: ctxIn.run,
    nodePath: ctxIn.nodePath || process.execPath,
    baseEnv: childBaseEnv(env),
    registry: ctxIn.registry,
  };

  // Pin: refuse before anything else when execute is not true.
  let pin;
  try {
    pin = ctxIn.pin || JSON.parse(fs.readFileSync(path.join(root, tool.pin_rel), 'utf8'));
  } catch (error) {
    return stop('pin', fail(CODES.INVALID_MANIFEST, 'production pin could not be read', { pin: tool.pin_rel, message: String(error?.message || error).slice(0, 200) }));
  }
  if (pin.execute !== true) {
    return stop('pin', fail(CODES.GUARD_APPLY_FORBIDDEN, `${tool.key} production pin has execute false; a run needs a reviewed pin change setting execute true`, { pin: tool.pin_rel }));
  }
  if (pin.staging_acceptance?.ok !== true || !pin.staging_acceptance?.reference || !pin.authorization_phrase) {
    return stop('pin', fail(CODES.PRODUCTION_APPROVAL_REQUIRED, 'production pin lacks a staging acceptance reference or authorization phrase', { pin: tool.pin_rel }));
  }
  steps.push({ step: 'pin', ok: true, pin: tool.pin_rel, execute: true, staging_acceptance: pin.staging_acceptance.reference });

  // 1. Source.
  const source = await verifySource({ root, commit: args.commit, tarball: args.source_tarball, expectedSha256: args.expected_tarball_sha256, pin, tool }, ctxIn);
  if (!source.ok) return stop('source', source);
  steps.push({ step: 'source', ok: true });
  summary.source = source.details;
  // The tree is re-compared to the tarball right before preflight and right before apply.
  // Against the index cached from the verified bytes; the tarball file is not trusted again.
  const recheckTree = async (step) => {
    const again = await (ctxIn.compareTreeToIndex || compareTreeToIndex)(root, source.index);
    if (!again.ok) return again;
    steps.push({ step, ok: true });
    return null;
  };

  // 2. Read-only inspect.
  const inspect = runTool(ctx, 'inspect', [tool.script, ...tool.args, '--inspect'], { env: ctx.baseEnv, timeout: TIMEOUT_MS.inspect });
  if (inspect.status !== 0 || inspect.json?.ok !== true) return stop('inspect', childFailure('inspect', inspect, { inspect: true }));
  const preFailures = preApplyInspectFailures(inspect.json.details, pin, tool);
  summary.pre_apply_inspect = pickInspect(inspect.json.details);
  if (preFailures.length) {
    return stop('inspect', fail(CODES.DEPLOYMENT_COLLISION, 'read-only inspect does not allow this apply; a different live state needs its own reviewed pin change', { failed: preFailures }));
  }
  steps.push({ step: 'inspect', ok: true });

  // 3. Contracts on this tree.
  const contracts = runContracts(ctx, { runnerLabel, runnerBasis, commit: args.commit, runId });
  if (!contracts.ok) return stop('contracts', contracts);
  steps.push({ step: 'contracts', ok: true, ids: Object.keys(contracts.details.contract_results) });
  summary.contract_results = contracts.details.contract_results;

  if (args.phase === 'inspect') {
    return done(ok(), { next:'Read-only phase complete; nothing was written. With the owner\'s approval of this run, re-run with --phase apply (it repeats every step).' });
  }

  // 4. Manifest (outside the tree, so the tree stays identical to the tarball).
  const oneUseId = `${tool.key}-prod-${randomUUID()}`;
  const manifest = buildOneShotManifest({
    args,
    pin,
    inspect: inspect.json.details,
    contractResults: contracts.details.contract_results,
    oneUseId,
    buildTimestamp: now().toISOString(),
  });
  const manifestDir = fs.mkdtempSync(path.join(ctxIn.tmpDir || os.tmpdir(), `production-sql-one-shot-${tool.key}-`));
  const manifestFile = path.join(manifestDir, `${tool.key}-manifest.json`);
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  steps.push({ step: 'manifest', ok: true, file: manifestFile });
  Object.assign(summary, {
    manifest_file: manifestFile,
    manifest_sha256: sha256(fs.readFileSync(manifestFile)),
    one_use_id: oneUseId,
  });
  let result;
  try {
    result = await applySteps();
  } finally {
    // The manifest only feeds the children of this run; nothing reads it afterwards.
    fs.rmSync(manifestDir, { recursive: true, force: true });
  }
  result.details.manifest_deleted = !fs.existsSync(manifestDir);
  return result;

  async function applySteps() {
    // 5. Preflight: lease + receipt. The receipt path is taken only from this child's output.
    const beforePreflight = await recheckTree('source-recheck-before-preflight');
    if (beforePreflight) return stop('source-recheck-before-preflight', beforePreflight);
    const preflight = runTool(ctx, 'preflight', [PREFLIGHT, '--acquire-lease', '--receipt', '--input', manifestFile], { env: ctx.baseEnv, timeout: TIMEOUT_MS.preflight });
    if (preflight.status !== 0 || preflight.json?.ok !== true) return stop('preflight', childFailure('preflight', preflight));
    const receiptFile = preflight.json.details?.receipt;
    if (typeof receiptFile !== 'string' || path.dirname(path.resolve(root, receiptFile)) !== receiptDir(root)) {
      return stop('preflight', fail(CODES.DEPLOYMENT_GUARD_REQUIRED, 'preflight did not issue a receipt under .deployment-guard/receipts', { receipt: receiptFile ?? null }));
    }
    steps.push({ step: 'preflight', ok: true, receipt_issued: true });
    Object.assign(summary, { receipt_issued: true, receipt_file: receiptFile });

    // 6. Evaluate (no connection).
    const evaluate = runTool(ctx, 'evaluate', [tool.script, ...tool.args, '--input', manifestFile], { env: ctx.baseEnv, timeout: TIMEOUT_MS.preflight });
    if (evaluate.status !== 0 || evaluate.json?.ok !== true || evaluate.json.details?.[tool.allowed_key] !== true || evaluate.json.details?.migration !== tool.key) {
      return stop('evaluate', evaluate.json?.ok === true
        ? fail(CODES.GUARD_APPLY_FORBIDDEN, `evaluate did not report ${tool.allowed_key} true`, { result: evaluate.json })
        : childFailure('evaluate', evaluate));
    }
    steps.push({ step: 'evaluate', ok: true, [tool.allowed_key]: true });

    // 7. Apply: the only child with the apply variables.
    const beforeApply = await recheckTree('source-recheck-before-apply');
    if (beforeApply) return stop('source-recheck-before-apply', beforeApply);
    const applyEnv = { ...ctx.baseEnv, CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1', CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT: receiptFile };
    summary.apply_child_started = true;
    const apply = runTool(ctx, 'apply', [tool.script, ...tool.args, '--apply', '--input', manifestFile], { env: applyEnv, timeout: TIMEOUT_MS.apply });
    const applyRecord = apply.json?.details?.receipt;
    const applyOk = apply.status === 0 && apply.json?.ok === true
      && applyRecord?.result === 'applied'
      && applyRecord?.before_hash === pin.expected_live_definition_sha256
      && applyRecord?.after_hash === pin.intended_replacement_sha256;

    // 8. Post-apply inspect: also after a failed apply (a COMMIT outcome can be unknown).
    const post = runTool(ctx, 'post-apply-inspect', [tool.script, ...tool.args, '--inspect'], { env: ctx.baseEnv, timeout: TIMEOUT_MS.inspect });
    const postFailures = post.status === 0 && post.json?.ok === true ? postApplyInspectFailures(post.json.details, pin, tool) : ['inspect_failed'];
    summary.post_apply_inspect = post.json?.ok === true ? pickInspect(post.json.details) : { error: post.json ? inspectResultRecord(post.json) : post.stderr_tail };

    if (!applyOk) {
      steps.push({ step: 'apply', ok: false, code: apply.json?.code || null });
      steps.push({ step: 'post-apply-inspect', ok: postFailures.length === 0, failed: postFailures });
      return done(apply.json?.ok === true
        ? fail(CODES.UNRELATED_MUTATION, 'apply reported success without the pinned before/after hashes', { result: apply.json })
        : childFailure('apply', apply), { stopped_at: 'apply' });
    }
    steps.push({ step: 'apply', ok: true, result: 'applied' });
    summary.apply_result = applyRecord;
    if (postFailures.length) {
      return stop('post-apply-inspect', fail(CODES.DEPLOYMENT_COLLISION, 'post-apply inspect does not show the intended state', { failed: postFailures, result: post.json ? inspectResultRecord(post.json) : post.stderr_tail }));
    }
    steps.push({ step: 'post-apply-inspect', ok: true });

    summary.applied = {
      date: now().toISOString().slice(0, 10),
      result: 'applied',
      source_commit: args.commit,
      source_commit_basis: 'SOURCE_COMMIT in the tarball (written by sql53-temporary-transfer) equals --commit, and the tarball sha256 equals --expected-tarball-sha256 as copied by the operator from that transfer run\'s log (TARBALL_SHA256 line); the run log itself was not read by the one-shot.',
      source_tarball: { file: source.details.tarball, sha256: source.details.tarball_sha256 },
      runner: runnerLabel,
      runner_basis: runnerBasis,
      workstream_id: args.workstream_id,
      one_use_id: oneUseId,
      one_use_id_consumed: true,
      one_use_id_consumed_basis: 'Inferred from the successful apply (the tool records the one_use_id after COMMIT and only warns if that write fails); the consumed-registry entry was not read back separately.',
      owner_approval: args.approval_statement,
      owner_approval_basis: `As passed in --approval-statement for --approval-scope ${args.approval_scope}; the one-shot cannot verify who said it.`,
      operator: args.operator,
      pre_apply_inspect: summary.pre_apply_inspect,
      contract_results: summary.contract_results,
      one_shot_run_id: runId,
      one_shot_note: 'One production-sql-one-shot run verified the source, ran the read-only inspect and the runner contracts, built the manifest, issued the receipt and lease (preflight), evaluated (' + tool.allowed_key + ' true), applied (exit 0) and ran the post-apply inspect.',
      receipt: applyRecord,
      post_apply_inspect: summary.post_apply_inspect,
    };
    summary.not_observed_by_this_run = [
      'ssm_command_id (add from SSM)',
      'source_staged_by (the sql53-temporary-transfer run id; add from GitHub Actions)',
    ];
    return done(ok());
  }
}
