/**
 * SQL 127 (aws/workflows/sql/127_homeowner_portal_signing.sql) in the staging guarded executor,
 * on the release engine shared with SQL 90-126 (scripts/deployment-guard/lib/release-sql-state.mjs).
 * release-sql90-97-executor.test.mjs runs what every release key shares (SQL 127 included); this
 * file covers what is new:
 *
 *   - the pin: pending, code-derived, selectable, packed, in step with the production pin; the
 *     pinned commit authored the bytes; no predecessor (SQL 83 is on the homeowner engine);
 *   - the file and spec: SQL 83's endorse capability and pending_signatures replaced (each body SQL
 *     83's with only SQL 127's edits) and the new document_portal_signer; all three SECURITY
 *     DEFINER, search_path public, row_security off, jsonb; EXECUTE for checksops and the owner
 *     (PUBLIC and authenticated revoked); no table, column, view, policy, table grant or trigger;
 *     the two tables the functions write; the SQL 82 / SQL 83 prerequisites; the ownership,
 *     result, ACL and definer-write pre-conditions refuse;
 *   - on PostgreSQL 16: refused while SQL 82 / SQL 83 are missing; with the real SQL 82 and SQL 83
 *     applied the inspect reports the SQL 83 state (derived here from SQL 83's bytes); refused
 *     while check_endorsements forces RLS, a function is owned by another role or granted to a
 *     role the file does not revoke; a pending pin cannot apply; one apply through the executor
 *     reaches the intended fingerprint, then is refused as already in place.
 * The behavior (who can sign what from the claim portal) is
 * aws/tests/sql127-homeowner-portal-signing-pg.test.mjs.
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
  AUTHORIZED_SQL127_HOMEOWNER_PORTAL_SIGNING,
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
  releaseUnrelatedScope,
} from '../../scripts/deployment-guard/lib/release-sql-state.mjs';
import { EXECUTOR_PACK_MEMBERS } from '../../scripts/deployment-guard/sql-executor-ensure.mjs';
import { MIGRATIONS } from '../../scripts/deployment-guard/github-staging-sql-executor.mjs';
import { READ_LIVE_EXPECTED_SENTINEL } from '../../scripts/deployment-guard/lib/sql-executor-read-live.mjs';
import { importGuardedSqlExecutor } from './helpers/import-guarded-sql-executor.mjs';
import { assertStagingPinState } from './helpers/staging-sql-wave1.mjs';
import { pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-10-29T12:00:00.000Z';
const KEY = 'sql127';
const ENDORSE = 'public.aws_public_homeowner_ledger_endorse_capability(text, uuid)';
const PENDING = 'public.aws_public_homeowner_pending_signatures(text)';
const PORTAL = 'public.aws_public_homeowner_document_portal_signer(text, uuid)';
const FNS = [ENDORSE, PENDING, PORTAL];
const NAMES = FNS.map((identity) => identity.replace(/^public\.|\(.*$/g, ''));
const REPLACED = [ENDORSE, PENDING];
const KEPT_SQL83 = 'public.aws_public_homeowner_document_sign_capability(text, uuid)';
const SQL82_FN = 'public.aws_public_homeowner_ledger_by_token(text)';
const WRITES = ['public.check_endorsements', 'public.signature_signers'];
const FOR_CHECKSOPS = Object.freeze(['checksops EXECUTE', 'owner EXECUTE']);
const REVOKES = Object.freeze(['PUBLIC EXECUTE', 'authenticated EXECUTE']);
const sha = (text) => createHash('sha256').update(text).digest('hex');
const TEXT = fs.readFileSync(path.join(ROOT, PINS[KEY].filename), 'utf8');
const SQL82_TEXT = fs.readFileSync(path.join(ROOT, 'aws/workflows/sql/82_homeowner_ledger_view.sql'), 'utf8');
const SQL83_TEXT = fs.readFileSync(path.join(ROOT, 'aws/workflows/sql/83_homeowner_signing_capabilities.sql'), 'utf8');
const FILES = Object.freeze(Object.fromEntries(RELEASE_SQL_KEYS.map((key) => [key, path.join(ROOT, PINS[key].filename)])));
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK|BEGIN READ ONLY)\b/i;
const productionPin = () => JSON.parse(fs.readFileSync(path.join(ROOT, RELEASE_SQL_SPECS[KEY].production_pin_rel), 'utf8'));

/**
 * The state the inspect reads where SQL 83 is applied (staging and production): the two replaced
 * functions as SQL 83 defines them (body and attributes from SQL 83's bytes, EXECUTE for checksops
 * and the owner after SQL 83's REVOKE / GRANT), the portal signer absent. Derived from bytes.
 */
