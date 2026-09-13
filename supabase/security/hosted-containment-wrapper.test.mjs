import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  APPLY_CONFIRM_PHRASE,
  AUTH_FLAG,
  EXEC_TIMEOUT_MS,
  GIT_SHA_ENV,
  PREFLIGHT_SENTINEL_PREFIX,
  APPLY_SENTINEL_PREFIX,
  PSQL_PATH_ENV,
  PSQL_SHA_ENV,
  PSQL_PRODUCTION_TRUST,
  TEST_PSQL_TRUST,
  ALLOWED_GIT_BINS,
  GIT_PRODUCTION_TRUST,
  TEST_GIT_TRUST,
  REQUIRED_SSLMODE,
  SYSTEM_CA_BUNDLE,
  URL_ENV,
  VERSION_TIMEOUT_MS,
  STALE_PASSDIR_MIN_AGE_MS,
  buildChildEnv,
  cleanupStalePassDirs,
  defaultAsyncSpawn,
  handleExecutionSignal,
  parseCliArgs,
  parseExactSentinel,
  removePassfile,
  runCli,
  sanitizeText,
  sha256Bytes,
  validateConnectionUrl,
  validatePinsObject,
  verifyPinnedSqlFiles,
  verifyPsqlBinary,
  verifyRepoState,
  resolveTrustedGit,
  revalidateGitHandle,
  makeDefaultGitRun,
} from '../../scripts/run-hosted-tax-profile-containment.mjs';
import { loadPins } from '../../scripts/check-recipient-tax-profile-migrations.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SECRET = 'SuperSecretPassw0rd-do-not-print';
const REF = 'nbcqwpysqgyxrrbgtmkw';
const UNUSED = 'sqyyvpaymashtdwjjmku';
const PRE_NONCE = 'a'.repeat(64);
const APPLY_NONCE = 'b'.repeat(64);
const STUB_GIT_SHA = 'a'.repeat(40);

const directUrl = `postgresql://postgres:${SECRET}@db.${REF}.supabase.co:5432/postgres?sslmode=verify-full`;
const DISTRO_PSQL = '/usr/lib/postgresql/16/bin/psql';

function dummyPsql() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtp-psql-'));
  fs.chmodSync(dir, 0o700);
  const bin = path.join(dir, 'psql');
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(bin, 0o755);
  const digest = createHash('sha256').update(fs.readFileSync(bin)).digest('hex');
  return { dir, bin, digest };
}

function stubGit(expectedSha = STUB_GIT_SHA, extra = {}) {
  return (repoRoot, args) => {
    if (typeof extra.gitRun === 'function') {
      const override = extra.gitRun(repoRoot, args);
      if (override) return override;
    }
    const cmd = args.join(' ');
    if (cmd === 'rev-parse --is-inside-work-tree') return { status: 0, stdout: 'true\n', stderr: '' };
    if (cmd === 'rev-parse --show-toplevel') return { status: 0, stdout: `${path.resolve(repoRoot)}\n`, stderr: '' };
    if (cmd === 'symbolic-ref -q HEAD') {
      if (extra.detached) return { status: 1, stdout: '', stderr: '' };
      return { status: 0, stdout: 'refs/heads/review\n', stderr: '' };
    }
    if (cmd === 'rev-parse HEAD') return { status: 0, stdout: `${extra.headSha ?? expectedSha}\n`, stderr: '' };
    if (cmd.startsWith('status ')) return { status: 0, stdout: extra.statusStdout ?? '', stderr: '' };
    return { status: 1, stdout: '', stderr: 'unexpected git invocation' };
  };
}

function operatorEnv(extra = {}) {
  const psql = extra.psql || dummyPsql();
  extra._psql = extra._psql || psql;
  return {
    [URL_ENV]: extra.url ?? directUrl,
    [PSQL_PATH_ENV]: extra.psqlPath ?? psql.bin,
    [PSQL_SHA_ENV]: extra.psqlSha ?? psql.digest,
    [GIT_SHA_ENV]: extra.gitSha ?? STUB_GIT_SHA,
    ...extra.env,
  };
}

function nonceFromArgs(args) {
  const pre = args.find((a) => a.startsWith('checksops_preflight_nonce='));
  const apply = args.find((a) => a.startsWith('checksops_apply_nonce='));
  if (pre) return { kind: 'preflight', nonce: pre.slice('checksops_preflight_nonce='.length) };
  if (apply) return { kind: 'apply', nonce: apply.slice('checksops_apply_nonce='.length) };
  return { kind: 'none', nonce: '' };
}

async function capturedRun(argv, extra = {}) {
  const psql = extra.psql || dummyPsql();
  const env = extra.env || operatorEnv({ psql, url: extra.url, env: extra.extraEnv });
  if (!env[URL_ENV]) env[URL_ENV] = extra.url ?? directUrl;
  if (!env[GIT_SHA_ENV]) env[GIT_SHA_ENV] = STUB_GIT_SHA;
  let out = '';
  let err = '';
  const calls = [];
  let nonceGen = 0;
  const innerSpawn = extra.spawnImpl || ((bin, args, opts = {}) => {
    if (args.includes('--version')) {
      return { status: 0, stdout: 'psql (PostgreSQL) 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)\n', stderr: '' };
    }
    const parsed = nonceFromArgs(args);
    if (parsed.kind === 'preflight') {
      return {
        status: extra.psqlStatus ?? 0,
        stdout: extra.psqlStdout ?? `${PREFLIGHT_SENTINEL_PREFIX}|${parsed.nonce}|EXACT_EXPECTED_LEGACY\n`,
        stderr: extra.psqlStderr ?? '',
      };
    }
    return {
      status: extra.applyStatus ?? 0,
      stdout: extra.applyStdout ?? `${APPLY_SENTINEL_PREFIX}|${parsed.nonce}|ok\n`,
      stderr: extra.applyStderr ?? '',
    };
  });
  const spawnImpl = (bin, args, opts = {}) => {
    calls.push({ bin, args, opts });
    return innerSpawn(bin, args, opts);
  };
  const code = await runCli({
    argv,
    env,
    spawnImpl,
    repoRoot: extra.repoRoot || ROOT,
    stdout: { write: (s) => { out += s; } },
    stderr: { write: (s) => { err += s; } },
    randomNonce: extra.randomNonce || (() => (nonceGen++ === 0 ? PRE_NONCE : APPLY_NONCE)),
    psqlTrust: extra.psqlTrust ?? TEST_PSQL_TRUST,
    gitRun: extra.gitRun ?? stubGit(env[GIT_SHA_ENV] || STUB_GIT_SHA, extra),
    installSignals: extra.installSignals ?? (() => () => {}),
    exitImpl: extra.exitImpl || ((code) => {
      const err = new Error('operator wrapper interrupted');
      err.sanitized = true;
      err.exitCode = code;
      throw err;
    }),
  });
  return { code, out, err, combined: `${out}\n${err}`, calls, env, psql };
}

