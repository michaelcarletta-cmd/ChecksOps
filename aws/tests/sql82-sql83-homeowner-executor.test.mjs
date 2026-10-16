/**
 * Staging VPC executor support for SQL 82 (CREATE OR REPLACE of
 * public.aws_public_homeowner_ledger_by_token(text)) and SQL 83 (CREATE OR REPLACE
 * of the three homeowner signing doorways), each REVOKE ALL FROM PUBLIC and
 * authenticated and GRANT EXECUTE TO checksops.
 *
 * Neither pre-state is code-derived: each pin's expected hash is recorded from a
 * guarded staging read-live run (2026-10-16, run 48 for SQL 82 and run 49 for SQL 83;
 * staging carries Cursor's SQL 73 ledger view and SQL 74 doorways). Tests that need
 * the no-pre-state behaviour pass an explicit copy with the hash null (UNRECORDED).
 * The intended hash is code-derived; the PostgreSQL 16 tests re-derive it and the
 * definition hashes from the real catalog, starting from the real Cursor SQL 73 / 74
 * files (fixtures), and apply through the handler with a pin copy carrying the
 * inspected pre-state.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import {
  AUTHORIZED_SQL82_HOMEOWNER_LEDGER_VIEW as PIN82,
  AUTHORIZED_SQL83_HOMEOWNER_SIGNING_CAPABILITIES as PIN83,
  AUTHORIZED_STAGING_SQL,
  HOMEOWNER_DEFINITION_SHA256,
  HOMEOWNER_MIGRATIONS,
  HOMEOWNER_RAW_ENDORSE_LINK_RE,
  authorizationFingerprint,
  evaluateSqlExecutorAuthorization,
  homeownerAppliedStates,
  homeownerStateText,
  resolveAuthorizedMigration,
} from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import { EXECUTOR_PACK_MEMBERS } from '../../scripts/deployment-guard/sql-executor-ensure.mjs';
import { MIGRATIONS } from '../../scripts/deployment-guard/github-staging-sql-executor.mjs';
import { READ_LIVE_EXPECTED_SENTINEL, readLiveSummary } from '../../scripts/deployment-guard/lib/sql-executor-read-live.mjs';
import { importGuardedSqlExecutor } from './helpers/import-guarded-sql-executor.mjs';
import {
  CURSOR_SQL73_SHA256,
  CURSOR_SQL74_SHA256,
  LEGACY_REMINT_SQL,
  assertNoSeededPii,
  cursorSql73,
  cursorSql74,
  homeownerSchemaSql,
} from './helpers/homeowner-sql-pg.mjs';
import { pgSkipReason, startPg } from './helpers/stakeholder-policies-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-10-16T12:00:00.000Z';
const sha = (text) => createHash('sha256').update(text).digest('hex');
const clone = (value) => JSON.parse(JSON.stringify(value));

const { module: executorModule } = await importGuardedSqlExecutor();
const {
  createHandler,
  parseHomeownerSql,
  homeownerReviewedFunctiondefs,
  homeownerSqlIsReviewed,
  HOMEOWNER_NORMALIZED_STATEMENTS,
} = executorModule;

const PINS = { sql82: PIN82, sql83: PIN83 };
// The pre-states recorded from the staging read-live runs (run 48 / job 116757174929,
// run 49 / job 116757504435, 2026-10-16).
const RECORDED_STAGING_PRE = {
  sql82: '452f8f3d2411e0c3772fdf92c14e1b85785823dcb8d6567d01f1908dc9a8d783',
  sql83: 'e85f64fa17ff2146d1aa3a603c83580c8c369dd2b49d252dfc8fd45453f4a21f',
};
// The committed pins with no recorded pre-state, for the no-pre-state refusals.
const UNRECORDED = Object.fromEntries(Object.entries(PINS).map(([key, pin]) => [key, { ...pin, expected_live_definition_sha256: null }]));
const CHOICES = { sql82: 'sql82-homeowner-ledger-view', sql83: 'sql83-homeowner-signing-capabilities' };
const FILES = { sql82: path.join(ROOT, PIN82.filename), sql83: path.join(ROOT, PIN83.filename) };
const TEXT = { sql82: fs.readFileSync(FILES.sql82, 'utf8'), sql83: fs.readFileSync(FILES.sql83, 'utf8') };
const DEFS = { sql82: homeownerReviewedFunctiondefs('sql82', TEXT.sql82), sql83: homeownerReviewedFunctiondefs('sql83', TEXT.sql83) };
const pinKey = { sql82: 'sql82Pin', sql83: 'sql83Pin' };
const fileKey = { sql82: 'sqlFile82', sql83: 'sqlFile83' };

function homeownerEvent(key, overrides = {}) {
  const pin = overrides.pin || PINS[key];
  const oneUse = overrides.one_use_id || `${key}-test-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const rest = { ...overrides };
  delete rest.pin;
  const event = {
    action: 'apply',
    workstream_id: `staging-${CHOICES[key]}`,
    branch: 'main',
    commit: pin.commit,
    operator: 'test-agent',
    target_environment: 'staging',
    target_component: 'staging-sql',
    deployment_type: 'sql-executor-invoke',
    owned_components: [pin.filename],
    filename: pin.filename,
    migration_id: pin.migration_id,
    source_sha256: pin.source_sha256,
    intended_replacement_sha256: pin.intended_replacement_sha256,
    expected_live_definition_sha256: pin.expected_live_definition_sha256 || READ_LIVE_EXPECTED_SENTINEL,
    one_use_id: oneUse,
    expiry: '2026-10-16T13:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    ...rest,
  };
  event.one_use_id = oneUse;
  event.preflight_live_fingerprint = authorizationFingerprint(event);
  return event;
}
const inspectEvent = (key, overrides = {}) => homeownerEvent(key, { action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL, ...overrides });

function handlerFor(connect, extra = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(
    os.tmpdir(),
    `sql8283-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), sqlFile82: FILES.sql82, sqlFile83: FILES.sql83, ...extra });
}

const neverConnect = async () => {
  throw new Error('should-not-connect');
};
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK TO)\b/i;

test('pins match the SQL files and their commit; pre-states recorded from read-live, post-states code-derived; registered everywhere', () => {
  assert.equal(sha(fs.readFileSync(FILES.sql82)), PIN82.source_sha256);
  assert.equal(PIN82.source_sha256, '1db68ee9aee1c91c146e7f70c39bef7cc015eb38f6f436bfdfd0bc49f360a934');
  assert.equal(sha(fs.readFileSync(FILES.sql83)), PIN83.source_sha256);
  assert.equal(PIN83.source_sha256, '8443a3e7b2c1f7a61d621e2e5b7fb3dcd94beb769fb16c2d2b49f867aa5149af');
  assert.equal(PIN82.migration_id, '82_homeowner_ledger_view');
  assert.equal(PIN83.migration_id, '83_homeowner_signing_capabilities');
  for (const [key, pin] of Object.entries(PINS)) {
    // Recorded from the staging read-live run (not code-derived), and not the post-state.
    assert.equal(pin.expected_live_definition_sha256, RECORDED_STAGING_PRE[key], key);
    assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256, key);
    assert.equal(pin.intended_replacement_sha256, sha(homeownerStateText(key, homeownerAppliedStates(key))), key);
    assert.deepEqual([...pin.function_identities], HOMEOWNER_MIGRATIONS[key].functions.map((fn) => fn.identity));
    assert.equal(pin.migration, key);
    assert.ok(AUTHORIZED_STAGING_SQL.includes(pin), key);
    assert.equal(MIGRATIONS[CHOICES[key]], pin, key);
    assert.equal(resolveAuthorizedMigration({ filename: pin.filename, migration_id: pin.migration_id }), pin, key);
    assert.ok(EXECUTOR_PACK_MEMBERS.some(([from, to]) => from === pin.filename && to === `sql/${path.basename(pin.filename)}`), key);
    assert.equal(parseHomeownerSql(TEXT[key]).outside, HOMEOWNER_NORMALIZED_STATEMENTS[key], key);
    assert.equal(homeownerSqlIsReviewed(key, TEXT[key]), true, key);
    for (const fn of HOMEOWNER_MIGRATIONS[key].functions) {
      assert.equal(sha(DEFS[key][fn.identity]), HOMEOWNER_DEFINITION_SHA256[fn.identity], fn.identity);
    }
    const atCommit = spawnSync('git', ['show', `${pin.commit}:${pin.filename}`], { cwd: ROOT, maxBuffer: 4 * 1024 * 1024 });
    if (atCommit.status === 0) assert.equal(sha(atCommit.stdout), pin.source_sha256, key);
  }
  assert.equal(PIN82.intended_replacement_sha256, '04e41eedb372334169feb32bc65991a3ce99558b84e91b27e22a6501be641e37');
  assert.equal(PIN83.intended_replacement_sha256, '78da421900f4e3d0af7110ee2b1a47f1498599a59a6dfa07953c59ad56b27163');
  assert.deepEqual(HOMEOWNER_DEFINITION_SHA256, {
    'public.aws_public_homeowner_ledger_by_token(text)': '962de3a55ffccf39baf5ac5274e50df4f137dcef0b4b9f7bdd78bf72fe355ec3',
    'public.aws_public_homeowner_ledger_endorse_capability(text, uuid)': '066754e61334f2f988a9e5ac28fd06f840bc28cb3890a5d961c1a20d50cccbe7',
    'public.aws_public_homeowner_pending_signatures(text)': '3b632929f4b72e168ef4b42951d6845d5dbb751fa8ced92860697dda782fc5cb',
    'public.aws_public_homeowner_document_sign_capability(text, uuid)': 'a45f3bfcab4f6a8a686a2e1374b50dda5fcf28731ec18bbf935ef4839c221786',
  });
  // SQL 82's body has no raw /endorse link; Cursor SQL 73's does.
  assert.equal(HOMEOWNER_RAW_ENDORSE_LINK_RE.test(DEFS.sql82['public.aws_public_homeowner_ledger_by_token(text)']), false);
  assert.equal(HOMEOWNER_RAW_ENDORSE_LINK_RE.test(cursorSql73()), true);
  assert.equal(sha(cursorSql73()), CURSOR_SQL73_SHA256);
  assert.equal(sha(cursorSql74()), CURSOR_SQL74_SHA256);
  // Authorization packages (read-live sentinel, and an apply with a recorded pre-state) evaluate.
  assert.equal(evaluateSqlExecutorAuthorization(inspectEvent('sql82'), { now: Date.parse(NOW) }).ok, true);
  const recorded = { ...PIN83, expected_live_definition_sha256: 'a'.repeat(64) };
  assert.equal(evaluateSqlExecutorAuthorization(homeownerEvent('sql83', { pin: recorded }), { now: Date.parse(NOW) }).ok, true);
  for (const key of Object.keys(PINS)) {
    assert.equal(evaluateSqlExecutorAuthorization(homeownerEvent(key), { now: Date.parse(NOW) }).ok, true, `${key} committed pin`);
    assert.equal(homeownerEvent(key).expected_live_definition_sha256, RECORDED_STAGING_PRE[key], key);
  }
});

test('the workflow offers both pins and runs this test', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  const migrationInput = workflow.slice(workflow.indexOf('      migration:'), workflow.indexOf('      approved_commit:'));
  const options = [...migrationInput.matchAll(/^\s+- ([a-z0-9-]+)$/gm)].map((match) => match[1]);
  assert.deepEqual(options, Object.keys(MIGRATIONS));
  assert.ok(options.includes('sql82-homeowner-ledger-view'));
  assert.ok(options.includes('sql83-homeowner-signing-capabilities'));
  assert.match(workflow, /node --test aws\/tests\/sql82-sql83-homeowner-executor\.test\.mjs/);
});

test('the reviewed-text check refuses SECURITY INVOKER, another search_path or row_security, wider grants, missing revokes, extra statements, a changed body', () => {
  const cases = {
    sql82: [
      ['security invoker', /^SECURITY DEFINER$/m, 'SECURITY INVOKER'],
      ['search_path', /^SET search_path = public$/m, 'SET search_path = public, pg_temp'],
      ['grant authenticated', 'TO checksops;', 'TO checksops, authenticated;'],
      ['no revoke authenticated', 'REVOKE ALL ON FUNCTION public.aws_public_homeowner_ledger_by_token(text) FROM authenticated;\n', ''],
      ['extra statement', 'GRANT EXECUTE ON FUNCTION', 'DROP FUNCTION public.aws_public_homeowner_ledger_remint_signer(text, uuid);\nGRANT EXECUTE ON FUNCTION'],
      ['raw link back', "'sign_url', NULL::text", "'sign_url', '/endorse?token=' || e.token"],
    ],
    sql83: [
      ['security invoker', /^SECURITY DEFINER$/m, 'SECURITY INVOKER'],
      ['row_security on', 'SET row_security = off', 'SET row_security = on'],
      ['grant public', 'public.aws_public_homeowner_pending_signatures(text) TO checksops;', 'public.aws_public_homeowner_pending_signatures(text) TO checksops, PUBLIC;'],
      ['no revoke public', 'REVOKE ALL ON FUNCTION public.aws_public_homeowner_document_sign_capability(text, uuid) FROM PUBLIC;\n', ''],
      ['extra statement', 'REVOKE ALL ON FUNCTION public.aws_public_homeowner_ledger_endorse_capability(text, uuid) FROM PUBLIC;', 'ALTER TABLE public.signature_signers DISABLE ROW LEVEL SECURITY;\nREVOKE ALL ON FUNCTION public.aws_public_homeowner_ledger_endorse_capability(text, uuid) FROM PUBLIC;'],
      ['changed body', "IN ('pending', 'in_progress')", "IN ('pending', 'in_progress', 'completed')"],
    ],
  };
  for (const [key, list] of Object.entries(cases)) {
    for (const [label, from, to] of list) {
      const text = TEXT[key].replace(from, to);
      assert.notEqual(text, TEXT[key], `${key} ${label}`);
      assert.equal(homeownerSqlIsReviewed(key, text), false, `${key} ${label}`);
    }
    assert.equal(parseHomeownerSql(`${TEXT[key]}\nDO $$ BEGIN END $$;\n`)?.outside === HOMEOWNER_NORMALIZED_STATEMENTS[key], false);
    assert.equal(homeownerSqlIsReviewed(key, `${TEXT[key]}\nDO $$ BEGIN END $$;\n`), false);
  }
  // The other migration's file is not this one.
  assert.equal(homeownerSqlIsReviewed('sql82', TEXT.sql83), false);
  assert.equal(homeownerSqlIsReviewed('sql83', TEXT.sql82), false);
  // Cursor's own files are not the reviewed ones.
  assert.equal(homeownerSqlIsReviewed('sql82', cursorSql73()), false);
  assert.equal(homeownerSqlIsReviewed('sql83', cursorSql74()), false);
});

test('apply refuses before connecting: a pin with no pre-state, the read-live sentinel, a wrong hash, a forged pin, a tampered file', async () => {
  for (const key of ['sql82', 'sql83']) {
    const pin = PINS[key];
    // A pin with no recorded pre-state (explicit copy; the committed pins are recorded).
    const pending = await handlerFor(neverConnect, { [pinKey[key]]: UNRECORDED[key] })(homeownerEvent(key, { pin: UNRECORDED[key], expected_live_definition_sha256: 'b'.repeat(64) }));
    assert.equal(pending.code, CODES.SQL_COLLISION, key);
    assert.match(pending.message, /no reviewed pre-apply live definition hash/, key);
    // The committed (recorded) pin: any other hash, or the read-live sentinel, is refused.
    for (const expected of ['b'.repeat(64), READ_LIVE_EXPECTED_SENTINEL]) {
      const committed = await handlerFor(neverConnect)(homeownerEvent(key, { expected_live_definition_sha256: expected }));
      assert.equal(committed.code, CODES.SQL_COLLISION, key);
      assert.match(committed.message, /bound to the exact allowlisted pin/, key);
    }
    const recorded = { ...pin, expected_live_definition_sha256: 'a'.repeat(64) };
    const extra = { [pinKey[key]]: recorded };
    const sentinel = await handlerFor(neverConnect, extra)(homeownerEvent(key, { pin: recorded, expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL }));
    assert.equal(sentinel.code, CODES.SQL_COLLISION, key);
    assert.match(sentinel.message, /bound to the exact allowlisted pin/, key);
    const other = await handlerFor(neverConnect, extra)(homeownerEvent(key, { pin: recorded, expected_live_definition_sha256: 'b'.repeat(64) }));
    assert.equal(other.code, CODES.SQL_COLLISION, key);
    const wrongIntended = await handlerFor(neverConnect, extra)(homeownerEvent(key, { pin: recorded, intended_replacement_sha256: 'c'.repeat(64) }));
    assert.equal(wrongIntended.ok, false, key);
    for (const forged of [
      { ...recorded, intended_replacement_sha256: 'c'.repeat(64) },
      { ...recorded, function_identities: [...recorded.function_identities, 'public.aws_public_homeowner_ledger_remint_signer(text, uuid)'] },
      { ...recorded, commit: 'f'.repeat(40) },
    ]) {
      const result = await handlerFor(neverConnect, { [pinKey[key]]: forged })(homeownerEvent(key, { pin: recorded }));
      assert.equal(result.code, CODES.SQL_COLLISION, key);
      assert.match(result.message, /committed allowlist entry/, key);
    }
    const unsupported = await handlerFor(neverConnect, extra)(homeownerEvent(key, { pin: recorded, action: 'drop' }));
    assert.equal(unsupported.ok, false, key);
    const tampered = path.join(os.tmpdir(), `sql8283-tampered-${process.pid}-${key}.sql`);
    fs.writeFileSync(tampered, `${TEXT[key]}GRANT EXECUTE ON FUNCTION ${pin.function_identities[0]} TO authenticated;\n`);
    try {
      const result = await handlerFor(neverConnect, { ...extra, [fileKey[key]]: tampered })(homeownerEvent(key, { pin: recorded }));
      assert.equal(result.code, CODES.SQL_COLLISION, key);
    } finally {
      fs.rmSync(tampered, { force: true });
    }
  }
});

// --- fake catalog ------------------------------------------------------------------

const TABLE_COLUMNS = {
  homeowner_ledger_tokens: ['id', 'tenant_id', 'claim_id', 'token', 'homeowner_email', 'homeowner_name', 'revoked_at', 'expires_at', 'last_viewed_at', 'created_at'],
  claims: ['id', 'org_id', 'claim_number', 'policyholder_address', 'loss_type', 'status', 'created_at'],
  check_intake_items: ['id', 'tenant_id', 'claim_id', 'amount', 'check_stage', 'check_number'],
  homeowner_ledger_events: ['id', 'tenant_id', 'claim_id', 'check_id', 'event_type', 'occurred_at', 'amount', 'actor_label', 'payload_json'],
  homeowner_ledger_check_uploads: ['id', 'token_id', 'tenant_id', 'created_at'],
  check_endorsements: ['id', 'check_id', 'tenant_id', 'payee_name', 'payee_type', 'status', 'token', 'contact_email', 'signed_at', 'request_sent_at', 'created_at'],
  disbursement_batches: ['id', 'tenant_id', 'check_intake_item_id'],
  disbursement_splits: ['id', 'batch_id', 'tenant_id', 'amount', 'status'],
  claim_disbursements: ['id', 'claim_id', 'check_id', 'amount', 'status'],
  signature_requests: ['id', 'claim_id', 'check_intake_item_id', 'document_name', 'status', 'sent_at', 'completed_at', 'created_at'],
  signature_signers: ['id', 'signature_request_id', 'signer_name', 'signer_email', 'signer_type', 'signing_order', 'status', 'signed_at', 'access_token', 'expires_at', 'created_at'],
};
const appliedFn = (key, fn) => ({
  present: true,
  def: DEFS[key][fn.identity],
  arguments: fn.arguments,
  identity_arguments: fn.identity.replace(/^[^(]+\(|\)$/g, ''),
  result: 'jsonb',
  prokind: 'f',
  retset: false,
  language: 'plpgsql',
  arg_names: [...fn.arg_names],
  security_definer: true,
  config: [...fn.config],
  proacl: '{fakeowner=X/fakeowner,checksops=X/fakeowner}',
  owner: 'fakeowner',
  owner_is_executor: true,
  owner_rolsuper: false,
  owner_rolbypassrls: false,
});
const cursorFn = (key, fn) => ({ ...appliedFn(key, fn), def: DEFS[key][fn.identity].replace('BEGIN', "BEGIN\n  -- cursor '/endorse?token=' || e.token\n") });

/** Fake catalog with Cursor-like functions; running the embedded file installs the reviewed ones. */
function fakeDb(key, { mutate, onApply, failOnApply = false } = {}) {
  const spec = HOMEOWNER_MIGRATIONS[key];
  let committed = {
    fns: Object.fromEntries(spec.functions.map((fn) => [fn.identity, cursorFn(key, fn)])),
    acl: Object.fromEntries(spec.functions.map((fn) => [fn.identity, [
      { grantee: 'authenticated', privilege_type: 'EXECUTE', is_grantable: false },
      { grantee: 'checksops', privilege_type: 'EXECUTE', is_grantable: false },
    ]])),
    extraNamed: [],
    roles: ['authenticated', 'checksops'],
    tables: Object.keys(TABLE_COLUMNS).map((relname) => ({ relname, rls_enabled: true, rls_forced: false, owner: 'fakeowner' })),
    columns: clone(TABLE_COLUMNS),
    relations: [{ relname: 'claims', relkind: 'r', relacl: null }],
    policies: [{ table_name: 'public.claims', polname: 'p', polcmd: 'r', polpermissive: true, polroles: '{0}', polqual: 'true', polwithcheck: null }],
    otherFunctions: [{ signature: 'public.other()', def_sha256: 'a'.repeat(64), acl: null, prosecdef: false, config: null, owner: 'fakeowner' }],
  };
  if (mutate) mutate(committed);
  let working = null;
  const current = () => working || committed;
  const seen = [];
  return {
    seen,
    get committed() { return committed; },
    connect: async () => ({
      end: async () => {},
      query: async (sql, params = []) => {
        const text = String(sql);
        seen.push(text);
        const db = current();
        if (text === 'BEGIN' || text === 'BEGIN READ ONLY') { working = clone(committed); return { rows: [] }; }
        if (text === 'COMMIT') { committed = working; working = null; return { rows: [] }; }
        if (text === 'ROLLBACK') { working = null; return { rows: [] }; }
        if (/^(SAVEPOINT|RELEASE|ROLLBACK TO)\b/.test(text) || text.startsWith('SET LOCAL lock_timeout')) return { rows: [] };
        if (text.includes('pg_advisory_xact_lock') || text.includes('set_config(')) return { rows: [{}] };
        if (text.includes('AS session_user')) return { rows: [{ current_user: 'fakeowner', session_user: 'fakeowner', rolsuper: false, rolbypassrls: false }] };
        if (text.includes('SELECT rolname::text AS rolname')) return { rows: db.roles.map((rolname) => ({ rolname })) };
        if (text.includes('AS rls_forced')) return { rows: clone(db.tables.filter((row) => params[0].includes(row.relname))) };
        if (text.includes('a.attname::text AS attname')) {
          return { rows: params[0].flatMap((relname) => (db.columns[relname] || []).map((attname) => ({ relname, attname }))) };
        }
        if (text.includes('p.proname = ANY($1::text[])')) {
          const named = [
            ...Object.entries(db.fns).filter(([, fn]) => fn.present).map(([identity]) => ({ name: identity.replace(/^public\.|\(.*$/g, ''), signature: identity.replace(/, /g, ','), result: 'jsonb' })),
            ...db.extraNamed,
          ];
          return { rows: named.filter((row) => params[0].includes(row.name)) };
        }
        if (text.includes('AS owner_rolbypassrls')) {
          const fn = db.fns[params[0]];
          const count = Object.entries(db.fns).filter(([identity, row]) => row.present && identity.includes(`.${params[1]}(`)).length
            + db.extraNamed.filter((row) => row.name === params[1]).length;
          return { rows: [fn?.present ? { ...clone(fn), overload_count: count } : { present: false, overload_count: count }] };
        }
        if (text.includes("acldefault('f'")) return { rows: clone(db.acl[params[0]] || []) };
        if (text.includes("con.contype = 'c'")) return { rows: [{ relname: 'check_endorsements', conname: 'check_endorsements_status_check', def: "CHECK ((status = ANY (ARRAY['pending'::text, 'sent'::text])))" }] };
        if (text.includes('FROM public.check_endorsements GROUP BY')) return { rows: [{ payee_type: 'insured', status: 'sent', n: 2 }, { payee_type: 'mortgage_company', status: 'pending', n: 1 }] };
        if (text.includes('FROM public.signature_signers GROUP BY')) throw new Error('query would be affected by row-level security policy for table "signature_signers"');
        if (text.includes('FROM public.signature_requests GROUP BY')) return { rows: [{ status: 'Pending <script>', n: 1 }] };
        if (text.includes('AS relacl')) return { rows: clone(db.relations) };
        if (text.includes('FROM pg_policy pol')) return { rows: clone(db.policies) };
        if (text.includes("nspname IN ('public', 'auth')")) return { rows: clone(db.otherFunctions) };
        if (text.includes('CREATE OR REPLACE FUNCTION public.aws_public_homeowner')) {
          if (failOnApply) throw new Error('cannot change return type of existing function');
          for (const fn of spec.functions) {
            db.fns[fn.identity] = appliedFn(key, fn);
            db.acl[fn.identity] = [{ grantee: 'checksops', privilege_type: 'EXECUTE', is_grantable: false }];
          }
          if (onApply) onApply(db);
          return { rows: [] };
        }
        throw new Error(`unexpected SQL ${text.slice(0, 80)}`);
      },
    }),
  };
}

test('inspect only reads and reports each function, the clashes, RLS, columns, constraints and counts; read-live shows it without names or row data', async () => {
  for (const key of ['sql82', 'sql83']) {
    const db = fakeDb(key, { mutate: (d) => { d.extraNamed.push({ name: 'aws_public_homeowner_ledger_remint_signer', signature: 'public.aws_public_homeowner_ledger_remint_signer(text,uuid)', result: 'jsonb' }); } });
    // A pin with no recorded pre-state: pin_executable false.
    const inspect = await handlerFor(db.connect, { [pinKey[key]]: UNRECORDED[key] })(inspectEvent(key, { pin: UNRECORDED[key] }));
    assert.equal(inspect.ok, true, JSON.stringify(inspect));
    const receipt = inspect.details.receipt;
    assert.equal(receipt.before_hash, receipt.after_hash);
    assert.equal(receipt.result, 'inspect');
    assert.equal(receipt.pin_executable, false);
    assert.equal(receipt.apply_preconditions_met, false);
    assert.deepEqual(receipt.precondition_failures, [], key);
    assert.equal(receipt.prerequisites_ok, true);
    assert.equal(receipt.already_applied, false);
    assert.deepEqual(Object.values(receipt.function_states), HOMEOWNER_MIGRATIONS[key].functions.map(() => 'other'));
    const report = receipt.homeowner_inspect;
    for (const fn of HOMEOWNER_MIGRATIONS[key].functions) {
      const row = report.functions[fn.name];
      assert.equal(row.exists, true);
      assert.equal(row.matches_migration, false);
      assert.equal(row.body_matches_migration, false);
      assert.equal(row.raw_endorse_token_link, true);
      assert.deepEqual(row.acl_entries, ['authenticated EXECUTE', 'checksops EXECUTE']);
      assert.equal(row.owner_is_executor, true);
      assert.equal(row.result, 'jsonb');
      assert.deepEqual(row.argument_names, fn.arg_names);
      assert.equal(row.definition_sha256.length, 64);
    }
    assert.equal(report.legacy_remint_signer.present, true);
    assert.deepEqual(report.status_counts.check_endorsements.groups, [{ payee_type: 'insured', status: 'sent', count: 2 }, { payee_type: 'mortgage_company', status: 'pending', count: 1 }]);
    assert.deepEqual(report.status_counts.signature_signers, { readable: false, reason: 'row_security_would_filter' });
    assert.deepEqual(report.status_counts.signature_requests.groups, [{ status: 'unrecognized', count: 1 }]);
    assert.deepEqual(report.status_constraints.check_endorsements[0].allowed, ['pending', 'sent']);
    assert.equal(report.tables.claims.rls_enabled, true);
    assert.equal(report.row_security_off_supported, true);
    assert.equal(JSON.stringify(report).includes('fakeowner'), false, 'no owner names in the staging report');
    // Read-only: BEGIN READ ONLY, then only SELECT/WITH/savepoints, then ROLLBACK.
    assert.equal(db.seen[0], 'BEGIN READ ONLY');
    assert.equal(db.seen.at(-1), 'ROLLBACK');
    assert.ok(db.seen.slice(1, -1).every((text) => READ_ONLY_STATEMENT_RE.test(text)), JSON.stringify(db.seen.filter((text) => !READ_ONLY_STATEMENT_RE.test(text))));
    assert.ok(!db.seen.some((text) => text.includes('CREATE OR REPLACE')));

    const summary = readLiveSummary({ ok: true, details: inspect }, { migration: CHOICES[key], pin: UNRECORDED[key] });
    assert.equal(summary.ok, true, JSON.stringify(summary));
    assert.equal(summary.details.pin_executable, false);
    assert.equal(summary.details.matches_pinned_expected, false);
    assert.equal(summary.details.pinned_expected_live_definition_sha256, null);
    assert.equal(summary.details.live_definition_sha256, receipt.live_definition_sha256);
    assert.deepEqual(summary.details.precondition_failures, []);
    assert.equal(summary.details.homeowner_inspect.functions[HOMEOWNER_MIGRATIONS[key].functions[0].name].raw_endorse_token_link, true);
    assert.deepEqual(summary.details.function_states, receipt.function_states);
    assertNoSeededPii(assert, summary.details, `${key} read-live summary`);
    assertNoSeededPii(assert, inspect, `${key} executor result`);
    // The committed pin is executable, but this fake live state is not the recorded staging pre-state.
    const committedInspect = (await handlerFor(fakeDb(key).connect)(inspectEvent(key))).details.receipt;
    assert.equal(committedInspect.pin_executable, true, key);
    assert.notEqual(committedInspect.live_definition_sha256, PINS[key].expected_live_definition_sha256, key);
    assert.equal(committedInspect.apply_preconditions_met, false, key);
  }
});

test('inspect fails the replace-safely rules: another signature, a return type or parameter-name clash, another owner, an extra grantee, missing columns, RLS not bypassed', async () => {
  const name = (key, i = 0) => HOMEOWNER_MIGRATIONS[key].functions[i].name;
  const id = (key, i = 0) => HOMEOWNER_MIGRATIONS[key].functions[i].identity;
  for (const [key, label, mutate, expected] of [
    ['sql83', 'another signature (Cursor SQL 74 variant)', (d) => { d.extraNamed.push({ name: name('sql83', 2), signature: 'public.aws_public_homeowner_document_sign_capability(text,uuid,text)', result: 'jsonb' }); }, [`no_other_signature:${name('sql83', 2)}`]],
    ['sql82', 'return type clash', (d) => { d.fns[id('sql82')].result = 'json'; }, [`return_type_jsonb:${name('sql82')}`]],
    ['sql83', 'parameter name clash', (d) => { d.fns[id('sql83', 0)].arg_names = ['token', 'endorsement_id']; }, [`argument_names_match:${name('sql83', 0)}`]],
    ['sql82', 'a parameter DEFAULT', (d) => { d.fns[id('sql82')].arguments = 'p_token text DEFAULT NULL::text'; }, [`arguments_match:${name('sql82')}`]],
    ['sql83', 'a set-returning function', (d) => { d.fns[id('sql83', 1)].retset = true; }, [`replaceable_kind:${name('sql83', 1)}`]],
    ['sql82', 'another owner', (d) => { d.fns[id('sql82')].owner_is_executor = false; d.fns[id('sql82')].owner = 'someone'; }, [`owner_is_login:${name('sql82')}`]],
    ['sql82', 'an anon grant the file does not revoke', (d) => { d.acl[id('sql82')].push({ grantee: 'anon', privilege_type: 'EXECUTE', is_grantable: false }); }, [`acl_replaceable:${name('sql82')}`]],
    ['sql82', 'a grant option', (d) => { d.acl[id('sql82')][1].is_grantable = true; }, [`acl_replaceable:${name('sql82')}`]],
    ['sql82', 'a missing column', (d) => { d.columns.homeowner_ledger_tokens = d.columns.homeowner_ledger_tokens.filter((c) => c !== 'last_viewed_at'); }, ['required_columns_present']],
    ['sql83', 'a missing table', (d) => { d.tables = d.tables.filter((row) => row.relname !== 'signature_signers'); }, ['required_tables_present']],
    ['sql83', 'the checksops role missing', (d) => { d.roles = ['authenticated']; }, ['required_roles_present']],
    ['sql83', 'FORCE RLS on a table the definers read', (d) => { d.tables.find((row) => row.relname === 'signature_signers').rls_forced = true; },
      HOMEOWNER_MIGRATIONS.sql83.functions.map((fn) => `row_security_off_supported:${fn.name}`)],
    ['sql83', 'a table owned by another role', (d) => { d.tables.find((row) => row.relname === 'claims').owner = 'other'; },
      HOMEOWNER_MIGRATIONS.sql83.functions.map((fn) => `row_security_off_supported:${fn.name}`)],
  ]) {
    const db = fakeDb(key, { mutate });
    const inspect = await handlerFor(db.connect)(inspectEvent(key));
    assert.equal(inspect.ok, true, `${label}: ${JSON.stringify(inspect)}`);
    const failures = inspect.details.receipt.precondition_failures;
    for (const failure of expected) assert.ok(failures.includes(failure), `${label}: ${JSON.stringify(failures)}`);
    assert.equal(inspect.details.receipt.prerequisites_ok, false, label);
    // Apply with a pin that records exactly this live state still refuses, before running the file.
    const recorded = { ...PINS[key], expected_live_definition_sha256: inspect.details.receipt.live_definition_sha256 };
    const refused = await handlerFor(db.connect, { [pinKey[key]]: recorded })(homeownerEvent(key, { pin: recorded }));
    assert.equal(refused.code, CODES.DEPLOYMENT_COLLISION, `${label}: ${JSON.stringify(refused)}`);
    for (const failure of expected) assert.ok(refused.details.failed.includes(failure), label);
    assert.ok(!db.seen.some((text) => text.includes('CREATE OR REPLACE')), label);
  }
  // SQL 82 does not set row_security, so FORCE RLS is reported but not a precondition.
  const forced = fakeDb('sql82', { mutate: (d) => { d.tables.find((row) => row.relname === 'claims').rls_forced = true; } });
  const inspect82 = await handlerFor(forced.connect)(inspectEvent('sql82'));
  assert.deepEqual(inspect82.details.receipt.precondition_failures, []);
  assert.equal(inspect82.details.receipt.homeowner_inspect.tables.claims.rls_forced, true);
});

test('apply with a recorded pre-state replaces once; drift, replay, re-apply and collateral changes are refused and rolled back', async () => {
  for (const key of ['sql82', 'sql83']) {
    const db = fakeDb(key);
    const inspected = await handlerFor(db.connect)(inspectEvent(key));
    const live = inspected.details.receipt.live_definition_sha256;
    const recorded = { ...PINS[key], expected_live_definition_sha256: live };
    const handler = handlerFor(db.connect, { [pinKey[key]]: recorded });
    const ready = await handler(inspectEvent(key, { pin: recorded }));
    assert.equal(ready.details.receipt.pin_executable, true);
    assert.equal(ready.details.receipt.apply_preconditions_met, true);
    const event = homeownerEvent(key, { pin: recorded });
    const applied = await handler(event);
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.before_hash, live);
    assert.equal(applied.details.receipt.after_hash, recorded.intended_replacement_sha256);
    assert.ok(Object.values(applied.details.receipt.function_states).every((state) => state === 'intended'));
    assert.equal(db.seen[db.seen.indexOf('BEGIN') + 1], "SET LOCAL lock_timeout = '5s'");
    assert.ok(db.seen[db.seen.indexOf('BEGIN') + 2].includes('pg_advisory_xact_lock'));
    assert.ok(db.seen.includes('COMMIT'));
    assert.equal((await handler(event)).code, CODES.SQL_COLLISION, 'replay');
    const again = await handler(homeownerEvent(key, { pin: recorded }));
    assert.equal(again.code, CODES.UNRELATED_MUTATION);
    assert.match(again.message, /already in place/);

    // Collision: the live state moved after the inspect that the pin records.
    const drifted = fakeDb(key, { mutate: (d) => { d.acl[Object.keys(d.acl)[0]].pop(); } });
    const collision = await handlerFor(drifted.connect, { [pinKey[key]]: recorded })(homeownerEvent(key, { pin: recorded }));
    assert.equal(collision.code, CODES.DEPLOYMENT_COLLISION, JSON.stringify(collision));
    assert.match(collision.message, /not the pinned pre-apply state/);
    assert.ok(!drifted.seen.some((text) => text.includes('CREATE OR REPLACE')));

    const identity = HOMEOWNER_MIGRATIONS[key].functions[0].identity;
    for (const [label, onApply] of [
      ['authenticated kept EXECUTE', (d) => { d.acl[identity].push({ grantee: 'authenticated', privilege_type: 'EXECUTE', is_grantable: false }); }],
      ['security definer dropped', (d) => { d.fns[identity].security_definer = false; }],
      ['config changed', (d) => { d.fns[identity].config = ['search_path=public, pg_temp']; }],
      ['another definition landed', (d) => { d.fns[identity].def = `${d.fns[identity].def} `; }],
      ['an overload created', (d) => { d.extraNamed.push({ name: identity.replace(/^public\.|\(.*$/g, ''), signature: 'public.x(uuid)', result: 'jsonb' }); }],
      ['another function changed', (d) => { d.otherFunctions[0].def_sha256 = 'b'.repeat(64); }],
      ['a policy changed', (d) => { d.policies[0].polqual = 'false'; }],
      ['a relation ACL changed', (d) => { d.relations[0].relacl = '{anon=r/fakeowner}'; }],
    ]) {
      const collateral = fakeDb(key, { onApply });
      const refused = await handlerFor(collateral.connect, { [pinKey[key]]: recorded })(homeownerEvent(key, { pin: recorded }));
      assert.equal(refused.code, CODES.UNRELATED_MUTATION, `${key} ${label}: ${JSON.stringify(refused)}`);
      assert.ok(collateral.seen.includes('ROLLBACK'), label);
      assert.ok(!collateral.seen.includes('COMMIT'), label);
      assert.equal(collateral.committed.fns[identity].def, cursorFn(key, HOMEOWNER_MIGRATIONS[key].functions[0]).def, label);
    }
    const broken = fakeDb(key, { failOnApply: true });
    const failed = await handlerFor(broken.connect, { [pinKey[key]]: recorded })(homeownerEvent(key, { pin: recorded }));
    assert.equal(failed.code, CODES.UNRELATED_MUTATION);
    assert.ok(broken.seen.includes('ROLLBACK'));
  }
});

test('a COMMIT that throws is reported as outcome unknown; no ROLLBACK is sent or claimed', async () => {
  for (const key of ['sql82', 'sql83']) {
    const probe = fakeDb(key);
    const live = (await handlerFor(probe.connect)(inspectEvent(key))).details.receipt.live_definition_sha256;
    const recorded = { ...PINS[key], expected_live_definition_sha256: live };
    for (const lands of [true, false]) {
      const db = fakeDb(key);
      const connect = async () => {
        const client = await db.connect();
        const query = client.query;
        client.query = async (sql, params) => {
          if (String(sql) === 'COMMIT') {
            if (lands) await query(sql, params);
            else db.seen.push('COMMIT');
            throw new Error('Connection terminated unexpectedly');
          }
          return query(sql, params);
        };
        return client;
      };
      const result = await handlerFor(connect, { [pinKey[key]]: recorded })(homeownerEvent(key, { pin: recorded }));
      assert.equal(result.ok, false);
      assert.equal(result.code, CODES.SQL_COLLISION, `${key} lands=${lands}: ${JSON.stringify(result)}`);
      assert.match(result.message, /COMMIT outcome unknown; re-run read-live/);
      assert.doesNotMatch(result.message, /roll/i);
      assert.equal(result.details.commit_outcome, 'unknown');
      assert.equal(db.seen.at(-1), 'COMMIT', `${key} lands=${lands}: no ROLLBACK after COMMIT`);
    }
  }
});

// --- PostgreSQL 16 ---------------------------------------------------------------

const OWNER = 'sql8283_owner';

async function stagingFixture(pg, prefix, port) {
  const server = startPg(prefix, port);
  const admin = new pg.Client({ host: server.host, port: server.port, user: 'ubuntu', database: 'postgres' });
  await admin.connect();
  const connectAs = async (user) => {
    const client = new pg.Client({ host: server.host, port: server.port, user, database: 'postgres' });
    await client.connect();
    return client;
  };
  await admin.query(homeownerSchemaSql(OWNER));
  // Staging's Cursor SQL 73 / 74 functions, created by the executor login.
  const owner = await connectAs(OWNER);
  try {
    await owner.query(cursorSql73());
    await owner.query(cursorSql74());
    await owner.query(LEGACY_REMINT_SQL);
  } finally {
    await owner.end();
  }
  return { server, admin, connectAs };
}

async function loadPg(t) {
  const reason = pgSkipReason();
  if (reason) {
    t.skip(reason);
    return null;
  }
  try {
    return (await import('pg')).default;
  } catch {
    t.skip('pg module is not installed');
    return null;
  }
}

test('PostgreSQL 16: from Cursor SQL 73/74, inspect reports the live state read-only; SQL 82 then SQL 83 land on the code-derived hashes once', { timeout: 240000 }, async (t) => {
  const pg = await loadPg(t);
  if (!pg) return;
  const { server, admin, connectAs } = await stagingFixture(pg, 'pg-sql8283-exec-', 57200);
  try {
    const seen = [];
    const connect = async () => {
      const client = await connectAs(OWNER);
      const query = client.query.bind(client);
      client.query = (sql, params) => { seen.push(String(sql)); return query(sql, params); };
      return client;
    };
    for (const key of ['sql82', 'sql83']) {
      seen.length = 0;
      const before = await handlerFor(connect, { [pinKey[key]]: UNRECORDED[key] })(inspectEvent(key, { pin: UNRECORDED[key] }));
      assert.equal(before.ok, true, JSON.stringify(before));
      const receipt = before.details.receipt;
      assert.equal(seen[0], 'BEGIN READ ONLY');
      assert.equal(seen.at(-1), 'ROLLBACK');
      assert.ok(seen.slice(1, -1).every((text) => READ_ONLY_STATEMENT_RE.test(text)), JSON.stringify(seen.filter((text) => !READ_ONLY_STATEMENT_RE.test(text))));
      assert.deepEqual(receipt.precondition_failures, [], `${key}: ${JSON.stringify(receipt.homeowner_inspect)}`);
      assert.equal(receipt.pin_executable, false);
      assert.equal(receipt.apply_preconditions_met, false, 'a pin with no pre-state');
      assert.notEqual(receipt.live_definition_sha256, PINS[key].intended_replacement_sha256);
      // This fixture (the real Cursor SQL 73 / 74 files, owned by the executor login, checksops
      // EXECUTE only) reproduces the pre-state recorded from the staging read-live run, so the
      // committed pin is ready to apply here.
      assert.equal(receipt.live_definition_sha256, RECORDED_STAGING_PRE[key], key);
      const committedReceipt = (await handlerFor(connect)(inspectEvent(key))).details.receipt;
      assert.equal(committedReceipt.pin_executable, true, key);
      assert.equal(committedReceipt.apply_preconditions_met, true, key);
      const report = receipt.homeowner_inspect;
      for (const fn of HOMEOWNER_MIGRATIONS[key].functions) {
        const row = report.functions[fn.name];
        assert.equal(row.exists, true, fn.name);
        assert.equal(row.matches_migration, false, fn.name);
        assert.equal(row.body_matches_migration, false, fn.name);
        assert.deepEqual(row.acl_entries, ['checksops EXECUTE'], fn.name);
        assert.deepEqual(row.config, fn.config, fn.name);
        assert.equal(row.identity_arguments, fn.arguments, fn.name);
        assert.deepEqual(row.named_signatures, [`${fn.identity.replace(/, /g, ',')} returns jsonb`], fn.name);
        assert.equal(row.owner_is_executor, true);
        assert.equal(row.owner_rolbypassrls, false);
      }
      if (key === 'sql82') assert.equal(report.functions.aws_public_homeowner_ledger_by_token.raw_endorse_token_link, true);
      assert.equal(report.legacy_remint_signer.present, true);
      assert.deepEqual(report.legacy_remint_signer.signatures, ['public.aws_public_homeowner_ledger_remint_signer(text,uuid) returns jsonb']);
      assert.deepEqual(report.missing_columns, {});
      for (const table of ['homeowner_ledger_tokens', 'check_endorsements', 'signature_requests', 'signature_signers', 'check_intake_items', 'claims']) {
        assert.deepEqual(report.tables[table], { present: true, rls_enabled: true, rls_forced: false, owner_is_login: true }, table);
      }
      assert.equal(report.row_security_off_supported, true);
      assert.deepEqual(report.status_counts.check_endorsements, { readable: true, groups: [
        { payee_type: 'insured', status: 'sent', count: 2 }, { payee_type: 'mortgage_company', status: 'pending', count: 1 }] });
      assert.deepEqual(report.status_counts.signature_signers, { readable: true, groups: [{ status: 'pending', count: 1 }] });
      assert.deepEqual(report.status_constraints.signature_signers.map((row) => row.allowed), [['pending', 'signed', 'declined']]);
      assertNoSeededPii(assert, before, `${key} executor result`);
      assertNoSeededPii(assert, readLiveSummary({ ok: true, details: before }, { migration: CHOICES[key], pin: PINS[key] }), `${key} read-live summary`);
      assert.equal(JSON.stringify(report).includes(OWNER), false);

      const recorded = { ...PINS[key], expected_live_definition_sha256: receipt.live_definition_sha256 };
      const handler = handlerFor(connect, { [pinKey[key]]: recorded });
      assert.equal((await handler(inspectEvent(key, { pin: recorded }))).details.receipt.apply_preconditions_met, true);
      const event = homeownerEvent(key, { pin: recorded });
      const applied = await handler(event);
      assert.equal(applied.ok, true, JSON.stringify(applied));
      assert.equal(applied.details.receipt.after_hash, PINS[key].intended_replacement_sha256);
      const after = (await handler(inspectEvent(key, { pin: recorded }))).details.receipt;
      assert.equal(after.live_definition_sha256, PINS[key].intended_replacement_sha256);
      assert.equal(after.already_applied, true);
      assert.equal(after.apply_preconditions_met, false);
      for (const fn of HOMEOWNER_MIGRATIONS[key].functions) {
        const row = (await admin.query(`SELECT encode(sha256(convert_to(pg_get_functiondef($1::regprocedure), 'UTF8')), 'hex') AS def_sha,
          proacl::text AS acl, pg_get_userbyid(proowner) AS owner, proconfig::text AS config FROM pg_proc WHERE oid = $1::regprocedure`, [fn.identity])).rows[0];
        assert.equal(row.def_sha, HOMEOWNER_DEFINITION_SHA256[fn.identity], fn.identity);
        assert.equal(row.owner, OWNER);
        assert.equal(row.acl, `{${OWNER}=X/${OWNER},checksops=X/${OWNER}}`);
        assert.equal(after.homeowner_inspect.functions[fn.name].matches_migration, true);
        assert.equal(after.homeowner_inspect.functions[fn.name].body_matches_migration, true);
        assert.equal(after.homeowner_inspect.functions[fn.name].raw_endorse_token_link, false);
      }
      assert.equal((await handler(event)).code, CODES.SQL_COLLISION, 'replay');
      const reapply = await handler(homeownerEvent(key, { pin: recorded }));
      assert.equal(reapply.code, CODES.UNRELATED_MUTATION);
      assert.match(reapply.message, /already in place/);
    }
    // The legacy re-mint function is untouched; the replaced doorways still run as checksops.
    assert.equal((await admin.query("SELECT to_regprocedure('public.aws_public_homeowner_ledger_remint_signer(text, uuid)') IS NOT NULL AS p")).rows[0].p, true);
    await admin.query('BEGIN');
    try {
      await admin.query('SET LOCAL ROLE checksops');
      const view = (await admin.query("SELECT public.aws_public_homeowner_ledger_by_token('no-such-token-value') AS r")).rows[0].r;
      assert.equal(view, null);
      const pending = (await admin.query("SELECT public.aws_public_homeowner_pending_signatures('no-such-token-value') AS r")).rows[0].r;
      assert.equal(typeof pending, 'object');
    } finally {
      await admin.query('ROLLBACK');
    }
  } finally {
    await admin.end();
    server.stop();
  }
});

test('PostgreSQL 16: another signature, a return-type clash, a renamed parameter and FORCE RLS fail closed; drift after the inspect is a collision; a failing statement rolls back', { timeout: 240000 }, async (t) => {
  const pg = await loadPg(t);
  if (!pg) return;
  const { server, admin, connectAs } = await stagingFixture(pg, 'pg-sql8283-clash-', 57300);
  try {
    const connect = () => connectAs(OWNER);
    const owner = await connectAs(OWNER);
    const inspect = async (key, pin = PINS[key]) => (await handlerFor(connect, { [pinKey[key]]: pin })(inspectEvent(key, { pin }))).details.receipt;
    const refusedThenRestored = async (key, label, breakIt, restore, failures, as = owner) => {
      await as.query(breakIt);
      const receipt = await inspect(key);
      for (const failure of failures) assert.ok(receipt.precondition_failures.includes(failure), `${label}: ${JSON.stringify(receipt.precondition_failures)}`);
      const recorded = { ...PINS[key], expected_live_definition_sha256: receipt.live_definition_sha256 };
      const refused = await handlerFor(connect, { [pinKey[key]]: recorded })(homeownerEvent(key, { pin: recorded }));
      assert.equal(refused.code, CODES.DEPLOYMENT_COLLISION, `${label}: ${JSON.stringify(refused)}`);
      await as.query(restore);
      assert.deepEqual((await inspect(key)).precondition_failures, [], `${label} restored`);
    };
    await refusedThenRestored('sql83', 'a Cursor SQL 74 function with a different signature',
      'CREATE FUNCTION public.aws_public_homeowner_document_sign_capability(p_token text, p_signer_id uuid, p_kind text) RETURNS jsonb LANGUAGE sql AS $$ SELECT NULL::jsonb $$',
      'DROP FUNCTION public.aws_public_homeowner_document_sign_capability(text, uuid, text)',
      ['no_other_signature:aws_public_homeowner_document_sign_capability']);
    await refusedThenRestored('sql83', 'the same signature in another schema',
      'CREATE FUNCTION auth.aws_public_homeowner_pending_signatures(p_token text) RETURNS jsonb LANGUAGE sql AS $$ SELECT NULL::jsonb $$',
      'DROP FUNCTION auth.aws_public_homeowner_pending_signatures(text)',
      ['no_other_signature:aws_public_homeowner_pending_signatures'], admin);
    await refusedThenRestored('sql82', 'a return-type clash',
      `DROP FUNCTION public.aws_public_homeowner_ledger_by_token(text);
       CREATE FUNCTION public.aws_public_homeowner_ledger_by_token(p_token text) RETURNS json LANGUAGE sql SECURITY DEFINER AS $$ SELECT NULL::json $$`,
      `DROP FUNCTION public.aws_public_homeowner_ledger_by_token(text); ${cursorSql73()}`,
      ['return_type_jsonb:aws_public_homeowner_ledger_by_token']);
    await refusedThenRestored('sql82', 'a parameter DEFAULT (CREATE OR REPLACE cannot remove it)',
      `DROP FUNCTION public.aws_public_homeowner_ledger_by_token(text);
       CREATE FUNCTION public.aws_public_homeowner_ledger_by_token(p_token text DEFAULT NULL) RETURNS jsonb LANGUAGE sql SECURITY DEFINER AS $$ SELECT NULL::jsonb $$`,
      `DROP FUNCTION public.aws_public_homeowner_ledger_by_token(text); ${cursorSql73()}`,
      ['arguments_match:aws_public_homeowner_ledger_by_token']);
    await refusedThenRestored('sql83', 'a renamed parameter',
      `DROP FUNCTION public.aws_public_homeowner_ledger_endorse_capability(text, uuid);
       CREATE FUNCTION public.aws_public_homeowner_ledger_endorse_capability(p_token text, p_id uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER AS $$ SELECT NULL::jsonb $$`,
      `DROP FUNCTION public.aws_public_homeowner_ledger_endorse_capability(text, uuid); ${cursorSql74()}`,
      ['argument_names_match:aws_public_homeowner_ledger_endorse_capability']);
    await refusedThenRestored('sql83', 'FORCE RLS on signature_signers',
      'ALTER TABLE public.signature_signers FORCE ROW LEVEL SECURITY',
      'ALTER TABLE public.signature_signers NO FORCE ROW LEVEL SECURITY',
      HOMEOWNER_MIGRATIONS.sql83.functions.map((fn) => `row_security_off_supported:${fn.name}`));
    await refusedThenRestored('sql82', 'an anon EXECUTE grant the file does not revoke',
      'CREATE ROLE anon NOLOGIN; GRANT EXECUTE ON FUNCTION public.aws_public_homeowner_ledger_by_token(text) TO anon',
      'REVOKE EXECUTE ON FUNCTION public.aws_public_homeowner_ledger_by_token(text) FROM anon; DROP ROLE anon',
      ['acl_replaceable:aws_public_homeowner_ledger_by_token'], admin);

    // Drift between the recorded inspect and the apply: DEPLOYMENT_COLLISION, nothing replaced.
    const recorded82 = { ...PINS.sql82, expected_live_definition_sha256: (await inspect('sql82')).live_definition_sha256 };
    await owner.query('GRANT EXECUTE ON FUNCTION public.aws_public_homeowner_ledger_by_token(text) TO authenticated');
    const collision = await handlerFor(connect, { sql82Pin: recorded82 })(homeownerEvent('sql82', { pin: recorded82 }));
    assert.equal(collision.code, CODES.DEPLOYMENT_COLLISION, JSON.stringify(collision));
    assert.match(collision.message, /not the pinned pre-apply state/);
    await owner.query('REVOKE EXECUTE ON FUNCTION public.aws_public_homeowner_ledger_by_token(text) FROM authenticated');

    // A statement failing half-way (the GRANT names a missing role): the Cursor definitions stay.
    const before83 = await inspect('sql83');
    const recorded83 = { ...PINS.sql83, expected_live_definition_sha256: before83.live_definition_sha256 };
    const failing = async () => {
      const client = await connectAs(OWNER);
      const query = client.query.bind(client);
      client.query = (sql, params) => (String(sql).includes('GRANT EXECUTE ON FUNCTION public.aws_public_homeowner_document_sign_capability')
        ? query(String(sql).replace('public.aws_public_homeowner_document_sign_capability(text, uuid) TO checksops;', 'public.aws_public_homeowner_document_sign_capability(text, uuid) TO sql8283_missing_role;'), params)
        : query(sql, params));
      return client;
    };
    const result = await handlerFor(failing, { sql83Pin: recorded83 })(homeownerEvent('sql83', { pin: recorded83 }));
    assert.equal(result.code, CODES.UNRELATED_MUTATION, JSON.stringify(result));
    assert.equal((await inspect('sql83')).live_definition_sha256, before83.live_definition_sha256);
    await owner.end();
  } finally {
    await admin.end();
    server.stop();
  }
});
