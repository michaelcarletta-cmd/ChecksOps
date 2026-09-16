import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  evaluateEndorsementCompletion,
  runPublicEndorsement,
} from '../functions/api/check-endorsement.mjs';
import { endorsementAutoAdvanceEnabled } from '../functions/api/endorsement-parity.mjs';
import { syntheticCompliantCheckAltJpeg } from '../functions/api/providers/production/checkalt-image-compliance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const AWS_LOCK = path.join(ROOT, 'aws/migrations/20260916_endorsement_verified_staging_lock.sql');
const SUPABASE_LOCK = path.join(ROOT, 'supabase/migrations/20260916223000_drop_legacy_endorsement_auto_ready_trigger.sql');
const SQL40 = path.join(ROOT, 'aws/write-path/sql/40_endorsement_activation_grants.sql');
const TRIGGER = 'trg_advance_on_endorsement_complete';
const FN = 'advance_check_on_endorsement_complete';
const HLE = ['trg_hle_endorsement_insert', 'trg_hle_endorsement_update'];

const walkSql = (dir) => {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const full = path.join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...walkSql(full));
    else if (name.endsWith('.sql')) out.push(full);
  }
  return out.sort();
};

const stripComments = (sql) => sql
  .replace(/--[^\n]*/g, '\n')
  .replace(/\/\*[\s\S]*?\*\//g, '\n');

const triggerActions = (sql) => {
  const body = stripComments(sql);
  const actions = [];
  const re = /\b(CREATE|DROP)\s+TRIGGER(?:\s+IF\s+EXISTS)?\s+trg_advance_on_endorsement_complete\b/gi;
  let match;
  while ((match = re.exec(body))) {
    actions.push(match[1].toUpperCase());
  }
  return actions;
};

const TENANT = '11111111-1111-4111-8111-111111111111';
const CHECK_ID = '33333333-3333-4333-8333-333333333333';
const ENDORSE_A = '44444444-4444-4444-8444-444444444444';
const ENDORSE_B = '55555555-5555-4555-8555-555555555555';

const eventOf = (body = {}) => ({
  headers: {},
  body: JSON.stringify(body),
  requestContext: { http: { method: 'POST', path: '/public/endorsement' } },
});

const mockClient = (impl) => ({
  query: async (sql, params = []) => impl(String(sql), params || []),
  connect: async () => {},
  end: async () => {},
});

const sqlClient = (handlers, captured = []) => mockClient((sql, params) => {
  const compact = sql.replace(/\s+/g, ' ');
  captured.push({ sql: compact, params });
  if (/^BEGIN|COMMIT|ROLLBACK|SET TRANSACTION/i.test(compact.trim())) return { rows: [], rowCount: 0 };
  for (const handler of handlers) {
    if (handler.match(compact, params)) return handler.result(params, compact);
  }
  return { rows: [], rowCount: 0 };
});

const succeedingCompositeDeps = () => {
  const original = syntheticCompliantCheckAltJpeg({ seed: 41, quality: 78 });
  const files = new Map([[`checks/${CHECK_ID}/back-original.jpg`, original]]);
  return {
    downloadClaimFile: async (rel) => files.get(rel) || original,
    uploadClaimFile: async (rel, bytes) => {
      files.set(rel, Buffer.from(bytes));
      return { path: rel };
    },
    loadDeposits: async () => [],
  };
};

test('lock-in SQL represents verified staging in_person, grant, and trigger drop', () => {
  const sql = readFileSync(AWS_LOCK, 'utf8');
  assert.match(sql, /in_person/);
  assert.match(sql, /portal','sms','email','internal','manual','in_person/);
  assert.match(sql, /GRANT UPDATE \(endorsement_render_version\)/);
  assert.match(sql, /TO checksops, authenticated/);
  assert.match(sql, new RegExp(`DROP TRIGGER IF EXISTS ${TRIGGER} ON public.check_endorsements`));
  assert.match(sql, /intentionally preserved/);
  assert.doesNotMatch(sql, /DROP FUNCTION[\s\S]*advance_check_on_endorsement_complete/i);
  assert.doesNotMatch(sql, /trg_hle_endorsement_(insert|update)/);
  assert.doesNotMatch(sql, /GRANT UPDATE \(deposit_recommendation\)/);
  assert.doesNotMatch(sql, /aws_public_endorsement_by_token/);
  assert.doesNotMatch(sql, /front_image_deposit_path/);
  assert.doesNotMatch(sql, /40_endorsement_activation_grants/);
  assert.equal(triggerActions(sql).at(-1), 'DROP');
});

test('rebuild follow-on drops the legacy Ready trigger and keeps in_person', () => {
  const sql = readFileSync(SUPABASE_LOCK, 'utf8');
  assert.match(sql, new RegExp(`DROP TRIGGER IF EXISTS ${TRIGGER} ON public.check_endorsements`));
  assert.match(sql, /in_person/);
  assert.doesNotMatch(sql, /DROP FUNCTION[\s\S]*advance_check_on_endorsement_complete/i);
  assert.doesNotMatch(sql, /trg_hle_endorsement_(insert|update)/);
  assert.doesNotMatch(sql, /GRANT /);
  assert.equal(triggerActions(sql).at(-1), 'DROP');
});

test('repository migration state does not recreate the legacy Ready trigger', () => {
  const files = walkSql(ROOT);
  const actions = [];
  for (const file of files) {
    const rel = path.relative(ROOT, file);
    const sql = readFileSync(file, 'utf8');
    assert.doesNotMatch(stripComments(sql), new RegExp(`DROP\\s+FUNCTION[\\s\\S]{0,80}${FN}`, 'i'), rel);
    for (const action of triggerActions(sql)) {
      actions.push({ file: rel, action });
    }
  }
  assert.ok(actions.some((row) => row.action === 'CREATE'), 'historical CREATE should still exist');
  assert.equal(actions.at(-1)?.action, 'DROP');
  assert.ok(actions.at(-1).file.includes('20260916'), actions.at(-1)?.file);
  const awsCreates = actions.filter((row) => row.file.startsWith('aws/') && row.action === 'CREATE');
  assert.deepEqual(awsCreates, []);
  for (const file of files) {
    const rel = path.relative(ROOT, file);
    if (rel === path.relative(ROOT, AWS_LOCK) || rel === path.relative(ROOT, SUPABASE_LOCK)) continue;
    const sql = readFileSync(file, 'utf8');
    for (const name of HLE) {
      if (rel.includes('20260916')) {
        assert.doesNotMatch(stripComments(sql), new RegExp(`DROP\\s+TRIGGER[\\s\\S]{0,40}${name}`, 'i'));
      }
    }
  }
});

test('SQL 40 remains untouched and is not the render-version grant', () => {
  const sql = readFileSync(SQL40, 'utf8');
  assert.match(sql, /NOT APPLIED/i);
  assert.match(sql, /GRANT UPDATE \(deposit_recommendation\)/);
  assert.doesNotMatch(sql, /endorsement_render_version/);
  assert.doesNotMatch(sql, new RegExp(TRIGGER));
  assert.doesNotMatch(sql, /in_person/);
});

test('auto-advance defaults OFF and does not Ready after official rear', async () => {
  delete process.env.AWS_ENDORSEMENT_AUTO_ADVANCE;
  assert.equal(endorsementAutoAdvanceEnabled(), false);
  const done = evaluateEndorsementCompletion([
    { status: 'signed', payee_type: 'insured' },
    { status: 'signed', payee_type: 'insured' },
  ]);
  assert.equal(done.allSigned, true);
  assert.equal(done.depositAdvanceDenied, true);
  assert.equal(done.readyForDeposit, false);
  assert.equal(done.advance_check_on_endorsement_complete, 'denied');

  const check = {
    id: CHECK_ID,
    tenant_id: TENANT,
    status: 'endorsements_in_progress',
    deposit_recommendation: null,
    check_stage: 'endorsing',
    deposited_at: null,
    back_image_path: `checks/${CHECK_ID}/back-original.jpg`,
    back_image_original_path: `checks/${CHECK_ID}/back-original.jpg`,
    back_image_deposit_path: null,
  };
  const rows = [
    {
      id: ENDORSE_A, check_id: CHECK_ID, tenant_id: TENANT, payee_name: 'A',
      payee_type: 'insured', status: 'signed', token: null, contact_email: 'a@example.com',
    },
    {
      id: ENDORSE_B, check_id: CHECK_ID, tenant_id: TENANT, payee_name: 'B',
      payee_type: 'insured', status: 'sent', token: 'tok-b', contact_email: 'b@example.com',
    },
  ];
  const captured = [];
  const client = sqlClient([
    {
      match: (sql) => sql.includes('FROM public.check_endorsements WHERE token'),
      result: () => ({ rows: [rows[1]] }),
    },
    {
      match: (sql) => sql.includes("SET status = 'signed'"),
      result: () => {
        rows[1].status = 'signed';
        return { rows: [{ ...rows[1] }], rowCount: 1 };
      },
    },
    {
      match: (sql) => sql.includes('SELECT status, payee_type'),
      result: () => ({ rows: rows.map((row) => ({ status: row.status, payee_type: row.payee_type })) }),
    },
    {
      match: (sql) => sql.includes('FROM public.check_intake_items'),
      result: () => ({ rows: [check] }),
    },
    {
      match: (sql) => sql.includes("SET status = 'endorsements_in_progress'"),
      result: () => ({ rows: [], rowCount: 1 }),
    },
  ], captured);

  const submitted = await runPublicEndorsement(eventOf({
    action: 'submit_endorsement',
    token: 'tok-b',
    eSignConsentAccepted: true,
    signatureData: 'data:image/png;base64,bbb',
  }), { client, compositeDeps: succeedingCompositeDeps() });

  assert.equal(submitted.ok, true);
  assert.equal(submitted.allSigned, true);
  assert.equal(submitted.officialRearReady, true);
  assert.equal(submitted.readyForDeposit, false);
  assert.equal(submitted.approvedForDeposit, false);
  assert.equal(submitted.depositAdvanceDenied, true);
  assert.equal(submitted.advance_check_on_endorsement_complete, 'denied');
  assert.equal(check.status, 'endorsements_in_progress');
  assert.equal(captured.some((row) => row.sql.includes("SET status = 'approved_for_deposit'")), false);
  assert.equal(captured.some((row) => row.sql.includes("check_stage = 'ready_for_deposit'")), false);
  assert.equal(captured.some((row) => /moov_transfer|checkalt_deposits|fincapture/i.test(row.sql)), false);
});
