import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OLD_MIGRATION = '20260912114853_revoke_postgrest_tax_profiles.sql';
const APPLY_REL = 'supabase/security/unapplied-do-not-run/NOT_APPLIED_revoke_postgrest_tax_profiles.sql';
const APPLY = path.join(ROOT, APPLY_REL);
const PREFLIGHT = path.join(ROOT, 'supabase/security/preflight_gate_revoke_postgrest_tax_profiles.sql');
const INVENTORY = path.join(ROOT, 'supabase/security/preflight_inventory.sql');
const FIXTURE = path.join(ROOT, 'supabase/security/fixtures/legacy_recipient_tax_profiles.sql');
const ROLLBACK_DOC = path.join(ROOT, 'supabase/security/EMERGENCY_ROLLBACK_revoke_postgrest_tax_profiles.md');
const RUNBOOK = path.join(ROOT, 'supabase/security/revoke_postgrest_tax_profiles.md');
const PG_BIN = '/usr/lib/postgresql/16/bin';
const SYNTHETIC = 'SYNTHETIC_PLACEHOLDER_NOT_A_TIN';
const HOSTED_REF = 'nbcqwpysqgyxrrbgtmkw';

const sql = fs.readFileSync(APPLY, 'utf8');
const preflightSql = fs.readFileSync(PREFLIGHT, 'utf8');
const inventorySql = fs.readFileSync(INVENTORY, 'utf8');
const rollbackDoc = fs.readFileSync(ROLLBACK_DOC, 'utf8');
const runbook = fs.readFileSync(RUNBOOK, 'utf8');

let clusterDir = null;
let pgPort = 0;
let keepCluster = false;

function run(bin, args, opts = {}) {
  const result = spawnSync(bin, args, {
    encoding: 'utf8',
    env: { ...process.env, ...(opts.env || {}) },
    input: opts.input,
  });
  if (result.status !== 0 && opts.allowFail !== true) {
    const err = (result.stderr || result.stdout || '').trim();
    throw new Error(`${bin} ${args.join(' ')}\n${err}`);
  }
  return result;
}

function psql(database, extraArgs = [], opts = {}) {
  return run(path.join(PG_BIN, 'psql'), [
    '-v', 'ON_ERROR_STOP=1',
    '-X',
    '-d', database,
    '-h', opts.host || '127.0.0.1',
    '-p', String(pgPort),
    '-U', opts.user || process.env.USER,
    ...extraArgs,
  ], opts);
}

function identityArgs(database, overrides = {}) {
  return [
    '-v', `expected_project_ref=${overrides.projectRef ?? HOSTED_REF}`,
    '-v', `expected_database=${overrides.database ?? database}`,
    '-v', `expected_owner=${overrides.owner ?? process.env.USER}`,
  ];
}

function applySql(database, opts = {}) {
  return psql(database, [...identityArgs(database, opts), '-f', APPLY], {
    allowFail: opts.allowFail === true,
  });
}

function runPreflight(database, opts = {}) {
  return psql(database, [...identityArgs(database, opts), '-f', PREFLIGHT], {
    allowFail: opts.allowFail === true,
  });
}

function scalar(database, query) {
  const result = psql(database, ['-tA', '-c', query]);
  const lines = (result.stdout || '').trim().split('\n').filter((line) => (
    line.length > 0 && line !== 'SET' && !/^(UPDATE|INSERT|DELETE)\s+\d+$/.test(line)
  ));
  return lines[lines.length - 1] || '';
}

function startCluster() {
  clusterDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtp-containment-'));
  pgPort = 20000 + Math.floor(Math.random() * 10000);
  run(path.join(PG_BIN, 'initdb'), ['-D', clusterDir, '--no-sync', '-A', 'trust', '-U', process.env.USER]);
  const started = run(path.join(PG_BIN, 'pg_ctl'), [
    '-D', clusterDir,
    '-l', path.join(clusterDir, 'pg.log'),
    '-o', `-p ${pgPort} -k ${clusterDir}`,
    '-w',
    'start',
  ], { allowFail: true });
  if (started.status !== 0) {
    throw new Error(`pg_ctl start failed:\n${started.stderr}\n${fs.readFileSync(path.join(clusterDir, 'pg.log'), 'utf8')}`);
  }
}