test('verify-full direct URL validates; require and verify-ca are refused', () => {
  const pins = loadPins();
  const ok = validateConnectionUrl(directUrl, pins);
  assert.equal(ok.kind, 'direct');
  assert.equal(ok.sslmode, REQUIRED_SSLMODE);
  assert.equal(ok.sslrootcert, SYSTEM_CA_BUNDLE);
  assert.equal(ok.port, '5432');
  assert.equal(JSON.stringify(ok).includes(SECRET), false);
  assert.throws(() => validateConnectionUrl(
    `postgresql://postgres:${SECRET}@db.${REF}.supabase.co:5432/postgres?sslmode=require`,
    pins,
  ));
  assert.throws(() => validateConnectionUrl(
    `postgresql://postgres:${SECRET}@db.${REF}.supabase.co:5432/postgres?sslmode=verify-ca`,
    pins,
  ));
});

test('forbidden query parameters, duplicate sslmode, empty password, and wrong ports are refused', () => {
  const pins = loadPins();
  const base = `postgresql://postgres:${SECRET}@db.${REF}.supabase.co:5432/postgres`;
  const rejects = [
    `${base}?sslmode=verify-full&port=9999`,
    `${base}?sslmode=verify-full&service=evil`,
    `${base}?sslmode=verify-full&passfile=/tmp/x`,
    `${base}?sslmode=verify-full&options=-csearch_path=public`,
    `${base}?sslmode=verify-full&host=evil.example`,
    `${base}?sslmode=verify-full&hostaddr=1.2.3.4`,
    `${base}?sslmode=verify-full&user=authenticator`,
    `${base}?sslmode=verify-full&password=x`,
    `${base}?sslmode=verify-full&dbname=other`,
    `${base}?sslmode=verify-full&target_session_attrs=read-only`,
    `${base}?sslmode=verify-full&replication=database`,
    `${base}?sslmode=verify-full&gssencmode=require`,
    `${base}?sslmode=verify-full&krbsrvname=postgres`,
    `${base}?sslmode=verify-full&requirepeer=postgres`,
    `${base}?sslmode=verify-full&sslrootcert=/tmp/ca.pem`,
    `${base}?sslmode=verify-full&sslcert=/tmp/c.pem`,
    `${base}?sslmode=verify-full&sslkey=/tmp/k.pem`,
    `${base}?sslmode=verify-full&sslcrl=/tmp/crl.pem`,
    `${base}?sslmode=verify-full&sslpassword=x`,
    `${base}?sslmode=verify-full&sslnegotiation=direct`,
    `${base}?sslmode=verify-full&sslmode=verify-full`,
    `postgresql://postgres@db.${REF}.supabase.co:5432/postgres?sslmode=verify-full`,
    `postgresql://postgres:${SECRET}@db.${REF}.supabase.co:6543/postgres?sslmode=verify-full`,
    `postgresql://postgres:${SECRET}@db.${REF}.supabase.co/postgres?sslmode=verify-full`,
    `postgresql://postgres:${SECRET}@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=verify-full`,
    `postgresql://postgres.${REF}:${SECRET}@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=verify-full`,
    `postgresql://postgres:${SECRET}@db.${UNUSED}.supabase.co:5432/postgres?sslmode=verify-full`,
    `postgresql://postgres:${SECRET}@localhost:5432/postgres?sslmode=verify-full`,
    `postgresql://postgres:${SECRET}@127.0.0.1:5432/postgres?sslmode=verify-full`,
    `postgresql://postgres:${encodeURIComponent('x\ny')}@db.${REF}.supabase.co:5432/postgres?sslmode=verify-full`,
  ];
  for (const url of rejects) {
    assert.throws(() => validateConnectionUrl(url, pins));
    try {
      validateConnectionUrl(url, pins);
    } catch (err) {
      assert.equal(String(err.message).includes(SECRET), false);
    }
  }
});

test('apply without authorization or with the wrong phrase is refused', async () => {
  const missing = await capturedRun(['apply']);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /authorization flag and exact confirmation phrase/);
  assert.equal(missing.combined.includes(SECRET), false);
  const wrong = await capturedRun(['apply', AUTH_FLAG, `--confirm=NOPE`]);
  assert.equal(wrong.code, 1);
});

test('no URI or password in child argv; PG* injection is not inherited', async () => {
  const result = await capturedRun(['preflight']);
  assert.equal(result.code, 0);
  assert.equal(result.calls.length >= 2, true);
  for (const call of result.calls) {
    const blob = `${call.bin}\0${(call.args || []).join('\0')}`;
    assert.equal(blob.includes(SECRET), false);
    assert.equal(blob.includes('postgresql://'), false);
    assert.equal((call.args || []).includes('-d'), false);
    assert.equal((call.args || []).includes('-f'), false);
    if (call.args.includes('--version')) {
      assert.equal(call.opts.timeout, VERSION_TIMEOUT_MS);
      continue;
    }
    assert.equal(call.args.includes('-w'), true);
    assert.equal(call.args.includes('-X'), true);
    assert.equal(Buffer.isBuffer(call.opts.input), true);
    assert.equal(call.opts.timeout, EXEC_TIMEOUT_MS);
    assert.equal(call.opts.env.PGSSLMODE, 'verify-full');
    assert.equal(call.opts.env.PGSSLROOTCERT, SYSTEM_CA_BUNDLE);
    assert.equal(call.opts.env.PGHOST, `db.${REF}.supabase.co`);
    assert.equal(call.opts.env.PGPORT, '5432');
    assert.equal(Object.hasOwn(call.opts.env, 'PGPASSWORD'), false);
    assert.equal(Object.hasOwn(call.opts.env, 'PGOPTIONS'), false);
    assert.equal(Object.hasOwn(call.opts.env, 'PSQLRC'), false);
    assert.equal(Object.hasOwn(call.opts.env, 'PGSERVICE'), false);
    assert.equal(call.opts.env.PATH, '');
    assert.equal(call.opts.shell, false);
    assert.equal(call.opts.argv0, result.psql.bin);
  }
});

test('PATH psql and relative override are rejected', async () => {
  const psql = dummyPsql();
  const missing = await capturedRun(['preflight'], {
    env: { [URL_ENV]: directUrl, [PSQL_SHA_ENV]: psql.digest },
  });
  assert.equal(missing.code, 1);
  assert.match(missing.err, /absolute psql path/);

  const relative = await capturedRun(['preflight'], {
    env: { [URL_ENV]: directUrl, [PSQL_PATH_ENV]: 'psql', [PSQL_SHA_ENV]: psql.digest },
  });
  assert.equal(relative.code, 1);
  assert.match(relative.err, /absolute/);
});

