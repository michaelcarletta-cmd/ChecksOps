/**
 * Staging-only VPC SQL executor for allowlisted reviewed SQL files.
 * Fail closed. No arbitrary SQL. No create_new. No production.
 * CREATE OR REPLACE must not invoke the function.
 * SQL 39 may drop/recreate only the authenticated TMP write policy.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODES, fail, ok } from './lib/errors.mjs';
import { functionDefsMatchExactly, readFunctionDef } from './lib/function-def-lookup.mjs';
import { evaluateSqlCollision, hashSqlDefinition } from './lib/sql-apply.mjs';
import {
  AUTHORIZED_SQL39,
  AUTHORIZED_SQL40,
  AUTHORIZED_SQL44,
  AMOUNT_GRANT_STATE_TEXT,
  AUTHORIZED_LEDGER_20261007193200,
  AUTHORIZED_SQL53,
  AUTHORIZED_SQL71_AMOUNT_GRANT,
  AUTHORIZED_SQL72_MEMBER_PAYMENT_WRITES,
  AUTHORIZED_SQL76_PARTNERSHIP_CONSENT,
  AUTHORIZED_TENANT_USERS_SAME_CHECK_PERMISSIONS,
  MEMBER_PAYMENT_POLICIES,
  MEMBER_PAYMENT_REQUIRED_FUNCTIONS,
  memberPaymentPolicyStateText,
  PARTNERSHIP_CONSENT_REQUIRED_FUNCTIONS,
  PARTNERSHIP_CONSENT_TRIGGER,
  PARTNERSHIP_RETIRED_POLICIES,
  PARTNERSHIP_WRITER_SETTING,
  PARTNERSHIP_WRITER_VALUE,
  partnershipConsentStateText,
  PARTNERSHIP_CONNECT_BODY_SHA256,
  PARTNERSHIP_CONNECT_CONFIG,
  SQL_EXECUTOR_FUNCTION,
  classifySql53CreateLive,
  evaluateSqlExecutorAuthorization,
  isSql39,
  isSql40,
  isLedger20261007193200,
  isSql44AuthorizedMigration,
  isSql53AuthorizedMigration,
  isSql71AmountGrant,
  isSql72MemberPaymentWrites,
  isSql76PartnershipConsent,
  isTenantUsersSameCheckPermissions,
} from './lib/sql-executor-auth.mjs';
import {
  AUTHORIZED_SYNTHETIC_FIXTURE,
  EMPTY_FIXTURE_SHA256,
  FORBIDDEN_FREEDOM,
  evaluateFixtureGuards,
  hashFixtureSnapshot,
} from './lib/collection-v2-synthetic-uat-cleanup.mjs';
import {
  EXPECTED_POLICY_NAMES,
  FROZEN_FUNCTION_NAMES,
  INSPECTED_JOB,
  TMP_TABLE,
  hashTmpRlsCatalog,
  hashTmpRlsFrozen,
  jobPredicateIntact,
  policyByName,
  writePredicateAcceptable,
  writePredicateIntended,
} from './lib/tmp-rls-catalog.mjs';

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
const LEDGER_20261007193200_FILE = path.join(
  ROOT,
  'sql/20261007193200_skip_claim_ledger_event_for_endorsement_stage.sql',
);
const SQL71_AMOUNT_GRANT_FILE = path.join(ROOT, 'sql/71_review_amount_column_grant.sql');
const SQL72_MEMBER_PAYMENT_WRITES_FILE = path.join(ROOT, 'sql/72_member_payment_writes.sql');
const SQL76_PARTNERSHIP_CONSENT_FILE = path.join(ROOT, 'sql/76_tenant_partnership_invitee_consent.sql');
const SQL39_FILE = path.join(ROOT, 'sql/39_tmp_write_policy_reconcile.sql');
const SQL40_FILE = path.join(ROOT, 'sql/40_collection_v2_synthetic_uat_cleanup.sql');
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

async function readTmpRlsCatalog(client) {
  const table = await client.query(`
    /* tmp_rls_catalog_rls */
    SELECT c.relname AS table,
           c.relrowsecurity,
           c.relforcerowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = $1
       AND c.relkind = 'r'
  `, [TMP_TABLE]);
  const policies = await client.query(`
    /* tmp_rls_catalog_policies */
    SELECT pol.polname AS name,
           CASE WHEN pol.polpermissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END AS permissive,
           CASE pol.polcmd
             WHEN 'r' THEN 'SELECT'
             WHEN 'a' THEN 'INSERT'
             WHEN 'w' THEN 'UPDATE'
             WHEN 'd' THEN 'DELETE'
             WHEN '*' THEN 'ALL'
           END AS command,
           '{' || COALESCE((
             SELECT string_agg(rol.rolname, ',' ORDER BY rol.rolname)
               FROM pg_roles rol
              WHERE rol.oid = ANY (pol.polroles)
           ), '') || '}' AS roles,
           pg_get_expr(pol.polqual, pol.polrelid) AS using,
           pg_get_expr(pol.polwithcheck, pol.polrelid) AS with_check
      FROM pg_policy pol
      JOIN pg_class c ON c.oid = pol.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = $1
     ORDER BY pol.polname
  `, [TMP_TABLE]);
  const grants = await client.query(`
    /* tmp_rls_catalog_grants */
    SELECT grantee, privilege_type
      FROM information_schema.role_table_grants
     WHERE table_schema = 'public'
       AND table_name = $1
     ORDER BY grantee, privilege_type
  `, [TMP_TABLE]);
  const membership = await client.query(`
    /* tmp_rls_catalog_membership */
    SELECT r.rolname
      FROM pg_auth_members m
      JOIN pg_roles r ON r.oid = m.roleid
      JOIN pg_roles u ON u.oid = m.member
     WHERE u.rolname = 'checksops'
     ORDER BY r.rolname
  `);
  const row = table.rows[0] || {};
  return {
    table: row.table || TMP_TABLE,
    table_catalog: {
      table: row.table || TMP_TABLE,
      relrowsecurity: row.relrowsecurity === true,
      relforcerowsecurity: row.relforcerowsecurity === true,
    },
    relrowsecurity: row.relrowsecurity === true,
    relforcerowsecurity: row.relforcerowsecurity === true,
    policies: policies.rows,
    grants: grants.rows,
    lambda_role_membership: membership.rows.map((item) => item.rolname),
  };
}

async function readTmpRlsFrozen(client) {
  const functions = await client.query(`
    /* tmp_rls_frozen_functions */
    SELECT n.nspname AS schema,
           p.proname AS name,
           pg_get_function_identity_arguments(p.oid) AS identity_arguments,
           pg_get_functiondef(p.oid) AS definition
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = ANY ($1::text[])
     ORDER BY p.proname, pg_get_function_identity_arguments(p.oid)
  `, [FROZEN_FUNCTION_NAMES]);
  const triggers = await client.query(`
    /* tmp_rls_frozen_triggers */
    SELECT t.tgname AS name,
           pg_get_triggerdef(t.oid) AS definition
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = $1
       AND NOT t.tgisinternal
     ORDER BY t.tgname
  `, [TMP_TABLE]);
  return {
    functions: functions.rows.map((row) => ({
      ...row,
      identity: `public.${row.name}(${row.identity_arguments || ''})`,
      definition_sha256: hashSqlDefinition(row.definition || ''),
    })),
    triggers: triggers.rows,
  };
}

function sql39CatalogGuards(catalog) {
  const write = policyByName(catalog, AUTHORIZED_SQL39.policy_name);
  const job = policyByName(catalog, AUTHORIZED_SQL39.job_policy_name);
  if (!write) {
    return fail(CODES.SQL_COLLISION, 'authenticated TMP write policy is missing');
  }
  if (!job) {
    return fail(CODES.SQL_COLLISION, 'job/webhook TMP write policy is missing');
  }
  if (!writePredicateAcceptable(write.using) || !writePredicateAcceptable(write.with_check)) {
    return fail(CODES.SQL_COLLISION, 'authenticated TMP write policy drifted from the inspected or intended predicate', {
      using: write.using,
      with_check: write.with_check,
    });
  }
  if (!jobPredicateIntact(job.using) || !jobPredicateIntact(job.with_check)) {
    return fail(CODES.SQL_COLLISION, 'job/webhook TMP write policy drifted from the inspected predicate', {
      using: job.using,
      with_check: job.with_check,
    });
  }
  if (catalog.relrowsecurity !== true && catalog.table_catalog?.relrowsecurity !== true) {
    return fail(CODES.SQL_COLLISION, 'TMP RLS is not enabled; SQL 39 refuses to enable it');
  }
  return ok({ write, job });
}

function sql39AfterGuards(before, after) {
  const names = [...(after.policies || []).map((policy) => policy.name)].sort();
  if (JSON.stringify(names) !== JSON.stringify([...EXPECTED_POLICY_NAMES].sort())) {
    return fail(CODES.SQL_COLLISION, 'TMP policy set drifted after SQL 39', { names });
  }
  const write = policyByName(after, AUTHORIZED_SQL39.policy_name);
  const job = policyByName(after, AUTHORIZED_SQL39.job_policy_name);
  const beforeJob = policyByName(before, AUTHORIZED_SQL39.job_policy_name);
  if (!writePredicateIntended(write?.using) || !writePredicateIntended(write?.with_check)) {
    return fail(CODES.SQL_COLLISION, 'authenticated TMP write policy was not reconciled', {
      using: write?.using,
      with_check: write?.with_check,
    });
  }
  if (
    !job
    || job.using !== beforeJob?.using
    || job.with_check !== beforeJob?.with_check
    || job.roles !== beforeJob?.roles
    || job.command !== beforeJob?.command
    || !jobPredicateIntact(job.using)
  ) {
    return fail(CODES.SQL_COLLISION, 'job/webhook TMP write policy changed during SQL 39', {
      before: beforeJob,
      after: job,
    });
  }
  for (const name of EXPECTED_POLICY_NAMES) {
    if (name === AUTHORIZED_SQL39.policy_name) continue;
    const previous = policyByName(before, name);
    const next = policyByName(after, name);
    if (JSON.stringify(previous) !== JSON.stringify(next)) {
      return fail(CODES.SQL_COLLISION, `unexpected TMP policy change: ${name}`, {
        before: previous,
        after: next,
      });
    }
  }
  const beforeCanon = {
    relrowsecurity: before.table_catalog?.relrowsecurity ?? before.relrowsecurity,
    relforcerowsecurity: before.table_catalog?.relforcerowsecurity ?? before.relforcerowsecurity,
    grants: before.grants,
    membership: before.lambda_role_membership,
  };
  const afterCanon = {
    relrowsecurity: after.table_catalog?.relrowsecurity ?? after.relrowsecurity,
    relforcerowsecurity: after.table_catalog?.relforcerowsecurity ?? after.relforcerowsecurity,
    grants: after.grants,
    membership: after.lambda_role_membership,
  };
  if (JSON.stringify(beforeCanon) !== JSON.stringify(afterCanon)) {
    return fail(CODES.UNRELATED_MUTATION, 'SQL 39 changed RLS/FORCE/grants/membership', {
      before: beforeCanon,
      after: afterCanon,
    });
  }
  return ok({ write, job });
}

async function readSql40Fixture(client) {
  const fixture = AUTHORIZED_SYNTHETIC_FIXTURE;
  const tmp = (await client.query(`
    /* sql40_tmp */
    SELECT id::text AS id,
           tenant_id::text AS tenant_id,
           provider_transfer_id,
           amount_cents,
           provider_environment,
           status,
           notes
      FROM public.tenant_maintenance_payments
     WHERE id = $1::uuid
  `, [fixture.tmp_id])).rows[0] || null;
  const events = (await client.query(`
    /* sql40_events */
    SELECT id::text AS id,
           tenant_id::text AS tenant_id,
           provider_transfer_id,
           provider_metadata
      FROM public.payment_event_log
     WHERE id = ANY ($1::uuid[])
     ORDER BY id::text
  `, [fixture.event_ids])).rows.map((row) => ({
    id: row.id,
    tenant_id: row.tenant_id,
    provider_transfer_id: row.provider_transfer_id,
    synthetic_uat_marker: row.provider_metadata?.synthetic_uat_marker || '',
    harness_id: row.provider_metadata?.harness_id || '',
    checksops_payment_id: String(row.provider_metadata?.checksops_payment_id || ''),
  }));
  const transfers = (await client.query(`
    /* sql40_transfers */
    SELECT count(*)::int AS n
      FROM public.payment_transfers
     WHERE provider_transfer_id = $1
        OR coalesce(provider_metadata->>'obligation_id', '') = $2
        OR coalesce(provider_metadata->>'harness_id', '') = $3
        OR coalesce(provider_metadata->>'checksops_payment_id', '') = $2
  `, [fixture.provider_transfer_id, fixture.tmp_id, fixture.harness_id])).rows[0];
  return {
    tmp: tmp
      ? {
        id: tmp.id,
        tenant_id: tmp.tenant_id,
        provider_transfer_id: tmp.provider_transfer_id,
        amount_cents: Number(tmp.amount_cents),
        provider_environment: tmp.provider_environment,
        status: tmp.status,
        notes: tmp.notes,
        marker_present: String(tmp.notes || '').includes(fixture.marker),
        harness_present: String(tmp.notes || '').includes(`harness=${fixture.harness_id}`),
      }
      : null,
    events,
    payment_transfers: Number(transfers?.n || 0),
  };
}

async function readSql40Preservation(client) {
  const freedom = FORBIDDEN_FREEDOM;
  const freedomTmp = (await client.query(`
    /* sql40_freedom_tmp */
    SELECT id::text AS id,
           tenant_id::text AS tenant_id,
           provider_transfer_id,
           amount_cents,
           provider_environment,
           status
      FROM public.tenant_maintenance_payments
     WHERE id = $1::uuid
  `, [freedom.tmp_id])).rows[0] || null;
  const freedomTransfers = (await client.query(`
    /* sql40_freedom_xfer */
    SELECT provider_transfer_id,
           tenant_id::text AS tenant_id
      FROM public.payment_transfers
     WHERE provider_transfer_id = $1
  `, [freedom.provider_transfer_id])).rows;
  const freedomTmpByXfer = (await client.query(`
    /* sql40_freedom_tmp_by_xfer */
    SELECT id::text AS id,
           tenant_id::text AS tenant_id,
           provider_transfer_id,
           amount_cents,
           provider_environment,
           status
      FROM public.tenant_maintenance_payments
     WHERE provider_transfer_id = $1
        OR id = $2::uuid
  `, [freedom.provider_transfer_id, freedom.tmp_id])).rows;
  const freedomEvents = (await client.query(`
    /* sql40_freedom_events */
    SELECT count(*)::int AS n
      FROM public.payment_event_log
     WHERE provider_transfer_id = $1
        OR id = $2::uuid
  `, [freedom.provider_transfer_id, freedom.tmp_id])).rows[0];
  const grants = (await client.query(`
    /* sql40_tmp_grants */
    SELECT grantee, privilege_type
      FROM information_schema.role_table_grants
     WHERE table_schema = 'public'
       AND table_name = 'tenant_maintenance_payments'
       AND grantee IN ('authenticated', 'checksops', 'PUBLIC', 'anon')
     ORDER BY grantee, privilege_type
  `)).rows;
  const writePolicies = (await client.query(`
    /* sql40_tmp_write_policy */
    SELECT pol.polname AS name,
           pg_get_expr(pol.polqual, pol.polrelid) AS using,
           pg_get_expr(pol.polwithcheck, pol.polrelid) AS with_check
      FROM pg_policy pol
      JOIN pg_class c ON c.oid = pol.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'tenant_maintenance_payments'
       AND pol.polname IN (
         'aws_write_tenant_maintenance_payments',
         'aws_write_tenant_maintenance_payments_job'
       )
     ORDER BY pol.polname
  `)).rows;
  const deleteGranted = grants.some((row) => String(row.privilege_type).toUpperCase() === 'DELETE');
  const write = writePolicies.find((row) => row.name === 'aws_write_tenant_maintenance_payments');
  return {
    freedom_tmp: freedomTmp,
    freedom_tmp_by_transfer_or_id: freedomTmpByXfer,
    freedom_event_count: Number(freedomEvents?.n || 0),
    freedom_transfers: freedomTransfers,
    grants,
    write_policies: writePolicies,
    application_delete_granted: deleteGranted,
    sql39_write_intended: Boolean(
      write && writePredicateIntended(write.using) && writePredicateIntended(write.with_check),
    ),
  };
}

async function handleSql40({
  event,
  authorization,
  identity,
  connect,
  sqlFile40,
}) {
  const embedded = readEmbeddedSql(sqlFile40, AUTHORIZED_SQL40.source_sha256);
  if (!embedded.ok) return embedded;

  let client;
  try {
    client = await connect();
    const live = await readSql40Fixture(client);
    const liveHash = hashFixtureSnapshot(live);
    const guards = evaluateFixtureGuards(live);

    if (event.action === 'inspect' || event.action === 'verify_data' || event.action === 'authorize') {
      const preservation = await readSql40Preservation(client);
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
          fixture: live,
          fixture_guards: guards,
          preservation,
          expected_deletes: {
            payment_event_log: 2,
            tenant_maintenance_payments: 1,
            payment_transfers: 0,
          },
        },
      });
    }

    if (event.action !== 'apply') {
      return fail(CODES.INVALID_MANIFEST, `unsupported SQL 40 executor action ${event.action}`);
    }

    if (!guards.ok) {
      const freedom = guards.errors.some((code) => code.includes('FORBIDDEN'));
      return fail(
        freedom ? CODES.UNRELATED_MUTATION : CODES.SQL_COLLISION,
        'SQL 40 refuse: live fixture does not match the authorized exact-ID synthetic cleanup',
        { errors: guards.errors, live_hash: liveHash },
      );
    }

    const collision = evaluateSqlCollision({
      filename: event.filename,
      migration_id: event.migration_id,
      source_sha256: event.source_sha256,
      target_environment: 'staging',
      expected_live_definition_sha256: event.expected_live_definition_sha256,
      live_definition_sha256: liveHash,
      live_definition: JSON.stringify(live),
    });
    if (!collision.ok) return collision;

    await client.query(embedded.details.text);
    const after = await readSql40Fixture(client);
    const afterHash = hashFixtureSnapshot(after);
    if (afterHash !== EMPTY_FIXTURE_SHA256 || afterHash !== AUTHORIZED_SQL40.intended_replacement_sha256) {
      return fail(CODES.SQL_COLLISION, 'SQL 40 did not leave the authorized empty fixture state', {
        after_hash: afterHash,
        intended_replacement_sha256: AUTHORIZED_SQL40.intended_replacement_sha256,
      });
    }
    if (after.tmp || after.events.length || after.payment_transfers) {
      return fail(CODES.SQL_COLLISION, 'SQL 40 leftover synthetic rows remain', after);
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
        fixture_before: live,
        fixture_after: after,
        deleted: {
          payment_event_log: 2,
          tenant_maintenance_payments: 1,
          payment_transfers: 0,
        },
        application_delete_granted: false,
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

async function handleSql39({
  event,
  authorization,
  identity,
  connect,
  sqlFile39,
}) {
  const embedded = readEmbeddedSql(sqlFile39, AUTHORIZED_SQL39.source_sha256);
  if (!embedded.ok) return embedded;

  let client;
  try {
    client = await connect();
    const live = await readTmpRlsCatalog(client);
    const liveHash = hashTmpRlsCatalog(live);
    const guards = sql39CatalogGuards(live);
    if (!guards.ok) return guards;
    const frozenBefore = await readTmpRlsFrozen(client);
    const frozenBeforeHash = hashTmpRlsFrozen(frozenBefore);

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
          catalog: live,
          frozen_hash: frozenBeforeHash,
        },
      });
    }

    if (event.action !== 'apply') {
      return fail(CODES.INVALID_MANIFEST, `unsupported SQL 39 executor action ${event.action}`);
    }

    const collision = evaluateSqlCollision({
      filename: event.filename,
      migration_id: event.migration_id,
      source_sha256: event.source_sha256,
      target_environment: 'staging',
      expected_live_definition_sha256: event.expected_live_definition_sha256,
      live_definition_sha256: liveHash,
      live_definition: JSON.stringify(live),
    });
    if (!collision.ok) return collision;

    await client.query(embedded.details.text);
    const after = await readTmpRlsCatalog(client);
    const afterGuards = sql39AfterGuards(live, after);
    if (!afterGuards.ok) return afterGuards;
    const frozenAfter = await readTmpRlsFrozen(client);
    const frozenAfterHash = hashTmpRlsFrozen(frozenAfter);
    if (frozenAfterHash !== frozenBeforeHash) {
      return fail(CODES.UNRELATED_MUTATION, 'SQL 39 changed TMP helper functions or triggers', {
        before: frozenBeforeHash,
        after: frozenAfterHash,
      });
    }

    consumeOneUse(event.one_use_id);
    return ok({
      receipt: {
        workstream: event.workstream_id,
        commit: event.commit,
        sql_file: event.filename,
        before_hash: liveHash,
        after_hash: hashTmpRlsCatalog(after),
        result: 'applied',
        executor_identity: identity,
        catalog_before: live,
        catalog_after: after,
        job_policy_intact: true,
        frozen_hash: frozenAfterHash,
        inspected_job: INSPECTED_JOB,
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

function ledgerSqlForbiddenMutation(sqlText) {
  const text = String(sqlText || '');
  if (!LEDGER_SINGLE_STATEMENT_RE.test(text)) return 'not a single CREATE OR REPLACE of the pinned function';
  if (/\b(DROP|ALTER|GRANT|REVOKE|TRUNCATE|DELETE)\b/i.test(text)) return 'DROP|ALTER|GRANT|REVOKE|TRUNCATE|DELETE';
  if (/\bCREATE\s+(OR\s+REPLACE\s+)?TRIGGER\b/i.test(text)) return 'CREATE TRIGGER';
  for (const marker of LEDGER_FORBIDDEN_MARKERS) {
    if (text.includes(marker)) return marker;
  }
  return null;
}

async function readLedgerState(client, pin = AUTHORIZED_LEDGER_20261007193200) {
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

function ledgerPreconditionErrors(state, pin = AUTHORIZED_LEDGER_20261007193200) {
  const drifted = state.preserved_functions
    .filter((row) => row.definitionSha256 !== row.expectedSha256)
    .map((row) => row.identity);
  const byName = new Map(state.triggers.map((row) => [row.name, row.function_name]));
  const missingTriggers = Object.entries(pin.required_ledger_triggers)
    .filter(([name, fn]) => byName.get(name) !== fn)
    .map(([name]) => name);
  return { drifted, missingTriggers };
}

function ledgerPinExact(event = {}, pin = AUTHORIZED_LEDGER_20261007193200) {
  return event.filename === pin.filename
    && event.migration_id === pin.migration_id
    && event.source_sha256 === pin.source_sha256
    && event.intended_replacement_sha256 === pin.intended_replacement_sha256
    && event.expected_live_definition_sha256 === pin.expected_live_definition_sha256
    && event.commit === pin.commit;
}

async function handleLedger20261007193200({
  event,
  authorization,
  identity,
  connect,
  sqlFileLedger,
}) {
  const pin = AUTHORIZED_LEDGER_20261007193200;
  const embedded = readEmbeddedSql(sqlFileLedger, pin.source_sha256);
  if (!embedded.ok) return embedded;
  const forbidden = ledgerSqlForbiddenMutation(embedded.details.text);
  if (forbidden) {
    return fail(CODES.UNRELATED_MUTATION, 'embedded ledger SQL contains a forbidden mutation', {
      marker: forbidden,
    });
  }

  const readOnly = event.action === 'inspect' || event.action === 'verify_data' || event.action === 'authorize';
  if (!readOnly && event.action !== 'apply') {
    return fail(CODES.INVALID_MANIFEST, `unsupported ledger executor action ${event.action}`);
  }
  if (event.action === 'apply' && !ledgerPinExact(event, pin)) {
    return fail(CODES.SQL_COLLISION, 'ledger apply is bound to the exact allowlisted pin', {
      filename: event.filename || null,
      migration_id: event.migration_id || null,
      expected_live_definition_sha256: event.expected_live_definition_sha256 || null,
    });
  }

  let client;
  let inTx = false;
  const rollback = async () => {
    if (inTx) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    }
    inTx = false;
  };
  try {
    client = await connect();

    if (readOnly) {
      const state = await readLedgerState(client, pin);
      if (!state.ok) return state;
      const { drifted, missingTriggers } = ledgerPreconditionErrors(state.details, pin);
      return ok({
        authorization: authorization.details,
        receipt: {
          workstream: event.workstream_id,
          commit: event.commit,
          sql_file: event.filename,
          before_hash: state.details.live_definition_sha256,
          after_hash: state.details.live_definition_sha256,
          result: event.action,
          executor_identity: identity,
          function_identity: pin.function_identity,
          ...state.details,
          apply_preconditions_met: state.details.live_definition_sha256 === pin.expected_live_definition_sha256
            && drifted.length === 0
            && missingTriggers.length === 0,
          drifted_preserved_functions: drifted,
          missing_ledger_triggers: missingTriggers,
        },
      });
    }

    await client.query('BEGIN');
    inTx = true;
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [pin.function_identity]);

    if (isConsumed(event.one_use_id)) {
      await rollback();
      return fail(CODES.SQL_COLLISION, 'one_use_id has already been consumed; replay is forbidden', {
        one_use_id: event.one_use_id,
      });
    }

    const before = await readLedgerState(client, pin);
    if (!before.ok) {
      await rollback();
      return before;
    }
    const liveHash = before.details.live_definition_sha256;
    if (before.details.exists !== true) {
      await rollback();
      return fail(CODES.SQL_COLLISION, 'ledger apply is replace-only; the function is missing', {
        function_identity: pin.function_identity,
      });
    }
    if (liveHash === pin.intended_replacement_sha256) {
      await rollback();
      return fail(CODES.UNRELATED_MUTATION, 'ledger function already matches the intended definition; refuse replace', {
        live_definition_sha256: liveHash,
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
      await rollback();
      return fail(CODES.DEPLOYMENT_COLLISION, 'expected live fingerprint changed immediately before apply', {
        expected_live_definition_sha256: event.expected_live_definition_sha256,
        live_definition_sha256: liveHash,
      });
    }
    const pre = ledgerPreconditionErrors(before.details, pin);
    if (pre.drifted.length || pre.missingTriggers.length) {
      await rollback();
      return fail(CODES.DEPLOYMENT_COLLISION, 'ledger preconditions do not hold immediately before apply', {
        drifted_preserved_functions: pre.drifted,
        missing_ledger_triggers: pre.missingTriggers,
      });
    }

    await client.query(embedded.details.text);

    const after = await readLedgerState(client, pin);
    if (!after.ok) {
      await rollback();
      return after;
    }
    if (after.details.live_definition_sha256 !== pin.intended_replacement_sha256) {
      await rollback();
      return fail(CODES.SQL_COLLISION, 'applied ledger definition does not match the intended hash', {
        after_hash: after.details.live_definition_sha256,
        intended_replacement_sha256: pin.intended_replacement_sha256,
      });
    }
    const post = ledgerPreconditionErrors(after.details, pin);
    if (post.drifted.length || post.missingTriggers.length
      || after.details.triggers_sha256 !== before.details.triggers_sha256) {
      await rollback();
      return fail(CODES.UNRELATED_MUTATION, 'ledger apply changed a preserved function or trigger', {
        drifted_preserved_functions: post.drifted,
        missing_ledger_triggers: post.missingTriggers,
        triggers_before_sha256: before.details.triggers_sha256,
        triggers_after_sha256: after.details.triggers_sha256,
      });
    }
    if (after.details.ledger_event_count !== before.details.ledger_event_count) {
      await rollback();
      return fail(CODES.UNRELATED_MUTATION, 'ledger apply changed homeowner_ledger_events rows', {
        before: before.details.ledger_event_count,
        after: after.details.ledger_event_count,
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
        after_hash: after.details.live_definition_sha256,
        result: 'applied',
        executor_identity: identity,
        function_identity: pin.function_identity,
        preserved_functions: after.details.preserved_functions,
        triggers: after.details.triggers,
        ledger_event_count: after.details.ledger_event_count,
      },
    });
  } catch (error) {
    await rollback();
    return fail(CODES.UNRELATED_MUTATION, String(error?.message || error).slice(0, 400));
  } finally {
    await rollback();
    if (client) {
      try { await client.end(); } catch { /* ignore */ }
    }
  }
}

// --- SQL 71: GRANT UPDATE (amount) to checksops -----------------------------

const COLUMN_UPDATE_PRIVILEGES_SQL = `
SELECT c.column_name AS column_name,
       has_column_privilege($1::text, 'public.check_intake_items', c.column_name, 'UPDATE') AS can_update
