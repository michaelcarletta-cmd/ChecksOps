/**
 * SQL 124 (aws/workflows/sql/124_mortgage_desk_signature_and_reads.sql) in the staging guarded executor,
 * on the release engine shared with SQL 90-123 (scripts/deployment-guard/lib/release-sql-state.mjs).
 * release-sql90-97-executor.test.mjs runs what every release key shares (SQL 124 included); this
 * file covers what is new:
 *
 *   - the pin: staging-authorized from its read-live (wave 23), code-derived, selectable, packed, in step with the production pin; the
 *     pinned commit authored the bytes; no predecessor;
 *   - the file and spec: eight SECURITY DEFINER functions (search_path public), seven with EXECUTE
 *     for checksops and the owner, the internal readable-request check for the owner only; the two
 *     TABLE (...) results and the row-type result as PostgreSQL renders them; no table, column,
 *     policy, table grant or trigger; the tables each function writes; the prerequisites are the
 *     file's own; the definer-write and ACL pre-conditions refuse;
 *   - on PostgreSQL 16: refused while SQL 122's aws_mortgage_desk_working_request is missing; refused
 *     while the login cannot write signature_fields under RLS (FORCE ROW LEVEL SECURITY); a pending
 *     pin cannot apply; one apply through the executor reaches the intended fingerprint (the TABLE
 *     results as PostgreSQL renders them), then is refused as already in place.
 * The behavior (the assigned agent reads the check and sends its document for signature; everyone
 * else refused) is aws/tests/sql124-mortgage-desk-signature-pg.test.mjs.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import {
  AUTHORIZED_SQL124_MORTGAGE_DESK_SIGNATURE_AND_READS,
  AUTHORIZED_STAGING_SQL,
  RELEASE_2026_10_17_PENDING_SQL_PINS as PINS,
  authorizationFingerprint,
  resolveAuthorizedMigration,
} from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import {
  RELEASE_SQL_KEYS,
  RELEASE_SQL_SPECS,
  releaseFunctionDefinitions,
  releaseIntendedHash,
  releaseIntendedState,
  releaseSharedPostconditionFailures,
  releaseSharedPreconditionFailures,
  releaseSqlExecutableText,
  releaseStateHash,
  releaseStateText,
} from '../../scripts/deployment-guard/lib/release-sql-state.mjs';
import { EXECUTOR_PACK_MEMBERS } from '../../scripts/deployment-guard/sql-executor-ensure.mjs';
import { MIGRATIONS } from '../../scripts/deployment-guard/github-staging-sql-executor.mjs';
import { READ_LIVE_EXPECTED_SENTINEL } from '../../scripts/deployment-guard/lib/sql-executor-read-live.mjs';
import { importGuardedSqlExecutor } from './helpers/import-guarded-sql-executor.mjs';
import { assertStagingPinState, pendingPin } from './helpers/staging-sql-wave1.mjs';
import { pgSkipReason, releaseFixture, sql98To100Schema } from './helpers/release-sql-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-10-28T12:00:00.000Z';
const KEY = 'sql124';
const READABLE = 'public.aws_mortgage_desk_readable_request(uuid)';
const MESSAGES = 'public.aws_mortgage_desk_messages(uuid)';
const FILES_FN = 'public.aws_mortgage_desk_check_files(uuid)';
const SIGNATURES = 'public.aws_mortgage_desk_signature_requests(uuid)';
const CAN_READ = 'public.aws_mortgage_desk_can_read_path(text[], text)';
const CREATE = 'public.aws_mortgage_desk_create_signature_request(uuid, text, text, text, jsonb, jsonb, timestamp with time zone)';
const DELIVERY = 'public.aws_mortgage_desk_record_signature_delivery(uuid, uuid, jsonb)';
const TIMELINE = 'public.aws_mortgage_desk_post_timeline(uuid, text, text)';
const FNS = [READABLE, MESSAGES, FILES_FN, SIGNATURES, CAN_READ, CREATE, DELIVERY, TIMELINE];
const NAMES = FNS.map((identity) => identity.replace(/^public\.|\(.*$/g, ''));
const WRITES = ['public.check_messages', 'public.check_files', 'public.mortgage_handling_requests', 'public.homeowner_ledger_events',
  'public.signature_requests', 'public.signature_signers', 'public.signature_fields', 'public.esign_event_logs'];
const sha = (text) => createHash('sha256').update(text).digest('hex');
const TEXT = fs.readFileSync(path.join(ROOT, PINS[KEY].filename), 'utf8');
const SQL90_TEXT = fs.readFileSync(path.join(ROOT, 'aws/workflows/sql/90_users_only_tenant_roles.sql'), 'utf8');
const SQL122_TEXT = fs.readFileSync(path.join(ROOT, PINS.sql122.filename), 'utf8');
const FILES = Object.freeze(Object.fromEntries(RELEASE_SQL_KEYS.map((key) => [key, path.join(ROOT, PINS[key].filename)])));
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK|BEGIN READ ONLY)\b/i;
const productionPin = () => JSON.parse(fs.readFileSync(path.join(ROOT, RELEASE_SQL_SPECS[KEY].production_pin_rel), 'utf8'));

const { module: executorModule } = await importGuardedSqlExecutor();
const { createHandler } = executorModule;

function releaseEvent(overrides = {}) {
  const pin = overrides.pin || PINS[KEY];
  const rest = { ...overrides };
  delete rest.pin;
  const event = {
    action: 'apply',
    workstream_id: `staging-${RELEASE_SQL_SPECS[KEY].choice}`,
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
    one_use_id: `${KEY}-test-${process.pid}-${Math.random().toString(16).slice(2)}`,
    expiry: '2026-10-28T13:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    ...rest,
  };
  event.preflight_live_fingerprint = authorizationFingerprint(event);
  return event;
}
const inspectEvent = () => releaseEvent({ action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL });

function handlerFor(connect, { pins = {} } = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql124-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

/** The text from `start` through the end of the first `end` after it, exactly as the file has it. */
const sliceFrom = (text, start, end) => {
  const from = text.indexOf(start);
  const to = from < 0 ? -1 : text.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`${start} ... ${end} not found`);
  return text.slice(from, to + end.length);
};

