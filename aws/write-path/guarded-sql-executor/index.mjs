/**
 * Staging-only VPC SQL executor for the reviewed Claim Ledger SQL 44.
 * Fail closed. No arbitrary SQL. No create_new. No production.
 * CREATE OR REPLACE must not invoke the function.
 *
 * Forward-composed from the live staging executor. Preserves SQL 44,
 * #601, membership-only, Mortgage Ops SQL 39, SQL 71, SQL 72, SQL 73,
 * and SQL 74. Adds only SQL 75 check_files.signature_request_id column grant.
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
  AUTHORIZED_SQL71,
  AUTHORIZED_SQL72,
  AUTHORIZED_SQL73,
  AUTHORIZED_SQL74,
  AUTHORIZED_SQL75,
  AUTHORIZED_TENANT_USERS_SAME_CHECK_PERMISSIONS,
  AUTHORIZED_MEMBERSHIP_ONLY,
  SQL_EXECUTOR_FUNCTION,
  evaluateSqlExecutorAuthorization,
  isHomeownerLedgerViewClaimOk,
  isHomeownerLedgerViewContract,
  isHomeownerLedgerViewLastViewedBestEffort,
  isHomeownerSigningRlsBoundary,
  isSignatureRequestCheckFilesLinkGrant,
  isMembershipOnlyHelper,
  isMortgageOpsAcceptComplete,
  isTenantUsersSameCheckPermissions,
} from './lib/sql-executor-auth.mjs';
import { handleMortgageOpsAcceptComplete } from './mortgage-ops-sql39.mjs';

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
const MEMBERSHIP_ONLY_SQL_FILE = path.join(
  ROOT,
  'sql/20261002200000_user_can_move_tenant_checks_membership_only.sql',
);
const MORTGAGE_OPS_SQL_FILE = path.join(
  ROOT,
  'sql/39_mortgage_ops_agent_accept_complete.sql',
);
const SQL71_FILE = path.join(ROOT, 'sql/71_homeowner_ledger_view_contract.sql');
const SQL72_FILE = path.join(ROOT, 'sql/72_homeowner_ledger_view_claim_ok.sql');
const SQL73_FILE = path.join(ROOT, 'sql/73_homeowner_ledger_view_last_viewed_best_effort.sql');
const SQL74_FILE = path.join(ROOT, 'sql/74_homeowner_signing_rls_boundary.sql');
const SQL75_FILE = path.join(ROOT, 'sql/75_signature_request_check_files_link_grant.sql');
const SQL74_BEHAVIOR_MARKERS = [
  'aws_public_homeowner_ledger_endorse_capability',
  'aws_public_homeowner_pending_signatures',
  'aws_public_homeowner_document_sign_capability',
  'existing_email_link_required',
  "payee_type IS DISTINCT FROM 'insured'",
  "lower(COALESCE(s.signer_type, '')) IN ('policyholder', 'insured', 'homeowner')",
];
const SQL71_BEHAVIOR_MARKERS = [
  "mode', 'claim'",
  "mode', 'pre_claim'",
  'pending_signatures',
  "'money', NULL",
  "payee_type IN ('insured', 'mortgage_company')",
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

function helperInspect(live = {}) {
  const move = String(live.user_can_move_tenant_checks || '');
  const override = String(live.admin_override_check_status || '');
  return {
    user_can_move_tenant_checks_sha256: move ? hashSqlDefinition(move) : null,
    admin_override_check_status_sha256: override ? hashSqlDefinition(override) : null,
    user_can_move_has_role: move.includes('has_role'),
    user_can_move_membership_only: Boolean(
      move
      && move.includes('user_belongs_to_tenant')
      && !move.includes('has_role'),
    ),
  };
}

async function handleMembershipOnlyHelper({
  event,
  authorization,
  identity,
  connect,
  sqlFile,
}) {
  const embedded = readEmbeddedSql(sqlFile, AUTHORIZED_MEMBERSHIP_ONLY.source_sha256);
  if (!embedded.ok) return embedded;
  const text = embedded.details.text;
  if (/\bGRANT\b/i.test(text) || /\bREVOKE\b/i.test(text) || /\bPOLICY\b/i.test(text)) {
    return fail(CODES.UNRELATED_MUTATION, 'membership-only helper SQL must not change grants or RLS');
  }
  if (/admin_override_check_status/i.test(text)) {
    return fail(CODES.UNRELATED_MUTATION, 'membership-only helper SQL must not replace admin_override_check_status');
  }

  let client;
  try {
    client = await connect();
    const liveLookup = await readTenantPermissionDefs(client);
    if (!liveLookup.ok) return liveLookup;
    const live = liveLookup.details;
    const liveHash = hashTenantPermissionLiveDefs(live);
    const inspect = helperInspect(live);
    if (
      event.expected_live_definition_sha256
      && event.expected_live_definition_sha256 !== liveHash
    ) {
      return fail(CODES.SQL_COLLISION, 'live tenant-permission function definitions differ from the expected baseline', {
        expected_live_definition_sha256: event.expected_live_definition_sha256,
        live_definition_sha256: liveHash,
        ...inspect,
      });
    }

    const intendedMove = extractPinnedFunctionSql(text, 'user_can_move_tenant_checks');
    const helperExact = Boolean(
      intendedMove
      && live.user_can_move_tenant_checks
      && functionDefsMatchExactly(live.user_can_move_tenant_checks, intendedMove),
    );

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
          helper_exact: helperExact,
          ...inspect,
        },
      });
    }

    if (event.action !== 'apply') {
      return fail(CODES.INVALID_MANIFEST, `unsupported membership-only executor action ${event.action}`);
    }

    if (!live.admin_override_check_status) {
      return fail(CODES.SQL_COLLISION, 'admin_override_check_status is missing; refuse helper-only apply');
    }

    if (helperExact) {
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
          admin_override_unchanged: true,
          ...inspect,
        },
      });
    }

    const overrideBefore = hashSqlDefinition(live.admin_override_check_status);
    await client.query(text);
    const afterLookup = await readTenantPermissionDefs(client);
    if (!afterLookup.ok) return afterLookup;
    const after = afterLookup.details;
    const afterHash = hashTenantPermissionLiveDefs(after);
    const afterInspect = helperInspect(after);
    if (!after.user_can_move_tenant_checks || !after.admin_override_check_status) {
      return fail(CODES.SQL_COLLISION, 'apply did not keep both #601 functions');
    }
    if (hashSqlDefinition(after.admin_override_check_status) !== overrideBefore) {
      return fail(CODES.SQL_COLLISION, 'admin_override_check_status definition changed; STOP');
    }
    if (!functionDefsMatchExactly(after.user_can_move_tenant_checks, intendedMove)) {
      return fail(CODES.SQL_COLLISION, 'applied helper does not match the membership-only source');
    }
    if (afterInspect.user_can_move_has_role || !afterInspect.user_can_move_membership_only) {
      return fail(CODES.SQL_COLLISION, 'applied helper is not membership-only');
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
        admin_override_unchanged: true,
        before: inspect,
        after: afterInspect,
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


function sql71DefinitionMatchesSourceBehavior(def) {
  if (!def) return false;
  return SQL71_BEHAVIOR_MARKERS.every((marker) => def.includes(marker));
}

async function readSql71Grants(client) {
  const routine = await client.query(`
    SELECT grantee, privilege_type
    FROM information_schema.routine_privileges
    WHERE routine_schema = 'public'
      AND routine_name = 'aws_public_homeowner_ledger_by_token'
    ORDER BY grantee, privilege_type
  `);
  return { routine: routine.rows };
}

function sql73DefinitionMatchesSourceBehavior(def) {
  if (!sql71DefinitionMatchesSourceBehavior(def)) return false;
  return def.includes('check_stage::text')
    && def.includes('EXCEPTION')
    && def.includes('last_viewed_at')
    && def.includes("c.org_id = tok.tenant_id")
    && !def.includes('c.org_id IS NULL');
}

function sql74SourceMatchesBehavior(text) {
  if (!text) return false;
  return SQL74_BEHAVIOR_MARKERS.every((marker) => text.includes(marker))
    && text.includes('SET search_path = public')
    && text.includes('SECURITY DEFINER')
    && text.includes('GRANT EXECUTE ON FUNCTION public.aws_public_homeowner_ledger_endorse_capability(text, uuid) TO checksops')
    && text.includes('GRANT EXECUTE ON FUNCTION public.aws_public_homeowner_pending_signatures(text) TO checksops')
    && text.includes('GRANT EXECUTE ON FUNCTION public.aws_public_homeowner_document_sign_capability(text, uuid) TO checksops')
    && !text.includes('CREATE TABLE')
    && !text.includes('ENABLE ROW LEVEL SECURITY')
    && !text.includes('GRANT SELECT ON TABLE')
    && !text.includes('UPDATE public.signature_signers')
    && !text.includes('SET token_hash');
}

async function readSql74Grants(client) {
  const routine = await client.query(`
    SELECT routine_name, grantee, privilege_type
    FROM information_schema.routine_privileges
    WHERE routine_schema = 'public'
      AND routine_name IN (
        'aws_public_homeowner_ledger_endorse_capability',
        'aws_public_homeowner_pending_signatures',
        'aws_public_homeowner_document_sign_capability',
        'aws_public_homeowner_ledger_by_token'
      )
    ORDER BY routine_name, grantee, privilege_type
  `);
  return { routine: routine.rows };
}

function sql74GrantsConstrained(grants) {
  const genericGrantees = new Set(['PUBLIC', 'authenticated', 'anon']);
  const execute = (grants.routine || []).filter((row) => row.privilege_type === 'EXECUTE');
  const badRoutine = execute.filter((row) => genericGrantees.has(row.grantee));
  const required = [
    'aws_public_homeowner_ledger_endorse_capability',
    'aws_public_homeowner_pending_signatures',
    'aws_public_homeowner_document_sign_capability',
    'aws_public_homeowner_ledger_by_token',
  ];
  const missingChecksops = required.filter((name) => (
    !execute.some((row) => row.routine_name === name && row.grantee === 'checksops')
  ));
  if (badRoutine.length || missingChecksops.length) {
    return fail(CODES.UNRELATED_MUTATION, 'SQL 74 grants are not constrained', {
      bad_routine: badRoutine,
      missing_checksops: missingChecksops,
    });
  }
  return ok({ grants_constrained: true, checksops_execute: true });
}

async function handleHomeownerSigningRlsBoundary({
  event,
  authorization,
  identity,
  connect,
  sqlFile74,
  expectedLiveDefinitionSha256 = AUTHORIZED_SQL74.expected_live_definition_sha256,
}) {
  if (event.expected_live_definition_sha256 !== expectedLiveDefinitionSha256) {
    return fail(CODES.SQL_COLLISION, 'SQL 74 authority requires the current live SQL 73 definition hash', {
      expected_live_definition_sha256: event.expected_live_definition_sha256 || null,
      required_live_definition_sha256: expectedLiveDefinitionSha256,
    });
  }

  const embedded = readEmbeddedSql(sqlFile74, AUTHORIZED_SQL74.source_sha256);
  if (!embedded.ok) return embedded;
  if (!sql74SourceMatchesBehavior(embedded.details.text)) {
    return fail(CODES.SQL_COLLISION, 'embedded SQL 74 does not match intended sibling-definer behavior');
  }

  let client;
  try {
    client = await connect();
    const sql73Lookup = await definitionTextOrFail(client, AUTHORIZED_SQL74.sql73_function_identity);
    if (!sql73Lookup.ok) return sql73Lookup;
    const sql73BeforeDef = sql73Lookup.details.definition;
    const sql73BeforeHash = sql73BeforeDef ? hashSqlDefinition(sql73BeforeDef) : null;
    const sql44Lookup = await definitionTextOrFail(client, AUTHORIZED_SQL44.function_identity);
    if (!sql44Lookup.ok) return sql44Lookup;
    const sql44BeforeHash = sql44Lookup.details.definition
      ? hashSqlDefinition(sql44Lookup.details.definition)
      : null;

    const beforeNew = {};
    for (const identityName of AUTHORIZED_SQL74.function_identities) {
      const lookup = await definitionTextOrFail(client, identityName);
      if (!lookup.ok) return lookup;
      beforeNew[identityName] = lookup.details.definition
        ? hashSqlDefinition(lookup.details.definition)
        : null;
    }

    if (event.action === 'inspect' || event.action === 'verify_data' || event.action === 'authorize') {
      if (event.inspect?.token || event.verify?.token) {
        return fail(CODES.UNRELATED_MUTATION, 'SQL 74 inspect/verify must not invoke the public token RPC');
      }
      return ok({
        authorization: authorization.details,
        receipt: {
          workstream: event.workstream_id,
          commit: event.commit,
          sql_file: event.filename,
          before_hash: sql73BeforeHash,
          after_hash: sql73BeforeHash,
          result: event.action,
          executor_identity: identity,
          function_identities: AUTHORIZED_SQL74.function_identities,
          sql73_hash: sql73BeforeHash,
          sql44_hash: sql44BeforeHash,
          required_live_definition_sha256: expectedLiveDefinitionSha256,
        },
      });
    }

    if (event.action !== 'apply') {
      return fail(CODES.INVALID_MANIFEST, `unsupported SQL 74 executor action ${event.action}`);
    }

    if (sql73BeforeHash !== expectedLiveDefinitionSha256) {
      return fail(CODES.SQL_COLLISION, 'live SQL 73 definition drifted; SQL 74 apply refused', {
        expected_live_definition_sha256: expectedLiveDefinitionSha256,
        live_definition_sha256: sql73BeforeHash,
      });
    }

    const collision = evaluateSqlCollision({
      filename: event.filename,
      migration_id: event.migration_id,
      source_sha256: event.source_sha256,
      target_environment: 'staging',
      expected_live_definition_sha256: event.expected_live_definition_sha256,
      live_definition_sha256: sql73BeforeHash,
      live_definition: sql73BeforeDef,
    });
    if (!collision.ok) return collision;

    await client.query(embedded.details.text);

    const sql73AfterLookup = await definitionTextOrFail(client, AUTHORIZED_SQL74.sql73_function_identity);
    if (!sql73AfterLookup.ok) return sql73AfterLookup;
    const sql73AfterHash = sql73AfterLookup.details.definition
      ? hashSqlDefinition(sql73AfterLookup.details.definition)
      : null;
    if (sql73AfterHash !== sql73BeforeHash || sql73AfterHash !== expectedLiveDefinitionSha256) {
      return fail(CODES.SQL_COLLISION, 'SQL 74 apply changed the live SQL 73 definition; STOP', {
        expected: expectedLiveDefinitionSha256,
        live: sql73AfterHash,
      });
    }
    if (!sql73DefinitionMatchesSourceBehavior(sql73AfterLookup.details.definition)) {
      return fail(CODES.SQL_COLLISION, 'SQL 73 behavior markers changed during SQL 74 apply; STOP');
    }

    const afterNew = {};
    for (const identityName of AUTHORIZED_SQL74.function_identities) {
      const lookup = await definitionTextOrFail(client, identityName);
      if (!lookup.ok) return lookup;
      if (!lookup.details.definition) {
        return fail(CODES.SQL_COLLISION, 'SQL 74 apply did not create a required sibling function', {
          function_identity: identityName,
        });
      }
      afterNew[identityName] = hashSqlDefinition(lookup.details.definition);
    }

    const grants = sql74GrantsConstrained(await readSql74Grants(client));
    if (!grants.ok) return grants;

    const sql44AfterLookup = await definitionTextOrFail(client, AUTHORIZED_SQL44.function_identity);
    if (!sql44AfterLookup.ok) return sql44AfterLookup;
    const sql44AfterHash = sql44AfterLookup.details.definition
      ? hashSqlDefinition(sql44AfterLookup.details.definition)
      : null;
    if (sql44AfterHash !== sql44BeforeHash) {
      return fail(CODES.SQL_COLLISION, 'SQL 74 apply changed the live SQL 44 definition; STOP', {
        expected: sql44BeforeHash,
        live: sql44AfterHash,
      });
    }

    consumeOneUse(event.one_use_id);
    return ok({
      receipt: {
        workstream: event.workstream_id,
        commit: event.commit,
        sql_file: event.filename,
        before_hash: sql73BeforeHash,
        after_hash: sql73AfterHash,
        result: 'applied',
        executor_identity: identity,
        function_identities: AUTHORIZED_SQL74.function_identities,
        new_function_hashes: afterNew,
        prior_function_hashes: beforeNew,
        sql73_hash: sql73AfterHash,
        sql44_hash: sql44AfterHash,
        required_live_definition_sha256: expectedLiveDefinitionSha256,
      },
      grants: grants.details,
    });
  } catch (error) {
    return fail(CODES.UNRELATED_MUTATION, String(error?.message || error).slice(0, 400));
  } finally {
    if (client) {
      try { await client.end(); } catch { /* ignore */ }
    }
  }
}

