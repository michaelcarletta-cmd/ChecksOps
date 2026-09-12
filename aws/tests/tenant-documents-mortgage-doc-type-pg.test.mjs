import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MORTGAGE_LIBRARY_DOC_TYPES } from '../functions/api/mortgage-library-doc-types.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SQL_DIR = path.join(ROOT, 'rls/sql');
const APPLY_SQL = path.join(SQL_DIR, '30_tenant_documents_mortgage_doc_type.sql');
const ROLLBACK_SQL = path.join(SQL_DIR, '30_tenant_documents_mortgage_doc_type_rollback.sql');
const SQL29 = path.join(SQL_DIR, '29_mortgage_ops_library_parity.sql');
const PG_BIN = '/usr/lib/postgresql/16/bin';
const ARTIFACT_DIR = '/opt/cursor/artifacts';

const LEGACY = [
  'w9', 'license', 'insurance', 'saas_agreement', 'terms_of_service', 'privacy_policy',
];
const REJECT = [
  'library:mortgage:evil',
  'library:mortgage:other',
  'library:mortgage:license',
  'library:mortgage:closing',
  'library:template:tpa',
  'library:shingle:oakridge',
  'library:siding:vinyl',
  'library:catalog:roofing',
  'library:letterhead:logo',
  'verification',
  'bogus',
];
const TARGET = [
  'insurance',
  'library:mortgage:adjuster-tpa-letter',
  'library:mortgage:certificate-of-insurance',
  'library:mortgage:contractor-license',
  'library:mortgage:general-liability-insurance',
  'library:mortgage:signed-contract',
  'library:mortgage:w-9',
  'library:mortgage:workers-comp-insurance',
  'license',
  'privacy_policy',
  'saas_agreement',
  'terms_of_service',
  'w9',
];

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

