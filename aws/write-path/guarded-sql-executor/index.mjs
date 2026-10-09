/**
 * Staging-only VPC SQL executor for the reviewed Claim Ledger SQL 44.
 * Fail closed. No arbitrary SQL. No create_new. No production.
 * CREATE OR REPLACE must not invoke the function.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODES, fail, ok } from './lib/errors.mjs';
import { functionDefsMatchExactly, readFunctionDef } from './lib/function-def-lookup.mjs';
import { evaluateSqlCollision, hashSqlDefinition } from './lib/sql-apply.mjs';
import {
  AUTHORIZED_SQL44,
  AUTHORIZED_SQL53,
  AUTHORIZED_TENANT_USERS_SAME_CHECK_PERMISSIONS,
  SQL_EXECUTOR_FUNCTION,
  classifySql53CreateLive,
  evaluateSqlExecutorAuthorization,
  isSql44AuthorizedMigration,
  isSql53AuthorizedMigration,
  isTenantUsersSameCheckPermissions,
} from './lib/sql-executor-auth.mjs';

export { readFunctionDef } from './lib/function-def-lookup.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SQL_FILE = path.join(ROOT, 'sql/44_claim_ledger_link_or_create.sql');
const TENANT_PERMISSIONS_SQL_FILE = path.join(
  ROOT,
  'sql/20261001231500_tenant_users_same_check_permissions.sql',
);
const TENANT_PERMISSIONS_PREDECESSOR_SQL_FILE = path.join(
  ROOT,
  'sql/20261001193100_tenant_users_can_override_check_status.sql',
);
const SQL53_FILE = path.join(ROOT, 'sql/53_claim_settlement_breakdown.sql');
const SQL53_FORBIDDEN_MARKERS = [
  'claim_ledger_link_or_create',
  'sync_homeowner_ledger_from_check',
  'hle_on_check_intake_insert',
  '20261007193200',
  'one_check_received_writer',
];
const CA_CANDIDATES = [
  path.join(ROOT, 'rds-global-bundle.pem'),
  '/var/task/rds-global-bundle.pem',
];
function consumedPath() {
  return process.env.SQL_EXECUTOR_CONSUMED_PATH || '/tmp/guarded-sql-executor-consumed.json';
}
const CLAIM_NUMBER = '695064-GQ';
const TENANT_ID = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const BEHAVIOR_MARKERS = [
  'same_tenant_detected_count',
  'same_tenant_unlinked_count',
  'same_tenant_already_linked_count',
  'ocr_claim_number_key',
];
const FORBIDDEN_GRANT_MARKERS = [
  'GRANT INSERT ON TABLE public.claims',
  'GRANT UPDATE ON TABLE public.check_intake_items',
  'GRANT UPDATE (claim_id)',
];

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file), 'utf8').digest('hex');
}

function loadConsumed() {
  try {
    return JSON.parse(fs.readFileSync(consumedPath(), 'utf8'));
  } catch {
    return { ids: [] };
  }
}

function consumeOneUse(id) {
  const current = loadConsumed();
  if (!current.ids.includes(id)) current.ids.push(id);
  fs.writeFileSync(consumedPath(), `${JSON.stringify(current)}\n`);
}

function isConsumed(id) {
  return loadConsumed().ids.includes(id);
}

export function extractPinnedFunctionSql(sqlText, name) {
  const re = new RegExp(
    `CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?(?:\\$function\\$[\\s\\S]*?\\$function\\$|\\$\\$[\\s\\S]*?\\$\\$);`,
    'i',
  );
  const match = String(sqlText || '').match(re);
  return match ? match[0] : null;
}

export function hashTenantPermissionLiveDefs(defs = {}) {
  return hashSqlDefinition(JSON.stringify({
    user_can_move_tenant_checks: defs.user_can_move_tenant_checks || null,
    admin_override_check_status: defs.admin_override_check_status || null,
  }));
}

export function tenantPermissionDefsAreExact(live, sourceText) {
  const intendedMove = extractPinnedFunctionSql(sourceText, 'user_can_move_tenant_checks');
  const intendedOverride = extractPinnedFunctionSql(sourceText, 'admin_override_check_status');
  if (!intendedMove || !intendedOverride) return false;
  if (!live?.user_can_move_tenant_checks || !live?.admin_override_check_status) return false;
  return functionDefsMatchExactly(live.user_can_move_tenant_checks, intendedMove)
    && functionDefsMatchExactly(live.admin_override_check_status, intendedOverride);
}

export function tenantPermissionMarkersMatch(live = {}) {
  const move = String(live.user_can_move_tenant_checks || '');
  const override = String(live.admin_override_check_status || '');
  if (!move || !override) return false;
  if (!move.includes('user_belongs_to_tenant') || !move.includes('has_role')) return false;
  if (!override.includes('user_can_move_tenant_checks')) return false;
  const allow = override.match(/v_allowed text\[\] := ARRAY\[([\s\S]*?)\]/);
  if (!allow) return false;
  if (allow[1].includes("'deposited'")) return false;
  return true;
}

export function loadPredecessorOverrideSql(sqlFile) {
  if (!sqlFile || !fs.existsSync(sqlFile)) return null;
  return extractPinnedFunctionSql(fs.readFileSync(sqlFile, 'utf8'), 'admin_override_check_status');
}

export function isExactKnownPredecessor(live = {}, predecessorOverrideSql = '') {
  if (live?.user_can_move_tenant_checks) return false;
  if (!live?.admin_override_check_status || !predecessorOverrideSql) return false;
  return hashSqlDefinition(live.admin_override_check_status)
    === hashSqlDefinition(predecessorOverrideSql);
}

function readEmbeddedSql(sqlFile = SQL_FILE, authorizedSha = AUTHORIZED_SQL44.source_sha256) {
  if (!fs.existsSync(sqlFile)) {
    return fail(CODES.INVALID_MANIFEST, 'embedded SQL file is missing from the executor package', {
      sql_file: sqlFile,
    });
  }
  const text = fs.readFileSync(sqlFile, 'utf8');
  const sourceSha = sha256File(sqlFile);
  if (sourceSha !== authorizedSha) {
    return fail(CODES.SQL_COLLISION, 'embedded SQL file SHA256 does not match the authorized source', {
      embedded_sha256: sourceSha,
      authorized_sha256: authorizedSha,
    });
  }
  for (const marker of FORBIDDEN_GRANT_MARKERS) {
    if (text.includes(marker)) {
      return fail(CODES.UNRELATED_MUTATION, 'embedded SQL contains a forbidden generic grant', { marker });
    }
  }
  return ok({ text, source_sha256: sourceSha });
}

async function defaultConnect() {
  const { default: pg } = await import('pg');
  const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const arn = process.env.ADMIN_SECRET_ARN;
  if (!arn || !/checksops_admin/i.test(arn)) {
    throw new Error('ADMIN_SECRET_ARN must be the staging checksops_admin secret');
  }
  const sm = new SecretsManagerClient({});
  const secret = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  const parsed = JSON.parse(secret.SecretString);
  if (!/checksops_admin/i.test(parsed.username || '')) {
    throw new Error('secret username is not checksops_admin');
  }
  const host = parsed.host && parsed.host !== 'localhost' && parsed.host !== '127.0.0.1'
    ? parsed.host
    : process.env.RDS_HOST;
  if (!host || host === 'localhost' || host === '127.0.0.1') {
    throw new Error('admin secret host is missing or loopback');
  }
  const database = process.env.DATABASE_NAME || 'checksops';
  if (database !== 'checksops') throw new Error(`refusing database name ${database}`);
  const caPath = CA_CANDIDATES.find((p) => fs.existsSync(p));
  const client = new pg.Client({
    host,
    port: Number(parsed.port || 5432),
    user: parsed.username,
    password: parsed.password,
    database,
    ssl: caPath ? { rejectUnauthorized: true, ca: fs.readFileSync(caPath, 'utf8') } : { rejectUnauthorized: true },
    connectionTimeoutMillis: 8000,
    query_timeout: 30000,
  });
  await client.connect();
  const db = (await client.query('SELECT current_database() AS d')).rows[0];
  if (db.d !== 'checksops') {
    await client.end();
    throw new Error(`connected to ${db.d}, expected checksops`);
  }
  return client;
}

async function definitionTextOrFail(client, identity) {
  const lookup = await readFunctionDef(client, identity);
  if (!lookup.ok) return lookup;
  return ok({ definition: lookup.details.exists ? lookup.details.definition : null });
}

async function readGrants(client) {
  const routine = await client.query(`
    SELECT grantee, privilege_type
    FROM information_schema.routine_privileges
    WHERE routine_schema = 'public'
      AND routine_name = 'claim_ledger_link_or_create'
    ORDER BY grantee, privilege_type
  `);
  const claimsInsert = await client.query(`
    SELECT grantee, privilege_type
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name = 'claims'
      AND privilege_type = 'INSERT'
    ORDER BY grantee
  `);
  const claimIdUpdate = await client.query(`
    SELECT grantee, privilege_type
    FROM information_schema.column_privileges
    WHERE table_schema = 'public'
      AND table_name = 'check_intake_items'
      AND column_name = 'claim_id'
      AND privilege_type = 'UPDATE'
    ORDER BY grantee
  `);
  return {
    routine: routine.rows,
    claims_insert: claimsInsert.rows,
    claim_id_update: claimIdUpdate.rows,
  };
}

function grantsConstrained(grants) {
  const genericGrantees = new Set(['PUBLIC', 'authenticated', 'anon']);
  const badRoutine = (grants.routine || []).filter((row) => (
    genericGrantees.has(row.grantee) && row.privilege_type === 'EXECUTE'
  ));
  const badInsert = (grants.claims_insert || []).filter((row) => genericGrantees.has(row.grantee));
  const badUpdate = (grants.claim_id_update || []).filter((row) => genericGrantees.has(row.grantee));
  if (badRoutine.length || badInsert.length || badUpdate.length) {
    return fail(CODES.UNRELATED_MUTATION, 'grants are not constrained', {
      bad_routine: badRoutine,
      bad_claims_insert: badInsert,
      bad_claim_id_update: badUpdate,
    });
  }
  return ok({ grants_constrained: true });
}

async function readClaimFingerprint(client) {
  const claims = await client.query(`
    SELECT id, org_id, claim_number
    FROM public.claims
    WHERE public.ocr_claim_number_key(claim_number) = public.ocr_claim_number_key($1)
    ORDER BY id
  `, [CLAIM_NUMBER]);
  const checks = await client.query(`
    SELECT id, tenant_id, claim_id, amount::text AS amount,
           deposited_at, check_stage::text AS check_stage,
           detected_claim_number
    FROM public.check_intake_items
    WHERE tenant_id = $1::uuid
      AND public.ocr_claim_number_key(detected_claim_number) = public.ocr_claim_number_key($2)
    ORDER BY id
  `, [TENANT_ID, CLAIM_NUMBER]);
  const checkIds = checks.rows.map((row) => row.id);
  const payments = checkIds.length
    ? await client.query(`
        SELECT id, claim_id, check_intake_item_id, amount::text AS amount
        FROM public.claim_payments
        WHERE check_intake_item_id = ANY($1::uuid[])
        ORDER BY id
      `, [checkIds])
    : { rows: [] };
  const claimChecks = checkIds.length
    ? await client.query(`
        SELECT id, claim_id, check_intake_item_id
        FROM public.claim_checks
        WHERE check_intake_item_id = ANY($1::uuid[])
        ORDER BY id
      `, [checkIds])
    : { rows: [] };
  const disbursements = await client.query(`
    SELECT d.id, d.claim_id, d.check_id, d.amount::text AS amount, d.status
    FROM public.claim_disbursements d
    WHERE d.check_id = ANY($1::uuid[])
       OR d.claim_id IN (
            SELECT c.id FROM public.claims c
            WHERE public.ocr_claim_number_key(c.claim_number) = public.ocr_claim_number_key($2)
          )
    ORDER BY d.id
  `, [claimChecks.rows.map((row) => row.id), CLAIM_NUMBER]);
  return {
    claims_rows: claims.rows.length,
    claims: claims.rows,
    same_tenant_unlinked_count: checks.rows.filter((row) => row.claim_id == null).length,
    checks: checks.rows,
    claim_checks: claimChecks.rows,
    payments: payments.rows,
    disbursements: disbursements.rows,
  };
}

function fingerprintsEqual(before, after) {
  return JSON.stringify(before) === JSON.stringify(after);
}

function definitionMatchesSourceBehavior(def) {
  if (!def) return false;
  return BEHAVIOR_MARKERS.every((marker) => def.includes(marker));
}

function executionReceipt({
  event,
  beforeHash,
  afterHash,
  sql43Hash,
  result,
  identity,
  inspect = null,
  data_before = null,
  data_after = null,
}) {
  return {
    workstream: event.workstream_id,
    commit: event.commit,
    sql_file: event.filename || AUTHORIZED_SQL44.filename,
    before_hash: beforeHash,
    after_hash: afterHash,
    sql43_hash: sql43Hash,
    timestamp: new Date().toISOString(),
    result,
    executor_identity: identity,
    inspect,
    data_before,
    data_after,
  };
}

async function readTenantPermissionDefs(client) {
  const move = await readFunctionDef(
    client,
    AUTHORIZED_TENANT_USERS_SAME_CHECK_PERMISSIONS.function_identities[0],
  );
  if (!move.ok) return move;
  const override = await readFunctionDef(
    client,
    AUTHORIZED_TENANT_USERS_SAME_CHECK_PERMISSIONS.function_identities[1],
  );
  if (!override.ok) return override;
  return ok({
    user_can_move_tenant_checks: move.details.exists ? move.details.definition : null,
    admin_override_check_status: override.details.exists ? override.details.definition : null,
  });
}

async function handleTenantPermissions({
  event,
  authorization,
  identity,
  connect,
  sqlFile601,
  sqlFile601Predecessor,
}) {
  const embedded = readEmbeddedSql(
    sqlFile601,
    AUTHORIZED_TENANT_USERS_SAME_CHECK_PERMISSIONS.source_sha256,
  );
  if (!embedded.ok) return embedded;

  let client;
  try {
    client = await connect();
    const liveLookup = await readTenantPermissionDefs(client);
    if (!liveLookup.ok) return liveLookup;
    const live = liveLookup.details;
    const liveHash = hashTenantPermissionLiveDefs(live);
    if (
      event.expected_live_definition_sha256
      && event.expected_live_definition_sha256 !== liveHash
    ) {
      return fail(CODES.SQL_COLLISION, 'live tenant-permission function definitions differ from the expected baseline', {
        expected_live_definition_sha256: event.expected_live_definition_sha256,
        live_definition_sha256: liveHash,
      });
    }

    const exact = tenantPermissionDefsAreExact(live, embedded.details.text);
    const absent = !live.user_can_move_tenant_checks && !live.admin_override_check_status;
    const predecessorOverrideSql = loadPredecessorOverrideSql(sqlFile601Predecessor);
    const knownPredecessor = isExactKnownPredecessor(live, predecessorOverrideSql);
    const markerSimilar = tenantPermissionMarkersMatch(live);

    if (event.action === 'inspect' || event.action === 'verify_data' || event.action === 'authorize') {
      return ok({
        authorization: authorization.details,
        receipt: {
          workstream: event.workstream_id,
          commit: event.commit,
          sql_file: event.filename,
          before_hash: liveHash,
          after_hash: liveHash,
          result: event.action,
          executor_identity: identity,
          live_functions: {
            user_can_move_tenant_checks: Boolean(live.user_can_move_tenant_checks),
            admin_override_check_status: Boolean(live.admin_override_check_status),
          },
          exact,
          known_predecessor: knownPredecessor,
          marker_similar: markerSimilar,
        },
      });
    }

    if (event.action !== 'apply') {
      return fail(CODES.INVALID_MANIFEST, `unsupported tenant-permission executor action ${event.action}`);
    }

    if (exact) {
      consumeOneUse(event.one_use_id);
      return ok({
        receipt: {
          workstream: event.workstream_id,
          commit: event.commit,
          sql_file: event.filename,
          before_hash: liveHash,
          after_hash: liveHash,
          result: 'idempotent',
          executor_identity: identity,
        },
      });
    }

    if (!absent && !knownPredecessor) {
      return fail(CODES.SQL_COLLISION, 'live function definition conflicts with the pinned #601 migration', {
        live_definition_sha256: liveHash,
        exact: false,
        known_predecessor: false,
        marker_similar: markerSimilar,
      });
    }

    await client.query(embedded.details.text);
    const afterLookup = await readTenantPermissionDefs(client);
    if (!afterLookup.ok) return afterLookup;
    const after = afterLookup.details;
    const afterHash = hashTenantPermissionLiveDefs(after);
    if (!after.user_can_move_tenant_checks || !after.admin_override_check_status) {
      return fail(CODES.SQL_COLLISION, 'apply did not create the expected #601 functions');
    }
    if (!tenantPermissionDefsAreExact(after, embedded.details.text)) {
      return fail(CODES.SQL_COLLISION, 'applied #601 definitions do not match the pinned migration');
    }
    consumeOneUse(event.one_use_id);
    return ok({
      receipt: {
        workstream: event.workstream_id,
        commit: event.commit,
        sql_file: event.filename,
        before_hash: liveHash,
        after_hash: afterHash,
        result: 'applied',
        executor_identity: identity,
      },
    });
  } catch (error) {
    return fail(CODES.UNRELATED_MUTATION, String(error?.message || error).slice(0, 400));
  } finally {
    if (client) {
      try { await client.end(); } catch { /* ignore */ }
    }
  }
}