function sql75SourceMatchesBehavior(text) {
  if (!text) return false;
  return text.includes('GRANT UPDATE (signature_request_id) ON TABLE public.check_files TO checksops, authenticated;')
    && text.includes('aws_write_check_files')
    && text.includes('aws_can_write_check(check_intake_item_id)')
    && !text.includes('GRANT UPDATE ON TABLE public.check_files')
    && !text.includes('GRANT ALL ON TABLE public.check_files')
    && !text.includes('CREATE POLICY')
    && !text.includes('DROP POLICY')
    && !text.includes('ENABLE ROW LEVEL SECURITY')
    && !text.includes('CREATE OR REPLACE FUNCTION')
    && !text.includes('TO PUBLIC')
    && !text.includes('TO anon');
}

const CHECK_FILES_CATALOG_SQL = `
SELECT jsonb_build_object(
  'table_grants', (
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'grantee', grantee, 'privilege', privilege_type
    ) ORDER BY grantee, privilege_type), '[]'::jsonb)
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'check_files'
      AND grantee IN ('checksops', 'authenticated', 'PUBLIC', 'anon')
  ),
  'column_update_grants', (
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'grantee', grantee, 'column', column_name
    ) ORDER BY grantee, column_name), '[]'::jsonb)
    FROM information_schema.column_privileges
    WHERE table_schema = 'public' AND table_name = 'check_files'
      AND privilege_type = 'UPDATE'
      AND grantee IN ('checksops', 'authenticated', 'PUBLIC', 'anon')
  ),
  'rls', (
    SELECT jsonb_build_object(
      'relrowsecurity', c.relrowsecurity,
      'relforcerowsecurity', c.relforcerowsecurity
    )
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'check_files'
  ),
  'policies', (
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'policyname', policyname, 'cmd', cmd, 'roles', roles, 'qual', qual, 'with_check', with_check
    ) ORDER BY policyname), '[]'::jsonb)
    FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'check_files'
  )
) AS catalog
`;

