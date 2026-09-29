import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { INTAKE_PROHIBITED_COLUMNS, WRITE_ALLOWLIST } from '../functions/api/write-allowlist.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PG_BIN = '/usr/lib/postgresql/16/bin';
const SQL44 = fs.readFileSync(path.join(ROOT, 'aws/write-path/sql/44_claim_ledger_link_or_create.sql'), 'utf8');
const SQL43 = fs.readFileSync(path.join(ROOT, 'aws/write-path/sql/43_review_save_detected_claim_number.sql'), 'utf8');
const WRITE_SRC = fs.readFileSync(path.join(ROOT, 'aws/functions/api/write.mjs'), 'utf8');
const WORKFLOW_SRC = fs.readFileSync(path.join(ROOT, 'aws/functions/api/workflow-rpc.mjs'), 'utf8');
const FILES_SRC = fs.readFileSync(path.join(ROOT, 'src/components/check-review/CheckFilesSection.tsx'), 'utf8');
const SIG_SRC = fs.readFileSync(path.join(ROOT, 'src/components/claim-detail/SignatureRequests.tsx'), 'utf8');

test('SQL 44 is a narrow Claim Ledger RPC and does not broaden generic writes', () => {
  assert.equal(INTAKE_PROHIBITED_COLUMNS.has('claim_id'), true);
  assert.equal(INTAKE_PROHIBITED_COLUMNS.has('detected_claim_number'), true);
  assert.equal(INTAKE_PROHIBITED_COLUMNS.has('amount'), true);
  assert.equal(WRITE_ALLOWLIST.check_intake_items.columns.has('claim_id'), false);
  assert.equal(WRITE_ALLOWLIST.claims.ops.has('insert'), false);
  assert.equal(WRITE_ALLOWLIST.claims.columns.has('claim_number'), true);
  assert.match(SQL44, /NOT APPLIED/);
  assert.match(SQL44, /claim_ledger_link_or_create/);
  assert.match(SQL44, /p_action text/);
  assert.match(SQL44, /inspect/);
  assert.match(SQL44, /link_existing/);
  assert.match(SQL44, /create_new/);
  assert.match(SQL44, /FOR UPDATE/);
  assert.match(SQL44, /INSERT INTO public\.claims \(claim_number, status, org_id\)/);
  assert.match(SQL44, /SET claim_id = v_same_id/);
  assert.match(SQL44, /SET claim_id = v_new_id/);
  assert.match(SQL44, /AND claim_id IS NULL/);
  assert.match(SQL44, /already_linked/);
  assert.match(SQL44, /unique_violation/);
  assert.match(SQL44, /cross_tenant/);
  assert.match(SQL44, /ambiguous/);
  assert.match(SQL44, /SELECT count\(\*\).*v_same_count/s);
  assert.match(SQL44, /v_ambiguous_own/);
  assert.match(SQL44, /c\.org_id IS NULL/);
  assert.match(SQL44, /ev\.claim_id = c\.id/);
  assert.match(SQL44, /link_existing does NOT assign claims\.org_id/);
  assert.doesNotMatch(SQL44, /UPDATE public\.claims[\s\S]*org_id/);
  assert.doesNotMatch(SQL44, /ev\.detected_claim_number/);
  assert.doesNotMatch(SQL44, /SET\s+detected_claim_number/);
  assert.doesNotMatch(SQL44, /ocr_claim_number_key\(.*detected_claim_number/);
  assert.doesNotMatch(SQL44, /GRANT UPDATE/);
  assert.doesNotMatch(SQL44, /GRANT INSERT/);
  assert.match(SQL44, /GRANT EXECUTE ON FUNCTION public\.claim_ledger_link_or_create/);
  assert.match(SQL44, /REVOKE ALL ON FUNCTION public\.claim_ledger_link_or_create[\s\S]*FROM authenticated/);
  assert.doesNotMatch(SQL44, /SET\s+detected_claim_number/);
  assert.doesNotMatch(SQL44, /deposited_at\s*=/);
  assert.doesNotMatch(SQL44, /SET[\s\S]*amount\s*=/);

  assert.match(SQL43, /review_save_detected_claim_number/);
  assert.match(SQL43, /Never inserts a claims row/);
  assert.doesNotMatch(SQL43, /INSERT INTO public\.claims/);
  assert.match(WRITE_SRC, /peelReviewClaimNumber/);
  assert.match(WRITE_SRC, /executeReviewClaimSave/);
  assert.match(WORKFLOW_SRC, /claim_ledger_link_or_create/);
  assert.match(WORKFLOW_SRC, /CLAIM_LEDGER_LINK_OR_CREATE_SQL/);
  assert.match(FILES_SRC, /preselected_sig_file/);
  assert.match(FILES_SRC, /Send for Homeowner Signature/);
  assert.match(SIG_SRC, /Send for Signature/);
});

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const CLAIM_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const CHECK_1 = '33333333-3333-4333-8333-333333333331';
const CHECK_2 = '33333333-3333-4333-8333-333333333332';

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

test('isolated PostgreSQL Claim Ledger RPC links, creates atomically, and denies cross-tenant', { timeout: 180000 }, async (t) => {
  if (!fs.existsSync(path.join(PG_BIN, 'initdb'))) {
    t.skip('PostgreSQL 16 initdb is not installed in this environment');
    return;
  }
  const pgData = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-claim-ledger-'));
  const port = 55800 + (process.pid % 1000);
  const logPath = path.join(pgData, 'pg.log');
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
  const started = run(path.join(PG_BIN, 'pg_ctl'), [
    '-D', pgData, '-l', logPath, '-w', '-t', '30', 'start',
  ]);
  if (started.status !== 0) {
    throw new Error(`pg_ctl start failed: ${started.stderr || fs.readFileSync(logPath, 'utf8')}`);
  }
  const psql = (sql) => {
    const result = mustRun(path.join(PG_BIN, 'psql'), [
      '-h', pgData, '-p', String(port), '-U', 'ubuntu', '-d', 'postgres',
      '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql,
    ]);
    return String(result.stdout || '').trim();
  };
  try {
    psql(`
      CREATE FUNCTION public.ocr_claim_number_key(p_value text) RETURNS text
      LANGUAGE sql IMMUTABLE AS $$ SELECT NULLIF(lower(btrim(p_value)), ''); $$;
      CREATE TABLE public.claims (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        claim_number text UNIQUE,
        status text,
        org_id uuid,
        policyholder_name text,
        updated_at timestamptz DEFAULT now()
      );
      CREATE TABLE public.check_intake_items (
        id uuid PRIMARY KEY,
        tenant_id uuid,
        claim_id uuid,
        detected_claim_number text,
        amount numeric,
        deposited_at timestamptz,
        check_stage text,
        updated_at timestamptz DEFAULT now()
      );
    `);
    mustRun(path.join(PG_BIN, 'psql'), [
      '-h', pgData, '-p', String(port), '-U', 'ubuntu', '-d', 'postgres',
      '-v', 'ON_ERROR_STOP=1', '-f', path.join(ROOT, 'aws/write-path/sql/44_claim_ledger_link_or_create.sql'),
    ]);
    psql(`
      INSERT INTO public.claims (id, claim_number, status, org_id, policyholder_name)
      VALUES ('${CLAIM_A}', 'CL-EXIST', 'tracking', '${TENANT_A}', 'Pat');
      INSERT INTO public.check_intake_items (id, tenant_id, claim_id, check_stage)
      VALUES
        ('${CHECK_1}', '${TENANT_A}', '${CLAIM_A}', 'review'),
        ('${CHECK_2}', '${TENANT_A}', NULL, 'review');
    `);

    const already = JSON.parse(psql(
      `SELECT public.claim_ledger_link_or_create('${CHECK_1}','${TENANT_A}','CL-NEW','create_new');`,
    ));
    assert.equal(already.code, 'already_linked');
    assert.equal(already.claim_id, CLAIM_A);
    assert.equal(already.created, false);
    assert.equal(psql(`SELECT claim_id FROM public.check_intake_items WHERE id = '${CHECK_1}'`), CLAIM_A);
    assert.equal(psql(`SELECT count(*) FROM public.claims`), '1');

    const found = JSON.parse(psql(
      `SELECT public.claim_ledger_link_or_create('${CHECK_2}','${TENANT_A}','CL-EXIST','inspect');`,
    ));
    assert.equal(found.code, 'existing_found');
    assert.equal(found.claim_id, CLAIM_A);
    assert.equal(psql(`SELECT claim_id IS NULL FROM public.check_intake_items WHERE id = '${CHECK_2}'`), 't');

    const linked = JSON.parse(psql(
      `SELECT public.claim_ledger_link_or_create('${CHECK_2}','${TENANT_A}','CL-EXIST','link_existing');`,
    ));
    assert.equal(linked.code, 'linked');
    assert.equal(linked.claim_id, CLAIM_A);
    assert.equal(linked.check_claim_id, CLAIM_A);
    assert.equal(psql(`SELECT claim_id FROM public.check_intake_items WHERE id = '${CHECK_2}'`), CLAIM_A);
    assert.equal(psql(`SELECT count(*) FROM public.claims`), '1');

    const check3 = '33333333-3333-4333-8333-333333333333';
    psql(`INSERT INTO public.check_intake_items (id, tenant_id, claim_id) VALUES ('${check3}', '${TENANT_A}', NULL)`);
    const created = JSON.parse(psql(
      `SELECT public.claim_ledger_link_or_create('${check3}','${TENANT_A}','CL-NEW','create_new');`,
    ));
    assert.equal(created.code, 'created');
    assert.equal(created.created, true);
    assert.equal(created.check_claim_id, created.claim_id);
    assert.equal(psql(`SELECT claim_id FROM public.check_intake_items WHERE id = '${check3}'`), created.claim_id);
    assert.equal(psql(`SELECT count(*) FROM public.claims`), '2');

    const dup = JSON.parse(psql(
      `SELECT public.claim_ledger_link_or_create('${check3}','${TENANT_A}','CL-NEW','create_new');`,
    ));
    assert.equal(dup.code, 'already_linked');
    assert.equal(psql(`SELECT count(*) FROM public.claims`), '2');

    const check4 = '33333333-3333-4333-8333-333333333334';
    psql(`INSERT INTO public.check_intake_items (id, tenant_id, claim_id) VALUES ('${check4}', '${TENANT_B}', NULL)`);
    const cross = JSON.parse(psql(
      `SELECT public.claim_ledger_link_or_create('${check4}','${TENANT_B}','CL-EXIST','link_existing');`,
    ));
    assert.equal(cross.ok, false);
    assert.ok(['cross_tenant', 'no_match'].includes(cross.code));
    assert.equal(psql(`SELECT claim_id IS NULL FROM public.check_intake_items WHERE id = '${check4}'`), 't');

    const legacyClaim = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
    const legacyLinked = '33333333-3333-4333-8333-333333333335';
    const legacyUnlinked = '33333333-3333-4333-8333-333333333336';
    const ocrOnly = '33333333-3333-4333-8333-333333333337';
    psql(`
      INSERT INTO public.claims (id, claim_number, status, org_id, policyholder_name)
      VALUES ('${legacyClaim}', 'CL-LEGACY', 'tracking', NULL, 'Lee');
      INSERT INTO public.check_intake_items (id, tenant_id, claim_id, detected_claim_number, check_stage, amount, deposited_at)
      VALUES
        ('${legacyLinked}', '${TENANT_A}', '${legacyClaim}', 'CL-LEGACY', 'review', 10, NULL),
        ('${legacyUnlinked}', '${TENANT_A}', NULL, 'CL-LEGACY', 'review', 11, NULL),
        ('${ocrOnly}', '${TENANT_A}', NULL, 'CL-OCR-ONLY', 'review', 12, NULL);
    `);
    const inspectBefore = psql(`
      SELECT claim_id::text || '|' || amount::text || '|' || coalesce(deposited_at::text, '') || '|' || check_stage
      FROM public.check_intake_items WHERE id = '${legacyUnlinked}'
    `);
    const legacyFound = JSON.parse(psql(
      `SELECT public.claim_ledger_link_or_create('${legacyUnlinked}','${TENANT_A}','CL-LEGACY','inspect');`,
    ));
    assert.equal(legacyFound.code, 'existing_found');
    assert.equal(legacyFound.claim_id, legacyClaim);
    assert.equal(legacyFound.persisted, false);
    assert.equal(psql(`
      SELECT claim_id::text || '|' || amount::text || '|' || coalesce(deposited_at::text, '') || '|' || check_stage
      FROM public.check_intake_items WHERE id = '${legacyUnlinked}'
    `), inspectBefore);
    assert.equal(psql(`SELECT org_id IS NULL FROM public.claims WHERE id = '${legacyClaim}'`), 't');

    const ocrInspect = JSON.parse(psql(
      `SELECT public.claim_ledger_link_or_create('${ocrOnly}','${TENANT_A}','CL-OCR-ONLY','inspect');`,
    ));
    assert.equal(ocrInspect.code, 'no_match');
    assert.equal(ocrInspect.can_create, true);
    assert.equal(psql(`SELECT claim_id IS NULL FROM public.check_intake_items WHERE id = '${ocrOnly}'`), 't');
    assert.equal(psql(`SELECT count(*) FROM public.claims WHERE public.ocr_claim_number_key(claim_number) = 'cl-ocr-only'`), '0');

    const foreignOrg = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3';
    const foreignCheck = '33333333-3333-4333-8333-333333333338';
    psql(`
      INSERT INTO public.claims (id, claim_number, status, org_id)
      VALUES ('${foreignOrg}', 'CL-FOREIGN', 'tracking', '${TENANT_B}');
      INSERT INTO public.check_intake_items (id, tenant_id, claim_id)
      VALUES ('${foreignCheck}', '${TENANT_A}', NULL);
    `);
    const foreignInspect = JSON.parse(psql(
      `SELECT public.claim_ledger_link_or_create('${foreignCheck}','${TENANT_A}','CL-FOREIGN','inspect');`,
    ));
    assert.equal(foreignInspect.code, 'no_match');
    assert.equal(foreignInspect.can_create, false);
    const foreignLink = JSON.parse(psql(
      `SELECT public.claim_ledger_link_or_create('${foreignCheck}','${TENANT_A}','CL-FOREIGN','link_existing');`,
    ));
    assert.equal(foreignLink.code, 'cross_tenant');
    assert.equal(psql(`SELECT claim_id IS NULL FROM public.check_intake_items WHERE id = '${foreignCheck}'`), 't');

    const otherLegacy = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4';
    const otherLegacyLinked = '33333333-3333-4333-8333-333333333339';
    const otherLegacyProbe = '33333333-3333-4333-8333-33333333333a';
    psql(`
      INSERT INTO public.claims (id, claim_number, status, org_id)
      VALUES ('${otherLegacy}', 'CL-OTHER-LEG', 'tracking', NULL);
      INSERT INTO public.check_intake_items (id, tenant_id, claim_id)
      VALUES
        ('${otherLegacyLinked}', '${TENANT_B}', '${otherLegacy}'),
        ('${otherLegacyProbe}', '${TENANT_A}', NULL);
    `);
    const otherLegacyInspect = JSON.parse(psql(
      `SELECT public.claim_ledger_link_or_create('${otherLegacyProbe}','${TENANT_A}','CL-OTHER-LEG','inspect');`,
    ));
    assert.equal(otherLegacyInspect.code, 'no_match');
    assert.equal(otherLegacyInspect.can_create, false);
    const otherLegacyLink = JSON.parse(psql(
      `SELECT public.claim_ledger_link_or_create('${otherLegacyProbe}','${TENANT_A}','CL-OTHER-LEG','link_existing');`,
    ));
    assert.equal(otherLegacyLink.code, 'cross_tenant');
    assert.equal(psql(`SELECT claim_id IS NULL FROM public.check_intake_items WHERE id = '${otherLegacyProbe}'`), 't');

    const splitClaim = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5';
    const splitA = '33333333-3333-4333-8333-33333333333b';
    const splitB = '33333333-3333-4333-8333-33333333333c';
    const splitProbe = '33333333-3333-4333-8333-33333333333d';
    psql(`
      INSERT INTO public.claims (id, claim_number, status, org_id)
      VALUES ('${splitClaim}', 'CL-SPLIT', 'tracking', NULL);
      INSERT INTO public.check_intake_items (id, tenant_id, claim_id)
      VALUES
        ('${splitA}', '${TENANT_A}', '${splitClaim}'),
        ('${splitB}', '${TENANT_B}', '${splitClaim}'),
        ('${splitProbe}', '${TENANT_A}', NULL);
    `);
    const splitInspect = JSON.parse(psql(
      `SELECT public.claim_ledger_link_or_create('${splitProbe}','${TENANT_A}','CL-SPLIT','inspect');`,
    ));
    assert.equal(splitInspect.ok, false);
    assert.equal(splitInspect.code, 'ambiguous');
    const splitLink = JSON.parse(psql(
      `SELECT public.claim_ledger_link_or_create('${splitProbe}','${TENANT_A}','CL-SPLIT','link_existing');`,
    ));
    assert.equal(splitLink.code, 'ambiguous');
    assert.equal(psql(`SELECT claim_id IS NULL FROM public.check_intake_items WHERE id = '${splitProbe}'`), 't');
    assert.equal(psql(`SELECT org_id IS NULL FROM public.claims WHERE id = '${splitClaim}'`), 't');

    const dupKeyA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6';
    const dupKeyB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7';
    const dupProbe = '33333333-3333-4333-8333-33333333333e';
    psql(`
      INSERT INTO public.claims (id, claim_number, status, org_id)
      VALUES
        ('${dupKeyA}', 'CL-DUP', 'tracking', '${TENANT_A}'),
        ('${dupKeyB}', 'cl-dup', 'tracking', '${TENANT_A}');
      INSERT INTO public.check_intake_items (id, tenant_id, claim_id)
      VALUES ('${dupProbe}', '${TENANT_A}', NULL);
    `);
    const dupInspect = JSON.parse(psql(
      `SELECT public.claim_ledger_link_or_create('${dupProbe}','${TENANT_A}','CL-DUP','inspect');`,
    ));
    assert.equal(dupInspect.ok, false);
    assert.equal(dupInspect.code, 'ambiguous');
    assert.equal(psql(`SELECT claim_id IS NULL FROM public.check_intake_items WHERE id = '${dupProbe}'`), 't');

    const legacyLink = JSON.parse(psql(
      `SELECT public.claim_ledger_link_or_create('${legacyUnlinked}','${TENANT_A}','CL-LEGACY','link_existing');`,
    ));
    assert.equal(legacyLink.code, 'linked');
    assert.equal(legacyLink.claim_id, legacyClaim);
    assert.equal(legacyLink.check_claim_id, legacyClaim);
    assert.equal(psql(`SELECT claim_id FROM public.check_intake_items WHERE id = '${legacyUnlinked}'`), legacyClaim);
    assert.equal(psql(`SELECT org_id IS NULL FROM public.claims WHERE id = '${legacyClaim}'`), 't');
    assert.equal(psql(`SELECT amount::text FROM public.check_intake_items WHERE id = '${legacyUnlinked}'`), '11');
  } finally {
    run(path.join(PG_BIN, 'pg_ctl'), ['-D', pgData, '-m', 'fast', '-w', 'stop']);
  }
});
