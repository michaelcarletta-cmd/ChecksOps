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
  AUTHORIZED_SQL77_CHECK_STAKEHOLDERS_GRANT,
  AUTHORIZED_SQL78_PARTNER_STAKEHOLDER_REMOVALS,
  AUTHORIZED_SQL79_MEMBER_STAKEHOLDER_WRITES,
  AUTHORIZED_SQL80_CHECKALT_MEMBER_AUTO_DEPOSIT,
  AUTHORIZED_SQL81_CHECKALT_PRODUCTION_REGISTER,
  AUTHORIZED_SQL82_HOMEOWNER_LEDGER_VIEW,
  AUTHORIZED_SQL83_HOMEOWNER_SIGNING_CAPABILITIES,
  AUTHORIZED_TENANT_USERS_SAME_CHECK_PERMISSIONS,
  CHECKALT_AUTO_DEPOSIT_COMMENT_SHA256,
  CHECKALT_AUTO_DEPOSIT_CONFIG,
  CHECKALT_AUTO_DEPOSIT_DEFINITION_SHA256,
  CHECKALT_AUTO_DEPOSIT_FUNCTION,
  CHECKALT_AUTO_DEPOSIT_FUNCTION_NAME,
  CHECKALT_AUTO_DEPOSIT_GRANTEES,
  CHECKALT_AUTO_DEPOSIT_TABLE,
  checkaltAutoDepositStateText,
  CHECKALT_REGISTER_COLUMNS,
  CHECKALT_REGISTER_COMMENT_SHA256,
  CHECKALT_REGISTER_CONFIG,
  CHECKALT_REGISTER_DEFINITION_SHA256,
  CHECKALT_REGISTER_FUNCTION,
  CHECKALT_REGISTER_FUNCTION_NAME,
  CHECKALT_REGISTER_GRANTEES,
  CHECKALT_REGISTER_TABLE,
  checkaltRegisterStateText,
  HOMEOWNER_DEFINITION_SHA256,
  HOMEOWNER_EXECUTE_GRANTEES,
  HOMEOWNER_LEGACY_FUNCTION_NAME,
  HOMEOWNER_MIGRATIONS,
  HOMEOWNER_RAW_ENDORSE_LINK_RE,
  HOMEOWNER_REPLACEABLE_ACL_ENTRIES,
  HOMEOWNER_RLS_TABLES,
  HOMEOWNER_STATUS_TABLES,
  homeownerStateText,
  MEMBER_STAKEHOLDER_FUNCTIONS,
  MEMBER_STAKEHOLDER_FUNCTION_SHA256,
  MEMBER_STAKEHOLDER_NEW_POLICIES,
  MEMBER_STAKEHOLDER_REVIEWED_POLICIES,
  MEMBER_STAKEHOLDER_TABLES,
  memberStakeholderWritesStateText,
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
  PARTNER_STAKEHOLDER_REMOVALS_TABLE,
  partnerStakeholderRemovalsStateText,
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
  isSql77CheckStakeholdersGrant,
  isSql78PartnerStakeholderRemovals,
  isSql79MemberStakeholderWrites,
  isSql80CheckaltMemberAutoDeposit,
  isSql81CheckaltProductionRegister,
  isSql82HomeownerLedgerView,
  isSql83HomeownerSigningCapabilities,
  isTenantUsersSameCheckPermissions,
  STAKEHOLDER_GRANT_PRIVILEGES,
  STAKEHOLDER_GRANT_TABLE,
  STAKEHOLDER_GRANTEES,
  stakeholderGrantStateText,
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
const SQL77_CHECK_STAKEHOLDERS_GRANT_FILE = path.join(ROOT, 'sql/77_check_stakeholders_write_grant.sql');
const SQL78_PARTNER_STAKEHOLDER_REMOVALS_FILE = path.join(ROOT, 'sql/78_check_partner_stakeholder_removals.sql');
const SQL79_MEMBER_STAKEHOLDER_WRITES_FILE = path.join(ROOT, 'sql/79_member_stakeholder_writes.sql');
const SQL80_CHECKALT_MEMBER_AUTO_DEPOSIT_FILE = path.join(ROOT, 'sql/80_checkalt_member_auto_deposit.sql');
const SQL81_CHECKALT_PRODUCTION_REGISTER_FILE = path.join(ROOT, 'sql/81_checkalt_production_register.sql');
const SQL82_HOMEOWNER_LEDGER_VIEW_FILE = path.join(ROOT, 'sql/82_homeowner_ledger_view.sql');
const SQL83_HOMEOWNER_SIGNING_CAPABILITIES_FILE = path.join(ROOT, 'sql/83_homeowner_signing_capabilities.sql');
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

// --- SQL 77: check_stakeholders SELECT/INSERT/DELETE grant -------------------

// Direct ACL entries of public.check_stakeholders (owner defaults when relacl is NULL).
const STAKEHOLDER_ACL_SQL = `
SELECT COALESCE(r.rolname, 'PUBLIC') AS grantee, a.privilege_type, a.is_grantable
FROM pg_class c
CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
LEFT JOIN pg_roles r ON r.oid = a.grantee
WHERE c.oid = to_regclass('public.check_stakeholders')
ORDER BY 1, 2, 3
`.trim();
const STAKEHOLDER_TABLE_SQL = "SELECT to_regclass('public.check_stakeholders') IS NOT NULL AS present";
// Row-level security and the write policy are what keep the grant inside one tenant.
const STAKEHOLDER_RLS_SQL = `
SELECT c.relrowsecurity AS rls_enabled
FROM pg_class c
WHERE c.oid = to_regclass('public.check_stakeholders')
`.trim();
const STAKEHOLDER_POLICIES_SQL = `
SELECT pol.polname AS name,
  pol.polpermissive AS permissive,
  CASE pol.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' ELSE 'ALL' END AS cmd,
  ARRAY(SELECT CASE WHEN r = 0 THEN 'public' ELSE pg_get_userbyid(r)::text END FROM unnest(pol.polroles) r ORDER BY 1)::text[] AS roles,
  pg_get_expr(pol.polqual, pol.polrelid) AS using,
  pg_get_expr(pol.polwithcheck, pol.polrelid) AS with_check
FROM pg_policy pol
WHERE pol.polrelid = to_regclass('public.check_stakeholders')
ORDER BY 1
`.trim();
// Every role the grant reaches (checksops, authenticated, and any role that
// inherits from or can SET ROLE to either) must be held to RLS on this table:
// not superuser or BYPASSRLS, and unable to act as the table owner or to grant
// itself the owner or a superuser/BYPASSRLS role (ADMIN OPTION). FORCE RLS is
// no exemption: a role that can act as the owner can turn it off. Other
// superusers already hold every privilege (and pg_has_role is always true for
// them), so they are not counted as reached.
const STAKEHOLDER_BYPASS_SQL = `
SELECT COALESCE(bool_or(
  r.rolsuper OR r.rolbypassrls
  OR pg_has_role(r.oid, c.relowner, 'USAGE') OR pg_has_role(r.oid, c.relowner, 'SET')
  OR pg_has_role(r.oid, c.relowner, 'USAGE WITH ADMIN OPTION')
  OR EXISTS (
    SELECT 1 FROM pg_roles b
    WHERE (b.rolsuper OR b.rolbypassrls) AND b.oid <> r.oid
      AND pg_has_role(r.oid, b.oid, 'USAGE WITH ADMIN OPTION'))
), true) AS bypasses
FROM pg_roles r
CROSS JOIN pg_class c
WHERE c.oid = to_regclass('public.check_stakeholders')
  AND (r.rolname IN ('checksops', 'authenticated')
    OR (NOT r.rolsuper AND (
      pg_has_role(r.oid, 'checksops', 'USAGE') OR pg_has_role(r.oid, 'checksops', 'SET')
      OR pg_has_role(r.oid, 'authenticated', 'USAGE') OR pg_has_role(r.oid, 'authenticated', 'SET'))))
`.trim();
// pg_get_expr omits a function's schema whenever search_path would find it;
// with only pg_catalog on the path, the reviewed function prints as public.*.
const STAKEHOLDER_POLICY_SEARCH_PATH_SQL = "SELECT set_config('search_path', 'pg_catalog', false)";
const STAKEHOLDER_WRITE_POLICY = 'aws_write_check_stakeholders';
// aws/rls/sql/24_complete_write_policies.sql: USING and WITH CHECK are both this.
const STAKEHOLDER_WRITE_CONDITION = 'public.aws_can_write_tenant(tenant_id)';

/** Compares policy expressions without case, spacing or outer parentheses. */
function normalizePolicyExpr(expr) {
  let text = String(expr ?? '').toLowerCase().replace(/\s+/g, '');
  while (text.startsWith('(') && text.endsWith(')')) text = text.slice(1, -1);
  return text;
}

/**
 * Whether the reviewed write policy is the only permissive policy that can let
 * INSERT or DELETE through, and still limits both to the row's own tenant.
 */
function stakeholderPolicyState(policies) {
  const write = policies.find((policy) => policy.name === STAKEHOLDER_WRITE_POLICY);
  const roles = Array.isArray(write?.roles) ? write.roles : [];
  const writePolicyAsExpected = Boolean(write)
    && write.permissive === true
    && write.cmd === 'ALL'
    && roles.length === 1 && roles[0] === 'authenticated'
    && normalizePolicyExpr(write.using) === STAKEHOLDER_WRITE_CONDITION
    && normalizePolicyExpr(write.with_check) === STAKEHOLDER_WRITE_CONDITION;
  const otherWritePolicies = policies.filter((policy) => policy.name !== STAKEHOLDER_WRITE_POLICY
    && policy.permissive !== false
    && ['ALL', 'INSERT', 'DELETE'].includes(policy.cmd));
  return {
    write_policy_present: Boolean(write),
    write_policy_as_expected: writePolicyAsExpected,
    other_write_policy_count: otherWritePolicies.length,
  };
}
// The file may hold only comments and this one statement.
const SQL77_SINGLE_STATEMENT_RE = /^(?:\s*--[^\n]*\n)*\s*GRANT SELECT, INSERT, DELETE ON TABLE public\.check_stakeholders TO checksops, authenticated;\s*$/;

/**
 * Read-only fingerprint of the SQL 77 grant: the two grantees' direct SELECT,
 * INSERT, UPDATE and DELETE privileges, plus a hash of every other ACL entry.
 */
export async function readStakeholderGrantState(client) {
  const present = (await client.query(STAKEHOLDER_TABLE_SQL))?.rows?.[0]?.present === true;
  if (!present) return fail(CODES.SQL_COLLISION, 'public.check_stakeholders is missing');
  const rls = (await client.query(STAKEHOLDER_RLS_SQL))?.rows?.[0] || {};
  await client.query(STAKEHOLDER_POLICY_SEARCH_PATH_SQL);
  const policyState = stakeholderPolicyState((await client.query(STAKEHOLDER_POLICIES_SQL))?.rows || []);
  const bypassesRls = (await client.query(STAKEHOLDER_BYPASS_SQL))?.rows?.[0]?.bypasses !== false;
  const rlsEnabled = rls.rls_enabled === true;
  const acl = (await client.query(STAKEHOLDER_ACL_SQL))?.rows || [];
  const privilegeState = Object.fromEntries(STAKEHOLDER_GRANTEES.map((grantee) => [
    grantee,
    Object.fromEntries(STAKEHOLDER_GRANT_PRIVILEGES.map((privilege) => [
      privilege,
      acl.some((row) => row.grantee === grantee && row.privilege_type === privilege) ? 'granted' : 'absent',
    ])),
  ]));
  const preserved = acl
    .filter((row) => !(STAKEHOLDER_GRANTEES.includes(row.grantee) && STAKEHOLDER_GRANT_PRIVILEGES.includes(row.privilege_type)))
    .map((row) => `${row.grantee}:${row.privilege_type}:${row.is_grantable === true}`)
    .sort();
  return ok({
    table_present: true,
    rls_enabled: rlsEnabled,
    ...policyState,
    grantee_bypasses_rls: bypassesRls,
    // Every condition that keeps an INSERT or DELETE inside the row's own tenant.
    tenant_guard_ok: rlsEnabled
      && policyState.write_policy_as_expected
      && policyState.other_write_policy_count === 0
      && !bypassesRls,
    privilege_state: privilegeState,
    update_granted: STAKEHOLDER_GRANTEES.some((grantee) => privilegeState[grantee].UPDATE === 'granted'),
    preserved_acl_sha256: hashSqlDefinition(preserved.join('\n')),
    live_definition_sha256: hashSqlDefinition(stakeholderGrantStateText(privilegeState)),
  });
}

const SQL77_SHA256_RE = /^[0-9a-f]{64}$/;

/** A test may supply `pin` only as the committed pin with a reviewed expected hash filled in. */
function sql77PinIsCommitted(pin) {
  const committed = AUTHORIZED_SQL77_CHECK_STAKEHOLDERS_GRANT;
  return Boolean(pin) && ['filename', 'migration_id', 'commit', 'source_sha256', 'intended_replacement_sha256', 'table']
    .every((key) => pin[key] === committed[key]);
}

