import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  APPLY_CONFIRM_PHRASE,
  AUTH_FLAG,
  URL_ENV,
  classifyPreflightOutput,
  parseCliArgs,
  runCli,
  sanitizeText,
  validateConnectionUrl,
  verifyPinnedSqlFiles,
} from '../../scripts/run-hosted-tax-profile-containment.mjs';
import { loadPins } from '../../scripts/check-recipient-tax-profile-migrations.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SECRET = 'SuperSecretPassw0rd-do-not-print';
const REF = 'nbcqwpysqgyxrrbgtmkw';
const UNUSED = 'sqyyvpaymashtdwjjmku';

const directUrl = `postgresql://postgres:${SECRET}@db.${REF}.supabase.co:5432/postgres?sslmode=require`;
const poolerUrl = `postgresql://postgres.${REF}:${SECRET}@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=verify-full`;

function capturedRun(argv, extra = {}) {
  const env = extra.env || { [URL_ENV]: extra.url ?? directUrl };
  if (!env[URL_ENV]) env[URL_ENV] = extra.url ?? directUrl;
  let out = '';
  let err = '';
  const calls = [];
  const spawnImpl = extra.spawnImpl || ((bin, args) => {
    calls.push({ bin, args });
    if (args.includes('--version')) return { status: 0, stdout: 'psql (PostgreSQL) 16.0', stderr: '' };
    return {
      status: extra.psqlStatus ?? 0,
      stdout: extra.psqlStdout ?? '',
      stderr: extra.psqlStderr ?? 'NOTICE:  CLASSIFICATION=EXACT_EXPECTED_LEGACY\n',
    };
  });
  const code = runCli({
    argv,
    env,
    spawnImpl,
    repoRoot: extra.repoRoot || ROOT,
    stdout: { write: (s) => { out += s; } },
    stderr: { write: (s) => { err += s; } },
  });
  return { code, out, err, combined: `${out}\n${err}`, calls, env };
}

test('correct direct and pooler URLs validate without printing secrets', () => {
  const pins = loadPins();
  const direct = validateConnectionUrl(directUrl, pins);
  const pooler = validateConnectionUrl(poolerUrl, pins);
  assert.equal(direct.kind, 'direct');
  assert.equal(pooler.kind, 'pooler');
  assert.equal(direct.expectedProjectRef, REF);
  const dump = JSON.stringify({ direct, pooler });
  assert.equal(dump.includes(SECRET), false);
  assert.equal(Object.prototype.hasOwnProperty.call(direct, 'originalUrl'), false);
  assert.equal(sanitizeText(`failed ${directUrl}`, directUrl).includes(SECRET), false);
});

test('wrong project, unused project, RDS, localhost, IP, db, user, and weak SSL are refused', () => {
  const pins = loadPins();
  const rejects = [
    `postgresql://postgres:${SECRET}@db.${UNUSED}.supabase.co:5432/postgres?sslmode=require`,
    `postgresql://postgres.${UNUSED}:${SECRET}@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require`,
    `postgresql://postgres:${SECRET}@checksops.c9.rds.amazonaws.com:5432/postgres?sslmode=require`,
    `postgresql://postgres:${SECRET}@localhost:5432/postgres?sslmode=require`,
    `postgresql://postgres:${SECRET}@127.0.0.1:5432/postgres?sslmode=require`,
    `postgresql://postgres:${SECRET}@db.${REF}.supabase.co:5432/checksops?sslmode=require`,
    `postgresql://authenticator:${SECRET}@db.${REF}.supabase.co:5432/postgres?sslmode=require`,
    `postgresql://postgres:${SECRET}@db.${REF}.supabase.co:5432/postgres?sslmode=disable`,
    `postgresql://postgres:${SECRET}@db.${REF}.supabase.co:5432/postgres?sslmode=prefer`,
    `postgresql://postgres:${SECRET}@db.${REF}.supabase.co:5432/postgres`,
    `postgresql://postgres:${SECRET}@example.com:5432/postgres?sslmode=require`,
  ];
  for (const url of rejects) {
    assert.throws(() => validateConnectionUrl(url, pins));
    try {
      validateConnectionUrl(url, pins);
    } catch (err) {
      assert.equal(String(err.message).includes(SECRET), false);
      assert.equal(String(err.message).includes(url), false);
    }
  }
});

test('pooler requires production project ref in the username', () => {
  const pins = loadPins();
  assert.throws(
    () => validateConnectionUrl(
      `postgresql://postgres:${SECRET}@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require`,
      pins,
    ),
  );
});

test('apply without authorization or with the wrong phrase is refused', () => {
  const missing = capturedRun(['apply']);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /authorization flag and exact confirmation phrase/);
  assert.equal(missing.combined.includes(SECRET), false);

  const wrong = capturedRun(['apply', AUTH_FLAG, `--confirm=NOPE`]);
  assert.equal(wrong.code, 1);
  assert.match(wrong.err, /authorization flag and exact confirmation phrase/);
});

