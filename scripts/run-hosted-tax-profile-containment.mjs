#!/usr/bin/env node
/**
 * ONLY authorized way to run hosted recipient_tax_profiles preflight or apply.
 *
 * The database URL MUST come from CHECKSOPS_TAX_CONTAINMENT_DATABASE_URL.
 * Never pass the URL or password on the command line or in child argv.
 *
 * Modes:
 *   node scripts/run-hosted-tax-profile-containment.mjs preflight
 *   node scripts/run-hosted-tax-profile-containment.mjs apply \
 *     --i-authorize-hosted-recipient-tax-profiles-revoke \
 *     --confirm=REVOKE_POSTGREST_RECIPIENT_TAX_PROFILES
 *
 * Direct connections only: db.nbcqwpysqgyxrrbgtmkw.supabase.co:5432/postgres
 * with sslmode=verify-full and a reviewed system CA bundle
 * (/etc/ssl/certs/ca-certificates.crt). Pooler is not supported.
 * Production execution requires a root-owned distro psql with root-owned
 * non-writable parents. Root compromise is outside this wrapper's threat
 * boundary. Do not use supabase db push. Do not execute supabase/migrations.
 *
 * PostgreSQL does not expose the Supabase project ref. This wrapper proves
 * the connection target. SQL -v expected_project_ref is defense in depth.
 *
 * Exact-commit Git authorization does not replace human review of that commit.
 * Hosted execution remains unauthorized until a separate event and the
 * Tax/1099 error-banner PR. psql is spawned asynchronously so SIGINT/SIGTERM
 * can terminate the active child, unlink the 0600 passfile, and rmdir the
 * 0700 temp directory. SIGKILL/crash/power-loss cleanup is not guaranteed.
 * Relaxed psql trust exists only as a test-injected runCli({ psqlTrust })
 * harness and cannot be enabled by env or CLI flags.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const URL_ENV = 'CHECKSOPS_TAX_CONTAINMENT_DATABASE_URL';
const PSQL_PATH_ENV = 'CHECKSOPS_TAX_CONTAINMENT_PSQL';
const PSQL_SHA_ENV = 'CHECKSOPS_TAX_CONTAINMENT_PSQL_SHA256';
const GIT_SHA_ENV = 'CHECKSOPS_TAX_CONTAINMENT_GIT_SHA';
const AUTH_FLAG = '--i-authorize-hosted-recipient-tax-profiles-revoke';
const CONFIRM_PREFIX = '--confirm=';
export const APPLY_CONFIRM_PHRASE = 'REVOKE_POSTGREST_RECIPIENT_TAX_PROFILES';
export {
  URL_ENV,
  AUTH_FLAG,
  PSQL_PATH_ENV,
  PSQL_SHA_ENV,
  GIT_SHA_ENV,
};

export const PREFLIGHT_SENTINEL_PREFIX = 'CHECKSOPS_TAX_PREFLIGHT_V1';
export const APPLY_SENTINEL_PREFIX = 'CHECKSOPS_TAX_APPLY_V1';
export const REQUIRED_SSLMODE = 'verify-full';
export const SYSTEM_CA_BUNDLE = '/etc/ssl/certs/ca-certificates.crt';
export const REQUIRED_SSLROOTCERT = SYSTEM_CA_BUNDLE;
export const DIRECT_PORT = '5432';
export const EXEC_TIMEOUT_MS = 60_000;
export const VERSION_TIMEOUT_MS = 5_000;
export const CONNECT_TIMEOUT_SEC = '10';
export const PSQL_VERSION_RE = /^psql \(PostgreSQL\) (16|17|18)\./;
export const NONCE_RE = /^[0-9a-f]{64}$/;
export const GIT_SHA_RE = /^[0-9a-f]{40}$/;
export const PINS_REL = 'supabase/security/hosted-tax-profile-containment.pins.json';
export const PREFLIGHT_REL = 'supabase/security/preflight_gate_revoke_postgrest_tax_profiles.sql';
export const APPLY_REL = 'supabase/security/unapplied-do-not-run/NOT_APPLIED_revoke_postgrest_tax_profiles.sql';
export const PASSFILE_DIR_RE = /^checksops-tax-pg-[A-Za-z0-9]{6,12}$/;
export const STALE_PASSDIR_MIN_AGE_MS = 24 * 60 * 60 * 1000;
export const SPAWN_OUTPUT_LIMIT = 1_000_000;

export const PSQL_PRODUCTION_TRUST = Object.freeze({
  requireRootOwner: true,
  requireRootOwnedParents: true,
  allowStickyWorldWritableParents: false,
});

// Test-only. Pass via runCli({ psqlTrust }). Never read from env or argv.
export const TEST_PSQL_TRUST = Object.freeze({
  requireRootOwner: false,
  requireRootOwnedParents: false,
  allowStickyWorldWritableParents: true,
});

const REPO_FILE_TRUST = Object.freeze({
  requireRootOwner: false,
  requireRootOwnedParents: false,
  allowStickyWorldWritableParents: true,
});

const CA_FILE_TRUST = Object.freeze({
  requireRootOwner: true,
  requireRootOwnedParents: true,
  allowStickyWorldWritableParents: false,
});

const PINS_TOP_KEYS = [
  'expected_project_ref', 'forbidden_project_ref', 'expected_database',
  'expected_owner', 'files', 'historical_migrations',
];
const FILE_SPEC_KEYS = ['path', 'sha256'];
const HIST_KEYS = ['basename', 'sha256', 'review'];
const SECURITY_PACKAGE_EXACT = new Set([
  'scripts/run-hosted-tax-profile-containment.mjs',
  'scripts/check-recipient-tax-profile-migrations.mjs',
  'scripts/recipient-tax-profile-migration-allowlist.txt',
]);

const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const FORBIDDEN_CHILD_ENV = [
  'PGHOST', 'PGHOSTADDR', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD',
  'PGPASSFILE', 'PGSERVICE', 'PGSERVICEFILE', 'PGOPTIONS', 'PGAPPNAME',
  'PGSSLMODE', 'PGSSLROOTCERT', 'PGSSLCERT', 'PGSSLKEY', 'PGSSLCRL',
  'PGREQUIRESSL', 'PGSSLCOMPRESSION', 'PGCHANNELBINDING', 'PGGSSENCMODE',
  'PGKRBSRVNAME', 'PGCONNECT_TIMEOUT', 'PGREQUIREPEER', 'PGSSLPASSWORD',
  'PGSSLSNI', 'PGSSLNEGOTIATION', 'PGTARGETSESSIONATTRS', 'PGREALM',
  'PGDATA', 'PGDATABASEURL', 'DATABASE_URL', 'PSQLRC', 'PSQL_EDITOR',
  'PGSYSCONFDIR', 'PGLOCALEDIR',
];

export function sha256Bytes(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function sanitizedError(message) {
  const err = new Error(message);
  err.sanitized = true;
  return err;
}

export function sanitizeText(text, secrets = []) {
  let out = String(text || '');
  for (const secret of secrets) {
    if (secret) out = out.split(String(secret)).join('[redacted]');
  }
  out = out.replace(/postgresql:\/\/[^\s'"]+/gi, '[redacted-connection]');
  out = out.replace(/postgres:\/\/[^\s'"]+/gi, '[redacted-connection]');
  out = out.replace(/:[^/@\s]{4,}@/g, ':[redacted]@');
  return out;
}

export function escapePgPassField(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll(':', '\\:');
}

function isIpHostname(host) {
  if (!host) return true;
  if (host === 'localhost' || host === '::1' || host === '[::1]') return true;
  if (IPV4_RE.test(host)) return true;
  if (host.includes(':')) return true;
  return false;
}

function exactKeys(obj, allowed) {
  const keys = Object.keys(obj).sort();
  const expect = [...allowed].sort();
  if (keys.length !== expect.length || keys.some((k, i) => k !== expect[i])) {
    throw sanitizedError('pins schema has missing or extra keys');
  }
}

function isHexSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function inSecurityPackage(rel) {
  const n = String(rel).replaceAll('\\', '/');
  if (SECURITY_PACKAGE_EXACT.has(n)) return true;
  return n === PINS_REL || n.startsWith('supabase/security/');
}

export function validatePinsObject(pins) {
  if (!pins || typeof pins !== 'object' || Array.isArray(pins)) {
    throw sanitizedError('pins file is not a JSON object');
  }
  exactKeys(pins, PINS_TOP_KEYS);
  if (!/^[a-z0-9]{20}$/.test(pins.expected_project_ref) || !/^[a-z0-9]{20}$/.test(pins.forbidden_project_ref)) {
    throw sanitizedError('pins project refs are invalid');
  }
  if (pins.expected_database !== 'postgres' || pins.expected_owner !== 'postgres') {
    throw sanitizedError('pins database/owner are invalid');
  }
  if (!pins.files || typeof pins.files !== 'object' || Array.isArray(pins.files)) {
    throw sanitizedError('pins files map is invalid');
  }
  exactKeys(pins.files, ['preflight', 'apply']);
  const seenPaths = new Set();
  for (const key of ['preflight', 'apply']) {
    const spec = pins.files[key];
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
      throw sanitizedError(`pins ${key} spec is invalid`);
    }
    exactKeys(spec, FILE_SPEC_KEYS);
    if (!isHexSha256(spec.sha256)) {
      throw sanitizedError(`pins ${key} hash is invalid`);
    }
    if (typeof spec.path !== 'string' || spec.path.startsWith('/') || spec.path.includes('..') || path.normalize(spec.path) !== spec.path) {
      throw sanitizedError(`pins ${key} path is invalid`);
    }
    if (spec.path.includes('supabase/migrations')) {
      throw sanitizedError('pinned SQL must not live under supabase/migrations');
    }
    if (seenPaths.has(spec.path)) {
      throw sanitizedError('pins contain duplicate paths');
    }
    seenPaths.add(spec.path);
  }
  if (pins.files.preflight.path !== PREFLIGHT_REL) {
    throw sanitizedError('pinned preflight path is not the reviewed preflight file');
  }
  if (pins.files.apply.path !== APPLY_REL) {
    throw sanitizedError('pinned apply path is not the reviewed NOT_APPLIED_revoke_postgrest_tax_profiles.sql file');
  }
  if (!Array.isArray(pins.historical_migrations)) {
    throw sanitizedError('pins historical_migrations must be an array');
  }
  const seenHist = new Set();
  for (const row of pins.historical_migrations) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw sanitizedError('pins historical entry is invalid');
    }
    exactKeys(row, HIST_KEYS);
    if (!isHexSha256(row.sha256)) {
      throw sanitizedError('pins historical hash is invalid');
    }
    if (typeof row.basename !== 'string' || row.basename.includes('/') || row.basename.includes('..')
        || !/^[0-9]{14}_[A-Za-z0-9._-]+\.sql$/.test(row.basename)) {
      throw sanitizedError('pins historical basename is invalid');
    }
    if (typeof row.review !== 'string' || row.review.trim().length < 20) {
      throw sanitizedError('pins historical review metadata is invalid');
    }
    if (seenHist.has(row.basename)) {
      throw sanitizedError('pins contain duplicate historical basenames');
    }
    seenHist.add(row.basename);
  }
  return pins;
}

function assertSafeParents(absPath, trust) {
  let dir = path.dirname(absPath);
  const seen = new Set();
  while (!seen.has(dir)) {
    seen.add(dir);
    let st;
    try {
      st = fs.lstatSync(dir);
    } catch {
      throw sanitizedError('parent directory is missing');
    }
    if (st.isSymbolicLink()) {
      throw sanitizedError('parent directory must not be a symlink');
    }
    if (trust.requireRootOwnedParents && st.uid !== 0) {
      throw sanitizedError('parent directory must be root-owned');
    }
    const worldOrGroupWrite = (st.mode & 0o022) !== 0;
    const sticky = (st.mode & 0o1000) !== 0;
    if (worldOrGroupWrite) {
      if (!trust.allowStickyWorldWritableParents || !sticky) {
        throw sanitizedError('parent directory is group or world writable');
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

function snapshotIdentity(st, digest) {
  return Object.freeze({
    dev: st.dev,
    ino: st.ino,
    uid: st.uid,
    gid: st.gid,
    mode: st.mode,
    size: st.size,
    mtimeMs: st.mtimeMs,
    ctimeMs: st.ctimeMs,
    digest,
  });
}

export function identitiesMatch(a, b) {
  return a && b
    && a.dev === b.dev
    && a.ino === b.ino
    && a.uid === b.uid
    && a.gid === b.gid
    && a.mode === b.mode
    && a.size === b.size
    && a.mtimeMs === b.mtimeMs
    && a.ctimeMs === b.ctimeMs
    && a.digest === b.digest;
}

export function readTrustedFile(filePath, {
  executable = false,
  trust = REPO_FILE_TRUST,
  keepFd = false,
} = {}) {
  if (!path.isAbsolute(filePath)) {
    throw sanitizedError('path must be absolute');
  }
  const resolved = path.resolve(filePath);
  if (resolved !== filePath) {
    throw sanitizedError('path must be already absolute and normalized');
  }
  let lst;
  try {
    lst = fs.lstatSync(filePath);
  } catch {
    throw sanitizedError('required file is missing');
  }
  if (lst.isSymbolicLink()) {
    throw sanitizedError('symlinks are rejected');
  }
  if (!lst.isFile()) {
    throw sanitizedError('path must be a regular file');
  }
  const real = fs.realpathSync(filePath);
  if (real !== filePath) {
    throw sanitizedError('path must not contain symlink components');
  }
  if ((lst.mode & 0o022) !== 0) {
    throw sanitizedError('file is group or world writable');
  }
  if (executable && (lst.mode & 0o111) === 0) {
    throw sanitizedError('file is not executable');
  }
  const uid = process.getuid();
  if (trust.requireRootOwner) {
    if (lst.uid !== 0) {
      throw sanitizedError('file owner is not root');
    }
  } else if (lst.uid !== 0 && lst.uid !== uid) {
    throw sanitizedError('file owner is not trusted');
  }
  assertSafeParents(filePath, trust);
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.ino !== lst.ino || st.dev !== lst.dev) {
      throw sanitizedError('file identity changed during open');
    }
    const bytes = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = fs.readSync(fd, bytes, off, st.size - off, off);
      if (n <= 0) break;
      off += n;
    }
    if (off !== st.size) {
      throw sanitizedError('short read of trusted file');
    }
    const digest = sha256Bytes(bytes);
    const identity = snapshotIdentity(st, digest);
    if (keepFd) {
      return { bytes, digest, stat: st, identity, fd, path: filePath };
    }
    return { bytes, digest, stat: st, identity, fd: null, path: filePath };
  } catch (err) {
    fs.closeSync(fd);
    throw err;
  } finally {
    if (!keepFd) {
      try { fs.closeSync(fd); } catch { /* already closed on error path */ }
    }
  }
}

