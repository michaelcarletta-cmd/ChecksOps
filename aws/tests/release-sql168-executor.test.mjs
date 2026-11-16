/**
 * SQL 168 (aws/workflows/sql/168_mortgage_desk_same_agent_new_check.sql) in the staging guarded executor, on the release
 * engine shared with SQL 90-167 (scripts/deployment-guard/lib/release-sql-state.mjs). Owner 2026-11-16: "We need to make
 * sure once a mortgage agent handles a check, if another check comes in they handle each one for that check file."
 * release-sql90-97-executor.test.mjs runs what every release key shares (SQL 168 included); this file covers what is new:
 *
 *   - the pin: staging-authorized (wave 60) from staging read-live run 43878936321, code-derived, selectable, packed, in step with the pending production pin; the pinned commit
 *     authored the bytes; no predecessor, supersedes nothing; nothing names it;
 *   - the file and spec: two new SECURITY DEFINER functions, public.aws_mortgage_desk_route_same_agent(uuid, text) and
 *     public.aws_mortgage_desk_route_same_agent_trigger(), with SQL 167's lock rule, SQL 158's active-agent rule, the
 *     tenant's insert shape, the agent's accept row change, one check-thread message (SQL 166's columns) and one audit
 *     row, and two triggers; the prerequisite block,
 *     the REVOKEs (EXECUTE for the owner only), nothing else; pre- and post-conditions;
 *   - on PostgreSQL 16 (the release fixture plus SQL 166's Desk and loss draft schema and the columns and table SQL 168
 *     reads): the absent state read back as derived; refused while a column is missing, a relation is under FORCE ROW
 *     LEVEL SECURITY or a trigger of the same name already exists; a pending pin and an unexpected pre-state cannot
 *     apply; one apply through the executor reaches the intended fingerprint (the live trigger renderings are the
 *     spec's), then is refused as already in place.
 * The behavior is aws/tests/sql168-mortgage-desk-same-agent-new-check-pg.test.mjs.
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
  AUTHORIZED_SQL168_MORTGAGE_DESK_SAME_AGENT_NEW_CHECK,
  AUTHORIZED_STAGING_SQL,
  RELEASE_2026_10_17_PENDING_SQL_PINS as PINS,
  authorizationFingerprint,
  resolveAuthorizedMigration,
} from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import {
  RELEASE_SQL_KEYS,
  RELEASE_SQL_SPECS,
  RELEASE_STAGING_SQL_KEYS,
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
import { assertStagingPinState, pendingPin } from './helpers/staging-sql-wave1.mjs';
import { pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';
import { deskMonitoringSchema } from './helpers/sql166-desk-monitoring-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-11-16T12:00:00.000Z';
const KEY = 'sql168';
const ROUTE = 'public.aws_mortgage_desk_route_same_agent(uuid, text)';
const ROUTE_TRIGGER = 'public.aws_mortgage_desk_route_same_agent_trigger()';
const IDENTITIES = Object.freeze([ROUTE, ROUTE_TRIGGER]);
const RELATIONS = Object.freeze(['public.check_intake_items', 'public.loss_draft_tracking', 'public.mortgage_handling_requests',
  'public.mortgage_ops_request_audit', 'public.mortgage_agent_accounts', 'public.check_messages', 'public.profiles']);
const TRIGGER_TABLES = Object.freeze(['public.loss_draft_tracking', 'public.check_intake_items']);
const ACL = Object.freeze(['owner EXECUTE']);
const REVOKES = Object.freeze(['PUBLIC EXECUTE', 'anon EXECUTE', 'authenticated EXECUTE', 'service_role EXECUTE', 'checksops EXECUTE']);
const TRIGGERS = Object.freeze([
  {
    table: 'public.loss_draft_tracking',
    name: 'aws_loss_draft_route_same_agent',
    def: 'CREATE TRIGGER aws_loss_draft_route_same_agent AFTER INSERT ON public.loss_draft_tracking FOR EACH ROW EXECUTE FUNCTION public.aws_mortgage_desk_route_same_agent_trigger()',
  },
  {
    table: 'public.check_intake_items',
    name: 'aws_check_claim_route_same_agent',
    def: 'CREATE TRIGGER aws_check_claim_route_same_agent AFTER UPDATE ON public.check_intake_items FOR EACH ROW WHEN (((new.claim_id IS NOT NULL) AND (old.claim_id IS DISTINCT FROM new.claim_id))) EXECUTE FUNCTION public.aws_mortgage_desk_route_same_agent_trigger()',
  },
]);
/** The columns the routing copies from the source request. */
const COPIED = Object.freeze(['mortgage_company', 'mortgage_servicer', 'loan_number', 'policy_number', 'claim_number', 'insurance_company',
  'loss_type', 'date_of_loss', 'homeowner_name', 'homeowner_email', 'homeowner_phone', 'property_address', 'homeowner_ssn_last_four']);