test('symlink, writable, and wrong-hash psql binaries are rejected', async () => {
  const psql = dummyPsql();
  const link = path.join(psql.dir, 'link-psql');
  fs.symlinkSync(psql.bin, link);
  const sym = await capturedRun(['preflight'], {
    env: { [URL_ENV]: directUrl, [PSQL_PATH_ENV]: link, [PSQL_SHA_ENV]: psql.digest },
  });
  assert.equal(sym.code, 1);
  assert.match(sym.err, /symlink/);

  fs.chmodSync(psql.bin, 0o777);
  const writable = await capturedRun(['preflight'], {
    env: { [URL_ENV]: directUrl, [PSQL_PATH_ENV]: psql.bin, [PSQL_SHA_ENV]: psql.digest },
  });
  assert.equal(writable.code, 1);
  assert.match(writable.err, /writable/);
  fs.chmodSync(psql.bin, 0o755);

  const wrong = await capturedRun(['preflight'], {
    env: { [URL_ENV]: directUrl, [PSQL_PATH_ENV]: psql.bin, [PSQL_SHA_ENV]: '0'.repeat(64) },
  });
  assert.equal(wrong.code, 1);
  assert.match(wrong.err, /SHA-256 mismatch/);
  assert.equal(wrong.calls.some((c) => c.args && !c.args.includes('--version')), false);
});

test('timeout and password prompt flags are enforced', async () => {
  const timed = await capturedRun(['preflight'], {
    spawnImpl: (bin, args, opts = {}) => {
      if (args.includes('--version')) {
        return { status: 0, stdout: 'psql (PostgreSQL) 16.15\n', stderr: '' };
      }
      return { error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }), status: null, stdout: '', stderr: '' };
    },
  });
  assert.equal(timed.code, 1);
  assert.match(timed.err, /timed out/);
});

test('NOTICE/HINT/prefix/suffix sentinel spoofing is rejected', () => {
  assert.throws(() => parseExactSentinel(
    'NOTICE: CLASSIFICATION=EXACT_EXPECTED_LEGACY\n',
    PREFLIGHT_SENTINEL_PREFIX,
    PRE_NONCE,
    ['EXACT_EXPECTED_LEGACY'],
  ));
  assert.throws(() => parseExactSentinel(
    `FOO${PREFLIGHT_SENTINEL_PREFIX}|${PRE_NONCE}|EXACT_EXPECTED_LEGACY\n`,
    PREFLIGHT_SENTINEL_PREFIX,
    PRE_NONCE,
    ['EXACT_EXPECTED_LEGACY'],
  ));
  assert.throws(() => parseExactSentinel(
    `${PREFLIGHT_SENTINEL_PREFIX}|${PRE_NONCE}|EXACT_EXPECTED_LEGACY extra\n`,
    PREFLIGHT_SENTINEL_PREFIX,
    PRE_NONCE,
    ['EXACT_EXPECTED_LEGACY'],
  ));
  assert.throws(() => parseExactSentinel(
    `HINT: ${PREFLIGHT_SENTINEL_PREFIX}|${PRE_NONCE}|EXACT_EXPECTED_LEGACY\n`,
    PREFLIGHT_SENTINEL_PREFIX,
    PRE_NONCE,
    ['EXACT_EXPECTED_LEGACY'],
  ));
  assert.equal(
    parseExactSentinel(
      `${PREFLIGHT_SENTINEL_PREFIX}|${PRE_NONCE}|EXACT_EXPECTED_LEGACY\n`,
      PREFLIGHT_SENTINEL_PREFIX,
      PRE_NONCE,
      ['EXACT_EXPECTED_LEGACY'],
    ),
    'EXACT_EXPECTED_LEGACY',
  );
});

test('wrong nonce, multiple sentinel rows, and extra stdout are rejected', async () => {
  const wrongNonce = await capturedRun(['preflight'], {
    spawnImpl: (bin, args) => {
      if (args.includes('--version')) return { status: 0, stdout: 'psql (PostgreSQL) 16.15\n', stderr: '' };
      return { status: 0, stdout: `${PREFLIGHT_SENTINEL_PREFIX}|${'c'.repeat(64)}|EXACT_EXPECTED_LEGACY\n`, stderr: '' };
    },
  });
  assert.equal(wrongNonce.code, 1);
  assert.match(wrongNonce.err, /sentinel/);

  const multi = await capturedRun(['preflight'], {
    spawnImpl: (bin, args) => {
      if (args.includes('--version')) return { status: 0, stdout: 'psql (PostgreSQL) 16.15\n', stderr: '' };
      const n = nonceFromArgs(args).nonce;
      return {
        status: 0,
        stdout: `${PREFLIGHT_SENTINEL_PREFIX}|${n}|EXACT_EXPECTED_LEGACY\n${PREFLIGHT_SENTINEL_PREFIX}|${n}|EXACT_EXPECTED_LEGACY\n`,
        stderr: '',
      };
    },
  });
  assert.equal(multi.code, 1);

  const extra = await capturedRun(['preflight'], {
    spawnImpl: (bin, args) => {
      if (args.includes('--version')) return { status: 0, stdout: 'psql (PostgreSQL) 16.15\n', stderr: '' };
      const n = nonceFromArgs(args).nonce;
      return { status: 0, stdout: `hello\n${PREFLIGHT_SENTINEL_PREFIX}|${n}|EXACT_EXPECTED_LEGACY\n`, stderr: '' };
    },
  });
  assert.equal(extra.code, 1);
});