function stopCluster() {
  if (!clusterDir || keepCluster) return;
  run(path.join(PG_BIN, 'pg_ctl'), ['-D', clusterDir, '-m', 'fast', 'stop'], { allowFail: true });
}

function createdb(name) {
  run(path.join(PG_BIN, 'createdb'), ['-h', '127.0.0.1', '-p', String(pgPort), name]);
}

function loadLegacy(database) {
  psql(database, ['-f', FIXTURE]);
}

function seedSynthetic(database) {
  psql(database, ['-c', `
    INSERT INTO public.tenants(id, name) VALUES
      ('00000000-0000-0000-0000-000000000001', 't1'),
      ('00000000-0000-0000-0000-000000000002', 't2');
    INSERT INTO public.tenant_users(tenant_id, user_id, role) VALUES
      ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000aa', 'member'),
      ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000bb', 'owner');
    INSERT INTO public.recipient_tax_profiles(
      id, tenant_id, recipient_key, recipient_name, tin
    ) VALUES (
      '00000000-0000-0000-0000-0000000000cc',
      '00000000-0000-0000-0000-000000000001',
      'payee-1',
      'synthetic',
      ${literal(SYNTHETIC)}
    );
  `]);
}

function literal(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function fingerprint(database) {
  return scalar(database, `
    SELECT md5(convert_to(id::text || '|' || tenant_id::text || '|' || recipient_key || '|' || coalesce(tin, '') || '|' || coalesce(recipient_name, ''), 'utf8'))
    FROM public.recipient_tax_profiles
    WHERE id = '00000000-0000-0000-0000-0000000000cc'
  `);
}

function asRoleDenied(database, role, query) {
  const result = psql(database, ['-c', `SET ROLE ${role}; ${query}`], { allowFail: true });
  assert.notEqual(result.status, 0, `expected ${role} to be denied for: ${query}`);
  assert.match(`${result.stderr}\n${result.stdout}`, /permission denied/i);
}

function walkFiles(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, acc);
    else acc.push(full);
  }
  return acc;
}

test('apply SQL lives outside supabase/migrations and is a single transaction', () => {
  assert.equal(fs.existsSync(APPLY), true);
  assert.equal(fs.existsSync(path.join(ROOT, 'supabase/migrations', OLD_MIGRATION)), false);
  assert.match(path.basename(APPLY), /^NOT_APPLIED_revoke_postgrest_tax_profiles\.sql$/);
  assert.match(sql, /NOT SAFE TO APPLY WITHOUT AUTHORIZED PREFLIGHT/);
  assert.match(sql, /^BEGIN;/m);
  assert.match(sql, /^COMMIT;/m);
  assert.doesNotMatch(sql, /CREATE\s+(OR\s+REPLACE\s+)?FUNCTION[\s\S]{0,200}SECURITY\s+DEFINER/i);
  assert.equal(/GRANT\b[\s\S]{0,80}TO authenticated/i.test(sql), false);
  assert.equal(/CREATE\s+POLICY/i.test(sql), false);
  assert.doesNotMatch(sql, /SELECT\s+tin\b/i);
  assert.doesNotMatch(sql, /UPDATE\s+public\.recipient_tax_profiles/i);
  assert.doesNotMatch(sql, /DELETE\s+FROM\s+public\.recipient_tax_profiles/i);
  assert.doesNotMatch(sql, /\b\d{3}-\d{2}-\d{4}\b/);
  assert.doesNotMatch(sql, /\b\d{2}-\d{7}\b/);
  assert.doesNotMatch(sql, /\b\d{9}\b/);
  assert.match(sql, /REVOKE ALL ON TABLE public\.recipient_tax_profiles FROM PUBLIC/);
  assert.match(sql, /REVOKE ALL ON TABLE public\.recipient_tax_profiles FROM anon/);
  assert.match(sql, /REVOKE ALL ON TABLE public\.recipient_tax_profiles FROM authenticated/);
  assert.match(sql, /REVOKE ALL ON TABLE public\.recipient_tax_profiles FROM authenticator/);
  assert.match(sql, /DROP POLICY IF EXISTS "tenant members read recipient_tax_profiles"/);
  assert.match(sql, /failed closed/);
  assert.match(sql, /pg_notify\('pgrst', 'reload schema'\)/);
  const notifyIdx = sql.indexOf("pg_notify('pgrst', 'reload schema')");
  const commitIdx = sql.lastIndexOf('COMMIT;');
  assert.ok(commitIdx > 0 && notifyIdx > commitIdx, 'NOTIFY must run after COMMIT');
  assert.equal(fs.existsSync(APPLY.replace(/\.sql$/, '.down.sql')), false);
  const downFiles = fs.readdirSync(path.join(ROOT, 'supabase/migrations'))
    .filter((name) => name.includes('revoke_postgrest_tax_profiles') && name.includes('down'));
  assert.deepEqual(downFiles, []);
});

