/**
 * SQL 97 against PostgreSQL 16 (shared helper): an app_financial_totp
 * step-up row is written only by the server path (auth-financial-totp
 * insertAppStepUpLog, admin-reset-totp consumption), never by a client-shaped
 * insert. Also: a teammate 2FA reset uses a step-up bound to a tenant the
 * caller shares with the target (RESET_TOTP_STEPUP_SQL), so a step-up
 * recorded in another tenant does not count.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { AWS_ROOT, pgSkipReason, startPg } from './helpers/stakeholder-policies-pg.mjs';
import { insertAppStepUpLog, STEPUP_WRITER_SQL } from '../functions/api/auth-financial-totp.mjs';
import {
  RESET_TOTP_CONSUME_SQL,
  RESET_TOTP_STEPUP_SQL,
  TEAM_RESET_TOTP_ACTION,
  TEAM_RESET_TOTP_CONSUMED_ACTION,
} from '../functions/api/admin-reset-totp.mjs';

const SQL_97 = path.join(AWS_ROOT, 'workflows/sql/97_financial_stepup_log_server_writer.sql');
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '33333333-3333-4333-8333-333333333333';
const CALLER = 'a1000000-0000-4000-8000-000000000001';
const TARGET = 'a1000000-0000-4000-8000-000000000002';
const LOGIN = 'sub-1:origin-1';

const SCHEMA = `
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE checksops LOGIN NOSUPERUSER NOBYPASSRLS INHERIT;
GRANT authenticated TO checksops;
CREATE ROLE web_login LOGIN NOSUPERUSER INHERIT;
GRANT authenticated TO web_login;
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO authenticated;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.app_user_id', true), '')::uuid $$;
GRANT USAGE ON SCHEMA public TO authenticated;
CREATE TABLE public.tenant_users (tenant_id uuid NOT NULL, user_id uuid NOT NULL, role text);
CREATE TABLE public.financial_stepup_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, tenant_id uuid,
  action_key text NOT NULL, factor_type text, succeeded boolean, metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now());
-- The Supabase-era grant: every authenticated client could insert.
GRANT SELECT, INSERT ON TABLE public.financial_stepup_log TO authenticated;
GRANT SELECT ON TABLE public.tenant_users TO authenticated;
INSERT INTO public.tenant_users VALUES ('${TENANT_A}', '${CALLER}', 'owner'), ('${TENANT_B}', '${CALLER}', 'viewer'),
  ('${TENANT_B}', '${TARGET}', 'viewer');
`;

const forged = (tenantId = TENANT_A) => ({
  sql: `INSERT INTO public.financial_stepup_log (user_id, tenant_id, action_key, factor_type, succeeded, metadata)
        VALUES ($1::uuid, $2::uuid, 'deposit.submit', 'totp', true, $3::jsonb)`,
  params: [CALLER, tenantId, JSON.stringify({ source: 'app_financial_totp', login_session: LOGIN })],
});

test('PostgreSQL 16: SQL 97 lets only the server record app_financial_totp step-ups; resets use the shared tenant', {
  timeout: 180000, skip: pgSkipReason() || false,
}, async () => {
  const { default: pg } = await import('pg');
  const server = startPg('pg-sql97-stepup-', 55700);
  const admin = new pg.Client({ host: server.host, port: server.port, user: 'ubuntu', database: 'postgres' });
  const connectAs = async (user) => {
    const c = new pg.Client({ host: server.host, port: server.port, user, database: 'postgres' });
    await c.connect();
    return c;
  };
  const inTx = async (c, fn) => {
    await c.query('BEGIN');
    try {
      await c.query("SELECT set_config('request.app_user_id', $1, true)", [CALLER]);
      const out = await fn();
      await c.query('COMMIT');
      return out;
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    }
  };
  let checksops = null;
  let web = null;
  try {
    await admin.connect();
    await admin.query(SCHEMA);
    checksops = await connectAs('checksops');
    web = await connectAs('web_login');
    // Before SQL 97: a client-shaped insert writes a valid step-up.
    const before = forged();
    assert.equal((await inTx(web, () => web.query(before.sql, before.params))).rowCount, 1);
    await admin.query('TRUNCATE public.financial_stepup_log');

    // Refuses without the table; then apply twice.
    await admin.query('BEGIN');
    await admin.query('ALTER TABLE public.financial_stepup_log RENAME TO fsl_x');
    await assert.rejects(admin.query(fs.readFileSync(SQL_97, 'utf8')), (e) => e.code === '55000' && /sql97_prerequisite_missing/.test(e.message));
    await admin.query('ROLLBACK');
    await admin.query(fs.readFileSync(SQL_97, 'utf8'));
    await admin.query(fs.readFileSync(SQL_97, 'utf8'));

    // A client role that only has authenticated's privileges cannot insert at all.
    const f = forged();
    await assert.rejects(inTx(web, () => web.query(f.sql, f.params)), /permission denied/);
    // checksops without the server's writer setting: an app_financial_totp row is refused.
    await assert.rejects(inTx(checksops, () => checksops.query(f.sql, f.params)),
      (e) => e.code === '42501' && /stepup_writer_required/.test(e.message));
    // A writer setting from an earlier transaction does not carry over (transaction-local).
    await inTx(checksops, () => checksops.query(STEPUP_WRITER_SQL));
    await assert.rejects(inTx(checksops, () => checksops.query(f.sql, f.params)), (e) => e.code === '42501');
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM public.financial_stepup_log')).rows[0].n, 0);

    // The server path (insertAppStepUpLog sets the writer setting) records step-ups.
    const mapping = { application_user_id: CALLER };
    const recordedA = await inTx(checksops, () => insertAppStepUpLog(checksops, mapping, {
      kind: 'login_session', tenantId: TENANT_A, loginSession: LOGIN, actionKey: TEAM_RESET_TOTP_ACTION,
    }));
    assert.equal(recordedA.recorded, true);
    // The writer flag is cleared right after the server's insert: a forged row later in
    // the same transaction is refused.
    await assert.rejects(inTx(checksops, async () => {
      await insertAppStepUpLog(checksops, mapping, {
        kind: 'login_session', tenantId: TENANT_A, loginSession: LOGIN, actionKey: 'wallet.fund',
      });
      assert.equal((await checksops.query("SELECT current_setting('app.stepup_writer', true) AS v")).rows[0].v, '0');
      await checksops.query(f.sql, f.params);
    }), (e) => e.code === '42501' && /stepup_writer_required/.test(e.message));
    const row = (await admin.query('SELECT tenant_id, metadata FROM public.financial_stepup_log WHERE id = $1', [recordedA.stepup_id])).rows[0];
    assert.equal(row.tenant_id, TENANT_A);
    assert.equal(row.metadata.source, 'app_financial_totp');

    // team.reset_totp: the caller (tenants A and B) resets a teammate who shares
    // only tenant B. The step-up recorded in tenant A does not count.
    const lookup = (c) => c.query(RESET_TOTP_STEPUP_SQL, [CALLER, TARGET, TEAM_RESET_TOTP_ACTION, LOGIN, 15, TEAM_RESET_TOTP_CONSUMED_ACTION]);
    assert.equal((await inTx(checksops, () => lookup(checksops))).rows.length, 0);
    const recordedB = await inTx(checksops, () => insertAppStepUpLog(checksops, mapping, {
      kind: 'login_session', tenantId: TENANT_B, loginSession: LOGIN, actionKey: TEAM_RESET_TOTP_ACTION,
    }));
    const found = (await inTx(checksops, () => lookup(checksops))).rows;
    assert.equal(found.length, 1);
    assert.equal(found[0].tenant_id, TENANT_B);
    assert.equal(found[0].id, recordedB.stepup_id);
    // Another login session's step-up does not count either.
    assert.equal((await inTx(checksops, () => checksops.query(RESET_TOTP_STEPUP_SQL,
      [CALLER, TARGET, TEAM_RESET_TOTP_ACTION, 'sub-1:other', 15, TEAM_RESET_TOTP_CONSUMED_ACTION]))).rows.length, 0);

    // The consumption row (not app_financial_totp) is written by the server and uses the step-up up.
    await inTx(checksops, async () => {
      await checksops.query(STEPUP_WRITER_SQL);
      await checksops.query(RESET_TOTP_CONSUME_SQL, [CALLER, TENANT_B, TEAM_RESET_TOTP_CONSUMED_ACTION,
        JSON.stringify({ stepup_id: recordedB.stepup_id, target_user_id: TARGET, source: 'team_reset_totp_consumed' })]);
    });
    assert.equal((await inTx(checksops, () => lookup(checksops))).rows.length, 0);
  } finally {
    await checksops?.end().catch(() => {});
    await web?.end().catch(() => {});
    await admin.end().catch(() => {});
    server.stop();
  }
});
