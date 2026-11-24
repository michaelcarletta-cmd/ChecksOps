/**
 * Read-only production inspect of one check whose endorsements are signed but which did not
 * advance to ready for deposit (scripts/deployment-guard/check-endorsement-state-inspect.mjs,
 * lib/check-endorsement-state-inspect.mjs, ops/production-check-endorsement-state-inspect.md):
 *
 *   - the configuration is inspect-only and bound to the same production RDS and
 *     checksops_admin secret as the Mortgage Desk access inspect; the tool is inventoried SAFE
 *     and is not a one-shot apply entry;
 *   - the CLI accepts exactly --inspect --check-id <uuid>, refuses every other argument, a
 *     check id that is not a uuid and any deployment-guard environment variable before reading
 *     a secret or connecting;
 *   - every statement is a fixed constant: BEGIN READ ONLY, a SELECT / WITH ... SELECT or
 *     ROLLBACK; no INSERT, UPDATE or DELETE; the signature columns never leave the database;
 *   - with fake clients whose rows carry names, emails, amounts, paths, tokens and signature
 *     data, none of them reaches the output;
 *   - the predicted blocker for every case, in the order finalizeEndorsementState meets them;
 *   - on PostgreSQL 16, as a non-superuser checksops_admin: the statements run, nothing
 *     changes, a write inside the inspect's transaction is refused (25006) and nothing leaks.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { main, parseArgs } from '../../scripts/deployment-guard/check-endorsement-state-inspect.mjs';
import {
  BLOCKERS,
  INSPECT_STATEMENTS,
  INSPECT_TABLES,
  Q,
  inspectCheckEndorsementState,
  loadInspectConfig,
  predictBlockers,
  recoverWithoutS3,
} from '../../scripts/deployment-guard/lib/check-endorsement-state-inspect.mjs';
import { ONE_SHOT_TOOLS } from '../../scripts/deployment-guard/lib/production-sql-one-shot.mjs';
import { pgSkipReason, startPg } from './helpers/stakeholder-policies-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TOOL = 'scripts/deployment-guard/check-endorsement-state-inspect.mjs';
const LIB = 'scripts/deployment-guard/lib/check-endorsement-state-inspect.mjs';
const READ_ONLY_STATEMENT_RE = /^\s*(BEGIN READ ONLY|SELECT|WITH|ROLLBACK)\b/;
const MUTATING_RE = /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE|COPY|CALL|DO|LOCK|VACUUM|ANALYZE|REFRESH|COMMENT|SECURITY LABEL|REASSIGN|nextval|setval|pg_terminate|pg_cancel|lo_)\b/i;
const UUID_ANY = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const CHECK_ID = '7d1e2f30-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const TENANT_ID = '11111111-2222-4333-8444-555555555555';
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

// --- fake client -------------------------------------------------------------------------

const COLUMNS = {
  check_intake_items: ['id', 'tenant_id', 'status', 'check_stage', 'deposited_at', 'deposit_recommendation', 'amount', 'payee_line',
    'back_image_path', 'back_image_original_path', 'back_image_deposit_path', 'endorsement_render_meta', 'endorsement_render_status'],
  check_endorsements: ['id', 'check_id', 'tenant_id', 'payee_id', 'payee_name', 'payee_type', 'status', 'signed_at', 'signature_image_url',
    'signature_method', 'contact_email', 'token', 'created_at'],
  check_payees: ['id', 'check_id', 'tenant_id', 'payee_type', 'endorsement_status', 'endorsed_at', 'endorsement_image_path', 'endorsement_token'],
  check_audit_log: ['check_id', 'event_type', 'event_data', 'created_at'],
  checkalt_deposits: ['id', 'tenant_id', 'check_intake_item_id', 'checkalt_reference', 'status', 'provider_http_attempted_at',
    'last_status_payload', 'idempotency_key', 'created_at'],
};
const SECRET_NAME = 'Jane Q Homeowner';
const SECRET_EMAIL = 'jane.homeowner@example.com';
const SECRET_PATH = `tenants/${TENANT_ID}/checks/${CHECK_ID}/Jane_Q_Homeowner_back`;
const SIGNATURE = 'data:image/png;base64,iVBORw0KGgoSECRETSIGNATURE';
const LEAKS = [SECRET_NAME, 'Jane', SECRET_EMAIL, SECRET_PATH, 'Homeowner_back', 'SECRETSIGNATURE', 'base64', '5542', 'tok-secret-123', CHECK_ID, TENANT_ID,
  'claim-files', '.jpg', '.png', '.svg'];

/** A clean-original check whose endorsements are all signed with drawn ink: no blocker. */
const baseState = () => ({
  check: {
    id: CHECK_ID, tenant_id: TENANT_ID, status: 'needs_review', check_stage: 'endorsing', deposited_at: null, deposit_recommendation: null,
    // Extra keys a careless SELECT could return; the report must not print them.
    amount: '5542.00', payee_line: SECRET_NAME, contact_email: SECRET_EMAIL,
    back_image_path: `${SECRET_PATH}.jpg`, back_image_original_path: `${SECRET_PATH}.jpg`, back_image_deposit_path: null,
    endorsement_render_meta: { original_back_image_path: `${SECRET_PATH}.jpg`, signer: SECRET_NAME }, endorsement_render_status: 'idle',
  },
  endorsements: [
    { payee_name: SECRET_NAME, contact_email: SECRET_EMAIL, token: 'tok-secret-123', payee_type: 'insured', status: 'signed',
      signature_method: 'portal', signature_image_url: SIGNATURE, endorsement_image_path: null },
    { payee_name: 'Acme Mortgage', payee_type: 'mortgage_company', status: 'manual_required', signature_method: 'manual',
      signature_image_url: null, endorsement_image_path: null },
  ],
  deposits: [],
  audits: [{ event_data: { original_back_image_path: `${SECRET_PATH}.png`, endorsed_back_image_path: `${SECRET_PATH}_endorsed.svg` }, created_at: new Date() }],
  events: [
    { event_type: 'endorsement_signed', created_at: new Date('2026-11-24T10:00:00Z'), event_data: { signer: SECRET_NAME, amount: 5542 } },
    { event_type: 'Weird Event by Jane', created_at: '2026-11-24T09:00:00Z' },
  ],
});