test('file hash mismatch is refused before psql', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rtp-wrap-'));
  fs.cpSync(path.join(ROOT, 'supabase'), path.join(tmp, 'supabase'), { recursive: true });
  fs.cpSync(
    path.join(ROOT, 'supabase/security/hosted-tax-profile-containment.pins.json'),
    path.join(tmp, 'supabase/security/hosted-tax-profile-containment.pins.json'),
  );
  fs.appendFileSync(path.join(tmp, 'supabase/security/preflight_gate_revoke_postgrest_tax_profiles.sql'), '\n-- tamper\n');
  const result = capturedRun(['preflight'], { repoRoot: tmp });
  assert.equal(result.code, 1);
  assert.match(result.err, /SHA-256 mismatch/);
  assert.equal(result.calls.some((c) => c.args.includes('-f')), false);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('preflight nonzero exit refuses apply', () => {
  const result = capturedRun(['apply', AUTH_FLAG, `--confirm=${APPLY_CONFIRM_PHRASE}`], {
    spawnImpl: (bin, args) => {
      if (args.includes('--version')) return { status: 0, stdout: 'psql', stderr: '' };
      return { status: 3, stdout: '', stderr: 'NOTICE:  CLASSIFICATION=UNSAFE/AMBIGUOUS\n' };
    },
  });
  assert.equal(result.code, 1);
  assert.match(result.err, /preflight failed closed; apply refused/);
  assert.equal(result.combined.includes(SECRET), false);
});

test('ALREADY_CONTAINED is refused for apply', () => {
  const result = capturedRun(['apply', AUTH_FLAG, `--confirm=${APPLY_CONFIRM_PHRASE}`], {
    psqlStderr: 'NOTICE:  CLASSIFICATION=ALREADY_CONTAINED\n',
  });
  assert.equal(result.code, 1);
  assert.match(result.err, /apply refused: preflight classification is ALREADY_CONTAINED/);
});

test('connection value cannot change between preflight and apply', () => {
  const env = { [URL_ENV]: directUrl };
  let preflightSeen = false;
  const result = capturedRun(['apply', AUTH_FLAG, `--confirm=${APPLY_CONFIRM_PHRASE}`], {
    env,
    spawnImpl: (bin, args) => {
      if (args.includes('--version')) return { status: 0, stdout: 'psql', stderr: '' };
      if (!preflightSeen) {
        preflightSeen = true;
        env[URL_ENV] = poolerUrl;
        return { status: 0, stdout: '', stderr: 'NOTICE:  CLASSIFICATION=EXACT_EXPECTED_LEGACY\n' };
      }
      return { status: 0, stdout: 'applied', stderr: '' };
    },
  });
  assert.equal(result.code, 1);
  assert.match(result.err, /connection value changed/);
});

test('parseCliArgs defaults to preflight', () => {
  assert.deepEqual(parseCliArgs([]), { mode: 'preflight', authorized: false, confirm: '' });
  assert.equal(parseCliArgs(['preflight']).mode, 'preflight');
});

test('classifyPreflightOutput requires exactly one classification', () => {
  assert.equal(classifyPreflightOutput('NOTICE:  CLASSIFICATION=EXACT_EXPECTED_LEGACY'), 'EXACT_EXPECTED_LEGACY');
  assert.equal(classifyPreflightOutput('nope'), 'PARSE_FAILURE');
  assert.equal(
    classifyPreflightOutput('CLASSIFICATION=EXACT_EXPECTED_LEGACY\nCLASSIFICATION=ALREADY_CONTAINED'),
    'PARSE_FAILURE',
  );
});

test('missing psql is refused', () => {
  const result = capturedRun(['preflight'], {
    spawnImpl: () => ({ status: 1, stdout: '', stderr: 'not found' }),
  });
  assert.equal(result.code, 1);
  assert.match(result.err, /psql is missing/);
});

test('authorized apply runs preflight then the pinned apply file', () => {
  const files = [];
  const result = capturedRun(['apply', AUTH_FLAG, `--confirm=${APPLY_CONFIRM_PHRASE}`], {
    spawnImpl: (bin, args) => {
      if (args.includes('--version')) return { status: 0, stdout: 'psql', stderr: '' };
      const file = args[args.indexOf('-f') + 1];
      files.push(file);
      if (files.length === 1) {
        return { status: 0, stdout: '', stderr: 'NOTICE:  CLASSIFICATION=EXACT_EXPECTED_LEGACY\n' };
      }
      return { status: 0, stdout: 'NOTICE:  CLASSIFICATION=EXACT_EXPECTED_LEGACY\n', stderr: '' };
    },
  });
  assert.equal(result.code, 0);
  assert.match(result.out, /WRAPPER_APPLY=ok/);
  assert.equal(files.length, 2);
  assert.match(files[0], /preflight_gate_revoke_postgrest_tax_profiles\.sql$/);
  assert.match(files[1], /NOT_APPLIED_revoke_postgrest_tax_profiles\.sql$/);
  assert.equal(files[1].includes('supabase/migrations'), false);
  assert.equal(result.combined.includes(SECRET), false);
});

test('verify-ca is an accepted TLS mode', () => {
  const pins = loadPins();
  const url = `postgresql://postgres:${SECRET}@db.${REF}.supabase.co:5432/postgres?sslmode=verify-ca`;
  assert.equal(validateConnectionUrl(url, pins).kind, 'direct');
});

test('PARSE_FAILURE and UNSAFE/AMBIGUOUS refuse apply', () => {
  const parseFail = capturedRun(['apply', AUTH_FLAG, `--confirm=${APPLY_CONFIRM_PHRASE}`], {
    psqlStderr: 'NOTICE:  no classification token\n',
  });
  assert.equal(parseFail.code, 1);
  assert.match(parseFail.err, /PARSE_FAILURE/);

  const unsafe = capturedRun(['apply', AUTH_FLAG, `--confirm=${APPLY_CONFIRM_PHRASE}`], {
    psqlStderr: 'NOTICE:  CLASSIFICATION=UNSAFE/AMBIGUOUS\n',
  });
  assert.equal(unsafe.code, 1);
  assert.match(unsafe.err, /UNSAFE\/AMBIGUOUS/);
});

test('repository pinned SQL hashes currently match', () => {
  verifyPinnedSqlFiles(ROOT);
});