const sql83State = () => {
  const defs = releaseFunctionDefinitions(SQL83_TEXT);
  const fn = (identity) => {
    const def = defs[identity.replace(/^public\.|\(.*$/g, '')];
    return [identity, {
      exists: true, language: def.language, volatility: def.volatility, parallel: def.parallel, security_definer: def.security_definer,
      result: def.result, config: [...def.config], prosrc_sha256: sha(def.prosrc), acl: [...FOR_CHECKSOPS],
    }];
  };
  return { functions: Object.fromEntries(REPLACED.map(fn)) };
};

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
    expiry: '2026-10-29T13:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    ...rest,
  };
  event.preflight_live_fingerprint = authorizationFingerprint(event);
  return event;
}
const inspectEvent = () => releaseEvent({ action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL });

function handlerFor(connect, { pins = {} } = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql127-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

// The columns SQL 82 and SQL 83 read beyond the release fixture (claims, check_intake_items,
// homeowner_ledger_tokens, homeowner_ledger_events and signature_requests as the restored database
// has them), check_endorsements, signature_signers and the disbursement tables SQL 82 reads.
// SQL 82 and SQL 83 themselves are applied only after the first inspect (the prerequisite refusal).
const HOMEOWNER_SCHEMA = `
ALTER TABLE public.claims ADD COLUMN claim_number text, ADD COLUMN policyholder_address text, ADD COLUMN loss_type text,
  ADD COLUMN status text, ADD COLUMN created_at timestamptz;
ALTER TABLE public.check_intake_items ADD COLUMN amount numeric, ADD COLUMN check_stage text, ADD COLUMN check_number text;
ALTER TABLE public.homeowner_ledger_tokens ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.homeowner_ledger_events ADD COLUMN check_id uuid, ADD COLUMN event_type text,
  ADD COLUMN occurred_at timestamptz NOT NULL DEFAULT now(), ADD COLUMN amount numeric, ADD COLUMN actor_label text, ADD COLUMN payload_json jsonb;
CREATE TABLE public.homeowner_ledger_check_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), token_id uuid, tenant_id uuid, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.check_endorsements (
  id uuid PRIMARY KEY, check_id uuid NOT NULL, tenant_id uuid, payee_name text, payee_type text, status text, token text,
  contact_email text, signed_at timestamptz, request_sent_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.disbursement_batches (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, check_intake_item_id uuid);
CREATE TABLE public.disbursement_splits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), batch_id uuid NOT NULL, tenant_id uuid NOT NULL, amount numeric, status text);
CREATE TABLE public.claim_disbursements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), claim_id uuid NOT NULL, check_id uuid, amount numeric, status text);
ALTER TABLE public.signature_requests ADD COLUMN document_name text, ADD COLUMN document_path text, ADD COLUMN status text NOT NULL DEFAULT 'pending',
  ADD COLUMN sent_at timestamptz, ADD COLUMN completed_at timestamptz, ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE public.signature_signers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), signature_request_id uuid NOT NULL, signer_name text NOT NULL, signer_email text NOT NULL,
  signer_type text NOT NULL, signing_order integer NOT NULL DEFAULT 1, status text NOT NULL DEFAULT 'pending', signed_at timestamptz,
  access_token text, token_hash text, expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.check_endorsements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.signature_signers ENABLE ROW LEVEL SECURITY;
`;

test('pin: SQL 127 pending, code-derived, selectable, packed, in step with the production pin; no predecessor', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL127_HOMEOWNER_PORTAL_SIGNING, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/127_homeowner_portal_signing.sql');
  assert.equal(pin.migration_id, '127_homeowner_portal_signing');
  assert.equal(spec.choice, 'sql127-homeowner-portal-signing');
  assert.doesNotMatch(spec.choice, /production/);
  assert.equal(sha(TEXT), pin.source_sha256);
  // Pending: no staging read-live recorded yet (and no apply authorized).
  assertStagingPinState(assert, KEY, pin);
  assert.equal(pin.execute, false);
  assert.equal(pin.authorization, 'pending');
  assert.equal(pin.expected_live_definition_sha256, null);
  assert.equal(releaseIntendedHash(KEY, TEXT), pin.intended_replacement_sha256);
  // Everything absent, and the SQL 83 state, each have a fingerprint of their own.
  assert.notEqual(releaseStateHash(KEY, {}), pin.intended_replacement_sha256);
  assert.notEqual(releaseStateHash(KEY, sql83State()), pin.intended_replacement_sha256);
  // The runbook names that SQL 83 pre-state (derived here) and the intended fingerprint.
  const runbook = fs.readFileSync(path.join(ROOT, 'ops/production-sql-127-apply.md'), 'utf8');
  assert.ok(runbook.includes(releaseStateHash(KEY, sql83State())));
  assert.ok(runbook.includes(pin.intended_replacement_sha256));
  assert.equal(pin.superseded_intended_sha256, undefined);
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql127-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], FNS);
  assert.deepEqual([...pin.function_identities], spec.functions.map((fn) => fn.identity));
  assert.deepEqual(spec.predecessors, []);
  assert.equal(spec.runs_before, undefined);
  assert.equal(spec.supersedes, undefined);
  assert.equal(spec.refuse_after, undefined);
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes(KEY)
    || (RELEASE_SQL_SPECS[key].refuse_after || []).some((m) => m.key === KEY)
    || (RELEASE_SQL_SPECS[key].predecessors || []).includes(KEY)), []);
  // No other release migration creates, replaces or drops one of the three, or SQL 83's other function.
  for (const key of RELEASE_SQL_KEYS.filter((k) => k !== KEY)) {
    const other = RELEASE_SQL_SPECS[key];
    const touched = [...other.functions.map((fn) => fn.identity), ...(other.dropped_functions || []), ...(other.acl_functions || []).map((fn) => fn.identity)];
    assert.deepEqual(touched.filter((identity) => [...FNS, KEPT_SQL83, SQL82_FN].includes(identity)), [], key);
  }
  const prod = productionPin();
  assert.equal(prod.intended_replacement_sha256, pin.intended_replacement_sha256);
  assert.equal(prod.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(prod.staging_pin_commit, pin.commit);
  assert.equal(prod.source_sha256, pin.source_sha256);
  assert.deepEqual(prod.predecessors, []);
  assert.equal(prod.execute, false);
  assert.equal(prod.authorization, 'pending');
  assert.equal(prod.expected_live_definition_sha256, null);
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

test('reviewed file and spec: SQL 83\'s two functions with only SQL 127\'s edits and the new portal signer; EXECUTE for checksops and the owner; no table, view, policy, table grant or trigger; the written tables; the SQL 82 / SQL 83 prerequisites; pre- and post-conditions', () => {
  assert.equal(releaseSqlExecutableText(KEY, TEXT), TEXT);
  const defs = releaseFunctionDefinitions(TEXT);
  assert.deepEqual(Object.keys(defs), NAMES);
  const sql83 = releaseFunctionDefinitions(SQL83_TEXT);
  for (const name of NAMES) {
    const def = defs[name];
    assert.equal(def.security_definer, true, name);
    assert.equal(def.language, 'plpgsql', name);
    assert.equal(def.volatility, 'v', name);
    assert.equal(def.parallel, 'u', name);
    assert.equal(def.result, 'jsonb', name);
    assert.deepEqual(def.config, ['row_security=off', 'search_path=public'], name);
    assert.doesNotMatch(def.prosrc, /SET\s+ROLE|\bGRANT\b|\bREVOKE\b|access_token/i, name);
  }
  // The replaced functions keep SQL 83's attributes.
  for (const name of NAMES.slice(0, 2)) {
    for (const attr of ['language', 'volatility', 'parallel', 'result', 'security_definer']) assert.equal(defs[name][attr], sql83[name][attr], `${name} ${attr}`);
    assert.deepEqual(defs[name].config, sql83[name].config, name);
  }

  // The endorse capability: SQL 83's body with only the status allow-list widened to ('pending', 'sent').
  const endorse = defs.aws_public_homeowner_ledger_endorse_capability.prosrc;
  const endorse83 = sql83.aws_public_homeowner_ledger_endorse_capability.prosrc;
  const allow83 = /  -- Allow-list: only an endorsement[^\n]*\n(?:  --[^\n]*\n)*  IF status_lc <> 'sent' THEN\n/.exec(endorse83);
  assert.ok(allow83, 'SQL 83 allow-list');
  const allow127 = /  -- SQL 127: the claim portal link is enough to sign[^\n]*\n(?:  --[^\n]*\n)*  IF status_lc NOT IN \('pending', 'sent'\) THEN\n/.exec(endorse);
  assert.ok(allow127, 'SQL 127 allow-list');
  assert.equal(endorse.replace(allow127[0], allow83[0]), endorse83);
  assert.match(endorse, /UPDATE public\.check_endorsements\s+SET token = gen_random_uuid\(\)::text\s+WHERE id = rec\.id\s+AND \(token IS NULL OR trim\(token\) = ''\)/);
  assert.match(endorse, /FOR UPDATE OF e;/);
  assert.match(endorse, /IF rec\.payee_type IS DISTINCT FROM 'insured' THEN/);

  // pending_signatures: SQL 83's body with only the signer_open expiry filter removed.
  const pending = defs.aws_public_homeowner_pending_signatures.prosrc;
  const pending83 = sql83.aws_public_homeowner_pending_signatures.prosrc;
  const open83 = /(        AND lower\(trim\(COALESCE\(matched\.signer_status, ''\)\)\) = 'pending'\n)((?:        [^\n]*\n)*?)(      \) AS signer_open)/.exec(pending83);
  const open127 = /(        AND lower\(trim\(COALESCE\(matched\.signer_status, ''\)\)\) = 'pending'\n)((?:        [^\n]*\n)*?)(      \) AS signer_open)/.exec(pending);
  assert.ok(open83 && open127);
  assert.match(open83[2], /expires_at/);
  assert.doesNotMatch(open127[2], /expires_at/);
  assert.match(open127[2], /-- SQL 127:/);
  assert.equal(pending.replace(open127[0], open83[0]), pending83);
  // Signing order still ignores an earlier signer whose link expired (as in SQL 83).
  assert.match(pending, /AND \(prior\.expires_at IS NULL OR prior\.expires_at >= now\(\)\)/);
  assert.doesNotMatch(pending, /\b(UPDATE|INSERT INTO|DELETE FROM)\s+public\./);

  // The portal signer: SQL 83's document gates; the existing token_hash, never a raw token; the
  // expiry renewal for the one matched signer; the signer row locked.
  const portal = defs.aws_public_homeowner_document_portal_signer.prosrc;
  assert.match(portal, /FOR UPDATE OF s;/);
  assert.match(portal, /IF lower\(COALESCE\(rec\.signer_type, ''\)\) NOT IN \('policyholder', 'insured', 'homeowner'\) THEN/);
  assert.match(portal, /IF rec\.completed_at IS NOT NULL OR request_status_lc NOT IN \('pending', 'in_progress'\) THEN/);
  assert.match(portal, /IF hash_raw !~ '\^\[0-9a-f\]\{64\}\$' THEN/);
  assert.match(portal, /UPDATE public\.signature_signers\s+SET expires_at = now\(\) \+ interval '72 hours'\s+WHERE id = rec\.id;/);
  assert.match(portal, /'token_hash', hash_raw/);
  assert.doesNotMatch(portal, /SET token_hash|gen_random|access_token/);
  // The tables each function writes.
  const writes = (body) => [...new Set([...body.matchAll(/\b(?:UPDATE|INSERT INTO|DELETE FROM)\s+(public\.[a-z_]+)/g)].map((m) => m[1]))];
  assert.deepEqual(writes(endorse), ['public.check_endorsements']);
  assert.deepEqual(writes(pending), []);
  assert.deepEqual(writes(portal), ['public.signature_signers']);

  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.functions, FNS.map((identity) => ({ identity, acl: [...FOR_CHECKSOPS], revokes: [...REVOKES] })));
  assert.deepEqual(spec.definer_writes, WRITES);
  // The file's ACL statements: PUBLIC and authenticated revoked from all three, checksops granted on all three.
  const code = TEXT.replace(/--[^\n]*/g, '');
  for (const identity of FNS) {
    assert.ok(code.includes(`REVOKE ALL ON FUNCTION ${identity} FROM PUBLIC;`), identity);
    assert.ok(code.includes(`REVOKE ALL ON FUNCTION ${identity} FROM authenticated;`), identity);
    assert.ok(code.includes(`GRANT EXECUTE ON FUNCTION ${identity} TO checksops;`), identity);
  }
  assert.equal([...code.matchAll(/\bGRANT\b/g)].length, 3);
  assert.equal([...code.matchAll(/\bREVOKE\b/g)].length, 6);
  for (const forbidden of [/\bCREATE\s+(TABLE|POLICY|VIEW|INDEX|TRIGGER)\b/i, /\bDROP\b/i, /\bTRUNCATE\b/i, /\bALTER\s+(TABLE|VIEW|FUNCTION)\b/i,
    /\bDELETE\s+FROM\b/i, /\bINSERT\s+INTO\b/i, /\banon\b/, /\bservice_role\b/, /aws_public_homeowner_ledger_by_token|aws_public_homeowner_document_sign_capability\(/]) {
    assert.doesNotMatch(code, forbidden, String(forbidden));
  }
  // The prerequisites: SQL 83's and SQL 82's functions, gen_random_uuid, the seven tables, role
  // checksops, then every column the three bodies read or write.
  assert.deepEqual(spec.prerequisites.slice(0, 5), [ENDORSE, PENDING, KEPT_SQL83, SQL82_FN, 'pg_catalog.gen_random_uuid()']);
  const tables = ['homeowner_ledger_tokens', 'claims', 'check_intake_items', 'homeowner_ledger_events', 'check_endorsements', 'signature_requests', 'signature_signers'];
  assert.deepEqual(spec.prerequisites.slice(5, 12), tables.map((t) => `public.${t}`));
  assert.equal(spec.prerequisites[12], 'role checksops');
  const columns = spec.prerequisites.slice(13);
  assert.ok(columns.every((c) => /^column public\.[a-z_]+\.[a-z_]+$/.test(c)));
  assert.equal(new Set(columns).size, columns.length);
  for (const c of columns) {
    const [, table, column] = /^column public\.([a-z_]+)\.([a-z_]+)$/.exec(c);
    assert.ok(tables.includes(table), c);
    assert.ok(new RegExp(`\\b${column}\\b`).test(code), c);
  }
  for (const c of ['signature_signers.token_hash', 'signature_signers.expires_at', 'check_endorsements.token', 'check_endorsements.status',
    'signature_requests.completed_at', 'homeowner_ledger_tokens.revoked_at']) {
    assert.ok(columns.includes(`column public.${c}`), c);
  }
  for (const absent of ['tables', 'policies', 'views', 'column_acl', 'indexes', 'unique_covers', 'dropped_functions', 'whole_tables', 'counts',
    'triggers', 'table_privileges', 'acl_functions', 'render', 'production_noop', 'added_columns', 'altered_relations']) {
    assert.equal(spec[absent], undefined, absent);
  }
  const scope = releaseUnrelatedScope(KEY);
  assert.deepEqual(scope.skip_functions, FNS);
  assert.deepEqual(scope.skip_relations, []);
  assert.deepEqual(scope.skip_views, []);

  const text = releaseStateText(KEY, releaseIntendedState(KEY, TEXT));
  assert.equal(text.split('\n')[0], 'release sql127 v1');
  assert.equal(text.split('\n').length, 1 + FNS.length);
  for (const identity of FNS) {
    assert.match(text, new RegExp(`\\nfunction ${identity.replace(/[().]/g, (c) => `\\${c}`)}: lang=plpgsql vol=v parallel=u secdef=true result=jsonb config=row_security=off;search_path=public prosrc=[0-9a-f]{64} acl=checksops EXECUTE;owner EXECUTE(\\n|$)`), identity);
  }
  // The SQL 83 state: the two replaced functions 'different' (body only), the portal signer absent.
  const sql83Text = releaseStateText(KEY, sql83State());
  assert.match(sql83Text, /\nfunction public\.aws_public_homeowner_document_portal_signer\(text, uuid\): absent$/);
  assert.deepEqual(sql83Text.split('\n').slice(1, 3).map((line) => line.replace(/ prosrc=[0-9a-f]{64}/, '')),
    text.split('\n').slice(1, 3).map((line) => line.replace(/ prosrc=[0-9a-f]{64}/, '')));

  // Pre-conditions: definer writes, the function's owner, its result, an EXECUTE grant the file would not revoke.
  const before = sql83State();
  const base = {
    prerequisites_missing: [], predecessors_applied: true, successors_applied: [], dropped_function_callers: [],
    definer: Object.fromEntries(WRITES.map((t) => [t, true])),
    functions: {},
  };
  const pre = (over = {}) => releaseSharedPreconditionFailures(KEY, { ...base, ...over }, TEXT);
  const live = (identity, over = {}) => ({ ...before.functions[identity], owner_is_login: true, ...over });
  const all = (over = {}) => Object.fromEntries(REPLACED.map((identity) => [identity, live(identity, over)]));
  assert.deepEqual(pre(), []);
  assert.deepEqual(pre({ functions: all() }), []);
  assert.deepEqual(pre({ prerequisites_missing: [KEPT_SQL83] }), ['prerequisites_present']);
  assert.deepEqual(pre({ definer: { ...base.definer, 'public.check_endorsements': false } }), ['definer_can_write_relations']);
  assert.deepEqual(pre({ definer: { ...base.definer, 'public.signature_signers': false } }), ['definer_can_write_relations']);
  assert.deepEqual(pre({ functions: { ...all(), [ENDORSE]: live(ENDORSE, { acl: [...REVOKES, ...FOR_CHECKSOPS] }) } }), []);
  assert.deepEqual(pre({ functions: { ...all(), [ENDORSE]: live(ENDORSE, { acl: ['anon EXECUTE', 'owner EXECUTE'] }) } }), ['function_acl_replaceable']);
  assert.deepEqual(pre({ functions: { ...all(), [PENDING]: live(PENDING, { acl: ['PUBLIC EXECUTE with grant option', 'owner EXECUTE'] }) } }), ['function_acl_replaceable']);
  assert.deepEqual(pre({ functions: { ...all(), [PENDING]: live(PENDING, { owner_is_login: false }) } }), ['functions_owned_by_login']);
  assert.deepEqual(pre({ functions: { ...all(), [ENDORSE]: live(ENDORSE, { result: 'json' }) } }), ['function_results_match']);
  // Post-conditions: the intended fingerprint with every function owned by the login.
  const after = (over = {}) => ({
    live_definition_sha256: PINS[KEY].intended_replacement_sha256,
    functions: Object.fromEntries(FNS.map((identity) => [identity, { exists: true, owner_is_login: true }])),
    ...over,
  });
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, {}, after(), PINS[KEY]), []);
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, {}, after({ live_definition_sha256: 'f'.repeat(64) }), PINS[KEY]), ['intended_state']);
});