function fakeClient(state, { readOnly = 'on', columns = COLUMNS } = {}) {
  const names = new Map(Object.entries(Q).map(([k, v]) => [v, k]));
  const statements = [];
  const rows = {
    session: [{ transaction_read_only: readOnly, current_user: 'checksops_admin', session_user: 'checksops_admin', server_version_num: 180001 }],
    columns: Object.entries(columns).flatMap(([t, cs]) => cs.map((c) => ({ table_name: t, column_name: c }))),
    check: state.check ? [{ check_row: state.check }] : [],
    completion: state.endorsements.map((e) => ({ status: e.status, payee_type: e.payee_type })),
    endorsements: state.endorsements,
    deposits: state.deposits,
    compositeAudits: state.audits,
    eligibilityPayees: state.payees || [],
    eligibilityEndorsements: state.eligibilityEndorsements || [],
    events: state.events,
  };
  const client = {
    ended: false,
    query: async (sql, params) => {
      statements.push({ sql, params });
      const key = names.get(sql);
      if (!key) throw new Error(`unexpected statement: ${sql}`);
      return { rows: rows[key] || [] };
    },
    end: async () => { client.ended = true; },
  };
  return { client, statements, connect: async () => client };
}

const runFake = async (state, opts) => {
  const fake = fakeClient(state, opts);
  const result = await inspectCheckEndorsementState({ connect: fake.connect, checkId: CHECK_ID });
  return { ...fake, result, text: JSON.stringify(result) };
};

// --- configuration, inventory, statements ------------------------------------------------

