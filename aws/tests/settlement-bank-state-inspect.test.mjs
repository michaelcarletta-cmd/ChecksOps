/**
 * Read-only production inspect of one organization's settlement-bank state
 * (scripts/deployment-guard/settlement-bank-state-inspect.mjs,
 * lib/settlement-bank-state-inspect.mjs, ops/production-settlement-bank-state-inspect.md).
 * Owner 2026-11-25: "yes start with the read-only check" (Condition One: "No settlement bank",
 * the micro-deposit never sent from ChecksOps, "This verification can no longer accept codes").
 *
 *   - the configuration is inspect-only and bound to the same production RDS and
 *     checksops_admin secret as the Mortgage Desk access inspect; the tool is inventoried SAFE
 *     and is not a one-shot apply entry;
 *   - the CLI accepts exactly --inspect and refuses every other argument and any
 *     deployment-guard environment variable before reading a secret or connecting;
 *   - every statement is a fixed constant (BEGIN READ ONLY, SELECT / WITH ... SELECT, ROLLBACK)
 *     whose only parameter is the fixed tenant id (or the table list);
 *   - the derived answers follow the website's Transfer to bank list and the initiate handler;
 *   - on PostgreSQL 16, as a non-superuser checksops_admin: only the target tenant's rows are
 *     read, nothing changes, and the output has no uuid, name, bank name, digits, error text or
 *     payload value.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { main } from '../../scripts/deployment-guard/settlement-bank-state-inspect.mjs';
import {
  INSPECT_STATEMENTS,
  Q,
  TARGET_TENANT_ID,
  buildReport,
  initiateCandidate,
  loadInspectConfig,
  ownMoovBanks,
} from '../../scripts/deployment-guard/lib/settlement-bank-state-inspect.mjs';
import { ONE_SHOT_TOOLS } from '../../scripts/deployment-guard/lib/production-sql-one-shot.mjs';
import { C1C_TENANT } from '../identity/oneshot/onboard.mjs';
import { pgSkipReason, startPg } from './helpers/stakeholder-policies-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TOOL = 'scripts/deployment-guard/settlement-bank-state-inspect.mjs';
const LIB = 'scripts/deployment-guard/lib/settlement-bank-state-inspect.mjs';
const READ_ONLY_STATEMENT_RE = /^\s*(BEGIN READ ONLY|SELECT|WITH|ROLLBACK)\b/;
const MUTATING_RE = /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE|COPY|CALL|DO|LOCK|VACUUM|ANALYZE|REFRESH|COMMENT|SECURITY LABEL|REASSIGN|nextval|setval|pg_terminate|pg_cancel|lo_)\b/i;
/** The only column names a statement may return. */
const RETURNED = new Set(['current_user', 'session_user', 'transaction_read_only', 'server_version_num', 'table_name', 'column_name',
  'row_security_active', 'set_config', 'tenant_rows', 'provider', 'environment', 'onboarding_status', 'verification_status',
  'has_provider_account', 'disabled', 'restricted', 'last_webhook_event_type', 'created_minute', 'synced_minute', 'seq',
  'is_recipient_bank', 'has_provider_bank', 'account_matches', 'connection_status', 'is_default', 'can_send', 'can_receive', 'source',
  'provider_status', 'connected_minute', 'disconnected_minute', 'method', 'status', 'attempts', 'max_attempts', 'failure_reason',
  'has_payment_method', 'payment_method_found', 'method_seq', 'bank_matches', 'initiated_minute', 'verified_minute', 'updated_minute',
  'event_type', 'previous_status', 'new_status', 'action_key', 'factor_type', 'succeeded', 'account_type', 'is_active', 'is_primary',
  'accounts']);
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const quiet = async (fn) => {
  const out = process.stdout.write;
  const err = process.stderr.write;
  const chunks = [];
  process.stdout.write = (c) => { chunks.push(String(c)); return true; };
  process.stderr.write = (c) => { chunks.push(String(c)); return true; };
  try {
    const code = await fn();
    return { code, text: chunks.join('') };
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
};

// --- configuration, inventory, statements ------------------------------------------------

test('the configuration is inspect-only and bound to the same production RDS and admin secret as the Mortgage Desk inspect', () => {
  const config = loadInspectConfig(ROOT);
  const desk = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/mortgage-desk-access-production-inspect.json'), 'utf8'));
  assert.equal(config.id, 'settlement-bank-state-inspect');
  assert.equal(config.read_only, true);
  assert.equal(config.apply, false);
  assert.equal(config.target_environment, 'production');
  assert.equal(config.tool, TOOL);
  assert.equal(config.execute, undefined);
  assert.equal(config.authorization_phrase, undefined);
  assert.equal(config.production_inspect, null, 'nothing has been run');
  for (const key of ['admin_login', 'rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(config[key], desk[key], key);
  assert.ok(fs.existsSync(path.join(ROOT, config.runbook)));
});

test('the tool is inventoried as SAFE, is not a one-shot apply entry and has no write capability', () => {
  const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/bypass-inventory.json'), 'utf8'));
  const entry = inventory.scripts.find((s) => s.path === TOOL);
  assert.ok(entry, 'inventoried');
  assert.equal(entry.classification, 'SAFE');
  assert.match(entry.note, /BEGIN READ ONLY/);
  assert.ok(!JSON.stringify(ONE_SHOT_TOOLS).includes('settlement-bank-state-inspect'));
  const source = fs.readFileSync(path.join(ROOT, TOOL), 'utf8') + fs.readFileSync(path.join(ROOT, LIB), 'utf8');
  assert.doesNotMatch(source, /CHECKSOPS_DEPLOYMENT_GUARD_APPLY|issueReceipt|acquireLease|UpdateFunctionCode|PutObject|SendCommand/);
});

test('the target is Condition One, the same tenant the identity one-shot names', () => {
  assert.equal(TARGET_TENANT_ID, C1C_TENANT);
});

test('every statement is a fixed read-only constant and returns only the allowed columns', () => {
  assert.equal(INSPECT_STATEMENTS[0], 'BEGIN READ ONLY');
  assert.equal(INSPECT_STATEMENTS.at(-1), 'ROLLBACK');
  for (const sql of INSPECT_STATEMENTS) {
    assert.match(sql, READ_ONLY_STATEMENT_RE, sql);
    if (/^\s*(BEGIN READ ONLY|ROLLBACK)\s*$/.test(sql)) continue;
    assert.doesNotMatch(sql.replace(/'[^']*'/g, "''"), MUTATING_RE, sql);
    assert.doesNotMatch(sql, UUID_RE, 'the tenant id is a bind parameter, never inlined');
    for (const alias of [...sql.matchAll(/\bAS\s+([a-z0-9_]+)\b(?!\s*\()/g)].map((m) => m[1])) {
      if (['methods'].includes(alias)) continue; // the CTE name in verifications
      assert.ok(RETURNED.has(alias), `${alias} in ${sql}`);
    }
    // Names, digits and provider ids are never selected as values.
    assert.doesNotMatch(sql, /\b(holder_name|bank_name|last_four|routing_last_four|display_name|nickname|chk_aba|chk_acct|custname)\b/, sql);
    assert.doesNotMatch(sql, /\b[a-z]\.(provider_account_id|provider_bank_account_id|external_recipient_id|payment_method_id|user_id|tenant_id|id)(\s+AS\s|\)::text, ''\) AS\s)/, sql);
  }
});

test('the derived answers follow the Transfer to bank list and the micro-deposit initiate handler', () => {
  const lister = fs.readFileSync(path.join(ROOT, 'src/hooks/useWalletWithdraw.ts'), 'utf8');
  assert.match(lister, /\.eq\("provider", "moov"\)[\s\S]{0,80}\.eq\("environment", walletEnvironment\)[\s\S]{0,40}\.is\("external_recipient_id", null\)/);
  const handlers = fs.readFileSync(path.join(ROOT, 'aws/functions/api/providers/onboarding/handlers.mjs'), 'utf8');
  const initiate = handlers.slice(handlers.indexOf("'moov-micro-deposit-initiate'"), handlers.indexOf("'moov-micro-deposit-confirm'"));
  assert.match(initiate, /external_recipient_id IS NULL AND connection_status <> 'disconnected'/);
  assert.match(initiate, /if \(!method\) return fail\('Bank account not found\.', 404\)/);
  assert.ok(initiate.indexOf("fail('Bank account not found.'") < initiate.indexOf('/verify`'), 'no Moov call without a row');

  const row = (over) => ({ provider: 'moov', environment: 'production', is_recipient_bank: false, connection_status: 'connected',
    has_provider_account: true, has_provider_bank: true, ...over });
  assert.equal(initiateCandidate([], 'production'), 'bank_account_not_found');
  assert.equal(initiateCandidate([row({ environment: 'sandbox' })], 'production'), 'bank_account_not_found');
  assert.equal(initiateCandidate([row({ is_recipient_bank: true })], 'production'), 'bank_account_not_found');
  assert.equal(initiateCandidate([row({ connection_status: 'disconnected' })], 'production'), 'bank_account_not_found');
  assert.equal(initiateCandidate([row({ has_provider_bank: false })], 'production'), 'not_ready_for_verification');
  assert.equal(initiateCandidate([row({ connection_status: 'pending' })], 'production'), 'would_call_moov');
  assert.equal(ownMoovBanks([row({ connection_status: 'disconnected' }), row({ provider: 'stripe' })], 'production').length, 1);
});

// --- CLI refusals ------------------------------------------------------------------------

test('the CLI accepts exactly --inspect and refuses everything else before a secret or connection', async () => {
  for (const argv of [[], ['--apply'], ['--inspect', '--apply'], ['--inspect', '--input', 'x.json'], ['--inspect', '--password', 'x'],
    ['--inspect', '--sql', 'SELECT 1'], ['--inspect', '--tenant', '00000000-0000-4000-8000-000000000001'], ['--inspect=1'], ['inspect'],
    ['--inspect', '--inspect']]) {
    let touched = false;
    const deps = {
      root: ROOT,
      connect: async () => { touched = true; throw new Error('must not connect'); },
      resolveUrl: async () => { touched = true; throw new Error('must not read the secret'); },
    };
    const { code, text } = await quiet(() => main(argv, {}, deps));
    assert.equal(code, 1, argv.join(' '));
    assert.equal(touched, false, argv.join(' '));
    assert.match(text, /accepts exactly one argument: --inspect/);
    assert.doesNotMatch(text, /x\.json|SELECT 1|00000000-0000/);
  }
});

test('the CLI refuses any deployment-guard environment variable or a configuration that is not read-only production', async () => {
  for (const env of [{ CHECKSOPS_SKIP_DEPLOYMENT_GUARD: '1' }, { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' }]) {
    let touched = false;
    const deps = { root: ROOT, connect: async () => { touched = true; }, resolveUrl: async () => { touched = true; } };
    const { code, text } = await quiet(() => main(['--inspect'], env, deps));
    assert.equal(code, 1);
    assert.equal(touched, false);
    assert.match(text, /refuses to run with deployment-guard environment variables/);
  }
  const base = loadInspectConfig(ROOT);
  for (const config of [{ ...base, read_only: false }, { ...base, apply: true }, { ...base, target_environment: 'staging' }]) {
    let touched = false;
    const { code } = await quiet(() => main(['--inspect'], {}, { root: ROOT, config, connect: async () => { touched = true; throw new Error('no'); } }));
    assert.equal(code, 1);
    assert.equal(touched, false);
  }
});

test('a connection failure prints only the JSON error with its code', async () => {
  const host = 'bank-unreachable.invalid';
  const password = 'Hunter2-not-a-real-password';
  const failing = async () => {
    const error = new Error(`getaddrinfo ENOTFOUND ${host} (postgres://checksops_admin:${password}@${host}:5432/postgres)`);
    error.code = 'ENOTFOUND';
    throw error;
  };
  const { code, text } = await quiet(() => main(['--inspect'], {}, { root: ROOT, connect: failing }));
  assert.equal(code, 1);
  const result = JSON.parse(text);
  assert.deepEqual(Object.keys(result.details).sort(), ['error_code', 'read_only', 'stage']);
  assert.equal(result.details.error_code, 'ENOTFOUND');
  for (const leak of [host, password, 'postgres://', '    at ']) assert.ok(!text.includes(leak), `leaked ${leak}`);
});

test('a transaction that is not read-only is refused before any data statement', async () => {
  const sent = [];
  const connect = async () => ({
    query: async (sql) => {
      sent.push(sql);
      if (sql === Q.session) return { rows: [{ transaction_read_only: 'off', current_user: 'x', session_user: 'x', server_version_num: 160000 }] };
      return { rows: [] };
    },
    end: async () => {},
  });
  const { code, text } = await quiet(() => main(['--inspect'], {}, { root: ROOT, connect }));
  assert.equal(code, 1);
  assert.match(text, /not read-only/);
  assert.ok(!sent.includes(Q.methods) && !sent.includes(Q.verifications));
  assert.equal(sent.at(-1), 'ROLLBACK');
});

test('the report sanitizes labels and minutes and marks statements that were not read', () => {
  const report = buildReport({
    session: [{ transaction_read_only: 'on', current_user: 'checksops_admin', session_user: 'checksops_admin', server_version_num: 160004 }],
    skipped: { stepUps: 'columns_missing:financial_stepup_log.factor_type' },
    tenant: [{ tenant_rows: 1 }],
    methods: [{ seq: 1, provider: 'moov', environment: 'production', is_recipient_bank: false, connection_status: 'Jane Doe',
      verification_status: 'pending', source: 'manual_entry', created_minute: '2026-11-25T20:00:30Z', has_provider_account: true,
      has_provider_bank: true }],
    events: [{ event_type: 'bank_account.micro_deposit.initiated', environment: 'production', new_status: 'pending', created_minute: '2026-11-25T20:01Z' }],
  });
  assert.equal(report.tenant_found, true);
  assert.deepEqual(report.step_ups, { read: false, reason: 'columns_missing:financial_stepup_log.factor_type' });
  assert.equal(report.methods.rows[0].connection_status, 'other');
  assert.equal(report.methods.rows[0].created_minute, 'other');
  assert.equal(report.events.rows[0].event_type, 'bank_account.micro_deposit.initiated');
  assert.equal(report.derived.transfer_to_bank_rows_production, 1);
  assert.equal(report.derived.micro_deposit_initiate_production, 'would_call_moov');
  assert.deepEqual(report.accounts, { read: false, reason: 'not_read' });
});

// --- PostgreSQL 16 -----------------------------------------------------------------------

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const OTHER = ID(1);
const USER = ID(2);
const SECRET_NAME = 'Jane Q Treasurer';
const SECRET_BANK = 'First Secret Bank';
const MOOV_ACCT = 'moov-acct-SECRET-7f3a';
const MOOV_BANK = 'moov-bank-SECRET-91bc';
const SETUP = `
CREATE ROLE checksops_admin LOGIN NOSUPERUSER;
CREATE TABLE public.tenants (id uuid PRIMARY KEY, name text);
CREATE TABLE public.payment_provider_accounts (id uuid PRIMARY KEY, tenant_id uuid, provider text, environment text, provider_account_id text,
  display_name text, onboarding_status text, verification_status text, disabled boolean, restricted boolean, last_webhook_event_type text,
  last_synced_at timestamptz, provider_metadata jsonb, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.payment_provider_methods (id uuid PRIMARY KEY, tenant_id uuid, provider text, environment text, provider_account_id text,
  provider_bank_account_id text, external_recipient_id uuid, bank_name text, last_four text, routing_last_four text, holder_name text,
  connection_status text, verification_status text, is_default boolean, can_send boolean, can_receive boolean, provider_metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), connected_at timestamptz, disconnected_at timestamptz);
CREATE TABLE public.payment_method_verifications (id uuid PRIMARY KEY, tenant_id uuid, payment_method_id uuid, external_recipient_id uuid,
  provider text, environment text, provider_account_id text, provider_bank_account_id text, method text, status text, attempts int,
  max_attempts int, failure_reason text, initiated_by uuid, initiated_at timestamptz, verified_at timestamptz, provider_metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.payment_event_log (id uuid PRIMARY KEY, tenant_id uuid, provider text, environment text, event_type text,
  previous_status text, new_status text, provider_metadata jsonb, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.financial_stepup_log (id uuid PRIMARY KEY, user_id uuid NOT NULL, tenant_id uuid, action_key text NOT NULL,
  factor_type text, succeeded boolean, metadata jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.stakeholder_accounts (id uuid PRIMARY KEY, tenant_id uuid, nickname text, chk_acct text, account_type text,
  is_active boolean, is_primary boolean, verification_status text);
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO checksops_admin;
`;
const T = TARGET_TENANT_ID;
const ROWS = `
INSERT INTO public.tenants VALUES ('${T}', 'Condition One'), ('${OTHER}', 'Other Org');
INSERT INTO public.payment_provider_accounts (id, tenant_id, provider, environment, provider_account_id, display_name, onboarding_status,
  verification_status, disabled, restricted, last_webhook_event_type, last_synced_at, provider_metadata, created_at) VALUES
  ('${ID(10)}', '${T}', 'moov', 'production', '${MOOV_ACCT}', '${SECRET_NAME}', 'active', 'verified', false, false, 'bankAccount.updated',
   '2026-11-25T19:00:10Z', '{"note":"${SECRET_NAME}"}', '2026-11-01T10:00:00Z'),
  ('${ID(11)}', '${OTHER}', 'moov', 'production', 'moov-acct-other', 'x', 'active', 'verified', false, false, NULL, NULL, NULL, now());
INSERT INTO public.payment_provider_methods (id, tenant_id, provider, environment, provider_account_id, provider_bank_account_id,
  external_recipient_id, bank_name, last_four, routing_last_four, holder_name, connection_status, verification_status, is_default,
  can_send, can_receive, provider_metadata, created_at) VALUES
  ('${ID(20)}', '${T}', 'moov', 'production', '${MOOV_ACCT}', 'moov-bank-recipient', '${ID(30)}', '${SECRET_BANK}', '4321', '0021',
   '${SECRET_NAME}', 'connected', 'verified', false, true, true, '{"source":"recipient"}', '2026-11-02T10:00:00Z'),
  ('${ID(21)}', '${T}', 'moov', 'sandbox', 'moov-acct-sandbox', '${MOOV_BANK}', NULL, '${SECRET_BANK}', '9876', '0021',
   '${SECRET_NAME}', 'connected', 'verified', true, true, true, '{"source":"manual_entry","status":"verified"}', '2026-10-01T10:00:00Z'),
  ('${ID(22)}', '${OTHER}', 'moov', 'production', 'moov-acct-other', 'moov-bank-other', NULL, 'x', '1111', '0021', 'x',
   'connected', 'verified', true, true, true, NULL, now());
INSERT INTO public.payment_method_verifications (id, tenant_id, payment_method_id, provider, environment, provider_account_id,
  provider_bank_account_id, method, status, attempts, max_attempts, failure_reason, initiated_by, created_at) VALUES
  ('${ID(40)}', '${T}', '${ID(21)}', 'moov', 'sandbox', 'moov-acct-sandbox', '${MOOV_BANK}', 'micro_deposit', 'verified', 1, 3, NULL,
   '${USER}', '2026-10-01T11:00:00Z'),
  ('${ID(41)}', '${T}', '${ID(99)}', 'moov', 'production', '${MOOV_ACCT}', 'gone', 'micro_deposit', 'max_attempts_exceeded', 3, 3,
   'Moov said 422 for ${SECRET_NAME}', '${USER}', '2026-11-20T11:00:00Z'),
  ('${ID(42)}', '${OTHER}', '${ID(22)}', 'moov', 'production', 'moov-acct-other', 'moov-bank-other', 'micro_deposit', 'pending', 0, 3, NULL,
   '${USER}', now());
INSERT INTO public.payment_event_log (id, tenant_id, provider, environment, event_type, previous_status, new_status, provider_metadata, created_at) VALUES
  ('${ID(50)}', '${T}', 'moov', 'production', 'bank_account.connected', NULL, 'new', '{"last_four":"4321"}', now() - interval '2 days'),
  ('${ID(51)}', '${T}', 'moov', 'production', 'bank_account.connected', NULL, 'new', NULL, now() - interval '40 days'),
  ('${ID(52)}', '${OTHER}', 'moov', 'production', 'transfer.created', NULL, 'pending', NULL, now());
INSERT INTO public.financial_stepup_log (id, user_id, tenant_id, action_key, factor_type, succeeded, metadata, created_at) VALUES
  ('${ID(60)}', '${USER}', '${T}', 'bank_change', 'totp', true, '{"ip":"10.0.0.1"}', now() - interval '1 hour'),
  ('${ID(61)}', '${USER}', '${OTHER}', 'bank_change', 'totp', false, '{}', now());
INSERT INTO public.stakeholder_accounts VALUES
  ('${ID(70)}', '${T}', 'Bank Account (pending verification)', '0000000000', 'operating', true, true, 'unverified'),
  ('${ID(71)}', '${OTHER}', 'x', '1', 'operating', true, true, 'verified');
`;
const SNAPSHOT = `SELECT pg_catalog.md5(pg_catalog.string_agg(x, ',' ORDER BY x)) AS h FROM (
  SELECT t::text AS x FROM public.tenants t UNION ALL SELECT t::text FROM public.payment_provider_accounts t
  UNION ALL SELECT t::text FROM public.payment_provider_methods t UNION ALL SELECT t::text FROM public.payment_method_verifications t
  UNION ALL SELECT t::text FROM public.payment_event_log t UNION ALL SELECT t::text FROM public.financial_stepup_log t
  UNION ALL SELECT t::text FROM public.stakeholder_accounts t) s`;

test('PostgreSQL 16: the inspect is read-only, reads only the target tenant and leaks no id, name or digits', {
  timeout: 180000, skip: pgSkipReason() || false,
}, async (t) => {
  let pg;
  try {
    pg = (await import('pg')).default;
  } catch {
    t.skip('pg module is not installed');
    return;
  }
  const server = startPg('pg-settlement-bank-state-', 60320);
  const open = async (user) => {
    const c = new pg.Client({ host: server.host, port: server.port, user, database: 'postgres' });
    await c.connect();
    return c;
  };
  const su = await open('ubuntu');
  try {
    await su.query(SETUP);
    await su.query(ROWS);
    const statements = [];
    const connect = async () => {
      const c = await open('checksops_admin');
      const query = c.query.bind(c);
      c.query = async (sql, params) => {
        statements.push(typeof sql === 'string' ? sql : sql.text);
        const result = await query(sql, params);
        for (const field of result.fields || []) assert.ok(RETURNED.has(field.name), `${field.name} returned by ${sql}`);
        return result;
      };
      return c;
    };
    const before = (await su.query(SNAPSHOT)).rows[0];
    const { code, text } = await quiet(() => main(['--inspect'], {}, { root: ROOT, connect }));
    assert.equal(code, 0, text);
    assert.deepEqual((await su.query(SNAPSHOT)).rows[0], before, 'nothing changed');
    for (const sql of statements) assert.ok(INSPECT_STATEMENTS.includes(sql), sql);
    assert.equal(statements.length, INSPECT_STATEMENTS.length, 'every statement ran once');
    assert.equal(statements[0], 'BEGIN READ ONLY');
    assert.equal(statements.at(-1), 'ROLLBACK');
    for (const leak of [SECRET_NAME, 'Jane', SECRET_BANK, 'Condition One', MOOV_ACCT, MOOV_BANK, 'moov-acct', 'moov-bank', '4321', '9876',
      '0021', '0000000000', '10.0.0.1', '422', 'pending verification', 'transfer.created']) {
      assert.ok(!text.includes(leak), `leaked ${leak}`);
    }
    assert.doesNotMatch(text, UUID_RE);
    const report = JSON.parse(text).details;

    assert.equal(report.transaction_read_only, true);
    assert.equal(report.current_user, 'checksops_admin');
    assert.equal(report.tenant_found, true);
    assert.equal(Object.values(report.row_security).every((v) => v === false), true);
    // Only a recipient bank in production and an own bank in sandbox: the Condition One shape.
    assert.deepEqual(report.derived, {
      read: true, transfer_to_bank_rows_production: 0, transfer_to_bank_rows_sandbox: 1, micro_deposit_initiate_production: 'bank_account_not_found',
    });
    assert.deepEqual(report.accounts.rows, [{
      provider: 'moov', environment: 'production', onboarding_status: 'active', verification_status: 'verified', has_provider_account: true,
      disabled: false, restricted: false, last_webhook_event_type: 'other', created_minute: '2026-11-01T10:00Z', synced_minute: '2026-11-25T19:00Z',
    }]);
    assert.deepEqual(report.methods.rows.map((m) => [m.seq, m.environment, m.is_recipient_bank, m.account_matches, m.source]), [
      [1, 'sandbox', false, false, 'manual_entry'], [2, 'production', true, true, 'recipient'],
    ]);
    assert.deepEqual(report.verifications.rows.map((v) => [v.environment, v.status, v.attempts, v.payment_method_found, v.method_seq, v.bank_matches, v.failure_reason]), [
      ['sandbox', 'verified', 1, true, 1, true, '(none)'], ['production', 'max_attempts_exceeded', 3, false, null, null, 'other'],
    ]);
    assert.deepEqual(report.events.rows.map((e) => e.event_type), ['bank_account.connected'], 'only the last 30 days, only this tenant');
    assert.deepEqual(report.step_ups.rows.map((s) => [s.action_key, s.succeeded]), [['bank_change', true]]);
    assert.deepEqual(report.stakeholder_accounts.rows, [
      { account_type: 'operating', is_active: true, is_primary: true, verification_status: 'unverified', accounts: 1 },
    ]);
  } finally {
    await su.end().catch(() => {});
    server.stop();
  }
});