function sql75GrantsConstrained(catalog) {
  const tableGrants = catalog?.table_grants || [];
  const columnGrants = catalog?.column_update_grants || [];
  const tableUpdate = tableGrants.filter((row) => row.privilege === 'UPDATE');
  const extraColumns = columnGrants.filter((row) => row.column !== 'signature_request_id');
  const publicOrAnon = [
    ...tableGrants.filter((row) => row.grantee === 'PUBLIC' || row.grantee === 'anon'),
    ...columnGrants.filter((row) => row.grantee === 'PUBLIC' || row.grantee === 'anon'),
  ];
  const hasChecksopsCol = columnGrants.some((row) => row.grantee === 'checksops' && row.column === 'signature_request_id');
  const hasAuthenticatedCol = columnGrants.some((row) => row.grantee === 'authenticated' && row.column === 'signature_request_id');
  const writePolicy = (catalog?.policies || []).find((row) => row.policyname === 'aws_write_check_files');
  if (tableUpdate.length || extraColumns.length || publicOrAnon.length || !hasChecksopsCol || !hasAuthenticatedCol) {
    return fail(CODES.UNRELATED_MUTATION, 'SQL 75 check_files grants are not constrained to signature_request_id', {
      table_update: tableUpdate,
      extra_columns: extraColumns,
      public_or_anon: publicOrAnon,
      has_checksops_column: hasChecksopsCol,
      has_authenticated_column: hasAuthenticatedCol,
    });
  }
  if (!writePolicy || !String(writePolicy.qual || '').includes('aws_can_write_check')) {
    return fail(CODES.SQL_COLLISION, 'aws_write_check_files authorization boundary is missing after SQL 75', {
      policy: writePolicy || null,
    });
  }
  return ok({
    grants_constrained: true,
    column: 'signature_request_id',
    checksops_update: true,
    authenticated_update: true,
    table_wide_update: false,
    policy: writePolicy.policyname,
  });
}

