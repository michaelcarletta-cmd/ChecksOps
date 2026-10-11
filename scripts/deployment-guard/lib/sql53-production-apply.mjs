/**
 * Dedicated production SQL 53 apply path.
 *
 * Reuses the approved settlement file, create-only classifier, and official
 * catalog queries. Does not change the staging executor or its production refuse.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CODES, fail, ok } from './errors.mjs';
import { evaluateProductionGate } from './production.mjs';
import { repoRootFrom } from './paths.mjs';
import { evaluateSqlCollision, hashSqlDefinition } from './sql-apply.mjs';
import {
  AUTHORIZED_SQL53,
  classifySql53CreateLive,
} from './sql-executor-auth.mjs';
import { loadSql53Pin } from './sql53-staging-apply.mjs';

// Keep catalog constants here so Deployment Guard CI can load this module
// without installing Lambda runtime `pg`. Do not import
// sql53-production-readonly-inspect.mjs from this file.

export const SQL53_FUNCTION_DEF_INSPECT_SQL = `
SELECT n.nspname AS schema_name,
       p.proname AS function_name,
       pg_get_functiondef(p.oid) AS def
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = $1::text
  AND p.proname = $2::text
  AND p.pronargs = COALESCE(cardinality($3::text[]), 0)
  AND (
    SELECT COALESCE(ARRAY_AGG(proc_t.typ ORDER BY proc_t.ord), ARRAY[]::oid[])
    FROM unnest(p.proargtypes::oid[]) WITH ORDINALITY AS proc_t(typ, ord)
  ) = (
    SELECT COALESCE(ARRAY_AGG(u.typ::regtype::oid ORDER BY u.ord), ARRAY[]::oid[])
    FROM unnest(COALESCE($3::text[], ARRAY[]::text[])) WITH ORDINALITY AS u(typ, ord)
  )
`.trim();

export const SQL53_SETTLEMENT_COLUMN_INSPECT_SQL = `SELECT a.attname AS column_name
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname = 'claim_settlements'
  AND a.attnum > 0
  AND NOT a.attisdropped
  AND a.attname = ANY($1::text[])`;

export const SQL53_LEDGER_TRIGGER_INSPECT_SQL = `SELECT c.relname AS table_name,
       t.tgname AS trigger_name
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND NOT t.tgisinternal
  AND c.relname = $1::text
  AND t.tgname = ANY($2::text[])`;

export const SQL53_PINNED_FUNCTION_LOOKUPS = Object.freeze([
  Object.freeze({
    identity: 'public.save_claim_settlement_breakdown(uuid,uuid,jsonb)',
    schema: 'public',
    name: 'save_claim_settlement_breakdown',
    argTypes: Object.freeze(['uuid', 'uuid', 'jsonb']),
  }),
  Object.freeze({
    identity: 'public.sync_homeowner_ledger_from_check()',
    schema: 'public',
    name: 'sync_homeowner_ledger_from_check',
    argTypes: Object.freeze([]),
  }),
  Object.freeze({
    identity: 'public.aws_can_write_claim(uuid)',
    schema: 'public',
    name: 'aws_can_write_claim',
    argTypes: Object.freeze(['uuid']),
  }),
  Object.freeze({
    identity: 'public.hle_on_check_intake_insert()',
    schema: 'public',
    name: 'hle_on_check_intake_insert',
    argTypes: Object.freeze([]),
  }),
]);

export const SQL53_REQUIRED_SETTLEMENT_COLUMNS = Object.freeze([
  'replacement_cost_value',
  'recoverable_depreciation',
  'non_recoverable_depreciation',
  'deductible',
  'other_structures_rcv',
  'other_structures_recoverable_depreciation',
  'other_structures_non_recoverable_depreciation',
  'other_structures_deductible',
  'pwi_rcv',
  'pwi_recoverable_depreciation',
  'pwi_non_recoverable_depreciation',
  'personal_property_rcv',
  'personal_property_recoverable_depreciation',
  'personal_property_non_recoverable_depreciation',
  'ale_rcv',
  'ale_recoverable_depreciation',
  'ale_non_recoverable_depreciation',
]);

export const SQL53_REQUIRED_LEDGER_TRIGGERS = Object.freeze([
  Object.freeze({ table: 'check_intake_items', trigger: 'trg_sync_homeowner_ledger_ins' }),
  Object.freeze({ table: 'check_intake_items', trigger: 'trg_sync_homeowner_ledger_upd' }),
  Object.freeze({ table: 'check_intake_items', trigger: 'trg_hle_check_intake_insert' }),
]);

export const SQL53_PRODUCTION_RDS_IDENTIFIER = 'checksops-production';

export function secretHostBindsProvenRds(host, identifier = SQL53_PRODUCTION_RDS_IDENTIFIER) {
  if (typeof host !== 'string') return false;
  const hostname = host.trim().toLowerCase().replace(/\.$/, '');
  if (!hostname || hostname.length > 253 || /[\s:/@\\?#]/.test(hostname)) return false;
  if (!hostname.endsWith('.rds.amazonaws.com')) return false;
  const labels = hostname.split('.');
  if (labels.length < 5 || labels[0] !== identifier) return false;
  if (hostname.includes('checksops-staging')) return false;
  return true;
}

export const SQL53_PRODUCTION_APPLY_DEPLOYMENT_TYPE = 'sql53-production-apply';
export const SQL53_PRODUCTION_APPLY_COMPONENT = 'production-sql';
export const SQL53_PRODUCTION_APPLY_PHRASE = 'CREATE_SAVE_CLAIM_SETTLEMENT_BREAKDOWN';
export const SQL53_PRODUCTION_DATABASE_URL_ENV = 'CHECKSOPS_SQL53_PRODUCTION_DATABASE_URL';
export const SQL53_PRODUCTION_APPLY_PIN_REL = 'ops/deployment-guard/sql53-production-apply.json';
export const SQL53_PRODUCTION_LEDGER_REL = 'ops/release-locks/applied-migrations.ledger.json';

export const SQL53_FORBIDDEN_MARKERS = Object.freeze([
  'claim_ledger_link_or_create',
  'sync_homeowner_ledger_from_check',
  'hle_on_check_intake_insert',
  '20261007193200',
  'one_check_received_writer',
]);

const SHA256_RE = /^[0-9a-f]{64}$/;
const ONE_USE_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const PRESERVED_COUNT_SQL = `SELECT
  (SELECT count(*)::int FROM public.claim_settlements) AS claim_settlements,
  (SELECT count(*)::int FROM public.check_intake_items) AS check_intake_items,
  (SELECT count(*)::int FROM public.payments) AS payments,
  (SELECT count(*)::int FROM public.homeowner_ledger) AS homeowner_ledger`;

export function loadSql53ProductionApplyPin(root = repoRootFrom(import.meta.url)) {
  return JSON.parse(fs.readFileSync(path.join(root, SQL53_PRODUCTION_APPLY_PIN_REL), 'utf8'));
}

export function isSql53ProductionApply(input = {}, ctx = {}) {
  const root = ctx.root || input.root || repoRootFrom(import.meta.url);
  const pin = input.pin || loadSql53ProductionApplyPin(root);
  return (input.deployment_type || input.type) === SQL53_PRODUCTION_APPLY_DEPLOYMENT_TYPE
    || ((input.target_environment || input.environment) === 'production'
      && (input.filename === pin.filename || input.migration_id === pin.migration_id)
      && (input.deployment_type === SQL53_PRODUCTION_APPLY_DEPLOYMENT_TYPE));
}

export function hashFileSha256(root, rel) {
  return createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex');
}

export function sql53ContainsForbiddenMutation(sqlText) {
  const text = String(sqlText || '');
  if (/\bDROP\s+(FUNCTION|TRIGGER|TABLE)\b/i.test(text)) return 'DROP FUNCTION|TRIGGER|TABLE';
  if (/\bCREATE\s+TABLE\b/i.test(text)) return 'CREATE TABLE';
  if (/\bALTER\s+TABLE\b/i.test(text)) return 'ALTER TABLE';
  if (/\bCREATE\s+TRIGGER\b/i.test(text)) return 'CREATE TRIGGER';
  for (const marker of SQL53_FORBIDDEN_MARKERS) {
    if (text.includes(marker)) return marker;
  }
  return null;
}

export function evaluateSql53SourcePin(root, pin = loadSql53ProductionApplyPin(root)) {
  const stagingPin = loadSql53Pin(root);
  if (pin.filename !== AUTHORIZED_SQL53.filename || pin.filename !== stagingPin.filename) {
    return fail(CODES.SQL_COLLISION, 'production SQL 53 apply must reuse the approved settlement file');
  }
  if (pin.source_sha256 !== AUTHORIZED_SQL53.source_sha256 || pin.source_sha256 !== stagingPin.source_sha256) {
    return fail(CODES.SQL_COLLISION, 'production SQL 53 apply must reuse the approved source SHA-256');
  }
  if (pin.function_identity !== AUTHORIZED_SQL53.function_identity) {
    return fail(CODES.SQL_COLLISION, 'production SQL 53 apply may target only save_claim_settlement_breakdown(uuid,uuid,jsonb)');
  }
  if (hashFileSha256(root, pin.filename) !== pin.source_sha256) {
    return fail(CODES.SQL_COLLISION, 'SQL 53 source bytes do not match the approved production apply pin');
  }
  const text = fs.readFileSync(path.join(root, pin.filename), 'utf8');
  const forbidden = sql53ContainsForbiddenMutation(text);
  if (forbidden) {
    return fail(CODES.UNRELATED_MUTATION, 'SQL 53 source contains a forbidden unrelated mutation', { marker: forbidden });
  }
  return ok({
    filename: pin.filename,
    source_sha256: pin.source_sha256,
    function_identity: pin.function_identity,
  });
}

export function evaluateSql53ReleaseLock(root, pin = loadSql53ProductionApplyPin(root)) {
  const ledger = JSON.parse(fs.readFileSync(path.join(root, SQL53_PRODUCTION_LEDGER_REL), 'utf8'));
  const applied = (ledger.entries || []).find((row) => (
    (row.path === pin.filename || row.migration_id === pin.migration_id)
    && row.applied === true
    && (row.applied_environment === 'production' || row.environment === 'production')
  ));
  if (applied) {
    return fail(CODES.UNRELATED_MUTATION, 'SQL 53 is already marked applied on the production release-lock ledger', {
      id: applied.id || null,
    });
  }
  return ok({
    exclusive: true,
    component: SQL53_PRODUCTION_APPLY_COMPONENT,
    ledger: SQL53_PRODUCTION_LEDGER_REL,
    already_applied: false,
  });
}

function dependencyBaseline(pin, input = {}) {
  if (input.harness === true && input.synthetic_baseline && typeof input.synthetic_baseline === 'object') {
    return input.synthetic_baseline;
  }
  return pin.preserved_function_definition_sha256 || {};
}

export function evaluateSql53ProductionCatalog(inspect = {}, pin = {}, input = {}) {
  const functions = Array.isArray(inspect.functions) ? inspect.functions : [];
  const settlement = functions.find((row) => row?.identity === pin.function_identity);
  const liveHash = settlement?.exists === true && SHA256_RE.test(String(settlement.definitionSha256 || ''))
    ? settlement.definitionSha256
    : pin.absent_live_definition_sha256;
  const create = classifySql53CreateLive({
    exists: settlement?.exists === true,
    live_definition_sha256: liveHash,
  }, {
    ...AUTHORIZED_SQL53,
    intended_replacement_sha256: pin.intended_replacement_sha256 || pin.intended_definition_sha256,
    absent_live_definition_sha256: pin.absent_live_definition_sha256,
    function_identity: pin.function_identity,
  });
  if (!create.ok) return create;

  const baseline = dependencyBaseline(pin, input);
  for (const identity of pin.preserved_function_identities || []) {
    const row = functions.find((item) => item?.identity === identity);
    if (row?.exists !== true) {
      return fail(CODES.SQL_COLLISION, 'SQL 53 production apply refuses to run when a preserved function is missing', {
        identity,
      });
    }
    const expected = baseline[identity];
    if (SHA256_RE.test(String(expected || '')) && row.definitionSha256 !== expected) {
      return fail(CODES.SQL_COLLISION, 'a preserved function differs from the accepted baseline', {
        identity,
        expected,
        observed: row.definitionSha256 || null,
      });
    }
  }

  const columns = Array.isArray(inspect.settlementColumns) ? inspect.settlementColumns : [];
  const missingColumns = (pin.preserved_settlement_columns || SQL53_REQUIRED_SETTLEMENT_COLUMNS)
    .filter((column) => !columns.some((row) => row?.column === column && row.exists === true));
  if (missingColumns.length) {
    return fail(CODES.SQL_COLLISION, 'SQL 53 production apply refuses to run when a settlement column is missing', {
      missing: missingColumns,
    });
  }

  const triggers = Array.isArray(inspect.ledgerTriggers) ? inspect.ledgerTriggers : [];
  const missingTriggers = (pin.preserved_ledger_triggers || []).filter((trigger) => (
    !triggers.some((row) => row?.trigger === trigger && row.exists === true)
  ));
  if (missingTriggers.length) {
    return fail(CODES.SQL_COLLISION, 'SQL 53 production apply refuses to run when a ledger trigger is missing', {
      missing: missingTriggers,
    });
  }

  return ok({
    state: 'absent',
    live_definition_sha256: pin.absent_live_definition_sha256,
    function_identity: pin.function_identity,
  });
}

export function evaluateSql53ProductionApply(input = {}, ctx = {}) {
  const root = ctx.root || input.root || repoRootFrom(import.meta.url);
  const pin = ctx.pin || loadSql53ProductionApplyPin(root);

  if (input.sql_text != null || input.sql != null || input.statement != null || input.arbitrary_sql != null) {
    return fail(CODES.UNRELATED_MUTATION, 'arbitrary SQL text is forbidden; SQL 53 may apply only the pinned source file');
  }
  if ((input.target_environment || input.environment) !== 'production') {
    return fail(CODES.INVALID_MANIFEST, 'SQL 53 production apply requires target_environment=production');
  }
  if ((input.target_component || input.component) !== SQL53_PRODUCTION_APPLY_COMPONENT) {
    return fail(CODES.RECEIPT_MISMATCH, 'SQL 53 production apply requires component=production-sql');
  }
  if ((input.deployment_type || pin.deployment_type) !== SQL53_PRODUCTION_APPLY_DEPLOYMENT_TYPE) {
    return fail(
      CODES.RECEIPT_MISMATCH,
      'SQL 53 production apply requires deployment_type=sql53-production-apply; staging receipts are not an escape hatch',
    );
  }
  if (input.filename && input.filename !== pin.filename) {
    return fail(CODES.UNRELATED_MUTATION, 'production SQL 53 apply may own only the pinned settlement file');
  }
  if (input.function_name === 'checksops-staging-guarded-sql-executor'
    || input.function_name === 'checksops-production-prep-api') {
    return fail(CODES.UNRELATED_MUTATION, 'production SQL 53 apply must not retarget the staging executor or production API');
  }

  const source = evaluateSql53SourcePin(root, pin);
  if (!source.ok) return source;
  const lock = evaluateSql53ReleaseLock(root, pin);
  if (!lock.ok) return lock;

  const production = evaluateProductionGate(input);
  if (!production.ok) return production;

  const inspect = input.inspect || input.catalog || null;
  if (inspect) {
    const catalog = evaluateSql53ProductionCatalog(inspect, pin, input);
    if (!catalog.ok) return catalog;
  } else if (input.action === 'apply' || input.execute === true || input.apply === true) {
    return fail(
      CODES.SQL_COLLISION,
      'SQL 53 production apply requires a fresh read-only catalog immediately before apply',
    );
  }

  const applying = input.action === 'apply' || input.execute === true || input.apply === true;
  if (applying) {
    if (input.authorization_phrase !== pin.authorization_phrase) {
      return fail(CODES.PRODUCTION_APPROVAL_REQUIRED, 'SQL 53 production apply requires the exact authorization phrase');
    }
    if (pin.execute !== true && input.harness !== true) {
      return fail(
        CODES.GUARD_APPLY_FORBIDDEN,
        'SQL 53 production execute is not authorized by this pin; independent execute authorization is required',
        { apply_authorized: false, execute: false },
      );
    }
    if (!ONE_USE_RE.test(String(input.one_use_id || ''))) {
      return fail(CODES.INVALID_MANIFEST, 'SQL 53 production apply requires a single-use receipt id');
    }
    if (input.expected_live_definition_sha256
      && input.expected_live_definition_sha256 !== pin.absent_live_definition_sha256) {
      return fail(CODES.DEPLOYMENT_COLLISION, 'expected live fingerprint is not the absent-function hash');
    }
  }

  return ok({
    sql53_production_executor_ready: true,
    apply_authorized: pin.apply_authorized === true,
    execute: pin.execute === true,
    apply_executed: false,
    function_identity: pin.function_identity,
    filename: pin.filename,
    source_sha256: pin.source_sha256,
    intended_definition_sha256: pin.intended_definition_sha256,
    deployment_type: SQL53_PRODUCTION_APPLY_DEPLOYMENT_TYPE,
    release_lock: lock.details,
    independent_execute_authorization_required: pin.execute !== true,
  });
}

function classifyInspectRows(rows) {
  if (!Array.isArray(rows)) return { complete: false };
  if (rows.length === 0) return { complete: true, exists: false, definitionSha256: null };
  if (rows.length !== 1 || typeof rows[0]?.def !== 'string' || !rows[0].def) {
    return { complete: false };
  }
  return { complete: true, exists: true, definitionSha256: hashSqlDefinition(rows[0].def) };
}

export async function inspectSql53ProductionCatalog(client) {
  const functions = [];
  for (const target of SQL53_PINNED_FUNCTION_LOOKUPS) {
    const result = await client.query(SQL53_FUNCTION_DEF_INSPECT_SQL, [
      target.schema,
      target.name,
      [...target.argTypes],
    ]);
    const classified = classifyInspectRows(result?.rows);
    if (!classified.complete) {
      return fail(CODES.SQL_COLLISION, 'sql53 function catalog evidence is incomplete', {
        identity: target.identity,
      });
    }
    functions.push({
      identity: target.identity,
      exists: classified.exists === true,
      definitionSha256: classified.definitionSha256,
    });
  }

  const columnResult = await client.query(
    SQL53_SETTLEMENT_COLUMN_INSPECT_SQL,
    [[...SQL53_REQUIRED_SETTLEMENT_COLUMNS]],
  );
  const presentColumns = new Set((columnResult?.rows || []).map((row) => String(row.column_name || '')));
  const settlementColumns = SQL53_REQUIRED_SETTLEMENT_COLUMNS.map((column) => ({
    table: 'claim_settlements',
    column,
    exists: presentColumns.has(column),
  }));

  const triggerResult = await client.query(SQL53_LEDGER_TRIGGER_INSPECT_SQL, [
    'check_intake_items',
    SQL53_REQUIRED_LEDGER_TRIGGERS.map((row) => row.trigger),
  ]);
  const presentTriggers = new Set(
    (triggerResult?.rows || []).map((row) => `${row.table_name || ''}\0${row.trigger_name || ''}`),
  );
  const ledgerTriggers = SQL53_REQUIRED_LEDGER_TRIGGERS.map((row) => ({
    table: row.table,
    trigger: row.trigger,
    exists: presentTriggers.has(`${row.table}\0${row.trigger}`),
  }));

  return ok({
    readOnly: true,
    functions,
    settlementColumns,
    ledgerTriggers,
  });
}

function loadConsumed(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { consumed: [] };
  }
}

function isConsumed(file, oneUseId) {
  return loadConsumed(file).consumed.includes(oneUseId);
}

function consumeOneUse(file, oneUseId) {
  const current = loadConsumed(file);
  current.consumed = [...new Set([...(current.consumed || []), oneUseId])];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(current)}\n`, { mode: 0o600 });
}

async function rollbackApply(client, inTx) {
  if (!inTx) return false;
  try { await client.query('ROLLBACK'); } catch { /* ignore */ }
  return false;
}