test('the configuration is inspect-only and bound to the same production RDS and admin secret as the Mortgage Desk inspect', () => {
  const config = loadInspectConfig(ROOT);
  const desk = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/mortgage-desk-access-production-inspect.json'), 'utf8'));
  assert.equal(config.read_only, true);
  assert.equal(config.apply, false);
  assert.equal(config.target_environment, 'production');
  assert.equal(config.tool, TOOL);
  assert.equal(config.execute, undefined);
  assert.equal(config.authorization_phrase, undefined);
  assert.equal(config.production_inspect, null);
  for (const key of ['admin_login', 'rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(config[key], desk[key], key);
  assert.ok(fs.existsSync(path.join(ROOT, config.runbook)));
});

test('the tool is inventoried as SAFE, is not a one-shot apply entry and has no write or S3 capability', () => {
  const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/bypass-inventory.json'), 'utf8'));
  const entry = inventory.scripts.find((s) => s.path === TOOL);
  assert.ok(entry, 'inventoried');
  assert.equal(entry.classification, 'SAFE');
  assert.match(entry.note, /BEGIN READ ONLY/);
  assert.ok(!JSON.stringify(ONE_SHOT_TOOLS).includes('check-endorsement-state-inspect'));
  const source = fs.readFileSync(path.join(ROOT, TOOL), 'utf8') + fs.readFileSync(path.join(ROOT, LIB), 'utf8');
  assert.doesNotMatch(source, /CHECKSOPS_DEPLOYMENT_GUARD_APPLY|issueReceipt|acquireLease|UpdateFunctionCode|PutObject|GetObject|SendCommand|client-s3|downloadClaimFile|compositeEndorsementSignatures\(|finalizeEndorsementState\(/);
});

test('every statement is a fixed read-only constant with no INSERT, UPDATE or DELETE, and the signature columns never leave the database', () => {
  assert.equal(INSPECT_STATEMENTS[0], 'BEGIN READ ONLY');
  assert.equal(INSPECT_STATEMENTS.at(-1), 'ROLLBACK');
  for (const sql of INSPECT_STATEMENTS) {
    assert.match(sql, READ_ONLY_STATEMENT_RE, sql);
    assert.doesNotMatch(sql.replace(/'[^']*'/g, "''"), MUTATING_RE, sql);
    assert.doesNotMatch(sql, /\b(payee_name|contact_email|contact_phone|endorsement_token|token|amount|check_number|payee_line|event_description)\b/, sql);
  }
  // The signature columns appear only inside the CASE that reduces them to a class.
  const select = Q.endorsements.slice(0, Q.endorsements.indexOf('FROM'));
  for (const col of ['e.signature_image_url', 'p.endorsement_image_path']) {
    const uses = select.split(col).length - 1;
    assert.equal(uses, 3, col);
    assert.ok(select.includes(`ELSE 'other' END AS ${col.split('.')[1]}`), col);
  }
  // The recent events are event_type and created_at only, at most 20.
  assert.match(Q.events, /^SELECT a\.event_type, a\.created_at\n/);
  assert.match(Q.events, /LIMIT 20$/);
  assert.deepEqual([...INSPECT_TABLES].sort(), ['check_audit_log', 'check_endorsements', 'check_intake_items', 'check_payees', 'checkalt_deposits']);
});

// --- CLI refusals ------------------------------------------------------------------------

test('the CLI accepts exactly --inspect --check-id <uuid> and refuses everything else before a secret or connection', async () => {
  assert.deepEqual(parseArgs(['--inspect', '--check-id', CHECK_ID.toUpperCase()]), { checkId: CHECK_ID });
  assert.deepEqual(parseArgs(['--check-id', CHECK_ID, '--inspect']), { checkId: CHECK_ID });
  for (const argv of [[], ['--inspect'], ['--apply'], ['--check-id', CHECK_ID], ['--inspect', '--apply', CHECK_ID],
    ['--inspect', '--check-id', CHECK_ID, '--apply'], ['--inspect', '--check-id', CHECK_ID, '--check-id', CHECK_ID],
    ['--inspect', '--input', 'x.json'], ['--inspect', '--password', 'x'], ['--inspect', '--sql', 'SELECT 1'],
    ['--inspect', '--database-url', 'postgres://x'], [`--check-id=${CHECK_ID}`, '--inspect'], ['--inspect=1', '--check-id', CHECK_ID],
    ['inspect', '--check-id', CHECK_ID], ['--inspect', CHECK_ID, '--check-id'], ['--inspect', '--inspect', '--check-id']]) {
    let touched = false;
    const deps = {
      root: ROOT,
      connect: async () => { touched = true; throw new Error('must not connect'); },
      resolveUrl: async () => { touched = true; throw new Error('must not read the secret'); },
    };
    const { code, text } = await quiet(() => main(argv, {}, deps));
    assert.equal(code, 1, argv.join(' '));
    assert.equal(touched, false, argv.join(' '));
    assert.match(text, /accepts exactly: --inspect --check-id <uuid>/, argv.join(' '));
    assert.doesNotMatch(text, /x\.json|postgres:\/\/|SELECT 1/);
  }
  for (const bad of ['not-a-uuid', `${CHECK_ID}x`, `'${CHECK_ID}'`, `${CHECK_ID}; DROP TABLE x`, '', 'Jane Q Homeowner', '7d1e2f30-4a5b-4c6d-8e9f-0a1b2c3d4e5']) {
    let touched = false;
    const deps = { root: ROOT, connect: async () => { touched = true; }, resolveUrl: async () => { touched = true; } };
    const { code, text } = await quiet(() => main(['--inspect', '--check-id', bad], {}, deps));
    assert.equal(code, 1, bad);
    assert.equal(touched, false, bad);
    assert.match(text, /--check-id must be a uuid/);
    if (bad) assert.ok(!text.includes(bad), `echoed ${bad}`);
  }
});

test('the CLI refuses any deployment-guard environment variable before a secret or connection', async () => {
  for (const env of [{ CHECKSOPS_SKIP_DEPLOYMENT_GUARD: '1' }, { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' }, { CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT: '/tmp/r.json' }]) {
    let touched = false;
    const deps = { root: ROOT, connect: async () => { touched = true; }, resolveUrl: async () => { touched = true; } };
    const { code, text } = await quiet(() => main(['--inspect', '--check-id', CHECK_ID], env, deps));
    assert.equal(code, 1);
    assert.equal(touched, false);
    assert.match(text, /refuses to run with deployment-guard environment variables/);
  }
});

test('the CLI refuses a configuration that is not read-only production', async () => {
  const base = loadInspectConfig(ROOT);
  for (const config of [{ ...base, read_only: false }, { ...base, apply: true }, { ...base, target_environment: 'staging' }]) {
    let touched = false;
    const { code } = await quiet(() => main(['--inspect', '--check-id', CHECK_ID], {}, {
      root: ROOT, config, connect: async () => { touched = true; throw new Error('no'); }, resolveUrl: async () => { touched = true; } }));
    assert.equal(code, 1);
    assert.equal(touched, false);
  }
});

test('a connection failure prints only the JSON error with its code', async () => {
  const host = 'endorsement-unreachable.invalid';
  const password = 'Hunter2-not-a-real-password';
  const failing = async () => {
    const error = new Error(`getaddrinfo ENOTFOUND ${host} (postgres://checksops_admin:${password}@${host}:5432/postgres)`);
    error.code = 'ENOTFOUND';
    throw error;
  };
  const { code, text } = await quiet(() => main(['--inspect', '--check-id', CHECK_ID], {}, { root: ROOT, connect: failing }));
  assert.equal(code, 1);
  const result = JSON.parse(text);
  assert.deepEqual(Object.keys(result.details).sort(), ['error_code', 'read_only', 'stage']);
  assert.equal(result.details.stage, 'connect');
  assert.equal(result.details.error_code, 'ENOTFOUND');
  for (const leak of [host, password, 'postgres://', '    at ', CHECK_ID]) assert.ok(!text.includes(leak), `leaked ${leak}`);
});

// --- read-only wrapping and output -------------------------------------------------------

test('the inspect runs inside BEGIN READ ONLY ... ROLLBACK, sends only the fixed statements, and ends the client', async () => {
  const { statements, result, client } = await runFake(baseState());
  assert.equal(result.ok, true);
  assert.equal(statements[0].sql, 'BEGIN READ ONLY');
  assert.equal(statements.at(-1).sql, 'ROLLBACK');
  assert.equal(statements.filter((s) => s.sql === 'ROLLBACK').length, 1);
  for (const { sql } of statements) {
    assert.ok(INSPECT_STATEMENTS.includes(sql), sql);
    assert.doesNotMatch(sql.replace(/'[^']*'/g, "''"), /\b(INSERT|UPDATE|DELETE)\b/i, sql);
  }
  assert.equal(client.ended, true);
  // The check id is only ever a bound parameter.
  assert.ok(statements.every(({ sql }) => !sql.includes(CHECK_ID)));
  assert.deepEqual(statements.find((s) => s.sql === Q.check).params[0], CHECK_ID);

  // A session that is not read-only is refused before any check row is read, and still rolled back.
  const refused = await runFake(baseState(), { readOnly: 'off' });
  assert.equal(refused.result.ok, false);
  assert.match(refused.result.message, /not read-only/);
  assert.ok(!refused.statements.some((s) => s.sql === Q.check));
  assert.equal(refused.statements.at(-1).sql, 'ROLLBACK');

  // A failing statement reports its stage and SQLSTATE only, and is rolled back.
  const fake = fakeClient(baseState());
  const query = fake.client.query;
  fake.client.query = async (sql, params) => {
    if (sql === Q.endorsements) throw Object.assign(new Error(`permission denied for ${SECRET_NAME}`), { code: '42501' });
    return query(sql, params);
  };
  const failed = await inspectCheckEndorsementState({ connect: fake.connect, checkId: CHECK_ID });
  assert.deepEqual(failed.details, { read_only: true, stage: 'endorsements', error_code: '42501' });
  assert.ok(!JSON.stringify(failed).includes(SECRET_NAME));
  assert.equal(fake.statements.at(-1).sql, 'ROLLBACK');
});

test('the output has no names, emails, amounts, paths, ids, tokens or signature data', async () => {
  const states = [baseState()];
  const sibling = baseState();
  sibling.check.back_image_original_path = `${SECRET_PATH}_endorsed.svg`;
  sibling.check.back_image_path = `${SECRET_PATH}_endorsed.svg`;
  sibling.check.endorsement_render_meta = {};
  states.push(sibling);
  const rear = baseState();
  rear.check.back_image_deposit_path = `${SECRET_PATH}/endorsed_deposit_ab12.checkalt.jpg`;
  rear.payees = [{ id: TENANT_ID, check_id: CHECK_ID, tenant_id: TENANT_ID, payee_type: 'insured', endorsement_status: 'signed', endorsed_at: null }];
  rear.eligibilityEndorsements = [{ id: TENANT_ID, check_id: CHECK_ID, tenant_id: TENANT_ID, payee_id: TENANT_ID, payee_type: 'insured', status: 'signed', signed_at: null }];
  states.push(rear);
  for (const state of states) {
    const { text, result } = await runFake(state);
    assert.equal(result.ok, true);
    for (const leak of LEAKS) assert.ok(!text.includes(leak), `leaked ${leak}`);
    assert.doesNotMatch(text, UUID_ANY);
    const report = result.details;
    assert.deepEqual(Object.keys(report.check).sort(), ['active_loss_draft', 'check_stage', 'deposit_recommendation', 'deposited_at_set',
      'endorsement_render_meta', 'endorsement_render_status', 'ineligible_for_auto_advance', 'ready_transition',
      'status', 'status_in_ineligible_auto_advance_statuses']);
    for (const row of report.endorsements.rows) {
      assert.deepEqual(Object.keys(row).sort(), ['blocks_composite', 'endorsement_image_path_present', 'has_usable_drawn_ink', 'index',
        'is_exception_completion', 'payee_type', 'satisfied', 'signature_image_url_present', 'signature_method', 'status']);
    }
    for (const event of report.recent_events.rows) assert.deepEqual(Object.keys(event).sort(), ['created_at', 'event_type']);
    assert.ok(report.recent_events.rows.length <= 20);
  }
  const { result } = await runFake(baseState());
  const report = result.details;
  assert.deepEqual(report.recent_events.rows, [
    { event_type: 'endorsement_signed', created_at: '2026-11-24T10:00:00.000Z' },
    { event_type: 'other', created_at: '2026-11-24T09:00:00.000Z' },
  ]);
  assert.deepEqual(report.images.back_image_original_path, {
    column_exists: true, present: true, clean_raster_original: true, endorsed_artifact: false, checkalt_artifact: false });
  assert.deepEqual(report.images.endorsed_back_image_path, {
    column_exists: false, present: false, clean_raster_original: false, endorsed_artifact: false, checkalt_artifact: false });
  assert.deepEqual(report.endorsements.rows[0], { index: 0, payee_type: 'insured', status: 'signed', signature_method: 'portal',
    signature_image_url_present: true, endorsement_image_path_present: false, has_usable_drawn_ink: true, is_exception_completion: false,
    satisfied: true, blocks_composite: false });
  assert.deepEqual(report.endorsements.rows[1], { index: 1, payee_type: 'mortgage_company', status: 'manual_required', signature_method: 'manual',
    signature_image_url_present: false, endorsement_image_path_present: false, has_usable_drawn_ink: false, is_exception_completion: true,
    satisfied: true, blocks_composite: false });
  assert.deepEqual({ allSigned: report.completion.allSigned, anyRejected: report.completion.anyRejected }, { allSigned: true, anyRejected: false });
  assert.deepEqual(report.recovery, { ok: true, error: null, source: 'back_image_original_path', determined: true, s3: 'not_needed', s3_checks_skipped: 0 });
  assert.equal(report.prediction.predicted_blocker, 'none');
});

// --- blocker prediction ------------------------------------------------------------------

const predicted = async (mutate) => {
  const state = baseState();
  mutate(state);
  const { result } = await runFake(state);
  assert.equal(result.ok, true);
  return result.details;
};

test('blocker prediction: each case on a fake client', async () => {
  // none
  assert.equal((await predicted(() => {})).prediction.predicted_blocker, 'none');

  // check_not_found: nothing else is read.
  {
    const state = baseState();
    state.check = null;
    const { result, statements } = await runFake(state);
    assert.equal(result.details.check_found, false);
    assert.equal(result.details.prediction.predicted_blocker, 'check_not_found');
    assert.ok(!statements.some((s) => [Q.completion, Q.endorsements, Q.deposits, Q.compositeAudits, Q.events].includes(s.sql)));
  }

  // ineligible_status: a status in INELIGIBLE_AUTO_ADVANCE_STATUSES, or deposited_at set.
  for (const mutate of [(s) => { s.check.status = 'funds_released'; }, (s) => { s.check.deposited_at = '2026-11-20T00:00:00Z'; }]) {
    const report = await predicted(mutate);
    assert.equal(report.prediction.predicted_blocker, 'ineligible_status');
    assert.equal(report.check.ineligible_for_auto_advance, true);
    assert.equal(report.historical_deposit_locked, true);
  }
  assert.equal((await predicted((s) => { s.check.status = 'deposited'; })).check.status_in_ineligible_auto_advance_statuses, true);

  // any_rejected
  assert.equal((await predicted((s) => { s.endorsements[1].status = 'rejected'; })).prediction.predicted_blocker, 'any_rejected');

  // not_all_signed: a pending insured, or a contractor (a required signer) still pending.
  assert.equal((await predicted((s) => { s.endorsements[0].status = 'pending'; })).prediction.predicted_blocker, 'not_all_signed');
  {
    const report = await predicted((s) => { s.endorsements.push({ payee_type: 'contractor', status: 'sent', signature_method: 'portal' }); });
    assert.equal(report.prediction.predicted_blocker, 'not_all_signed');
    assert.equal(report.completion.allSigned, false);
  }

  // historical_deposit_locked: a CheckAlt deposit with a provider reference on an otherwise eligible check.
  {
    const report = await predicted((s) => {
      s.deposits = [{ status: 'pending', has_reference: true, provider_http_attempted: false, payload_http_attempted: null, legacy_row: false }];
    });
    assert.equal(report.prediction.predicted_blocker, 'historical_deposit_locked');
    assert.deepEqual(report.deposits, { read: true, count: 1, blocking: { status: 'pending', has_reference: true } });
  }
  // A failed deposit row without a provider attempt does not lock.
  assert.equal((await predicted((s) => {
    s.deposits = [{ status: 'failed', has_reference: false, provider_http_attempted: false, payload_http_attempted: false, legacy_row: false }];
  })).historical_deposit_locked, false);

  // original_back_missing: no clean original and no recovery evidence (determined without S3).
  {
    const report = await predicted((s) => {
      s.check.back_image_original_path = null;
      s.check.back_image_path = null;
      s.check.endorsement_render_meta = {};
      s.audits = [];
    });
    assert.deepEqual(report.recovery, { ok: false, error: 'original_back_missing', source: null, determined: true, s3: 'not_needed', s3_checks_skipped: 0 });
    assert.equal(report.prediction.predicted_blocker, 'original_back_missing');
  }

  // original_back_ambiguous / missing depend on S3 for a sibling reconstruction: undetermined, with both possibilities.
  {
    const report = await predicted((s) => {
      s.check.back_image_original_path = `${SECRET_PATH}_endorsed.svg`;
      s.check.back_image_path = `${SECRET_PATH}_endorsed.svg`;
      s.check.endorsement_render_meta = {};
      s.audits = [];
    });
    assert.equal(report.recovery.determined, false);
    assert.equal(report.recovery.s3, 'skipped');
    assert.deepEqual(report.recovery.if_every_object_absent, { ok: false, error: 'original_back_missing', source: null });
    assert.deepEqual(report.recovery.if_every_object_present, { ok: false, error: 'original_back_ambiguous', source: null });
    assert.equal(report.prediction.predicted_blocker, 'undetermined');
    assert.deepEqual(report.prediction.possible_blockers, ['original_back_missing', 'original_back_ambiguous']);
    assert.equal(report.images.back_image_path.endorsed_artifact, true);
  }
  // A determined ambiguous recovery (as a run with S3 would give) is named.
  assert.equal(predictBlockers({
    check: { status: 'needs_review' }, completion: { allSigned: true, anyRejected: false }, locked: false,
    recovery: { ok: false, error: 'original_back_ambiguous', determined: true },
  }).predicted_blocker, 'original_back_ambiguous');

  // signature_image_missing: signed through the portal with a typed (not drawn) signature.
  {
    const report = await predicted((s) => { s.endorsements[0].signature_image_url = `typed:${SECRET_NAME}`; });
    assert.equal(report.prediction.predicted_blocker, 'signature_image_missing');
    assert.equal(report.endorsements.rows[0].has_usable_drawn_ink, false);
    assert.equal(report.endorsements.rows[0].signature_image_url_present, true);
    assert.equal(report.endorsements.rows[0].blocks_composite, true);
  }
  // The drawn ink on the payee row counts; a manual signer is an exception completion.
  assert.equal((await predicted((s) => { s.endorsements[0].signature_image_url = ''; s.endorsements[0].endorsement_image_path = SIGNATURE; }))
    .prediction.predicted_blocker, 'none');
  assert.equal((await predicted((s) => { s.endorsements[0].signature_image_url = null; s.endorsements[0].signature_method = 'physical_check'; }))
    .prediction.predicted_blocker, 'none');

  // loss_draft_hold: an active loss draft by status or by stage.
  for (const mutate of [(s) => { s.check.status = 'loss_draft_required'; }, (s) => { s.check.check_stage = 'loss_draft'; }]) {
    const report = await predicted(mutate);
    assert.equal(report.prediction.predicted_blocker, 'loss_draft_hold');
    assert.equal(report.check.active_loss_draft, true);
    assert.equal(report.check.ready_transition, 'hold_loss_draft');
  }

  // Several blockers are all listed, first in finalizeEndorsementState's order.
  {
    const report = await predicted((s) => {
      s.check.check_stage = 'loss_draft';
      s.endorsements[0].signature_image_url = null;
      s.endorsements.push({ payee_type: 'insured', status: 'pending' });
    });
    assert.deepEqual(report.prediction.blockers, ['not_all_signed', 'signature_image_missing', 'loss_draft_hold']);
    assert.equal(report.prediction.predicted_blocker, 'not_all_signed');
  }
  for (const report of [await predicted(() => {})]) {
    assert.ok(report.prediction.undetermined.includes('auto_advance_flag'));
    for (const b of report.prediction.blockers) assert.ok(BLOCKERS.includes(b));
  }
});

test('recovery without S3 never calls S3 and is determined only when S3 cannot change it', async () => {
  const clean = await recoverWithoutS3({ id: CHECK_ID, back_image_original_path: 'a/b/back.jpg' }, []);
  assert.deepEqual(clean, { ok: true, error: null, source: 'back_image_original_path', determined: true, s3: 'not_needed', s3_checks_skipped: 0 });
  const fromCurrent = await recoverWithoutS3({ id: CHECK_ID, back_image_original_path: null, back_image_path: 'a/b/back.png' }, []);
  assert.equal(fromCurrent.source, 'back_image_path');
  // Audit evidence needs an existence check: undetermined between check_audit_log and missing.
  const audited = await recoverWithoutS3({ id: CHECK_ID, back_image_original_path: null, back_image_path: null },
    [{ event_data: { original_back_image_path: 'a/b/back.jpg' } }]);
  assert.equal(audited.determined, false);
  assert.deepEqual(audited.if_every_object_present, { ok: true, error: null, source: 'check_audit_log' });
});

test('a missing column skips only the statements that read it', async () => {
  const columns = { ...COLUMNS, checkalt_deposits: COLUMNS.checkalt_deposits.filter((c) => c !== 'idempotency_key'),
    check_intake_items: COLUMNS.check_intake_items.filter((c) => c !== 'check_stage') };
  const { result, statements } = await runFake(baseState(), { columns });
  const report = result.details;
  assert.deepEqual(report.deposits, { read: false, reason: 'columns_missing:checkalt_deposits.idempotency_key' });
  assert.equal(report.historical_deposit_locked, null);
  assert.equal(report.check.check_stage, 'column_missing');
  assert.ok(!statements.some((s) => s.sql === Q.deposits));
  assert.equal(report.prediction.predicted_blocker, 'undetermined');
  assert.ok(report.prediction.undetermined.includes('historical_deposit_lock'));
});

// --- PostgreSQL 16 -----------------------------------------------------------------------

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SETUP = `
CREATE ROLE checksops_admin LOGIN NOSUPERUSER;
CREATE TABLE public.check_intake_items (id uuid PRIMARY KEY, tenant_id uuid, status text, check_stage text, deposited_at timestamptz,
  deposit_recommendation text, amount numeric, check_number text, payee_line text, back_image_path text, back_image_original_path text,
  back_image_deposit_path text, endorsement_render_meta jsonb, endorsement_render_status text);
CREATE TABLE public.check_payees (id uuid PRIMARY KEY, check_id uuid, tenant_id uuid, payee_name text, payee_type text, endorsement_status text,
  endorsed_at timestamptz, endorsement_image_path text, endorsement_token text);
CREATE TABLE public.check_endorsements (id uuid PRIMARY KEY, check_id uuid, tenant_id uuid, payee_id uuid, payee_name text, payee_type text,
  status text, signed_at timestamptz, signature_image_url text, signature_method text, contact_email text, token text, created_at timestamptz DEFAULT now());
CREATE TABLE public.check_audit_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), check_id uuid NOT NULL, event_type text NOT NULL,
  event_description text, event_data jsonb DEFAULT '{}'::jsonb, created_at timestamptz DEFAULT now());
CREATE TABLE public.checkalt_deposits (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, check_intake_item_id uuid,
  checkalt_reference text, status text, amount numeric, provider_http_attempted_at timestamptz, last_status_payload jsonb,
  idempotency_key text, created_at timestamptz DEFAULT now());
GRANT SELECT ON ALL TABLES IN SCHEMA public TO checksops_admin;
`;
const ROWS = `
INSERT INTO public.check_intake_items VALUES ('${ID(1)}', '${ID(2)}', 'needs_review', 'endorsing', NULL, NULL, 5542, 'CK-SECRET-1', '${SECRET_NAME}',
  '${SECRET_PATH}_endorsed.svg', NULL, NULL, '{"signer": "${SECRET_NAME}"}', 'failed');
INSERT INTO public.check_payees VALUES ('${ID(11)}', '${ID(1)}', '${ID(2)}', '${SECRET_NAME}', 'insured', 'signed', now(), NULL, 'tok-secret-123');
INSERT INTO public.check_endorsements (id, check_id, tenant_id, payee_id, payee_name, payee_type, status, signed_at, signature_image_url, signature_method, contact_email, token, created_at) VALUES
  ('${ID(21)}', '${ID(1)}', '${ID(2)}', '${ID(11)}', '${SECRET_NAME}', 'insured', 'signed', now(), '${SIGNATURE}', 'portal', '${SECRET_EMAIL}', 'tok-secret-123', now() - interval '2 hours'),
  ('${ID(22)}', '${ID(1)}', '${ID(2)}', NULL, 'Acme Mortgage', 'mortgage_company', 'manual_required', NULL, NULL, 'manual', NULL, NULL, now() - interval '1 hour'),
  ('${ID(23)}', '${ID(1)}', '${ID(2)}', NULL, 'Bob Typed', 'insured', 'signed', now(), 'typed:Bob Typed', 'portal', NULL, NULL, now());
INSERT INTO public.check_audit_log (check_id, event_type, event_data, created_at)
  SELECT '${ID(1)}', 'endorsement_signed', '{"signer": "${SECRET_NAME}", "amount": 5542}', now() - (n || ' minutes')::interval FROM generate_series(1, 25) n;
INSERT INTO public.check_audit_log (check_id, event_type, event_data) VALUES
  ('${ID(1)}', 'endorsement_signatures_composited', '{"original_back_image_path": "${SECRET_PATH}.jpg", "endorsed_back_image_path": "${SECRET_PATH}_endorsed.svg"}');
INSERT INTO public.checkalt_deposits (tenant_id, check_intake_item_id, checkalt_reference, status, last_status_payload, idempotency_key) VALUES
  ('${ID(2)}', '${ID(1)}', NULL, 'failed', '{"provider_http_attempted": false}', 'k1');
`;
const SNAPSHOT = `SELECT
  (SELECT pg_catalog.md5(pg_catalog.string_agg(t::text, ',' ORDER BY t::text)) FROM public.check_intake_items t) AS checks,
  (SELECT pg_catalog.md5(pg_catalog.string_agg(t::text, ',' ORDER BY t::text)) FROM public.check_endorsements t) AS endorsements,
  (SELECT pg_catalog.md5(pg_catalog.string_agg(t::text, ',' ORDER BY t::text)) FROM public.check_payees t) AS payees,
  (SELECT pg_catalog.md5(pg_catalog.string_agg(t::text, ',' ORDER BY t::text)) FROM public.check_audit_log t) AS audit,
  (SELECT pg_catalog.md5(pg_catalog.string_agg(t::text, ',' ORDER BY t::text)) FROM public.checkalt_deposits t) AS deposits,
  (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public') AS relations`;

test('PostgreSQL 16: the inspect is read-only, runs every statement and prints no row values', {
  timeout: 180000, skip: pgSkipReason() || false,
}, async (t) => {
  let pg;
  try {
    pg = (await import('pg')).default;
  } catch {
    t.skip('pg module is not installed');
    return;
  }
  const server = startPg('pg-check-endorsement-state-', 62300);
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
        // The signature columns come back reduced to a class, never as the value.
        for (const row of result.rows || []) {
          for (const key of ['signature_image_url', 'endorsement_image_path']) {
            if (key in row) assert.ok([null, '', 'data:image/', 'other'].includes(row[key]), `${key}=${row[key]}`);
          }
        }
        return result;
      };
      return c;
    };
    const run = async (checkId) => {
      statements.length = 0;
      const before = (await su.query(SNAPSHOT)).rows[0];
      const { code, text } = await quiet(() => main(['--inspect', '--check-id', checkId], {}, { root: ROOT, connect }));
      assert.equal(code, 0, text);
      assert.deepEqual((await su.query(SNAPSHOT)).rows[0], before, 'nothing changed');
      for (const sql of statements) assert.ok(INSPECT_STATEMENTS.includes(sql), sql);
      assert.equal(statements[0], 'BEGIN READ ONLY');
      assert.equal(statements.at(-1), 'ROLLBACK');
      for (const leak of [...LEAKS, 'Bob Typed', 'Acme Mortgage', 'CK-SECRET-1', ID(1), ID(2)]) assert.ok(!text.includes(leak), `leaked ${leak}`);
      assert.doesNotMatch(text, UUID_ANY);
      return JSON.parse(text).details;
    };

    const report = await run(ID(1));
    assert.equal(report.transaction_read_only, true);
    assert.equal(report.current_user, 'checksops_admin');
    assert.equal(report.server_major_version, 16);
    assert.equal(report.check.status, 'needs_review');
    assert.equal(report.check.check_stage, 'endorsing');
    assert.equal(report.check.endorsement_render_status, 'failed');
    assert.deepEqual(report.images.back_image_path, { column_exists: true, present: true, clean_raster_original: false, endorsed_artifact: true, checkalt_artifact: false });
    assert.equal(report.images.back_image_original_path.present, false);
    assert.equal(report.images.endorsed_back_image_path.column_exists, false);
    assert.deepEqual(report.endorsements.rows.map((r) => [r.payee_type, r.status, r.has_usable_drawn_ink, r.is_exception_completion, r.blocks_composite]), [
      ['insured', 'signed', true, false, false],
      ['mortgage_company', 'manual_required', false, true, false],
      ['insured', 'signed', false, false, true],
    ]);
    assert.deepEqual([report.completion.rows, report.completion.allSigned, report.completion.anyRejected], [3, true, false]);
    assert.deepEqual(report.deposits, { read: true, count: 1, blocking: null });
    assert.equal(report.historical_deposit_locked, false);
    // The composite audit names a clean original in the anchor's directory: S3 decides between it and a sibling.
    assert.equal(report.recovery.determined, false);
    assert.deepEqual(report.recovery.if_every_object_present, { ok: true, error: null, source: 'check_audit_log' });
    assert.deepEqual(report.prediction.blockers, ['signature_image_missing']);
    assert.equal(report.prediction.predicted_blocker, 'signature_image_missing');
    assert.equal(report.recent_events.rows.length, 20);
    assert.equal(report.recent_events.rows[0].event_type, 'endorsement_signatures_composited');
    assert.equal(statements.length, INSPECT_STATEMENTS.length - 2, 'every statement but the two official-rear loaders ran once');

    // An unknown check: only the check row is read.
    const missing = await run(ID(99));
    assert.equal(missing.check_found, false);
    assert.equal(missing.prediction.predicted_blocker, 'check_not_found');
    assert.ok(!statements.some((sql) => [Q.completion, Q.endorsements, Q.events].includes(sql)));

    // A write inside the inspect's transaction is refused by PostgreSQL itself.
    const admin = await open('checksops_admin');
    try {
      await admin.query(Q.begin);
      await assert.rejects(admin.query("UPDATE public.check_intake_items SET status = 'approved_for_deposit'"), (e) => e.code === '25006');
      await admin.query(Q.rollback);
    } finally {
      await admin.end();
    }
  } finally {
    await su.end();
    server.stop();
  }
});