export function loadPins(repoRoot = ROOT) {
  const pinsPath = path.join(path.resolve(repoRoot), PINS_REL);
  const trusted = readTrustedFile(pinsPath, { trust: REPO_FILE_TRUST });
  let parsed;
  try {
    parsed = JSON.parse(trusted.bytes.toString('utf8'));
  } catch {
    throw sanitizedError('pins file is not valid JSON');
  }
  return validatePinsObject(parsed);
}

export function verifyPinnedSqlFiles(repoRoot = ROOT, pins = loadPins(repoRoot)) {
  validatePinsObject(pins);
  const out = {};
  for (const key of ['preflight', 'apply']) {
    const spec = pins.files[key];
    const full = path.join(path.resolve(repoRoot), spec.path);
    const trusted = readTrustedFile(full, { trust: REPO_FILE_TRUST });
    if (trusted.digest !== spec.sha256) {
      throw sanitizedError(`pinned ${key} SQL SHA-256 mismatch`);
    }
    out[key] = { ...spec, bytes: trusted.bytes, full };
  }
  return out;
}

export function validateConnectionUrl(rawUrl, pins = loadPins()) {
  validatePinsObject(pins);
  if (rawUrl == null || String(rawUrl).trim() === '') {
    throw sanitizedError(`${URL_ENV} is required`);
  }
  const original = String(rawUrl);
  if (/[\u0000-\u001f\u007f]/.test(original)) {
    throw sanitizedError('connection URL contains control characters');
  }
  if (original.includes('#')) {
    throw sanitizedError('connection URL must not contain a fragment');
  }
  let parsed;
  try {
    parsed = new URL(original);
  } catch {
    throw sanitizedError('connection URL is not a valid URI');
  }
  const protocol = parsed.protocol.replace(/:$/, '').toLowerCase();
  if (protocol !== 'postgres' && protocol !== 'postgresql') {
    throw sanitizedError('connection URL protocol must be postgresql');
  }
  if (parsed.search !== '?sslmode=verify-full') {
    throw sanitizedError('connection URL must have exactly sslmode=verify-full and no other query parameters');
  }
  const sslValues = parsed.searchParams.getAll('sslmode');
  if (sslValues.length !== 1 || sslValues[0] !== REQUIRED_SSLMODE) {
    throw sanitizedError('connection URL TLS must be exactly verify-full');
  }
  for (const key of parsed.searchParams.keys()) {
    if (key !== 'sslmode') {
      throw sanitizedError('connection URL has a forbidden query parameter');
    }
  }

  const host = (parsed.hostname || '').toLowerCase();
  const database = decodeURIComponent((parsed.pathname || '/').replace(/^\//, ''));
  const username = decodeURIComponent(parsed.username || '');
  const password = decodeURIComponent(parsed.password || '');
  const expectedRef = pins.expected_project_ref;
  const forbiddenRef = pins.forbidden_project_ref;
  const directHost = `db.${expectedRef}.supabase.co`;

  if (!parsed.port || parsed.port !== DIRECT_PORT) {
    throw sanitizedError('direct connection port must be 5432');
  }
  if (!password) {
    throw sanitizedError('connection password is required');
  }
  if (/[\u0000-\u001f\u007f]/.test(password)) {
    throw sanitizedError('connection password contains invalid characters');
  }
  if (!database || database !== pins.expected_database) {
    throw sanitizedError('connection database name is not postgres');
  }
  if (parsed.pathname !== '/postgres') {
    throw sanitizedError('connection database path is invalid');
  }
  if (isIpHostname(host)) {
    throw sanitizedError('connection host must not be localhost or an IP literal');
  }
  if (host.includes(forbiddenRef) || username.includes(forbiddenRef)) {
    throw sanitizedError('connection targets the unused Supabase project');
  }
  if (host !== directHost) {
    throw sanitizedError('connection host is not the production Supabase direct hostname');
  }
  if (username !== 'postgres') {
    throw sanitizedError('direct connection username shape is invalid');
  }
  if (parsed.username !== 'postgres') {
    throw sanitizedError('direct connection username encoding is invalid');
  }

  const fingerprint = ['direct', host, DIRECT_PORT, 'postgres', database, REQUIRED_SSLMODE].join('|');
  const conn = {
    kind: 'direct',
    host,
    port: DIRECT_PORT,
    database,
    user: 'postgres',
    sslmode: REQUIRED_SSLMODE,
    sslrootcert: REQUIRED_SSLROOTCERT,
    fingerprint,
    expectedProjectRef: expectedRef,
    expectedDatabase: pins.expected_database,
    expectedOwner: pins.expected_owner,
  };
  Object.defineProperty(conn, 'password', {
    value: password,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return Object.freeze(conn);
}

export function parseCliArgs(argv) {
  const args = [...argv];
  let mode = 'preflight';
  let authorized = false;
  let confirm = '';
  if (args.length === 0) {
    return { mode, authorized, confirm };
  }
  const first = args.shift();
  if (first === 'preflight' || first === 'apply') {
    mode = first;
  } else {
    throw sanitizedError('mode must be preflight or apply');
  }
  for (const arg of args) {
    if (arg === AUTH_FLAG) {
      authorized = true;
      continue;
    }
    if (arg.startsWith(CONFIRM_PREFIX)) {
      confirm = arg.slice(CONFIRM_PREFIX.length);
      continue;
    }
    throw sanitizedError('unrecognized flag');
  }
  return { mode, authorized, confirm };
}

export function parseExactSentinel(stdout, prefix, nonce, allowedResults) {
  const raw = String(stdout || '');
  if (raw.includes('\r')) {
    throw sanitizedError('preflight stdout contains carriage returns');
  }
  const lines = raw.split('\n').filter((line) => line.length > 0);
  if (lines.length !== 1) {
    throw sanitizedError('expected exactly one sentinel stdout line');
  }
  const allowed = new Set(allowedResults);
  for (const result of allowed) {
    const expected = `${prefix}|${nonce}|${result}`;
    if (lines[0] === expected) {
      return result;
    }
  }
  throw sanitizedError('sentinel line did not match nonce and allowed results');
}

export function buildChildEnv(conn, passfile) {
  const allowed = {
    LC_ALL: 'C',
    LANG: 'C',
    PATH: '',
    PGHOST: conn.host,
    PGPORT: conn.port,
    PGDATABASE: conn.database,
    PGUSER: conn.user,
    PGSSLMODE: REQUIRED_SSLMODE,
    PGSSLROOTCERT: REQUIRED_SSLROOTCERT,
    PGPASSFILE: passfile,
    PGCONNECT_TIMEOUT: CONNECT_TIMEOUT_SEC,
    PGCLIENTENCODING: 'UTF8',
  };
  for (const key of FORBIDDEN_CHILD_ENV) {
    if (Object.hasOwn(allowed, key) && (
      key === 'PGHOST' || key === 'PGPORT' || key === 'PGDATABASE' || key === 'PGUSER'
      || key === 'PGSSLMODE' || key === 'PGSSLROOTCERT' || key === 'PGPASSFILE'
      || key === 'PGCONNECT_TIMEOUT'
    )) {
      continue;
    }
    if (Object.hasOwn(allowed, key)) {
      throw sanitizedError('child environment contains a forbidden PostgreSQL variable');
    }
  }
  return allowed;
}

export function verifyTrustedCaBundle(caPath = SYSTEM_CA_BUNDLE) {
  if (caPath !== SYSTEM_CA_BUNDLE) {
    throw sanitizedError('TLS CA bundle path is not the reviewed system store');
  }
  readTrustedFile(caPath, { trust: CA_FILE_TRUST });
  return caPath;
}

function defaultGitRun(repoRoot, gitArgs) {
  return spawnSync('git', ['-C', repoRoot, ...gitArgs], {
    encoding: 'utf8',
    timeout: 5_000,
    env: { PATH: '/usr/bin:/bin', LANG: 'C' },
    shell: false,
  });
}

export function verifyRepoState(repoRoot, expectedSha, gitRun = defaultGitRun) {
  if (!GIT_SHA_RE.test(String(expectedSha || ''))) {
    throw sanitizedError(`${GIT_SHA_ENV} must be the full 40-character commit SHA`);
  }
  const root = path.resolve(repoRoot);
  const inside = gitRun(root, ['rev-parse', '--is-inside-work-tree']);
  if (inside.status !== 0 || String(inside.stdout || '').trim() !== 'true') {
    throw sanitizedError('repository root is unrecognized');
  }
  const toplevel = gitRun(root, ['rev-parse', '--show-toplevel']);
  if (toplevel.status !== 0) {
    throw sanitizedError('repository root is unrecognized');
  }
  const shown = path.resolve(String(toplevel.stdout || '').trim());
  if (shown !== root) {
    throw sanitizedError('repository root does not match the wrapper checkout');
  }
  const symbolic = gitRun(root, ['symbolic-ref', '-q', 'HEAD']);
  if (symbolic.status !== 0) {
    throw sanitizedError('detached HEAD is refused');
  }
  const head = gitRun(root, ['rev-parse', 'HEAD']);
  if (head.status !== 0) {
    throw sanitizedError('HEAD cannot be resolved');
  }
  const actual = String(head.stdout || '').trim().toLowerCase();
  if (actual !== expectedSha) {
    throw sanitizedError('HEAD does not match the authorized commit SHA');
  }
  const status = gitRun(root, ['status', '--porcelain=v1', '-uall']);
  if (status.status !== 0) {
    throw sanitizedError('git status failed');
  }
  const lines = String(status.stdout || '').split('\n').filter((line) => line.length > 0);
  for (const line of lines) {
    const code = line.slice(0, 2);
    const rel = line.slice(3).split(' -> ').pop();
    if (code === '??') {
      if (inSecurityPackage(rel)) {
        throw sanitizedError('untracked files are present in the security package');
      }
      continue;
    }
    throw sanitizedError('git worktree has dirty or staged tracked files');
  }
  return actual;
}

function closeKeptFd(handle) {
  if (handle && handle.fd != null) {
    try { fs.closeSync(handle.fd); } catch { /* ignore */ }
    handle.fd = null;
  }
}

export function revalidatePsqlHandle(handle, trust) {
  if (!handle || !handle.path || !handle.identity) {
    throw sanitizedError('psql identity is missing');
  }
  const again = readTrustedFile(handle.path, { executable: true, trust, keepFd: false });
  if (!identitiesMatch(handle.identity, again.identity)) {
    throw sanitizedError('psql identity changed after validation');
  }
  if (handle.fd != null) {
    const st = fs.fstatSync(handle.fd);
    if (st.ino !== handle.identity.ino || st.dev !== handle.identity.dev || st.size !== handle.identity.size
        || st.uid !== handle.identity.uid || st.mode !== handle.identity.mode) {
      throw sanitizedError('psql opened inode changed after validation');
    }
  }
  return again;
}

function productionExecPath(handle) {
  // Linux: exec the already-opened inode via /proc/self/fd/N. Node cannot
  // fexecve. The fd is CLOEXEC, so argv0 MUST be the reviewed absolute path
  // or psql prints "invalid binary /proc/self/fd/N" on stderr and the
  // empty-stderr protocol fail-closes. Combined with root-owned non-writable
  // parents and re-stat immediately before spawn.
  if (process.platform === 'linux' && handle && handle.fd != null) {
    return `/proc/self/fd/${handle.fd}`;
  }
  return handle.path;
}

export function usesVerifiedFdExec(spawnImpl, handle) {
  return spawnImpl === defaultAsyncSpawn
    && process.platform === 'linux'
    && handle
    && handle.fd != null;
}

export function defaultAsyncSpawn(bin, args, opts = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let child;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    try {
      child = spawn(bin, args, {
        env: opts.env,
        argv0: opts.argv0,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish({ status: null, signal: null, error, stdout: '', stderr: '' });
      return;
    }
    if (typeof opts.onChild === 'function') {
      try { opts.onChild(child); } catch { /* still wait for close */ }
    }
    const timer = opts.timeout
      ? setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
      }, opts.timeout)
      : null;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const append = (kind, chunk) => {
      if (kind === 'stdout') stdout += chunk;
      else stderr += chunk;
      if (stdout.length + stderr.length > SPAWN_OUTPUT_LIMIT) {
        timedOut = true;
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
      }
    };
    child.stdout.on('data', (chunk) => append('stdout', chunk));
    child.stderr.on('data', (chunk) => append('stderr', chunk));
    child.on('error', (error) => {
      finish({ status: null, signal: null, error, stdout, stderr });
    });
    child.on('close', (status, signal) => {
      finish({
        status,
        signal,
        error: timedOut ? Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) : null,
        stdout,
        stderr,
      });
    });
    try {
      if (opts.input != null) child.stdin.write(opts.input);
      child.stdin.end();
    } catch {
      // stdin may already be closed
    }
  });
}

export async function invokeSpawn(spawnImpl, bin, args, opts = {}) {
  const result = spawnImpl(bin, args, opts);
  if (result && typeof result.then === 'function') return result;
  return result;
}

export async function verifyPsqlBinary(env, spawnImpl = defaultAsyncSpawn, {
  trust = PSQL_PRODUCTION_TRUST,
  useFdExec,
  onChild,
} = {}) {
  const rawPath = env[PSQL_PATH_ENV];
  if (!rawPath) {
    throw sanitizedError(`${PSQL_PATH_ENV} must be an absolute psql path`);
  }
  if (!path.isAbsolute(rawPath) || rawPath !== path.resolve(rawPath)) {
    throw sanitizedError('psql path must be absolute and normalized');
  }
  const expectedSha = String(env[PSQL_SHA_ENV] || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expectedSha)) {
    throw sanitizedError(`${PSQL_SHA_ENV} must be the SHA-256 of the psql binary`);
  }
  const trusted = readTrustedFile(rawPath, { executable: true, trust, keepFd: true });
  if (trusted.digest !== expectedSha) {
    closeKeptFd(trusted);
    throw sanitizedError('psql SHA-256 mismatch');
  }
  const handle = {
    path: rawPath,
    fd: trusted.fd,
    identity: trusted.identity,
    trust,
  };
  try {
    revalidatePsqlHandle(handle, trust);
    const fdExec = useFdExec === undefined ? usesVerifiedFdExec(spawnImpl, handle) : useFdExec;
    const execBin = fdExec ? productionExecPath(handle) : rawPath;
    const probe = await invokeSpawn(spawnImpl, execBin, ['--version'], {
      encoding: 'utf8',
      timeout: VERSION_TIMEOUT_MS,
      env: { LC_ALL: 'C', LANG: 'C', PATH: '' },
      input: Buffer.alloc(0),
      shell: false,
      argv0: rawPath,
      onChild,
    });
    if (probe.error) {
      throw sanitizedError(probe.error.code === 'ETIMEDOUT' ? 'psql version probe timed out' : 'psql version probe failed');
    }
    if (probe.signal) {
      throw sanitizedError('psql version probe was signaled');
    }
    if (probe.status !== 0) {
      throw sanitizedError('psql version probe failed');
    }
    const version = String(probe.stdout || '').trim().split('\n')[0] || '';
    if (PSQL_VERSION_RE.test(version) === false) {
      throw sanitizedError('psql version is not an approved PostgreSQL 16+ client');
    }
    if (String(probe.stderr || '').trim() !== '') {
      throw sanitizedError('psql version probe produced unexpected stderr');
    }
    return handle;
  } catch (err) {
    closeKeptFd(handle);
    throw err;
  }
}