export async function executeSql53ProductionApply(input = {}, ctx = {}) {
  const root = ctx.root || input.root || repoRootFrom(import.meta.url);
  const pin = ctx.pin || loadSql53ProductionApplyPin(root);
  const pinCheck = evaluateSql53ProductionApply({
    ...input,
    action: 'inspect',
    execute: false,
    apply: false,
  }, { root, pin });
  if (!pinCheck.ok) return pinCheck;

  if (input.authorization_phrase !== pin.authorization_phrase) {
    return fail(CODES.PRODUCTION_APPROVAL_REQUIRED, 'SQL 53 production apply requires the exact authorization phrase');
  }
  if (pin.execute !== true && input.harness !== true) {
    return fail(
      CODES.GUARD_APPLY_FORBIDDEN,
      'SQL 53 production execute is not authorized by this pin; independent execute authorization is required',
      { apply_authorized: false, execute: false },
    );
  }
  if (!ONE_USE_RE.test(String(input.one_use_id || ''))) {
    return fail(CODES.INVALID_MANIFEST, 'SQL 53 production apply requires a single-use receipt id');
  }
  const connect = typeof ctx.connect === 'function'
    ? ctx.connect
    : createProductionDatabaseConnect(ctx.databaseUrl, { root });
  if (typeof connect !== 'function') {
    return fail(CODES.GUARD_APPLY_FORBIDDEN, 'SQL 53 production apply requires an injected or existing database connection factory');
  }

  const consumedFile = ctx.consumedPath || path.join(root, '.deployment-guard', 'sql53-production-consumed.json');
  if (isConsumed(consumedFile, input.one_use_id)) {
    return fail(CODES.RECEIPT_REUSED, 'one_use_id has already been consumed; replay is forbidden', {
      one_use_id: input.one_use_id,
    });
  }

  const sqlText = fs.readFileSync(path.join(root, pin.filename), 'utf8');
  const forbidden = sql53ContainsForbiddenMutation(sqlText);
  if (forbidden) {
    return fail(CODES.UNRELATED_MUTATION, 'embedded SQL 53 contains a forbidden unrelated mutation', { marker: forbidden });
  }

  let client;
  let inTx = false;
  try {
    client = await connect();
    const beforeCatalog = await inspectSql53ProductionCatalog(client);
    if (!beforeCatalog.ok) return beforeCatalog;
    const catalog = evaluateSql53ProductionCatalog(beforeCatalog.details, pin, input);
    if (!catalog.ok) return catalog;

    const countsBefore = (await client.query(PRESERVED_COUNT_SQL)).rows[0];

    await client.query('BEGIN');
    inTx = true;
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [pin.function_identity]);

    const lockedCatalog = await inspectSql53ProductionCatalog(client);
    if (!lockedCatalog.ok) {
      inTx = await rollbackApply(client, inTx);
      return lockedCatalog;
    }
    const locked = evaluateSql53ProductionCatalog(lockedCatalog.details, pin, input);
    if (!locked.ok) {
      inTx = await rollbackApply(client, inTx);
      return locked;
    }

    const liveHash = pin.absent_live_definition_sha256;
    const expectedLive = input.expected_live_definition_sha256 || liveHash;
    if (expectedLive !== liveHash) {
      inTx = await rollbackApply(client, inTx);
      return fail(CODES.DEPLOYMENT_COLLISION, 'expected live fingerprint changed immediately before apply', {
        expected_live_definition_sha256: expectedLive,
        live_definition_sha256: liveHash,
      });
    }

    const collision = evaluateSqlCollision({
      filename: pin.filename,
      migration_id: pin.migration_id,
      source_sha256: pin.source_sha256,
      target_environment: 'production',
      expected_live_definition_sha256: expectedLive,
      live_definition_sha256: liveHash,
    });
    if (!collision.ok) {
      inTx = await rollbackApply(client, inTx);
      return collision;
    }

    await client.query(sqlText);

    const afterCatalog = await inspectSql53ProductionCatalog(client);
    if (!afterCatalog.ok) {
      inTx = await rollbackApply(client, inTx);
      return afterCatalog;
    }
    const settlement = afterCatalog.details.functions.find((row) => row.identity === pin.function_identity);
    if (settlement?.exists !== true || settlement.definitionSha256 !== pin.intended_definition_sha256) {
      inTx = await rollbackApply(client, inTx);
      return fail(CODES.SQL_COLLISION, 'applied settlement definition does not match the intended hash', {
        after_hash: settlement?.definitionSha256 || null,
        intended_definition_sha256: pin.intended_definition_sha256,
      });
    }

    const afterDeps = evaluateSql53ProductionCatalog({
      ...afterCatalog.details,
      functions: afterCatalog.details.functions.map((row) => (
        row.identity === pin.function_identity
          ? { ...row, exists: false, definitionSha256: pin.absent_live_definition_sha256 }
          : row
      )),
    }, pin, input);
    if (!afterDeps.ok) {
      inTx = await rollbackApply(client, inTx);
      return fail(CODES.SQL_COLLISION, 'apply changed a preserved dependency', afterDeps.details);
    }

    const countsAfter = (await client.query(PRESERVED_COUNT_SQL)).rows[0];
    for (const table of Object.keys(countsBefore || {})) {
      if (Number(countsAfter[table]) !== Number(countsBefore[table])) {
        inTx = await rollbackApply(client, inTx);
        return fail(CODES.UNRELATED_MUTATION, 'apply mutated preserved financial or ledger row counts', {
          table,
          before: countsBefore[table],
          after: countsAfter[table],
        });
      }
    }

    await client.query('COMMIT');
    inTx = false;
    consumeOneUse(consumedFile, input.one_use_id);
    return ok({
      apply_executed: true,
      function_identity: pin.function_identity,
      live_definition_sha256: settlement.definitionSha256,
      before_hash: pin.absent_live_definition_sha256,
      after_hash: settlement.definitionSha256,
      preserved_row_counts: countsAfter,
      inspect: afterCatalog.details,
      rollback: pin.rollback,
    });
  } catch (error) {
    inTx = await rollbackApply(client, inTx);
    return fail(CODES.SQL_COLLISION, error?.message || 'SQL 53 production apply failed closed');
  } finally {
    try { await client?.end?.(); } catch { /* ignore */ }
  }
}

