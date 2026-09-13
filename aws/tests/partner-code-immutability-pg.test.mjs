import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.join(ROOT, '..');
const PG_BIN = '/usr/lib/postgresql/16/bin';
const ARTIFACT_DIR = '/opt/cursor/artifacts';
const MIGRATION = path.join(
  REPO,
  'supabase/migrations/20260913120000_partner_code_immutability.sql',
);
const GENERATOR_MIGRATION = path.join(
  REPO,
  'supabase/migrations/20260423135856_a1bb94d3-b8af-4a1a-b2af-aa3e19e6c3c5.sql',
);

const EXISTING_SYNTHETIC = 'A1B2C3D4';
const DUPLICATE_SYNTHETIC = 'B2C3D4E5';
const ATTEMPTED_NEW = 'C3D4E5F6';
const HEX8 = /^[0-9A-F]{8}$/;

const redacted = (value) => createHash('sha256').update(String(value || '')).digest('hex').slice(0, 12);

const run = (bin, args, opts = {}) => spawnSync(bin, args, {
  encoding: 'utf8',
  maxBuffer: 20 * 1024 * 1024,
  ...opts,
});

const mustRun = (bin, args, opts = {}) => {
  const result = run(bin, args, opts);
  if (result.status !== 0) {
    throw new Error(`${bin} ${args.join(' ')} failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return result;
};

const uncommented = (sql) => sql
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');

test('immutability SQL only replaces assign_tenant_partner_code and does not rewrite rows', () => {
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  const body = uncommented(sql);
  assert.match(body, /CREATE OR REPLACE FUNCTION public\.assign_tenant_partner_code\(\)/);
  assert.match(body, /TG_OP = 'INSERT'/);
  assert.match(body, /tenants\.partner_code is immutable once assigned/);
  assert.match(body, /ERRCODE = '23001'/);
  assert.match(body, /CREATE TRIGGER trg_assign_tenant_partner_code/);
  assert.equal(/CREATE OR REPLACE FUNCTION public\.generate_partner_code_value/.test(body), false);
  assert.equal(/tenant_partner_code_aliases/.test(body), false);
  assert.equal(/lookup_tenant_by_partner_code/.test(body), false);
  assert.equal(/shared_checks/.test(body), false);
  assert.equal(/UPDATE\s+public\.tenants/i.test(body), false);
  assert.equal(/SET\s+partner_code\s*=/i.test(body), false);
});

test('disposable PostgreSQL Partner Code immutability matrix', { timeout: 180000 }, async (t) => {
  assert.equal(fs.existsSync(path.join(PG_BIN, 'initdb')), true);
  assert.equal(fs.existsSync(MIGRATION), true);
  assert.equal(fs.existsSync(GENERATOR_MIGRATION), true);

  const stamp = `${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}_${process.pid}`;
  const pgData = fs.mkdtempSync(path.join(os.tmpdir(), `pg-partner-code-${stamp}-`));
  const port = 55200 + (process.pid % 1000);
  const logPath = path.join(pgData, 'pg.log');
  const artifactLog = path.join(ARTIFACT_DIR, `partner_code_immutability_pg_${stamp}.log`);
  let started = false;
  const logChunks = [];
  const note = (line) => { logChunks.push(line); };

  const stopCluster = () => {
    if (started) {
      run(path.join(PG_BIN, 'pg_ctl'), ['-D', pgData, '-m', 'immediate', 'stop']);
      started = false;
    }
    fs.rmSync(pgData, { recursive: true, force: true });
  };
  t.after(() => {
    try {
      fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
      fs.writeFileSync(artifactLog, logChunks.join('\n'), 'utf8');
    } catch { /* ignore artifact write failures */ }
    stopCluster();
  });

  mustRun(path.join(PG_BIN, 'initdb'), [
    '-D', pgData,
    '--auth=trust',
    '--no-sync',
    '--username=ubuntu',
    '--encoding=UTF8',
  ]);
  fs.appendFileSync(path.join(pgData, 'postgresql.conf'), `
listen_addresses = ''
port = ${port}
unix_socket_directories = '${pgData}'
logging_collector = off
shared_buffers = 32MB
max_connections = 20
`);
  mustRun(path.join(PG_BIN, 'pg_ctl'), ['-D', pgData, '-l', logPath, '-w', 'start']);
  started = true;

  const psqlArgs = ['-h', pgData, '-p', String(port), '-U', 'ubuntu', '-v', 'ON_ERROR_STOP=1', '-d', 'postgres'];
  const psql = (extra, input) => {
    const result = run(path.join(PG_BIN, 'psql'), [...psqlArgs, ...extra], input ? { input } : {});
    if (result.status !== 0) {
      throw new Error(`psql failed: ${result.stderr || result.stdout}`);
    }
    return result;
  };
  const query = (sql) => {
    const result = psql(['-Atq', '-F', '\t'], sql.endsWith('\n') ? sql : `${sql}\n`);
    const lines = result.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
      .filter((line) => !/^(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|COMMENT)\b/.test(line));
    return lines.join('\n');
  };
  const expectFail = (sql) => {
    const result = run(
      path.join(PG_BIN, 'psql'),
      [...psqlArgs],
      { input: `\\set VERBOSITY verbose\n${sql}\n` },
    );
    assert.notEqual(result.status, 0, 'expected failure for Partner Code mutation');
    return `${result.stderr || ''}\n${result.stdout || ''}`;
  };

  const generatorSrc = fs.readFileSync(GENERATOR_MIGRATION, 'utf8');
  const generatorMatch = generatorSrc.match(
    /CREATE OR REPLACE FUNCTION public\.generate_partner_code_value\(\)[\s\S]*?\$\$;/,
  );
  assert.ok(generatorMatch, 'existing generate_partner_code_value definition');

  psql([], `
CREATE TABLE public.tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  partner_code text UNIQUE,
  notes text
);
${generatorMatch[0]}
CREATE OR REPLACE FUNCTION public.assign_tenant_partner_code()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.partner_code IS NULL OR btrim(NEW.partner_code) = '' THEN
    NEW.partner_code := public.generate_partner_code_value();
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_assign_tenant_partner_code
BEFORE INSERT OR UPDATE OF partner_code ON public.tenants
FOR EACH ROW
EXECUTE FUNCTION public.assign_tenant_partner_code();
INSERT INTO public.tenants (name, slug, partner_code)
VALUES ('Existing Tenant', 'existing-tenant', '${EXISTING_SYNTHETIC}');
`);

  const beforeHash = redacted(query("SELECT partner_code FROM public.tenants WHERE slug = 'existing-tenant'"));
  note(`pre-migration existing code sha256-12=${beforeHash}`);

  psql([], fs.readFileSync(MIGRATION, 'utf8'));
  const afterHash = redacted(query("SELECT partner_code FROM public.tenants WHERE slug = 'existing-tenant'"));
  note(`post-migration existing code sha256-12=${afterHash}`);
  assert.equal(afterHash, beforeHash, '9 existing Partner Codes remain unchanged');
  assert.equal(
    query("SELECT partner_code FROM public.tenants WHERE slug = 'existing-tenant'"),
    EXISTING_SYNTHETIC,
  );

  const generated = query(`
INSERT INTO public.tenants (name, slug)
VALUES ('Generated Tenant', 'generated-tenant')
RETURNING partner_code;
`);
  assert.match(generated, HEX8, '1 INSERT without code generates; 2 format valid');
  note(`generated tenant A sha256-12=${redacted(generated)} len=${generated.length}`);

  const generatedB = query(`
INSERT INTO public.tenants (name, slug)
VALUES ('Generated Tenant B', 'generated-tenant-b')
RETURNING partner_code;
`);
  assert.match(generatedB, HEX8);
  assert.notEqual(generatedB, generated, '3 second tenant receives a different code');
  note(`generated tenant B sha256-12=${redacted(generatedB)}`);

  const changeErr = expectFail(`UPDATE public.tenants SET partner_code = '${ATTEMPTED_NEW}' WHERE slug = 'existing-tenant';`);
  assert.match(changeErr, /partner_code is immutable once assigned/, '4 UPDATE A -> B DENY');
  assert.match(changeErr, /23001/);

  const nullErr = expectFail("UPDATE public.tenants SET partner_code = NULL WHERE slug = 'existing-tenant';");
  assert.match(nullErr, /partner_code is immutable once assigned/, '5 UPDATE A -> NULL DENY');

  const blankErr = expectFail("UPDATE public.tenants SET partner_code = '' WHERE slug = 'existing-tenant';");
  assert.match(blankErr, /partner_code is immutable once assigned/, '6 UPDATE A -> blank DENY');

  const sameCount = query(`
UPDATE public.tenants SET partner_code = '${EXISTING_SYNTHETIC}' WHERE slug = 'existing-tenant';
SELECT partner_code FROM public.tenants WHERE slug = 'existing-tenant';
`);
  assert.equal(sameCount, EXISTING_SYNTHETIC, '7 UPDATE A -> same A PASS');

  query("UPDATE public.tenants SET notes = 'ordinary update' WHERE slug = 'existing-tenant';");
  assert.equal(
    query("SELECT notes || ':' || partner_code FROM public.tenants WHERE slug = 'existing-tenant'"),
    `ordinary update:${EXISTING_SYNTHETIC}`,
    '8 ordinary unrelated tenant UPDATE PASS',
  );

  query(`
INSERT INTO public.tenants (name, slug, partner_code)
VALUES ('Duplicate Probe', 'duplicate-probe', '${DUPLICATE_SYNTHETIC}');
`);
  const uniqueErr = expectFail(`
INSERT INTO public.tenants (name, slug, partner_code)
VALUES ('Duplicate Probe Two', 'duplicate-probe-two', '${DUPLICATE_SYNTHETIC}');
`);
  assert.match(uniqueErr, /duplicate key|unique/i, '10 uniqueness remains enforced');

  const stillExisting = query("SELECT partner_code FROM public.tenants WHERE slug = 'existing-tenant'");
  const stillGenerated = query("SELECT partner_code FROM public.tenants WHERE slug = 'generated-tenant'");
  assert.equal(stillExisting, EXISTING_SYNTHETIC);
  assert.equal(stillGenerated, generated);
  note('matrix PASS 1-10; no production rows modified');
});