function createPassfile(conn) {
  const tmpRoot = os.tmpdir();
  const home = os.homedir();
  if (!tmpRoot || tmpRoot === '/' || tmpRoot === home || tmpRoot.startsWith(`${home}${path.sep}`)) {
    throw sanitizedError('temporary directory is not usable for credentials');
  }
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'checksops-tax-pg-'));
  if (dir === home || dir.startsWith(`${home}${path.sep}`) || dir.includes('~')) {
    try { fs.rmdirSync(dir); } catch { /* ignore */ }
    throw sanitizedError('credential directory must not use HOME');
  }
  fs.chmodSync(dir, 0o700);
  const passPath = path.join(dir, 'pgpass');
  const line = [
    escapePgPassField(conn.host),
    escapePgPassField(conn.port),
    escapePgPassField(conn.database),
    escapePgPassField(conn.user),
    escapePgPassField(conn.password),
  ].join(':');
  const fd = fs.openSync(passPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.writeSync(fd, `${line}\n`);
    fs.fchmodSync(fd, 0o600);
  } finally {
    fs.closeSync(fd);
  }
  return { dir, passPath };
}

export function removePassfile(handle) {
  if (!handle) return;
  try {
    if (handle.passPath) {
      const lst = fs.lstatSync(handle.passPath);
      if (!lst.isSymbolicLink() && lst.isFile()) fs.unlinkSync(handle.passPath);
    }
  } catch {
    // still try rmdir
  }
  try {
    if (handle.dir) fs.rmdirSync(handle.dir);
  } catch {
    // do not recursively delete unexpected contents
  }
}