test('preflight gate cannot be mistaken for the apply file', () => {
  assert.match(preflightSql, /PREFLIGHT GATE ONLY/);
  assert.match(preflightSql, /SET TRANSACTION READ ONLY/);
  assert.match(preflightSql, /^ROLLBACK;/m);
  assert.doesNotMatch(preflightSql, /^COMMIT;/m);
  assert.doesNotMatch(preflightSql, /^\s*REVOKE\b/mi);
  assert.doesNotMatch(preflightSql, /^\s*DROP POLICY\b/mi);
  assert.doesNotMatch(preflightSql, /pg_notify/);
  assert.doesNotMatch(preflightSql, /SELECT\s+tin\b/i);
  assert.match(inventorySql, /not the apply/i);
  assert.doesNotMatch(inventorySql, /^\s*REVOKE\b/mi);
});

test('rollback is documentation-only and warns it reopens TIN exposure', () => {
  assert.match(rollbackDoc, /explicit operator authorization/i);
  assert.match(rollbackDoc, /reopens full-TIN exposure/i);
  assert.match(rollbackDoc, /Safer functional rollback/i);
  assert.match(rollbackDoc, /GRANT SELECT, INSERT, UPDATE, DELETE ON public\.recipient_tax_profiles TO authenticated/);
  assert.match(rollbackDoc, /tenant members read recipient_tax_profiles/);
  assert.equal(rollbackDoc.includes(APPLY_REL), true);
  assert.match(rollbackDoc, /supabase db push/);
  assert.match(rollbackDoc, /must not be used/);
  assert.equal(fs.existsSync(path.join(ROOT, 'supabase/migrations', OLD_MIGRATION.replace(/\.sql$/, '.down.sql'))), false);
});

test('docs forbid db push and treat Oct 30 2026 as scheduled future behavior', () => {
  assert.match(runbook, /must not be used/);
  assert.match(runbook, /supabase db push/);
  assert.equal(runbook.includes(APPLY_REL), true);
  assert.match(runbook, /preflight_gate_revoke_postgrest_tax_profiles\.sql/);
  assert.match(runbook, /scheduled future behavior/i);
  assert.match(runbook, /No TIN on file/);
  assert.match(runbook, /separate small UI PR/i);
  assert.doesNotMatch(runbook, /psql -1 .*supabase\/migrations\/20260912114853/);
});

test('unapplied encryption design SQL is not this change, and revoke is not a migration', () => {
  const migrations = fs.readdirSync(path.join(ROOT, 'supabase/migrations'));
  assert.equal(migrations.some((name) => name.includes('recipient_tax_profiles_containment')), false);
  assert.equal(migrations.includes(OLD_MIGRATION), false);
  assert.doesNotMatch(sql, /tin_encrypted/);
});