test('disposable PostgreSQL tenant_documents mortgage doc_type constraint', { timeout: 180000 }, async (t) => {
  assert.equal(fs.existsSync(path.join(PG_BIN, 'initdb')), true);
  assert.equal(fs.existsSync(APPLY_SQL), true);
  assert.equal(fs.existsSync(ROLLBACK_SQL), true);
  const sql29Before = fs.readFileSync(SQL29, 'utf8');

  const stamp = `${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}_${process.pid}`;
  const pgData = fs.mkdtempSync(path.join(os.tmpdir(), `pg-sql30-${stamp}-`));
  const port = 55100 + (process.pid % 1000);
  const dbName = `sql30_${stamp}`;
  const logPath = path.join(pgData, 'pg.log');
  const artifactLog = path.join(ARTIFACT_DIR, `tenant_documents_mortgage_doc_type_pg_${stamp}.log`);
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
    } catch { /* ignore */ }
    stopCluster();
  });

  mustRun(path.join(PG_BIN, 'initdb'), [
    '-D', pgData, '--auth=trust', '--no-sync', '--username=ubuntu', '--encoding=UTF8',
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

  const psqlArgs = ['-h', pgData, '-p', String(port), '-U', 'ubuntu', '-v', 'ON_ERROR_STOP=1'];
  const psql = (extra, input) => {
    const result = run(path.join(PG_BIN, 'psql'), [...psqlArgs, ...extra], input ? { input } : {});
    if (result.status !== 0) {
      throw new Error(`psql failed: ${result.stderr || result.stdout}`);
    }
    return result;
  };
  const psqlAllowFail = (extra, input) => run(
    path.join(PG_BIN, 'psql'),
    [...psqlArgs, ...extra],
    input ? { input } : {},
  );
  const scalar = (sql) => psql(['-d', dbName, '-A', '-t', '-c', sql]).stdout.trim();

  const proof = psql(['-d', 'postgres', '-A', '-t', '-c', `
SELECT json_build_object(
  'version', version(),
  'listen_addresses', current_setting('listen_addresses'),
  'data_directory', current_setting('data_directory'),
  'unix_socket_directories', current_setting('unix_socket_directories'),
  'inet_server_addr', inet_server_addr(),
  'is_rds', current_setting('rds.superuser', true) IS NOT NULL,
  'supabase_admin', EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin')
);
`]).stdout.trim();
  note(`target_proof ${proof}`);
  const target = JSON.parse(proof);
  assert.equal(target.listen_addresses, '');
  assert.equal(target.data_directory, pgData);
  assert.equal(target.inet_server_addr, null);
  assert.equal(target.is_rds, false);
  assert.equal(target.supabase_admin, false);
  assert.match(target.version, /PostgreSQL 16/);
  assert.doesNotMatch(pgData, /supabase|rds|staging|prod/i);

  psql(['-d', 'postgres', '-c', `CREATE DATABASE ${dbName}`]);

  psql(['-d', dbName, '-c', `
CREATE TABLE public.tenant_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  doc_type text NOT NULL,
  file_path text NOT NULL,
  file_name text NOT NULL,
  CONSTRAINT tenant_documents_doc_type_check CHECK (doc_type IN (
    'w9','license','insurance','saas_agreement','terms_of_service','privacy_policy'
  ))
);

CREATE TABLE public.sql30_canary (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  n int NOT NULL,
  CONSTRAINT sql30_canary_n_check CHECK (n > 0)
);
ALTER TABLE public.sql30_canary ENABLE ROW LEVEL SECURITY;
CREATE POLICY sql30_canary_read ON public.sql30_canary FOR SELECT USING (true);
CREATE FUNCTION public.sql30_canary_tg() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$;
CREATE TRIGGER sql30_canary_trigger
  BEFORE INSERT ON public.sql30_canary
  FOR EACH ROW EXECUTE FUNCTION public.sql30_canary_tg();
GRANT SELECT ON TABLE public.sql30_canary TO PUBLIC;
INSERT INTO public.sql30_canary (n) VALUES (1), (2);

CREATE TABLE public.mortgage_request_library_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid
);
ALTER TABLE public.mortgage_request_library_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY sql29_canary_select ON public.mortgage_request_library_documents
  FOR SELECT USING (true);

CREATE FUNCTION public.aws_mortgage_agent_can_read_library_document(_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false AND _id IS NULL; $$;
CREATE FUNCTION public.aws_mortgage_agent_can_read_library_path(_candidates text[], _rel text, _user_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false AND _rel IS NULL AND _user_id IS NULL AND _candidates IS NULL; $$;
CREATE FUNCTION public.aws_can_manage_mortgage_library(_tenant_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false AND _tenant_id IS NULL; $$;
CREATE FUNCTION public.aws_can_insert_mortgage_library_document(
  _tenant_id uuid, _request_id uuid, _tenant_document_id uuid, _file_path text
) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN false AND _tenant_id IS NULL AND _request_id IS NULL
    AND _tenant_document_id IS NULL AND _file_path IS NULL;
END;
$$;
`]);

  const inventorySql = `
SELECT json_build_object(
  'policies', (SELECT count(*)::int FROM pg_policies),
  'triggers', (SELECT count(*)::int FROM pg_trigger WHERE NOT tgisinternal),
  'grants', (SELECT count(*)::int FROM information_schema.role_table_grants WHERE table_schema = 'public'),
  'constraints', (SELECT count(*)::int FROM pg_constraint),
  'functions', (
    SELECT count(*)::int FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
  ),
  'canary_n', (SELECT count(*)::int FROM public.sql30_canary),
  'tenant_n', (SELECT count(*)::int FROM public.tenant_documents),
  'sql29_doc', md5(pg_get_functiondef('public.aws_mortgage_agent_can_read_library_document(uuid)'::regprocedure)),
  'sql29_path', md5(pg_get_functiondef('public.aws_mortgage_agent_can_read_library_path(text[], text, uuid)'::regprocedure)),
  'sql29_manage', md5(pg_get_functiondef('public.aws_can_manage_mortgage_library(uuid)'::regprocedure)),
  'sql29_insert', md5(pg_get_functiondef('public.aws_can_insert_mortgage_library_document(uuid, uuid, uuid, text)'::regprocedure)),
  'sql29_policy', (
    SELECT md5(coalesce(qual, '') || '|' || coalesce(with_check, ''))
    FROM pg_policies
    WHERE schemaname = 'public' AND policyname = 'sql29_canary_select'
  ),
  'canary_policy', (
    SELECT md5(coalesce(qual, '') || '|' || coalesce(with_check, ''))
    FROM pg_policies
    WHERE schemaname = 'public' AND policyname = 'sql30_canary_read'
  ),
  'nullable', (
    SELECT is_nullable FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'tenant_documents' AND column_name = 'doc_type'
  )
);
`;
  const extractedSql = `
SELECT coalesce(json_agg(v ORDER BY v), '[]'::json)
FROM (
  SELECT (regexp_matches(pg_get_constraintdef(c.oid), $$'([^']+)'$$, 'g'))[1] AS v
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public' AND t.relname = 'tenant_documents'
    AND c.conname = 'tenant_documents_doc_type_check' AND c.contype = 'c'
) s;
`;
  const extracted = () => JSON.parse(scalar(extractedSql));
  const inventory = () => JSON.parse(scalar(inventorySql));

  assert.deepEqual(extracted(), LEGACY.slice().sort());

  for (const [i, docType] of LEGACY.entries()) {
    psql(['-d', dbName, '-c', `
INSERT INTO public.tenant_documents (tenant_id, doc_type, file_path, file_name)
VALUES ('11111111-1111-4111-8111-111111111111', '${docType}', 'p/${i}', '${docType}');
`]);
  }
  const beforeRows = JSON.parse(scalar(`
SELECT json_agg(json_build_object(
  'doc_type', doc_type, 'file_path', file_path, 'file_name', file_name, 'ctid', ctid::text, 'xmin', xmin::text
) ORDER BY file_path)
FROM public.tenant_documents;
`));
  const beforeInv = inventory();
  note(`inventory_before ${JSON.stringify(beforeInv)}`);

  const firstApply = psql(['-d', dbName, '-f', APPLY_SQL]);
  note(`first_apply stderr=${firstApply.stderr.trim()}`);
  assert.deepEqual(extracted(), TARGET);
  const afterRows = JSON.parse(scalar(`
SELECT json_agg(json_build_object(
  'doc_type', doc_type, 'file_path', file_path, 'file_name', file_name, 'ctid', ctid::text, 'xmin', xmin::text
) ORDER BY file_path)
FROM public.tenant_documents;
`));
  assert.deepEqual(afterRows, beforeRows);
  const afterInv = inventory();
  assert.deepEqual(afterInv, { ...beforeInv, tenant_n: beforeInv.tenant_n });
  assert.equal(afterInv.sql29_doc, beforeInv.sql29_doc);
  assert.equal(afterInv.sql29_path, beforeInv.sql29_path);
  assert.equal(afterInv.sql29_manage, beforeInv.sql29_manage);
  assert.equal(afterInv.sql29_insert, beforeInv.sql29_insert);
  assert.equal(afterInv.sql29_policy, beforeInv.sql29_policy);
  assert.equal(afterInv.nullable, 'NO');

  for (const docType of MORTGAGE_LIBRARY_DOC_TYPES) {
    psql(['-d', dbName, '-c', `
INSERT INTO public.tenant_documents (tenant_id, doc_type, file_path, file_name)
VALUES ('11111111-1111-4111-8111-111111111111', '${docType}', 'm/${docType}', '${docType}');
`]);
  }
  for (const docType of LEGACY) {
    const ok = scalar(`SELECT 'ok' FROM public.tenant_documents WHERE doc_type = '${docType}' LIMIT 1`);
    assert.equal(ok, 'ok');
  }

  const insertShouldFail = (docType) => {
    const result = psqlAllowFail(['-d', dbName, '-c', `
INSERT INTO public.tenant_documents (tenant_id, doc_type, file_path, file_name)
VALUES ('11111111-1111-4111-8111-111111111111', ${docType === null ? 'NULL' : `'${docType}'`}, 'bad/${docType}', 'bad');
`]);
    assert.notEqual(result.status, 0, `expected reject for ${docType}: ${result.stdout}`);
  };
  for (const docType of REJECT) insertShouldFail(docType);
  insertShouldFail(null);

  const secondApply = psql(['-d', dbName, '-f', APPLY_SQL]);
  note(`second_apply stderr=${secondApply.stderr.trim()}`);
  assert.match(`${secondApply.stderr}\n${secondApply.stdout}`, /sql30_already_current/);
  assert.deepEqual(extracted(), TARGET);

  const rollbackBlocked = psqlAllowFail(['-d', dbName, '-f', ROLLBACK_SQL]);
  assert.notEqual(rollbackBlocked.status, 0);
  assert.match(`${rollbackBlocked.stderr}\n${rollbackBlocked.stdout}`, /Mortgage Ops document rows would be invalidated/);
  assert.deepEqual(extracted(), TARGET);

  psql(['-d', dbName, '-c', `DELETE FROM public.tenant_documents WHERE doc_type LIKE 'library:mortgage:%'`]);
  const rollbackOk = psql(['-d', dbName, '-f', ROLLBACK_SQL]);
  note(`rollback stderr=${rollbackOk.stderr.trim()}`);
  assert.deepEqual(extracted(), LEGACY.slice().sort());

  const injected = psqlAllowFail(['-d', dbName], `
SET checksops.tenant_documents_doc_type_test_fail_after_drop = '1';
${fs.readFileSync(APPLY_SQL, 'utf8')}
`);
  assert.notEqual(injected.status, 0);
  assert.match(`${injected.stderr}\n${injected.stdout}`, /sql30_injected_failure_after_drop/);
  assert.deepEqual(extracted(), LEGACY.slice().sort());

  const unexpected = psqlAllowFail(['-d', dbName], `
ALTER TABLE public.tenant_documents DROP CONSTRAINT tenant_documents_doc_type_check;
ALTER TABLE public.tenant_documents ADD CONSTRAINT tenant_documents_doc_type_check
  CHECK (doc_type IN ('w9', 'unexpected'));
${fs.readFileSync(APPLY_SQL, 'utf8')}
`);
  assert.notEqual(unexpected.status, 0);
  assert.match(`${unexpected.stderr}\n${unexpected.stdout}`, /unsupported predecessor/);
  assert.deepEqual(extracted(), ['unexpected', 'w9']);

  psql(['-d', dbName, '-c', `
DELETE FROM public.tenant_documents;
ALTER TABLE public.tenant_documents DROP CONSTRAINT tenant_documents_doc_type_check;
INSERT INTO public.tenant_documents (tenant_id, doc_type, file_path, file_name)
VALUES ('11111111-1111-4111-8111-111111111111', 'bogus', 'p/bad', 'bad');
ALTER TABLE public.tenant_documents ADD CONSTRAINT tenant_documents_doc_type_check
  CHECK (doc_type IN ('w9','license','insurance','saas_agreement','terms_of_service','privacy_policy')) NOT VALID;
`]);
  const incompatible = psqlAllowFail(['-d', dbName, '-f', APPLY_SQL]);
  assert.notEqual(incompatible.status, 0);
  assert.match(`${incompatible.stderr}\n${incompatible.stdout}`, /existing rows would violate replacement constraint/);
  assert.deepEqual(extracted(), LEGACY.slice().sort());

  psql(['-d', dbName, '-c', `
DELETE FROM public.tenant_documents;
ALTER TABLE public.tenant_documents DROP CONSTRAINT tenant_documents_doc_type_check;
ALTER TABLE public.tenant_documents ADD CONSTRAINT tenant_documents_doc_type_check
  CHECK (doc_type IN ('w9', 'license', 'insurance'));
INSERT INTO public.tenant_documents (tenant_id, doc_type, file_path, file_name)
VALUES ('11111111-1111-4111-8111-111111111111', 'w9', 'p/3', 'w9');
`]);
  psql(['-d', dbName, '-f', APPLY_SQL]);
  assert.deepEqual(extracted(), TARGET);
  psql(['-d', dbName, '-c', `
INSERT INTO public.tenant_documents (tenant_id, doc_type, file_path, file_name)
VALUES ('11111111-1111-4111-8111-111111111111', 'library:mortgage:signed-contract', 'p/sc', 'sc');
`]);

  assert.equal(fs.readFileSync(SQL29, 'utf8'), sql29Before);
  const finalInv = inventory();
  assert.equal(finalInv.sql29_doc, beforeInv.sql29_doc);
  assert.equal(finalInv.canary_n, 2);
  assert.equal(finalInv.nullable, 'NO');
  note('sql30_pg_pass');
});