async function readPreservedFunctionState(client, identities) {
  const functions = [];
  for (const identity of identities) {
    const lookup = await readFunctionDef(client, identity);
    if (!lookup.ok) return lookup;
    functions.push({
      identity,
      exists: lookup.details.exists === true,
      definitionSha256: lookup.details.exists
        ? hashSqlDefinition(lookup.details.definition)
        : AUTHORIZED_SQL53.absent_live_definition_sha256,
    });
  }
  return ok({ functions });
}

function sql53ContainsForbiddenMutation(sqlText) {
  const text = String(sqlText || '');
  if (/\bDROP\s+(FUNCTION|TRIGGER|TABLE)\b/i.test(text)) {
    return 'DROP FUNCTION|TRIGGER|TABLE';
  }
  for (const marker of SQL53_FORBIDDEN_MARKERS) {
    if (text.includes(marker)) return marker;
  }
  return null;
}

async function rollbackSql53(client, inTx) {
  if (!inTx) return false;
  try { await client.query('ROLLBACK'); } catch { /* ignore */ }
  return false;
}

function sql53PinExact(event = {}) {
  return event.filename === AUTHORIZED_SQL53.filename
    && event.migration_id === AUTHORIZED_SQL53.migration_id
    && event.source_sha256 === AUTHORIZED_SQL53.source_sha256
    && event.intended_replacement_sha256 === AUTHORIZED_SQL53.intended_replacement_sha256
    && event.commit === AUTHORIZED_SQL53.commit;
}