test('no auto-run discovery of the unapplied revoke file', () => {
  const scanners = [
    'aws/db-copy/lib/inventory.mjs',
    'aws/workflows/oneshot/index.mjs',
    'aws/financial/oneshot/index.mjs',
    'aws/rls/oneshot/index.mjs',
    'aws/write-path/oneshot/index.mjs',
    'aws/identity/oneshot/index.mjs',
    '.github/workflows/aws-migration-ci.yml',
    '.github/workflows/tax-profile-migration-guard.yml',
    'supabase/config.toml',
  ];
  for (const rel of scanners) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.doesNotMatch(text, /NOT_APPLIED_revoke_postgrest_tax_profiles/);
    assert.doesNotMatch(text, /unapplied-do-not-run/);
  }
  const inventory = fs.readFileSync(path.join(ROOT, 'aws/db-copy/lib/inventory.mjs'), 'utf8');
  assert.match(inventory, /supabase\/migrations/);
  const workflowFiles = walkFiles(path.join(ROOT, '.github/workflows'));
  for (const file of workflowFiles) {
    const text = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /db push/);
    assert.doesNotMatch(text, /psql[^\n]*NOT_APPLIED_revoke_postgrest_tax_profiles/);
  }
});

test('frontend still does not query the table directly', () => {
  const taxSummary = fs.readFileSync(path.join(ROOT, 'src/components/ledger/TaxSummary.tsx'), 'utf8');
  assert.doesNotMatch(taxSummary, /from\(['"]recipient_tax_profiles['"]\)/);
  assert.match(taxSummary, /tenant-tax-profiles/);
  assert.match(taxSummary, /taxProfiles = \[\]/);
  assert.match(taxSummary, /No TIN on file/);
  const client = fs.readFileSync(path.join(ROOT, 'src/integrations/supabase/client.ts'), 'utf8');
  assert.doesNotMatch(client, /SERVICE_ROLE/);
  assert.match(client, /VITE_SUPABASE_PUBLISHABLE_KEY/);
});

before(() => {
  startCluster();
});

test('local disposable database: revoke, deny Data API roles, preserve service_role, leave rows unchanged', () => {
  createdb('rtp_legacy');
  loadLegacy('rtp_legacy');
  seedSynthetic('rtp_legacy');
  const before = fingerprint('rtp_legacy');
  assert.equal(before.length, 32);

  const gated = runPreflight('rtp_legacy');
  assert.equal(gated.status, 0);
  assert.match(gated.stderr + gated.stdout, /CLASSIFICATION=EXACT_EXPECTED_LEGACY/);
  assert.doesNotMatch(gated.stderr + gated.stdout, new RegExp(SYNTHETIC));

  const first = applySql('rtp_legacy');
  assert.equal(first.status, 0);
  assert.match(first.stderr + first.stdout, /CLASSIFICATION=EXACT_EXPECTED_LEGACY/);
  assert.match(first.stderr + first.stdout, /Data API privileges revoked/);
  assert.doesNotMatch(first.stderr + first.stdout, new RegExp(SYNTHETIC));

  const after = fingerprint('rtp_legacy');
  assert.equal(after, before);

  assert.equal(scalar('rtp_legacy', `
    SELECT relrowsecurity::text
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'recipient_tax_profiles'
  `), 'true');

  assert.equal(scalar('rtp_legacy', `
    SELECT count(*)::text FROM pg_policy
    WHERE polrelid = 'public.recipient_tax_profiles'::regclass
  `), '0');

  assert.equal(scalar('rtp_legacy', `
    SELECT has_table_privilege('anon', 'public.recipient_tax_profiles', 'SELECT')::text
  `), 'false');
  assert.equal(scalar('rtp_legacy', `
    SELECT has_table_privilege('authenticated', 'public.recipient_tax_profiles', 'SELECT')::text
  `), 'false');
  assert.equal(scalar('rtp_legacy', `
    SELECT (
      has_table_privilege('authenticated', 'public.recipient_tax_profiles', 'INSERT')
      OR has_table_privilege('authenticated', 'public.recipient_tax_profiles', 'UPDATE')
      OR has_table_privilege('authenticated', 'public.recipient_tax_profiles', 'DELETE')
      OR has_table_privilege('authenticated', 'public.recipient_tax_profiles', 'TRUNCATE')
    )::text
  `), 'false');
  assert.equal(scalar('rtp_legacy', `
    SELECT (
      has_table_privilege('service_role', 'public.recipient_tax_profiles', 'SELECT')
      AND has_table_privilege('service_role', 'public.recipient_tax_profiles', 'INSERT')
      AND has_table_privilege('service_role', 'public.recipient_tax_profiles', 'UPDATE')
      AND has_table_privilege('service_role', 'public.recipient_tax_profiles', 'DELETE')
    )::text
  `), 'true');

  asRoleDenied('rtp_legacy', 'anon', 'SELECT tin FROM public.recipient_tax_profiles');
  asRoleDenied('rtp_legacy', 'anon', 'SELECT * FROM public.recipient_tax_profiles');
  asRoleDenied('rtp_legacy', 'authenticated', 'SELECT id FROM public.recipient_tax_profiles');
  asRoleDenied('rtp_legacy', 'authenticated', 'SELECT tin FROM public.recipient_tax_profiles');
  asRoleDenied('rtp_legacy', 'authenticated', 'SELECT * FROM public.recipient_tax_profiles');
  asRoleDenied('rtp_legacy', 'authenticated', 'SELECT tin FROM recipient_tax_profiles');
  asRoleDenied('rtp_legacy', 'authenticated', `
    SELECT recipient_tax_profiles.tin
    FROM public.tenants
    JOIN public.recipient_tax_profiles ON recipient_tax_profiles.tenant_id = tenants.id
  `);
  asRoleDenied('rtp_legacy', 'authenticated', `
    INSERT INTO public.recipient_tax_profiles (tenant_id, recipient_key, tin)
    VALUES ('00000000-0000-0000-0000-000000000001', 'x', 'nope')
  `);
  asRoleDenied('rtp_legacy', 'authenticated', `
    UPDATE public.recipient_tax_profiles SET notes = 'x'
    WHERE tenant_id = '00000000-0000-0000-0000-000000000001'
  `);
  asRoleDenied('rtp_legacy', 'authenticated', `
    DELETE FROM public.recipient_tax_profiles
    WHERE tenant_id = '00000000-0000-0000-0000-000000000001'
  `);

  const memberJwt = psql('rtp_legacy', ['-c', `
    SET ROLE authenticated;
    SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000aa', false);
    SELECT tin FROM public.recipient_tax_profiles;
  `], { allowFail: true });
  assert.notEqual(memberJwt.status, 0);
  assert.match(`${memberJwt.stderr}\n${memberJwt.stdout}`, /permission denied/i);

  const ownerJwt = psql('rtp_legacy', ['-c', `
    SET ROLE authenticated;
    SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000bb', false);
    SELECT tin FROM public.recipient_tax_profiles;
  `], { allowFail: true });
  assert.notEqual(ownerJwt.status, 0);

  const crossTenant = psql('rtp_legacy', ['-c', `
    SET ROLE authenticated;
    SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000aa', false);
    SELECT * FROM public.recipient_tax_profiles
    WHERE tenant_id = '00000000-0000-0000-0000-000000000002';
  `], { allowFail: true });
  assert.notEqual(crossTenant.status, 0);

  const upsert = psql('rtp_legacy', ['-c', `
    SET ROLE authenticated;
    INSERT INTO public.recipient_tax_profiles (tenant_id, recipient_key, tin)
    VALUES ('00000000-0000-0000-0000-000000000001', 'payee-1', 'nope')
    ON CONFLICT (tenant_id, recipient_key) DO UPDATE SET notes = 'upsert';
  `], { allowFail: true });
  assert.notEqual(upsert.status, 0);

  const serviceOk = scalar('rtp_legacy', `
    SET ROLE service_role;
    SELECT (count(*) FILTER (WHERE recipient_key = 'payee-1'))::text
    FROM public.recipient_tax_profiles
  `);
  assert.equal(serviceOk, '1');

  const serviceWrite = scalar('rtp_legacy', `
    SET ROLE service_role;
    UPDATE public.recipient_tax_profiles SET notes = 'svc' WHERE recipient_key = 'payee-1';
    SELECT notes FROM public.recipient_tax_profiles WHERE recipient_key = 'payee-1';
  `);
  assert.equal(serviceWrite, 'svc');

  psql('rtp_legacy', ['-c', `
    UPDATE public.recipient_tax_profiles SET notes = NULL WHERE recipient_key = 'payee-1';
  `]);
  assert.equal(fingerprint('rtp_legacy'), before);

  const contained = runPreflight('rtp_legacy');
  assert.equal(contained.status, 0);
  assert.match(contained.stderr + contained.stdout, /CLASSIFICATION=ALREADY_CONTAINED/);

  const second = applySql('rtp_legacy');
  assert.equal(second.status, 0);
  assert.match(second.stderr + second.stdout, /CLASSIFICATION=ALREADY_CONTAINED/);
  assert.match(second.stderr + second.stdout, /already applied, no-op/);
  assert.equal(fingerprint('rtp_legacy'), before);
});

test('fail closed on unexpected extra policy', () => {
  createdb('rtp_extra_policy');
  loadLegacy('rtp_extra_policy');
  psql('rtp_extra_policy', ['-c', `
    CREATE POLICY unexpected_wide_read ON public.recipient_tax_profiles
      FOR SELECT TO authenticated USING (true);
  `]);
  const result = applySql('rtp_extra_policy', { allowFail: true });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /failed closed/);
  assert.equal(scalar('rtp_extra_policy', `
    SELECT has_table_privilege('authenticated', 'public.recipient_tax_profiles', 'SELECT')::text
  `), 'true');
});

test('fail closed when a view depends on the table', () => {
  createdb('rtp_view');
  loadLegacy('rtp_view');
  psql('rtp_view', ['-c', `
    CREATE VIEW public.tax_profiles_leak AS
      SELECT recipient_key FROM public.recipient_tax_profiles;
  `]);
  const result = applySql('rtp_view', { allowFail: true });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /dependent object/);
});

test('fail closed when a public function references the table', () => {
  createdb('rtp_fn');
  loadLegacy('rtp_fn');
  psql('rtp_fn', ['-c', `
    CREATE FUNCTION public.leak_tax_profiles() RETURNS bigint
    LANGUAGE sql AS $$ SELECT count(*) FROM public.recipient_tax_profiles $$;
  `]);
  const result = applySql('rtp_fn', { allowFail: true });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /leak_tax_profiles/);
});

