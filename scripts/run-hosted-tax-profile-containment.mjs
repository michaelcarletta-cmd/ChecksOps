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
 * Do not use supabase db push. Do not execute supabase/migrations.
 *
 * PostgreSQL does not expose the Supabase project ref. This wrapper proves
 * the connection target. SQL -v expected_project_ref is defense in depth.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const URL_ENV = 'CHECKSOPS_TAX_CONTAINMENT_DATABASE_URL';
const PSQL_PATH_ENV = 'CHECKSOPS_TAX_CONTAINMENT_PSQL';
const PSQL_SHA_ENV = 'CHECKSOPS_TAX_CONTAINMENT_PSQL_SHA256';
const AUTH_FLAG = '--i-authorize-hosted-recipient-tax-profiles-revoke';
const CONFIRM_PREFIX = '--confirm=';
export const APPLY_CONFIRM_PHRASE = 'REVOKE_POSTGREST_RECIPIENT_TAX_PROFILES';
export {
  URL_ENV,
  AUTH_FLAG,
  PSQL_PATH_ENV,
  PSQL_SHA_ENV,
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

export function loadPins(repoRoot = ROOT) {
  const pinsPath = path.join(repoRoot, 'supabase/security/hosted-tax-profile-containment.pins.json');
  return JSON.parse(fs.readFileSync(pinsPath, 'utf8'));
}

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

function assertSafeParents(absPath) {
  let dir = path.dirname(absPath);
  const seen = new Set();
  while (!seen.has(dir)) {
    seen.add(dir);
    let st;
    try {
      st = fs.lstatSync(dir);
    } catch {
      throw sanitizedError('psql parent directory is missing');
    }
    if (st.isSymbolicLink()) {
      throw sanitizedError('psql parent directory must not be a symlink');
    }
    const worldOrGroupWrite = (st.mode & 0o022) !== 0;
    const sticky = (st.mode & 0o1000) !== 0;
    if (worldOrGroupWrite && !sticky) {
      throw sanitizedError('psql parent directory is group or world writable');
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

export function readTrustedFile(filePath, { executable = false } = {}) {
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
  if (lst.uid !== 0 && lst.uid !== uid) {
    throw sanitizedError('file owner is not trusted');
  }
  assertSafeParents(filePath);
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
    return { bytes, digest: sha256Bytes(bytes), stat: st };
  } finally {
    fs.closeSync(fd);
  }
}

export function verifyPinnedSqlFiles(repoRoot = ROOT, pins = loadPins(repoRoot)) {
  const out = {};
  for (const key of ['preflight', 'apply']) {
    const spec = pins.files[key];
    if (path.normalize(spec.path).includes('..') || spec.path.startsWith('/')) {
      throw sanitizedError(`pinned ${key} path is not a repository-relative SQL file`);
    }
    if (spec.path.includes('supabase/migrations')) {
      throw sanitizedError('pinned SQL must not live under supabase/migrations');
    }
    if (key === 'preflight' && spec.path !== 'supabase/security/preflight_gate_revoke_postgrest_tax_profiles.sql') {
      throw sanitizedError('pinned preflight path is not the reviewed preflight file');
    }
    if (key === 'apply' && spec.path !== 'supabase/security/unapplied-do-not-run/NOT_APPLIED_revoke_postgrest_tax_profiles.sql') {
      throw sanitizedError('pinned apply path is not the reviewed NOT_APPLIED_revoke_postgrest_tax_profiles.sql file');
    }
    const full = path.join(repoRoot, spec.path);
    const trusted = readTrustedFile(full);
    if (trusted.digest !== spec.sha256) {
      throw sanitizedError(`pinned ${key} SQL SHA-256 mismatch`);
    }
    out[key] = { ...spec, bytes: trusted.bytes, full };
  }
  return out;
}

export function validateConnectionUrl(rawUrl, pins = loadPins()) {
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
  const forbiddenKeys = [
    'port', 'service', 'passfile', 'options', 'host', 'hostaddr', 'user', 'password',
    'dbname', 'target_session_attrs', 'replication', 'gssencmode', 'krbsrvname',
    'requirepeer', 'sslrootcert', 'sslcert', 'sslkey', 'sslcrl', 'sslpassword',
    'sslnegotiation', 'sslmode', 'sslcompression', 'ssl_min_protocol_version',
    'channel_binding', 'connect_timeout', 'keepalives', 'application_name',
    'fallback_application_name', 'client_encoding', 'tty', 'require_auth',
  ];
  for (const key of parsed.searchParams.keys()) {
    if (key !== 'sslmode') {
      throw sanitizedError('connection URL has a forbidden query parameter');
    }
    if (forbiddenKeys.includes(key) && key !== 'sslmode') {
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
  readTrustedFile(caPath);
  return caPath;
}

export function verifyPsqlBinary(env, spawnImpl = spawnSync) {
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
  const trusted = readTrustedFile(rawPath, { executable: true });
  if (trusted.digest !== expectedSha) {
    throw sanitizedError('psql SHA-256 mismatch');
  }
  const probe = spawnImpl(rawPath, ['--version'], {
    encoding: 'utf8',
    timeout: VERSION_TIMEOUT_MS,
    env: { LC_ALL: 'C', LANG: 'C', PATH: '' },
    input: Buffer.alloc(0),
    shell: false,
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
  if (!PSQL_VERSION_RE.test(version)) {
    throw sanitizedError('psql version is not an approved PostgreSQL 16+ client');
  }
  return rawPath;
}

function createPassfile(conn) {
  const tmpRoot = os.tmpdir();
  const home = os.homedir();
  if (!tmpRoot || tmpRoot === '/' || tmpRoot === home || tmpRoot.startsWith(`${home}${path.sep}`)) {
    throw sanitizedError('temporary directory is not usable for credentials');
  }
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'checksops-tax-pg-'));
  if (dir === home || dir.startsWith(`${home}${path.sep}`) || dir.includes('~')) {
    fs.rmSync(dir, { recursive: true, force: true });
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

function removePassfile(handle) {
  if (!handle) return;
  try {
    if (handle.passPath) fs.unlinkSync(handle.passPath);
  } catch {
    // still try rmdir
  }
  try {
    if (handle.dir) fs.rmdirSync(handle.dir);
  } catch {
    try {
      if (handle.dir) fs.rmSync(handle.dir, { recursive: true, force: true });
    } catch {
      // credential cleanup best effort; do not throw secrets
    }
  }
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

function runPsqlStdin({
  spawnImpl,
  psqlBin,
  conn,
  passPath,
  pins,
  sqlBytes,
  nonceName,
  nonce,
  timeout = EXEC_TIMEOUT_MS,
}) {
  const args = psqlArgs(pins, nonceName, nonce);
  assertSafeChildArgs(args, conn, passPath);
  const result = spawnImpl(psqlBin, args, {
    encoding: 'utf8',
    timeout,
    env: buildChildEnv(conn, passPath),
    input: sqlBytes,
    shell: false,
  });
  const secrets = [conn.password, passPath];
  return {
    status: result.status,
    signal: result.signal,
    error: result.error,
    stdout: sanitizeText(result.stdout, secrets),
    stderr: sanitizeText(result.stderr, secrets),
    rawArgs: args,
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

export function runCli({
  argv = process.argv.slice(2),
  env = process.env,
  spawnImpl = spawnSync,
  repoRoot = ROOT,
  stdout = process.stdout,
  stderr = process.stderr,
  randomNonce = () => randomBytes(32).toString('hex'),
} = {}) {
  const writeOut = (msg) => stdout.write(`${msg}\n`);
  const writeErr = (msg) => stderr.write(`${msg}\n`);
  let passHandle = null;
  try {
    const pins = loadPins(repoRoot);
    const parsedArgs = parseCliArgs(argv);
    const capturedUrl = env[URL_ENV];
    const conn = validateConnectionUrl(capturedUrl, pins);
    verifyTrustedCaBundle(SYSTEM_CA_BUNDLE);
    const sqlFiles = verifyPinnedSqlFiles(repoRoot, pins);
    const psqlBin = verifyPsqlBinary(env, spawnImpl);
    passHandle = createPassfile(conn);

    const runPhase = (kind) => {
      if (env[URL_ENV] !== capturedUrl) {
        throw sanitizedError('connection value changed after capture');
      }
      const nonce = randomNonce();
      if (!/^[0-9a-f]{64}$/.test(nonce)) {
        throw sanitizedError('preflight nonce is invalid');
      }
      const nonceName = kind === 'preflight' ? 'checksops_preflight_nonce' : 'checksops_apply_nonce';
      const result = runPsqlStdin({
        spawnImpl,
        psqlBin,
        conn,
        passPath: passHandle.passPath,
        pins,
        sqlBytes: sqlFiles[kind].bytes,
        nonceName,
        nonce,
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
      const pre = runPhase('preflight');
      writeOut(`WRAPPER_CLASSIFICATION=${pre.classification}`);
      return pre.classification === 'UNSAFE/AMBIGUOUS' ? 1 : 0;
    }

    if (parsedArgs.mode !== 'apply') {
      throw sanitizedError('mode must be preflight or apply');
    }
    if (!parsedArgs.authorized || parsedArgs.confirm !== APPLY_CONFIRM_PHRASE) {
      throw sanitizedError('apply requires the authorization flag and exact confirmation phrase');
    }
    const pre = runPhase('preflight');
    if (pre.classification !== 'EXACT_EXPECTED_LEGACY') {
      writeErr(`apply refused: preflight classification is ${pre.classification}`);
      return 1;
    }
    runPhase('apply');
    writeOut('WRAPPER_APPLY=ok');
    return 0;
  } catch (err) {
    writeErr(err && err.sanitized ? err.message : 'operator wrapper failed closed');
    return 1;
  } finally {
    removePassfile(passHandle);
  }
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  process.exitCode = runCli();
}