async function handleSql53({
  event,
  authorization,
  identity,
  connect,
  sqlFile53,
  expectedSql53AfterHash,
}) {
  const embedded = readEmbeddedSql(sqlFile53, AUTHORIZED_SQL53.source_sha256);
  if (!embedded.ok) return embedded;
  const forbidden = sql53ContainsForbiddenMutation(embedded.details.text);
  if (forbidden) {
    return fail(CODES.UNRELATED_MUTATION, 'embedded SQL 53 contains a forbidden unrelated mutation', {
      marker: forbidden,
    });
  }

  let client;
  let inTx = false;
  try {
    client = await connect();

    if (event.action === 'inspect' || event.action === 'verify_data' || event.action === 'authorize') {
      const liveLookup = await readFunctionDef(client, AUTHORIZED_SQL53.function_identity);
      if (!liveLookup.ok) return liveLookup;
      const exists = liveLookup.details.exists === true;
      const liveHash = exists
        ? hashSqlDefinition(liveLookup.details.definition)
        : AUTHORIZED_SQL53.absent_live_definition_sha256;
      const preserved = await readPreservedFunctionState(
        client,
        AUTHORIZED_SQL53.preserved_function_identities,
      );
      if (!preserved.ok) return preserved;
      return ok({
        authorization: authorization.details,
        receipt: {
          workstream: event.workstream_id,
          commit: event.commit,
          sql_file: event.filename,
          before_hash: liveHash,
          after_hash: liveHash,
          result: event.action,
          executor_identity: identity,
          exists,
          function_identity: AUTHORIZED_SQL53.function_identity,
          live_definition_sha256: liveHash,
          preserved_functions: preserved.details.functions,
        },
      });
    }

    if (event.action !== 'apply') {
      return fail(CODES.INVALID_MANIFEST, `unsupported SQL 53 executor action ${event.action}`);
    }
    if (!sql53PinExact(event)) {
      return fail(CODES.SQL_COLLISION, 'SQL 53 apply is bound to the exact allowlisted pin', {
        filename: event.filename || null,
        migration_id: event.migration_id || null,
      });
    }

    await client.query('BEGIN');
    inTx = true;
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      AUTHORIZED_SQL53.function_identity,
    ]);

    if (isConsumed(event.one_use_id)) {
      inTx = await rollbackSql53(client, inTx);
      return fail(CODES.SQL_COLLISION, 'one_use_id has already been consumed; replay is forbidden', {
        one_use_id: event.one_use_id,
      });
    }

    const liveLookup = await readFunctionDef(client, AUTHORIZED_SQL53.function_identity);
    if (!liveLookup.ok) {
      inTx = await rollbackSql53(client, inTx);
      return liveLookup;
    }
    const exists = liveLookup.details.exists === true;
    const liveHash = exists
      ? hashSqlDefinition(liveLookup.details.definition)
      : AUTHORIZED_SQL53.absent_live_definition_sha256;

    if (event.expected_live_definition_sha256 !== liveHash) {
      inTx = await rollbackSql53(client, inTx);
      return fail(CODES.DEPLOYMENT_COLLISION, 'expected live fingerprint changed immediately before apply', {
        expected_live_definition_sha256: event.expected_live_definition_sha256 || null,
        live_definition_sha256: liveHash,
      });
    }

    const liveState = classifySql53CreateLive({
      exists,
      live_definition_sha256: liveHash,
    });
    if (!liveState.ok) {
      inTx = await rollbackSql53(client, inTx);
      return liveState;
    }

    const preserved = await readPreservedFunctionState(
      client,
      AUTHORIZED_SQL53.preserved_function_identities,
    );
    if (!preserved.ok) {
      inTx = await rollbackSql53(client, inTx);
      return preserved;
    }
    const missingPreserved = preserved.details.functions.filter((row) => row.exists !== true);
    if (missingPreserved.length) {
      inTx = await rollbackSql53(client, inTx);
      return fail(CODES.SQL_COLLISION, 'SQL 53 apply refuses to run when a preserved function is missing', {
        missing: missingPreserved.map((row) => row.identity),
      });
    }

    const collision = evaluateSqlCollision({
      filename: event.filename,
      migration_id: event.migration_id,
      source_sha256: event.source_sha256,
      target_environment: 'staging',
      expected_live_definition_sha256: event.expected_live_definition_sha256,
      live_definition_sha256: liveHash,
    });
    if (!collision.ok) {
      inTx = await rollbackSql53(client, inTx);
      return collision;
    }

    await client.query(embedded.details.text);

    const afterLookup = await readFunctionDef(client, AUTHORIZED_SQL53.function_identity);
    if (!afterLookup.ok) {
      inTx = await rollbackSql53(client, inTx);
      return afterLookup;
    }
    if (afterLookup.details.exists !== true) {
      inTx = await rollbackSql53(client, inTx);
      return fail(CODES.SQL_COLLISION, 'apply did not create the settlement function');
    }
    const afterHash = hashSqlDefinition(afterLookup.details.definition);
    if (afterHash !== expectedSql53AfterHash) {
      inTx = await rollbackSql53(client, inTx);
      return fail(CODES.SQL_COLLISION, 'applied settlement definition does not match the intended hash', {
        after_hash: afterHash,
        intended_replacement_sha256: expectedSql53AfterHash,
      });
    }

    const preservedAfter = await readPreservedFunctionState(
      client,
      AUTHORIZED_SQL53.preserved_function_identities,
    );
    if (!preservedAfter.ok) {
      inTx = await rollbackSql53(client, inTx);
      return preservedAfter;
    }
    const lost = preservedAfter.details.functions.filter((row) => row.exists !== true);
    if (lost.length) {
      inTx = await rollbackSql53(client, inTx);
      return fail(CODES.SQL_COLLISION, 'apply lost an unrelated pinned function', {
        missing: lost.map((row) => row.identity),
      });
    }

    await client.query('COMMIT');
    inTx = false;
    consumeOneUse(event.one_use_id);
    return ok({
      receipt: {
        workstream: event.workstream_id,
        commit: event.commit,
        sql_file: event.filename,
        before_hash: liveHash,
        after_hash: afterHash,
        result: 'applied',
        executor_identity: identity,
        function_identity: AUTHORIZED_SQL53.function_identity,
        preserved_functions: preservedAfter.details.functions,
      },
    });
  } catch (error) {
    inTx = await rollbackSql53(client, inTx);
    return fail(CODES.UNRELATED_MUTATION, String(error?.message || error).slice(0, 400));
  } finally {
    if (inTx) await rollbackSql53(client, inTx);
    if (client) {
      try { await client.end(); } catch { /* ignore */ }
    }
  }
}