function hashCheckFilesCatalog(catalog) {
  return hashSqlDefinition(JSON.stringify(catalog || {}));
}

async function readCheckFilesCatalog(client) {
  const rows = (await client.query(CHECK_FILES_CATALOG_SQL)).rows;
  return rows[0]?.catalog || {};
}

async function handleSignatureRequestCheckFilesLinkGrant({
  event,
  authorization,
  identity,
  connect,
  sqlFile75,
  expectedLiveDefinitionSha256 = AUTHORIZED_SQL75.expected_live_definition_sha256,
}) {
  if (event.expected_live_definition_sha256 !== AUTHORIZED_SQL75.expected_live_definition_sha256) {
    return fail(CODES.SQL_COLLISION, 'SQL 75 authority requires the current live SQL 73 definition hash', {
      expected_live_definition_sha256: event.expected_live_definition_sha256 || null,
      required_live_definition_sha256: AUTHORIZED_SQL75.expected_live_definition_sha256,
    });
  }

  const embedded = readEmbeddedSql(sqlFile75, AUTHORIZED_SQL75.source_sha256);
  if (!embedded.ok) return embedded;
  if (!sql75SourceMatchesBehavior(embedded.details.text)) {
    return fail(CODES.SQL_COLLISION, 'embedded SQL 75 does not match the column-scoped check_files grant');
  }

  let client;
  try {
    client = await connect();
    const sql73Lookup = await definitionTextOrFail(client, AUTHORIZED_SQL75.sql73_function_identity);
    if (!sql73Lookup.ok) return sql73Lookup;
    const sql73BeforeDef = sql73Lookup.details.definition;
    const sql73BeforeHash = sql73BeforeDef ? hashSqlDefinition(sql73BeforeDef) : null;

    const sql74Before = {};
    for (const identityName of AUTHORIZED_SQL75.sql74_function_identities) {
      const lookup = await definitionTextOrFail(client, identityName);
      if (!lookup.ok) return lookup;
      sql74Before[identityName] = lookup.details.definition
        ? hashSqlDefinition(lookup.details.definition)
        : null;
    }

    const catalogBefore = await readCheckFilesCatalog(client);
    const catalogBeforeHash = hashCheckFilesCatalog(catalogBefore);
    const policyBefore = (catalogBefore.policies || []).find((row) => row.policyname === 'aws_write_check_files') || null;

    if (event.action === 'inspect' || event.action === 'verify_data' || event.action === 'authorize') {
      if (event.inspect?.token || event.verify?.token) {
        return fail(CODES.UNRELATED_MUTATION, 'SQL 75 inspect/verify must not invoke a public token RPC');
      }
      return ok({
        authorization: authorization.details,
        receipt: {
          workstream: event.workstream_id,
          commit: event.commit,
          sql_file: event.filename,
          before_hash: catalogBeforeHash,
          after_hash: catalogBeforeHash,
          result: event.action,
          executor_identity: identity,
          sql73_hash: sql73BeforeHash,
          sql74_hashes: sql74Before,
          required_live_definition_sha256: expectedLiveDefinitionSha256,
          check_files_catalog: catalogBefore,
          aws_write_check_files: policyBefore,
        },
      });
    }

    if (event.action !== 'apply') {
      return fail(CODES.INVALID_MANIFEST, `unsupported SQL 75 executor action ${event.action}`);
    }

    if (sql73BeforeHash !== expectedLiveDefinitionSha256) {
      return fail(CODES.SQL_COLLISION, 'live SQL 73 definition drifted; SQL 75 apply refused', {
        expected_live_definition_sha256: expectedLiveDefinitionSha256,
        live_definition_sha256: sql73BeforeHash,
      });
    }
    if (!policyBefore || !String(policyBefore.qual || '').includes('aws_can_write_check')) {
      return fail(CODES.SQL_COLLISION, 'aws_write_check_files is missing or drifted; SQL 75 apply refused', {
        policy: policyBefore,
      });
    }

    const collision = evaluateSqlCollision({
      filename: event.filename,
      migration_id: event.migration_id,
      source_sha256: event.source_sha256,
      target_environment: 'staging',
      expected_live_definition_sha256: expectedLiveDefinitionSha256,
      live_definition_sha256: sql73BeforeHash,
      live_definition: sql73BeforeDef,
    });
    if (!collision.ok) return collision;

    await client.query(embedded.details.text);

    const sql73AfterLookup = await definitionTextOrFail(client, AUTHORIZED_SQL75.sql73_function_identity);
    if (!sql73AfterLookup.ok) return sql73AfterLookup;
    const sql73AfterHash = sql73AfterLookup.details.definition
      ? hashSqlDefinition(sql73AfterLookup.details.definition)
      : null;
    if (sql73AfterHash !== sql73BeforeHash || sql73AfterHash !== expectedLiveDefinitionSha256) {
      return fail(CODES.SQL_COLLISION, 'SQL 75 apply changed the live SQL 73 definition; STOP', {
        expected: expectedLiveDefinitionSha256,
        live: sql73AfterHash,
      });
    }

    const sql74After = {};
    for (const identityName of AUTHORIZED_SQL75.sql74_function_identities) {
      const lookup = await definitionTextOrFail(client, identityName);
      if (!lookup.ok) return lookup;
      sql74After[identityName] = lookup.details.definition
        ? hashSqlDefinition(lookup.details.definition)
        : null;
      if (sql74After[identityName] !== sql74Before[identityName]) {
        return fail(CODES.SQL_COLLISION, 'SQL 75 apply changed a live SQL 74 definition; STOP', {
          function_identity: identityName,
          expected: sql74Before[identityName],
          live: sql74After[identityName],
        });
      }
    }

    const catalogAfter = await readCheckFilesCatalog(client);
    const policyAfter = (catalogAfter.policies || []).find((row) => row.policyname === 'aws_write_check_files') || null;
    if (JSON.stringify(policyAfter) !== JSON.stringify(policyBefore)) {
      return fail(CODES.SQL_COLLISION, 'SQL 75 apply changed aws_write_check_files; STOP', {
        before: policyBefore,
        after: policyAfter,
      });
    }
    const grants = sql75GrantsConstrained(catalogAfter);
    if (!grants.ok) return grants;

    consumeOneUse(event.one_use_id);
    return ok({
      receipt: {
        workstream: event.workstream_id,
        commit: event.commit,
        sql_file: event.filename,
        before_hash: catalogBeforeHash,
        after_hash: hashCheckFilesCatalog(catalogAfter),
        result: 'applied',
        executor_identity: identity,
        sql73_hash: sql73AfterHash,
        sql74_hashes: sql74After,
        required_live_definition_sha256: expectedLiveDefinitionSha256,
        check_files_catalog_before: catalogBefore,
        check_files_catalog_after: catalogAfter,
        aws_write_check_files: policyAfter,
      },
      grants: grants.details,
    });
  } catch (error) {
    return fail(CODES.UNRELATED_MUTATION, String(error?.message || error).slice(0, 400));
  } finally {
    if (client) {
      try { await client.end(); } catch { /* ignore */ }
    }
  }
}

