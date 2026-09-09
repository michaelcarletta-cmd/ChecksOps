import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SQL_PATH = path.join(ROOT, 'write-path/sql/39_endorsing_child_tenant_backfill.sql');
const SCRIPT_PATH = path.join(ROOT, 'write-path/scripts/dry-run-endorsing-tenant-backfill.mjs');
const sql = fs.readFileSync(SQL_PATH, 'utf8');
const script = fs.readFileSync(SCRIPT_PATH, 'utf8');

const uncommented = sql
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');

test('backfill SQL only updates NULL child tenant_id from parent and never touches RLS', () => {
  assert.match(uncommented, /UPDATE public\.check_payees[\s\S]*SET tenant_id = plan\.parent_tenant_id[\s\S]*AND p\.tenant_id IS NULL/);
  assert.match(uncommented, /UPDATE public\.check_endorsements[\s\S]*SET tenant_id = plan\.parent_tenant_id[\s\S]*AND e\.tenant_id IS NULL/);
  assert.match(uncommented, /p\.tenant_id IS NULL AND i\.tenant_id IS NOT NULL/);
  assert.match(uncommented, /e\.tenant_id IS NULL AND i\.tenant_id IS NOT NULL/);
  assert.match(uncommented, /refusing backfill: tenant mismatch/);
  assert.match(uncommented, /to_jsonb\(p\) - 'tenant_id'/);
  assert.match(uncommented, /to_jsonb\(e\) - 'tenant_id'/);
  assert.match(uncommented, /signature_image_url/);
  assert.match(uncommented, /endorsement_image_path/);
  assert.match(uncommented, /reminder_count/);
  assert.match(uncommented, /last_reminder_at/);
  assert.equal(/CREATE POLICY|ALTER POLICY|FORCE ROW LEVEL|DISABLE ROW LEVEL|ENABLE ROW LEVEL/i.test(uncommented), false);
  assert.equal(/\bINSERT\b/i.test(uncommented), false);
  assert.equal(/\bDELETE\b/i.test(uncommented), false);
  assert.equal(/\bCOMMIT\s*;/i.test(uncommented), false);
  assert.equal(/SET tenant_id = plan\.parent_tenant_id,\s*\w+/.test(uncommented), false);
});

