/**
 * Production apply of ledger migration 20261007193200
 * (CREATE OR REPLACE public.sync_homeowner_ledger_from_check()).
 *
 * Mirrors the staging guarded executor's ledger handler: replace-only, the live
 * definition must equal the pinned before-hash, the result must equal the pinned
 * after-hash, preserved functions, ledger triggers and homeowner_ledger_events rows
 * must be unchanged, all inside one transaction that rolls back on any mismatch.
 * Runs only on a host with private reachability into the production VPC.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CODES, fail, ok } from './errors.mjs';
import { readFunctionDef } from './function-def-lookup.mjs';
import { evaluateProductionGate } from './production.mjs';
import { evaluateSqlCollision, hashSqlDefinition } from './sql-apply.mjs';
import {
  createProductionDatabaseConnect,
  credentialsToProductionDatabaseUrl,
  isProductionAdminSecretArn,
} from './sql53-production-apply.mjs';
import { repoRootFrom } from './paths.mjs';

export const LEDGER_PRODUCTION_PIN_REL = 'ops/deployment-guard/ledger-20261007193200-production-apply.json';
export const LEDGER_PRODUCTION_COMPONENT = 'production-sql';
export const LEDGER_PRODUCTION_DEPLOYMENT_TYPE = 'sql-apply';

const ONE_USE_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const LEDGER_TRIGGER_SQL = `
SELECT t.tgname AS name, p.proname AS function_name, pg_get_triggerdef(t.oid) AS def
FROM pg_trigger t
JOIN pg_proc p ON p.oid = t.tgfoid
WHERE t.tgrelid = to_regclass($1::text) AND NOT t.tgisinternal
ORDER BY t.tgname
`.trim();
const LEDGER_EVENT_COUNT_SQL = 'SELECT count(*)::text AS n FROM public.homeowner_ledger_events';
// The file may hold exactly one statement: the CREATE OR REPLACE of the pinned function.
const LEDGER_SINGLE_STATEMENT_RE = /^\s*CREATE OR REPLACE FUNCTION public\.sync_homeowner_ledger_from_check\(\)\s+RETURNS TRIGGER\b[^$]*\bAS \$\$(?:(?!\$\$)[\s\S])*\$\$;\s*$/;
const LEDGER_FORBIDDEN_MARKERS = [
  'hle_on_check_intake_insert',
  'claim_ledger_link_or_create',
  'save_claim_settlement_breakdown',
  'one_check_received_writer',
  'aws_can_write_claim',
];

export function loadLedgerProductionPin(root = repoRootFrom(import.meta.url)) {
  return JSON.parse(fs.readFileSync(path.join(root, LEDGER_PRODUCTION_PIN_REL), 'utf8'));
}

export function ledgerSqlForbiddenMutation(sqlText) {
  const text = String(sqlText || '');
  if (!LEDGER_SINGLE_STATEMENT_RE.test(text)) return 'not a single CREATE OR REPLACE of the pinned function';
  if (/\b(DROP|ALTER|GRANT|REVOKE|TRUNCATE|DELETE)\b/i.test(text)) return 'DROP|ALTER|GRANT|REVOKE|TRUNCATE|DELETE';
  if (/\bCREATE\s+(OR\s+REPLACE\s+)?TRIGGER\b/i.test(text)) return 'CREATE TRIGGER';
  for (const marker of LEDGER_FORBIDDEN_MARKERS) {
    if (text.includes(marker)) return marker;
  }
  return null;
}

/** Pinned source bytes, read from the repo and checked against the pin. */
export function readPinnedLedgerSql(root, pin) {
  const file = path.join(root, pin.filename);
  if (!fs.existsSync(file)) return fail(CODES.STALE_PACKAGE, 'pinned ledger migration file is missing');
  const text = fs.readFileSync(file, 'utf8');
  const sha = hashSqlDefinition(text);
  if (sha !== pin.source_sha256) {
    return fail(CODES.SOURCE_RECONCILIATION_REQUIRED, 'ledger migration bytes differ from the production pin', {
      source_sha256: sha,
      pinned_source_sha256: pin.source_sha256,
    });
  }
  const forbidden = ledgerSqlForbiddenMutation(text);
  if (forbidden) {
    return fail(CODES.UNRELATED_MUTATION, 'ledger migration contains a forbidden mutation', { marker: forbidden });
  }
  return ok({ text, source_sha256: sha });
}

export async function readLedgerState(client, pin) {
  const target = await readFunctionDef(client, pin.function_identity);
  if (!target.ok) return target;
  const preserved = [];
  for (const [identity, expected] of Object.entries(pin.preserved_function_definition_sha256)) {
    const lookup = await readFunctionDef(client, identity);
    if (!lookup.ok) return lookup;
    const exists = lookup.details.exists === true;
    preserved.push({
      identity,
      exists,
      definitionSha256: exists ? hashSqlDefinition(lookup.details.definition) : null,
      expectedSha256: expected,
    });
  }
  const triggerRows = (await client.query(LEDGER_TRIGGER_SQL, [pin.trigger_table]))?.rows || [];
  const triggers = triggerRows.map((row) => ({
    name: row.name,
    function_name: row.function_name,
    definitionSha256: hashSqlDefinition(row.def),
  }));
  const eventCount = String((await client.query(LEDGER_EVENT_COUNT_SQL))?.rows?.[0]?.n ?? '');
  const exists = target.details.exists === true;
  return ok({
    exists,
    live_definition_sha256: exists ? hashSqlDefinition(target.details.definition) : null,
    preserved_functions: preserved,
    triggers,
    triggers_sha256: hashSqlDefinition(JSON.stringify(triggers)),
    ledger_event_count: eventCount,
  });
}