test('SQL symlink is rejected', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rtp-sql-link-'));
  fs.cpSync(path.join(ROOT, 'supabase'), path.join(tmp, 'supabase'), { recursive: true });
  const real = path.join(tmp, 'supabase/security/preflight_gate_revoke_postgrest_tax_profiles.sql');
  const backup = `${real}.orig`;
  fs.renameSync(real, backup);
  fs.symlinkSync(backup, real);
  const result = await capturedRun(['preflight'], { repoRoot: tmp });
  assert.equal(result.code, 1);
  assert.match(result.err, /symlink/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('hash-then-replace uses the already hashed stdin bytes and never -f', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rtp-sql-toctou-'));
  fs.cpSync(path.join(ROOT, 'supabase'), path.join(tmp, 'supabase'), { recursive: true });
  const prePath = path.join(tmp, 'supabase/security/preflight_gate_revoke_postgrest_tax_profiles.sql');
  const original = fs.readFileSync(prePath);
  const result = await capturedRun(['preflight'], {
    repoRoot: tmp,
    spawnImpl: (bin, args, opts = {}) => {
      if (args.includes('--version')) return { status: 0, stdout: 'psql (PostgreSQL) 16.15\n', stderr: '' };
      fs.appendFileSync(prePath, '\n-- replaced-after-hash\n');
      assert.equal(Buffer.isBuffer(opts.input), true);
      assert.equal(sha256Bytes(opts.input), sha256Bytes(original));
      assert.equal(opts.input.includes('replaced-after-hash'), false);
      assert.equal(args.includes('-f'), false);
      const n = nonceFromArgs(args).nonce;
      return { status: 0, stdout: `${PREFLIGHT_SENTINEL_PREFIX}|${n}|EXACT_EXPECTED_LEGACY\n`, stderr: '' };
    },
  });
  assert.equal(result.code, 0);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('file hash mismatch is refused before psql stdin', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rtp-wrap-'));
  fs.cpSync(path.join(ROOT, 'supabase'), path.join(tmp, 'supabase'), { recursive: true });
  fs.appendFileSync(path.join(tmp, 'supabase/security/preflight_gate_revoke_postgrest_tax_profiles.sql'), '\n-- tamper\n');
  const result = await capturedRun(['preflight'], { repoRoot: tmp });
  assert.equal(result.code, 1);
  assert.match(result.err, /SHA-256 mismatch/);
  assert.equal(result.calls.some((c) => c.args && !c.args.includes('--version') && c.opts && c.opts.input), false);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('ALREADY_CONTAINED and nonzero preflight refuse apply', async () => {
  const contained = await capturedRun(['apply', AUTH_FLAG, `--confirm=${APPLY_CONFIRM_PHRASE}`], {
    spawnImpl: (bin, args) => {
      if (args.includes('--version')) return { status: 0, stdout: 'psql (PostgreSQL) 16.15\n', stderr: '' };
      const parsed = nonceFromArgs(args);
      if (parsed.kind === 'preflight') {
        return { status: 0, stdout: `${PREFLIGHT_SENTINEL_PREFIX}|${parsed.nonce}|ALREADY_CONTAINED\n`, stderr: '' };
      }
      return { status: 0, stdout: `${APPLY_SENTINEL_PREFIX}|${parsed.nonce}|ok\n`, stderr: '' };
    },
  });
  assert.equal(contained.code, 1);
  assert.match(contained.err, /ALREADY_CONTAINED/);
  assert.equal(contained.calls.filter((c) => nonceFromArgs(c.args).kind === 'apply').length, 0);

  const nonzero = await capturedRun(['apply', AUTH_FLAG, `--confirm=${APPLY_CONFIRM_PHRASE}`], {
    spawnImpl: (bin, args) => {
      if (args.includes('--version')) return { status: 0, stdout: 'psql (PostgreSQL) 16.15\n', stderr: '' };
      return { status: 3, stdout: '', stderr: 'ERROR: boom\n' };
    },
  });
  assert.equal(nonzero.code, 1);
  assert.match(nonzero.err, /preflight failed closed/);
});

test('connection capture is immutable across preflight and apply', async () => {
  const env = operatorEnv();
  const hosts = [];
  const result = await capturedRun(['apply', AUTH_FLAG, `--confirm=${APPLY_CONFIRM_PHRASE}`], {
    env,
    spawnImpl: (bin, args, opts = {}) => {
      if (args.includes('--version')) return { status: 0, stdout: 'psql (PostgreSQL) 16.15\n', stderr: '' };
      hosts.push(opts.env.PGHOST);
      env[URL_ENV] = `postgresql://postgres:${SECRET}@db.${REF}.supabase.co:5432/postgres?sslmode=verify-full`;
      const parsed = nonceFromArgs(args);
      if (parsed.kind === 'preflight') {
        return { status: 0, stdout: `${PREFLIGHT_SENTINEL_PREFIX}|${parsed.nonce}|EXACT_EXPECTED_LEGACY\n`, stderr: '' };
      }
      return { status: 0, stdout: `${APPLY_SENTINEL_PREFIX}|${parsed.nonce}|ok\n`, stderr: '' };
    },
  });
  assert.equal(result.code, 0);
  assert.deepEqual(hosts, [`db.${REF}.supabase.co`, `db.${REF}.supabase.co`]);
});

test('temp credential file is removed on success and failure', async () => {
  const passfiles = [];
  const ok = await capturedRun(['preflight'], {
    spawnImpl: (bin, args, opts = {}) => {
      if (opts.env && opts.env.PGPASSFILE) passfiles.push(opts.env.PGPASSFILE);
      if (args.includes('--version')) return { status: 0, stdout: 'psql (PostgreSQL) 16.15\n', stderr: '' };
      const n = nonceFromArgs(args).nonce;
      return { status: 0, stdout: `${PREFLIGHT_SENTINEL_PREFIX}|${n}|EXACT_EXPECTED_LEGACY\n`, stderr: '' };
    },
  });
  assert.equal(ok.code, 0);
  assert.equal(passfiles.length > 0, true);
  for (const p of passfiles) assert.equal(fs.existsSync(p), false);

  const fail = await capturedRun(['preflight'], {
    spawnImpl: (bin, args, opts = {}) => {
      if (opts.env && opts.env.PGPASSFILE) passfiles.push(opts.env.PGPASSFILE);
      if (args.includes('--version')) return { status: 0, stdout: 'psql (PostgreSQL) 16.15\n', stderr: '' };
      return { error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }), status: null, stdout: '', stderr: '' };
    },
  });
  assert.equal(fail.code, 1);
  for (const p of passfiles) assert.equal(fs.existsSync(p), false);
});

test('authorized apply hashes stdin for both phases and prints WRAPPER_APPLY=ok', async () => {
  const pins = loadPins();
  const inputs = [];
  const result = await capturedRun(['apply', AUTH_FLAG, `--confirm=${APPLY_CONFIRM_PHRASE}`], {
    spawnImpl: (bin, args, opts = {}) => {
      if (args.includes('--version')) return { status: 0, stdout: 'psql (PostgreSQL) 16.15\n', stderr: '' };
      inputs.push(opts.input);
      const parsed = nonceFromArgs(args);
      if (parsed.kind === 'preflight') {
        return { status: 0, stdout: `${PREFLIGHT_SENTINEL_PREFIX}|${parsed.nonce}|EXACT_EXPECTED_LEGACY\n`, stderr: '' };
      }
      return { status: 0, stdout: `${APPLY_SENTINEL_PREFIX}|${parsed.nonce}|ok\n`, stderr: '' };
    },
  });
  assert.equal(result.code, 0);
  assert.match(result.out, /WRAPPER_APPLY=ok/);
  assert.equal(inputs.length, 2);
  assert.equal(sha256Bytes(inputs[0]), pins.files.preflight.sha256);
  assert.equal(sha256Bytes(inputs[1]), pins.files.apply.sha256);
  assert.equal(result.combined.includes(SECRET), false);
});

test('parseCliArgs defaults to preflight', () => {
  assert.deepEqual(parseCliArgs([]), { mode: 'preflight', authorized: false, confirm: '' });
});

test('buildChildEnv does not spread process secrets', () => {
  const env = buildChildEnv({
    host: `db.${REF}.supabase.co`,
    port: '5432',
    database: 'postgres',
    user: 'postgres',
    password: SECRET,
  }, '/tmp/not-used');
  assert.equal(env.PGPASSWORD, undefined);
  assert.equal(env.PGSSLMODE, 'verify-full');
  assert.equal(env.PGSSLROOTCERT, SYSTEM_CA_BUNDLE);
  assert.equal(env.PSQLRC, undefined);
  assert.equal(JSON.stringify(env).includes(SECRET), false);
});

test('sanitizeText never keeps the password', () => {
  assert.equal(sanitizeText(`failed ${directUrl}`, [SECRET, directUrl]).includes(SECRET), false);
});

test('repository pinned SQL hashes currently match', () => {
  verifyPinnedSqlFiles(ROOT);
});

test('operator PG* and PSQLRC values are not inherited by the child', async () => {
  const result = await capturedRun(['preflight'], {
    extraEnv: {
      PATH: '/tmp/evil-bin',
      PGHOST: 'evil.example',
      PGHOSTADDR: '1.2.3.4',
      PGPORT: '1',
      PGDATABASE: 'other',
      PGUSER: 'authenticator',
      PGPASSWORD: 'injected',
      PGOPTIONS: '-csearch_path=public',
      PGSSLMODE: 'disable',
      PGSSLROOTCERT: '/tmp/evil.pem',
      PSQLRC: '/tmp/psqlrc',
      PGSERVICE: 'evil',
      HOME: '/tmp/evil-home',
    },
  });
  assert.equal(result.code, 0);
  const sqlCalls = result.calls.filter((c) => !(c.args || []).includes('--version'));
  assert.equal(sqlCalls.length, 1);
  const child = sqlCalls[0].opts.env;
  assert.equal(child.PGHOST, `db.${REF}.supabase.co`);
  assert.equal(child.PGPORT, '5432');
  assert.equal(child.PGDATABASE, 'postgres');
  assert.equal(child.PGUSER, 'postgres');
  assert.equal(child.PGSSLMODE, 'verify-full');
  assert.equal(child.PGSSLROOTCERT, SYSTEM_CA_BUNDLE);
  assert.equal(child.PATH, '');
  assert.equal(Object.hasOwn(child, 'PGPASSWORD'), false);
  assert.equal(Object.hasOwn(child, 'PGOPTIONS'), false);
  assert.equal(Object.hasOwn(child, 'PSQLRC'), false);
  assert.equal(Object.hasOwn(child, 'PGSERVICE'), false);
  assert.equal(Object.hasOwn(child, 'HOME'), false);
  assert.equal(Object.hasOwn(child, 'PGHOSTADDR'), false);
});

test('PATH-discovered psql is not used even when a fake binary exists', async () => {
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtp-path-psql-'));
  fs.chmodSync(fakeDir, 0o700);
  const fakeBin = path.join(fakeDir, 'psql');
  fs.writeFileSync(fakeBin, '#!/bin/sh\necho hijacked\n');
  fs.chmodSync(fakeBin, 0o755);
  const digest = createHash('sha256').update(fs.readFileSync(fakeBin)).digest('hex');
  const result = await capturedRun(['preflight'], {
    env: {
      [URL_ENV]: directUrl,
      [PSQL_SHA_ENV]: digest,
      PATH: fakeDir,
    },
  });
  assert.equal(result.code, 1);
  assert.match(result.err, /absolute psql path/);
  assert.equal(result.calls.length, 0);
  fs.rmSync(fakeDir, { recursive: true, force: true });
});

test('arbitrary executable override is rejected unless it is pinned psql', async () => {
  const bin = '/usr/bin/true';
  const digest = createHash('sha256').update(fs.readFileSync(bin)).digest('hex');
  const result = await capturedRun(['preflight'], {
    env: {
      [URL_ENV]: directUrl,
      [PSQL_PATH_ENV]: bin,
      [PSQL_SHA_ENV]: digest,
    },
    spawnImpl: (_file, args) => {
      if (args.includes('--version')) {
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 0, stdout: 'should-not-run\n', stderr: '' };
    },
  });
  assert.equal(result.code, 1);
  assert.match(result.err, /version is not an approved PostgreSQL/);
  assert.equal(result.calls.filter((c) => !(c.args || []).includes('--version')).length, 0);
});

test('stderr NOTICE/HINT cannot satisfy the sentinel parser', async () => {
  const result = await capturedRun(['preflight'], {
    spawnImpl: (bin, args) => {
      if (args.includes('--version')) return { status: 0, stdout: 'psql (PostgreSQL) 16.15\n', stderr: '' };
      const n = nonceFromArgs(args).nonce;
      return {
        status: 0,
        stdout: '',
        stderr: `NOTICE: ${PREFLIGHT_SENTINEL_PREFIX}|${n}|EXACT_EXPECTED_LEGACY\n`,
      };
    },
  });
  assert.equal(result.code, 1);
  assert.match(result.err, /unexpected stderr|sentinel/);
});

test('child signal aborts and removes the credential file', async () => {
  const passfiles = [];
  const result = await capturedRun(['preflight'], {
    spawnImpl: (bin, args, opts = {}) => {
      if (opts.env && opts.env.PGPASSFILE) passfiles.push(opts.env.PGPASSFILE);
      if (args.includes('--version')) return { status: 0, stdout: 'psql (PostgreSQL) 16.15\n', stderr: '' };
      return { status: null, signal: 'SIGTERM', stdout: '', stderr: '' };
    },
  });
  assert.equal(result.code, 1);
  assert.match(result.err, /signaled/);
  for (const p of passfiles) assert.equal(fs.existsSync(p), false);
});

test('apply refuses if the captured URL mutates before the second phase', async () => {
  const env = operatorEnv();
  const captured = env[URL_ENV];
  const result = await capturedRun(['apply', AUTH_FLAG, `--confirm=${APPLY_CONFIRM_PHRASE}`], {
    env,
    spawnImpl: (bin, args) => {
      if (args.includes('--version')) return { status: 0, stdout: 'psql (PostgreSQL) 16.15\n', stderr: '' };
      env[URL_ENV] = `${captured}&application_name=mutated`;
      const parsed = nonceFromArgs(args);
      if (parsed.kind === 'preflight') {
        return { status: 0, stdout: `${PREFLIGHT_SENTINEL_PREFIX}|${parsed.nonce}|EXACT_EXPECTED_LEGACY\n`, stderr: '' };
      }
      return { status: 0, stdout: `${APPLY_SENTINEL_PREFIX}|${parsed.nonce}|ok\n`, stderr: '' };
    },
  });
  assert.equal(result.code, 1);
  assert.match(result.err, /connection value changed/);
  assert.equal(result.calls.filter((c) => nonceFromArgs(c.args).kind === 'apply').length, 0);
});

test('hash-then-replace during apply uses original hashed bytes for both phases', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rtp-sql-apply-toctou-'));
  fs.cpSync(path.join(ROOT, 'supabase'), path.join(tmp, 'supabase'), { recursive: true });
  const applyPath = path.join(tmp, 'supabase/security/unapplied-do-not-run/NOT_APPLIED_revoke_postgrest_tax_profiles.sql');
  const original = fs.readFileSync(applyPath);
  const pins = loadPins();
  const result = await capturedRun(['apply', AUTH_FLAG, `--confirm=${APPLY_CONFIRM_PHRASE}`], {
    repoRoot: tmp,
    spawnImpl: (bin, args, opts = {}) => {
      if (args.includes('--version')) return { status: 0, stdout: 'psql (PostgreSQL) 16.15\n', stderr: '' };
      fs.appendFileSync(applyPath, '\n-- replaced-after-hash\n');
      const parsed = nonceFromArgs(args);
      if (parsed.kind === 'apply') {
        assert.equal(sha256Bytes(opts.input), pins.files.apply.sha256);
        assert.equal(sha256Bytes(opts.input), sha256Bytes(original));
        assert.equal(opts.input.includes('replaced-after-hash'), false);
        assert.equal(args.includes('-f'), false);
        return { status: 0, stdout: `${APPLY_SENTINEL_PREFIX}|${parsed.nonce}|ok\n`, stderr: '' };
      }
      return { status: 0, stdout: `${PREFLIGHT_SENTINEL_PREFIX}|${parsed.nonce}|EXACT_EXPECTED_LEGACY\n`, stderr: '' };
    },
  });
  assert.equal(result.code, 0);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('operator-owned psql is rejected in real execution mode', async () => {
  const result = await capturedRun(['preflight'], { psqlTrust: PSQL_PRODUCTION_TRUST });
  assert.equal(result.code, 1);
  assert.match(result.err, /file owner is not root/);
  assert.equal(result.calls.filter((c) => !(c.args || []).includes('--version')).length, 0);

  const flagged = await capturedRun(['preflight', '--psql-trust=test'], { psqlTrust: PSQL_PRODUCTION_TRUST });
  assert.equal(flagged.code, 1);
  assert.match(flagged.err, /unrecognized flag/);
});

test('root-owned distro psql with root-owned parents passes trust checks', async () => {
  const digest = createHash('sha256').update(fs.readFileSync(DISTRO_PSQL)).digest('hex');
  const handle = await verifyPsqlBinary({
    [PSQL_PATH_ENV]: DISTRO_PSQL,
    [PSQL_SHA_ENV]: digest,
  }, spawnSync, { trust: PSQL_PRODUCTION_TRUST, useFdExec: false });
  assert.equal(handle.path, DISTRO_PSQL);
  assert.equal(handle.identity.uid, 0);
  assert.equal(handle.identity.digest, digest);
  fs.closeSync(handle.fd);
});

test('inode or hash change between validation and spawn aborts before apply', async () => {
  const psql = dummyPsql();
  const result = await capturedRun(['apply', AUTH_FLAG, `--confirm=${APPLY_CONFIRM_PHRASE}`], {
    psql,
    spawnImpl: (bin, args) => {
      if (args.includes('--version')) {
        fs.unlinkSync(psql.bin);
        fs.writeFileSync(psql.bin, '#!/bin/sh\necho hijacked\n');
        fs.chmodSync(psql.bin, 0o755);
        return { status: 0, stdout: 'psql (PostgreSQL) 16.15\n', stderr: '' };
      }
      return { status: 0, stdout: 'should-not-run\n', stderr: '' };
    },
  });
  assert.equal(result.code, 1);
  assert.match(result.err, /identity changed after validation/);
  assert.equal(result.calls.filter((c) => nonceFromArgs(c.args).kind === 'apply').length, 0);
  assert.equal(result.calls.filter((c) => nonceFromArgs(c.args).kind === 'preflight').length, 0);
});

test('fake psql replacement cannot reach apply', async () => {
  const psql = dummyPsql();
  const result = await capturedRun(['apply', AUTH_FLAG, `--confirm=${APPLY_CONFIRM_PHRASE}`], {
    psql,
    spawnImpl: (bin, args) => {
      if (args.includes('--version')) {
        fs.appendFileSync(psql.bin, '# replaced\n');
        return { status: 0, stdout: 'psql (PostgreSQL) 16.15\n', stderr: '' };
      }
      const parsed = nonceFromArgs(args);
      return {
        status: 0,
        stdout: parsed.kind === 'preflight'
          ? `${PREFLIGHT_SENTINEL_PREFIX}|${parsed.nonce}|EXACT_EXPECTED_LEGACY\n`
          : `${APPLY_SENTINEL_PREFIX}|${parsed.nonce}|ok\n`,
        stderr: '',
      };
    },
  });
  assert.equal(result.code, 1);
  assert.match(result.err, /identity changed after validation/);
  assert.equal(result.calls.filter((c) => nonceFromArgs(c.args).kind === 'apply').length, 0);
});

test('wrong or missing authorized Git SHA fails', async () => {
  const wrong = await capturedRun(['preflight'], {
    env: {
      [URL_ENV]: directUrl,
      [GIT_SHA_ENV]: '0'.repeat(40),
      [PSQL_PATH_ENV]: dummyPsql().bin,
      [PSQL_SHA_ENV]: '0'.repeat(64),
    },
    headSha: STUB_GIT_SHA,
  });
  assert.equal(wrong.code, 1);
  assert.match(wrong.err, /HEAD does not match the authorized commit SHA/);

  let err = '';
  const psql = dummyPsql();
  const code = await runCli({
    argv: ['preflight'],
    env: {
      [URL_ENV]: directUrl,
      [PSQL_PATH_ENV]: psql.bin,
      [PSQL_SHA_ENV]: psql.digest,
    },
    spawnImpl: () => ({ status: 0, stdout: '', stderr: '' }),
    stdout: { write: () => {} },
    stderr: { write: (s) => { err += s; } },
    psqlTrust: TEST_PSQL_TRUST,
    gitRun: stubGit(),
    installSignals: () => () => {},
    exitImpl: () => {},
  });
  assert.equal(code, 1);
  assert.match(err, /must be the full 40-character commit SHA/);

  const detached = await capturedRun(['preflight'], { detached: true });
  assert.equal(detached.code, 1);
  assert.match(detached.err, /detached HEAD is refused/);
});

test('git binary override env is refused', async () => {
  const execPath = await capturedRun(['preflight'], {
    extraEnv: { GIT_EXEC_PATH: '/tmp/evil-git-exec' },
  });
  assert.equal(execPath.code, 1);
  assert.match(execPath.err, /git binary override is refused/);

  const wrapperGit = await capturedRun(['preflight'], {
    extraEnv: { CHECKSOPS_TAX_CONTAINMENT_GIT: '/tmp/evil-git' },
  });
  assert.equal(wrapperGit.code, 1);
  assert.match(wrapperGit.err, /git binary override is refused/);
});

test('dirty security-package paths fail Git authorization', async () => {
  const dirtyTracked = await capturedRun(['preflight'], {
    statusStdout: ' M supabase/security/hosted-tax-profile-containment.pins.json\n',
  });
  assert.equal(dirtyTracked.code, 1);
  assert.match(dirtyTracked.err, /dirty or staged tracked files/);

  const untracked = await capturedRun(['preflight'], {
    statusStdout: '?? supabase/security/evil.sql\n',
  });
  assert.equal(untracked.code, 1);
  assert.match(untracked.err, /untracked files are present in the security package/);
});

test('exact clean reviewed SHA on a named branch passes', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rtp-git-clean-'));
  fs.cpSync(path.join(ROOT, 'supabase'), path.join(tmp, 'supabase'), { recursive: true });
  const git = (args) => spawnSync('git', args, { cwd: tmp, encoding: 'utf8' });
  git(['init', '-b', 'review']);
  git(['config', 'user.email', 'review@example.test']);
  git(['config', 'user.name', 'review']);
  git(['add', '.']);
  git(['commit', '-q', '-m', 'reviewed']);
  const sha = git(['rev-parse', 'HEAD']).stdout.trim();
  assert.match(sha, /^[0-9a-f]{40}$/);
  assert.equal(verifyRepoState(tmp, sha), sha);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('git authorization uses allowlisted absolute binary and ignores PATH', () => {
  const trusted = resolveTrustedGit(GIT_PRODUCTION_TRUST);
  assert.equal(ALLOWED_GIT_BINS.includes(trusted.path), true);
  assert.match(trusted.identity.digest, /^[0-9a-f]{64}$/);
  const again = revalidateGitHandle(trusted, GIT_PRODUCTION_TRUST);
  assert.equal(again.path, trusted.path);
  assert.throws(
    () => revalidateGitHandle({ path: '/tmp/git', identity: trusted.identity }, TEST_GIT_TRUST),
    /not in the reviewed allowlist/,
  );

  const hijack = fs.mkdtempSync(path.join(os.tmpdir(), 'rtp-git-hijack-'));
  fs.writeFileSync(path.join(hijack, 'git'), '#!/bin/sh\necho hijacked >&2\nexit 42\n');
  fs.chmodSync(path.join(hijack, 'git'), 0o755);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rtp-git-path-'));
  fs.cpSync(path.join(ROOT, 'supabase'), path.join(tmp, 'supabase'), { recursive: true });
  const git = (args) => spawnSync('git', args, { cwd: tmp, encoding: 'utf8' });
  git(['init', '-b', 'review']);
  git(['config', 'user.email', 'review@example.test']);
  git(['config', 'user.name', 'review']);
  git(['add', '.']);
  git(['commit', '-q', '-m', 'reviewed']);
  const sha = git(['rev-parse', 'HEAD']).stdout.trim();
  const prevPath = process.env.PATH;
  process.env.PATH = `${hijack}:/no/such/git:${prevPath || ''}`;
  try {
    assert.equal(verifyRepoState(tmp, sha), sha);
    const runner = makeDefaultGitRun(GIT_PRODUCTION_TRUST);
    const inside = runner(tmp, ['rev-parse', '--is-inside-work-tree']);
    assert.equal(inside.status, 0);
    assert.equal(String(inside.stdout).trim(), 'true');
    assert.doesNotMatch(String(inside.stderr || ''), /hijacked/);
  } finally {
    process.env.PATH = prevPath;
    fs.rmSync(hijack, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('pins symlink, extra keys, traversal, and malformed hashes fail', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rtp-pins-'));
  fs.cpSync(path.join(ROOT, 'supabase'), path.join(tmp, 'supabase'), { recursive: true });
  const pinsPath = path.join(tmp, 'supabase/security/hosted-tax-profile-containment.pins.json');
  const original = fs.readFileSync(pinsPath, 'utf8');

  const pins = JSON.parse(original);
  pins.extra = true;
  fs.writeFileSync(pinsPath, JSON.stringify(pins));
  const extra = await capturedRun(['preflight'], { repoRoot: tmp });
  assert.equal(extra.code, 1);
  assert.match(extra.err, /missing or extra keys/);

  fs.writeFileSync(pinsPath, original);
  const bad = JSON.parse(original);
  bad.files.preflight.sha256 = 'ZZ';
  fs.writeFileSync(pinsPath, JSON.stringify(bad));
  const malformed = await capturedRun(['preflight'], { repoRoot: tmp });
  assert.equal(malformed.code, 1);
  assert.match(malformed.err, /hash is invalid/);

  fs.writeFileSync(pinsPath, original);
  const trav = JSON.parse(original);
  trav.files.preflight.path = '../migrations/evil.sql';
  fs.writeFileSync(pinsPath, JSON.stringify(trav));
  const traversal = await capturedRun(['preflight'], { repoRoot: tmp });
  assert.equal(traversal.code, 1);
  assert.match(traversal.err, /path is invalid|not the reviewed preflight file|pins schema/);

  fs.writeFileSync(pinsPath, original);
  const backup = `${pinsPath}.orig`;
  fs.renameSync(pinsPath, backup);
  fs.symlinkSync(backup, pinsPath);
  const linked = await capturedRun(['preflight'], { repoRoot: tmp });
  assert.equal(linked.code, 1);
  assert.match(linked.err, /symlink/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('SIGINT and SIGTERM clean the passfile and do not continue apply', async () => {
  const passfiles = [];
  let handler = null;
  const result = await capturedRun(['apply', AUTH_FLAG, `--confirm=${APPLY_CONFIRM_PHRASE}`], {
    installSignals: (h) => { handler = h; return () => {}; },
    spawnImpl: (bin, args, opts = {}) => {
      if (opts.env && opts.env.PGPASSFILE) passfiles.push(opts.env.PGPASSFILE);
      if (args.includes('--version')) return { status: 0, stdout: 'psql (PostgreSQL) 16.15\n', stderr: '' };
      handler();
      return { status: 0, stdout: 'should-not-finish\n', stderr: '' };
    },
  });
  assert.equal(result.code, 1);
  assert.match(result.err, /interrupted/);
  for (const p of passfiles) assert.equal(fs.existsSync(p), false);
  assert.equal(result.calls.filter((c) => nonceFromArgs(c.args).kind === 'apply').length, 0);

  const wrapperSrc = fs.readFileSync(path.join(ROOT, 'scripts/run-hosted-tax-profile-containment.mjs'), 'utf8');
  assert.match(wrapperSrc, /process\.on\('SIGINT'/);
  assert.match(wrapperSrc, /process\.on\('SIGTERM'/);
});

test('handleExecutionSignal kills the child and removes the passfile', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-tax-pg-'));
  fs.chmodSync(dir, 0o700);
  const passPath = path.join(dir, 'pgpass');
  fs.writeFileSync(passPath, 'x', { mode: 0o600 });
  let killed = false;
  let exitCode = null;
  handleExecutionSignal({
    passHandle: { dir, passPath },
    killChild: () => { killed = true; },
    exit: (code) => { exitCode = code; },
    exiting: false,
  });
  assert.equal(killed, true);
  assert.equal(exitCode, 1);
  assert.equal(fs.existsSync(passPath), false);
});

test('stale cleanup accepts only the exact safe fixture shape', () => {
  const name = 'checksops-tax-pg-safex1';
  const dir = path.join(os.tmpdir(), name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const passPath = path.join(dir, 'pgpass');
  fs.writeFileSync(passPath, 'secret\n', { mode: 0o600 });
  fs.chmodSync(passPath, 0o600);
  const old = new Date(Date.now() - STALE_PASSDIR_MIN_AGE_MS - 1000);
  fs.utimesSync(dir, old, old);
  const result = cleanupStalePassDirs({ nowMs: Date.now(), minAgeMs: STALE_PASSDIR_MIN_AGE_MS });
  assert.equal(result.removed.includes(name), true);
  assert.equal(fs.existsSync(dir), false);
});

test('stale cleanup rejects symlinks, unexpected contents, wrong mode/owner, and recent directories', () => {
  const tmp = os.tmpdir();
  const recent = path.join(tmp, 'checksops-tax-pg-rcnt01');
  const extra = path.join(tmp, 'checksops-tax-pg-extra1');
  const modeDir = path.join(tmp, 'checksops-tax-pg-mode01');
  const linked = path.join(tmp, 'checksops-tax-pg-link01');
  const target = path.join(tmp, 'checksops-tax-pg-target');
  const ownerDir = path.join(tmp, 'checksops-tax-pg-owner1');
  for (const p of [recent, extra, modeDir, linked, target, ownerDir]) fs.rmSync(p, { recursive: true, force: true });

  fs.mkdirSync(recent, { mode: 0o700 });
  fs.chmodSync(recent, 0o700);
  fs.writeFileSync(path.join(recent, 'pgpass'), 'x', { mode: 0o600 });
  fs.chmodSync(path.join(recent, 'pgpass'), 0o600);

  fs.mkdirSync(extra, { mode: 0o700 });
  fs.chmodSync(extra, 0o700);
  fs.writeFileSync(path.join(extra, 'pgpass'), 'x', { mode: 0o600 });
  fs.writeFileSync(path.join(extra, 'other'), 'nope');
  const old = new Date(Date.now() - STALE_PASSDIR_MIN_AGE_MS - 1000);
  fs.utimesSync(extra, old, old);

  fs.mkdirSync(modeDir, { mode: 0o700 });
  fs.chmodSync(modeDir, 0o777);
  fs.writeFileSync(path.join(modeDir, 'pgpass'), 'x', { mode: 0o600 });
  fs.utimesSync(modeDir, old, old);

  fs.mkdirSync(target, { mode: 0o700 });
  fs.symlinkSync(target, linked);

  fs.mkdirSync(ownerDir, { mode: 0o700 });
  fs.chmodSync(ownerDir, 0o700);
  fs.writeFileSync(path.join(ownerDir, 'pgpass'), 'x', { mode: 0o600 });
  fs.chmodSync(path.join(ownerDir, 'pgpass'), 0o600);
  fs.utimesSync(ownerDir, old, old);
  const ownerSkip = cleanupStalePassDirs({
    uid: process.getuid() + 1,
    nowMs: Date.now(),
    minAgeMs: STALE_PASSDIR_MIN_AGE_MS,
  });
  assert.equal(ownerSkip.removed.includes('checksops-tax-pg-owner1'), false);
  assert.equal(ownerSkip.skipped.some((row) => row.name === 'checksops-tax-pg-owner1' && row.reason === 'owner'), true);
  assert.equal(fs.existsSync(ownerDir), true);

  const result = cleanupStalePassDirs({ nowMs: Date.now(), minAgeMs: STALE_PASSDIR_MIN_AGE_MS });
  const skipped = new Set(result.skipped.map((row) => row.name));
  assert.equal(skipped.has('checksops-tax-pg-rcnt01'), true);
  assert.equal(skipped.has('checksops-tax-pg-extra1'), true);
  assert.equal(skipped.has('checksops-tax-pg-mode01'), true);
  assert.equal(skipped.has('checksops-tax-pg-link01'), true);
  assert.equal(result.removed.includes('checksops-tax-pg-rcnt01'), false);
  assert.equal(result.removed.includes('checksops-tax-pg-owner1'), true);
  assert.equal(fs.existsSync(recent), true);
  assert.equal(fs.existsSync(extra), true);
  assert.equal(fs.existsSync(ownerDir), false);
  fs.rmSync(recent, { recursive: true, force: true });
  fs.rmSync(extra, { recursive: true, force: true });
  fs.rmSync(modeDir, { recursive: true, force: true });
  fs.rmSync(linked, { recursive: true, force: true });
  fs.rmSync(target, { recursive: true, force: true });
  fs.rmSync(ownerDir, { recursive: true, force: true });
});

test('production fd exec with argv0 yields empty stderr for distro psql --version', async () => {
  const digest = createHash('sha256').update(fs.readFileSync(DISTRO_PSQL)).digest('hex');
  const handle = await verifyPsqlBinary({
    [PSQL_PATH_ENV]: DISTRO_PSQL,
    [PSQL_SHA_ENV]: digest,
  }, defaultAsyncSpawn, { trust: PSQL_PRODUCTION_TRUST, useFdExec: true });
  assert.equal(handle.identity.uid, 0);
  const probe = await defaultAsyncSpawn(`/proc/self/fd/${handle.fd}`, ['--version'], {
    env: { LC_ALL: 'C', LANG: 'C', PATH: '' },
    timeout: VERSION_TIMEOUT_MS,
    argv0: DISTRO_PSQL,
    input: Buffer.alloc(0),
  });
  assert.equal(probe.status, 0);
  assert.equal(String(probe.stderr || '').trim(), '');
  assert.match(String(probe.stdout), /psql \(PostgreSQL\) (16|17|18)\./);
  const broken = await defaultAsyncSpawn(`/proc/self/fd/${handle.fd}`, ['--version'], {
    env: { LC_ALL: 'C', LANG: 'C', PATH: '' },
    timeout: VERSION_TIMEOUT_MS,
    input: Buffer.alloc(0),
  });
  assert.match(String(broken.stderr || ''), /invalid binary/);
  fs.closeSync(handle.fd);
});

test('async spawn SIGTERM kills the child and removes the passfile', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-tax-pg-'));
  fs.chmodSync(dir, 0o700);
  const passPath = path.join(dir, 'pgpass');
  fs.writeFileSync(passPath, 'x', { mode: 0o600 });
  fs.chmodSync(passPath, 0o600);
  let child = null;
  const spawned = defaultAsyncSpawn('/bin/sleep', ['30'], {
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
    timeout: 8_000,
    onChild: (c) => { child = c; },
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(child != null, true);
  handleExecutionSignal({
    passHandle: { dir, passPath },
    killChild: () => { if (child) child.kill('SIGTERM'); },
    exit: () => {},
    exiting: false,
  });
  const result = await spawned;
  assert.equal(result.signal, 'SIGTERM');
  assert.equal(fs.existsSync(passPath), false);
});

test('async spawn timeout sends SIGTERM to the child', async () => {
  const start = Date.now();
  const result = await defaultAsyncSpawn('/bin/sleep', ['30'], {
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
    timeout: 400,
  });
  assert.equal(result.error && result.error.code, 'ETIMEDOUT');
  assert.equal(result.signal, 'SIGTERM');
  assert.equal(Date.now() - start < 3000, true);
});