export function resolveProductionDatabaseUrl(env = process.env, { harness = false } = {}) {
  if (harness === true) {
    return ok({ harness: true, url: null });
  }
  const raw = String(env[SQL53_PRODUCTION_DATABASE_URL_ENV] || '').trim();
  if (!raw) {
    return fail(
      CODES.GUARD_APPLY_FORBIDDEN,
      'SQL 53 production apply requires the existing production database URL; do not create Cursor OIDC access',
      { env: SQL53_PRODUCTION_DATABASE_URL_ENV },
    );
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return fail(CODES.INVALID_MANIFEST, 'SQL 53 production database URL is invalid');
  }
  if (!secretHostBindsProvenRds(parsed.hostname)) {
    return fail(CODES.UNRELATED_MUTATION, 'SQL 53 production apply refused a database host that is not the proven production RDS', {
      host: parsed.hostname,
    });
  }
  if (/checksops-staging/i.test(parsed.hostname) || /cursor/i.test(parsed.username || '')) {
    return fail(CODES.UNRELATED_MUTATION, 'SQL 53 production apply refused a staging or Cursor identity database target');
  }
  return ok({ url: raw, host: parsed.hostname });
}

export function createProductionDatabaseConnect(url, { root = repoRootFrom(import.meta.url) } = {}) {
  const connectionString = String(url || '').trim();
  if (!connectionString) return undefined;
  return async () => {
    const { Client } = await import('pg');
    const caPath = path.join(root, 'aws/functions/api/rds-global-bundle.pem');
    const client = new Client({
      connectionString,
      ssl: fs.existsSync(caPath)
        ? { rejectUnauthorized: true, ca: fs.readFileSync(caPath, 'utf8') }
        : { rejectUnauthorized: true },
      connectionTimeoutMillis: 8000,
      query_timeout: 30000,
    });
    await client.connect();
    return client;
  };
}
