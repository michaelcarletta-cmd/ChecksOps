#!/usr/bin/env node
/**
 * ONLY authorized way to run hosted recipient_tax_profiles preflight or apply.
 *
 * The database URL MUST come from CHECKSOPS_TAX_CONTAINMENT_DATABASE_URL.
 * Never pass the URL on the command line. This process never prints the URL,
 * password, token, or username.
 *
 * Modes:
 *   node scripts/run-hosted-tax-profile-containment.mjs preflight
 *   node scripts/run-hosted-tax-profile-containment.mjs apply \
 *     --i-authorize-hosted-recipient-tax-profiles-revoke \
 *     --confirm=REVOKE_POSTGREST_RECIPIENT_TAX_PROFILES
 *
 * Default mode is preflight. Apply is refused without the flag and phrase.
 * Apply always runs preflight first on the same validated URL and requires
 * CLASSIFICATION=EXACT_EXPECTED_LEGACY. ALREADY_CONTAINED is not applied.
 *
 * PostgreSQL does not expose the Supabase project ref. This wrapper proves
 * the connection target. SQL -v expected_project_ref is defense in depth.
 *
 * Do not use supabase db push. Do not execute supabase/migrations.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const URL_ENV = 'CHECKSOPS_TAX_CONTAINMENT_DATABASE_URL';
const AUTH_FLAG = '--i-authorize-hosted-recipient-tax-profiles-revoke';
const CONFIRM_PREFIX = '--confirm=';
export const APPLY_CONFIRM_PHRASE = 'REVOKE_POSTGREST_RECIPIENT_TAX_PROFILES';
export { URL_ENV, AUTH_FLAG };

const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const POOLER_HOST_RE = /^aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com$/i;
const ALLOWED_SSL = new Set(['require', 'verify-ca', 'verify-full']);
const WEAK_SSL = new Set(['', 'disable', 'allow', 'prefer', 'allow-off', 'off', 'false', '0']);

export function loadPins(repoRoot = ROOT) {
  const pinsPath = path.join(repoRoot, 'supabase/security/hosted-tax-profile-containment.pins.json');
  return JSON.parse(fs.readFileSync(pinsPath, 'utf8'));
}

export function sha256File(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export function verifyPinnedSqlFiles(repoRoot = ROOT, pins = loadPins(repoRoot)) {
  for (const key of ['preflight', 'apply']) {
    const spec = pins.files[key];
    const full = path.join(repoRoot, spec.path);
    if (!fs.existsSync(full)) {
      throw sanitizedError(`pinned ${key} SQL file is missing`);
    }
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
    const digest = sha256File(full);
    if (digest !== spec.sha256) {
      throw sanitizedError(`pinned ${key} SQL SHA-256 mismatch`);
    }
  }
}

export function sanitizeText(text, secretUrl) {
  let out = String(text || '');
  if (secretUrl) {
    out = out.split(secretUrl).join('[redacted-connection]');
  }
  out = out.replace(/postgresql:\/\/[^\s'"]+/gi, '[redacted-connection]');
  out = out.replace(/postgres:\/\/[^\s'"]+/gi, '[redacted-connection]');
  out = out.replace(/:[^/@\s]{4,}@/g, ':[redacted]@');
  return out;
}

function sanitizedError(message) {
  const err = new Error(message);
  err.sanitized = true;
  return err;
}

function isIpHostname(host) {
  if (!host) return true;
  if (host === 'localhost' || host === '::1' || host === '[::1]') return true;
  if (IPV4_RE.test(host)) return true;
  if (host.includes(':')) return true;
  return false;
}

function isRdsOrGenericHost(host) {
  const h = host.toLowerCase();
  if (h.includes('rds.amazonaws.com') || h.includes('amazonaws.com')) return true;
  if (h.includes('checksops')) return true;
  if (h.endsWith('.neon.tech') || h.endsWith('.azure.com') || h.endsWith('.googleapis.com')) return true;
  return false;
}

export function validateConnectionUrl(rawUrl, pins = loadPins()) {
  if (rawUrl == null || String(rawUrl).trim() === '') {
    throw sanitizedError(`${URL_ENV} is required`);
  }
  const original = String(rawUrl);
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
  const host = (parsed.hostname || '').toLowerCase();
  const database = decodeURIComponent((parsed.pathname || '/').replace(/^\//, ''));
  const username = decodeURIComponent(parsed.username || '');
  const sslmode = (parsed.searchParams.get('sslmode') || '').toLowerCase();
  const expectedRef = pins.expected_project_ref;
  const forbiddenRef = pins.forbidden_project_ref;

  for (const key of ['host', 'hostaddr', 'options', 'user', 'password', 'dbname']) {
    if (parsed.searchParams.has(key)) {
      throw sanitizedError('connection URL has ambiguous target overrides');
    }
  }
  const sslValues = parsed.searchParams.getAll('sslmode').map((v) => v.toLowerCase());
  if (sslValues.length !== 1) {
    throw sanitizedError('connection URL must include exactly one sslmode');
  }
  if (WEAK_SSL.has(sslmode) || !ALLOWED_SSL.has(sslmode)) {
    throw sanitizedError('connection URL TLS is missing or too weak');
  }
  if (!database || database !== pins.expected_database) {
    throw sanitizedError('connection database name is not postgres');
  }
  if (isIpHostname(host)) {
    throw sanitizedError('connection host must not be localhost or an IP literal');
  }
  if (isRdsOrGenericHost(host)) {
    throw sanitizedError('connection host is RDS or a non-Supabase PostgreSQL host');
  }
  if (host.includes(forbiddenRef) || username.includes(forbiddenRef)) {
    throw sanitizedError('connection targets the unused Supabase project');
  }
  if (username.includes('.') && !username.endsWith(`.${expectedRef}`) && username !== expectedRef) {
    const maybeRef = username.split('.').pop();
    if (maybeRef && maybeRef !== expectedRef && /^[a-z0-9]{20}$/.test(maybeRef)) {
      throw sanitizedError('connection username project ref is not production');
    }
  }

  let kind;
  const directHost = `db.${expectedRef}.supabase.co`;
  if (host === directHost) {
    kind = 'direct';
    if (username !== 'postgres') {
      throw sanitizedError('direct connection username shape is invalid');
    }
  } else if (POOLER_HOST_RE.test(host)) {
    kind = 'pooler';
    if (username !== `postgres.${expectedRef}`) {
      throw sanitizedError('pooler connection username does not bind the production project ref');
    }
  } else {
    throw sanitizedError('connection host is not a documented Supabase direct or pooler hostname');
  }

  const fingerprint = [
    kind,
    host,
    parsed.port || '',
    kind === 'direct' ? 'postgres' : 'postgres.<project_ref>',
    database,
    sslmode,
  ].join('|');

  return {
    kind,
    fingerprint,
    expectedProjectRef: expectedRef,
    expectedDatabase: pins.expected_database,
    expectedOwner: pins.expected_owner,
  };
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

export function classifyPreflightOutput(combined) {
  const text = String(combined || '');
  const matches = [...text.matchAll(/CLASSIFICATION=([A-Z_/]+)/g)].map((m) => m[1]);
  if (matches.length !== 1) return 'PARSE_FAILURE';
  if (matches[0] === 'EXACT_EXPECTED_LEGACY') return 'EXACT_EXPECTED_LEGACY';
  if (matches[0] === 'ALREADY_CONTAINED') return 'ALREADY_CONTAINED';
  if (matches[0] === 'UNSAFE/AMBIGUOUS') return 'UNSAFE/AMBIGUOUS';
  return 'PARSE_FAILURE';
}

function findPsql(env, spawnImpl) {
  const override = env.CHECKSOPS_TAX_CONTAINMENT_PSQL;
  const bin = override || 'psql';
  const probe = spawnImpl(bin, ['--version'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    throw sanitizedError('psql is missing');
  }
  return bin;
}

function runPsqlFile({ spawnImpl, psqlBin, url, filePath, pins }) {
  const args = [
    '-X',
    '-v', 'ON_ERROR_STOP=1',
    '-v', `expected_project_ref=${pins.expected_project_ref}`,
    '-v', `expected_database=${pins.expected_database}`,
    '-v', `expected_owner=${pins.expected_owner}`,
    '-d', url,
    '-f', filePath,
  ];
  const result = spawnImpl(psqlBin, args, {
    encoding: 'utf8',
    env: { ...process.env, [URL_ENV]: url },
  });
  const stdout = sanitizeText(result.stdout, url);
  const stderr = sanitizeText(result.stderr, url);
  return {
    status: result.status,
    stdout,
    stderr,
    combined: `${stdout}\n${stderr}`,
  };
}

export function runCli({
  argv = process.argv.slice(2),
  env = process.env,
  spawnImpl = spawnSync,
  repoRoot = ROOT,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const writeOut = (msg) => stdout.write(`${msg}\n`);
  const writeErr = (msg) => stderr.write(`${msg}\n`);
  try {
    const pins = loadPins(repoRoot);
    const parsedArgs = parseCliArgs(argv);
    const url = env[URL_ENV];
    const validated = validateConnectionUrl(url, pins);
    verifyPinnedSqlFiles(repoRoot, pins);
    const psqlBin = findPsql(env, spawnImpl);
    const preflightPath = path.join(repoRoot, pins.files.preflight.path);
    const applyPath = path.join(repoRoot, pins.files.apply.path);

    if (parsedArgs.mode === 'preflight') {
      const pre = runPsqlFile({
        spawnImpl, psqlBin, url, filePath: preflightPath, pins,
      });
      writeOut(pre.stdout.trimEnd());
      if (pre.stderr.trim()) writeErr(pre.stderr.trimEnd());
      if (pre.status !== 0) {
        writeErr('preflight failed closed');
        return 1;
      }
      const classification = classifyPreflightOutput(pre.combined);
      writeOut(`WRAPPER_CLASSIFICATION=${classification}`);
      return classification === 'PARSE_FAILURE' ? 1 : 0;
    }

    if (parsedArgs.mode !== 'apply') {
      throw sanitizedError('mode must be preflight or apply');
    }
    if (!parsedArgs.authorized || parsedArgs.confirm !== APPLY_CONFIRM_PHRASE) {
      throw sanitizedError('apply requires the authorization flag and exact confirmation phrase');
    }

    const urlAfterAuth = env[URL_ENV];
    const revalidated = validateConnectionUrl(urlAfterAuth, pins);
    if (revalidated.fingerprint !== validated.fingerprint || urlAfterAuth !== url) {
      throw sanitizedError('connection value changed between validation and apply');
    }

    const pre = runPsqlFile({
      spawnImpl, psqlBin, url: urlAfterAuth, filePath: preflightPath, pins,
    });
    if (pre.status !== 0) {
      writeErr('preflight failed closed; apply refused');
      return 1;
    }
    const classification = classifyPreflightOutput(pre.combined);
    if (classification !== 'EXACT_EXPECTED_LEGACY') {
      writeErr(`apply refused: preflight classification is ${classification}`);
      return 1;
    }
    const urlBeforeApply = env[URL_ENV];
    const third = validateConnectionUrl(urlBeforeApply, pins);
    if (third.fingerprint !== validated.fingerprint || urlBeforeApply !== url) {
      throw sanitizedError('connection value changed between preflight and apply');
    }
    verifyPinnedSqlFiles(repoRoot, pins);

    const applied = runPsqlFile({
      spawnImpl, psqlBin, url: urlBeforeApply, filePath: applyPath, pins,
    });
    writeOut(applied.stdout.trimEnd());
    if (applied.stderr.trim()) writeErr(applied.stderr.trimEnd());
    if (applied.status !== 0) {
      writeErr('apply failed closed');
      return 1;
    }
    writeOut('WRAPPER_APPLY=ok');
    return 0;
  } catch (err) {
    writeErr(err && err.sanitized ? err.message : 'operator wrapper failed closed');
    return 1;
  }
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  process.exitCode = runCli();
}