export function cleanupStalePassDirs({
  tmpRoot = os.tmpdir(),
  uid = process.getuid(),
  nowMs = Date.now(),
  minAgeMs = STALE_PASSDIR_MIN_AGE_MS,
} = {}) {
  const removed = [];
  const skipped = [];
  let names;
  try {
    names = fs.readdirSync(tmpRoot);
  } catch {
    return { removed, skipped };
  }
  for (const name of names) {
    if (!PASSFILE_DIR_RE.test(name)) continue;
    const dir = path.join(tmpRoot, name);
    const skip = (reason) => { skipped.push({ name, reason }); };
    let dirSt;
    try {
      dirSt = fs.lstatSync(dir);
    } catch {
      skip('missing');
      continue;
    }
    if (dirSt.isSymbolicLink() || !dirSt.isDirectory()) {
      skip('not a directory');
      continue;
    }
    let real;
    try {
      real = fs.realpathSync(dir);
    } catch {
      skip('unresolved');
      continue;
    }
    if (real !== path.resolve(dir)) {
      skip('symlink path');
      continue;
    }
    if (dirSt.uid !== uid) {
      skip('owner');
      continue;
    }
    if ((dirSt.mode & 0o777) !== 0o700) {
      skip('mode');
      continue;
    }
    if ((nowMs - dirSt.mtimeMs) < minAgeMs) {
      skip('recent');
      continue;
    }
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      skip('unreadable');
      continue;
    }
    if (entries.length !== 1 || entries[0] !== 'pgpass') {
      skip('unexpected contents');
      continue;
    }
    const passPath = path.join(dir, 'pgpass');
    let passSt;
    try {
      passSt = fs.lstatSync(passPath);
    } catch {
      skip('passfile missing');
      continue;
    }
    if (passSt.isSymbolicLink() || !passSt.isFile()) {
      skip('passfile type');
      continue;
    }
    if (passSt.uid !== uid || (passSt.mode & 0o777) !== 0o600) {
      skip('passfile owner or mode');
      continue;
    }
    try {
      fs.unlinkSync(passPath);
      fs.rmdirSync(dir);
      removed.push(name);
    } catch {
      skip('delete failed');
    }
  }
  return { removed, skipped };
}