FROM information_schema.columns c
WHERE c.table_schema = 'public' AND c.table_name = 'check_intake_items'
ORDER BY c.column_name
`.trim();
const TABLE_UPDATE_PRIVILEGE_SQL = "SELECT has_table_privilege($1::text, 'public.check_intake_items', 'UPDATE') AS can_update";
// The file may hold only comments and this one statement.
const SQL71_SINGLE_STATEMENT_RE = /^(?:\s*--[^\n]*\n)*\s*GRANT UPDATE \(amount\) ON TABLE public\.check_intake_items TO checksops;\s*$/;

async function readAmountGrantState(client, pin = AUTHORIZED_SQL71_AMOUNT_GRANT) {
  const rows = (await client.query(COLUMN_UPDATE_PRIVILEGES_SQL, [pin.grantee]))?.rows || [];
  if (!rows.length) {
    return fail(CODES.SQL_COLLISION, 'public.check_intake_items has no columns visible to the executor');
  }
  const tableLevel = (await client.query(TABLE_UPDATE_PRIVILEGE_SQL, [pin.grantee]))?.rows?.[0]?.can_update === true;
  const updatable = rows.filter((row) => row.can_update === true).map((row) => row.column_name);
  const amountRow = rows.find((row) => row.column_name === pin.column);
  if (!amountRow) return fail(CODES.SQL_COLLISION, 'check_intake_items.amount is missing');
  const granted = amountRow.can_update === true;
  const stateText = granted ? AMOUNT_GRANT_STATE_TEXT.granted : AMOUNT_GRANT_STATE_TEXT.absent;
  return ok({
    amount_update_granted: granted,
    table_level_update: tableLevel,
    updatable_columns: updatable,
    updatable_columns_sha256: hashSqlDefinition(updatable.join(',')),
    live_definition_sha256: hashSqlDefinition(stateText),
  });
}

async function handleSql71AmountGrant({ event, authorization, identity, connect, sqlFile71 }) {
  const pin = AUTHORIZED_SQL71_AMOUNT_GRANT;
  const embedded = readEmbeddedSql(sqlFile71, pin.source_sha256);
  if (!embedded.ok) return embedded;
  if (!SQL71_SINGLE_STATEMENT_RE.test(embedded.details.text)) {
    return fail(CODES.UNRELATED_MUTATION, 'embedded SQL 71 is not the single pinned GRANT statement');
  }
  const readOnly = event.action === 'inspect' || event.action === 'verify_data' || event.action === 'authorize';
  if (!readOnly && event.action !== 'apply') {
    return fail(CODES.INVALID_MANIFEST, `unsupported SQL 71 executor action ${event.action}`);
  }
  if (event.action === 'apply' && !(
    event.filename === pin.filename
    && event.migration_id === pin.migration_id
    && event.source_sha256 === pin.source_sha256
    && event.intended_replacement_sha256 === pin.intended_replacement_sha256
    && event.expected_live_definition_sha256 === pin.expected_live_definition_sha256
    && event.commit === pin.commit
  )) {
    return fail(CODES.SQL_COLLISION, 'SQL 71 apply is bound to the exact allowlisted pin');
  }

  let client;
  let inTx = false;
  const rollback = async () => {
    if (inTx) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    }
    inTx = false;
  };
  try {
    client = await connect();
    if (readOnly) {
      const state = await readAmountGrantState(client, pin);
      if (!state.ok) return state;
      return ok({
        authorization: authorization.details,
        receipt: {
          workstream: event.workstream_id,
          commit: event.commit,
          sql_file: event.filename,
          before_hash: state.details.live_definition_sha256,
          after_hash: state.details.live_definition_sha256,
          result: event.action,
          executor_identity: identity,
          ...state.details,
          apply_preconditions_met: state.details.live_definition_sha256 === pin.expected_live_definition_sha256
            && state.details.table_level_update === false,
        },
      });
    }

    await client.query('BEGIN');
    inTx = true;
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['sql71_amount_grant']);
    if (isConsumed(event.one_use_id)) {
      await rollback();
      return fail(CODES.SQL_COLLISION, 'one_use_id has already been consumed; replay is forbidden', {
        one_use_id: event.one_use_id,
      });
    }
    const before = await readAmountGrantState(client, pin);
    if (!before.ok) {
      await rollback();
      return before;
    }
    if (before.details.amount_update_granted) {
      await rollback();
      return fail(CODES.UNRELATED_MUTATION, 'checksops already has UPDATE (amount); refuse re-grant');
    }
    if (before.details.table_level_update) {
      await rollback();
      return fail(CODES.DEPLOYMENT_COLLISION, 'checksops has table-level UPDATE; column grants are not in the expected state');
    }
    if (before.details.live_definition_sha256 !== event.expected_live_definition_sha256) {
      await rollback();
      return fail(CODES.DEPLOYMENT_COLLISION, 'expected live privilege state changed immediately before apply');
    }

    await client.query(embedded.details.text);

    const after = await readAmountGrantState(client, pin);
    if (!after.ok) {
      await rollback();
      return after;
    }
    const expectedAfter = [...before.details.updatable_columns, pin.column].sort();
    const actualAfter = [...after.details.updatable_columns].sort();
    if (after.details.live_definition_sha256 !== pin.intended_replacement_sha256
      || after.details.table_level_update
      || JSON.stringify(actualAfter) !== JSON.stringify(expectedAfter)) {
      await rollback();
      return fail(CODES.UNRELATED_MUTATION, 'grant changed more than UPDATE (amount) for checksops', {
        before: before.details.updatable_columns,
        after: after.details.updatable_columns,
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
        before_hash: before.details.live_definition_sha256,
        after_hash: after.details.live_definition_sha256,
        result: 'applied',
        executor_identity: identity,
        updatable_columns_before: before.details.updatable_columns,
        updatable_columns_after: after.details.updatable_columns,
      },
    });
  } catch (error) {
    await rollback();
    return fail(CODES.UNRELATED_MUTATION, String(error?.message || error).slice(0, 400));
  } finally {
    await rollback();
    if (client) {
      try { await client.end(); } catch { /* ignore */ }
    }
  }
}

// --- SQL 72: tenant-member payment write policies ---------------------------

const PAYMENT_POLICIES_SQL = `
SELECT tablename, policyname, cmd, roles::text AS roles, permissive, qual, with_check
FROM pg_policies
WHERE schemaname = 'public' AND tablename = ANY($1::text[])
ORDER BY tablename, policyname
`.trim();
const REQUIRED_FUNCTIONS_SQL = `
SELECT p.proname, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS can_execute
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = ANY($1::text[])
`.trim();
const MEMBER_POLICY_CLAUSE_MARKERS = ['aws_is_authenticated()', 'aws_financial_execution_active()', 'aws_user_tenant_ids()'];
const MEMBER_POLICY_FORBIDDEN_MARKERS = ['aws_is_cross_tenant_reader', 'has_role', 'aws_can_access_tenant', 'aws_can_write_tenant'];
// The exact statements SQL 72 may contain, in file order: DROP then CREATE per policy.
const SQL72_FILE_ORDER = [
  'aws_member_insert_payment_transfers',
  'aws_member_update_payment_transfers',
  'aws_member_insert_payment_wallets',
  'aws_member_update_payment_wallets',
  'aws_member_insert_payment_event_log',
];
const SQL72_MEMBER_CONDITION = 'public.aws_is_authenticated() AND COALESCE(public.aws_financial_execution_active(), false) AND tenant_id IN (SELECT public.aws_user_tenant_ids())';
const normalizeSqlStatement = (text) => String(text).replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();

export function sql72ExpectedStatements() {
  return SQL72_FILE_ORDER.flatMap((name) => {
    const pinned = MEMBER_PAYMENT_POLICIES.find((row) => row.name === name);
    const clauses = pinned.cmd === 'UPDATE'
      ? `USING (${SQL72_MEMBER_CONDITION}) WITH CHECK (${SQL72_MEMBER_CONDITION})`
      : `WITH CHECK (${SQL72_MEMBER_CONDITION})`;
    return [
      `DROP POLICY IF EXISTS ${name} ON public.${pinned.table}`,
      normalizeSqlStatement(`CREATE POLICY ${name} ON public.${pinned.table} FOR ${pinned.cmd} TO authenticated ${clauses}`),
    ];
  });
}

export function sql72StatementsAllowed(text) {
  const body = String(text || '').split('\n').filter((line) => !/^\s*--/.test(line)).join('\n');
  const statements = body.split(';').map(normalizeSqlStatement).filter(Boolean);
  const expected = sql72ExpectedStatements();
  return statements.length === expected.length && statements.every((statement, index) => statement === expected[index]);
}

const memberPolicyWellFormed = (row, pinned) => {
  if (row.cmd !== pinned.cmd || row.roles !== '{authenticated}' || row.permissive !== 'PERMISSIVE') return false;
  const clauses = pinned.cmd === 'UPDATE' ? [row.qual, row.with_check] : [row.with_check];
  if (pinned.cmd === 'INSERT' && row.qual) return false;
  // Every clause is a pure AND of the three conditions: an OR could loosen it.
  return clauses.every((clause) => typeof clause === 'string'
    && !/\bOR\b/i.test(clause)
    && MEMBER_POLICY_CLAUSE_MARKERS.every((marker) => clause.includes(marker))
    && MEMBER_POLICY_FORBIDDEN_MARKERS.every((marker) => !clause.includes(marker)));
};

export async function readMemberPaymentPolicyState(client) {
  const tables = [...new Set(MEMBER_PAYMENT_POLICIES.map((row) => row.table))];
  const rows = (await client.query(PAYMENT_POLICIES_SQL, [tables]))?.rows || [];
  const isMember = (row) => MEMBER_PAYMENT_POLICIES.some((pinned) => pinned.name === row.policyname && pinned.table === row.tablename);
  const others = rows.filter((row) => !isMember(row));
  const states = MEMBER_PAYMENT_POLICIES.map((pinned) => {
    const row = rows.find((candidate) => candidate.policyname === pinned.name && candidate.tablename === pinned.table);
    if (!row) return 'absent';
    return memberPolicyWellFormed(row, pinned) ? 'present' : 'malformed';
  });
  const stateText = memberPaymentPolicyStateText(states);
  // Present and executable by authenticated: otherwise every policy check on these tables would error.
  const functions = ((await client.query(REQUIRED_FUNCTIONS_SQL, [[...MEMBER_PAYMENT_REQUIRED_FUNCTIONS]]))?.rows || [])
    .filter((row) => row.can_execute === true)
    .map((row) => row.proname);
  return ok({
    member_policy_states: Object.fromEntries(MEMBER_PAYMENT_POLICIES.map((row, index) => [row.name, states[index]])),
    other_policy_count: others.length,
    other_policies_sha256: hashSqlDefinition(JSON.stringify(others)),
    required_functions_present: MEMBER_PAYMENT_REQUIRED_FUNCTIONS.every((name) => functions.includes(name)),
    live_definition_sha256: hashSqlDefinition(stateText),
  });
}

async function handleSql72MemberPaymentWrites({ event, authorization, identity, connect, sqlFile72 }) {
  const pin = AUTHORIZED_SQL72_MEMBER_PAYMENT_WRITES;
  const embedded = readEmbeddedSql(sqlFile72, pin.source_sha256);
  if (!embedded.ok) return embedded;
  if (!sql72StatementsAllowed(embedded.details.text)) {
    return fail(CODES.UNRELATED_MUTATION, 'embedded SQL 72 is not the pinned member payment policy statements');
  }
  const readOnly = event.action === 'inspect' || event.action === 'verify_data' || event.action === 'authorize';
  if (!readOnly && event.action !== 'apply') {
    return fail(CODES.INVALID_MANIFEST, `unsupported SQL 72 executor action ${event.action}`);
  }
  if (event.action === 'apply' && !(
    event.filename === pin.filename
    && event.migration_id === pin.migration_id
    && event.source_sha256 === pin.source_sha256
    && event.intended_replacement_sha256 === pin.intended_replacement_sha256
    && event.expected_live_definition_sha256 === pin.expected_live_definition_sha256
    && event.commit === pin.commit
  )) {
    return fail(CODES.SQL_COLLISION, 'SQL 72 apply is bound to the exact allowlisted pin');
  }

  let client;
  let inTx = false;
  const rollback = async () => {
    if (inTx) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    }
    inTx = false;
  };
  try {
    client = await connect();
    if (readOnly) {
      const state = await readMemberPaymentPolicyState(client);
      if (!state.ok) return state;
      return ok({
        authorization: authorization.details,
        receipt: {
          workstream: event.workstream_id,
          commit: event.commit,
          sql_file: event.filename,
          before_hash: state.details.live_definition_sha256,
          after_hash: state.details.live_definition_sha256,
          result: event.action,
          executor_identity: identity,
          ...state.details,
          apply_preconditions_met: state.details.live_definition_sha256 === pin.expected_live_definition_sha256
            && state.details.required_functions_present === true,
        },
      });
    }

    await client.query('BEGIN');
    inTx = true;
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['sql72_member_payment_writes']);
    if (isConsumed(event.one_use_id)) {
      await rollback();
      return fail(CODES.SQL_COLLISION, 'one_use_id has already been consumed; replay is forbidden', {
        one_use_id: event.one_use_id,
      });
    }
    const before = await readMemberPaymentPolicyState(client);
    if (!before.ok) {
      await rollback();
      return before;
    }
    if (before.details.live_definition_sha256 === pin.intended_replacement_sha256) {
      await rollback();
      return fail(CODES.UNRELATED_MUTATION, 'SQL 72 member payment policies are already present; refuse re-apply');
    }
    if (before.details.live_definition_sha256 !== pin.expected_live_definition_sha256
      || before.details.live_definition_sha256 !== event.expected_live_definition_sha256) {
      await rollback();
      return fail(CODES.DEPLOYMENT_COLLISION, 'member payment policies are not in the expected absent state');
    }
    if (!before.details.required_functions_present) {
      await rollback();
      return fail(CODES.DEPLOYMENT_COLLISION, 'SQL 72 helper functions are missing on the target database');
    }

    await client.query(embedded.details.text);

    const after = await readMemberPaymentPolicyState(client);
    if (!after.ok) {
      await rollback();
      return after;
    }
    if (after.details.live_definition_sha256 !== pin.intended_replacement_sha256
      || after.details.other_policies_sha256 !== before.details.other_policies_sha256
      || after.details.other_policy_count !== before.details.other_policy_count) {
      await rollback();
      return fail(CODES.UNRELATED_MUTATION, 'SQL 72 changed more than the five member payment policies', {
        before: before.details.member_policy_states,
        after: after.details.member_policy_states,
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
        before_hash: before.details.live_definition_sha256,
        after_hash: after.details.live_definition_sha256,
        result: 'applied',
        executor_identity: identity,
        member_policy_states_after: after.details.member_policy_states,
        other_policy_count: after.details.other_policy_count,
      },
    });
  } catch (error) {
    await rollback();
    return fail(CODES.UNRELATED_MUTATION, String(error?.message || error).slice(0, 400));
  } finally {
    await rollback();
    if (client) {
      try { await client.end(); } catch { /* ignore */ }
    }
  }
}

// --- SQL 76: tenant partnership invitee consent guard -----------------------

const PARTNERSHIP_TABLE_SQL = `
SELECT c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c
WHERE c.oid = to_regclass('public.tenant_partnerships')
`.trim();
const PARTNERSHIP_GUARD_SQL = `
SELECT p.prosrc, l.lanname, p.prosecdef, p.proconfig::text[] AS proconfig,
  format_type(p.prorettype, NULL) AS rettype, p.pronargs::int AS pronargs,
  EXISTS (
    SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
  ) AS public_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_language l ON l.oid = p.prolang