test('column-level grants cannot restore authenticated access after revoke', () => {
  createdb('rtp_cols');
  loadLegacy('rtp_cols');
  psql('rtp_cols', ['-c', `
    GRANT SELECT (tin) ON public.recipient_tax_profiles TO authenticated;
  `]);
  const applied = applySql('rtp_cols');
  assert.equal(applied.status, 0);
  asRoleDenied('rtp_cols', 'authenticated', 'SELECT tin FROM public.recipient_tax_profiles');
  assert.equal(scalar('rtp_cols', `
    SELECT count(*)::text
    FROM information_schema.column_privileges
    WHERE table_schema = 'public'
      AND table_name = 'recipient_tax_profiles'
      AND grantee = 'authenticated'
  `), '0');
});

test('fail closed when the table is in a publication', () => {
  createdb('rtp_pub');
  loadLegacy('rtp_pub');
  psql('rtp_pub', ['-c', `
    CREATE PUBLICATION rtp_unexpected FOR TABLE public.recipient_tax_profiles;
  `]);
  const result = applySql('rtp_pub', { allowFail: true });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /publication/);
});

test('fail closed when a foreign table name references recipient_tax_profiles', () => {
  createdb('rtp_ft');
  loadLegacy('rtp_ft');
  psql('rtp_ft', ['-c', `
    CREATE FOREIGN DATA WRAPPER rtp_dummy;
    CREATE SERVER rtp_dummy_srv FOREIGN DATA WRAPPER rtp_dummy;
    CREATE FOREIGN TABLE public.recipient_tax_profiles_remote (id uuid)
      SERVER rtp_dummy_srv;
  `]);
  const result = applySql('rtp_ft', { allowFail: true });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /foreign table/i);
});