export function ledgerPreconditionErrors(state, pin) {
  const drifted = state.preserved_functions
    .filter((row) => row.definitionSha256 !== row.expectedSha256)
    .map((row) => row.identity);
  const byName = new Map(state.triggers.map((row) => [row.name, row.function_name]));
  const missingTriggers = Object.entries(pin.required_ledger_triggers)
    .filter(([name, fn]) => byName.get(name) !== fn)
    .map(([name]) => name);
  return { drifted, missingTriggers };
}

/** Manifest checks shared by preflight and apply: exact pin plus the production gate. */
export function evaluateLedgerProductionApply(input = {}, { root = repoRootFrom(import.meta.url), pin = loadLedgerProductionPin(root) } = {}) {
  const sql = readPinnedLedgerSql(root, pin);
  if (!sql.ok) return sql;
  const mismatched = [
    ['target_environment', 'production'],
    ['target_component', LEDGER_PRODUCTION_COMPONENT],
    ['deployment_type', LEDGER_PRODUCTION_DEPLOYMENT_TYPE],
    ['filename', pin.filename],
    ['migration_id', pin.migration_id],
    ['source_sha256', pin.source_sha256],
    ['expected_live_definition_sha256', pin.expected_live_definition_sha256],
  ].filter(([key, value]) => input[key] !== value).map(([key]) => key);
  if (mismatched.length) {
    return fail(CODES.SQL_COLLISION, 'ledger production apply is bound to the exact production pin', { mismatched });
  }
  const gate = evaluateProductionGate({ ...input, target_environment: 'production' });
  if (!gate.ok) return gate;
  return ok({
    ledger_production_apply_allowed: true,
    function_identity: pin.function_identity,
    expected_live_definition_sha256: pin.expected_live_definition_sha256,
    intended_replacement_sha256: pin.intended_replacement_sha256,
    staging_acceptance: gate.details.staging_acceptance,
  });
}

/**
 * Production admin credentials from the existing secret. The secret records the
 * RDS instance identifier but no host, so the pinned endpoint for that identifier
 * is supplied; credentialsToProductionDatabaseUrl still proves the host.
 */
export async function resolveLedgerDatabaseUrl({ pin, getSecretValue } = {}) {
  if (!isProductionAdminSecretArn(pin.admin_secret_arn)) {
    return fail(CODES.UNRELATED_MUTATION, 'pinned secret is not the existing production checksops_admin secret');
  }
  const loader = typeof getSecretValue === 'function'
    ? getSecretValue
    : async (secretId) => {
      const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
      const response = await new SecretsManagerClient({ region: 'us-east-1' }).send(new GetSecretValueCommand({ SecretId: secretId }));
      return response?.SecretString || null;
    };
  let secret;
  try {
    secret = JSON.parse(String(await loader(pin.admin_secret_arn) || ''));
  } catch {
    return fail(CODES.GUARD_APPLY_FORBIDDEN, 'could not read the production admin secret');
  }
  if (!secret.host) {
    if (secret.dbInstanceIdentifier !== pin.rds_identifier) {
      return fail(CODES.UNRELATED_MUTATION, 'admin secret does not name the pinned production RDS instance', {
        dbInstanceIdentifier: secret.dbInstanceIdentifier || null,
      });
    }
    secret.host = pin.rds_host;
  }
  return credentialsToProductionDatabaseUrl(secret);
}

export async function inspectLedgerProduction({ connect, pin }) {
  const client = await connect();
  try {
    await client.query('BEGIN READ ONLY');
    const state = await readLedgerState(client, pin);
    if (!state.ok) return state;
    const { drifted, missingTriggers } = ledgerPreconditionErrors(state.details, pin);
    return ok({
      read_only: true,
      function_identity: pin.function_identity,
      ...state.details,
      already_applied: state.details.live_definition_sha256 === pin.intended_replacement_sha256,
      apply_preconditions_met: state.details.exists === true
        && state.details.live_definition_sha256 === pin.expected_live_definition_sha256
        && drifted.length === 0
        && missingTriggers.length === 0,
      drifted_preserved_functions: drifted,
      missing_ledger_triggers: missingTriggers,
    });
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end().catch(() => {});
  }
}

function loadConsumed(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { consumed: [] };
  }
}