const sha = (text) => createHash('sha256').update(text).digest('hex');
const TEXT = fs.readFileSync(path.join(ROOT, PINS[KEY].filename), 'utf8');
const FILES = Object.freeze(Object.fromEntries(RELEASE_SQL_KEYS.map((key) => [key, path.join(ROOT, PINS[key].filename)])));
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK|BEGIN READ ONLY)\b/i;
const productionPin = () => JSON.parse(fs.readFileSync(path.join(ROOT, RELEASE_SQL_SPECS[KEY].production_pin_rel), 'utf8'));
const SQL158 = fs.readFileSync(path.join(ROOT, 'aws/workflows/sql/158_mortgage_desk_oversight_and_agent_notes.sql'), 'utf8');
const SQL167 = fs.readFileSync(path.join(ROOT, 'aws/workflows/sql/167_claim_ledger_relink_check.sql'), 'utf8');

/** The pre-state both databases have: the two functions and the two triggers absent (everything else present). */
const ABSENT_PRE = releaseStateHash(KEY, {});

/** What SQL 168 reads on top of the release fixture and SQL 166's Desk schema, in the production shapes (as the superuser). */
const ROUTING_SCHEMA = `
CREATE TYPE public.check_stage AS ENUM ('intake', 'review', 'deposited', 'voided', 'returned');
ALTER TABLE public.check_intake_items ADD COLUMN IF NOT EXISTS check_stage public.check_stage;
ALTER TABLE public.mortgage_handling_requests
  ADD COLUMN requested_by uuid, ADD COLUMN policy_number text, ADD COLUMN loss_type text, ADD COLUMN date_of_loss date,
  ADD COLUMN homeowner_ssn_last_four text, ADD COLUMN endorsement_order integer, ADD COLUMN total_mortgagees integer,
  ADD COLUMN predecessor_request_id uuid;
CREATE TABLE public.mortgage_ops_request_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), mortgage_request_id uuid NOT NULL, actor_id uuid, action text NOT NULL,
  previous_agent_id uuid, reason text NOT NULL, from_status text, to_status text, accepted_at_preserved timestamptz,
  tenant_billing_event_id uuid, payload jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.mortgage_ops_request_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mortgage_agent_accounts ENABLE ROW LEVEL SECURITY;
`;

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
    expiry: '2026-11-16T13:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    ...rest,
  };
  event.preflight_live_fingerprint = authorizationFingerprint(event);
  return event;
}
const inspectEvent = () => releaseEvent({ action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL });

function handlerFor(connect, { pins = {} } = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql168-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

test('pin: SQL 168 staging-authorized from its read-live, code-derived, selectable, packed, in step with the pending production pin; no predecessor', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL168_MORTGAGE_DESK_SAME_AGENT_NEW_CHECK, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/168_mortgage_desk_same_agent_new_check.sql');
  assert.equal(pin.migration_id, '168_mortgage_desk_same_agent_new_check');
  assert.equal(spec.choice, 'sql168-mortgage-desk-same-agent-new-check');
  assert.doesNotMatch(spec.choice, /production/);
  assert.equal(sha(TEXT), pin.source_sha256);
  assertStagingPinState(assert, KEY, pin);
  // Staging apply authorized (owner approved 2026-11-16) from staging read-live run 43878936321: already_applied false,
  // precondition_failures []. It read the derived pre-state (the functions and triggers absent).
  assert.equal(pin.execute, true);
  assert.equal(pin.authorization, 'Owner approved 2026-11-16: staging apply (wave 60) from staging read-live run 43878936321');
  assert.equal(pin.expected_live_definition_sha256, ABSENT_PRE);
  assert.equal(pin.expected_live_definition_sha256, 'a364af9a300c5e617db353e67e3f37a18691a27f10d9349d506471067a31ef33');
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/production-sql-168-apply.md'), 'utf8'), /\*\*Status:\*\* staging pin execute-authorized \(wave 60\); not applied anywhere\. The production pin is pending\./);
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/production-sql-168-apply.md'), 'utf8'), /read-live \(2026-11-16\)\.\*\* Run 43878936321/);
  assert.equal(releaseIntendedHash(KEY, TEXT), pin.intended_replacement_sha256);
  assert.notEqual(ABSENT_PRE, pin.intended_replacement_sha256);
  assert.ok(RELEASE_STAGING_SQL_KEYS.includes(KEY));
  // The runbook names the absent and intended states (derived here), the intended fingerprint and the source.
  const runbook = fs.readFileSync(path.join(ROOT, 'ops/production-sql-168-apply.md'), 'utf8');
  for (const value of [ABSENT_PRE, pin.intended_replacement_sha256, pin.source_sha256]) assert.ok(runbook.includes(value), value);
  assert.ok(runbook.includes(`\`\`\`\n${releaseStateText(KEY, releaseIntendedState(KEY, TEXT))}\n\`\`\``));
  assert.ok(runbook.includes(`\`\`\`\n${releaseStateText(KEY, {})}\n\`\`\``));
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql168-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], [...IDENTITIES]);
  assert.deepEqual([...pin.function_identities], spec.functions.map((fn) => fn.identity));
  assert.deepEqual(spec.predecessors, []);
  for (const absent of ['supersedes', 'runs_before', 'refuse_after', 'production_only']) assert.equal(spec[absent], undefined, absent);
  // Nothing supersedes, refuses after or depends on SQL 168, and no other release migration touches its objects.
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes(KEY)
    || (RELEASE_SQL_SPECS[key].refuse_after || []).some((m) => m.key === KEY)
    || (RELEASE_SQL_SPECS[key].predecessors || []).includes(KEY)), []);
  for (const key of RELEASE_SQL_KEYS.filter((k) => k !== KEY)) {
    const other = RELEASE_SQL_SPECS[key];
    const touched = [...(other.functions || []).map((fn) => fn.identity), ...(other.dropped_functions || []), ...(other.acl_functions || []).map((fn) => fn.identity)];
    for (const identity of IDENTITIES) assert.ok(!touched.includes(identity), `${key} ${identity}`);
    const triggers = [...(other.triggers || []), ...(other.dropped_triggers || [])].map((t) => t.name);
    for (const t of TRIGGERS) assert.ok(!triggers.includes(t.name), `${key} ${t.name}`);
  }
  const prod = productionPin();
  assert.equal(prod.migration, KEY);
  assert.equal(prod.intended_replacement_sha256, pin.intended_replacement_sha256);
  assert.equal(prod.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(prod.staging_pin_commit, pin.commit);
  assert.equal(prod.source_sha256, pin.source_sha256);
  assert.deepEqual(prod.function_identities, [...IDENTITIES]);
  assert.deepEqual(prod.predecessors, []);
  assert.equal(prod.execute, false);
  assert.equal(prod.authorization, 'pending');
  assert.equal(prod.authorization_phrase, 'ROUTE_NEW_CHECK_TO_SAME_MORTGAGE_AGENT');
  assert.equal(prod.expected_live_definition_sha256, null);
  assert.equal(prod.production_inspect.status, 'pending');
  assert.equal(prod.staging_acceptance.ok, false);
  assert.ok(prod.production_inspect.note.includes(ABSENT_PRE));
  assert.ok(prod.order_note.includes(ABSENT_PRE));
  assert.ok(prod.intended_post_state.note.includes(pin.intended_replacement_sha256));
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

test('reviewed file and spec: two new DEFINER functions with SQL 167\'s lock rule, SQL 158\'s active agent, the tenant\'s insert, the agent\'s accept and one audit row, run by two triggers; the prerequisite block and the REVOKEs, nothing else; the spec; pre- and post-conditions', () => {
  assert.equal(releaseSqlExecutableText(KEY, TEXT), TEXT);
  const defs = releaseFunctionDefinitions(TEXT);
  assert.deepEqual(Object.keys(defs), ['aws_mortgage_desk_route_same_agent', 'aws_mortgage_desk_route_same_agent_trigger']);
  for (const [name, result] of [['aws_mortgage_desk_route_same_agent', 'uuid'], ['aws_mortgage_desk_route_same_agent_trigger', 'trigger']]) {
    const def = defs[name];
    assert.equal(def.language, 'plpgsql', name);
    assert.equal(def.volatility, 'v', name);
    assert.equal(def.parallel, 'u', name);
    assert.equal(def.security_definer, true, name);
    assert.equal(def.result, result, name);
    // row_security on: SQL 167's relink runs with it off, which would carry into the routing's nested triggers.
    assert.deepEqual(def.config, ['row_security=on', 'search_path=public, pg_temp'], name);
  }
  const body = defs.aws_mortgage_desk_route_same_agent.prosrc.replace(/--[^\n]*/g, '');
  // SQL 167's lock rule (SQL 43's), word for word.
  assert.ok(SQL167.includes("IF v_deposited IS NOT NULL OR COALESCE(v_stage, '') IN ('deposited', 'voided', 'returned') THEN"));
  assert.match(body, /IF v_deposited IS NOT NULL OR COALESCE\(v_stage, ''\) IN \('deposited', 'voided', 'returned'\) THEN\s+RETURN NULL;/);
  // A claim and a loss draft; no requested, in-progress or completed request on the check.
  assert.match(body, /IF NOT FOUND OR v_tenant IS NULL OR v_claim IS NULL THEN\s+RETURN NULL;/);
  assert.match(body, /IF NOT EXISTS \(\s+SELECT 1 FROM public\.loss_draft_tracking ld WHERE ld\.check_intake_item_id = _check_id\s+\) THEN\s+RETURN NULL;/);
  assert.match(body, /WHERE r\.check_intake_item_id = _check_id\s+AND r\.status IN \('requested', 'in_progress', 'completed'\)\s+\) THEN\s+RETURN NULL;/);
  // The source: same tenant, the claim through the other check's claim_id, in_progress or completed, 1st mortgagee, and
  // SQL 158's active agent (has_role mortgage_agent and no roster row other than active); in progress first, most recent.
  assert.ok(SQL158.includes("IF NOT public.has_role(_agent_id, 'mortgage_agent'::public.app_role)\n     OR EXISTS (SELECT 1 FROM public.mortgage_agent_accounts m WHERE m.application_user_id = _agent_id AND m.status <> 'active') THEN"));
  assert.match(body, /WHERE r\.tenant_id = v_tenant\s+AND pc\.tenant_id = v_tenant\s+AND pc\.claim_id = v_claim\s+AND r\.check_intake_item_id <> _check_id\s+AND r\.status IN \('in_progress', 'completed'\)\s+AND COALESCE\(r\.endorsement_order, 1\) = 1\s+AND r\.assigned_employee_id IS NOT NULL\s+AND public\.has_role\(r\.assigned_employee_id, 'mortgage_agent'::public\.app_role\)\s+AND NOT EXISTS \(\s+SELECT 1 FROM public\.mortgage_agent_accounts m\s+WHERE m\.application_user_id = r\.assigned_employee_id AND m\.status <> 'active'\)/);
  assert.match(body, /ORDER BY CASE r\.status WHEN 'in_progress' THEN 0 ELSE 1 END,\s+CASE WHEN r\.status = 'in_progress' THEN COALESCE\(r\.accepted_at, r\.created_at\)\s+ELSE COALESCE\(r\.completed_at, r\.accepted_at, r\.created_at\) END DESC NULLS LAST,/);
  // The tenant's insert shape (requested, unassigned, order 1) with the copied details, then the accept row change.
  const insert = /INSERT INTO public\.mortgage_handling_requests \(([^)]*)\) VALUES \(([^)]*)\)/.exec(body.replace(/\s+/g, ' '));
  assert.ok(insert, 'one request INSERT');
  const columns = insert[1].split(',').map((c) => c.trim());
  assert.deepEqual(columns, ['tenant_id', 'check_intake_item_id', 'claim_id', 'status', 'endorsement_order', ...COPIED]);
  assert.deepEqual(insert[2].split(',').map((c) => c.trim()), ['v_tenant', '_check_id', 'v_claim', "'requested'", '1', ...COPIED.map((c) => `v_src.${c}`)]);
  assert.match(body, /UPDATE public\.mortgage_handling_requests r\s+SET assigned_employee_id = v_src\.assigned_employee_id,\s+status = 'in_progress',\s+accepted_at = COALESCE\(r\.accepted_at, now\(\)\),\s+updated_at = now\(\)\s+WHERE r\.id = v_new\s+AND r\.assigned_employee_id IS NULL\s+AND r\.status = 'requested'/);
  assert.match(body, /INSERT INTO public\.mortgage_ops_request_audit \(mortgage_request_id, actor_id, action, reason, from_status, to_status, payload\)\s+VALUES \(\s+v_new, NULL, 'auto_route_same_agent',/);
  // Writes: the new request (insert, then its accept) and one audit row; never a DELETE or another table.
  assert.deepEqual([...body.matchAll(/\b(UPDATE|INSERT INTO|DELETE FROM)\s+public\.([a-z_]+)/g)].map((m) => `${m[1]} ${m[2]}`),
    ['INSERT INTO mortgage_handling_requests', 'UPDATE mortgage_handling_requests', 'INSERT INTO check_messages', 'INSERT INTO mortgage_ops_request_audit']);
  // The check-thread message: SQL 166's columns, sent by the agent, the agent's profile name or the fallback.
  const sql166 = fs.readFileSync(path.join(ROOT, 'aws/workflows/sql/166_mortgage_desk_set_monitoring.sql'), 'utf8');
  assert.ok(sql166.includes('INSERT INTO public.check_messages (check_id, sender_id, body, is_deleted, created_at)'));
  assert.match(body, /SELECT NULLIF\(btrim\(COALESCE\(p\.full_name, ''\)\), ''\) INTO v_agent_name\s+FROM public\.profiles p\s+WHERE p\.id = v_src\.assigned_employee_id;/);
  assert.match(body, /INSERT INTO public\.check_messages \(check_id, sender_id, body, is_deleted, created_at\)\s+VALUES \(\s+_check_id, v_src\.assigned_employee_id,\s+'ChecksOps Mortgage Desk added this check to '\s+\|\| COALESCE\(v_agent_name \|\| '''s', 'the agent already handling this claim''s'\)\s+\|\| ' file automatically \(same claim\)\.',\s+false, clock_timestamp\(\)\)/);
  assert.doesNotMatch(body, /\bDELETE\b|check_billing_events|endorsement_order, 1\) = 2|predecessor_request_id/);
  // The trigger function: the row's check, the routing in its own subtransaction, a WARNING with the SQLSTATE only.
  const trig = defs.aws_mortgage_desk_route_same_agent_trigger.prosrc.replace(/--[^\n]*/g, '');
  assert.match(trig, /IF TG_TABLE_NAME = 'loss_draft_tracking' THEN\s+v_check := NEW\.check_intake_item_id;\s+ELSIF TG_TABLE_NAME = 'check_intake_items' THEN/);
  assert.match(trig, /BEGIN\s+PERFORM public\.aws_mortgage_desk_route_same_agent\(v_check, TG_TABLE_NAME\);\s+EXCEPTION WHEN OTHERS THEN\s+RAISE WARNING 'sql168_route_skipped: %', SQLSTATE;\s+END;\s+RETURN NULL;/);
  assert.doesNotMatch(trig, /SQLERRM|\bINSERT\s+INTO\b|\bUPDATE\s+public\.|\bDELETE\b/);

  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.functions, IDENTITIES.map((identity) => ({ identity, acl: [...ACL], revokes: [...REVOKES] })));
  assert.deepEqual(spec.triggers, TRIGGERS);
  assert.deepEqual(spec.altered_relations, [...TRIGGER_TABLES]);
  assert.deepEqual(spec.prerequisites.slice(0, 8), [...RELATIONS, 'public.has_role(uuid, public.app_role)']);
  // Every column the file's prerequisite block checks is a spec prerequisite, and nothing else.
  const fileColumns = [...TEXT.matchAll(/\('(check_intake_items|loss_draft_tracking|mortgage_handling_requests|mortgage_ops_request_audit|mortgage_agent_accounts|check_messages|profiles)', '([a-z_0-9]+)'\)/g)]
    .map((m) => `column public.${m[1]}.${m[2]}`);
  assert.deepEqual(spec.prerequisites.slice(8), fileColumns);
  for (const column of COPIED) assert.ok(spec.prerequisites.includes(`column public.mortgage_handling_requests.${column}`), column);
  assert.deepEqual(spec.predecessors, []);
  assert.deepEqual(spec.definer_writes, [...RELATIONS]);
  for (const absent of ['tables', 'policies', 'views', 'column_acl', 'indexes', 'unique_covers', 'whole_tables', 'counts', 'dropped_functions',
    'table_privileges', 'acl_functions', 'render', 'production_noop', 'added_columns', 'altered_columns', 'dropped_triggers', 'constraints']) {
    assert.equal(spec[absent], undefined, absent);
  }
  // The prerequisite DO block, two CREATE OR REPLACE FUNCTIONs, the REVOKEs from PUBLIC, the role REVOKE block, two
  // DROP TRIGGER IF EXISTS + CREATE TRIGGER pairs; no GRANT.
  const code = TEXT.replace(/--[^\n]*/g, '');
  const outside = code.replace(/\$\$[\s\S]*?\$\$/g, '$$$$');
  assert.equal([...code.matchAll(/\bDO\s+\$sql168_prereq\$/g)].length, 1);
  assert.equal([...code.matchAll(/\bDO\s+\$sql168_revoke\$/g)].length, 1);
  assert.match(code, /sql168_prerequisite_missing/);
  assert.match(code, /sql168_definer_cannot_reach/);
  assert.equal([...code.matchAll(/\bCREATE OR REPLACE FUNCTION\b/g)].length, 2);
  assert.equal([...code.matchAll(/^GRANT\b.*$/gm)].length, 0);
  assert.deepEqual([...code.matchAll(/^REVOKE\b.*$/gm)].map((m) => m[0]), IDENTITIES.map((identity) => `REVOKE ALL ON FUNCTION ${identity} FROM PUBLIC;`));
  assert.deepEqual([...outside.matchAll(/^DROP\b.*$/gm)].map((m) => m[0]), TRIGGERS.map((t) => `DROP TRIGGER IF EXISTS ${t.name} ON ${t.table};`));
  assert.deepEqual([...outside.matchAll(/^CREATE TRIGGER (\S+)$/gm)].map((m) => m[1]), TRIGGERS.map((t) => t.name));
  for (const forbidden of [/\bALTER\b/, /\bCOMMENT\b/, /\bCREATE\s+(TABLE|POLICY|VIEW|INDEX)\b/i, /\bDROP\s+(FUNCTION|TABLE|POLICY|INDEX|VIEW)\b/i,
    /\bTRUNCATE\b/i, /\bINSERT\s+INTO\b/i, /\bUPDATE\s+public\./i, /\bDELETE\s+FROM\b/i, /\bBEGIN\s*;/i, /\bCOMMIT\b/,
    /aws_mortgage_desk_assign_agent|accrue_mortgage_ops_billing|earn_mortgage_agent_compensation|claim_ledger_relink_check/]) {
    assert.doesNotMatch(outside, forbidden, String(forbidden));
  }
  const scope = releaseUnrelatedScope(KEY);
  assert.deepEqual(scope.skip_functions, [...IDENTITIES]);
  assert.deepEqual(scope.skip_triggers, TRIGGERS.map((t) => `${t.table}.${t.name}`));
  assert.deepEqual(scope.skip_views, []);

  const text = releaseStateText(KEY, releaseIntendedState(KEY, TEXT));
  assert.deepEqual(text.split('\n'), [
    'release sql168 v1',
    `function ${ROUTE}: lang=plpgsql vol=v parallel=u secdef=true result=uuid config=row_security=on;search_path=public, pg_temp prosrc=${sha(defs.aws_mortgage_desk_route_same_agent.prosrc)} acl=owner EXECUTE`,
    `function ${ROUTE_TRIGGER}: lang=plpgsql vol=v parallel=u secdef=true result=trigger config=row_security=on;search_path=public, pg_temp prosrc=${sha(defs.aws_mortgage_desk_route_same_agent_trigger.prosrc)} acl=owner EXECUTE`,
    ...TRIGGERS.map((t) => `trigger ${t.table} ${t.name}: enabled=O def=${sha(t.def)}`),
  ]);

  // Pre-conditions: absent passes; any relation unreachable or missing refuses; a trigger table not owned by the login
  // refuses; an existing function owned by another role, with another grant or another result refuses.
  const definer = Object.fromEntries(RELATIONS.map((table) => [table, true]));
  const altered = Object.fromEntries(TRIGGER_TABLES.map((table) => [table, { exists: true, owner_is_login: true }]));
  const base = { prerequisites_missing: [], predecessors_applied: true, successors_applied: [], dropped_function_callers: [], dependents: {}, functions: {}, definer, altered };
  const pre = (over = {}) => releaseSharedPreconditionFailures(KEY, { ...base, ...over }, TEXT);
  const fn = (identity, acl, over = {}) => ({ functions: { [identity]: { ...releaseIntendedState(KEY, TEXT).functions[identity], owner_is_login: true, acl: [...acl], ...over } } });
  assert.deepEqual(pre(), []);
  for (const table of RELATIONS) {
    assert.deepEqual(pre({ definer: { ...definer, [table]: false } }), ['definer_can_write_relations'], table);
    assert.ok(pre({ prerequisites_missing: [table] }).includes('prerequisites_present'), table);
  }
  for (const table of TRIGGER_TABLES) {
    assert.deepEqual(pre({ altered: { ...altered, [table]: { exists: true, owner_is_login: false } } }), ['altered_relations_owned_by_login'], table);
  }
  for (const identity of IDENTITIES) {
    assert.deepEqual(pre(fn(identity, ACL)), [], identity);
    assert.deepEqual(pre(fn(identity, [...REVOKES, ...ACL])), [], identity);
    assert.deepEqual(pre(fn(identity, [...ACL, 'sql168_plain EXECUTE'])), ['function_acl_replaceable'], identity);
    assert.deepEqual(pre(fn(identity, ACL, { owner_is_login: false })), ['functions_owned_by_login'], identity);
    assert.deepEqual(pre(fn(identity, ACL, { result: 'text' })), ['function_results_match'], identity);
  }
  // Post-conditions: the intended fingerprint with both functions owned by the login.
  const post = (over = {}) => ({
    live_definition_sha256: PINS[KEY].intended_replacement_sha256,
    functions: Object.fromEntries(IDENTITIES.map((identity) => [identity, { exists: true, owner_is_login: true }])),
    ...over,
  });
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, {}, post(), PINS[KEY]), []);
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, {}, post({ live_definition_sha256: ABSENT_PRE }), PINS[KEY]), ['intended_state']);
});

test('PostgreSQL 16: SQL 168 through the executor: the pre-state as derived; refused while a column is missing, a relation is under FORCE ROW LEVEL SECURITY or a trigger of the same name exists; a pending pin and an unexpected pre-state cannot apply; one apply on the intended fingerprint, then refused', { timeout: 600000 }, async (t) => {
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
  const fx = await releaseFixture(pg, 'pg-sql168-exec-', 62780, { extra: [...deskMonitoringSchema(), ROUTING_SCHEMA] });
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
    const present = async () => (await fx.admin.query(`SELECT pg_catalog.to_regprocedure($1) IS NOT NULL AS route, pg_catalog.to_regprocedure($2) IS NOT NULL AS trig,
        (SELECT count(*)::int FROM pg_catalog.pg_trigger WHERE tgname IN ('aws_loss_draft_route_same_agent', 'aws_check_claim_route_same_agent')) AS triggers`, IDENTITIES)).rows[0];
    const NOTHING = { route: false, trig: false, triggers: 0 };
    const executeAcl = async (identity) => (await fx.admin.query(`SELECT pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig,
        (SELECT pg_catalog.array_agg(g.name ORDER BY g.name)::text[] FROM (SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END AS name
           FROM pg_catalog.aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE') g) AS execute
      FROM pg_catalog.pg_proc p WHERE p.oid = $1::regprocedure`, [identity])).rows[0];
    const allOk = RELATIONS.map((table) => ({ name: table.replace(/^public\./, ''), ok: true }));

    // The pre-state both databases have: the functions and triggers absent, every prerequisite present, every relation reachable.
    const pre = await inspect();
    assert.deepEqual(pre.precondition_failures, [], JSON.stringify(pre.release_sql_inspect));
    assert.deepEqual(pre.release_sql_inspect.prerequisites_missing, []);
    assert.deepEqual(pre.release_sql_inspect.predecessors, {});
    assert.deepEqual(pre.release_sql_inspect.definer_writes, allOk);
    assert.equal(pre.already_applied, false);
    assert.equal(pre.live_definition_sha256, ABSENT_PRE);
    // The committed staging pin is authorized on exactly this pre-state (wave 60, read-live run 43878936321).
    assert.equal(pre.pin_executable, true);
    assert.deepEqual(await present(), NOTHING);

    // Any relation under FORCE ROW LEVEL SECURITY (the DEFINER owner could not reach it): refused, nothing applied.
    for (const table of RELATIONS) {
      await fx.admin.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      const forced = await inspect();
      assert.deepEqual(forced.precondition_failures, ['definer_can_write_relations'], `${table}: ${JSON.stringify(forced.release_sql_inspect)}`);
      assert.deepEqual(forced.release_sql_inspect.definer_writes, allOk.map((row) => (row.name === table.replace(/^public\./, '') ? { ...row, ok: false } : row)), table);
      assert.equal((await apply(ABSENT_PRE)).code, CODES.DEPLOYMENT_COLLISION, table);
      assert.deepEqual(await present(), NOTHING, table);
      await fx.admin.query(`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY`);
    }
    assert.deepEqual((await inspect()).precondition_failures, []);

    // A column it copies missing: refused, nothing applied.
    await fx.admin.query('ALTER TABLE public.mortgage_handling_requests RENAME COLUMN homeowner_ssn_last_four TO ssn_moved');
    const missing = await inspect();
    assert.ok(missing.release_sql_inspect.prerequisites_missing.includes('column public.mortgage_handling_requests.homeowner_ssn_last_four'), JSON.stringify(missing.release_sql_inspect.prerequisites_missing));
    assert.ok(missing.precondition_failures.includes('prerequisites_present'));
    assert.equal((await apply(missing.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
    await fx.admin.query('ALTER TABLE public.mortgage_handling_requests RENAME COLUMN ssn_moved TO homeowner_ssn_last_four');
    assert.deepEqual((await inspect()).precondition_failures, []);
    assert.deepEqual(await present(), NOTHING);

    // A trigger of the same name already on the table (the file would drop it): another pre-state; refused, kept.
    await fx.admin.query(`SET ROLE checksops_admin;
      CREATE FUNCTION public.sql168_other_trigger() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RETURN NULL; END $f$;
      CREATE TRIGGER aws_loss_draft_route_same_agent AFTER INSERT ON public.loss_draft_tracking FOR EACH ROW EXECUTE FUNCTION public.sql168_other_trigger();
      RESET ROLE;`);
    const squatted = await inspect();
    assert.notEqual(squatted.live_definition_sha256, ABSENT_PRE);
    assert.equal((await apply(ABSENT_PRE)).code, CODES.DEPLOYMENT_COLLISION);
    assert.equal((await fx.admin.query(`SELECT count(*)::int AS n FROM pg_catalog.pg_trigger WHERE tgname = 'aws_loss_draft_route_same_agent' AND tgfoid = 'public.sql168_other_trigger()'::regprocedure`)).rows[0].n, 1);
    await fx.admin.query('DROP TRIGGER aws_loss_draft_route_same_agent ON public.loss_draft_tracking; DROP FUNCTION public.sql168_other_trigger();');
    assert.equal((await inspect()).live_definition_sha256, ABSENT_PRE);

    // A pending pin cannot apply: a pending copy of the committed pin (the committed pin is staging-authorized, wave 60),
    // the pre-state kept recorded.
    const pendingCopy = Object.freeze({ ...pendingPin(PINS[KEY]), expected_live_definition_sha256: ABSENT_PRE });
    const pending = await handlerFor(connect, { pins: { [KEY]: pendingCopy } })(releaseEvent({ pin: pendingCopy }));
    assert.equal(pending.ok, false);
    assert.equal(pending.code, CODES.GUARD_APPLY_FORBIDDEN);
    assert.deepEqual(await present(), NOTHING);

    // An unexpected pre-state: a pin recording the intended state as the pre-state is not a valid authorization
    // package; a pin recording a hash the database does not show refuses on the live state. Nothing applied either way.
    const onIntended = await apply(PINS[KEY].intended_replacement_sha256);
    assert.equal(onIntended.ok, false, JSON.stringify(onIntended));
    assert.equal(onIntended.code, CODES.INVALID_MANIFEST);
    assert.deepEqual(await present(), NOTHING);
    const unknown = await apply('f'.repeat(64));
    assert.equal(unknown.ok, false, JSON.stringify(unknown));
    assert.equal(unknown.code, CODES.DEPLOYMENT_COLLISION);
    assert.deepEqual(await present(), NOTHING);
    assert.equal((await inspect()).live_definition_sha256, ABSENT_PRE);

    // One apply on the intended fingerprint: the functions (owned by the login, EXECUTE for the owner only) and the
    // triggers exist; the live renderings are the spec's (the fingerprint includes them).
    const applied = await apply(ABSENT_PRE);
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.before_hash, ABSENT_PRE);
    assert.equal(applied.details.receipt.after_hash, PINS[KEY].intended_replacement_sha256);
    const after = await inspect();
    assert.equal(after.already_applied, true);
    assert.equal(after.live_definition_sha256, PINS[KEY].intended_replacement_sha256);
    assert.deepEqual(after.precondition_failures, []);
    assert.deepEqual(after.release_sql_inspect.functions.map((fn) => fn.state), ['intended', 'intended']);
    assert.deepEqual(await present(), { route: true, trig: true, triggers: 2 });
    for (const identity of IDENTITIES) {
      assert.deepEqual(await executeAcl(identity), { owner: 'checksops_admin', prosecdef: true, proconfig: ['search_path=public, pg_temp', 'row_security=on'], execute: ['checksops_admin'] }, identity);
    }
    const rendered = (await fx.admin.query(`SET search_path = pg_catalog; SELECT t.tgname AS name, pg_catalog.pg_get_triggerdef(t.oid) AS def
      FROM pg_catalog.pg_trigger t WHERE t.tgname IN ('aws_loss_draft_route_same_agent', 'aws_check_claim_route_same_agent') ORDER BY t.tgname DESC; RESET search_path;`))[1].rows;
    assert.deepEqual(rendered, TRIGGERS.map((tr) => ({ name: tr.name, def: tr.def })));
    // A second apply: refused, the database already past the pinned pre-state.
    assert.equal((await apply(ABSENT_PRE)).code, CODES.UNRELATED_MUTATION);
    assert.equal((await apply(after.live_definition_sha256)).ok, false);
    assert.equal((await inspect()).live_definition_sha256, PINS[KEY].intended_replacement_sha256);
  } finally {
    await fx.close();
  }
});