WHERE n.nspname = 'public' AND p.proname = 'aws_tenant_partnership_consent_guard'
`.trim();
const PARTNERSHIP_TRIGGERS_SQL = `
SELECT t.tgname, t.tgtype::int AS tgtype, t.tgenabled::text AS tgenabled, t.tgnargs::int AS tgnargs,
  t.tgattr::text AS tgattr, t.tgqual IS NOT NULL AS has_qual,
  pn.nspname || '.' || p.proname AS function_name, pg_get_triggerdef(t.oid) AS definition
FROM pg_trigger t
JOIN pg_proc p ON p.oid = t.tgfoid
JOIN pg_namespace pn ON pn.oid = p.pronamespace
WHERE t.tgrelid = to_regclass('public.tenant_partnerships') AND NOT t.tgisinternal
ORDER BY t.tgname
`.trim();
const PARTNERSHIP_CONNECT_SQL = `
SELECT p.prosrc, p.prosecdef, p.proconfig::text[] AS proconfig
FROM pg_proc p
WHERE p.oid = to_regprocedure('public.aws_connect_partner_by_code(text, uuid)')
`.trim();
// ROW (1) | BEFORE (2) | INSERT (4) | UPDATE (16)
const SQL76_TRIGGER_TYPE = 23;
const SQL76_GUARD_FUNCTION_NAME = 'public.aws_tenant_partnership_consent_guard';
const SQL76_MARKER_ENTRY = `${PARTNERSHIP_WRITER_SETTING}=${PARTNERSHIP_WRITER_VALUE}`;
const SQL76_BODY_PLACEHOLDER = '$$BODY$$';
// The exact statements SQL 76 may contain, in file order. The function body is
// pinned by the file's source_sha256 and checked separately.
export const SQL76_EXPECTED_STATEMENTS = Object.freeze([
  /^CREATE OR REPLACE FUNCTION public\.aws_tenant_partnership_consent_guard\(\) RETURNS trigger LANGUAGE plpgsql SET search_path = public AS \$\$BODY\$\$$/,
  /^COMMENT ON FUNCTION public\.aws_tenant_partnership_consent_guard\(\) IS '[^']*'$/,
  /^REVOKE ALL ON FUNCTION public\.aws_tenant_partnership_consent_guard\(\) FROM PUBLIC$/,
  /^DROP TRIGGER IF EXISTS aws_tenant_partnership_consent_guard ON public\.tenant_partnerships$/,
  /^CREATE TRIGGER aws_tenant_partnership_consent_guard BEFORE INSERT OR UPDATE ON public\.tenant_partnerships FOR EACH ROW EXECUTE FUNCTION public\.aws_tenant_partnership_consent_guard\(\)$/,
  /^ALTER FUNCTION public\.aws_connect_partner_by_code\(text, uuid\) SET checksops\.partnership_writer = 'aws_connect_partner_by_code'$/,
  ...PARTNERSHIP_RETIRED_POLICIES.map((name) => new RegExp(`^DROP POLICY IF EXISTS "${name}" ON public\\.tenant_partnerships$`)),
]);
const SQL76_BODY_REQUIRED_MARKERS = [
  "current_setting('checksops.partnership_writer', true) = 'aws_connect_partner_by_code'",
  'NEW.invitee_tenant_id IN (SELECT public.aws_user_tenant_ids())',
  'COALESCE(public.aws_can_write_tenant(NEW.invitee_tenant_id), false)',
  "RAISE EXCEPTION 'partnership_invitee_consent_required' USING ERRCODE = '42501'",
  "RAISE EXCEPTION 'partnership_tenants_immutable' USING ERRCODE = '42501'",
  'RETURN NEW;',
];
const SQL76_BODY_FORBIDDEN = [
  /\bEXECUTE\b/i,
  /set_config/i,
  /SECURITY\s+DEFINER/i,
  /has_role/i,
  /cross_tenant/i,
  /aws_can_write_tenant\(\s*NEW\.inviter/i,
  /inviter_tenant_id\s+IN\b/i,
  /\b(INSERT|DELETE|TRUNCATE|GRANT|REVOKE|ALTER|DROP|CREATE|PERFORM)\b/i,
  // TG_OP = 'UPDATE' is the only UPDATE the guard may name (stripped before this check).
  /\bUPDATE\b/i,
];

/** The guard function body exactly as Postgres stores it in prosrc, or null. */
export function sql76GuardBody(text) {
  const parts = String(text || '').split('$$');
  return parts.length === 3 ? parts[1] : null;
}

export function sql76StatementsAllowed(text) {
  const raw = String(text || '');
  const body = sql76GuardBody(raw);
  if (body == null) return false;
  if (!SQL76_BODY_REQUIRED_MARKERS.every((marker) => body.includes(marker))) return false;
  if (SQL76_BODY_FORBIDDEN.some((pattern) => pattern.test(body.replace(/'UPDATE'/g, "''")))) return false;
  const outside = raw.replace(`$$${body}$$`, () => SQL76_BODY_PLACEHOLDER);
  const statements = outside
    .split('\n').filter((line) => !/^\s*--/.test(line)).join('\n')
    .split(';').map(normalizeSqlStatement).filter(Boolean);
  return statements.length === SQL76_EXPECTED_STATEMENTS.length
    && statements.every((statement, index) => SQL76_EXPECTED_STATEMENTS[index].test(statement));
}

const sameConfig = (actual, expected) => Array.isArray(actual)
  && actual.length === expected.length
  && actual.every((entry, index) => entry === expected[index]);

function classifyPartnershipGuard(rows, expectedBody) {
  if (rows.length === 0) return 'absent';
  if (rows.length !== 1) return 'different';
  const [row] = rows;
  return row.lanname === 'plpgsql'
    && row.prosecdef === false
    && row.rettype === 'trigger'
    && Number(row.pronargs) === 0
    && sameConfig(row.proconfig, ['search_path=public'])
    && row.public_execute === false
    && typeof expectedBody === 'string'
    && row.prosrc === expectedBody
    ? 'pinned'
    : 'different';
}

function classifyPartnershipTrigger(row) {
  if (!row) return 'absent';
  return row.function_name === SQL76_GUARD_FUNCTION_NAME
    && Number(row.tgtype) === SQL76_TRIGGER_TYPE
    && row.tgenabled === 'O'
    && Number(row.tgnargs) === 0
    && String(row.tgattr || '') === ''
    && row.has_qual === false
    ? 'pinned'
    : 'different';
}

function classifyPartnershipConnect(row) {
  if (!row) return 'missing_function';
  const rest = (row.proconfig || []).filter((entry) => !String(entry).startsWith(`${PARTNERSHIP_WRITER_SETTING}=`));
  return row.prosecdef === true
    && sameConfig(rest, PARTNERSHIP_CONNECT_CONFIG)
    && hashSqlDefinition(String(row.prosrc ?? '')) === PARTNERSHIP_CONNECT_BODY_SHA256
    ? 'pinned'
    : 'different';
}

function classifyPartnershipMarker(row) {
  if (!row) return 'missing_function';
  const entries = (row.proconfig || []).filter((entry) => String(entry).startsWith(`${PARTNERSHIP_WRITER_SETTING}=`));
  if (entries.length === 0) return 'unset';
  return entries.length === 1 && entries[0] === SQL76_MARKER_ENTRY ? 'pinned' : 'different';
}

/**
 * Read-only fingerprint of what SQL 76 touches on public.tenant_partnerships.
 * `expectedBody` is the guard body from the embedded file (prosrc must equal it
 * for the guard to read as pinned).
 */
export async function readPartnershipConsentState(client, expectedBody) {
  const table = ((await client.query(PARTNERSHIP_TABLE_SQL))?.rows || [])[0] || null;
  const guardRows = (await client.query(PARTNERSHIP_GUARD_SQL))?.rows || [];
  const triggers = (await client.query(PARTNERSHIP_TRIGGERS_SQL))?.rows || [];
  const connectRow = ((await client.query(PARTNERSHIP_CONNECT_SQL))?.rows || [])[0] || null;
  const policies = (await client.query(PAYMENT_POLICIES_SQL, [['tenant_partnerships']]))?.rows || [];
  const functions = ((await client.query(REQUIRED_FUNCTIONS_SQL, [[...PARTNERSHIP_CONSENT_REQUIRED_FUNCTIONS]]))?.rows || [])
    .filter((row) => row.can_execute === true)
    .map((row) => row.proname);

  const guardTrigger = triggers.find((row) => row.tgname === PARTNERSHIP_CONSENT_TRIGGER) || null;
  const otherTriggers = triggers.filter((row) => row.tgname !== PARTNERSHIP_CONSENT_TRIGGER);
  const otherPolicies = policies.filter((row) => !PARTNERSHIP_RETIRED_POLICIES.includes(row.policyname));
  const state = {
    guard: classifyPartnershipGuard(guardRows, expectedBody),
    trigger: classifyPartnershipTrigger(guardTrigger),
    marker: classifyPartnershipMarker(connectRow),
    policies: PARTNERSHIP_RETIRED_POLICIES.map((name) => (policies.some((row) => row.policyname === name) ? 'present' : 'absent')),
    connect: classifyPartnershipConnect(connectRow),
    otherTriggers: otherTriggers.length === 0 ? 'none' : 'present',
  };
  // Everything SQL 76 must leave alone: the table's RLS flags, every other
  // policy and trigger on it, and aws_connect_partner_by_code apart from the marker.
  const connectRest = connectRow
    ? {
      prosrc: connectRow.prosrc,
      prosecdef: connectRow.prosecdef,
      proconfig: (connectRow.proconfig || []).filter((entry) => !String(entry).startsWith(`${PARTNERSHIP_WRITER_SETTING}=`)),
    }
    : null;
  return ok({
    table_present: Boolean(table),
    connect_function_present: Boolean(connectRow),
    required_functions_present: PARTNERSHIP_CONSENT_REQUIRED_FUNCTIONS.every((name) => functions.includes(name)),
    consent_state: {
      guard: state.guard,
      trigger: state.trigger,
      marker: state.marker,
      policies: Object.fromEntries(PARTNERSHIP_RETIRED_POLICIES.map((name, index) => [name, state.policies[index]])),
      connect: state.connect,
      other_triggers: state.otherTriggers,
    },
    other_policy_count: otherPolicies.length,
    other_trigger_count: otherTriggers.length,
    preserved_sha256: hashSqlDefinition(JSON.stringify({
      table,
      other_policies: otherPolicies,
      other_triggers: otherTriggers,
      connect: connectRest,
    })),
    live_definition_sha256: hashSqlDefinition(partnershipConsentStateText(state)),
  });
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/**
 * A test may supply `pin` only as the committed pin with a reviewed
 * expected_live_definition_sha256 filled in; every other field must match.
 */
function sql76PinIsCommitted(pin) {
  const committed = AUTHORIZED_SQL76_PARTNERSHIP_CONSENT;
  return Boolean(pin) && ['filename', 'migration_id', 'commit', 'source_sha256', 'intended_replacement_sha256', 'table']
    .every((key) => pin[key] === committed[key]);
}

async function handleSql76PartnershipConsent({
  event,
  authorization,
  identity,
  connect,
  sqlFile76,
  pin = AUTHORIZED_SQL76_PARTNERSHIP_CONSENT,
}) {
  if (!sql76PinIsCommitted(pin)) {
    return fail(CODES.SQL_COLLISION, 'SQL 76 pin does not match the committed allowlist entry');
  }
  const embedded = readEmbeddedSql(sqlFile76, pin.source_sha256);
  if (!embedded.ok) return embedded;
  if (!sql76StatementsAllowed(embedded.details.text)) {
    return fail(CODES.UNRELATED_MUTATION, 'embedded SQL 76 is not the pinned partnership consent statements');
  }
  const expectedBody = sql76GuardBody(embedded.details.text);
  const readOnly = event.action === 'inspect' || event.action === 'verify_data' || event.action === 'authorize';
  if (!readOnly && event.action !== 'apply') {
    return fail(CODES.INVALID_MANIFEST, `unsupported SQL 76 executor action ${event.action}`);
  }
  const pinExecutable = SHA256_HEX_RE.test(String(pin.expected_live_definition_sha256 || ''));
  if (event.action === 'apply' && !pinExecutable) {
    return fail(CODES.SQL_COLLISION, 'SQL 76 pin has no reviewed pre-apply live definition hash yet; apply is refused');
  }
  if (event.action === 'apply' && !(
    event.filename === pin.filename
    && event.migration_id === pin.migration_id
    && event.source_sha256 === pin.source_sha256
    && event.intended_replacement_sha256 === pin.intended_replacement_sha256
    && event.expected_live_definition_sha256 === pin.expected_live_definition_sha256
    && event.commit === pin.commit
  )) {
    return fail(CODES.SQL_COLLISION, 'SQL 76 apply is bound to the exact allowlisted pin');
  }

  let client;
  let inTx = false;
  const rollback = async () => {
    if (inTx) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    }
    inTx = false;
  };
  const prerequisitesMet = (details) => details.table_present === true
    && details.connect_function_present === true
    && details.required_functions_present === true;
  try {
    client = await connect();
    if (readOnly) {
      const state = await readPartnershipConsentState(client, expectedBody);
      if (!state.ok) return state;
      return ok({
        authorization: authorization.details,
        receipt: {
          workstream: event.workstream_id,
          commit: event.commit,
          sql_file: event.filename,
          before_hash: state.details.live_definition_sha256,
          after_hash: state.details.live_definition_sha256,
          result: event.action,
          executor_identity: identity,
          ...state.details,
          pin_executable: pinExecutable,
          apply_preconditions_met: pinExecutable
            && state.details.live_definition_sha256 === pin.expected_live_definition_sha256
            && prerequisitesMet(state.details),
        },
      });
    }

    await client.query('BEGIN');
    inTx = true;
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['sql76_tenant_partnership_invitee_consent']);
    if (isConsumed(event.one_use_id)) {
      await rollback();
      return fail(CODES.SQL_COLLISION, 'one_use_id has already been consumed; replay is forbidden', {
        one_use_id: event.one_use_id,
      });
    }
    const before = await readPartnershipConsentState(client, expectedBody);
    if (!before.ok) {
      await rollback();
      return before;
    }
    if (before.details.live_definition_sha256 === pin.intended_replacement_sha256) {
      await rollback();
      return fail(CODES.UNRELATED_MUTATION, 'SQL 76 partnership consent guard is already applied; refuse re-apply');
    }
    if (before.details.live_definition_sha256 !== pin.expected_live_definition_sha256
      || before.details.live_definition_sha256 !== event.expected_live_definition_sha256) {
      await rollback();
      return fail(CODES.DEPLOYMENT_COLLISION, 'tenant_partnerships consent state is not the expected pre-apply state', {
        consent_state: before.details.consent_state,
      });
    }
    if (!prerequisitesMet(before.details)) {
      await rollback();
      return fail(CODES.DEPLOYMENT_COLLISION, 'SQL 76 prerequisites (table, aws_connect_partner_by_code, helper functions) are missing on the target database');
    }

    await client.query(embedded.details.text);

    const after = await readPartnershipConsentState(client, expectedBody);
    if (!after.ok) {
      await rollback();
      return after;
    }
    if (after.details.live_definition_sha256 !== pin.intended_replacement_sha256
      || after.details.preserved_sha256 !== before.details.preserved_sha256
      || after.details.other_policy_count !== before.details.other_policy_count
      || after.details.other_trigger_count !== before.details.other_trigger_count) {
      await rollback();
      return fail(CODES.UNRELATED_MUTATION, 'SQL 76 changed more than the consent guard, the connect marker and the five retired policies', {
        before: before.details.consent_state,
        after: after.details.consent_state,
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
        before_hash: before.details.live_definition_sha256,
        after_hash: after.details.live_definition_sha256,
        result: 'applied',
        executor_identity: identity,
        consent_state_after: after.details.consent_state,
        other_policy_count: after.details.other_policy_count,
        other_trigger_count: after.details.other_trigger_count,
      },
    });
  } catch (error) {
    await rollback();
    return fail(CODES.UNRELATED_MUTATION, String(error?.message || error).slice(0, 400));
  } finally {
    await rollback();
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
  sqlFileLedger = LEDGER_20261007193200_FILE,
  sqlFile71 = SQL71_AMOUNT_GRANT_FILE,
  sqlFile72 = SQL72_MEMBER_PAYMENT_WRITES_FILE,
  sqlFile76 = SQL76_PARTNERSHIP_CONSENT_FILE,
  sql76Pin = AUTHORIZED_SQL76_PARTNERSHIP_CONSENT,
  sqlFile39 = SQL39_FILE,
  sqlFile40 = SQL40_FILE,
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

    if (isSql71AmountGrant(event)) {
      return handleSql71AmountGrant({ event, authorization, identity, connect, sqlFile71 });
    }

    if (isSql72MemberPaymentWrites(event)) {
      return handleSql72MemberPaymentWrites({ event, authorization, identity, connect, sqlFile72 });
    }

    if (isSql76PartnershipConsent(event)) {
      return handleSql76PartnershipConsent({ event, authorization, identity, connect, sqlFile76, pin: sql76Pin });
    }

    if (isLedger20261007193200(event)) {
      return handleLedger20261007193200({
        event,
        authorization,
        identity,
        connect,
        sqlFileLedger,
      });
    }

    if (isSql40(event)) {
      return handleSql40({
        event,
        authorization,
        identity,
        connect,
        sqlFile40,
      });
    }

    if (isSql39(event)) {
      return handleSql39({
        event,
        authorization,
        identity,
        connect,
        sqlFile39,
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