// The columns SQL 122 and SQL 124 read or write beyond the release fixture and SQL 98-100's extra
// schema (check_files, homeowner_ledger_events, mortgage_handling_requests and the e-sign tables as
// the restored database has them), SQL 100's aws_is_mortgage_ops_agent() (a stand-in) and SQL 90's
// real aws_is_platform_owner_user(uuid). SQL 122 itself is applied only after the first inspect (the
// prerequisite refusal).
const DESK_SCHEMA = `
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS slug text;
ALTER TABLE public.check_intake_items ADD COLUMN IF NOT EXISTS check_number text;
ALTER TABLE public.check_files
  ADD COLUMN file_name text, ADD COLUMN file_type text, ADD COLUMN file_size bigint, ADD COLUMN category text NOT NULL DEFAULT 'other',
  ADD COLUMN source text NOT NULL DEFAULT 'manual', ADD COLUMN uploaded_by uuid, ADD COLUMN description text,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.homeowner_ledger_events
  ADD COLUMN check_id uuid, ADD COLUMN event_type text NOT NULL DEFAULT 'note', ADD COLUMN occurred_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN actor_label text, ADD COLUMN payload_json jsonb NOT NULL DEFAULT '{}'::jsonb, ADD COLUMN created_by uuid;
ALTER TABLE public.mortgage_handling_requests
  ADD COLUMN requested_by uuid, ADD COLUMN mail_to_name text, ADD COLUMN mail_to_address text, ADD COLUMN shipping_label_path text,
  ADD COLUMN shipping_label_name text, ADD COLUMN shipping_label_carrier text, ADD COLUMN shipping_label_tracking text,
  ADD COLUMN shipping_label_uploaded_at timestamptz, ADD COLUMN shipping_label_uploaded_by uuid,
  ADD COLUMN check_sent_date timestamptz, ADD COLUMN check_received_back_date timestamptz;
ALTER TABLE public.homeowner_ledger_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.signature_requests
  ADD COLUMN document_name text, ADD COLUMN document_path text, ADD COLUMN document_type text, ADD COLUMN field_data jsonb,
  ADD COLUMN status text NOT NULL DEFAULT 'draft', ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(), ADD COLUMN created_by uuid,
  ADD COLUMN sent_at timestamptz, ADD COLUMN final_pdf_path text, ADD COLUMN delivery_mode text, ADD COLUMN provider_status text,
  ADD COLUMN last_error text, ADD COLUMN last_attempted_at timestamptz;
CREATE TABLE public.signature_signers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), signature_request_id uuid NOT NULL REFERENCES public.signature_requests(id) ON DELETE CASCADE,
  signer_name text NOT NULL, signer_email text NOT NULL, signer_type text NOT NULL DEFAULT 'policyholder', signing_order integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'pending', signed_at timestamptz, viewed_at timestamptz, access_token text, token_hash text, expires_at timestamptz,
  delivery_status text, delivery_error text, email_sent_at timestamptz, email_provider_message_id text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.signature_fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), signature_request_id uuid NOT NULL REFERENCES public.signature_requests(id) ON DELETE CASCADE,
  signer_index integer NOT NULL DEFAULT 0, field_type text NOT NULL, label text, page integer NOT NULL DEFAULT 1, x numeric NOT NULL DEFAULT 0,
  y numeric NOT NULL DEFAULT 0, width numeric NOT NULL DEFAULT 33, height numeric NOT NULL DEFAULT 6, required boolean NOT NULL DEFAULT true,
  placeholder text, checkbox_label text);
CREATE TABLE public.esign_event_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz DEFAULT now(), request_id uuid, signer_id uuid, claim_id uuid,
  stage text NOT NULL, status text NOT NULL, message text, payload jsonb);
ALTER TABLE public.signature_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.signature_signers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.signature_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.esign_event_logs ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION public.aws_is_mortgage_ops_agent() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$ SELECT public.has_role(auth.uid(), 'mortgage_agent'::public.app_role) $$;
${sliceFrom(SQL90_TEXT, 'CREATE OR REPLACE FUNCTION public.aws_is_platform_owner_user(_user_id uuid)', '$$;')}`;