function consumeOneUse(file, oneUseId) {
  const current = loadConsumed(file);
  current.consumed = [...new Set([...(current.consumed || []), oneUseId])];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(current)}\n`, { mode: 0o600 });
}

export async function executeLedgerProductionApply(input = {}, ctx = {}) {
  const root = ctx.root || repoRootFrom(import.meta.url);
  const pin = ctx.pin || loadLedgerProductionPin(root);
  const evaluation = evaluateLedgerProductionApply(input, { root, pin });
  if (!evaluation.ok) return evaluation;
  if (pin.execute !== true) {
    return fail(CODES.GUARD_APPLY_FORBIDDEN, 'ledger production execute is not authorized by this pin');
  }
  if (input.authorization_phrase !== pin.authorization_phrase) {
    return fail(CODES.PRODUCTION_APPROVAL_REQUIRED, 'ledger production apply requires the exact authorization phrase');
  }
  if (!ONE_USE_RE.test(String(input.one_use_id || ''))) {
    return fail(CODES.INVALID_MANIFEST, 'ledger production apply requires a single-use id');
  }
  const consumedFile = ctx.consumedPath || path.join(root, '.deployment-guard', 'ledger-production-consumed.json');
  if (loadConsumed(consumedFile).consumed.includes(input.one_use_id)) {
    return fail(CODES.RECEIPT_REUSED, 'one_use_id has already been consumed; replay is forbidden', { one_use_id: input.one_use_id });
  }
  const sql = readPinnedLedgerSql(root, pin);
  if (!sql.ok) return sql;
  if (typeof ctx.connect !== 'function') {
    return fail(CODES.GUARD_APPLY_FORBIDDEN, 'ledger production apply requires a database connection factory');
  }

  const client = await ctx.connect();
  let inTx = false;
  const rollback = async (result) => {
    if (inTx) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      inTx = false;
    }
    return result;
  };
  try {
    await client.query('BEGIN');
    inTx = true;
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [pin.function_identity]);

    const before = await readLedgerState(client, pin);
    if (!before.ok) return rollback(before);
    if (before.details.exists !== true) {
      return rollback(fail(CODES.SQL_COLLISION, 'ledger apply is replace-only; the function is missing', { function_identity: pin.function_identity }));
    }
    if (before.details.live_definition_sha256 === pin.intended_replacement_sha256) {
      return rollback(fail(CODES.UNRELATED_MUTATION, 'ledger function already matches the intended definition; refuse replace', {
        live_definition_sha256: before.details.live_definition_sha256,
      }));
    }
    const collision = evaluateSqlCollision({
      filename: pin.filename,
      migration_id: pin.migration_id,
      source_sha256: pin.source_sha256,
      target_environment: 'production',
      expected_live_definition_sha256: pin.expected_live_definition_sha256,
      live_definition_sha256: before.details.live_definition_sha256,
    });
    if (!collision.ok) return rollback(collision);
    const pre = ledgerPreconditionErrors(before.details, pin);
    if (pre.drifted.length || pre.missingTriggers.length) {
      return rollback(fail(CODES.DEPLOYMENT_COLLISION, 'ledger preconditions do not hold immediately before apply', {
        drifted_preserved_functions: pre.drifted,
        missing_ledger_triggers: pre.missingTriggers,
      }));
    }

    await client.query(sql.details.text);

    const after = await readLedgerState(client, pin);
    if (!after.ok) return rollback(after);
    if (after.details.live_definition_sha256 !== pin.intended_replacement_sha256) {
      return rollback(fail(CODES.SQL_COLLISION, 'applied ledger definition does not match the intended hash', {
        after_hash: after.details.live_definition_sha256,
        intended_replacement_sha256: pin.intended_replacement_sha256,
      }));
    }
    const post = ledgerPreconditionErrors(after.details, pin);
    if (post.drifted.length || post.missingTriggers.length || after.details.triggers_sha256 !== before.details.triggers_sha256) {
      return rollback(fail(CODES.UNRELATED_MUTATION, 'ledger apply changed a preserved function or trigger', {
        drifted_preserved_functions: post.drifted,
        missing_ledger_triggers: post.missingTriggers,
        triggers_before_sha256: before.details.triggers_sha256,
        triggers_after_sha256: after.details.triggers_sha256,
      }));
    }
    if (after.details.ledger_event_count !== before.details.ledger_event_count) {
      return rollback(fail(CODES.UNRELATED_MUTATION, 'ledger apply changed homeowner_ledger_events rows', {
        before: before.details.ledger_event_count,
        after: after.details.ledger_event_count,
      }));
    }

    await client.query('COMMIT');
    inTx = false;
    consumeOneUse(consumedFile, input.one_use_id);
    return ok({
      receipt: {
        workstream: input.workstream_id,
        commit: input.commit,
        sql_file: pin.filename,
        function_identity: pin.function_identity,
        before_hash: before.details.live_definition_sha256,
        after_hash: after.details.live_definition_sha256,
        triggers_sha256: after.details.triggers_sha256,
        ledger_event_count: after.details.ledger_event_count,
        staging_acceptance: evaluation.details.staging_acceptance,
        result: 'applied',
      },
    });
  } catch (error) {
    return rollback(fail(CODES.SQL_COLLISION, 'ledger production apply failed and was rolled back', {
      message: String(error?.message || error).slice(0, 300),
    }));
  } finally {
    await client.end().catch(() => {});
  }
}

export { createProductionDatabaseConnect };
