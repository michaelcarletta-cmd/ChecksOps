/**
 * SQL 29 (aws/rls/sql/29_mortgage_ops_library_parity.sql) and SQL 30
 * (aws/rls/sql/30_tenant_documents_mortgage_doc_type.sql) in the staging guarded
 * executor: the pins (pending: no pre-state), the code-derived post-states, the
 * reviewed-package check (SQL 30's own BEGIN/COMMIT are stripped, anything else refuses),
 * refusals before connecting, and on PostgreSQL 16 (a non-superuser checksops_admin owns
 * everything, like production): inspect is read-only and reports counts only; apply lands
 * exactly once on the intended fingerprint; SQL 29 refuses after SQL 90; drift refuses;
 * and after SQL 29 a mortgage agent reads only attached library:mortgage documents of
 * open or assigned requests (the SQL 29 design).
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import {
  AUTHORIZED_SQL29_MORTGAGE_OPS_LIBRARY_PARITY as PIN29,
  AUTHORIZED_SQL30_TENANT_DOCUMENTS_DOC_TYPE as PIN30,
  AUTHORIZED_STAGING_SQL,
  SQL30_INTENDED_STATE,
  authorizationFingerprint,
  librarySqlExecutableText,
  resolveAuthorizedMigration,
  sql29FunctionBodies,
  sql29IntendedState,
  sql29StateText,
  sql30CheckShape,
  sql30StateText,
} from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import { EXECUTOR_PACK_MEMBERS } from '../../scripts/deployment-guard/sql-executor-ensure.mjs';
import { MIGRATIONS } from '../../scripts/deployment-guard/github-staging-sql-executor.mjs';
import { READ_LIVE_EXPECTED_SENTINEL, readLiveSummary } from '../../scripts/deployment-guard/lib/sql-executor-read-live.mjs';
import { importGuardedSqlExecutor } from './helpers/import-guarded-sql-executor.mjs';
import { assertStagingPinState, pendingPin } from './helpers/staging-sql-wave1.mjs';
import {
  AGENT,
  AGENT_OTHER,
  DOC_MORT,
  MEMBER_A,
  MEMBER_B,
  REQ_CLOSED,
  REQ_OPEN,
  SQL29_FILE,
  SQL30_FILE,
  TENANT_A,
  asApi,
  libraryFixture,
  pgSkipReason,
  seedMortgageLibrary,
} from './helpers/library-sql-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-10-16T12:00:00.000Z';
const sha = (text) => createHash('sha256').update(text).digest('hex');
const TEXT29 = fs.readFileSync(SQL29_FILE, 'utf8');
const TEXT30 = fs.readFileSync(SQL30_FILE, 'utf8');
const PINS = Object.freeze({ sql29: PIN29, sql30: PIN30 });
const CHOICES = Object.freeze({ sql29: 'sql29-mortgage-ops-library-parity', sql30: 'sql30-tenant-documents-doc-type' });
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK|BEGIN READ ONLY)\b/i;

const { module: executorModule } = await importGuardedSqlExecutor();
const { createHandler } = executorModule;

function libraryEvent(key, overrides = {}) {
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
const inspectEvent = (key, overrides = {}) => libraryEvent(key, { action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL, ...overrides });

function handlerFor(connect, extra = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql2930-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), sqlFile29: SQL29_FILE, sqlFile30: SQL30_FILE, ...extra });
}
const neverConnect = async () => { throw new Error('should-not-connect'); };

test('pins: the unchanged files, pending pre-states, code-derived post-states, selectable and packed', () => {
  assert.equal(sha(TEXT29), PIN29.source_sha256);
  assert.equal(sha(TEXT30), PIN30.source_sha256);
  assertStagingPinState(assert, 'sql29', PIN29);
  assertStagingPinState(assert, 'sql30', PIN30);
  assert.equal(sha(sql29StateText(sql29IntendedState(TEXT29))), PIN29.intended_replacement_sha256);
  assert.equal(sha(sql30StateText(SQL30_INTENDED_STATE)), PIN30.intended_replacement_sha256);
  assert.ok(AUTHORIZED_STAGING_SQL.includes(PIN29));
  assert.ok(AUTHORIZED_STAGING_SQL.includes(PIN30));
  assert.equal(resolveAuthorizedMigration({ filename: PIN29.filename }), PIN29);
  assert.equal(resolveAuthorizedMigration({ migration_id: PIN30.migration_id }), PIN30);
  assert.equal(MIGRATIONS[CHOICES.sql29], PIN29);
  assert.equal(MIGRATIONS[CHOICES.sql30], PIN30);
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  assert.equal(packed[PIN29.filename], 'sql/29_mortgage_ops_library_parity.sql');
  assert.equal(packed[PIN30.filename], 'sql/30_tenant_documents_mortgage_doc_type.sql');
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.match(workflow, /- sql29-mortgage-ops-library-parity\n/);
  assert.match(workflow, /- sql30-tenant-documents-doc-type\n/);
});

test('reviewed package: SQL 29 bodies parsed; SQL 30 runs without its own BEGIN/COMMIT; tampering refuses', () => {
  assert.deepEqual(Object.keys(sql29FunctionBodies(TEXT29)), [
    'aws_mortgage_agent_can_read_library_document',
    'aws_mortgage_agent_can_read_library_path',
    'aws_can_manage_mortgage_library',
    'aws_can_insert_mortgage_library_document',
    'share_library_docs_to_mortgage_request',
  ]);
  assert.equal(librarySqlExecutableText('sql29', TEXT29), TEXT29);
  const inner = librarySqlExecutableText('sql30', TEXT30);
  assert.ok(inner);
  assert.doesNotMatch(inner, /^BEGIN;$/m);
  assert.doesNotMatch(inner, /^COMMIT;$/m);
  assert.match(inner, /DO \$apply\$/);
  assert.equal(librarySqlExecutableText('sql30', TEXT30.replace('COMMIT;', 'COMMIT;\nDROP TABLE public.tenant_documents;')), null);
  assert.equal(librarySqlExecutableText('sql30', TEXT30.replace(/^BEGIN;$/m, '')), null);
  assert.equal(librarySqlExecutableText('sql29', `${TEXT29}\nCOMMIT;\n`), null);
  assert.equal(librarySqlExecutableText('sql29', TEXT29.replace('CREATE OR REPLACE FUNCTION public.aws_can_manage_mortgage_library', 'CREATE OR REPLACE FUNCTION public.aws_can_manage_x')), null);
  // The SQL 30 parse matches PostgreSQL's rendering of the predecessors and the target.
  assert.equal(sql30CheckShape("CHECK ((doc_type = ANY (ARRAY['w9'::text, 'license'::text, 'insurance'::text])))").shape, 'predecessor_3');
  assert.equal(sql30CheckShape("CHECK ((doc_type ~~ 'library:%'::text))").shape, 'other');
  assert.equal(sql30CheckShape('CHECK (public.aws_tenant_document_doc_type_ok(doc_type))').shape, 'sql94');
});

test('apply refuses before connecting: no pre-state, a mismatched pin, an unknown action', async () => {
  for (const key of ['sql29', 'sql30']) {
    const handler = handlerFor(neverConnect, { [`${key}Pin`]: pendingPin(PINS[key]) });
    const noPre = await handler(libraryEvent(key, { expected_live_definition_sha256: 'a'.repeat(64) }));
    assert.equal(noPre.code, CODES.SQL_COLLISION, key);
    assert.match(noPre.message, /no reviewed pre-apply live definition hash/);
    const recorded = Object.freeze({ ...PINS[key], expected_live_definition_sha256: 'b'.repeat(64) });
    const mismatched = await handlerFor(neverConnect, { [`${key}Pin`]: recorded })(libraryEvent(key, { expected_live_definition_sha256: 'c'.repeat(64) }));
    assert.equal(mismatched.code, CODES.SQL_COLLISION, key);
    assert.match(mismatched.message, /bound to the exact allowlisted pin/);
    const readLive = await handlerFor(neverConnect)(libraryEvent(key));
    assert.equal(readLive.ok, false, key);
  }
});

function recordingConnect(rows = {}) {
  const seen = [];
  return {
    seen,
    connect: async () => ({
      query: async (sql) => {
        seen.push(String(sql));
        const text = String(sql);
        if (/count\(\*\)/.test(text) && /GROUP BY 1/.test(text)) return { rows: [] };
        if (/count\(\*\)/.test(text)) return { rows: [{ n: 0 }] };
        if (/current_user::text/.test(text)) return { rows: [{ current_user: 'checksops_admin', session_user: 'checksops_admin' }] };
        return { rows: rows[text] || [] };
      },
      end: async () => {},
    }),
  };
}

test('inspect through the executor is read-only (fake client): BEGIN READ ONLY, only reads, rolled back', async () => {
  for (const key of ['sql29', 'sql30']) {
    const rec = recordingConnect();
    const result = await handlerFor(rec.connect)(inspectEvent(key));
    assert.equal(result.ok, true, JSON.stringify(result));
    const receipt = result.details.receipt;
    assert.equal(receipt.result, 'inspect');
    assert.equal(receipt.before_hash, receipt.after_hash);
    assert.equal(receipt.apply_preconditions_met, false);
    assert.ok(receipt.library_inspect);
    assert.equal(rec.seen[0], 'BEGIN READ ONLY');
    assert.ok(rec.seen.every((text) => READ_ONLY_STATEMENT_RE.test(text)), JSON.stringify(rec.seen.filter((text) => !READ_ONLY_STATEMENT_RE.test(text))));
    assert.ok(rec.seen.includes('ROLLBACK'));
    // The read-live summary keeps the library report (flags, hashes, counts).
    const summary = readLiveSummary({ ok: true, details: { ok: true, details: result.details } }, { migration: CHOICES[key], pin: PINS[key] });
    assert.equal(summary.ok, true, JSON.stringify(summary));
    assert.ok(summary.details.library_inspect);
    assert.equal(summary.details.library_inspect.sql29.functions_present, 0);
  }
});

async function withPg(t, prefix, port, fn) {
  const reason = pgSkipReason();
  if (reason) {
    t.skip(reason);
    return;
  }
  let pg;
  try {
    pg = (await import('pg')).default;
  } catch {
    t.skip('pg module is not installed');
    return;
  }
  const fx = await libraryFixture(pg, prefix, port);
  try {
    await fn(fx);
  } finally {
    await fx.close();
  }
}

test('PostgreSQL 16: SQL 30 then SQL 29 through the executor: inspect read-only, apply once, then agent reads per SQL 29', { timeout: 300000 }, async (t) => withPg(t, 'pg-sql2930-exec-', 57400, async ({ admin, connectAs }) => {
  const seen = [];
  const connect = async () => {
    const client = await connectAs('checksops_admin');
    const query = client.query.bind(client);
    client.query = (sql, params) => { seen.push(String(sql)); return query(sql, params); };
    return client;
  };
  const catalog = async () => (await admin.query(`SELECT
    (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'tenant_documents_doc_type_check') AS check_def,
    (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.mortgage_request_library_documents'::regclass) AS policies,
    (SELECT relacl::text FROM pg_class WHERE oid = 'public.mortgage_request_library_documents'::regclass) AS acl`)).rows[0];

  // SQL 30 inspect: read-only, predecessor_6, counts only.
  const start = await catalog();
  seen.length = 0;
  const inspected30 = await handlerFor(connect)(inspectEvent('sql30'));
  assert.equal(inspected30.ok, true, JSON.stringify(inspected30));
  const r30 = inspected30.details.receipt;
  assert.deepEqual(r30.precondition_failures, []);
  assert.equal(r30.library_inspect.sql30.check_shape, 'predecessor_6');
  assert.equal(r30.library_inspect.counts.rows_outside_sql30_values, 0);
  assert.equal(r30.library_inspect.counts.mortgage_request_library_documents, 0);
  assert.equal(seen[0], 'BEGIN READ ONLY');
  assert.ok(seen.every((text) => READ_ONLY_STATEMENT_RE.test(text)));
  assert.deepEqual(await catalog(), start, 'inspect changed nothing');
  const live30 = r30.live_definition_sha256;

  // Apply SQL 30 with a pin carrying that pre-state; then a replay refuses as already applied.
  const pin30 = Object.freeze({ ...PIN30, expected_live_definition_sha256: live30 });
  const applied30 = await handlerFor(connect, { sql30Pin: pin30 })(libraryEvent('sql30', { pin: pin30 }));
  assert.equal(applied30.ok, true, JSON.stringify(applied30));
  assert.equal(applied30.details.receipt.after_hash, PIN30.intended_replacement_sha256);
  const again30 = await handlerFor(connect, { sql30Pin: pin30 })(libraryEvent('sql30', { pin: pin30 }));
  assert.equal(again30.code, CODES.UNRELATED_MUTATION);

  // SQL 29: pre-state, apply, the intended fingerprint, replay refused.
  const inspected29 = await handlerFor(connect)(inspectEvent('sql29'));
  const r29 = inspected29.details.receipt;
  assert.deepEqual(r29.precondition_failures, [], JSON.stringify(r29.library_inspect));
  assert.equal(r29.library_inspect.sql29.functions.share_library_docs_to_mortgage_request.exists, true);
  assert.deepEqual(r29.library_inspect.sql29.other_policies, ['delete shared library docs', 'manage shared library docs', 'read shared library docs']);
  // Drift between inspect and apply refuses.
  const pin29 = Object.freeze({ ...PIN29, expected_live_definition_sha256: r29.live_definition_sha256 });
  await admin.query('CREATE POLICY drift ON public.mortgage_request_library_documents FOR SELECT TO authenticated USING (false)');
  const drifted = await handlerFor(connect, { sql29Pin: pin29 })(libraryEvent('sql29', { pin: pin29 }));
  assert.equal(drifted.code, CODES.DEPLOYMENT_COLLISION);
  await admin.query('DROP POLICY drift ON public.mortgage_request_library_documents');
  const applied29 = await handlerFor(connect, { sql29Pin: pin29 })(libraryEvent('sql29', { pin: pin29 }));
  assert.equal(applied29.ok, true, JSON.stringify(applied29));
  assert.equal(applied29.details.receipt.after_hash, PIN29.intended_replacement_sha256);
  const after = await catalog();
  assert.equal(after.policies, '2');
  assert.doesNotMatch(after.acl, /authenticated=[a-zA-Z]*[wd]/, 'authenticated has no UPDATE / DELETE');
  const again29 = await handlerFor(connect, { sql29Pin: pin29 })(libraryEvent('sql29', { pin: pin29 }));
  assert.equal(again29.code, CODES.UNRELATED_MUTATION);

  // Mortgage agent read per SQL 29: attached library:mortgage docs of open requests, and of
  // closed requests only for the assigned agent; members see their tenant's; others nothing.
  await seedMortgageLibrary(admin);
  const visible = (userId) => asApi(admin, userId, async () => (await admin.query(
    'SELECT request_id::text FROM public.mortgage_request_library_documents ORDER BY 1',
  )).rows.map((row) => row.request_id));
  assert.deepEqual(await visible(AGENT), [REQ_OPEN, REQ_CLOSED].sort());
  assert.deepEqual(await visible(AGENT_OTHER), [REQ_OPEN]);
  assert.deepEqual(await visible(MEMBER_A), [REQ_OPEN, REQ_CLOSED].sort());
  assert.deepEqual(await visible(MEMBER_B), []);
  assert.deepEqual(await visible(null), []);
  const pathOk = (userId) => asApi(admin, userId, async () => (await admin.query(
    'SELECT public.aws_mortgage_agent_can_read_library_path($1::text[], $2, $3::uuid) AS ok',
    [[`${TENANT_A}/library/mortgage/w9.pdf`], `${TENANT_A}/library/mortgage/w9.pdf`, userId],
  )).rows[0].ok);
  assert.equal(await pathOk(AGENT), true);
  assert.equal(await pathOk(MEMBER_A), false, 'not a mortgage agent');
  // Agents cannot UPDATE or DELETE attachments.
  await assert.rejects(asApi(admin, AGENT, () => admin.query('DELETE FROM public.mortgage_request_library_documents')), (error) => error.code === '42501');
  assert.ok(DOC_MORT);
}));

test('PostgreSQL 16: SQL 29 refuses after SQL 90 (it would bring back the owner/admin tier); SQL 30 refuses SQL 94\'s CHECK', { timeout: 300000 }, async (t) => withPg(t, 'pg-sql2930-order-', 57500, async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');
  await admin.query(`CREATE FUNCTION public.aws_is_tenant_member(_tenant_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
    ALTER FUNCTION public.aws_is_tenant_member(uuid) OWNER TO checksops_admin;`);
  const r29 = (await handlerFor(connect)(inspectEvent('sql29'))).details.receipt;
  assert.ok(r29.precondition_failures.includes('sql90_not_applied'));
  assert.equal(r29.apply_preconditions_met, false);
  const pin29 = Object.freeze({ ...PIN29, expected_live_definition_sha256: r29.live_definition_sha256 });
  const refused = await handlerFor(connect, { sql29Pin: pin29 })(libraryEvent('sql29', { pin: pin29 }));
  assert.equal(refused.code, CODES.DEPLOYMENT_COLLISION);
  assert.deepEqual(refused.details.failed, ['sql90_not_applied']);

  await admin.query(`CREATE FUNCTION public.aws_tenant_document_doc_type_ok(text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT true $$;
    ALTER TABLE public.tenant_documents DROP CONSTRAINT tenant_documents_doc_type_check;
    ALTER TABLE public.tenant_documents ADD CONSTRAINT tenant_documents_doc_type_check CHECK (public.aws_tenant_document_doc_type_ok(doc_type));`);
  const r30 = (await handlerFor(connect)(inspectEvent('sql30'))).details.receipt;
  assert.equal(r30.library_inspect.sql30.check_shape, 'sql94');
  assert.ok(r30.precondition_failures.includes('check_is_supported_predecessor'));
}));