async function handleSql77CheckStakeholdersGrant({
  event,
  authorization,
  identity,
  connect,
  sqlFile77,
  pin = AUTHORIZED_SQL77_CHECK_STAKEHOLDERS_GRANT,
}) {
  if (!sql77PinIsCommitted(pin)) {
    return fail(CODES.SQL_COLLISION, 'SQL 77 pin does not match the committed allowlist entry');
  }
  const embedded = readEmbeddedSql(sqlFile77, pin.source_sha256);
  if (!embedded.ok) return embedded;
  if (!SQL77_SINGLE_STATEMENT_RE.test(embedded.details.text)) {
    return fail(CODES.UNRELATED_MUTATION, 'embedded SQL 77 is not the single pinned GRANT statement');
  }
  const readOnly = event.action === 'inspect' || event.action === 'verify_data' || event.action === 'authorize';
  if (!readOnly && event.action !== 'apply') {
    return fail(CODES.INVALID_MANIFEST, `unsupported SQL 77 executor action ${event.action}`);
  }
  const pinExecutable = SQL77_SHA256_RE.test(String(pin.expected_live_definition_sha256 || ''));
  if (event.action === 'apply' && !pinExecutable) {
    return fail(CODES.SQL_COLLISION, 'SQL 77 pin has no reviewed pre-apply live definition hash yet; apply is refused');
  }
  if (event.action === 'apply' && !(
    event.filename === pin.filename
    && event.migration_id === pin.migration_id
    && event.source_sha256 === pin.source_sha256
    && event.intended_replacement_sha256 === pin.intended_replacement_sha256
    && event.expected_live_definition_sha256 === pin.expected_live_definition_sha256
    && event.commit === pin.commit
  )) {
    return fail(CODES.SQL_COLLISION, 'SQL 77 apply is bound to the exact allowlisted pin');
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
      const state = await readStakeholderGrantState(client);
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
            && state.details.update_granted === false
            && state.details.tenant_guard_ok === true,
        },
      });
    }

    await client.query('BEGIN');
    inTx = true;
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['sql77_check_stakeholders_grant']);
    if (isConsumed(event.one_use_id)) {
      await rollback();
      return fail(CODES.SQL_COLLISION, 'one_use_id has already been consumed; replay is forbidden', {
        one_use_id: event.one_use_id,
      });
    }
    const before = await readStakeholderGrantState(client);
    if (!before.ok) {
      await rollback();
      return before;
    }
    if (before.details.live_definition_sha256 === pin.intended_replacement_sha256) {
      await rollback();
      return fail(CODES.UNRELATED_MUTATION, 'SQL 77 grant is already in place; refuse re-grant');
    }
    if (before.details.tenant_guard_ok !== true) {
      await rollback();
      return fail(CODES.DEPLOYMENT_COLLISION, 'check_stakeholders needs row-level security with only the reviewed aws_write_check_stakeholders write policy before SQL 77', {
        rls_enabled: before.details.rls_enabled,
        write_policy_present: before.details.write_policy_present,
        write_policy_as_expected: before.details.write_policy_as_expected,
        other_write_policy_count: before.details.other_write_policy_count,
        grantee_bypasses_rls: before.details.grantee_bypasses_rls,
      });
    }
    if (before.details.update_granted) {
      await rollback();
      return fail(CODES.DEPLOYMENT_COLLISION, 'a grantee already has UPDATE on check_stakeholders; not the expected state');
    }
    if (before.details.live_definition_sha256 !== pin.expected_live_definition_sha256
      || before.details.live_definition_sha256 !== event.expected_live_definition_sha256) {
      await rollback();
      return fail(CODES.DEPLOYMENT_COLLISION, 'check_stakeholders privileges are not the expected pre-apply state', {
        privilege_state: before.details.privilege_state,
      });
    }

    await client.query(embedded.details.text);

    const after = await readStakeholderGrantState(client);
    if (!after.ok) {
      await rollback();
      return after;
    }
    if (after.details.live_definition_sha256 !== pin.intended_replacement_sha256
      || after.details.preserved_acl_sha256 !== before.details.preserved_acl_sha256) {
      await rollback();
      return fail(CODES.UNRELATED_MUTATION, 'SQL 77 changed more than SELECT/INSERT/DELETE for checksops and authenticated', {
        before: before.details.privilege_state,
        after: after.details.privilege_state,
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
        privilege_state_before: before.details.privilege_state,
        privilege_state_after: after.details.privilege_state,
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

// --- SQL 78: check_partner_stakeholder_removals table ------------------------

const REMOVALS_TABLE = PARTNER_STAKEHOLDER_REMOVALS_TABLE;
const REMOVALS_PRESENT_SQL = `SELECT to_regclass('${REMOVALS_TABLE}') IS NOT NULL AS removals_present`;
// What the CREATE TABLE, its policies and its grant need. REFERENCES is checked
// for the role that runs the file, which becomes the table owner.
const REMOVALS_PREREQUISITES_SQL = `
SELECT
  to_regclass('public.check_intake_items') IS NOT NULL
    AND to_regclass('public.tenants') IS NOT NULL
    AND to_regclass('public.identity_accounts') IS NOT NULL
    AND to_regclass('public.shared_checks') IS NOT NULL AS required_tables_present,
  to_regprocedure('public.aws_can_access_tenant(uuid)') IS NOT NULL
    AND to_regprocedure('public.aws_can_write_tenant(uuid)') IS NOT NULL
    AND to_regprocedure('public.aws_is_cross_tenant_reader()') IS NOT NULL
    AND to_regprocedure('pg_catalog.gen_random_uuid()') IS NOT NULL AS required_functions_present,
  EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'checksops')
    AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') AS required_roles_present,
  COALESCE(has_table_privilege(to_regclass('public.check_intake_items'), 'REFERENCES')
    AND has_table_privilege(to_regclass('public.tenants'), 'REFERENCES')
    AND has_table_privilege(to_regclass('public.identity_accounts'), 'REFERENCES')
    AND has_table_privilege(to_regclass('public.shared_checks'), 'REFERENCES'), false) AS references_granted,
  has_schema_privilege('public', 'CREATE') AS schema_create_granted,
  -- The share FK needs a primary key or unique constraint over exactly these columns.
  EXISTS (
    SELECT 1 FROM pg_constraint k
    WHERE k.conrelid = to_regclass('public.shared_checks') AND k.contype IN ('p', 'u')
      AND ARRAY(SELECT a.attname::text FROM unnest(k.conkey) n
        JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = n ORDER BY 1)
        = ARRAY['check_id', 'source_tenant_id', 'target_tenant_id']
  ) AS share_key_present
`.trim();
// Default privileges that would apply to the new table: the executing role's
// entries for schema public and its global entries (namespace 0), owner
// excluded. They are "as expected" when every entry is either for PUBLIC (the
// file's REVOKE ALL FROM PUBLIC removes it) or a SELECT, INSERT or DELETE for
// checksops or authenticated without grant option (the file's GRANT gives that
// anyway). Exactly then the post-apply non-owner ACL is the reviewed one.
const REMOVALS_DEFAULT_ACL_SQL = `
SELECT CASE WHEN d.defaclnamespace = 0 THEN 'global' ELSE 'public' END AS scope,
  COALESCE(r.rolname, 'PUBLIC') AS grantee, a.privilege_type, a.is_grantable
FROM pg_default_acl d
CROSS JOIN LATERAL aclexplode(d.defaclacl) a
LEFT JOIN pg_roles r ON r.oid = a.grantee
WHERE d.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = current_user)
  AND d.defaclobjtype = 'r'
  AND (d.defaclnamespace = 0 OR d.defaclnamespace = 'public'::regnamespace)
  AND a.grantee <> d.defaclrole
ORDER BY 1, 2, 3, 4
`.trim();
const REMOVALS_INDEXES_SQL = `
SELECT c.relname AS name, pg_get_indexdef(i.indexrelid) AS def
FROM pg_index i
JOIN pg_class c ON c.oid = i.indexrelid
WHERE i.indrelid = to_regclass('${REMOVALS_TABLE}')
ORDER BY 1
`.trim();
const REMOVALS_COLUMNS_SQL = `
SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null,
  pg_get_expr(d.adbin, d.adrelid) AS default_expr
FROM pg_attribute a
LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
WHERE a.attrelid = to_regclass('${REMOVALS_TABLE}') AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY a.attnum
`.trim();
// PostgreSQL 18 also stores NOT NULL as constraint rows (contype 'n'); the
// column lines already carry not null, so only these kinds are listed.
const REMOVALS_CONSTRAINTS_SQL = `
SELECT con.conname AS name, pg_get_constraintdef(con.oid) AS def
FROM pg_constraint con
WHERE con.conrelid = to_regclass('${REMOVALS_TABLE}') AND con.contype IN ('p', 'u', 'f', 'c', 'x')
ORDER BY 1
`.trim();
const REMOVALS_RLS_SQL = `
SELECT c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced,
  c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user) AS owner_is_executor
FROM pg_class c
WHERE c.oid = to_regclass('${REMOVALS_TABLE}')
`.trim();
const REMOVALS_POLICIES_SQL = `
SELECT pol.polname AS name,
  pol.polpermissive AS permissive,
  CASE pol.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' ELSE 'ALL' END AS cmd,
  ARRAY(SELECT CASE WHEN r = 0 THEN 'public' ELSE pg_get_userbyid(r)::text END FROM unnest(pol.polroles) r ORDER BY 1)::text[] AS roles,
  pg_get_expr(pol.polqual, pol.polrelid) AS using,
  pg_get_expr(pol.polwithcheck, pol.polrelid) AS with_check
FROM pg_policy pol
WHERE pol.polrelid = to_regclass('${REMOVALS_TABLE}')
ORDER BY 1
`.trim();
// Non-owner ACL entries: the owner's own privileges differ by server version.
const REMOVALS_ACL_SQL = `
SELECT COALESCE(r.rolname, 'PUBLIC') AS grantee, a.privilege_type, a.is_grantable
FROM pg_class c
CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
LEFT JOIN pg_roles r ON r.oid = a.grantee
WHERE c.oid = to_regclass('${REMOVALS_TABLE}') AND a.grantee <> c.relowner
ORDER BY 1, 2, 3
`.trim();
// SQL 77's bypass check, against the role that owns the table, or before the
// table exists, the role that would own it (the one running the file). The
// grantees are looked up by oid so a missing role reads as unknown (NULL,
// treated as bypassing) instead of raising.
const REMOVALS_BYPASS_SQL = `
WITH o AS (
  SELECT COALESCE(
    (SELECT c.relowner FROM pg_class c WHERE c.oid = to_regclass('${REMOVALS_TABLE}')),
    (SELECT oid FROM pg_roles WHERE rolname = current_user)) AS owner
), g AS (
  SELECT oid FROM pg_roles WHERE rolname IN ('checksops', 'authenticated')
)
SELECT CASE WHEN (SELECT count(*) FROM g) <> 2 THEN NULL ELSE COALESCE(bool_or(
  r.rolsuper OR r.rolbypassrls
  OR pg_has_role(r.oid, o.owner, 'USAGE') OR pg_has_role(r.oid, o.owner, 'SET')
  OR pg_has_role(r.oid, o.owner, 'USAGE WITH ADMIN OPTION')
  OR EXISTS (
    SELECT 1 FROM pg_roles b
    WHERE (b.rolsuper OR b.rolbypassrls) AND b.oid <> r.oid
      AND pg_has_role(r.oid, b.oid, 'USAGE WITH ADMIN OPTION'))
), true) END AS removals_bypasses
FROM pg_roles r
CROSS JOIN o
WHERE o.owner IS NOT NULL
  AND (r.oid IN (SELECT oid FROM g)
    OR (NOT r.rolsuper AND EXISTS (
      SELECT 1 FROM g WHERE pg_has_role(r.oid, g.oid, 'USAGE') OR pg_has_role(r.oid, g.oid, 'SET'))))
`.trim();
// Everything else in schema public: relations (minus the new table and its
// indexes) and the policies of every other table must not change.
const REMOVALS_SCHEMA_RELATIONS_SQL = `
SELECT c.relname, c.relkind::text AS relkind
FROM pg_class c
WHERE c.relnamespace = 'public'::regnamespace
  AND c.oid IS DISTINCT FROM to_regclass('${REMOVALS_TABLE}')
  AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indexrelid = c.oid AND i.indrelid = to_regclass('${REMOVALS_TABLE}'))
ORDER BY 1, 2
`.trim();
const REMOVALS_OTHER_POLICIES_SQL = `
SELECT pol.polrelid::regclass::text AS table_name, pol.polname, pol.polcmd::text AS polcmd,
  pol.polpermissive, pol.polroles::text AS polroles,
  pg_get_expr(pol.polqual, pol.polrelid) AS polqual,
  pg_get_expr(pol.polwithcheck, pol.polrelid) AS polwithcheck
FROM pg_policy pol
WHERE pol.polrelid IS DISTINCT FROM to_regclass('${REMOVALS_TABLE}')
ORDER BY 1, 2
`.trim();
const REMOVALS_SELECT_POLICY = 'aws_select_check_partner_stakeholder_removals';
const REMOVALS_WRITE_POLICY = 'aws_write_check_partner_stakeholder_removals';
// aws/rls/sql/12_final_select_policies.sql and 24_complete_write_policies.sql
// (check_stakeholders), normalized by normalizePolicyExpr.
const REMOVALS_SELECT_CONDITION = 'public.aws_is_cross_tenant_reader()orpublic.aws_can_access_tenant(tenant_id)';
const REMOVALS_WRITE_CONDITION = 'public.aws_can_write_tenant(tenant_id)';
// The reviewed file, comments removed and whitespace collapsed.
export const SQL78_NORMALIZED_STATEMENTS = [
  'CREATE TABLE public.check_partner_stakeholder_removals (',
  'id uuid PRIMARY KEY DEFAULT gen_random_uuid(),',
  'check_intake_item_id uuid NOT NULL REFERENCES public.check_intake_items(id) ON DELETE CASCADE,',
  'tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,',
  'partner_tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,',
  'removed_by uuid REFERENCES public.identity_accounts(application_user_id) ON DELETE SET NULL,',
  'created_at timestamptz NOT NULL DEFAULT now(),',
  'CONSTRAINT check_partner_stakeholder_removals_unique UNIQUE (check_intake_item_id, tenant_id, partner_tenant_id),',
  'CONSTRAINT check_partner_stakeholder_removals_not_self CHECK (partner_tenant_id <> tenant_id),',
  'CONSTRAINT check_partner_stakeholder_removals_share_fkey FOREIGN KEY (check_intake_item_id, tenant_id, partner_tenant_id)',
  'REFERENCES public.shared_checks (check_id, source_tenant_id, target_tenant_id) ON DELETE CASCADE',
  ');',
  'CREATE INDEX check_partner_stakeholder_removals_tenant_id_idx',
  'ON public.check_partner_stakeholder_removals (tenant_id);',
  'CREATE INDEX check_partner_stakeholder_removals_partner_tenant_id_idx',
  'ON public.check_partner_stakeholder_removals (partner_tenant_id);',
  'ALTER TABLE public.check_partner_stakeholder_removals ENABLE ROW LEVEL SECURITY;',
  'CREATE POLICY aws_select_check_partner_stakeholder_removals ON public.check_partner_stakeholder_removals',
  'FOR SELECT TO authenticated',
  'USING (public.aws_is_cross_tenant_reader() OR public.aws_can_access_tenant(tenant_id));',
  'CREATE POLICY aws_write_check_partner_stakeholder_removals ON public.check_partner_stakeholder_removals',
  'FOR ALL TO authenticated',
  'USING (public.aws_can_write_tenant(tenant_id))',
  'WITH CHECK (public.aws_can_write_tenant(tenant_id));',
  'REVOKE ALL ON TABLE public.check_partner_stakeholder_removals FROM PUBLIC;',
  'GRANT SELECT, INSERT, DELETE ON TABLE public.check_partner_stakeholder_removals TO checksops, authenticated;',
].join(' ');

function normalizeSql78(text) {
  return String(text).replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
}

function removalsPolicyState(policies) {
  const select = policies.find((policy) => policy.name === REMOVALS_SELECT_POLICY);
  const write = policies.find((policy) => policy.name === REMOVALS_WRITE_POLICY);
  const onlyAuthenticated = (policy) => Array.isArray(policy?.roles) && policy.roles.length === 1 && policy.roles[0] === 'authenticated';
  const selectAsExpected = Boolean(select) && select.permissive === true && select.cmd === 'SELECT'
    && onlyAuthenticated(select)
    && normalizePolicyExpr(select.using) === REMOVALS_SELECT_CONDITION
    && select.with_check == null;
  const writeAsExpected = Boolean(write) && write.permissive === true && write.cmd === 'ALL'
    && onlyAuthenticated(write)
    && normalizePolicyExpr(write.using) === REMOVALS_WRITE_CONDITION
    && normalizePolicyExpr(write.with_check) === REMOVALS_WRITE_CONDITION;
  return {
    select_policy_as_expected: selectAsExpected,
    write_policy_present: Boolean(write),
    write_policy_as_expected: writeAsExpected,
    other_policy_count: policies.filter((policy) => policy.name !== REMOVALS_SELECT_POLICY && policy.name !== REMOVALS_WRITE_POLICY).length,
  };
}

/**
 * Read-only fingerprint of public.check_partner_stakeholder_removals and of
 * what SQL 78 needs to create it.
 */
export async function readPartnerStakeholderRemovalsState(client) {
  // pg_get_expr / pg_get_constraintdef / regclass print schema-qualified names
  // with only pg_catalog on the path.
  await client.query(STAKEHOLDER_POLICY_SEARCH_PATH_SQL);
  const present = (await client.query(REMOVALS_PRESENT_SQL))?.rows?.[0]?.removals_present === true;
  const prereq = (await client.query(REMOVALS_PREREQUISITES_SQL))?.rows?.[0] || {};
  const prerequisites = {
    required_tables_present: prereq.required_tables_present === true,
    required_functions_present: prereq.required_functions_present === true,
    required_roles_present: prereq.required_roles_present === true,
    references_granted: prereq.references_granted === true,
    schema_create_granted: prereq.schema_create_granted === true,
    share_key_present: prereq.share_key_present === true,
  };
  const prerequisitesOk = Object.values(prerequisites).every(Boolean);
  const bypassesRls = (await client.query(REMOVALS_BYPASS_SQL))?.rows?.[0]?.removals_bypasses !== false;
  const defaultAcl = ((await client.query(REMOVALS_DEFAULT_ACL_SQL))?.rows || []).map((row) => ({
    scope: row.scope, grantee: row.grantee, privilege: row.privilege_type, grantable: row.is_grantable === true,
  }));
  const defaultAclEntries = defaultAcl
    .map((row) => `${row.scope} ${row.grantee} ${row.privilege}${row.grantable ? ' with grant option' : ''}`)
    .sort();
  const defaults = {
    default_acl_as_expected: defaultAcl.every((row) => row.grantee === 'PUBLIC' || (
      ['checksops', 'authenticated'].includes(row.grantee)
      && ['SELECT', 'INSERT', 'DELETE'].includes(row.privilege)
      && row.grantable === false)),
    default_acl_entries: defaultAclEntries,
    default_acl_entry_count: defaultAclEntries.length,
    default_acl_sha256: hashSqlDefinition(defaultAclEntries.join('\n')),
  };
  if (!present) {
    return ok({
      table_present: false,
      ...prerequisites,
      prerequisites_ok: prerequisitesOk,
      ...defaults,
      grantee_bypasses_rls: bypassesRls,
      tenant_guard_ok: false,
      live_definition_sha256: hashSqlDefinition(partnerStakeholderRemovalsStateText({ present: false })),
    });
  }
  const columns = ((await client.query(REMOVALS_COLUMNS_SQL))?.rows || []).map((row) => ({
    name: row.name, type: row.type, not_null: row.not_null === true, default: row.default_expr ?? null,
  }));
  const constraints = ((await client.query(REMOVALS_CONSTRAINTS_SQL))?.rows || []).map((row) => ({ name: row.name, def: row.def }));
  const indexes = ((await client.query(REMOVALS_INDEXES_SQL))?.rows || []).map((row) => ({ name: row.name, def: row.def }));
  const rls = (await client.query(REMOVALS_RLS_SQL))?.rows?.[0] || {};
  const policies = (await client.query(REMOVALS_POLICIES_SQL))?.rows || [];
  const acl = ((await client.query(REMOVALS_ACL_SQL))?.rows || []).map((row) => ({
    grantee: row.grantee, privilege: row.privilege_type, grantable: row.is_grantable === true,
  }));
  const policyState = removalsPolicyState(policies);
  const rlsEnabled = rls.rls_enabled === true;
  const state = {
    present: true,
    columns,
    constraints,
    indexes,
    rls_enabled: rlsEnabled,
    rls_forced: rls.rls_forced === true,
    policies,
    acl,
    owner_is_executor: rls.owner_is_executor === true,
  };
  return ok({
    table_present: true,
    ...prerequisites,
    prerequisites_ok: prerequisitesOk,
    ...defaults,
    rls_enabled: rlsEnabled,
    rls_forced: state.rls_forced,
    owner_is_executor: state.owner_is_executor,
    ...policyState,
    grantee_bypasses_rls: bypassesRls,
    // Every condition that keeps reads and writes inside the row's own tenant.
    tenant_guard_ok: rlsEnabled
      && policyState.select_policy_as_expected
      && policyState.write_policy_as_expected
      && policyState.other_policy_count === 0
      && !bypassesRls,
    update_granted: acl.some((row) => row.privilege === 'UPDATE'),
    live_definition_sha256: hashSqlDefinition(partnerStakeholderRemovalsStateText(state)),
  });
}

async function readPublicSchemaSnapshot(client) {
  await client.query(STAKEHOLDER_POLICY_SEARCH_PATH_SQL);
  const relations = (await client.query(REMOVALS_SCHEMA_RELATIONS_SQL))?.rows || [];
  const policies = (await client.query(REMOVALS_OTHER_POLICIES_SQL))?.rows || [];
  return {
    relations_sha256: hashSqlDefinition(relations.map((row) => `${row.relname}:${row.relkind}`).join('\n')),
    other_policies_sha256: hashSqlDefinition(policies.map((row) => JSON.stringify([
      row.table_name, row.polname, row.polcmd, row.polpermissive, row.polroles, row.polqual, row.polwithcheck,
    ])).join('\n')),
  };
}

const SQL78_SHA256_RE = /^[0-9a-f]{64}$/;

/** A test may supply `pin` only as the committed pin with a reviewed expected hash filled in. */
function sql78PinIsCommitted(pin) {
  const committed = AUTHORIZED_SQL78_PARTNER_STAKEHOLDER_REMOVALS;
  return Boolean(pin) && ['filename', 'migration_id', 'commit', 'source_sha256', 'intended_replacement_sha256', 'table']
    .every((key) => pin[key] === committed[key]);
}

async function handleSql78PartnerStakeholderRemovals({
  event,
  authorization,
  identity,
  connect,
  sqlFile78,
  pin = AUTHORIZED_SQL78_PARTNER_STAKEHOLDER_REMOVALS,
}) {
  if (!sql78PinIsCommitted(pin)) {
    return fail(CODES.SQL_COLLISION, 'SQL 78 pin does not match the committed allowlist entry');
  }
  const embedded = readEmbeddedSql(sqlFile78, pin.source_sha256);
  if (!embedded.ok) return embedded;
  if (normalizeSql78(embedded.details.text) !== SQL78_NORMALIZED_STATEMENTS) {
    return fail(CODES.UNRELATED_MUTATION, 'embedded SQL 78 is not exactly the reviewed statements');
  }
  const readOnly = event.action === 'inspect' || event.action === 'verify_data' || event.action === 'authorize';
  if (!readOnly && event.action !== 'apply') {
    return fail(CODES.INVALID_MANIFEST, `unsupported SQL 78 executor action ${event.action}`);
  }
  const pinExecutable = SQL78_SHA256_RE.test(String(pin.expected_live_definition_sha256 || ''));
  if (event.action === 'apply' && !pinExecutable) {
    return fail(CODES.SQL_COLLISION, 'SQL 78 pin has no reviewed pre-apply live definition hash yet; apply is refused');
  }
  if (event.action === 'apply' && !(
    event.filename === pin.filename
    && event.migration_id === pin.migration_id
    && event.source_sha256 === pin.source_sha256
    && event.intended_replacement_sha256 === pin.intended_replacement_sha256
    && event.expected_live_definition_sha256 === pin.expected_live_definition_sha256
    && event.commit === pin.commit
  )) {
    return fail(CODES.SQL_COLLISION, 'SQL 78 apply is bound to the exact allowlisted pin');
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
      await client.query('BEGIN READ ONLY');
      inTx = true;
      const state = await readPartnerStakeholderRemovalsState(client);
      await rollback();
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
            && state.details.table_present === false
            && state.details.live_definition_sha256 === pin.expected_live_definition_sha256
            && state.details.prerequisites_ok === true
            && state.details.default_acl_as_expected === true
            && state.details.grantee_bypasses_rls === false,
        },
      });
    }

    await client.query('BEGIN');
    inTx = true;
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['sql78_check_partner_stakeholder_removals']);
    if (isConsumed(event.one_use_id)) {
      await rollback();
      return fail(CODES.SQL_COLLISION, 'one_use_id has already been consumed; replay is forbidden', {
        one_use_id: event.one_use_id,
      });
    }
    const before = await readPartnerStakeholderRemovalsState(client);
    if (!before.ok) {
      await rollback();
      return before;
    }
    if (before.details.table_present) {
      await rollback();
      return fail(CODES.UNRELATED_MUTATION, 'public.check_partner_stakeholder_removals is already in place; refuse re-create', {
        live_definition_sha256: before.details.live_definition_sha256,
        matches_intended: before.details.live_definition_sha256 === pin.intended_replacement_sha256,
      });
    }
    if (before.details.prerequisites_ok !== true || before.details.grantee_bypasses_rls !== false) {
      await rollback();
      return fail(CODES.DEPLOYMENT_COLLISION, 'SQL 78 prerequisites are not met (referenced tables, shared_checks key, policy functions, roles, REFERENCES, schema CREATE, or a grantee that bypasses row-level security)', {
        required_tables_present: before.details.required_tables_present,
        share_key_present: before.details.share_key_present,
        required_functions_present: before.details.required_functions_present,
        required_roles_present: before.details.required_roles_present,
        references_granted: before.details.references_granted,
        schema_create_granted: before.details.schema_create_granted,
        grantee_bypasses_rls: before.details.grantee_bypasses_rls,
      });
    }
    if (before.details.default_acl_as_expected !== true) {
      await rollback();
      return fail(CODES.DEPLOYMENT_COLLISION, 'default privileges for new tables in schema public would grant more than SQL 78 leaves; refuse before creating the table', {
        default_acl_entries: before.details.default_acl_entries,
      });
    }
    if (before.details.live_definition_sha256 !== pin.expected_live_definition_sha256
      || before.details.live_definition_sha256 !== event.expected_live_definition_sha256) {
      await rollback();
      return fail(CODES.DEPLOYMENT_COLLISION, 'check_partner_stakeholder_removals is not the expected pre-apply state');
    }
    const schemaBefore = await readPublicSchemaSnapshot(client);

    await client.query(embedded.details.text);

    const after = await readPartnerStakeholderRemovalsState(client);
    if (!after.ok) {
      await rollback();
      return after;
    }
    const schemaAfter = await readPublicSchemaSnapshot(client);
    if (after.details.live_definition_sha256 !== pin.intended_replacement_sha256
      || after.details.tenant_guard_ok !== true
      || schemaAfter.relations_sha256 !== schemaBefore.relations_sha256
      || schemaAfter.other_policies_sha256 !== schemaBefore.other_policies_sha256) {
      await rollback();
      return fail(CODES.UNRELATED_MUTATION, 'SQL 78 did not land exactly on the reviewed table, or changed something else in schema public', {
        after_hash: after.details.live_definition_sha256,
        tenant_guard_ok: after.details.tenant_guard_ok,
        relations_unchanged: schemaAfter.relations_sha256 === schemaBefore.relations_sha256,
        other_policies_unchanged: schemaAfter.other_policies_sha256 === schemaBefore.other_policies_sha256,
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
        tenant_guard_ok: after.details.tenant_guard_ok,
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

// --- SQL 79: tenant-member stakeholder write policies -----------------------

// Each query takes the table (regclass text) as $1.
const MEMBER_TABLE_SQL = `
SELECT to_regclass($1) IS NOT NULL AS present,
  c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced,
  c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user) AS owner_is_executor
FROM (SELECT to_regclass($1) AS oid) t
LEFT JOIN pg_class c ON c.oid = t.oid
`.trim();
const MEMBER_POLICIES_SQL = `
SELECT pol.polname AS name,
  pol.polpermissive AS permissive,
  CASE pol.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' ELSE 'ALL' END AS cmd,
  ARRAY(SELECT CASE WHEN r = 0 THEN 'public' ELSE pg_get_userbyid(r)::text END FROM unnest(pol.polroles) r ORDER BY 1)::text[] AS roles,
  pg_get_expr(pol.polqual, pol.polrelid) AS using,
  pg_get_expr(pol.polwithcheck, pol.polrelid) AS with_check
FROM pg_policy pol
WHERE pol.polrelid = to_regclass($1)
ORDER BY 1
`.trim();
// Non-owner ACL entries (the owner's own privileges differ by server version).
const MEMBER_ACL_SQL = `
SELECT COALESCE(r.rolname, 'PUBLIC') AS grantee, a.privilege_type, a.is_grantable
FROM pg_class c
CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
LEFT JOIN pg_roles r ON r.oid = a.grantee
WHERE c.oid = to_regclass($1) AND a.grantee <> c.relowner
ORDER BY 1, 2, 3
`.trim();
// SQL 77's bypass check against the table's owner; a missing grantee role
// reads as unknown (NULL, treated as bypassing) instead of raising.
const MEMBER_BYPASS_SQL = `
WITH o AS (
  SELECT c.relowner AS owner FROM pg_class c WHERE c.oid = to_regclass($1)
), g AS (
  SELECT oid FROM pg_roles WHERE rolname IN ('checksops', 'authenticated')
)
SELECT CASE WHEN (SELECT count(*) FROM g) <> 2 OR NOT EXISTS (SELECT 1 FROM o) THEN NULL ELSE COALESCE(bool_or(
  r.rolsuper OR r.rolbypassrls
  OR pg_has_role(r.oid, o.owner, 'USAGE') OR pg_has_role(r.oid, o.owner, 'SET')
  OR pg_has_role(r.oid, o.owner, 'USAGE WITH ADMIN OPTION')
  OR EXISTS (
    SELECT 1 FROM pg_roles b
    WHERE (b.rolsuper OR b.rolbypassrls) AND b.oid <> r.oid
      AND pg_has_role(r.oid, b.oid, 'USAGE WITH ADMIN OPTION'))
), true) END AS member_bypasses
FROM pg_roles r
CROSS JOIN o
WHERE r.oid IN (SELECT oid FROM g)
  OR (NOT r.rolsuper AND EXISTS (
    SELECT 1 FROM g WHERE pg_has_role(r.oid, g.oid, 'USAGE') OR pg_has_role(r.oid, g.oid, 'SET')))
`.trim();
// $1 is the function signature. EXECUTE is checked only for roles that exist.
const MEMBER_FUNCTION_SQL = `
SELECT pg_get_functiondef(to_regprocedure($1)) AS def,
  CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'checksops')
    AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
    THEN has_function_privilege('checksops', to_regprocedure($1), 'EXECUTE')
      AND has_function_privilege('authenticated', to_regprocedure($1), 'EXECUTE')
  END AS executable
`.trim();
const MEMBER_ROLES_SQL = `
SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'checksops')
  AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') AS required_roles_present
`.trim();
// Everything else in schema public: relations and the policies of every other
// table must not change.
const MEMBER_SCHEMA_RELATIONS_SQL = `
SELECT c.relname, c.relkind::text AS relkind
FROM pg_class c
WHERE c.relnamespace = 'public'::regnamespace
ORDER BY 1, 2
`.trim();
const MEMBER_OTHER_POLICIES_SQL = `
SELECT pol.polrelid::regclass::text AS table_name, pol.polname, pol.polcmd::text AS polcmd,
  pol.polpermissive, pol.polroles::text AS polroles,
  pg_get_expr(pol.polqual, pol.polrelid) AS polqual,
  pg_get_expr(pol.polwithcheck, pol.polrelid) AS polwithcheck
FROM pg_policy pol
WHERE pol.polrelid IS DISTINCT FROM to_regclass('${STAKEHOLDER_GRANT_TABLE}')
  AND pol.polrelid IS DISTINCT FROM to_regclass('${PARTNER_STAKEHOLDER_REMOVALS_TABLE}')
ORDER BY 1, 2
`.trim();
// The reviewed file, comments removed and whitespace collapsed.
export const SQL79_NORMALIZED_STATEMENTS = MEMBER_STAKEHOLDER_TABLES.flatMap((table) => {
  const [insert, remove] = MEMBER_STAKEHOLDER_NEW_POLICIES[table];
  const condition = '( public.aws_is_authenticated() AND tenant_id IN (SELECT public.aws_user_tenant_ids()) );';
  // check_stakeholders: also a manual link on a check the row's tenant owns.
  const insertCondition = table === STAKEHOLDER_GRANT_TABLE
    ? '( public.aws_is_authenticated() AND tenant_id IN (SELECT public.aws_user_tenant_ids()) AND EXISTS ('
      + ' SELECT 1 FROM public.check_intake_items c WHERE c.id = check_intake_item_id AND c.tenant_id = check_stakeholders.tenant_id'
      + " ) AND added_via = 'manual' );"
    : condition;
  return [
    `CREATE POLICY ${insert.name} ON ${table} FOR INSERT TO authenticated WITH CHECK ${insertCondition}`,
    `CREATE POLICY ${remove.name} ON ${table} FOR DELETE TO authenticated USING ${condition}`,
  ];
}).join(' ');

function normalizeSql79(text) {
  return String(text).replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
}

const samePolicy = (a, b) => Boolean(a) && Boolean(b)
  && a.permissive === b.permissive && a.cmd === b.cmd
  && JSON.stringify([...(a.roles || [])].sort()) === JSON.stringify([...(b.roles || [])].sort())
  && (a.using ?? null) === (b.using ?? null) && (a.with_check ?? null) === (b.with_check ?? null);

/**
 * Read-only fingerprint of what SQL 79 changes and depends on: both tables'
 * row-level security and policies, the definitions of the two functions the
 * new policies call, the tables' ACLs and the RLS bypass check.
 */
export async function readMemberStakeholderWritesState(client) {
  // pg_get_expr prints schema-qualified names with only pg_catalog on the path.
  await client.query(STAKEHOLDER_POLICY_SEARCH_PATH_SQL);
  const requiredRolesPresent = (await client.query(MEMBER_ROLES_SQL))?.rows?.[0]?.required_roles_present === true;
  const tables = {};
  const memberPolicyStates = {};
  let reviewedAsExpected = true;
  let otherPolicyCount = 0;
  let bypasses = false;
  const aclLines = [];
  let updateGranted = false;
  let writeGrantsPresent = true;
  for (const table of MEMBER_STAKEHOLDER_TABLES) {
    const row = (await client.query(MEMBER_TABLE_SQL, [table]))?.rows?.[0] || {};
    const present = row.present === true;
    const policies = present ? ((await client.query(MEMBER_POLICIES_SQL, [table]))?.rows || []) : [];
    const acl = present ? ((await client.query(MEMBER_ACL_SQL, [table]))?.rows || []) : [];
    const tableBypasses = present ? (await client.query(MEMBER_BYPASS_SQL, [table]))?.rows?.[0]?.member_bypasses !== false : true;
    tables[table] = {
      present,
      rls_enabled: row.rls_enabled === true,
      rls_forced: row.rls_forced === true,
      owner_is_executor: row.owner_is_executor === true,
      policies: policies.map((policy) => ({
        name: policy.name,
        permissive: policy.permissive,
        cmd: policy.cmd,
        roles: policy.roles,
        using: policy.using ?? null,
        with_check: policy.with_check ?? null,
      })),
    };
    const reviewed = MEMBER_STAKEHOLDER_REVIEWED_POLICIES[table];
    const added = MEMBER_STAKEHOLDER_NEW_POLICIES[table];
    if (!reviewed.every((expected) => samePolicy(policies.find((p) => p.name === expected.name), expected))) reviewedAsExpected = false;
    for (const expected of added) {
      const live = policies.find((p) => p.name === expected.name);
      memberPolicyStates[expected.name] = !live ? 'absent' : (samePolicy(live, expected) ? 'present' : 'malformed');
    }
    otherPolicyCount += policies.filter((p) => ![...reviewed, ...added].some((expected) => expected.name === p.name)).length;
    if (tableBypasses) bypasses = true;
    for (const entry of acl) aclLines.push(`${table} ${entry.grantee} ${entry.privilege_type}${entry.is_grantable === true ? ' with grant option' : ''}`);
    if (acl.some((entry) => entry.privilege_type === 'UPDATE')) updateGranted = true;
    for (const grantee of STAKEHOLDER_GRANTEES) {
      for (const privilege of ['INSERT', 'DELETE']) {
        if (!acl.some((entry) => entry.grantee === grantee && entry.privilege_type === privilege)) writeGrantsPresent = false;
      }
    }
  }
  const functions = {};
  let functionsExecutable = true;
  for (const signature of MEMBER_STAKEHOLDER_FUNCTIONS) {
    const row = (await client.query(MEMBER_FUNCTION_SQL, [signature]))?.rows?.[0] || {};
    functions[signature] = typeof row.def === 'string' ? hashSqlDefinition(row.def) : null;
    if (row.executable !== true) functionsExecutable = false;
  }
  const tablesPresent = MEMBER_STAKEHOLDER_TABLES.every((table) => tables[table].present);
  const functionsAsExpected = MEMBER_STAKEHOLDER_FUNCTIONS.every((signature) => functions[signature] === MEMBER_STAKEHOLDER_FUNCTION_SHA256[signature]);
  const rlsEnabled = MEMBER_STAKEHOLDER_TABLES.every((table) => tables[table].rls_enabled);
  const states = Object.values(memberPolicyStates);
  return ok({
    tables_present: tablesPresent,
    rls_enabled: rlsEnabled,
    rls_forced: MEMBER_STAKEHOLDER_TABLES.some((table) => tables[table].rls_forced),
    owner_is_executor: MEMBER_STAKEHOLDER_TABLES.every((table) => tables[table].owner_is_executor),
    required_roles_present: requiredRolesPresent,
    reviewed_policies_as_expected: reviewedAsExpected,
    member_policy_states: memberPolicyStates,
    member_policies_present: states.every((state) => state === 'present'),
    other_policy_count: otherPolicyCount,
    functions_as_expected: functionsAsExpected,
    required_functions_present: MEMBER_STAKEHOLDER_FUNCTIONS.every((signature) => functions[signature] !== null),
    functions_executable: functionsExecutable,
    function_definition_sha256: functions,
    grantee_bypasses_rls: bypasses,
    update_granted: updateGranted,
    write_grants_present: writeGrantsPresent,
    acl_sha256: hashSqlDefinition(aclLines.sort().join('\n')),
    // Every condition that keeps member writes inside the caller's own tenants.
    tenant_guard_ok: tablesPresent && rlsEnabled && reviewedAsExpected && otherPolicyCount === 0
      && functionsAsExpected && functionsExecutable && !bypasses && !updateGranted,
    live_definition_sha256: hashSqlDefinition(memberStakeholderWritesStateText({ tables, functions })),
  });
}

async function readMemberSchemaSnapshot(client) {
  await client.query(STAKEHOLDER_POLICY_SEARCH_PATH_SQL);
  const relations = (await client.query(MEMBER_SCHEMA_RELATIONS_SQL))?.rows || [];
  const policies = (await client.query(MEMBER_OTHER_POLICIES_SQL))?.rows || [];
  return {
    relations_sha256: hashSqlDefinition(relations.map((row) => `${row.relname}:${row.relkind}`).join('\n')),
    other_policies_sha256: hashSqlDefinition(policies.map((row) => JSON.stringify([
      row.table_name, row.polname, row.polcmd, row.polpermissive, row.polroles, row.polqual, row.polwithcheck,
    ])).join('\n')),
  };
}

const SQL79_SHA256_RE = /^[0-9a-f]{64}$/;

/** A test may supply `pin` only as the committed pin with a reviewed expected hash filled in. */
function sql79PinIsCommitted(pin) {
  const committed = AUTHORIZED_SQL79_MEMBER_STAKEHOLDER_WRITES;
  return Boolean(pin) && ['filename', 'migration_id', 'commit', 'source_sha256', 'intended_replacement_sha256', 'table']
    .every((key) => pin[key] === committed[key]);
}

async function handleSql79MemberStakeholderWrites({
  event,
  authorization,
  identity,
  connect,
  sqlFile79,
  pin = AUTHORIZED_SQL79_MEMBER_STAKEHOLDER_WRITES,
}) {
  if (!sql79PinIsCommitted(pin)) {
    return fail(CODES.SQL_COLLISION, 'SQL 79 pin does not match the committed allowlist entry');
  }
  const embedded = readEmbeddedSql(sqlFile79, pin.source_sha256);
  if (!embedded.ok) return embedded;
  if (normalizeSql79(embedded.details.text) !== SQL79_NORMALIZED_STATEMENTS) {
    return fail(CODES.UNRELATED_MUTATION, 'embedded SQL 79 is not exactly the reviewed statements');
  }
  const readOnly = event.action === 'inspect' || event.action === 'verify_data' || event.action === 'authorize';
  if (!readOnly && event.action !== 'apply') {
    return fail(CODES.INVALID_MANIFEST, `unsupported SQL 79 executor action ${event.action}`);
  }
  const pinExecutable = SQL79_SHA256_RE.test(String(pin.expected_live_definition_sha256 || ''));
  if (event.action === 'apply' && !pinExecutable) {
    return fail(CODES.SQL_COLLISION, 'SQL 79 pin has no reviewed pre-apply live definition hash yet; apply is refused');
  }
  if (event.action === 'apply' && !(
    event.filename === pin.filename
    && event.migration_id === pin.migration_id
    && event.source_sha256 === pin.source_sha256
    && event.intended_replacement_sha256 === pin.intended_replacement_sha256
    && event.expected_live_definition_sha256 === pin.expected_live_definition_sha256
    && event.commit === pin.commit
  )) {
    return fail(CODES.SQL_COLLISION, 'SQL 79 apply is bound to the exact allowlisted pin');
  }

  let client;
  let inTx = false;
  const rollback = async () => {
    if (inTx) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    }
    inTx = false;
  };
  const prerequisites = (details) => details.tables_present === true
    && details.required_roles_present === true
    && details.required_functions_present === true
    && details.functions_executable === true
    && details.grantee_bypasses_rls === false
    && details.update_granted === false;
  try {
    client = await connect();
    if (readOnly) {
      await client.query('BEGIN READ ONLY');
      inTx = true;
      const state = await readMemberStakeholderWritesState(client);
      await rollback();
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
          prerequisites_ok: prerequisites(state.details),
          pin_executable: pinExecutable,
          apply_preconditions_met: pinExecutable
            && state.details.live_definition_sha256 === pin.expected_live_definition_sha256
            && prerequisites(state.details)
            && state.details.tenant_guard_ok === true,
        },
      });
    }

    await client.query('BEGIN');
    inTx = true;
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['sql79_member_stakeholder_writes']);
    if (isConsumed(event.one_use_id)) {
      await rollback();
      return fail(CODES.SQL_COLLISION, 'one_use_id has already been consumed; replay is forbidden', {
        one_use_id: event.one_use_id,
      });
    }
    const before = await readMemberStakeholderWritesState(client);
    if (!before.ok) {
      await rollback();
      return before;
    }
    if (before.details.live_definition_sha256 === pin.intended_replacement_sha256
      || Object.values(before.details.member_policy_states).some((state) => state !== 'absent')) {
      await rollback();
      return fail(CODES.UNRELATED_MUTATION, 'a SQL 79 member policy is already in place; refuse re-create', {
        member_policy_states: before.details.member_policy_states,
        matches_intended: before.details.live_definition_sha256 === pin.intended_replacement_sha256,
      });
    }
    if (!prerequisites(before.details)) {
      await rollback();
      return fail(CODES.DEPLOYMENT_COLLISION, 'SQL 79 prerequisites are not met (both tables, grantee roles, policy functions executable, no UPDATE grant, no grantee that bypasses row-level security)', {
        tables_present: before.details.tables_present,
        required_roles_present: before.details.required_roles_present,
        required_functions_present: before.details.required_functions_present,
        functions_executable: before.details.functions_executable,
        grantee_bypasses_rls: before.details.grantee_bypasses_rls,
        update_granted: before.details.update_granted,
      });
    }
    if (before.details.tenant_guard_ok !== true
      || before.details.live_definition_sha256 !== pin.expected_live_definition_sha256
      || before.details.live_definition_sha256 !== event.expected_live_definition_sha256) {
      await rollback();
      return fail(CODES.DEPLOYMENT_COLLISION, 'check_stakeholders / check_partner_stakeholder_removals row-level security or the policy functions are not the expected pre-apply state', {
        rls_enabled: before.details.rls_enabled,
        rls_forced: before.details.rls_forced,
        owner_is_executor: before.details.owner_is_executor,
        reviewed_policies_as_expected: before.details.reviewed_policies_as_expected,
        other_policy_count: before.details.other_policy_count,
        functions_as_expected: before.details.functions_as_expected,
      });
    }
    const schemaBefore = await readMemberSchemaSnapshot(client);

    await client.query(embedded.details.text);

    const after = await readMemberStakeholderWritesState(client);
    if (!after.ok) {
      await rollback();
      return after;
    }
    const schemaAfter = await readMemberSchemaSnapshot(client);
    if (after.details.live_definition_sha256 !== pin.intended_replacement_sha256
      || after.details.member_policies_present !== true
      || after.details.acl_sha256 !== before.details.acl_sha256
      || after.details.update_granted !== false
      || after.details.grantee_bypasses_rls !== false
      || schemaAfter.relations_sha256 !== schemaBefore.relations_sha256
      || schemaAfter.other_policies_sha256 !== schemaBefore.other_policies_sha256) {
      await rollback();
      return fail(CODES.UNRELATED_MUTATION, 'SQL 79 did not land exactly on the reviewed policies, or changed something else in schema public', {
        after_hash: after.details.live_definition_sha256,
        member_policy_states: after.details.member_policy_states,
        acl_unchanged: after.details.acl_sha256 === before.details.acl_sha256,
        relations_unchanged: schemaAfter.relations_sha256 === schemaBefore.relations_sha256,
        other_policies_unchanged: schemaAfter.other_policies_sha256 === schemaBefore.other_policies_sha256,
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
        member_policy_states: after.details.member_policy_states,
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

// --- SQL 80: Check Alt Auto-Deposit save for tenant operators -------------

// $1 is the function signature, $2 its bare name (overloads in any schema).
const CHECKALT_FUNCTION_SQL = `
SELECT p.oid IS NOT NULL AS present,
  CASE WHEN p.oid IS NOT NULL THEN pg_get_functiondef(p.oid) END AS def,
  p.prosecdef AS security_definer,
  COALESCE(p.proconfig, ARRAY[]::text[]) AS config,
  p.proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user) AS owner_is_executor,
  obj_description(p.oid, 'pg_proc') AS comment,
  (SELECT count(*)::int FROM pg_proc o WHERE o.proname = $2) AS overload_count
FROM (SELECT to_regprocedure($1) AS oid) t
LEFT JOIN pg_proc p ON p.oid = t.oid
`.trim();
// Non-owner ACL entries of the function; a NULL proacl reads as the default (PUBLIC EXECUTE).
const CHECKALT_FUNCTION_ACL_SQL = `
SELECT COALESCE(r.rolname, 'PUBLIC') AS grantee, a.privilege_type, a.is_grantable
FROM pg_proc p
CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
LEFT JOIN pg_roles r ON r.oid = a.grantee
WHERE p.oid = to_regprocedure($1) AND a.grantee <> p.proowner
ORDER BY 1, 2, 3
`.trim();
const CHECKALT_PREREQUISITES_SQL = `
SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'checksops')
    AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') AS required_roles_present,
  to_regclass('${CHECKALT_AUTO_DEPOSIT_TABLE}') IS NOT NULL
    AND to_regclass('public.tenant_users') IS NOT NULL AS required_tables_present,
  to_regprocedure('public.is_platform_owner()') IS NOT NULL
    AND to_regprocedure('auth.uid()') IS NOT NULL AS required_functions_present
`.trim();
// Table or column UPDATE for either grantee; unknown (missing table or role) reads as granted.
const CHECKALT_TABLE_UPDATE_SQL = `
SELECT CASE WHEN to_regclass('${CHECKALT_AUTO_DEPOSIT_TABLE}') IS NULL
    OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'checksops')
    OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN NULL
  ELSE has_any_column_privilege('checksops', '${CHECKALT_AUTO_DEPOSIT_TABLE}', 'UPDATE')
    OR has_any_column_privilege('authenticated', '${CHECKALT_AUTO_DEPOSIT_TABLE}', 'UPDATE')
  END AS table_update_granted
`.trim();
// Everything else SQL 80 must not touch: relations of schema public, every
// policy, every other function in public and auth (definition, ACL, SECURITY
// DEFINER, config) and the Check Alt table's ACL.
const CHECKALT_ALL_POLICIES_SQL = `
SELECT pol.polrelid::regclass::text AS table_name, pol.polname, pol.polcmd::text AS polcmd,
  pol.polpermissive, pol.polroles::text AS polroles,
  pg_get_expr(pol.polqual, pol.polrelid) AS polqual,
  pg_get_expr(pol.polwithcheck, pol.polrelid) AS polwithcheck
FROM pg_policy pol
ORDER BY 1, 2
`.trim();
const CHECKALT_OTHER_FUNCTIONS_SQL = `
SELECT p.oid::regprocedure::text AS signature,
  encode(sha256(convert_to(pg_get_functiondef(p.oid), 'UTF8')), 'hex') AS def_sha256,
  p.proacl::text AS acl, p.prosecdef, p.proconfig::text AS config, p.proowner::regrole::text AS owner
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname IN ('public', 'auth') AND p.prokind IN ('f', 'p')
  AND p.oid IS DISTINCT FROM to_regprocedure($1)
ORDER BY 1
`.trim();
const CHECKALT_TABLE_ACL_SQL = `
SELECT c.relacl::text AS table_acl FROM pg_class c WHERE c.oid = to_regclass('${CHECKALT_AUTO_DEPOSIT_TABLE}')
`.trim();

const SQL80_SIGNATURE = 'public.aws_save_checkalt_tenant_auto_deposit(uuid, jsonb)';
// The reviewed file outside the function body and the comment literal,
// comments removed and whitespace collapsed.
export const SQL80_NORMALIZED_STATEMENTS = [
  'CREATE OR REPLACE FUNCTION public.aws_save_checkalt_tenant_auto_deposit( _tenant_id uuid, _settings jsonb )',
  'RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public SET row_security = off AS $$<body>$$;',
  `COMMENT ON FUNCTION ${SQL80_SIGNATURE} IS <comment>;`,
  `REVOKE ALL ON FUNCTION ${SQL80_SIGNATURE} FROM PUBLIC;`,
  `GRANT EXECUTE ON FUNCTION ${SQL80_SIGNATURE} TO checksops, authenticated;`,
].join(' ');
// pg_get_functiondef's header on PostgreSQL 16 for the reviewed CREATE.
const SQL80_FUNCTIONDEF_HEADER = [
  'CREATE OR REPLACE FUNCTION public.aws_save_checkalt_tenant_auto_deposit(_tenant_id uuid, _settings jsonb)',
  ' RETURNS jsonb',
  ' LANGUAGE plpgsql',
  ' SECURITY DEFINER',
  " SET search_path TO 'public'",
  " SET row_security TO 'off'",
  'AS $function$',
].join('\n');

/** Splits the file into the statements outside the body, the body and the comment text. */
export function parseSql80(text) {
  const source = String(text || '');
  const open = source.indexOf('AS $$');
  const close = open < 0 ? -1 : source.indexOf('$$;', open + 5);
  if (open < 0 || close < 0 || source.indexOf('$$', close + 3) >= 0) return null;
  const body = source.slice(open + 5, close);
  const rest = `${source.slice(0, open)}AS $$<body>$$;${source.slice(close + 3)}`.replace(/--[^\n]*/g, ' ');
  const literal = rest.match(/ IS\s+'((?:[^']|'')*)'\s*;/);
  if (!literal) return null;
  const outside = rest.replace(literal[0], ' IS <comment>;').replace(/\s+/g, ' ').trim();
  return { outside, body, comment: literal[1].replace(/''/g, "'") };
}

/** pg_get_functiondef (PostgreSQL 16) of the function the reviewed file creates. */
export function sql80ReviewedFunctiondef(text) {
  const parsed = parseSql80(text);
  return parsed ? `${SQL80_FUNCTIONDEF_HEADER}${parsed.body}$function$\n` : null;
}

// 'expected' = the SQL 38 text (pre-apply), 'intended' = the SQL 80 text.
const versionLabel = (hash, table, missing) => {
  if (hash == null) return missing;
  if (hash === table.sql38) return 'expected';
  if (hash === table.sql80) return 'intended';
  return 'other';
};

/**
 * Read-only fingerprint of the SQL 38/80 function: its definition, SECURITY
 * DEFINER, config, owner, comment, overloads and ACL, plus prerequisites.
 */
export async function readCheckaltAutoDepositState(client) {
  await client.query(STAKEHOLDER_POLICY_SEARCH_PATH_SQL);
  const fn = (await client.query(CHECKALT_FUNCTION_SQL, [CHECKALT_AUTO_DEPOSIT_FUNCTION, CHECKALT_AUTO_DEPOSIT_FUNCTION_NAME]))?.rows?.[0] || {};
  const exists = fn.present === true;
  const acl = exists ? ((await client.query(CHECKALT_FUNCTION_ACL_SQL, [CHECKALT_AUTO_DEPOSIT_FUNCTION]))?.rows || []) : [];
  const prereq = (await client.query(CHECKALT_PREREQUISITES_SQL))?.rows?.[0] || {};
  const updateRow = (await client.query(CHECKALT_TABLE_UPDATE_SQL))?.rows?.[0] || {};
  const config = Array.isArray(fn.config) ? fn.config.map(String) : [];
  const state = {
    exists,
    overload_count: Number.isInteger(fn.overload_count) ? fn.overload_count : Number(fn.overload_count) || 0,
    definition_sha256: exists && typeof fn.def === 'string' ? hashSqlDefinition(fn.def) : null,
    security_definer: fn.security_definer === true,
    config,
    owner_is_executor: fn.owner_is_executor === true,
    comment_sha256: exists && typeof fn.comment === 'string' ? hashSqlDefinition(fn.comment) : null,
    acl: acl.map((entry) => ({ grantee: entry.grantee, privilege_type: entry.privilege_type, is_grantable: entry.is_grantable === true })),
  };
  const aclLines = state.acl.map((entry) => `${entry.grantee} ${entry.privilege_type}${entry.is_grantable ? ' with grant option' : ''}`).sort();
  const expectedAcl = CHECKALT_AUTO_DEPOSIT_GRANTEES.map((grantee) => `${grantee} EXECUTE`).sort();
  const configAsReviewed = JSON.stringify(config) === JSON.stringify(CHECKALT_AUTO_DEPOSIT_CONFIG);
  return ok({
    exists,
    overload_count: state.overload_count,
    security_definer: state.security_definer,
    config_as_reviewed: configAsReviewed,
    owner_is_executor: state.owner_is_executor,
    function_states: {
      definition: versionLabel(state.definition_sha256, CHECKALT_AUTO_DEPOSIT_DEFINITION_SHA256, 'absent'),
      comment: exists ? versionLabel(state.comment_sha256, CHECKALT_AUTO_DEPOSIT_COMMENT_SHA256, 'none') : 'absent',
    },
    function_definition_sha256: state.definition_sha256,
    acl_sha256: hashSqlDefinition(aclLines.join('\n')),
    acl_as_expected: JSON.stringify(aclLines) === JSON.stringify(expectedAcl),
    required_roles_present: prereq.required_roles_present === true,
    required_tables_present: prereq.required_tables_present === true,
    required_functions_present: prereq.required_functions_present === true,
    table_update_granted: updateRow.table_update_granted !== false,
    live_definition_sha256: hashSqlDefinition(checkaltAutoDepositStateText(state)),
  });
}

/** `fnIdentity` is the function the migration replaces or creates (excluded from other_functions). */
async function readCheckaltSchemaSnapshot(client, fnIdentity = CHECKALT_AUTO_DEPOSIT_FUNCTION) {
  await client.query(STAKEHOLDER_POLICY_SEARCH_PATH_SQL);
  const relations = (await client.query(MEMBER_SCHEMA_RELATIONS_SQL))?.rows || [];
  const policies = (await client.query(CHECKALT_ALL_POLICIES_SQL))?.rows || [];
  const functions = (await client.query(CHECKALT_OTHER_FUNCTIONS_SQL, [fnIdentity]))?.rows || [];
  const tableAcl = (await client.query(CHECKALT_TABLE_ACL_SQL))?.rows?.[0]?.table_acl ?? null;
  return {
    relations_sha256: hashSqlDefinition(relations.map((row) => `${row.relname}:${row.relkind}`).join('\n')),
    policies_sha256: hashSqlDefinition(policies.map((row) => JSON.stringify([
      row.table_name, row.polname, row.polcmd, row.polpermissive, row.polroles, row.polqual, row.polwithcheck,
    ])).join('\n')),
    other_functions_sha256: hashSqlDefinition(functions.map((row) => JSON.stringify([
      row.signature, row.def_sha256, row.acl, row.prosecdef, row.config, row.owner,
    ])).join('\n')),
    table_acl_sha256: hashSqlDefinition(String(tableAcl)),
  };
}

const SQL80_SHA256_RE = /^[0-9a-f]{64}$/;

/** A test may supply `pin` only as the committed pin with a reviewed expected hash filled in. */
function sql80PinIsCommitted(pin) {
  const committed = AUTHORIZED_SQL80_CHECKALT_MEMBER_AUTO_DEPOSIT;
  return Boolean(pin) && ['filename', 'migration_id', 'commit', 'source_sha256', 'intended_replacement_sha256', 'function_identity', 'table']
    .every((key) => pin[key] === committed[key]);
}

async function handleSql80CheckaltMemberAutoDeposit({
  event,
  authorization,
  identity,
  connect,
  sqlFile80,
  pin = AUTHORIZED_SQL80_CHECKALT_MEMBER_AUTO_DEPOSIT,
}) {
  if (!sql80PinIsCommitted(pin)) {
    return fail(CODES.SQL_COLLISION, 'SQL 80 pin does not match the committed allowlist entry');
  }
  const embedded = readEmbeddedSql(sqlFile80, pin.source_sha256);
  if (!embedded.ok) return embedded;
  const parsed = parseSql80(embedded.details.text);
  const reviewedDef = sql80ReviewedFunctiondef(embedded.details.text);
  if (!parsed || parsed.outside !== SQL80_NORMALIZED_STATEMENTS
    || hashSqlDefinition(parsed.comment) !== CHECKALT_AUTO_DEPOSIT_COMMENT_SHA256.sql80
    || hashSqlDefinition(reviewedDef) !== CHECKALT_AUTO_DEPOSIT_DEFINITION_SHA256.sql80) {
    return fail(CODES.UNRELATED_MUTATION, 'embedded SQL 80 is not exactly the reviewed statements');
  }
  const readOnly = event.action === 'inspect' || event.action === 'verify_data' || event.action === 'authorize';
  if (!readOnly && event.action !== 'apply') {
    return fail(CODES.INVALID_MANIFEST, `unsupported SQL 80 executor action ${event.action}`);
  }
  const pinExecutable = SQL80_SHA256_RE.test(String(pin.expected_live_definition_sha256 || ''));
  if (event.action === 'apply' && !pinExecutable) {
    return fail(CODES.SQL_COLLISION, 'SQL 80 pin has no reviewed pre-apply live definition hash yet; apply is refused');
  }
  if (event.action === 'apply' && !(
    event.filename === pin.filename
    && event.migration_id === pin.migration_id
    && event.source_sha256 === pin.source_sha256
    && event.intended_replacement_sha256 === pin.intended_replacement_sha256
    && event.expected_live_definition_sha256 === pin.expected_live_definition_sha256
    && event.commit === pin.commit
  )) {
    return fail(CODES.SQL_COLLISION, 'SQL 80 apply is bound to the exact allowlisted pin');
  }

  let client;
  let inTx = false;
  const rollback = async () => {
    if (inTx) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    }
    inTx = false;
  };
  const prerequisites = (details) => details.exists === true
    && details.overload_count === 1
    && details.security_definer === true
    && details.config_as_reviewed === true
    && details.owner_is_executor === true
    && details.acl_as_expected === true
    && details.required_roles_present === true
    && details.required_tables_present === true
    && details.required_functions_present === true
    && details.table_update_granted === false;
  try {
    client = await connect();
    if (readOnly) {
      await client.query('BEGIN READ ONLY');
      inTx = true;
      const state = await readCheckaltAutoDepositState(client);
      await rollback();
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
          prerequisites_ok: prerequisites(state.details),
          pin_executable: pinExecutable,
          apply_preconditions_met: pinExecutable
            && state.details.live_definition_sha256 === pin.expected_live_definition_sha256
            && state.details.function_states.definition === 'expected'
            && prerequisites(state.details),
        },
      });
    }

    await client.query('BEGIN');
    inTx = true;
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['sql80_checkalt_member_auto_deposit']);
    if (isConsumed(event.one_use_id)) {
      await rollback();
      return fail(CODES.SQL_COLLISION, 'one_use_id has already been consumed; replay is forbidden', {
        one_use_id: event.one_use_id,
      });
    }
    const before = await readCheckaltAutoDepositState(client);
    if (!before.ok) {
      await rollback();
      return before;
    }
    if (before.details.live_definition_sha256 === pin.intended_replacement_sha256
      || before.details.function_states.definition === 'intended') {
      await rollback();
      return fail(CODES.UNRELATED_MUTATION, 'the SQL 80 function definition is already in place; refuse re-apply', {
        function_states: before.details.function_states,
        matches_intended: before.details.live_definition_sha256 === pin.intended_replacement_sha256,
      });
    }
    if (!prerequisites(before.details)) {
      await rollback();
      return fail(CODES.DEPLOYMENT_COLLISION, 'SQL 80 prerequisites are not met (the SQL 38 function with no other overloads, SECURITY DEFINER and the reviewed search_path/row_security, owned by the executor role, EXECUTE for checksops and authenticated only, the tables, roles and helpers it calls, no UPDATE grant on checkalt_tenant_accounts)', {
        exists: before.details.exists,
        overload_count: before.details.overload_count,
        security_definer: before.details.security_definer,
        config_as_reviewed: before.details.config_as_reviewed,
        owner_is_executor: before.details.owner_is_executor,
        acl_as_expected: before.details.acl_as_expected,
        required_roles_present: before.details.required_roles_present,
        required_tables_present: before.details.required_tables_present,
        required_functions_present: before.details.required_functions_present,
        table_update_granted: before.details.table_update_granted,
      });
    }
    if (before.details.function_states.definition !== 'expected'
      || before.details.live_definition_sha256 !== pin.expected_live_definition_sha256
      || before.details.live_definition_sha256 !== event.expected_live_definition_sha256) {
      await rollback();
      return fail(CODES.DEPLOYMENT_COLLISION, 'aws_save_checkalt_tenant_auto_deposit is not the expected SQL 38 pre-apply state', {
        function_states: before.details.function_states,
        live_definition_sha256: before.details.live_definition_sha256,
      });
    }
    const schemaBefore = await readCheckaltSchemaSnapshot(client);

    await client.query(embedded.details.text);

    const after = await readCheckaltAutoDepositState(client);
    if (!after.ok) {
      await rollback();
      return after;
    }
    const schemaAfter = await readCheckaltSchemaSnapshot(client);
    if (after.details.live_definition_sha256 !== pin.intended_replacement_sha256
      || after.details.function_definition_sha256 !== hashSqlDefinition(reviewedDef)
      || after.details.function_states.definition !== 'intended'
      || after.details.overload_count !== 1
      || after.details.security_definer !== true
      || after.details.config_as_reviewed !== true
      || after.details.acl_sha256 !== before.details.acl_sha256
      || after.details.table_update_granted !== false
      || schemaAfter.relations_sha256 !== schemaBefore.relations_sha256
      || schemaAfter.policies_sha256 !== schemaBefore.policies_sha256
      || schemaAfter.other_functions_sha256 !== schemaBefore.other_functions_sha256
      || schemaAfter.table_acl_sha256 !== schemaBefore.table_acl_sha256) {
      await rollback();
      return fail(CODES.UNRELATED_MUTATION, 'SQL 80 did not land exactly on the reviewed function, or changed its grants or something else', {
        after_hash: after.details.live_definition_sha256,
        function_states: after.details.function_states,
        security_definer: after.details.security_definer,
        config_as_reviewed: after.details.config_as_reviewed,
        acl_unchanged: after.details.acl_sha256 === before.details.acl_sha256,
        relations_unchanged: schemaAfter.relations_sha256 === schemaBefore.relations_sha256,
        policies_unchanged: schemaAfter.policies_sha256 === schemaBefore.policies_sha256,
        other_functions_unchanged: schemaAfter.other_functions_sha256 === schemaBefore.other_functions_sha256,
        table_acl_unchanged: schemaAfter.table_acl_sha256 === schemaBefore.table_acl_sha256,
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
        function_states: after.details.function_states,
        acl_sha256: after.details.acl_sha256,
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

// --- SQL 81: production Check Alt depositor registration writer ------------

// The roles, tables, helper and columns SQL 81's body uses; ON CONFLICT (tenant_id)
// needs a plain unique index on tenant_id alone. $1 is CHECKALT_REGISTER_COLUMNS.
const CHECKALT_REGISTER_PREREQUISITES_SQL = `
SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'checksops')
    AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') AS required_roles_present,
  to_regclass('${CHECKALT_REGISTER_TABLE}') IS NOT NULL
    AND to_regclass('public.tenants') IS NOT NULL AS required_tables_present,
  to_regprocedure('public.is_platform_owner()') IS NOT NULL AS required_functions_present,
  to_regclass('${CHECKALT_REGISTER_TABLE}') IS NOT NULL
    AND (SELECT count(DISTINCT a.attname)::int FROM pg_attribute a
      WHERE a.attrelid = to_regclass('${CHECKALT_REGISTER_TABLE}') AND a.attnum > 0 AND NOT a.attisdropped
        AND a.attname::text = ANY($1::text[])) = cardinality($1::text[])
    AND EXISTS (SELECT 1 FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
      WHERE i.indrelid = to_regclass('${CHECKALT_REGISTER_TABLE}') AND i.indisunique AND i.indnkeyatts = 1
        AND i.indpred IS NULL AND i.indexprs IS NULL AND a.attname = 'tenant_id') AS required_columns_present
`.trim();
// Table or column UPDATE / INSERT for either grantee; unknown (missing table or role) reads as granted.
const CHECKALT_REGISTER_TABLE_WRITE_SQL = `
SELECT CASE WHEN to_regclass('${CHECKALT_REGISTER_TABLE}') IS NULL
    OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'checksops')
    OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN NULL
  ELSE has_any_column_privilege('checksops', '${CHECKALT_REGISTER_TABLE}', 'UPDATE')
    OR has_any_column_privilege('authenticated', '${CHECKALT_REGISTER_TABLE}', 'UPDATE')
  END AS register_table_update_granted,
  CASE WHEN to_regclass('${CHECKALT_REGISTER_TABLE}') IS NULL
    OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'checksops')
    OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN NULL
  ELSE has_any_column_privilege('checksops', '${CHECKALT_REGISTER_TABLE}', 'INSERT')
    OR has_any_column_privilege('authenticated', '${CHECKALT_REGISTER_TABLE}', 'INSERT')
  END AS register_table_insert_granted
`.trim();

const SQL81_SIGNATURE = CHECKALT_REGISTER_FUNCTION;
// The reviewed file outside the function body and the comment literal,
// comments removed and whitespace collapsed.
export const SQL81_NORMALIZED_STATEMENTS = [
  'CREATE OR REPLACE FUNCTION public.aws_register_checkalt_tenant_account( _tenant_id uuid, _account jsonb )',
  'RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public SET row_security = off AS $$<body>$$;',
  `COMMENT ON FUNCTION ${SQL81_SIGNATURE} IS <comment>;`,
  `REVOKE ALL ON FUNCTION ${SQL81_SIGNATURE} FROM PUBLIC;`,
  `GRANT EXECUTE ON FUNCTION ${SQL81_SIGNATURE} TO checksops, authenticated;`,
].join(' ');
// pg_get_functiondef's header on PostgreSQL 16 for the reviewed CREATE.
const SQL81_FUNCTIONDEF_HEADER = [
  'CREATE OR REPLACE FUNCTION public.aws_register_checkalt_tenant_account(_tenant_id uuid, _account jsonb)',
  ' RETURNS jsonb',
  ' LANGUAGE plpgsql',
  ' SECURITY DEFINER',
  " SET search_path TO 'public'",
  " SET row_security TO 'off'",
  'AS $function$',
].join('\n');

/** Splits the file into the statements outside the body, the body and the comment text (SQL 80's file shape). */
export function parseSql81(text) {
  return parseSql80(text);
}

/** pg_get_functiondef (PostgreSQL 16) of the function the reviewed SQL 81 file creates. */
export function sql81ReviewedFunctiondef(text) {
  const parsed = parseSql81(text);
  return parsed ? `${SQL81_FUNCTIONDEF_HEADER}${parsed.body}$function$\n` : null;
}

// 'absent' before SQL 81, 'intended' = the SQL 81 text, anything else 'other'.
const registerLabel = (hash, reviewed, missing) => {
  if (hash == null) return missing;
  return hash === reviewed ? 'intended' : 'other';
};

/**
 * Read-only fingerprint of the SQL 81 function (same shape as SQL 80's): its
 * definition, SECURITY DEFINER, config, owner, comment, overloads and ACL, plus
 * prerequisites and the table's INSERT/UPDATE surface.
 */
export async function readCheckaltRegisterState(client) {
  await client.query(STAKEHOLDER_POLICY_SEARCH_PATH_SQL);
  const fn = (await client.query(CHECKALT_FUNCTION_SQL, [CHECKALT_REGISTER_FUNCTION, CHECKALT_REGISTER_FUNCTION_NAME]))?.rows?.[0] || {};
  const exists = fn.present === true;
  const acl = exists ? ((await client.query(CHECKALT_FUNCTION_ACL_SQL, [CHECKALT_REGISTER_FUNCTION]))?.rows || []) : [];
  const prereq = (await client.query(CHECKALT_REGISTER_PREREQUISITES_SQL, [[...CHECKALT_REGISTER_COLUMNS]]))?.rows?.[0] || {};
  const writes = (await client.query(CHECKALT_REGISTER_TABLE_WRITE_SQL))?.rows?.[0] || {};
  const config = Array.isArray(fn.config) ? fn.config.map(String) : [];
  const state = {
    exists,
    overload_count: Number.isInteger(fn.overload_count) ? fn.overload_count : Number(fn.overload_count) || 0,
    definition_sha256: exists && typeof fn.def === 'string' ? hashSqlDefinition(fn.def) : null,
    security_definer: fn.security_definer === true,
    config,
    owner_is_executor: fn.owner_is_executor === true,
    comment_sha256: exists && typeof fn.comment === 'string' ? hashSqlDefinition(fn.comment) : null,
    acl: acl.map((entry) => ({ grantee: entry.grantee, privilege_type: entry.privilege_type, is_grantable: entry.is_grantable === true })),
  };
  const aclLines = state.acl.map((entry) => `${entry.grantee} ${entry.privilege_type}${entry.is_grantable ? ' with grant option' : ''}`).sort();
  const expectedAcl = CHECKALT_REGISTER_GRANTEES.map((grantee) => `${grantee} EXECUTE`).sort();
  return ok({
    exists,
    overload_count: state.overload_count,
    security_definer: state.security_definer,
    config_as_reviewed: JSON.stringify(config) === JSON.stringify(CHECKALT_REGISTER_CONFIG),
    owner_is_executor: state.owner_is_executor,
    function_states: {
      definition: registerLabel(state.definition_sha256, CHECKALT_REGISTER_DEFINITION_SHA256.sql81, 'absent'),
      comment: exists ? registerLabel(state.comment_sha256, CHECKALT_REGISTER_COMMENT_SHA256.sql81, 'none') : 'absent',
    },
    function_definition_sha256: state.definition_sha256,
    acl_sha256: hashSqlDefinition(aclLines.join('\n')),
    acl_as_expected: JSON.stringify(aclLines) === JSON.stringify(expectedAcl),
    required_roles_present: prereq.required_roles_present === true,
    required_tables_present: prereq.required_tables_present === true,
    required_functions_present: prereq.required_functions_present === true,
    required_columns_present: prereq.required_columns_present === true,
    table_update_granted: writes.register_table_update_granted !== false,
    table_insert_granted: writes.register_table_insert_granted !== false,
    live_definition_sha256: hashSqlDefinition(checkaltRegisterStateText(state)),
  });
}

/** A test may supply `pin` only as the committed pin with a reviewed expected hash filled in. */
function sql81PinIsCommitted(pin) {
  const committed = AUTHORIZED_SQL81_CHECKALT_PRODUCTION_REGISTER;
  return Boolean(pin) && ['filename', 'migration_id', 'commit', 'source_sha256', 'intended_replacement_sha256', 'function_identity', 'table']
    .every((key) => pin[key] === committed[key]);
}

async function handleSql81CheckaltProductionRegister({
  event,
  authorization,
  identity,
  connect,
  sqlFile81,
  pin = AUTHORIZED_SQL81_CHECKALT_PRODUCTION_REGISTER,
}) {
  if (!sql81PinIsCommitted(pin)) {
    return fail(CODES.SQL_COLLISION, 'SQL 81 pin does not match the committed allowlist entry');
  }
  const embedded = readEmbeddedSql(sqlFile81, pin.source_sha256);
  if (!embedded.ok) return embedded;
  const parsed = parseSql81(embedded.details.text);
  const reviewedDef = sql81ReviewedFunctiondef(embedded.details.text);
  if (!parsed || parsed.outside !== SQL81_NORMALIZED_STATEMENTS
    || hashSqlDefinition(parsed.comment) !== CHECKALT_REGISTER_COMMENT_SHA256.sql81
    || hashSqlDefinition(reviewedDef) !== CHECKALT_REGISTER_DEFINITION_SHA256.sql81) {
    return fail(CODES.UNRELATED_MUTATION, 'embedded SQL 81 is not exactly the reviewed statements');
  }
  const readOnly = event.action === 'inspect' || event.action === 'verify_data' || event.action === 'authorize';
  if (!readOnly && event.action !== 'apply') {
    return fail(CODES.INVALID_MANIFEST, `unsupported SQL 81 executor action ${event.action}`);
  }
  const pinExecutable = SQL80_SHA256_RE.test(String(pin.expected_live_definition_sha256 || ''));
  if (event.action === 'apply' && !pinExecutable) {
    return fail(CODES.SQL_COLLISION, 'SQL 81 pin has no reviewed pre-apply live definition hash yet; apply is refused');
  }
  if (event.action === 'apply' && !(
    event.filename === pin.filename
    && event.migration_id === pin.migration_id
    && event.source_sha256 === pin.source_sha256
    && event.intended_replacement_sha256 === pin.intended_replacement_sha256
    && event.expected_live_definition_sha256 === pin.expected_live_definition_sha256
    && event.commit === pin.commit
  )) {
    return fail(CODES.SQL_COLLISION, 'SQL 81 apply is bound to the exact allowlisted pin');
  }

  let client;
  let inTx = false;
  const rollback = async () => {
    if (inTx) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    }
    inTx = false;
  };
  // Pre-apply: the function is absent (no function of that name in any schema),
  // everything it uses exists, and neither grantee can INSERT or UPDATE the table.
  const prerequisites = (details) => details.exists === false
    && details.overload_count === 0
    && details.required_roles_present === true
    && details.required_tables_present === true
    && details.required_functions_present === true
    && details.required_columns_present === true
    && details.table_update_granted === false
    && details.table_insert_granted === false;
  try {
    client = await connect();
    if (readOnly) {
      await client.query('BEGIN READ ONLY');
      inTx = true;
      const state = await readCheckaltRegisterState(client);
      await rollback();
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
          prerequisites_ok: prerequisites(state.details),
          pin_executable: pinExecutable,
          apply_preconditions_met: pinExecutable
            && state.details.live_definition_sha256 === pin.expected_live_definition_sha256
            && state.details.function_states.definition === 'absent'
            && prerequisites(state.details),
        },
      });
    }

    await client.query('BEGIN');
    inTx = true;
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['sql81_checkalt_production_register']);
    if (isConsumed(event.one_use_id)) {
      await rollback();
      return fail(CODES.SQL_COLLISION, 'one_use_id has already been consumed; replay is forbidden', {
        one_use_id: event.one_use_id,
      });
    }
    const before = await readCheckaltRegisterState(client);
    if (!before.ok) {
      await rollback();
      return before;
    }
    if (before.details.live_definition_sha256 === pin.intended_replacement_sha256
      || before.details.function_states.definition === 'intended') {
      await rollback();
      return fail(CODES.UNRELATED_MUTATION, 'the SQL 81 function is already in place; refuse re-apply', {
        function_states: before.details.function_states,
        matches_intended: before.details.live_definition_sha256 === pin.intended_replacement_sha256,
      });
    }
    if (!prerequisites(before.details)) {
      await rollback();
      return fail(CODES.DEPLOYMENT_COLLISION, 'SQL 81 prerequisites are not met (no function named aws_register_checkalt_tenant_account in any schema; the roles, tables, columns, unique tenant_id and helper it uses; no INSERT or UPDATE on checkalt_tenant_accounts for checksops or authenticated)', {
        exists: before.details.exists,
        overload_count: before.details.overload_count,
        required_roles_present: before.details.required_roles_present,
        required_tables_present: before.details.required_tables_present,
        required_functions_present: before.details.required_functions_present,
        required_columns_present: before.details.required_columns_present,
        table_update_granted: before.details.table_update_granted,
        table_insert_granted: before.details.table_insert_granted,
      });
    }
    if (before.details.function_states.definition !== 'absent'
      || before.details.live_definition_sha256 !== pin.expected_live_definition_sha256
      || before.details.live_definition_sha256 !== event.expected_live_definition_sha256) {
      await rollback();
      return fail(CODES.DEPLOYMENT_COLLISION, 'aws_register_checkalt_tenant_account is not the expected absent pre-apply state', {
        function_states: before.details.function_states,
        live_definition_sha256: before.details.live_definition_sha256,
      });
    }
    const schemaBefore = await readCheckaltSchemaSnapshot(client, CHECKALT_REGISTER_FUNCTION);

    await client.query(embedded.details.text);

    const after = await readCheckaltRegisterState(client);
    if (!after.ok) {
      await rollback();
      return after;
    }
    const schemaAfter = await readCheckaltSchemaSnapshot(client, CHECKALT_REGISTER_FUNCTION);
    if (after.details.live_definition_sha256 !== pin.intended_replacement_sha256
      || after.details.function_definition_sha256 !== hashSqlDefinition(reviewedDef)
      || after.details.function_states.definition !== 'intended'
      || after.details.function_states.comment !== 'intended'
      || after.details.exists !== true
      || after.details.overload_count !== 1
      || after.details.security_definer !== true
      || after.details.config_as_reviewed !== true
      || after.details.owner_is_executor !== true
      || after.details.acl_as_expected !== true
      || after.details.table_update_granted !== false
      || after.details.table_insert_granted !== false
      || schemaAfter.relations_sha256 !== schemaBefore.relations_sha256
      || schemaAfter.policies_sha256 !== schemaBefore.policies_sha256
      || schemaAfter.other_functions_sha256 !== schemaBefore.other_functions_sha256
      || schemaAfter.table_acl_sha256 !== schemaBefore.table_acl_sha256) {
      await rollback();
      return fail(CODES.UNRELATED_MUTATION, 'SQL 81 did not land exactly on the reviewed function and grants, or changed something else', {
        after_hash: after.details.live_definition_sha256,
        function_states: after.details.function_states,
        security_definer: after.details.security_definer,
        config_as_reviewed: after.details.config_as_reviewed,
        owner_is_executor: after.details.owner_is_executor,
        acl_as_expected: after.details.acl_as_expected,
        relations_unchanged: schemaAfter.relations_sha256 === schemaBefore.relations_sha256,
        policies_unchanged: schemaAfter.policies_sha256 === schemaBefore.policies_sha256,
        other_functions_unchanged: schemaAfter.other_functions_sha256 === schemaBefore.other_functions_sha256,
        table_acl_unchanged: schemaAfter.table_acl_sha256 === schemaBefore.table_acl_sha256,
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
        function_states: after.details.function_states,
        acl_sha256: after.details.acl_sha256,
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

// --- SQL 82 / SQL 83: homeowner ledger view and signing capabilities ---------

// The reviewed files outside the function bodies, comments removed and whitespace collapsed.
export const HOMEOWNER_NORMALIZED_STATEMENTS = Object.freeze({
  sql82: [
    'CREATE OR REPLACE FUNCTION public.aws_public_homeowner_ledger_by_token(p_token text)',
    'RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$<body>$$;',
    'REVOKE ALL ON FUNCTION public.aws_public_homeowner_ledger_by_token(text) FROM PUBLIC;',
    'REVOKE ALL ON FUNCTION public.aws_public_homeowner_ledger_by_token(text) FROM authenticated;',
    'GRANT EXECUTE ON FUNCTION public.aws_public_homeowner_ledger_by_token(text) TO checksops;',
  ].join(' '),
  sql83: [
    'CREATE OR REPLACE FUNCTION public.aws_public_homeowner_ledger_endorse_capability( p_token text, p_endorsement_id uuid )',
    'RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public SET row_security = off AS $$<body>$$;',
    'CREATE OR REPLACE FUNCTION public.aws_public_homeowner_pending_signatures(p_token text)',
    'RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public SET row_security = off AS $$<body>$$;',
    'CREATE OR REPLACE FUNCTION public.aws_public_homeowner_document_sign_capability( p_token text, p_signer_id uuid )',
    'RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public SET row_security = off AS $$<body>$$;',
    'REVOKE ALL ON FUNCTION public.aws_public_homeowner_ledger_endorse_capability(text, uuid) FROM PUBLIC;',
    'REVOKE ALL ON FUNCTION public.aws_public_homeowner_ledger_endorse_capability(text, uuid) FROM authenticated;',
    'GRANT EXECUTE ON FUNCTION public.aws_public_homeowner_ledger_endorse_capability(text, uuid) TO checksops;',
    'REVOKE ALL ON FUNCTION public.aws_public_homeowner_pending_signatures(text) FROM PUBLIC;',
    'REVOKE ALL ON FUNCTION public.aws_public_homeowner_pending_signatures(text) FROM authenticated;',
    'GRANT EXECUTE ON FUNCTION public.aws_public_homeowner_pending_signatures(text) TO checksops;',
    'REVOKE ALL ON FUNCTION public.aws_public_homeowner_document_sign_capability(text, uuid) FROM PUBLIC;',
    'REVOKE ALL ON FUNCTION public.aws_public_homeowner_document_sign_capability(text, uuid) FROM authenticated;',
    'GRANT EXECUTE ON FUNCTION public.aws_public_homeowner_document_sign_capability(text, uuid) TO checksops;',
  ].join(' '),
});

/**
 * Splits a file into the statements outside the function bodies (each body
 * replaced by <body>) and the bodies in file order. Null when a body is not
 * closed by `$$;` or a stray `$$` remains.
 */
export function parseHomeownerSql(text) {
  const source = String(text || '');
  const bodies = [];
  let rest = '';
  let from = 0;
  for (;;) {
    const open = source.indexOf('AS $$', from);
    if (open < 0) break;
    const close = source.indexOf('$$;', open + 5);
    if (close < 0) return null;
    bodies.push(source.slice(open + 5, close));
    rest += `${source.slice(from, open)}AS $$<body>$$;`;
    from = close + 3;
  }
  rest += source.slice(from);
  const outside = rest.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
  if (outside.replace(/\$\$<body>\$\$/g, '').includes('$$')) return null;
  return { outside, bodies };
}

/** pg_get_functiondef (PostgreSQL 16) of each function a reviewed file creates, by identity. */
export function homeownerReviewedFunctiondefs(key, text) {
  const spec = HOMEOWNER_MIGRATIONS[key];
  const parsed = parseHomeownerSql(text);
  if (!spec || !parsed || parsed.bodies.length !== spec.functions.length) return null;
  return Object.fromEntries(spec.functions.map((fn, index) => [fn.identity, [
    `CREATE OR REPLACE FUNCTION public.${fn.name}(${fn.arguments})`,
    ' RETURNS jsonb',
    ' LANGUAGE plpgsql',
    ' SECURITY DEFINER',
    ...fn.config.map((entry) => {
      const [name, value] = entry.split('=');
      return ` SET ${name} TO '${value}'`;
    }),
    `AS $function$${parsed.bodies[index]}$function$`,
    '',
  ].join('\n')]));
}

/** The reviewed file is exactly the reviewed statements, bodies and functiondefs. */
export function homeownerSqlIsReviewed(key, text) {
  const parsed = parseHomeownerSql(text);
  const defs = homeownerReviewedFunctiondefs(key, text);
  return Boolean(parsed && defs)
    && parsed.outside === HOMEOWNER_NORMALIZED_STATEMENTS[key]
    && HOMEOWNER_MIGRATIONS[key].functions.every((fn) => hashSqlDefinition(defs[fn.identity]) === HOMEOWNER_DEFINITION_SHA256[fn.identity]);
}

// $1 is the function identity, $2 its bare name (functions of that name in any schema).
const HOMEOWNER_FUNCTION_SQL = `
SELECT p.oid IS NOT NULL AS present,
  CASE WHEN p.oid IS NOT NULL THEN pg_get_functiondef(p.oid) END AS def,
  CASE WHEN p.oid IS NOT NULL THEN pg_get_function_arguments(p.oid) END AS arguments,
  CASE WHEN p.oid IS NOT NULL THEN pg_get_function_identity_arguments(p.oid) END AS identity_arguments,
  CASE WHEN p.oid IS NOT NULL THEN pg_get_function_result(p.oid) END AS result,
  p.prokind::text AS prokind,
  p.proretset AS retset,
  l.lanname::text AS language,
  COALESCE(p.proargnames, ARRAY[]::text[]) AS arg_names,
  p.prosecdef AS security_definer,
  COALESCE(p.proconfig, ARRAY[]::text[]) AS config,
  p.proacl::text AS proacl,
  pg_get_userbyid(p.proowner)::text AS owner,
  p.proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user) AS owner_is_executor,
  o.rolsuper AS owner_rolsuper,
  o.rolbypassrls AS owner_rolbypassrls,
  (SELECT count(*)::int FROM pg_proc x WHERE x.proname = $2) AS overload_count
FROM (SELECT to_regprocedure($1) AS oid) t
LEFT JOIN pg_proc p ON p.oid = t.oid
LEFT JOIN pg_language l ON l.oid = p.prolang
LEFT JOIN pg_roles o ON o.oid = p.proowner
`.trim();
// Every function carrying one of the names, in any schema (overloads and other signatures).
const HOMEOWNER_NAMED_FUNCTIONS_SQL = `
SELECT p.proname::text AS name, p.oid::regprocedure::text AS signature, pg_get_function_result(p.oid) AS result
FROM pg_proc p
WHERE p.proname = ANY($1::text[])
ORDER BY 1, 2
`.trim();
const HOMEOWNER_LOGIN_SQL = `
SELECT current_user::text AS current_user, session_user::text AS session_user,
  r.rolsuper AS rolsuper, r.rolbypassrls AS rolbypassrls
FROM pg_roles r
WHERE r.rolname = current_user
`.trim();
const HOMEOWNER_ROLES_SQL = `
SELECT rolname::text AS rolname FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY 1
`.trim();
const HOMEOWNER_TABLES_SQL = `
SELECT c.relname::text AS relname, c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced,
  pg_get_userbyid(c.relowner)::text AS owner
FROM pg_class c
WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND c.relname = ANY($1::text[])
ORDER BY 1
`.trim();
const HOMEOWNER_COLUMNS_SQL = `
SELECT c.relname::text AS relname, a.attname::text AS attname
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND c.relname = ANY($1::text[])
  AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY 1, 2
`.trim();
const HOMEOWNER_CHECK_CONSTRAINTS_SQL = `
SELECT c.relname::text AS relname, con.conname::text AS conname, pg_get_constraintdef(con.oid) AS def
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY($1::text[]) AND con.contype = 'c'
ORDER BY 1, 2
`.trim();
// Aggregate status counts only (never row data). Read under row_security = off inside a
// savepoint: a login RLS would filter gets an error instead of silently partial counts.
const HOMEOWNER_STATUS_COUNT_SQL = Object.freeze({
  check_endorsements: {
    columns: ['payee_type', 'status'],
    sql: `SELECT lower(COALESCE(payee_type::text, '')) AS payee_type, lower(COALESCE(status::text, '')) AS status, count(*)::int AS n
FROM public.check_endorsements GROUP BY 1, 2 ORDER BY 1, 2 LIMIT 100`,
  },
  signature_signers: {
    columns: ['status'],
    sql: `SELECT lower(COALESCE(status::text, '')) AS status, count(*)::int AS n
FROM public.signature_signers GROUP BY 1 ORDER BY 1 LIMIT 100`,
  },
  signature_requests: {
    columns: ['status'],
    sql: `SELECT lower(COALESCE(status::text, '')) AS status, count(*)::int AS n
FROM public.signature_requests GROUP BY 1 ORDER BY 1 LIMIT 100`,
  },
});
// Everything else in schema public and auth the migrations must not touch.
const HOMEOWNER_RELATIONS_SQL = `
SELECT c.relname::text AS relname, c.relkind::text AS relkind, c.relacl::text AS relacl,
  c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner)::text AS owner
FROM pg_class c
WHERE c.relnamespace = 'public'::regnamespace
ORDER BY 1, 2
`.trim();
const HOMEOWNER_OTHER_FUNCTIONS_SQL = `
SELECT p.oid::regprocedure::text AS signature,
  encode(sha256(convert_to(pg_get_functiondef(p.oid), 'UTF8')), 'hex') AS def_sha256,
  p.proacl::text AS acl, p.prosecdef, p.proconfig::text AS config, p.proowner::regrole::text AS owner
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname IN ('public', 'auth') AND p.prokind IN ('f', 'p')
  AND NOT EXISTS (SELECT 1 FROM unnest($1::text[]) x WHERE to_regprocedure(x) = p.oid)
ORDER BY 1
`.trim();

const SAFE_LABEL_RE = /^[a-z0-9_ -]{0,40}$/;
const aclLine = (entry) => `${entry.grantee} ${entry.privilege_type}${entry.is_grantable === true ? ' with grant option' : ''}`;
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** Status literals a CHECK definition allows ('a'::text, ...); labels only. */
const checkLiterals = (def) => [...String(def || '').matchAll(/'((?:[^']|'')*)'/g)]
  .map((match) => match[1].replace(/''/g, "'"))
  .map((value) => (SAFE_LABEL_RE.test(value) ? value : 'unrecognized'));

/**
 * Read-only fingerprint and readable detail of a homeowner migration's
 * functions plus the roles, tables, columns and RLS their bodies rely on.
 * Never reads row data. `live_definition_sha256` is the pinned fingerprint.
 */
export async function readHomeownerState(client, key) {
  const spec = HOMEOWNER_MIGRATIONS[key];
  if (!spec) return fail(CODES.INVALID_MANIFEST, `unknown homeowner migration ${key}`);
  await client.query(STAKEHOLDER_POLICY_SEARCH_PATH_SQL);
  const login = (await client.query(HOMEOWNER_LOGIN_SQL))?.rows?.[0] || {};
  const tables = Object.keys(spec.columns);
  const reportTables = [...new Set([...HOMEOWNER_RLS_TABLES, ...tables])].sort();
  const roles = ((await client.query(HOMEOWNER_ROLES_SQL, [['checksops', 'authenticated']]))?.rows || []).map((row) => row.rolname);
  const tableRows = (await client.query(HOMEOWNER_TABLES_SQL, [reportTables]))?.rows || [];
  const columnRows = (await client.query(HOMEOWNER_COLUMNS_SQL, [tables]))?.rows || [];
  const named = (await client.query(HOMEOWNER_NAMED_FUNCTIONS_SQL, [spec.functions.map((fn) => fn.name)]))?.rows || [];
  const states = {};
  const functions = {};
  for (const fn of spec.functions) {
    const row = (await client.query(HOMEOWNER_FUNCTION_SQL, [fn.identity, fn.name]))?.rows?.[0] || {};
    const exists = row.present === true;
    const acl = exists ? ((await client.query(CHECKALT_FUNCTION_ACL_SQL, [fn.identity]))?.rows || []) : [];
    const config = Array.isArray(row.config) ? row.config.map(String) : [];
    const def = exists && typeof row.def === 'string' ? row.def : null;
    const state = {
      exists,
      overload_count: Number.isInteger(row.overload_count) ? row.overload_count : Number(row.overload_count) || 0,
      arguments: exists ? row.arguments ?? null : null,
      result: exists ? row.result ?? null : null,
      definition_sha256: def ? hashSqlDefinition(def) : null,
      security_definer: row.security_definer === true,
      config,
      owner_is_executor: row.owner_is_executor === true,
      acl: acl.map((entry) => ({ grantee: entry.grantee, privilege_type: entry.privilege_type, is_grantable: entry.is_grantable === true })),
    };
    states[fn.identity] = state;
    const aclLines = state.acl.map(aclLine).sort();
    functions[fn.name] = {
      identity: fn.identity,
      exists,
      overload_count: state.overload_count,
      named_signatures: named.filter((other) => other.name === fn.name).map((other) => `${other.signature} returns ${other.result}`),
      identity_arguments: exists ? row.identity_arguments ?? null : null,
      arguments: state.arguments,
      argument_names: exists ? (row.arg_names || []).map(String) : [],
      result: state.result,
      kind: exists ? row.prokind ?? null : null,
      returns_set: exists ? row.retset === true : null,
      language: exists ? row.language ?? null : null,
      security_definer: exists ? state.security_definer : null,
      config,
      owner: exists ? row.owner ?? null : null,
      owner_is_executor: exists ? state.owner_is_executor : null,
      owner_rolsuper: exists ? row.owner_rolsuper === true : null,
      owner_rolbypassrls: exists ? row.owner_rolbypassrls === true : null,
      proacl: exists ? row.proacl ?? null : null,
      acl_entries: aclLines,
      definition_sha256: state.definition_sha256,
      matches_migration: state.definition_sha256 != null && state.definition_sha256 === HOMEOWNER_DEFINITION_SHA256[fn.identity],
      raw_endorse_token_link: def ? HOMEOWNER_RAW_ENDORSE_LINK_RE.test(def) : null,
      // Whole-file comparison helpers keep the body as text only inside this process.
      _def: def,
    };
  }
  const tableMap = Object.fromEntries(reportTables.map((name) => {
    const row = tableRows.find((entry) => entry.relname === name);
    return [name, row
      ? { present: true, rls_enabled: row.rls_enabled === true, rls_forced: row.rls_forced === true, owner: row.owner ?? null }
      : { present: false, rls_enabled: null, rls_forced: null, owner: null }];
  }));
  const missingColumns = {};
  for (const [table, columns] of Object.entries(spec.columns)) {
    const have = new Set(columnRows.filter((row) => row.relname === table).map((row) => row.attname));
    const missing = columns.filter((column) => !have.has(column));
    if (missing.length) missingColumns[table] = missing;
  }
  // Which role each definer runs as after the apply: the current owner, or the login for a new function.
  const effectiveOwner = (fn) => (fn.exists
    ? { name: fn.owner, rolsuper: fn.owner_rolsuper, rolbypassrls: fn.owner_rolbypassrls }
    : { name: login.current_user ?? null, rolsuper: login.rolsuper === true, rolbypassrls: login.rolbypassrls === true });
  // With row_security = off a definer errors on any RLS table it does not bypass
  // (superuser, BYPASSRLS, or the table owner without FORCE RLS).
  const rowSecurity = {};
  for (const fn of spec.functions) {
    const owner = effectiveOwner(functions[fn.name]);
    const blocked = tables.filter((table) => {
      const row = tableMap[table];
      if (!row?.present || row.rls_enabled !== true) return false;
      if (owner.rolsuper === true || owner.rolbypassrls === true) return false;
      return !(row.owner === owner.name && row.rls_forced !== true);
    });
    rowSecurity[fn.name] = {
      owner: owner.name,
      owner_rolsuper: owner.rolsuper === true,
      owner_rolbypassrls: owner.rolbypassrls === true,
      rls_tables_not_bypassed: blocked,
    };
  }
  const allAcl = spec.functions.flatMap((fn) => functions[fn.name].acl_entries.map((line) => `${fn.identity} ${line}`)).sort();
  const present = spec.functions.filter((fn) => functions[fn.name].exists);
  return ok({
    migration: key,
    current_user: login.current_user ?? null,
    session_user: login.session_user ?? null,
    login_rolsuper: login.rolsuper === true,
    login_rolbypassrls: login.rolbypassrls === true,
    exists: present.length === spec.functions.length,
    overload_count: spec.functions.reduce((sum, fn) => sum + functions[fn.name].overload_count, 0),
    security_definer: present.every((fn) => functions[fn.name].security_definer === true),
    config_as_reviewed: present.every((fn) => sameJson(functions[fn.name].config, fn.config)),
    owner_is_executor: present.every((fn) => functions[fn.name].owner_is_executor === true),
    acl_as_expected: present.length === spec.functions.length
      && present.every((fn) => sameJson(functions[fn.name].acl_entries, HOMEOWNER_EXECUTE_GRANTEES.map((g) => `${g} EXECUTE`))),
    acl_sha256: hashSqlDefinition(allAcl.join('\n')),
    function_states: Object.fromEntries(spec.functions.map((fn) => {
      const row = functions[fn.name];
      return [fn.name, !row.exists ? 'absent' : (row.matches_migration ? 'intended' : 'other')];
    })),
    functions,
    required_roles_present: ['authenticated', 'checksops'].every((role) => roles.includes(role)),
    required_tables_present: tables.every((table) => tableMap[table]?.present === true),
    required_columns_present: Object.keys(missingColumns).length === 0,
    missing_columns: missingColumns,
    tables: tableMap,
    row_security: rowSecurity,
    row_security_off_supported: spec.functions.every((fn) => rowSecurity[fn.name].rls_tables_not_bypassed.length === 0),
    live_definition_sha256: hashSqlDefinition(homeownerStateText(key, states)),
  });
}

/**
 * Report-only reads for the inspect: the legacy re-mint function, status CHECK
 * constraints and aggregate status counts. Never part of the fingerprint.
 */
export async function readHomeownerReport(client) {
  await client.query(STAKEHOLDER_POLICY_SEARCH_PATH_SQL);
  const legacy = (await client.query(HOMEOWNER_NAMED_FUNCTIONS_SQL, [[HOMEOWNER_LEGACY_FUNCTION_NAME]]))?.rows || [];
  const constraintRows = (await client.query(HOMEOWNER_CHECK_CONSTRAINTS_SQL, [[...HOMEOWNER_STATUS_TABLES]]))?.rows || [];
  const columnRows = (await client.query(HOMEOWNER_COLUMNS_SQL, [[...HOMEOWNER_STATUS_TABLES]]))?.rows || [];
  const constraints = Object.fromEntries(HOMEOWNER_STATUS_TABLES.map((table) => [table, constraintRows
    .filter((row) => row.relname === table && /\b(status|payee_type)\b/.test(String(row.def || '')))
    .map((row) => ({ name: row.conname, definition: row.def, definition_sha256: hashSqlDefinition(String(row.def || '')), allowed: checkLiterals(row.def) }))]));
  const counts = {};
  await client.query('SAVEPOINT homeowner_status_counts');
  try {
    await client.query("SELECT set_config('row_security', 'off', true)");
    for (const table of HOMEOWNER_STATUS_TABLES) {
      const spec = HOMEOWNER_STATUS_COUNT_SQL[table];
      const have = new Set(columnRows.filter((row) => row.relname === table).map((row) => row.attname));
      if (!spec.columns.every((column) => have.has(column))) {
        counts[table] = { readable: false, reason: 'table_or_columns_missing' };
        continue;
      }
      await client.query('SAVEPOINT homeowner_status_count_table');
      try {
        const rows = (await client.query(spec.sql))?.rows || [];
        counts[table] = {
          readable: true,
          groups: rows.map((row) => ({
            ...Object.fromEntries(spec.columns.map((column) => [column, SAFE_LABEL_RE.test(String(row[column] ?? '')) ? String(row[column] ?? '') : 'unrecognized'])),
            count: Number(row.n) || 0,
          })),
        };
        await client.query('RELEASE SAVEPOINT homeowner_status_count_table');
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT homeowner_status_count_table');
        counts[table] = {
          readable: false,
          reason: /row-level security/i.test(String(error?.message || '')) ? 'row_security_would_filter' : 'unreadable',
        };
      }
    }
  } finally {
    // Restores row_security and discards anything the reads touched.
    await client.query('ROLLBACK TO SAVEPOINT homeowner_status_counts');
    await client.query('RELEASE SAVEPOINT homeowner_status_counts');
  }
  return ok({
    legacy_remint_signer: {
      name: HOMEOWNER_LEGACY_FUNCTION_NAME,
      present: legacy.length > 0,
      signatures: legacy.map((row) => `${row.signature} returns ${row.result}`),
      note: 'reported only; SQL 82 and SQL 83 never drop it',
    },
    status_constraints: constraints,
    status_counts: counts,
  });
}

/** Strips owner names and raw text so a staging read-live shows labels, flags, counts and hashes only. */
export function homeownerInspectSummary(state, report) {
  const functions = Object.fromEntries(Object.entries(state.functions || {}).map(([name, row]) => [name, {
    exists: row.exists,
    overload_count: row.overload_count,
    named_signatures: row.named_signatures,
    identity_arguments: row.identity_arguments,
    argument_names: row.argument_names,
    result: row.result,
    kind: row.kind,
    returns_set: row.returns_set,
    language: row.language,
    security_definer: row.security_definer,
    config: row.config,
    owner_is_executor: row.owner_is_executor,
    owner_rolsuper: row.owner_rolsuper,
    owner_rolbypassrls: row.owner_rolbypassrls,
    acl_entries: row.acl_entries,
    definition_sha256: row.definition_sha256,
    matches_migration: row.matches_migration,
    body_matches_migration: row.body_matches_migration ?? null,
    raw_endorse_token_link: row.raw_endorse_token_link,
  }]));
  return {
    migration: state.migration,
    login_rolsuper: state.login_rolsuper,
    login_rolbypassrls: state.login_rolbypassrls,
    functions,
    missing_columns: state.missing_columns,
    tables: Object.fromEntries(Object.entries(state.tables || {}).map(([name, row]) => [name, {
      present: row.present, rls_enabled: row.rls_enabled, rls_forced: row.rls_forced,
      owner_is_login: row.present ? row.owner === state.current_user : null,
    }])),
    row_security: Object.fromEntries(Object.entries(state.row_security || {}).map(([name, row]) => [name, {
      owner_rolsuper: row.owner_rolsuper, owner_rolbypassrls: row.owner_rolbypassrls, rls_tables_not_bypassed: row.rls_tables_not_bypassed,
    }])),
    row_security_off_supported: state.row_security_off_supported,
    ...(report ? {
      legacy_remint_signer: { present: report.legacy_remint_signer.present, signatures: report.legacy_remint_signer.signatures },
      status_constraints: Object.fromEntries(Object.entries(report.status_constraints).map(([table, rows]) => [table, rows.map((row) => ({
        name: row.name, definition_sha256: row.definition_sha256, allowed: row.allowed,
      }))])),
      status_counts: report.status_counts,
    } : {}),
  };
}

/**
 * Pre-apply rules shared by the staging handler and the production tool: what
 * CREATE OR REPLACE with the same signature can replace safely. A different
 * signature, a return-type or parameter-name clash, a procedure, a function
 * owned by another role or an ACL entry the files do not revoke is refused.
 */
export function homeownerPreconditionFailures(state, key) {
  const spec = HOMEOWNER_MIGRATIONS[key];
  const failures = [];
  const check = (name, passed) => { if (!passed) failures.push(name); };
  check('required_roles_present', state?.required_roles_present === true);
  check('required_tables_present', state?.required_tables_present === true);
  check('required_columns_present', state?.required_columns_present === true);
  for (const fn of spec?.functions || []) {
    const row = state?.functions?.[fn.name];
    if (!row) {
      failures.push(`state_readable:${fn.name}`);
      continue;
    }
    check(`no_other_signature:${fn.name}`, row.overload_count === (row.exists ? 1 : 0));
    if (row.exists) {
      check(`replaceable_kind:${fn.name}`, row.kind === 'f' && row.returns_set === false);
      check(`return_type_jsonb:${fn.name}`, row.result === 'jsonb');
      check(`argument_names_match:${fn.name}`, sameJson(row.argument_names, fn.arg_names));
      // pg_get_function_arguments includes defaults; CREATE OR REPLACE cannot remove one.
      check(`arguments_match:${fn.name}`, row.arguments === fn.arguments);
      check(`owner_is_login:${fn.name}`, row.owner_is_executor === true);
      check(`acl_replaceable:${fn.name}`, (row.acl_entries || []).every((line) => HOMEOWNER_REPLACEABLE_ACL_ENTRIES.includes(line)));
    }
    if (spec.row_security_off) {
      check(`row_security_off_supported:${fn.name}`, (state?.row_security?.[fn.name]?.rls_tables_not_bypassed || ['unknown']).length === 0);
    }
  }
  return failures;
}

/** Post-apply rules shared by staging and production; `reviewed` maps identity -> sha256 of the reconstructed def. */
export function homeownerPostconditionFailures(after, key, reviewed, intendedSha256) {
  const spec = HOMEOWNER_MIGRATIONS[key];
  const failures = [];
  const check = (name, passed) => { if (!passed) failures.push(name); };
  check('intended_state', typeof intendedSha256 === 'string' && after?.live_definition_sha256 === intendedSha256);
  for (const fn of spec?.functions || []) {
    const row = after?.functions?.[fn.name] || {};
    check(`definition_is_reviewed:${fn.name}`, row.exists === true && typeof reviewed?.[fn.identity] === 'string'
      && row.definition_sha256 === reviewed[fn.identity] && row.matches_migration === true);
    check(`no_overloads:${fn.name}`, row.overload_count === 1);
    check(`security_definer:${fn.name}`, row.security_definer === true);
    check(`config_as_reviewed:${fn.name}`, sameJson(row.config, fn.config));
    check(`owner_is_login:${fn.name}`, row.owner_is_executor === true);
    check(`execute_checksops_only:${fn.name}`, sameJson(row.acl_entries, HOMEOWNER_EXECUTE_GRANTEES.map((g) => `${g} EXECUTE`)));
  }
  if (spec?.row_security_off) check('row_security_off_supported', after?.row_security_off_supported === true);
  return failures;
}

/** Everything in schema public and auth except the migration's own functions. */
export async function readHomeownerSchemaSnapshot(client, identities) {
  await client.query(STAKEHOLDER_POLICY_SEARCH_PATH_SQL);
  const relations = (await client.query(HOMEOWNER_RELATIONS_SQL))?.rows || [];
  const policies = (await client.query(CHECKALT_ALL_POLICIES_SQL))?.rows || [];
  const functions = (await client.query(HOMEOWNER_OTHER_FUNCTIONS_SQL, [[...identities]]))?.rows || [];
  return {
    relations_sha256: hashSqlDefinition(relations.map((row) => JSON.stringify(row)).join('\n')),
    policies_sha256: hashSqlDefinition(policies.map((row) => JSON.stringify([
      row.table_name, row.polname, row.polcmd, row.polpermissive, row.polroles, row.polqual, row.polwithcheck,
    ])).join('\n')),
    other_functions_sha256: hashSqlDefinition(functions.map((row) => JSON.stringify([
      row.signature, row.def_sha256, row.acl, row.prosecdef, row.config, row.owner,
    ])).join('\n')),
  };
}

/**
 * Adds the function-def-lookup comparison (body, language, SECURITY DEFINER,
 * search_path) of each live definition with the one reconstructed from the file,
 * and drops the definition text. The full-definition sha256 stays authoritative.
 */
export function withHomeownerBodyComparison(state, key, text) {
  const reviewed = homeownerReviewedFunctiondefs(key, text) || {};
  for (const row of Object.values(state.functions || {})) {
    const source = reviewed[row.identity];
    row.body_matches_migration = row._def && source ? functionDefsMatchExactly(row._def, source) : null;
    delete row._def;
  }
  return state;
}

const HOMEOWNER_COMMITTED_KEYS = ['filename', 'migration_id', 'migration', 'commit', 'source_sha256', 'intended_replacement_sha256'];

/** A test may supply `pin` only as the committed pin with a reviewed expected hash filled in. */
function homeownerPinIsCommitted(pin, committed) {
  return Boolean(pin) && HOMEOWNER_COMMITTED_KEYS.every((key) => pin[key] === committed[key])
    && sameJson(pin.function_identities, committed.function_identities);
}

async function handleHomeownerMigration({ key, event, authorization, identity, connect, sqlFile, pin, committed }) {
  const spec = HOMEOWNER_MIGRATIONS[key];
  const label = spec.label;
  if (!homeownerPinIsCommitted(pin, committed)) {
    return fail(CODES.SQL_COLLISION, `${label} pin does not match the committed allowlist entry`);
  }
  const embedded = readEmbeddedSql(sqlFile, pin.source_sha256);
  if (!embedded.ok) return embedded;
  if (!homeownerSqlIsReviewed(key, embedded.details.text)) {
    return fail(CODES.UNRELATED_MUTATION, `embedded ${label} is not exactly the reviewed statements`);
  }
  const reviewed = Object.fromEntries(Object.entries(homeownerReviewedFunctiondefs(key, embedded.details.text))
    .map(([fnIdentity, def]) => [fnIdentity, hashSqlDefinition(def)]));
  const readOnly = event.action === 'inspect' || event.action === 'verify_data' || event.action === 'authorize';
  if (!readOnly && event.action !== 'apply') {
    return fail(CODES.INVALID_MANIFEST, `unsupported ${label} executor action ${event.action}`);
  }
  const pinExecutable = SQL80_SHA256_RE.test(String(pin.expected_live_definition_sha256 || ''));
  if (event.action === 'apply' && !pinExecutable) {
    return fail(CODES.SQL_COLLISION, `${label} pin has no reviewed pre-apply live definition hash yet; apply is refused`);
  }
  if (event.action === 'apply' && !(
    event.filename === pin.filename
    && event.migration_id === pin.migration_id
    && event.source_sha256 === pin.source_sha256
    && event.intended_replacement_sha256 === pin.intended_replacement_sha256
    && event.expected_live_definition_sha256 === pin.expected_live_definition_sha256
    && event.commit === pin.commit
  )) {
    return fail(CODES.SQL_COLLISION, `${label} apply is bound to the exact allowlisted pin`);
  }

  let client;
  let inTx = false;
  const rollback = async () => {
    if (inTx) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    }
    inTx = false;
  };
  const identities = spec.functions.map((fn) => fn.identity);
  try {
    client = await connect();
    if (readOnly) {
      await client.query('BEGIN READ ONLY');
      inTx = true;
      const state = await readHomeownerState(client, key);
      const report = state.ok ? await readHomeownerReport(client).catch(() => null) : null;
      await rollback();
      if (!state.ok) return state;
      withHomeownerBodyComparison(state.details, key, embedded.details.text);
      const failures = homeownerPreconditionFailures(state.details, key);
      const live = state.details.live_definition_sha256;
      const alreadyApplied = live === pin.intended_replacement_sha256;
      return ok({
        authorization: authorization.details,
        receipt: {
          workstream: event.workstream_id,
          commit: event.commit,
          sql_file: event.filename,
          before_hash: live,
          after_hash: live,
          result: event.action,
          executor_identity: identity,
          migration: key,
          exists: state.details.exists,
          overload_count: state.details.overload_count,
          security_definer: state.details.security_definer,
          config_as_reviewed: state.details.config_as_reviewed,
          owner_is_executor: state.details.owner_is_executor,
          acl_as_expected: state.details.acl_as_expected,
          acl_sha256: state.details.acl_sha256,
          function_states: state.details.function_states,
          required_roles_present: state.details.required_roles_present,
          required_tables_present: state.details.required_tables_present,
          required_columns_present: state.details.required_columns_present,
          live_definition_sha256: live,
          already_applied: alreadyApplied,
          precondition_failures: failures,
          prerequisites_ok: failures.length === 0,
          pin_executable: pinExecutable,
          apply_preconditions_met: pinExecutable
            && live === pin.expected_live_definition_sha256
            && !alreadyApplied
            && failures.length === 0,
          homeowner_inspect: homeownerInspectSummary(state.details, report?.ok ? report.details : null),
        },
      });
    }

    await client.query('BEGIN');
    inTx = true;
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${key}_homeowner_functions`]);
    if (isConsumed(event.one_use_id)) {
      await rollback();
      return fail(CODES.SQL_COLLISION, 'one_use_id has already been consumed; replay is forbidden', {
        one_use_id: event.one_use_id,
      });
    }
    const before = await readHomeownerState(client, key);
    if (!before.ok) {
      await rollback();
      return before;
    }
    if (before.details.live_definition_sha256 === pin.intended_replacement_sha256) {
      await rollback();
      return fail(CODES.UNRELATED_MUTATION, `the ${label} functions are already in place; refuse re-apply`, {
        function_states: before.details.function_states,
      });
    }
    const preFailures = homeownerPreconditionFailures(before.details, key);
    if (preFailures.length) {
      await rollback();
      return fail(CODES.DEPLOYMENT_COLLISION, `${label} cannot replace the live functions safely (same signature, jsonb result, same parameter names, owned by the executor role, only PUBLIC/authenticated/checksops EXECUTE${spec.row_security_off ? ', row_security = off supported' : ''}; roles, tables and columns present)`, {
        failed: preFailures,
        function_states: before.details.function_states,
      });
    }
    if (before.details.live_definition_sha256 !== pin.expected_live_definition_sha256
      || before.details.live_definition_sha256 !== event.expected_live_definition_sha256) {
      await rollback();
      return fail(CODES.DEPLOYMENT_COLLISION, `${label} live state is not the pinned pre-apply state`, {
        function_states: before.details.function_states,
        live_definition_sha256: before.details.live_definition_sha256,
      });
    }
    const schemaBefore = await readHomeownerSchemaSnapshot(client, identities);

    await client.query(embedded.details.text);

    const after = await readHomeownerState(client, key);
    if (!after.ok) {
      await rollback();
      return after;
    }
    const schemaAfter = await readHomeownerSchemaSnapshot(client, identities);
    const postFailures = homeownerPostconditionFailures(after.details, key, reviewed, pin.intended_replacement_sha256);
    const unrelated = Object.keys(schemaBefore).filter((name) => schemaBefore[name] !== schemaAfter[name]);
    if (postFailures.length || unrelated.length) {
      await rollback();
      return fail(CODES.UNRELATED_MUTATION, `${label} did not land exactly on the reviewed functions and grants, or changed something else`, {
        failed: postFailures,
        unrelated_changed: unrelated,
        after_hash: after.details.live_definition_sha256,
        function_states: after.details.function_states,
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
        migration: key,
        function_states: after.details.function_states,
        acl_sha256: after.details.acl_sha256,
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
// api_role_owns_connect: the API role (checksops) owns connect or is a member of
// its owner. The SQL 76 guard trusts connect's owner, so that must be false.
const PARTNERSHIP_CONNECT_SQL = `
SELECT p.prosrc, p.prosecdef, p.proconfig::text[] AS proconfig,
  CASE WHEN to_regrole('checksops') IS NULL THEN NULL
       ELSE pg_has_role('checksops', p.proowner, 'MEMBER') END AS api_role_owns_connect
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
  ...PARTNERSHIP_RETIRED_POLICIES.map((name) => new RegExp(`^DROP POLICY IF EXISTS "${name}" ON public\\.tenant_partnerships$`)),
]);
// sha256 of each aws_connect_partner_by_code row write as PG_CONTEXT prints it
// (the SQL 32 statement text without INTO _existing): reactivate, create, and
// the reactivate in the unique_violation retry. A test re-derives them from SQL 32.
export const SQL76_CONNECT_WRITE_STATEMENT_SHA256 = Object.freeze([
  'c8fc47f91e83fcf246df089dc86d9a1f91d7dfc14196f5d77e0a393920bcfd48',
  'd5f42d0e619e1c484f63e71077e27c6cbcbf7b5bd8d279d65f6a3b6192f6e414',
  '993e0708fac80457d614485ba16be98a6869ceb9b74bca9200eb6db16b803867',
]);
const SQL76_BODY_REQUIRED_MARKERS = [
  'GET DIAGNOSTICS _ctx = PG_CONTEXT;',
  `_stmt := substring(_ctx from E'^PL/pgSQL function aws_tenant_partnership_consent_guard\\\\(\\\\) line [0-9]+ at GET DIAGNOSTICS\\nSQL statement "([^"]*)"\\nPL/pgSQL function aws_connect_partner_by_code\\\\(text,uuid\\\\) line [0-9]+ at SQL statement(?:\\n|$)');`,
  // Exactly these three hashes, no more.
  `encode(pg_catalog.sha256(convert_to(_stmt, 'UTF8')), 'hex') IN (\n${SQL76_CONNECT_WRITE_STATEMENT_SHA256.map((hash) => `      '${hash}'`).join(',\n')}\n    )\n`,
  'AND current_user = (',
  'SELECT pg_catalog.pg_get_userbyid(p.proowner)',
  "WHERE p.oid = pg_catalog.to_regprocedure('public.aws_connect_partner_by_code(text, uuid)')",
  'NEW.invitee_tenant_id IN (SELECT public.aws_user_tenant_ids())',
  'COALESCE(public.aws_can_write_tenant(NEW.invitee_tenant_id), false)',
  "RAISE EXCEPTION 'partnership_invitee_consent_required' USING ERRCODE = '42501'",
  "RAISE EXCEPTION 'partnership_tenants_immutable' USING ERRCODE = '42501'",
  'RETURN NEW;',
];
const SQL76_BODY_FORBIDDEN = [
  /\bEXECUTE\b/i,
  /set_config/i,
  // The trusted writer comes from PG_CONTEXT and the connect owner, never a setting.
  /current_setting/i,
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
    && row.api_role_owns_connect === false
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
  // policy and trigger on it, and aws_connect_partner_by_code apart from any marker entry.
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
      return fail(CODES.UNRELATED_MUTATION, 'SQL 76 changed more than the consent guard and the five retired policies', {
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
  sqlFile77 = SQL77_CHECK_STAKEHOLDERS_GRANT_FILE,
  sql77Pin = AUTHORIZED_SQL77_CHECK_STAKEHOLDERS_GRANT,
  sqlFile78 = SQL78_PARTNER_STAKEHOLDER_REMOVALS_FILE,
  sql78Pin = AUTHORIZED_SQL78_PARTNER_STAKEHOLDER_REMOVALS,
  sqlFile79 = SQL79_MEMBER_STAKEHOLDER_WRITES_FILE,
  sql79Pin = AUTHORIZED_SQL79_MEMBER_STAKEHOLDER_WRITES,
  sqlFile80 = SQL80_CHECKALT_MEMBER_AUTO_DEPOSIT_FILE,
  sql80Pin = AUTHORIZED_SQL80_CHECKALT_MEMBER_AUTO_DEPOSIT,
  sqlFile81 = SQL81_CHECKALT_PRODUCTION_REGISTER_FILE,
  sql81Pin = AUTHORIZED_SQL81_CHECKALT_PRODUCTION_REGISTER,
  sqlFile82 = SQL82_HOMEOWNER_LEDGER_VIEW_FILE,
  sql82Pin = AUTHORIZED_SQL82_HOMEOWNER_LEDGER_VIEW,
  sqlFile83 = SQL83_HOMEOWNER_SIGNING_CAPABILITIES_FILE,
  sql83Pin = AUTHORIZED_SQL83_HOMEOWNER_SIGNING_CAPABILITIES,
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

    if (isSql77CheckStakeholdersGrant(event)) {
      return handleSql77CheckStakeholdersGrant({ event, authorization, identity, connect, sqlFile77, pin: sql77Pin });
    }

    if (isSql78PartnerStakeholderRemovals(event)) {
      return handleSql78PartnerStakeholderRemovals({ event, authorization, identity, connect, sqlFile78, pin: sql78Pin });
    }

    if (isSql79MemberStakeholderWrites(event)) {
      return handleSql79MemberStakeholderWrites({ event, authorization, identity, connect, sqlFile79, pin: sql79Pin });
    }

    if (isSql80CheckaltMemberAutoDeposit(event)) {
      return handleSql80CheckaltMemberAutoDeposit({ event, authorization, identity, connect, sqlFile80, pin: sql80Pin });
    }

    if (isSql81CheckaltProductionRegister(event)) {
      return handleSql81CheckaltProductionRegister({ event, authorization, identity, connect, sqlFile81, pin: sql81Pin });
    }

    if (isSql82HomeownerLedgerView(event)) {
      return handleHomeownerMigration({
        key: 'sql82', event, authorization, identity, connect, sqlFile: sqlFile82, pin: sql82Pin, committed: AUTHORIZED_SQL82_HOMEOWNER_LEDGER_VIEW,
      });
    }

    if (isSql83HomeownerSigningCapabilities(event)) {
      return handleHomeownerMigration({
        key: 'sql83', event, authorization, identity, connect, sqlFile: sqlFile83, pin: sql83Pin, committed: AUTHORIZED_SQL83_HOMEOWNER_SIGNING_CAPABILITIES,
      });
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