function sql71GrantsConstrained(grants) {
  const genericGrantees = new Set(['PUBLIC', 'authenticated', 'anon']);
  const execute = (grants.routine || []).filter((row) => row.privilege_type === 'EXECUTE');
  const badRoutine = execute.filter((row) => genericGrantees.has(row.grantee));
  const hasChecksops = execute.some((row) => row.grantee === 'checksops');
  if (badRoutine.length || !hasChecksops) {
    return fail(CODES.UNRELATED_MUTATION, 'SQL 71 grants are not constrained', {
      bad_routine: badRoutine,
      checksops_execute: hasChecksops,
    });
  }
  return ok({ grants_constrained: true, checksops_execute: true });
}

async function handleHomeownerLedgerViewLastViewedBestEffort({
  event,
  authorization,
  identity,
  connect,
  sqlFile73,
  expectedLiveDefinitionSha256 = AUTHORIZED_SQL73.expected_live_definition_sha256,
}) {
  if (event.expected_live_definition_sha256 !== expectedLiveDefinitionSha256) {
    return fail(CODES.SQL_COLLISION, 'SQL 73 authority requires the current live SQL 72 definition hash', {
      expected_live_definition_sha256: event.expected_live_definition_sha256 || null,
      required_live_definition_sha256: expectedLiveDefinitionSha256,
    });
  }

  const embedded = readEmbeddedSql(sqlFile73, AUTHORIZED_SQL73.source_sha256);
  if (!embedded.ok) return embedded;

  let client;
  try {
    client = await connect();
    const beforeLookup = await definitionTextOrFail(client, AUTHORIZED_SQL73.function_identity);
    if (!beforeLookup.ok) return beforeLookup;
    const beforeDef = beforeLookup.details.definition;
    const beforeHash = beforeDef ? hashSqlDefinition(beforeDef) : null;
    const sql44Lookup = await definitionTextOrFail(client, AUTHORIZED_SQL44.function_identity);
    if (!sql44Lookup.ok) return sql44Lookup;
    const sql44BeforeHash = sql44Lookup.details.definition
      ? hashSqlDefinition(sql44Lookup.details.definition)
      : null;

    if (event.action === 'inspect' || event.action === 'verify_data' || event.action === 'authorize') {
      if (event.inspect?.token || event.verify?.token) {
        return fail(CODES.UNRELATED_MUTATION, 'SQL 73 inspect/verify must not invoke the public token RPC');
      }
      return ok({
        authorization: authorization.details,
        receipt: {
          workstream: event.workstream_id,
          commit: event.commit,
          sql_file: event.filename,
          before_hash: beforeHash,
          after_hash: beforeHash,
          result: event.action,
          executor_identity: identity,
          function_identity: AUTHORIZED_SQL73.function_identity,
          sql44_hash: sql44BeforeHash,
          required_live_definition_sha256: expectedLiveDefinitionSha256,
        },
      });
    }

    if (event.action !== 'apply') {
      return fail(CODES.INVALID_MANIFEST, `unsupported SQL 73 executor action ${event.action}`);
    }

    if (beforeHash !== expectedLiveDefinitionSha256) {
      return fail(CODES.SQL_COLLISION, 'live function is not the accepted SQL 72 definition; SQL 73 apply refused', {
        expected_live_definition_sha256: expectedLiveDefinitionSha256,
        live_definition_sha256: beforeHash,
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

    await client.query(embedded.details.text);
    const afterLookup = await definitionTextOrFail(client, AUTHORIZED_SQL73.function_identity);
    if (!afterLookup.ok) return afterLookup;
    const afterDef = afterLookup.details.definition;
    const afterHash = afterDef ? hashSqlDefinition(afterDef) : null;
    if (!sql73DefinitionMatchesSourceBehavior(afterDef)) {
      return fail(CODES.SQL_COLLISION, 'applied SQL 73 definition does not match intended source behavior', {
        after_hash: afterHash,
      });
    }
    if (afterHash === beforeHash) {
      return fail(CODES.SQL_COLLISION, 'apply did not change the live homeowner ledger definition');
    }

    const grants = sql71GrantsConstrained(await readSql71Grants(client));
    if (!grants.ok) return grants;

    const sql44AfterLookup = await definitionTextOrFail(client, AUTHORIZED_SQL44.function_identity);
    if (!sql44AfterLookup.ok) return sql44AfterLookup;
    const sql44AfterHash = sql44AfterLookup.details.definition
      ? hashSqlDefinition(sql44AfterLookup.details.definition)
      : null;
    if (sql44AfterHash !== sql44BeforeHash) {
      return fail(CODES.SQL_COLLISION, 'SQL 73 apply changed the live SQL 44 definition; STOP', {
        expected: sql44BeforeHash,
        live: sql44AfterHash,
      });
    }

    consumeOneUse(event.one_use_id);
    return ok({
      receipt: {
        workstream: event.workstream_id,
        commit: event.commit,
        sql_file: event.filename,
        before_hash: beforeHash,
        after_hash: afterHash,
        result: 'applied',
        executor_identity: identity,
        function_identity: AUTHORIZED_SQL73.function_identity,
        sql44_hash: sql44AfterHash,
        required_live_definition_sha256: expectedLiveDefinitionSha256,
      },
      grants: grants.details,
    });
  } catch (error) {
    return fail(CODES.UNRELATED_MUTATION, String(error?.message || error).slice(0, 400));
  } finally {
    if (client) {
      try { await client.end(); } catch { /* ignore */ }
    }
  }
}

async function handleHomeownerLedgerViewClaimOk({
  event,
  authorization,
  identity,
  connect,
  sqlFile72,
  expectedLiveDefinitionSha256 = AUTHORIZED_SQL72.expected_live_definition_sha256,
}) {
  if (event.expected_live_definition_sha256 !== expectedLiveDefinitionSha256) {
    return fail(CODES.SQL_COLLISION, 'SQL 72 authority requires the current live SQL 71 definition hash', {
      expected_live_definition_sha256: event.expected_live_definition_sha256 || null,
      required_live_definition_sha256: expectedLiveDefinitionSha256,
    });
  }

  const embedded = readEmbeddedSql(sqlFile72, AUTHORIZED_SQL72.source_sha256);
  if (!embedded.ok) return embedded;

  let client;
  try {
    client = await connect();
    const beforeLookup = await definitionTextOrFail(client, AUTHORIZED_SQL72.function_identity);
    if (!beforeLookup.ok) return beforeLookup;
    const beforeDef = beforeLookup.details.definition;
    const beforeHash = beforeDef ? hashSqlDefinition(beforeDef) : null;
    const sql44Lookup = await definitionTextOrFail(client, AUTHORIZED_SQL44.function_identity);
    if (!sql44Lookup.ok) return sql44Lookup;
    const sql44BeforeHash = sql44Lookup.details.definition
      ? hashSqlDefinition(sql44Lookup.details.definition)
      : null;

    if (event.action === 'inspect' || event.action === 'verify_data' || event.action === 'authorize') {
      if (event.inspect?.token || event.verify?.token) {
        return fail(CODES.UNRELATED_MUTATION, 'SQL 72 inspect/verify must not invoke the public token RPC');
      }
      return ok({
        authorization: authorization.details,
        receipt: {
          workstream: event.workstream_id,
          commit: event.commit,
          sql_file: event.filename,
          before_hash: beforeHash,
          after_hash: beforeHash,
          result: event.action,
          executor_identity: identity,
          function_identity: AUTHORIZED_SQL72.function_identity,
          sql44_hash: sql44BeforeHash,
          required_live_definition_sha256: expectedLiveDefinitionSha256,
        },
      });
    }

    if (event.action !== 'apply') {
      return fail(CODES.INVALID_MANIFEST, `unsupported SQL 72 executor action ${event.action}`);
    }

    if (beforeHash !== expectedLiveDefinitionSha256) {
      return fail(CODES.SQL_COLLISION, 'live function is not the accepted SQL 71 definition; SQL 72 apply refused', {
        expected_live_definition_sha256: expectedLiveDefinitionSha256,
        live_definition_sha256: beforeHash,
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

    await client.query(embedded.details.text);
    const afterLookup = await definitionTextOrFail(client, AUTHORIZED_SQL72.function_identity);
    if (!afterLookup.ok) return afterLookup;
    const afterDef = afterLookup.details.definition;
    const afterHash = afterDef ? hashSqlDefinition(afterDef) : null;
    if (!sql71DefinitionMatchesSourceBehavior(afterDef)) {
      return fail(CODES.SQL_COLLISION, 'applied SQL 72 definition does not match intended source behavior', {
        after_hash: afterHash,
      });
    }
    if (afterHash === beforeHash) {
      return fail(CODES.SQL_COLLISION, 'apply did not change the live homeowner ledger definition');
    }

    const grants = sql71GrantsConstrained(await readSql71Grants(client));
    if (!grants.ok) return grants;

    const sql44AfterLookup = await definitionTextOrFail(client, AUTHORIZED_SQL44.function_identity);
    if (!sql44AfterLookup.ok) return sql44AfterLookup;
    const sql44AfterHash = sql44AfterLookup.details.definition
      ? hashSqlDefinition(sql44AfterLookup.details.definition)
      : null;
    if (sql44AfterHash !== sql44BeforeHash) {
      return fail(CODES.SQL_COLLISION, 'SQL 72 apply changed the live SQL 44 definition; STOP', {
        expected: sql44BeforeHash,
        live: sql44AfterHash,
      });
    }

    consumeOneUse(event.one_use_id);
    return ok({
      receipt: {
        workstream: event.workstream_id,
        commit: event.commit,
        sql_file: event.filename,
        before_hash: beforeHash,
        after_hash: afterHash,
        result: 'applied',
        executor_identity: identity,
        function_identity: AUTHORIZED_SQL72.function_identity,
        sql44_hash: sql44AfterHash,
        required_live_definition_sha256: expectedLiveDefinitionSha256,
      },
      grants: grants.details,
    });
  } catch (error) {
    return fail(CODES.UNRELATED_MUTATION, String(error?.message || error).slice(0, 400));
  } finally {
    if (client) {
      try { await client.end(); } catch { /* ignore */ }
    }
  }
}

async function handleHomeownerLedgerViewContract({
  event,
  authorization,
  identity,
  connect,
  sqlFile71,
}) {
  const embedded = readEmbeddedSql(sqlFile71, AUTHORIZED_SQL71.source_sha256);
  if (!embedded.ok) return embedded;

  let client;
  try {
    client = await connect();
    const beforeLookup = await definitionTextOrFail(client, AUTHORIZED_SQL71.function_identity);
    if (!beforeLookup.ok) return beforeLookup;
    const beforeDef = beforeLookup.details.definition;
    const beforeHash = beforeDef ? hashSqlDefinition(beforeDef) : null;
    const sql44Lookup = await definitionTextOrFail(client, AUTHORIZED_SQL44.function_identity);
    if (!sql44Lookup.ok) return sql44Lookup;
    const sql44BeforeHash = sql44Lookup.details.definition
      ? hashSqlDefinition(sql44Lookup.details.definition)
      : null;

    if (event.action === 'inspect' || event.action === 'verify_data' || event.action === 'authorize') {
      if (event.inspect?.token || event.verify?.token) {
        return fail(CODES.UNRELATED_MUTATION, 'SQL 71 inspect/verify must not invoke the public token RPC');
      }
      return ok({
        authorization: authorization.details,
        receipt: {
          workstream: event.workstream_id,
          commit: event.commit,
          sql_file: event.filename,
          before_hash: beforeHash,
          after_hash: beforeHash,
          result: event.action,
          executor_identity: identity,
          function_identity: AUTHORIZED_SQL71.function_identity,
          sql44_hash: sql44BeforeHash,
        },
      });
    }

    if (event.action !== 'apply') {
      return fail(CODES.INVALID_MANIFEST, `unsupported SQL 71 executor action ${event.action}`);
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

    await client.query(embedded.details.text);
    const afterLookup = await definitionTextOrFail(client, AUTHORIZED_SQL71.function_identity);
    if (!afterLookup.ok) return afterLookup;
    const afterDef = afterLookup.details.definition;
    const afterHash = afterDef ? hashSqlDefinition(afterDef) : null;
    if (!sql71DefinitionMatchesSourceBehavior(afterDef)) {
      return fail(CODES.SQL_COLLISION, 'applied SQL 71 definition does not match intended source behavior', {
        after_hash: afterHash,
      });
    }
    if (afterHash === beforeHash) {
      return fail(CODES.SQL_COLLISION, 'apply did not change the live SQL 71 definition');
    }

    const grants = sql71GrantsConstrained(await readSql71Grants(client));
    if (!grants.ok) return grants;

    const sql44AfterLookup = await definitionTextOrFail(client, AUTHORIZED_SQL44.function_identity);
    if (!sql44AfterLookup.ok) return sql44AfterLookup;
    const sql44AfterHash = sql44AfterLookup.details.definition
      ? hashSqlDefinition(sql44AfterLookup.details.definition)
      : null;
    if (sql44AfterHash !== sql44BeforeHash) {
      return fail(CODES.SQL_COLLISION, 'SQL 71 apply changed the live SQL 44 definition; STOP', {
        expected: sql44BeforeHash,
        live: sql44AfterHash,
      });
    }

    consumeOneUse(event.one_use_id);
    return ok({
      receipt: {
        workstream: event.workstream_id,
        commit: event.commit,
        sql_file: event.filename,
        before_hash: beforeHash,
        after_hash: afterHash,
        result: 'applied',
        executor_identity: identity,
        function_identity: AUTHORIZED_SQL71.function_identity,
        sql44_hash: sql44AfterHash,
      },
      grants: grants.details,
    });
  } catch (error) {
    return fail(CODES.UNRELATED_MUTATION, String(error?.message || error).slice(0, 400));
  } finally {
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
  sqlFileMembership = MEMBERSHIP_ONLY_SQL_FILE,
  sqlFile39 = MORTGAGE_OPS_SQL_FILE,
  sqlFile71 = SQL71_FILE,
  sqlFile72 = SQL72_FILE,
  sqlFile73 = SQL73_FILE,
  sqlFile74 = SQL74_FILE,
  sqlFile75 = SQL75_FILE,
  expectedSql72LiveHash = AUTHORIZED_SQL72.expected_live_definition_sha256,
  expectedSql73LiveHash = AUTHORIZED_SQL73.expected_live_definition_sha256,
  expectedSql74LiveHash = AUTHORIZED_SQL74.expected_live_definition_sha256,
  expectedSql75LiveHash = AUTHORIZED_SQL75.expected_live_definition_sha256,
  expectedSql43Hash = AUTHORIZED_SQL44.expected_sql43_definition_sha256,
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

    if (isMortgageOpsAcceptComplete(event)) {
      return handleMortgageOpsAcceptComplete({
        event,
        authorization,
        identity,
        connect,
        sqlFile: sqlFile39,
        readEmbeddedSql,
        consumeOneUse,
      });
    }

    if (isMembershipOnlyHelper(event)) {
      return handleMembershipOnlyHelper({
        event,
        authorization,
        identity,
        connect,
        sqlFile: sqlFileMembership,
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

    if (isSignatureRequestCheckFilesLinkGrant(event)) {
      return handleSignatureRequestCheckFilesLinkGrant({
        event,
        authorization,
        identity,
        connect,
        sqlFile75,
        expectedLiveDefinitionSha256: expectedSql75LiveHash,
      });
    }

    if (isHomeownerSigningRlsBoundary(event)) {
      return handleHomeownerSigningRlsBoundary({
        event,
        authorization,
        identity,
        connect,
        sqlFile74,
        expectedLiveDefinitionSha256: expectedSql74LiveHash,
      });
    }

    if (isHomeownerLedgerViewLastViewedBestEffort(event)) {
      return handleHomeownerLedgerViewLastViewedBestEffort({
        event,
        authorization,
        identity,
        connect,
        sqlFile73,
        expectedLiveDefinitionSha256: expectedSql73LiveHash,
      });
    }

    if (isHomeownerLedgerViewClaimOk(event)) {
      return handleHomeownerLedgerViewClaimOk({
        event,
        authorization,
        identity,
        connect,
        sqlFile72,
        expectedLiveDefinitionSha256: expectedSql72LiveHash,
      });
    }

    if (isHomeownerLedgerViewContract(event)) {
      return handleHomeownerLedgerViewContract({
        event,
        authorization,
        identity,
        connect,
        sqlFile71,
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