function psqlArgs(pins, nonceName, nonce) {
  return [
    '-X',
    '-w',
    '-q',
    '-t',
    '-A',
    '-v', 'ON_ERROR_STOP=1',
    '-v', `expected_project_ref=${pins.expected_project_ref}`,
    '-v', `expected_database=${pins.expected_database}`,
    '-v', `expected_owner=${pins.expected_owner}`,
    '-v', `${nonceName}=${nonce}`,
  ];
}

function assertSafeChildArgs(args, conn, passPath) {
  const joined = args.join('\u0000');
  if (joined.includes(conn.password) || (passPath && joined.includes(passPath))) {
    throw sanitizedError('child argv leaked a secret');
  }
  if (args.includes('-d') || args.includes('-f') || args.includes('--file')) {
    throw sanitizedError('psql must not receive a URI, -d, or -f path');
  }
  for (const arg of args) {
    if (/^postgres(ql)?:\/\//i.test(arg)) {
      throw sanitizedError('psql must not receive a URI argument');
    }
  }
}

async function runPsqlStdin({
  spawnImpl,
  psqlHandle,
  conn,
  passPath,
  pins,
  sqlBytes,
  nonceName,
  nonce,
  timeout = EXEC_TIMEOUT_MS,
  useFdExec,
  onChild,
}) {
  revalidatePsqlHandle(psqlHandle, psqlHandle.trust);
  const args = psqlArgs(pins, nonceName, nonce);
  assertSafeChildArgs(args, conn, passPath);
  const fdExec = useFdExec && psqlHandle.fd != null;
  const execBin = fdExec ? productionExecPath(psqlHandle) : psqlHandle.path;
  if (execBin !== psqlHandle.path && !String(execBin).startsWith('/proc/self/fd/')) {
    throw sanitizedError('psql executable path is invalid');
  }
  const result = await invokeSpawn(spawnImpl, execBin, args, {
    encoding: 'utf8',
    timeout,
    env: buildChildEnv(conn, passPath),
    input: sqlBytes,
    shell: false,
    argv0: psqlHandle.path,
    onChild,
  });
  const secrets = [conn.password, passPath, execBin];
  return {
    status: result.status,
    signal: result.signal,
    error: result.error,
    stdout: sanitizeText(result.stdout, secrets),
    stderr: sanitizeText(result.stderr, secrets),
    rawArgs: args,
    execBin,
    argv0: psqlHandle.path,
  };
}