test('dry-run runner always rolls back and refuses APPLY', () => {
  assert.match(script, /ROLLBACK/);
  assert.match(script, /Refusing apply/);
  assert.match(script, /CHECKSOPS_BACKFILL_APPLY/);
  assert.equal(/query\(\s*['"]COMMIT['"]\s*\)/.test(script), false);
});

const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const C1C = '4f172140-f57a-4744-8050-95f4f07b13b4';
const pgPeer = (database) => ({
  host: '/var/run/postgresql',
  user: process.env.USER || 'ubuntu',
  database,
});

test('fixture database backfills only NULL children and rolls back', async () => {
  const requireFromApi = createRequire(new URL('../functions/api/package.json', import.meta.url));
  const { Client } = requireFromApi('pg');
  const dbName = `endorsing_backfill_test_${process.pid}_${Date.now()}`;
  const admin = new Client(pgPeer('postgres'));
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  const client = new Client(pgPeer(dbName));
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE public.check_intake_items (
        id uuid PRIMARY KEY,
        tenant_id uuid,
        check_number text,
        amount numeric,
        status text,
        check_stage text,
        payee_line text
      );
      CREATE TABLE public.check_payees (
        id uuid PRIMARY KEY,
        check_id uuid,
        tenant_id uuid,
        payee_name text,
        payee_type text,
        endorsement_status text,
        endorsed_at timestamptz,
        endorsement_image_path text
      );
      CREATE TABLE public.check_endorsements (
        id uuid PRIMARY KEY,
        check_id uuid,
        payee_id uuid,
        tenant_id uuid,
        payee_name text,
        payee_type text,
        status text,
        signed_at timestamptz,
        signature_image_url text,
        reminder_count int,
        last_reminder_at timestamptz
      );
    `);
    const parentFreedom = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
    const parentC1c = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
    const missingParent = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3';
    await client.query(`
      INSERT INTO public.check_intake_items
        (id, tenant_id, check_number, amount, status, check_stage, payee_line)
      VALUES
        ($1, $3, '271682', 100, 'endorsements_in_progress', 'endorsing', 'Freedom Adjustment'),
        ($2, $4, 'c1c-only', 50, 'endorsements_in_progress', 'endorsing', 'C1C');
    `, [parentFreedom, parentC1c, FREEDOM, C1C]);
    await client.query(`
      INSERT INTO public.check_payees
        (id, check_id, tenant_id, payee_name, payee_type, endorsement_status, endorsement_image_path)
      VALUES
        ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', $1, NULL, 'Anissa Nassry', 'insured', 'pending', NULL),
        ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', $1, $3, 'Already Visible', 'insured', 'signed', 'sig/a.png'),
        ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3', $4, NULL, 'Orphan Payee', 'insured', 'pending', NULL),
        ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4', $2, NULL, 'C1C Hidden', 'insured', 'pending', NULL);
    `, [parentFreedom, parentC1c, FREEDOM, missingParent]);
    await client.query(`
      INSERT INTO public.check_endorsements
        (id, check_id, payee_id, tenant_id, payee_name, payee_type, status, signature_image_url, reminder_count)
      VALUES
        ('cccccccc-cccc-4ccc-8ccc-ccccccccccc1', $1, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', NULL, 'Anissa Nassry', 'insured', 'pending', NULL, 2),
        ('cccccccc-cccc-4ccc-8ccc-ccccccccccc2', $1, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', $2, 'Already Visible', 'insured', 'signed', 'https://example/sig.png', 0);
    `, [parentFreedom, FREEDOM]);

    await client.query('BEGIN');
    await client.query(sql);
    const payees = (await client.query('SELECT id, tenant_id, endorsement_status, endorsement_image_path FROM public.check_payees ORDER BY id')).rows;
    const endorsements = (await client.query('SELECT id, tenant_id, status, signature_image_url, reminder_count FROM public.check_endorsements ORDER BY id')).rows;
    const byId = Object.fromEntries(payees.map((row) => [row.id, row]));
    assert.equal(byId['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'].tenant_id, FREEDOM);
    assert.equal(byId['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'].endorsement_status, 'pending');
    assert.equal(byId['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'].tenant_id, FREEDOM);
    assert.equal(byId['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'].endorsement_status, 'signed');
    assert.equal(byId['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'].endorsement_image_path, 'sig/a.png');
    assert.equal(byId['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3'].tenant_id, null);
    assert.equal(byId['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4'].tenant_id, C1C);
    assert.equal(endorsements[0].tenant_id, FREEDOM);
    assert.equal(endorsements[0].status, 'pending');
    assert.equal(endorsements[0].reminder_count, 2);
    assert.equal(endorsements[1].status, 'signed');
    assert.equal(endorsements[1].signature_image_url, 'https://example/sig.png');
    const c1c = await client.query('SELECT count(*)::int AS n FROM public.check_payees WHERE tenant_id = $1', [C1C]);
    assert.equal(c1c.rows[0].n, 1);
    const freedomVisible = await client.query(
      `SELECT count(*)::int AS n FROM public.check_payees p
       JOIN public.check_intake_items i ON i.id = p.check_id
       WHERE i.check_number = '271682' AND p.tenant_id = $1`,
      [FREEDOM],
    );
    assert.equal(freedomVisible.rows[0].n, 2);
    await client.query('ROLLBACK');
    const afterRollback = await client.query('SELECT count(*)::int AS n FROM public.check_payees WHERE tenant_id IS NULL');
    assert.equal(afterRollback.rows[0].n, 3);
  } finally {
    await client.end();
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  }
});

test('fixture aborts on tenant mismatch and does not overwrite non-null tenant_id', async () => {
  const requireFromApi = createRequire(new URL('../functions/api/package.json', import.meta.url));
  const { Client } = requireFromApi('pg');
  const dbName = `endorsing_backfill_mismatch_${process.pid}_${Date.now()}`;
  const admin = new Client(pgPeer('postgres'));
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  const client = new Client(pgPeer(dbName));
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE public.check_intake_items (
        id uuid PRIMARY KEY, tenant_id uuid, check_number text, amount numeric,
        status text, check_stage text, payee_line text
      );
      CREATE TABLE public.check_payees (
        id uuid PRIMARY KEY, check_id uuid, tenant_id uuid, payee_name text, payee_type text,
        endorsement_status text, endorsed_at timestamptz, endorsement_image_path text
      );
      CREATE TABLE public.check_endorsements (
        id uuid PRIMARY KEY, check_id uuid, payee_id uuid, tenant_id uuid, payee_name text,
        payee_type text, status text, signed_at timestamptz, signature_image_url text,
        reminder_count int, last_reminder_at timestamptz
      );
    `);
    await client.query(
      `INSERT INTO public.check_intake_items VALUES
        ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', $1, '129810787', 1, 'endorsements_in_progress', 'endorsing', 'x')`,
      [FREEDOM],
    );
    await client.query(
      `INSERT INTO public.check_payees VALUES
        ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', $1, 'Mismatch', 'insured', 'pending', NULL, NULL)`,
      [C1C],
    );
    await client.query('BEGIN');
    await assert.rejects(() => client.query(sql), /tenant mismatch/);
    await client.query('ROLLBACK');
    const row = await client.query('SELECT tenant_id FROM public.check_payees');
    assert.equal(row.rows[0].tenant_id, C1C);
  } finally {
    await client.end();
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  }
});