test('fail closed on role-membership ambiguity', () => {
  createdb('rtp_membership');
  loadLegacy('rtp_membership');
  psql('rtp_membership', ['-c', `GRANT service_role TO authenticated;`]);
  try {
    const result = applySql('rtp_membership', { allowFail: true });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}\n${result.stdout}`, /role-membership ambiguity/);
  } finally {
    psql('rtp_membership', ['-c', `REVOKE service_role FROM authenticated;`], { allowFail: true });
  }
});

test('fail closed on unexpected custom grantee', () => {
  createdb('rtp_grantee');
  loadLegacy('rtp_grantee');
  psql('rtp_grantee', ['-c', `
    CREATE ROLE unexpected_auditor NOLOGIN;
    GRANT SELECT ON public.recipient_tax_profiles TO unexpected_auditor;
  `]);
  const result = applySql('rtp_grantee', { allowFail: true });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /unexpected custom grantee/);
});

test('fail closed on unexpected aws_* policy', () => {
  createdb('rtp_aws_pol');
  loadLegacy('rtp_aws_pol');
  psql('rtp_aws_pol', ['-c', `
    CREATE POLICY aws_select_recipient_tax_profiles ON public.recipient_tax_profiles
      FOR SELECT TO authenticated USING (true);
  `]);
  const result = applySql('rtp_aws_pol', { allowFail: true });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /aws_\* policy/);
});

test('fail closed on wrong project or database identity', () => {
  createdb('rtp_identity');
  loadLegacy('rtp_identity');
  const wrongRef = applySql('rtp_identity', {
    allowFail: true,
    projectRef: 'sqyyvpaymashtdwjjmku',
  });
  assert.notEqual(wrongRef.status, 0);
  assert.match(`${wrongRef.stderr}\n${wrongRef.stdout}`, /authorized hosted ref|project identity/);

  const wrongDb = applySql('rtp_identity', {
    allowFail: true,
    database: 'postgres',
  });
  assert.notEqual(wrongDb.status, 0);
  assert.match(`${wrongDb.stderr}\n${wrongDb.stdout}`, /database identity mismatch/);
});

test('fail closed on RDS/AWS database name pattern', () => {
  createdb('checksops_rtp');
  loadLegacy('checksops_rtp');
  const result = applySql('checksops_rtp', { allowFail: true });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /RDS\/AWS database name/);
});

test('fail closed on partially applied state', () => {
  createdb('rtp_partial');
  loadLegacy('rtp_partial');
  psql('rtp_partial', ['-c', `
    DROP POLICY "tenant members read recipient_tax_profiles" ON public.recipient_tax_profiles;
  `]);
  const result = applySql('rtp_partial', { allowFail: true });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /UNSAFE\/AMBIGUOUS/);
  assert.equal(scalar('rtp_partial', `
    SELECT has_table_privilege('authenticated', 'public.recipient_tax_profiles', 'SELECT')::text
  `), 'true');
  assert.equal(scalar('rtp_partial', `
    SELECT count(*)::text FROM pg_policy
    WHERE polrelid = 'public.recipient_tax_profiles'::regclass
  `), '3');
});

after(() => {
  stopCluster();
});