test('pin: SQL 124 staging-authorized from its read-live, code-derived, selectable, packed, in step with the production pin; no predecessor', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL124_MORTGAGE_DESK_SIGNATURE_AND_READS, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/124_mortgage_desk_signature_and_reads.sql');
  assert.equal(pin.migration_id, '124_mortgage_desk_signature_and_reads');
  assert.equal(spec.choice, 'sql124-mortgage-desk-signature-and-reads');
  assert.doesNotMatch(spec.choice, /production/);
  assert.equal(sha(TEXT), pin.source_sha256);
  // Staging apply authorized (owner approved 2026-10-28) from staging read-live run 40754712957: the
  // eight functions absent, so SQL 124 was not yet applied there.
  assertStagingPinState(assert, KEY, pin);
  assert.equal(pin.execute, true);
  assert.equal(pin.authorization, 'Owner approved 2026-10-28: staging apply (wave 23) from staging read-live run 40754712957');
  assert.equal(pin.expected_live_definition_sha256, '59fe6907e23de341e97d4aec548203d0cd7f7cf320b009e0e440d247d82a4db2');
  assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
  assert.equal(releaseIntendedHash(KEY, TEXT), pin.intended_replacement_sha256);
  // Everything absent (a database without SQL 124) has a fingerprint of its own.
  assert.notEqual(releaseStateHash(KEY, {}), pin.intended_replacement_sha256);
  assert.equal(pin.superseded_intended_sha256, undefined);
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql124-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], FNS);
  assert.deepEqual([...pin.function_identities], spec.functions.map((fn) => fn.identity));
  assert.deepEqual(spec.predecessors, []);
  assert.equal(spec.runs_before, undefined);
  assert.equal(spec.supersedes, undefined);
  assert.equal(spec.refuse_after, undefined);
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes(KEY)
    || (RELEASE_SQL_SPECS[key].refuse_after || []).some((m) => m.key === KEY)
    || (RELEASE_SQL_SPECS[key].predecessors || []).includes(KEY)), []);
  const prod = productionPin();
  assert.equal(prod.intended_replacement_sha256, pin.intended_replacement_sha256);
  assert.equal(prod.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(prod.staging_pin_commit, pin.commit);
  assert.equal(prod.source_sha256, pin.source_sha256);
  assert.deepEqual(prod.predecessors, []);
  // Production pin execute-authorized (owner-approved pin change of 2026-10-28) on the staging apply. Its
  // pre-state is production's own (read-only inspect SSM a139e8f8), the same as staging's.
  assert.equal(prod.execute, true);
  assert.match(prod.authorization, /^Owner approved 2026-10-28 /);
  assert.equal(prod.expected_live_definition_sha256, '59fe6907e23de341e97d4aec548203d0cd7f7cf320b009e0e440d247d82a4db2');
  assert.equal(prod.expected_live_definition_sha256, pin.expected_live_definition_sha256);
  assert.notEqual(prod.expected_live_definition_sha256, prod.intended_replacement_sha256);
  let bytes = null;
  if (/^[0-9a-f]{40}$/.test(pin.commit)) {
    try {
      bytes = execFileSync('git', ['-C', ROOT, 'show', `${pin.commit}:${pin.filename}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      bytes = null;
    }
  }
  if (bytes !== null) assert.equal(sha(bytes), pin.source_sha256, 'the pinned commit carries the pinned bytes');
});

test('reviewed file and spec: eight definer functions (seven for checksops, one owner-only), the TABLE and row-type results; no table, column, policy, grant or trigger; the file\'s prerequisites; pre- and post-conditions', () => {
  assert.equal(releaseSqlExecutableText(KEY, TEXT), TEXT);
  const defs = releaseFunctionDefinitions(TEXT);
  assert.deepEqual(Object.keys(defs), NAMES);
  const stable = ['aws_mortgage_desk_readable_request', 'aws_mortgage_desk_messages', 'aws_mortgage_desk_check_files',
    'aws_mortgage_desk_signature_requests', 'aws_mortgage_desk_can_read_path'];
  for (const [name, fn] of Object.entries(defs)) {
    assert.equal(fn.security_definer, true, name);
    assert.equal(fn.language, name === 'aws_mortgage_desk_can_read_path' ? 'sql' : 'plpgsql', name);
    assert.equal(fn.volatility, stable.includes(name) ? 's' : 'v', name);
    assert.equal(fn.parallel, 'u', name);
    assert.deepEqual(fn.config, ['search_path=public'], name);
    // No row_security setting: the e-sign and ledger triggers keep running as they do today.
    assert.doesNotMatch(fn.prosrc, /row_security/i, name);
  }
  // The reads go through the readable-request check; the writes through SQL 122's working-request check.
  for (const name of ['aws_mortgage_desk_messages', 'aws_mortgage_desk_check_files', 'aws_mortgage_desk_signature_requests']) {
    assert.match(defs[name].prosrc, /v_req := public\.aws_mortgage_desk_readable_request\(_request_id\);/, name);
  }
  for (const name of ['aws_mortgage_desk_create_signature_request', 'aws_mortgage_desk_post_timeline']) {
    assert.match(defs[name].prosrc, /v_req := public\.aws_mortgage_desk_working_request\(_request_id, ARRAY\['in_progress'\]\);/, name);
  }
  assert.match(defs.aws_mortgage_desk_record_signature_delivery.prosrc,
    /v_req := public\.aws_mortgage_desk_working_request\(_request_id, ARRAY\['in_progress', 'completed'\]\);/);
  const readable = defs.aws_mortgage_desk_readable_request.prosrc;
  assert.match(readable, /FROM public\.mortgage_handling_requests WHERE id = _request_id;/);
  assert.doesNotMatch(readable, /FOR UPDATE/);
  assert.match(readable, /v_req\.assigned_employee_id IS DISTINCT FROM v_uid\s+OR NOT COALESCE\(public\.aws_is_mortgage_ops_agent\(\), false\)/);
  assert.match(readable, /NOT COALESCE\(public\.is_platform_owner\(\), false\)/);
  assert.match(readable, /v_req\.status NOT IN \('in_progress', 'completed'\)/);
  // The storage check uses the same caller rule and the same statuses.
  const canRead = defs.aws_mortgage_desk_can_read_path.prosrc;
  assert.match(canRead, /r\.status IN \('in_progress', 'completed'\)/);
  assert.match(canRead, /r\.assigned_employee_id = auth\.uid\(\)\s+AND COALESCE\(public\.aws_is_mortgage_ops_agent\(\), false\)/);
  assert.match(canRead, /'checks\/' \|\| r\.check_intake_item_id::text \|\| '\/mortgage-ops\/'/);
  // The tables each function writes.
  const writes = (body) => [...new Set([...body.matchAll(/\b(?:UPDATE|INSERT INTO|DELETE FROM)\s+(public\.[a-z_]+)/g)].map((m) => m[1]))];
  for (const name of stable) assert.deepEqual(writes(defs[name].prosrc), [], name);
  assert.deepEqual(writes(defs.aws_mortgage_desk_create_signature_request.prosrc),
    ['public.signature_requests', 'public.signature_signers', 'public.signature_fields', 'public.check_files', 'public.esign_event_logs']);
  assert.deepEqual(writes(defs.aws_mortgage_desk_record_signature_delivery.prosrc),
    ['public.signature_signers', 'public.signature_requests', 'public.esign_event_logs']);
  assert.deepEqual(writes(defs.aws_mortgage_desk_post_timeline.prosrc), ['public.homeowner_ledger_events']);
  // Tokens: the reads never return them; the create stores the hash esign.mjs computes and returns none.
  assert.doesNotMatch(defs.aws_mortgage_desk_signature_requests.prosrc, /access_token|token_hash|expires_at/);
  const create = defs.aws_mortgage_desk_create_signature_request.prosrc;
  assert.match(create, /encode\(sha256\(convert_to\(v_tokens\[v_i\], 'UTF8'\)\), 'hex'\)/);
  assert.match(create, /jsonb_build_object\(\s*'id', s\.id, 'signer_name', s\.signer_name, 'signer_email', s\.signer_email\)/);
  assert.match(create, /RETURN jsonb_build_object\('signature_request_id', v_sig_id, 'signers', v_out_signers\);/);
  // The timeline row never carries mortgage_request_id (SQL 122's completion row keys on it).
  assert.doesNotMatch(defs.aws_mortgage_desk_post_timeline.prosrc, /mortgage_request_id/);

  const spec = RELEASE_SQL_SPECS[KEY];
  const forChecksops = ['checksops EXECUTE', 'owner EXECUTE'];
  // The TABLE (...) results: the file's column list, with timestamptz as PostgreSQL prints it.
  const tableResult = (name) => {
    const header = new RegExp(`FUNCTION public\\.${name}\\([^)]*\\)\\s*RETURNS TABLE \\(([^)]*)\\)`).exec(TEXT);
    assert.ok(header, name);
    return `TABLE(${header[1].split(',').map((c) => c.trim().replace(/\s+/g, ' ').replace(/ timestamptz$/, ' timestamp with time zone')).join(', ')})`;
  };
  assert.deepEqual(spec.functions, [
    { identity: READABLE, acl: ['owner EXECUTE'], result: `public.${defs.aws_mortgage_desk_readable_request.result}` },
    { identity: MESSAGES, acl: forChecksops, result: tableResult('aws_mortgage_desk_messages') },
    { identity: FILES_FN, acl: forChecksops, result: tableResult('aws_mortgage_desk_check_files') },
    { identity: SIGNATURES, acl: forChecksops },
    { identity: CAN_READ, acl: forChecksops },
    { identity: CREATE, acl: forChecksops },
    { identity: DELIVERY, acl: forChecksops },
    { identity: TIMELINE, acl: forChecksops },
  ]);
  assert.equal(spec.functions[0].result, 'public.mortgage_handling_requests');
  assert.equal(defs.aws_mortgage_desk_messages.result, 'table');
  assert.equal(defs.aws_mortgage_desk_check_files.result, 'table');
  assert.equal(defs.aws_mortgage_desk_signature_requests.result, 'jsonb');
  assert.equal(defs.aws_mortgage_desk_can_read_path.result, 'boolean');
  assert.equal(defs.aws_mortgage_desk_create_signature_request.result, 'jsonb');
  assert.equal(defs.aws_mortgage_desk_record_signature_delivery.result, 'jsonb');
  assert.equal(defs.aws_mortgage_desk_post_timeline.result, 'uuid');
  // The file's ACL statements: PUBLIC revoked from all eight, checksops granted on seven only.
  const code = TEXT.replace(/--[^\n]*/g, '');
  for (const identity of FNS) {
    const sig = identity.replace(/^public\./, '').replace('timestamp with time zone', 'timestamptz').replace(/[()[\]]/g, (c) => `\\${c}`);
    assert.match(code, new RegExp(`REVOKE ALL ON FUNCTION public\\.${sig} FROM PUBLIC;`), identity);
  }
  const grants = [...code.matchAll(/\bGRANT\s+EXECUTE ON FUNCTION public\.([a-z_]+)\([^)]*\) TO checksops;/g)].map((m) => m[1]);
  assert.deepEqual(grants, NAMES.slice(1));
  assert.equal([...code.matchAll(/\bGRANT\b/g)].length, 7);
  for (const forbidden of [/\bCREATE\s+(TABLE|POLICY|VIEW|INDEX|TRIGGER)\b/i, /\bDROP\b/i, /\bTRUNCATE\b/i, /\bALTER\s+TABLE\b/i,
    /\bauthenticated\b/i, /\banon\b/i, /\bDELETE\s+FROM\b/i, /\bALTER\s+FUNCTION\b/i]) {
    assert.doesNotMatch(code, forbidden, String(forbidden));
  }
  assert.deepEqual(spec.definer_writes, WRITES);
  // Every object and column the file's own prerequisite block names is a spec prerequisite, and no more.
  const prereqBlock = TEXT.slice(TEXT.indexOf('DO $sql124_prereq$'), TEXT.indexOf('$sql124_prereq$;'));
  const fileObjects = [...prereqBlock.matchAll(/\('([^']+)', (?:to_reg|\(SELECT)/g)].map((m) => m[1].replace(/ \(SQL \d+\)$/, ''));
  const fileColumns = [...prereqBlock.matchAll(/\('([a-z_]+)', '([a-z_]+)'\)/g)].map((m) => `column public.${m[1]}.${m[2]}`);
  assert.equal(fileObjects.length, 18);
  assert.ok(fileColumns.length > 80);
  assert.deepEqual(spec.prerequisites, [...fileObjects, ...fileColumns]);
  // The file's own ownership rule names exactly the definer_writes tables.
  const owned = sliceFrom(prereqBlock, 'WHERE t.oid IN (', ')\n');
  assert.deepEqual([...owned.matchAll(/'(public\.[a-z_]+)'::regclass/g)].map((m) => m[1]), WRITES);
  for (const absent of ['tables', 'policies', 'column_acl', 'indexes', 'unique_covers', 'dropped_functions', 'whole_tables', 'counts',
    'triggers', 'table_privileges', 'acl_functions', 'render', 'production_noop', 'added_columns', 'altered_relations']) {
    assert.equal(spec[absent], undefined, absent);
  }

  const text = releaseStateText(KEY, releaseIntendedState(KEY, TEXT));
  assert.match(text, /^release sql124 v1\n/);
  assert.match(text, /\nfunction public\.aws_mortgage_desk_readable_request\(uuid\): lang=plpgsql vol=s parallel=u secdef=true result=public\.mortgage_handling_requests config=search_path=public prosrc=[0-9a-f]{64} acl=owner EXECUTE\n/);
  assert.match(text, /\nfunction public\.aws_mortgage_desk_messages\(uuid\): lang=plpgsql vol=s parallel=u secdef=true result=TABLE\(id uuid, sender_id uuid, body text, created_at timestamp with time zone, from_desk boolean\) config=search_path=public prosrc=[0-9a-f]{64} acl=checksops EXECUTE;owner EXECUTE\n/);
  assert.match(text, /\nfunction public\.aws_mortgage_desk_can_read_path\(text\[\], text\): lang=sql vol=s parallel=u secdef=true result=boolean config=search_path=public prosrc=[0-9a-f]{64} acl=checksops EXECUTE;owner EXECUTE\n/);
  assert.match(text, /\nfunction public\.aws_mortgage_desk_post_timeline\(uuid, text, text\): lang=plpgsql vol=v parallel=u secdef=true result=uuid config=search_path=public prosrc=[0-9a-f]{64} acl=checksops EXECUTE;owner EXECUTE$/);

  // Pre-conditions: definer writes, an existing function ACL the file would not fix, its owner, its result.
  const want = releaseIntendedState(KEY, TEXT);
  const base = {
    prerequisites_missing: [], predecessors_applied: true, successors_applied: [], dropped_function_callers: [],
    definer: Object.fromEntries(WRITES.map((t) => [t, true])),
    functions: {},
  };
  const pre = (over = {}) => releaseSharedPreconditionFailures(KEY, { ...base, ...over }, TEXT);
  assert.deepEqual(pre(), []);
  assert.deepEqual(pre({ prerequisites_missing: ['public.aws_mortgage_desk_working_request(uuid, text[])'] }), ['prerequisites_present']);
  assert.deepEqual(pre({ definer: { ...base.definer, 'public.signature_fields': false } }), ['definer_can_write_relations']);
  assert.deepEqual(pre({ definer: { ...base.definer, 'public.check_messages': false } }), ['definer_can_write_relations']);
  const live = (identity, over = {}) => ({ ...want.functions[identity], owner_is_login: true, ...over });
  assert.deepEqual(pre({ functions: { [CREATE]: live(CREATE, { acl: ['PUBLIC EXECUTE', 'checksops EXECUTE', 'owner EXECUTE'] }) } }), []);
  assert.deepEqual(pre({ functions: { [CREATE]: live(CREATE, { acl: ['authenticated EXECUTE', 'owner EXECUTE'] }) } }), ['function_acl_replaceable']);
  assert.deepEqual(pre({ functions: { [READABLE]: live(READABLE, { acl: ['checksops EXECUTE', 'owner EXECUTE'] }) } }), ['function_acl_replaceable']);
  assert.deepEqual(pre({ functions: { [MESSAGES]: live(MESSAGES, { owner_is_login: false }) } }), ['functions_owned_by_login']);
  assert.deepEqual(pre({ functions: { [FILES_FN]: live(FILES_FN, { result: 'SETOF record' }) } }), ['function_results_match']);
  // Post-conditions: the intended fingerprint with every function owned by the login.
  const after = (over = {}) => ({
    live_definition_sha256: PINS[KEY].intended_replacement_sha256,
    functions: Object.fromEntries(FNS.map((identity) => [identity, { exists: true, owner_is_login: true }])),
    ...over,
  });
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, {}, after(), PINS[KEY]), []);
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, {}, after({ live_definition_sha256: 'f'.repeat(64) }), PINS[KEY]), ['intended_state']);
});

test('PostgreSQL 16: SQL 124 through the executor: refused without SQL 122\'s working-request check and while signature_fields forces RLS, a pending pin cannot apply, one apply on the intended fingerprint, then already in place', { timeout: 600000 }, async (t) => {
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
  const fx = await releaseFixture(pg, 'pg-sql124-exec-', 59630, { extra: [...sql98To100Schema(), DESK_SCHEMA] });
  const { connectAs } = fx;
  try {
    const seen = [];
    const connect = async () => {
      const client = await connectAs('checksops_admin');
      const query = client.query.bind(client);
      client.query = (sql, params) => { seen.push(String(sql)); return query(sql, params); };
      return client;
    };
    const inspect = async () => {
      seen.length = 0;
      const result = await handlerFor(connect)(inspectEvent());
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(seen[0], 'BEGIN READ ONLY');
      assert.ok(seen.every((text) => READ_ONLY_STATEMENT_RE.test(text)), JSON.stringify(seen.filter((text) => !READ_ONLY_STATEMENT_RE.test(text))));
      return result.details.receipt;
    };
    const apply = async (live) => {
      const pin = Object.freeze({ ...PINS[KEY], expected_live_definition_sha256: live, execute: true, authorization: 'Owner approved test fixture' });
      return handlerFor(connect, { pins: { [KEY]: pin } })(releaseEvent({ pin }));
    };
    const owner = async (sql) => {
      const client = await connectAs('checksops_admin');
      try {
        return await client.query(sql);
      } finally {
        await client.end();
      }
    };
    const fnCount = async () => (await fx.admin.query(
      'SELECT count(*)::int AS n FROM pg_catalog.pg_proc WHERE pronamespace = \'public\'::regnamespace AND proname = ANY($1::text[])', [NAMES],
    )).rows[0].n;

    const early = await inspect();
    assert.deepEqual(early.release_sql_inspect.prerequisites_missing, ['public.aws_mortgage_desk_working_request(uuid, text[])']);
    assert.ok(early.precondition_failures.includes('prerequisites_present'));
    assert.equal((await apply(early.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
    assert.equal(await fnCount(), 0);
    // SQL 122 (the real file), applied by the owning login as in staging and production.
    await owner(SQL122_TEXT);

    // signature_fields with FORCE ROW LEVEL SECURITY: the definer could not write it; refused, nothing applied.
    await owner('ALTER TABLE public.signature_fields FORCE ROW LEVEL SECURITY');
    const forced = await inspect();
    assert.deepEqual(forced.precondition_failures, ['definer_can_write_relations'], JSON.stringify(forced.release_sql_inspect));
    assert.deepEqual(forced.release_sql_inspect.definer_writes.filter((row) => !row.ok).map((row) => row.name), ['signature_fields']);
    assert.equal((await apply(forced.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
    assert.equal(await fnCount(), 0);
    await owner('ALTER TABLE public.signature_fields NO FORCE ROW LEVEL SECURITY');

    const r = await inspect();
    assert.deepEqual(r.precondition_failures, [], JSON.stringify(r.release_sql_inspect));
    assert.equal(r.already_applied, false);
    assert.notEqual(r.live_definition_sha256, PINS[KEY].intended_replacement_sha256);
    assert.deepEqual(r.release_sql_inspect.definer_writes, WRITES.map((table) => ({ name: table.replace(/^public\./, ''), ok: true })));
    // A pending pin cannot apply (the committed pin is staging-authorized, so pend a copy).
    const pendingCopy = pendingPin(PINS[KEY]);
    const pending = await handlerFor(connect, { pins: { [KEY]: pendingCopy } })(releaseEvent({ pin: pendingCopy, expected_live_definition_sha256: r.live_definition_sha256 }));
    assert.equal(pending.ok, false);
    assert.equal(await fnCount(), 0);

    const applied = await apply(r.live_definition_sha256);
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.before_hash, r.live_definition_sha256);
    assert.equal(applied.details.receipt.after_hash, PINS[KEY].intended_replacement_sha256);
    const after = await inspect();
    assert.equal(after.already_applied, true);
    assert.equal(after.live_definition_sha256, PINS[KEY].intended_replacement_sha256);
    assert.deepEqual(after.precondition_failures, []);
    // The results PostgreSQL renders are the ones the spec states.
    const rendered = (await fx.admin.query(`SELECT p.proname, pg_catalog.pg_get_function_result(p.oid) AS result
      FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY($1::text[])`, [NAMES])).rows;
    for (const fn of RELEASE_SQL_SPECS[KEY].functions.filter((f) => f.result)) {
      const name = fn.identity.replace(/^public\.|\(.*$/g, '');
      assert.equal(rendered.find((row) => row.proname === name).result, fn.result.replace(/^public\./, ''), name);
    }
    const acl = (await fx.admin.query(`SELECT p.proname, pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef,
        has_function_privilege('checksops', p.oid, 'EXECUTE') AS checksops, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated
      FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY($1::text[]) ORDER BY 1`, [NAMES])).rows;
    assert.deepEqual(acl.map((row) => [row.proname, row.owner, row.prosecdef, row.checksops, row.authenticated]), [
      ['aws_mortgage_desk_can_read_path', 'checksops_admin', true, true, false],
      ['aws_mortgage_desk_check_files', 'checksops_admin', true, true, false],
      ['aws_mortgage_desk_create_signature_request', 'checksops_admin', true, true, false],
      ['aws_mortgage_desk_messages', 'checksops_admin', true, true, false],
      ['aws_mortgage_desk_post_timeline', 'checksops_admin', true, true, false],
      ['aws_mortgage_desk_readable_request', 'checksops_admin', true, false, false],
      ['aws_mortgage_desk_record_signature_delivery', 'checksops_admin', true, true, false],
      ['aws_mortgage_desk_signature_requests', 'checksops_admin', true, true, false],
    ]);
    assert.equal((await apply(r.live_definition_sha256)).code, CODES.UNRELATED_MUTATION);
  } finally {
    await fx.close();
  }
});