test('PostgreSQL 16: SQL 127 through the executor: refused without SQL 82 / SQL 83; the SQL 83 state as derived; refused while check_endorsements forces RLS, a function is owned by another role or granted beyond the revoked roles; a pending pin cannot apply; one apply on the intended fingerprint, then already in place', { timeout: 600000 }, async (t) => {
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
  const fx = await releaseFixture(pg, 'pg-sql127-exec-', 59960, { extra: [HOMEOWNER_SCHEMA] });
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
    const bodies = async () => (await fx.admin.query(`SELECT p.proname, pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc, 'UTF8')), 'hex') AS h
      FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY($1::text[]) ORDER BY 1`, [NAMES])).rows;
    const sql83Defs = releaseFunctionDefinitions(SQL83_TEXT);
    const sql83Bodies = NAMES.slice(0, 2).map((name) => ({ proname: name, h: sha(sql83Defs[name].prosrc) })).sort((a, b) => a.proname.localeCompare(b.proname));

    // Without SQL 82 and SQL 83: refused, nothing applied.
    const early = await inspect();
    assert.deepEqual(early.release_sql_inspect.prerequisites_missing, [ENDORSE, PENDING, KEPT_SQL83, SQL82_FN]);
    assert.ok(early.precondition_failures.includes('prerequisites_present'));
    assert.equal((await apply(early.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
    assert.deepEqual(await bodies(), []);
    // SQL 82 and SQL 83 (the real files), applied by the owning login as in staging and production.
    await owner(SQL82_TEXT);
    await owner(SQL83_TEXT);

    // The SQL 83 state: the inspect's fingerprint is the one derived from SQL 83's bytes.
    const r = await inspect();
    assert.deepEqual(r.precondition_failures, [], JSON.stringify(r.release_sql_inspect));
    assert.deepEqual(r.release_sql_inspect.prerequisites_missing, []);
    assert.equal(r.already_applied, false);
    assert.equal(r.live_definition_sha256, releaseStateHash(KEY, sql83State()));
    assert.deepEqual(r.release_sql_inspect.functions.map((f) => f.state), ['different', 'different', 'absent']);
    assert.deepEqual(r.release_sql_inspect.function_acl.map((f) => f.acl), [[...FOR_CHECKSOPS], [...FOR_CHECKSOPS], []]);
    assert.deepEqual(r.release_sql_inspect.definer_writes, WRITES.map((table) => ({ name: table.replace(/^public\./, ''), ok: true })));
    assert.deepEqual(await bodies(), sql83Bodies);

    // check_endorsements with FORCE ROW LEVEL SECURITY: the definer could not write it; refused, nothing applied.
    await owner('ALTER TABLE public.check_endorsements FORCE ROW LEVEL SECURITY');
    const forced = await inspect();
    assert.deepEqual(forced.precondition_failures, ['definer_can_write_relations'], JSON.stringify(forced.release_sql_inspect));
    assert.deepEqual(forced.release_sql_inspect.definer_writes.filter((row) => !row.ok).map((row) => row.name), ['check_endorsements']);
    assert.equal((await apply(forced.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
    await owner('ALTER TABLE public.check_endorsements NO FORCE ROW LEVEL SECURITY');

    // A replaced function owned by another role: refused, nothing applied.
    await fx.admin.query(`ALTER FUNCTION ${PENDING} OWNER TO ubuntu`);
    const foreign = await inspect();
    assert.deepEqual(foreign.precondition_failures, ['functions_owned_by_login'], JSON.stringify(foreign.release_sql_inspect));
    assert.equal((await apply(foreign.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
    await fx.admin.query(`ALTER FUNCTION ${PENDING} OWNER TO checksops_admin`);

    // EXECUTE for a role the file does not revoke: refused (it would survive), nothing applied.
    await fx.admin.query(`CREATE ROLE reporting NOLOGIN; GRANT EXECUTE ON FUNCTION ${ENDORSE} TO reporting`);
    const granted = await inspect();
    assert.deepEqual(granted.precondition_failures, ['function_acl_replaceable'], JSON.stringify(granted.release_sql_inspect));
    assert.equal((await apply(granted.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
    await fx.admin.query(`REVOKE EXECUTE ON FUNCTION ${ENDORSE} FROM reporting; DROP ROLE reporting`);
    assert.deepEqual(await bodies(), sql83Bodies);

    // EXECUTE for PUBLIC and authenticated (the roles the file revokes): allowed.
    await owner(`GRANT EXECUTE ON FUNCTION ${PENDING} TO PUBLIC, authenticated`);
    const wider = await inspect();
    assert.deepEqual(wider.precondition_failures, [], JSON.stringify(wider.release_sql_inspect));
    assert.notEqual(wider.live_definition_sha256, r.live_definition_sha256);
    // A pending pin cannot apply.
    const pending = await handlerFor(connect)(releaseEvent({ expected_live_definition_sha256: wider.live_definition_sha256 }));
    assert.equal(pending.ok, false);
    assert.deepEqual(await bodies(), sql83Bodies);

    const applied = await apply(wider.live_definition_sha256);
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.before_hash, wider.live_definition_sha256);
    assert.equal(applied.details.receipt.after_hash, PINS[KEY].intended_replacement_sha256);
    const after = await inspect();
    assert.equal(after.already_applied, true);
    assert.equal(after.live_definition_sha256, PINS[KEY].intended_replacement_sha256);
    assert.deepEqual(after.precondition_failures, []);
    const defs = releaseFunctionDefinitions(TEXT);
    assert.deepEqual(await bodies(), NAMES.map((name) => ({ proname: name, h: sha(defs[name].prosrc) })).sort((a, b) => a.proname.localeCompare(b.proname)));
    const acl = (await fx.admin.query(`SELECT p.proname, pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig::text[] AS config,
        has_function_privilege('checksops', p.oid, 'EXECUTE') AS checksops, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
        has_function_privilege('anon', p.oid, 'EXECUTE') AS anon
      FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY($1::text[]) ORDER BY 1`, [NAMES])).rows;
    assert.equal(acl.length, 3);
    for (const row of acl) {
      assert.deepEqual([row.owner, row.prosecdef, row.checksops, row.authenticated, row.anon], ['checksops_admin', true, true, false, false], row.proname);
      assert.deepEqual([...row.config].sort(), ['row_security=off', 'search_path=public'], row.proname);
    }
    // SQL 82's view and SQL 83's document capability are untouched.
    const kept = (await fx.admin.query(`SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc, 'UTF8')), 'hex') AS h
      FROM pg_catalog.pg_proc p WHERE p.oid = $1::regprocedure`, [KEPT_SQL83])).rows;
    assert.deepEqual(kept, [{ h: sha(sql83Defs.aws_public_homeowner_document_sign_capability.prosrc) }]);
    assert.equal((await apply(wider.live_definition_sha256)).code, CODES.UNRELATED_MUTATION);
  } finally {
    await fx.close();
  }
});