function failClosedFromSpawn(result, label) {
  if (result.error && result.error.code === 'ETIMEDOUT') {
    throw sanitizedError(`${label} timed out`);
  }
  if (result.error) {
    throw sanitizedError(`${label} failed to start`);
  }
  if (result.signal) {
    throw sanitizedError(`${label} was signaled`);
  }
  if (result.status !== 0) {
    throw sanitizedError(`${label} failed closed`);
  }
}

export function handleExecutionSignal(state) {
  if (!state || state.exiting) return;
  state.exiting = true;
  try {
    if (typeof state.killChild === 'function') state.killChild();
  } catch {
    // still clean credentials
  }
  removePassfile(state.passHandle);
  state.passHandle = null;
  if (typeof state.exit === 'function') {
    state.exit(1);
  }
}

function defaultInstallSignals(handler) {
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
  return () => {
    process.removeListener('SIGINT', handler);
    process.removeListener('SIGTERM', handler);
  };
}

export async function runCli({
  argv = process.argv.slice(2),
  env = process.env,
  spawnImpl = defaultAsyncSpawn,
  repoRoot = ROOT,
  stdout = process.stdout,
  stderr = process.stderr,
  randomNonce = () => randomBytes(32).toString('hex'),
  psqlTrust = PSQL_PRODUCTION_TRUST,
  gitRun,
  installSignals = defaultInstallSignals,
  exitImpl,
  nowMs = Date.now(),
  staleMinAgeMs = STALE_PASSDIR_MIN_AGE_MS,
} = {}) {
  const writeOut = (msg) => stdout.write(`${msg}\n`);
  const writeErr = (msg) => stderr.write(`${msg}\n`);
  const useFdExec = spawnImpl === defaultAsyncSpawn && process.platform === 'linux';
  const state = {
    passHandle: null,
    psqlHandle: null,
    child: null,
    killChild: null,
    exiting: false,
    exit: exitImpl || ((code) => {
      process.exitCode = code;
      process.exit(code);
    }),
  };
  state.killChild = () => {
    const child = state.child;
    if (!child || child.killed) return;
    if (child.exitCode != null || child.signalCode != null) return;
    try { child.kill('SIGTERM'); } catch { /* still clean credentials */ }
  };
  const uninstallSignals = installSignals(() => {
    handleExecutionSignal(state);
  });
  try {
    const expectedSha = env[GIT_SHA_ENV];
    verifyRepoState(path.resolve(repoRoot), expectedSha, gitRun || defaultGitRun);
    const pins = loadPins(repoRoot);
    const parsedArgs = parseCliArgs(argv);
    const capturedUrl = env[URL_ENV];
    const conn = validateConnectionUrl(capturedUrl, pins);
    verifyTrustedCaBundle(SYSTEM_CA_BUNDLE);
    const sqlFiles = verifyPinnedSqlFiles(repoRoot, pins);
    state.psqlHandle = await verifyPsqlBinary(env, spawnImpl, {
      trust: psqlTrust,
      useFdExec,
      onChild: (child) => { state.child = child; },
    });
    cleanupStalePassDirs({ nowMs, minAgeMs: staleMinAgeMs });
    state.passHandle = createPassfile(conn);

    const runPhase = async (kind) => {
      if (env[URL_ENV] !== capturedUrl) {
        throw sanitizedError('connection value changed after capture');
      }
      const nonce = randomNonce();
      if (!NONCE_RE.test(nonce)) {
        throw sanitizedError('preflight nonce is invalid');
      }
      const nonceName = kind === 'preflight' ? 'checksops_preflight_nonce' : 'checksops_apply_nonce';
      const result = await runPsqlStdin({
        spawnImpl,
        psqlHandle: state.psqlHandle,
        conn,
        passPath: state.passHandle.passPath,
        pins,
        sqlBytes: sqlFiles[kind].bytes,
        nonceName,
        nonce,
        useFdExec,
        onChild: (child) => { state.child = child; },
      });
      failClosedFromSpawn(result, kind);
      if (String(result.stderr || '').trim() !== '') {
        throw sanitizedError(`${kind} produced unexpected stderr`);
      }
      if (kind === 'preflight') {
        const classification = parseExactSentinel(
          result.stdout,
          PREFLIGHT_SENTINEL_PREFIX,
          nonce,
          ['EXACT_EXPECTED_LEGACY', 'ALREADY_CONTAINED', 'UNSAFE/AMBIGUOUS'],
        );
        return { classification, result, nonce };
      }
      parseExactSentinel(result.stdout, APPLY_SENTINEL_PREFIX, nonce, ['ok']);
      return { result, nonce };
    };

    if (parsedArgs.mode === 'preflight') {
      const pre = await runPhase('preflight');
      writeOut(`WRAPPER_CLASSIFICATION=${pre.classification}`);
      return pre.classification === 'UNSAFE/AMBIGUOUS' ? 1 : 0;
    }

    if (parsedArgs.mode !== 'apply') {
      throw sanitizedError('mode must be preflight or apply');
    }
    if (!parsedArgs.authorized || parsedArgs.confirm !== APPLY_CONFIRM_PHRASE) {
      throw sanitizedError('apply requires the authorization flag and exact confirmation phrase');
    }
    const pre = await runPhase('preflight');
    if (pre.classification !== 'EXACT_EXPECTED_LEGACY') {
      writeErr(`apply refused: preflight classification is ${pre.classification}`);
      return 1;
    }
    await runPhase('apply');
    writeOut('WRAPPER_APPLY=ok');
    return 0;
  } catch (err) {
    if (state.exiting) {
      writeErr('operator wrapper interrupted');
      return 1;
    }
    writeErr(err && err.sanitized ? err.message : 'operator wrapper failed closed');
    return 1;
  } finally {
    state.child = null;
    try { uninstallSignals(); } catch { /* ignore */ }
    closeKeptFd(state.psqlHandle);
    removePassfile(state.passHandle);
  }
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  runCli().then((code) => {
    process.exitCode = code;
  }, () => {
    process.exitCode = 1;
  });
}