export function createHandler({
  connect = defaultConnect,
  now = () => Date.now(),
  sqlFile = SQL_FILE,
  sqlFile601 = TENANT_PERMISSIONS_SQL_FILE,
  sqlFile601Predecessor = TENANT_PERMISSIONS_PREDECESSOR_SQL_FILE,
  sqlFile53 = SQL53_FILE,
  expectedSql43Hash = AUTHORIZED_SQL44.expected_sql43_definition_sha256,
  expectedSql53AfterHash = AUTHORIZED_SQL53.intended_replacement_sha256,
} = {}) {
  return async function handler(event = {}) {
    const identity = process.env.EXECUTOR_IDENTITY
      || process.env.AWS_LAMBDA_FUNCTION_NAME
      || SQL_EXECUTOR_FUNCTION;
    if (identity !== SQL_EXECUTOR_FUNCTION) {
      return fail(CODES.UNRELATED_MUTATION, 'executor identity mismatch', { identity });
    }

    const authorization = evaluateSqlExecutorAuthorization(event, { now: now() });
    if (!authorization.ok) return authorization;

    if (isConsumed(event.one_use_id) && event.action === 'apply') {
      return fail(CODES.SQL_COLLISION, 'one_use_id has already been consumed; replay is forbidden', {
        one_use_id: event.one_use_id,
      });
    }

    if (isSql53AuthorizedMigration(event)) {
      return handleSql53({
        event,
        authorization,
        identity,
        connect,
        sqlFile53,
        expectedSql53AfterHash,
      });
    }

    if (isTenantUsersSameCheckPermissions(event)) {
      return handleTenantPermissions({
        event,
        authorization,
        identity,
        connect,
        sqlFile601,
        sqlFile601Predecessor,
      });
    }

    if (!isSql44AuthorizedMigration(event)) {
      return fail(CODES.SQL_COLLISION, 'authorization package is not bound to an allowlisted staging SQL file', {
        filename: event.filename || null,
        migration_id: event.migration_id || null,
      });
    }

    const embedded = readEmbeddedSql(sqlFile);
    if (!embedded.ok) return embedded;

    let client;
    try {
      client = await connect();
      const beforeLookup = await definitionTextOrFail(client, AUTHORIZED_SQL44.function_identity);
      if (!beforeLookup.ok) return beforeLookup;
      const beforeDef = beforeLookup.details.definition;
      const beforeHash = beforeDef ? hashSqlDefinition(beforeDef) : null;
      const sql43Lookup = await definitionTextOrFail(client, AUTHORIZED_SQL44.sql43_function_identity);
      if (!sql43Lookup.ok) return sql43Lookup;
      const sql43Def = sql43Lookup.details.definition;
      const sql43Hash = sql43Def ? hashSqlDefinition(sql43Def) : null;

      if (event.action === 'verify_data') {
        const data = await readClaimFingerprint(client);
        return ok({
          receipt: executionReceipt({
            event,
            beforeHash,
            afterHash: beforeHash,
            sql43Hash,
            result: 'verify_data',
            identity,
            data_before: data,
            data_after: data,
          }),
        });
      }

      if (event.action === 'inspect') {
        if (!event.applied_after_hash || event.applied_after_hash !== beforeHash) {
          return fail(CODES.SQL_COLLISION, 'inspect is forbidden until the applied SQL 44 definition has been verified', {
            live_definition_sha256: beforeHash,
            applied_after_hash: event.applied_after_hash || null,
          });
        }
        if (!definitionMatchesSourceBehavior(beforeDef)) {
          return fail(CODES.SQL_COLLISION, 'live SQL 44 definition does not match intended source behavior');
        }
        const inspect = event.inspect || {};
        if (!inspect.check_id || !inspect.tenant_id || !inspect.claim_number) {
          return fail(CODES.INVALID_MANIFEST, 'inspect requires check_id, tenant_id, and claim_number');
        }
        if (inspect.rpc_action && inspect.rpc_action !== 'inspect') {
          return fail(CODES.UNRELATED_MUTATION, 'inspect invoke may only call action=inspect');
        }
        const dataBefore = await readClaimFingerprint(client);
        const rpc = await client.query(
          'SELECT public.claim_ledger_link_or_create($1::uuid, $2::uuid, $3::text, $4::text) AS result',
          [inspect.check_id, inspect.tenant_id, inspect.claim_number, 'inspect'],
        );
        const dataAfter = await readClaimFingerprint(client);
        if (!fingerprintsEqual(dataBefore, dataAfter)) {
          return fail(CODES.UNRELATED_MUTATION, 'inspect mutated claim/check/payment/disbursement data', {
            data_before: dataBefore,
            data_after: dataAfter,
          });
        }
        return ok({
          receipt: executionReceipt({
            event,
            beforeHash,
            afterHash: beforeHash,
            sql43Hash,
            result: 'inspect',
            identity,
            inspect: rpc.rows[0]?.result || null,
            data_before: dataBefore,
            data_after: dataAfter,
          }),
        });
      }

      if (event.action !== 'apply') {
        return ok({
          authorization: authorization.details,
          receipt: executionReceipt({
            event,
            beforeHash,
            afterHash: null,
            sql43Hash,
            result: 'authorize',
            identity,
          }),
        });
      }

      const collision = evaluateSqlCollision({
        filename: event.filename,
        migration_id: event.migration_id,
        source_sha256: event.source_sha256,
        target_environment: 'staging',
        expected_live_definition_sha256: event.expected_live_definition_sha256,
        live_definition_sha256: beforeHash,
        live_definition: beforeDef,
      });
      if (!collision.ok) return collision;

      const dataBefore = await readClaimFingerprint(client);
      await client.query(embedded.details.text);
      const afterLookup = await definitionTextOrFail(client, AUTHORIZED_SQL44.function_identity);
      if (!afterLookup.ok) return afterLookup;
      const afterDef = afterLookup.details.definition;
      const afterHash = afterDef ? hashSqlDefinition(afterDef) : null;
      const sql43AfterLookup = await definitionTextOrFail(client, AUTHORIZED_SQL44.sql43_function_identity);
      if (!sql43AfterLookup.ok) return sql43AfterLookup;
      const sql43After = sql43AfterLookup.details.definition;
      const sql43AfterHash = sql43After ? hashSqlDefinition(sql43After) : null;

      if (sql43AfterHash !== expectedSql43Hash) {
        return fail(CODES.SQL_COLLISION, 'SQL 43 definition changed; STOP', {
          expected: expectedSql43Hash,
          live: sql43AfterHash,
        });
      }
      if (!definitionMatchesSourceBehavior(afterDef)) {
        return fail(CODES.SQL_COLLISION, 'applied SQL 44 definition does not match intended source behavior', {
          after_hash: afterHash,
        });
      }
      if (afterHash === beforeHash) {
        return fail(CODES.SQL_COLLISION, 'apply did not change the live SQL 44 definition');
      }

      const grants = grantsConstrained(await readGrants(client));
      if (!grants.ok) return grants;

      const dataAfter = await readClaimFingerprint(client);
      if (!fingerprintsEqual(dataBefore, dataAfter)) {
        return fail(CODES.UNRELATED_MUTATION, 'CREATE OR REPLACE mutated claim/check/payment/disbursement data', {
          data_before: dataBefore,
          data_after: dataAfter,
        });
      }

      consumeOneUse(event.one_use_id);
      return ok({
        receipt: executionReceipt({
          event,
          beforeHash,
          afterHash,
          sql43Hash: sql43AfterHash,
          result: 'applied',
          identity,
          data_before: dataBefore,
          data_after: dataAfter,
        }),
        grants: grants.details,
      });
    } catch (error) {
      return fail(CODES.UNRELATED_MUTATION, String(error?.message || error).slice(0, 400));
    } finally {
      if (client) {
        try { await client.end(); } catch { /* ignore */ }
      }
    }
  };
}

export const handler = createHandler();
