import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import {
  FUNCTION_DEF_LOOKUP_SQL,
  functionDefsMatchExactly,
  readFunctionDef,
} from '../../scripts/deployment-guard/lib/function-def-lookup.mjs';
import {
  extractPinnedFunctionSql,
  tenantPermissionDefsAreExact,
} from '../write-path/guarded-sql-executor/index.mjs';

const MIGRATION = fs.readFileSync(
  new URL('../../supabase/migrations/20261001231500_tenant_users_same_check_permissions.sql', import.meta.url),
  'utf8',
);

const STUBS = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;
DO $$ BEGIN
  CREATE TYPE public.app_role AS ENUM ('admin', 'user');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE public.check_stage AS ENUM ('review', 'endorsing', 'ready_for_deposit', 'loss_draft');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE TABLE IF NOT EXISTS public.check_intake_items (
  id uuid PRIMARY KEY,
  tenant_id uuid,
  status text,
  check_stage public.check_stage,
  deposit_recommendation text,
  updated_at timestamptz
);
CREATE TABLE IF NOT EXISTS public.claim_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_intake_item_id uuid,
  check_stage public.check_stage,
  updated_at timestamptz
);
CREATE TABLE IF NOT EXISTS public.check_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_id uuid,
  event_type text,
  actor_id uuid,
  event_description text,
  event_data jsonb
);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
CREATE OR REPLACE FUNCTION public.user_belongs_to_tenant(_user_id uuid, _tenant_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
`;

function pgConfig() {
  if (process.env.CHECKSOPS_TEST_DATABASE_URL) {
    return { connectionString: process.env.CHECKSOPS_TEST_DATABASE_URL };
  }
  return {
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || 'repro',
    password: process.env.PGPASSWORD || 'repro',
    database: process.env.PGDATABASE || 'repro',
  };
}

async function connectOrSkip(t) {
  let pg;
  try {
    ({ default: pg } = await import('pg'));
  } catch {
    t.skip('pg module is not installed');
    return null;
  }
  const client = new pg.Client(pgConfig());
  try {
    await client.connect();
    return client;
  } catch (error) {
    t.skip(`PostgreSQL is not available for create→inspect: ${error.message}`);
    return null;
  }
}

test('#601 create then immediate #616-style inspect is visible after the lower-bound fix', async (t) => {
  const client = await connectOrSkip(t);
  if (!client) return;
  try {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    await client.query(STUBS);

    const broken = await client.query(`
      SELECT
        array_lower(p.proargtypes::oid[], 1) AS proc_lower,
        array_lower(agg.oids, 1) AS agg_lower,
        p.proargtypes::oid[] = agg.oids AS broken_616_equal
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      CROSS JOIN LATERAL (
        SELECT COALESCE(ARRAY_AGG(u.typ::regtype::oid ORDER BY u.ord), ARRAY[]::oid[]) AS oids
        FROM unnest(ARRAY['uuid','uuid']::text[]) WITH ORDINALITY AS u(typ, ord)
      ) agg
      WHERE n.nspname = 'public' AND p.proname = 'has_role'
    `);
    assert.equal(broken.rows[0].proc_lower, 0);
    assert.equal(broken.rows[0].agg_lower, 1);
    assert.equal(broken.rows[0].broken_616_equal, false);

    const beforeMove = await readFunctionDef(client, 'public.user_can_move_tenant_checks(uuid,uuid)');
    const beforeOverride = await readFunctionDef(client, 'public.admin_override_check_status(uuid,text,uuid)');
    assert.equal(beforeMove.details.exists, false);
    assert.equal(beforeOverride.details.exists, false);

    const applied = await client.query(MIGRATION);
    assert.equal(Array.isArray(applied), true);
    assert.deepEqual(applied.map((row) => row.command), ['CREATE', 'CREATE']);

    const move = await readFunctionDef(client, 'public.user_can_move_tenant_checks(uuid,uuid)');
    const override = await readFunctionDef(client, 'public.admin_override_check_status(uuid,text,uuid)');
    assert.equal(move.ok, true, move.message);
    assert.equal(override.ok, true, override.message);
    assert.equal(move.details.exists, true);
    assert.equal(override.details.exists, true);
    assert.equal(
      functionDefsMatchExactly(move.details.definition, extractPinnedFunctionSql(MIGRATION, 'user_can_move_tenant_checks')),
      true,
    );
    assert.equal(
      functionDefsMatchExactly(override.details.definition, extractPinnedFunctionSql(MIGRATION, 'admin_override_check_status')),
      true,
    );
    assert.equal(tenantPermissionDefsAreExact({
      user_can_move_tenant_checks: move.details.definition,
      admin_override_check_status: override.details.definition,
    }, MIGRATION), true);

    const raw = await client.query(FUNCTION_DEF_LOOKUP_SQL, [
      'public',
      'admin_override_check_status',
      ['uuid', 'text', 'uuid'],
    ]);
    assert.equal(raw.rows.length, 1);
    assert.equal(typeof raw.rows[0].def, 'string');
    assert.equal(/AS\s+oidvector/i.test(FUNCTION_DEF_LOOKUP_SQL), false);
  } finally {
    await client.end();
  }
});
