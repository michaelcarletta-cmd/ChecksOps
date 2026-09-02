import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  C1C_ADMIN_ID,
  C1C_TENANT,
  COGNITO_SUB,
  FREEDOM_TENANT,
  MASTER_OWNER_ID,
  NINTH_ID,
  TESTER_ID,
  inspectApplicationRole,
} from './writePlan.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SQL_DIR = path.join(ROOT, '..', 'sql');
const CLASS_DIR = path.join(ROOT, '..', 'classification');
const readSql = (name) => fs.readFileSync(path.join(SQL_DIR, name), 'utf8');
const inventory = JSON.parse(
  fs.readFileSync(path.join(CLASS_DIR, 'rls_enable_inventory.json'), 'utf8'),
);

const ENABLE_TABLES = inventory.enable_tables;
const RESTORE_TABLES = inventory.restore_tables;
const SERVER_SIDE = inventory.server_side_api_no_write_policy;
const OBSOLETE = inventory.obsolete_no_write_policy;
const PLATFORM_OWNER_WRITES = inventory.platform_owner_only_write_tables;
const FINANCIAL_EXPECTED = inventory.financial_expected;
const CORE_COUNTS = inventory.core_row_counts;

const WRITE_GRANT_TABLES = [
  'check_intake_items',
  'deposit_items',
  'claims',
  'claim_files',
  'claim_folders',
  'payment_provider_accounts',
  'payment_webhook_events',
  'checkalt_config',
  'checkalt_deposits',
  'company_branding',
  'user_roles',
  'tenants',
  'homeowner_ledger_events',
  'tenant_email_settings',
  'check_endorsements',
  'disbursement_batches',
  'payment_idempotency_keys',
  'plaid_webhook_cursors',
];

const asRole = async (client, appUserId, fn) => {
  await client.query('SAVEPOINT rls_enable_probe');
  try {
    await client.query('SET LOCAL ROLE checksops');
    if (appUserId) {
      await client.query("SELECT set_config('request.app_user_id', $1, true)", [appUserId]);
    } else {
      await client.query("SELECT set_config('request.app_user_id', '', true)");
    }
    const result = await fn();
    await client.query('ROLLBACK TO SAVEPOINT rls_enable_probe');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK TO SAVEPOINT rls_enable_probe'); } catch { /* ignore */ }
    return { error: String(error?.message || error).slice(0, 400) };
  }
};

const countResult = (result) => {
  if (result?.error) return { ok: false, n: 0, error: result.error };
  return { ok: true, n: Number(result?.rowCount || result?.n || 0) };
};

const rlsDenied = (t) => Boolean(t?.error && /row-level security|permission denied/i.test(t.error));
const expectOk = (t) => t && !t.error && Number(t.n) > 0;
const expectDenied = (t) => {
  if (!t) return false;
  if (rlsDenied(t)) return true;
  if (t.error) return false;
  return t.n === 0;
};

const tryWrite = async (client, appUserId, sql, params = []) => asRole(client, appUserId, async () => {
  const result = await client.query(sql, params);
  return { rowCount: result.rowCount };
});

const trySelect = async (client, appUserId, sql, params = []) => asRole(client, appUserId, async () => {
  const result = await client.query(sql, params);
  const row = result.rows[0] || {};
  return { ok: true, ...row, n: Number(row.n || 0), rowCount: Number(row.n || 0) };
});

const applySqlStatements = async (client, name) => {
  const sql = readSql(name)
    .split('\n')
    .filter((line) => line.trim() && !line.trim().startsWith('--'))
    .join('\n');
  const stmts = sql.split(/;\s*/).map((s) => s.trim()).filter(Boolean);
  for (const stmt of stmts) {
    await client.query(`${stmt};`);
  }
  return stmts.length;
};

const policyCounts = async (client) => {
  const selectPolicies = Number((await client.query(
    `SELECT count(*)::int AS n FROM pg_policies
     WHERE schemaname='public' AND policyname LIKE 'aws_select_%'`,
  )).rows[0].n);
  const writePolicies = Number((await client.query(
    `SELECT count(*)::int AS n FROM pg_policies
     WHERE schemaname='public' AND policyname LIKE 'aws_write_%'`,
  )).rows[0].n);
  const dumpPolicies = Number((await client.query(
    `SELECT count(*)::int AS n FROM pg_policies
     WHERE schemaname='public' AND policyname NOT LIKE 'aws_%'`,
  )).rows[0].n);
  const identityFks = Number((await client.query(
    `SELECT count(*)::int AS n FROM pg_constraint WHERE conname LIKE '%_identity_fkey'`,
  )).rows[0].n);
  const writeOnServerSide = Number((await client.query(
    `SELECT count(*)::int AS n FROM pg_policies
     WHERE schemaname='public'
       AND policyname LIKE 'aws_write_%'
       AND tablename = ANY($1::text[])`,
    [SERVER_SIDE],
  )).rows[0].n);
  const writeOnObsolete = Number((await client.query(
    `SELECT count(*)::int AS n FROM pg_policies
     WHERE schemaname='public'
       AND policyname LIKE 'aws_write_%'
       AND tablename = ANY($1::text[])`,
    [OBSOLETE],
  )).rows[0].n);
  const platformOwnerWrites = Number((await client.query(
    `SELECT count(*)::int AS n FROM pg_policies
     WHERE schemaname='public'
       AND policyname LIKE 'aws_write_%'
       AND tablename = ANY($1::text[])`,
    [PLATFORM_OWNER_WRITES],
  )).rows[0].n);
  return {
    selectPolicies,
    writePolicies,
    dumpPolicies,
    identityFks,
    writeOnServerSide,
    writeOnObsolete,
    platformOwnerWrites,
  };
};

const rlsStateFor = async (client, tables) => {
  const { rows } = await client.query(
    `SELECT c.relname AS table_name, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname='public' AND c.relkind='r' AND c.relname = ANY($1::text[])
     ORDER BY 1`,
    [tables],
  );
  return {
    present: rows.length,
    enabled: rows.filter((r) => r.rls).map((r) => r.table_name),
    forced: rows.filter((r) => r.forced).map((r) => r.table_name),
    disabled: rows.filter((r) => !r.rls).map((r) => r.table_name),
  };
};

const financialSnapshot = async (client) => {
  const { rows } = await client.query(readSql('28_financial_aggregates.sql'));
  const values = Object.fromEntries(rows.map((row) => [row.metric, String(row.value)]));
  const mismatches = Object.entries(FINANCIAL_EXPECTED).filter(([metric, expected]) => (
    Number(values[metric]) !== Number(expected)
  ));
  return {
    values,
    mismatches: mismatches.map(([metric, expected]) => ({
      metric,
      expected,
      actual: values[metric] ?? null,
    })),
    pass: mismatches.length === 0,
  };
};

const coreCounts = async (client) => {
  const out = {};
  for (const [table, expected] of Object.entries(CORE_COUNTS)) {
    const n = Number((await client.query(
      `SELECT count(*)::bigint AS n FROM public.${table}`,
    )).rows[0].n);
    out[table] = { n, expected, match: n === expected };
  }
  return {
    tables: out,
    pass: Object.values(out).every((row) => row.match),
  };
};

const claimsSnapshot = async (client) => {
  const row = (await client.query(
    `SELECT count(*)::int AS n,
            count(*) FILTER (WHERE org_id IS NULL)::int AS org_null,
            count(*) FILTER (WHERE org_id = $1::uuid)::int AS freedom,
            count(*) FILTER (WHERE org_id IS NOT NULL AND org_id <> $1::uuid)::int AS other
     FROM public.claims`,
    [FREEDOM_TENANT],
  )).rows[0];
  return {
    n: Number(row.n),
    org_null: Number(row.org_null),
    freedom: Number(row.freedom),
    other: Number(row.other),
    pass: Number(row.n) === 180 && Number(row.freedom) === 83
      && Number(row.org_null) === 97 && Number(row.other) === 0,
  };
};

const identitySnapshot = async (client) => {
  const ninth = (await client.query(
    `SELECT application_user_id::text AS application_user_id, cognito_sub, email, status
     FROM public.identity_accounts WHERE application_user_id = $1::uuid`,
    [NINTH_ID],
  )).rows[0] || null;
  const probe = (await client.query(
    `SELECT application_user_id::text AS application_user_id, cognito_sub, email, status
     FROM public.identity_accounts WHERE cognito_sub = $1`,
    [COGNITO_SUB],
  )).rows[0] || null;
  const realUsers = Number((await client.query(
    `SELECT count(*)::int AS n FROM public.identity_accounts
     WHERE status = 'active' AND cognito_sub IS NOT NULL`,
  )).rows[0].n);
  return {
    ninth,
    probe,
    realUsersWithCognito: realUsers,
    ninthHasCognito: Boolean(ninth?.cognito_sub),
    ninthEmail: ninth?.email || null,
    probeMapsToTester: probe?.application_user_id === TESTER_ID,
    pass: Boolean(ninth)
      && ninth.cognito_sub == null
      && realUsers === 0
      && probe?.application_user_id === TESTER_ID
      && probe?.status === 'isolated_test',
  };
};

const applicationRoleFlags = async (client) => {
  const role = (await client.query(
    `SELECT rolname, rolsuper, rolbypassrls, rolcreaterole
     FROM pg_roles WHERE rolname = 'checksops'`,
  )).rows[0];
  const owner = (await client.query(
    `SELECT pg_get_userbyid(c.relowner) AS owner
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname='public' AND c.relname='check_intake_items'`,
  )).rows[0]?.owner;
  const currentUser = (await client.query('SELECT current_user AS u')).rows[0].u;
  return {
    currentUser,
    checksops: role,
    checkIntakeOwner: owner,
    apiRoleIsChecksops: true,
    checksopsIsOwner: owner === 'checksops',
    checksopsIsSuperuser: Boolean(role?.rolsuper),
    checksopsBypassRls: Boolean(role?.rolbypassrls),
    pass: currentUser === 'checksops_admin'
      && owner !== 'checksops'
      && !role?.rolsuper
      && !role?.rolbypassrls,
  };
};

export const capturePreEnableSnapshot = async (client) => {
  const restorePresent = Number((await client.query(
    `SELECT count(*)::int AS n
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname='public' AND c.relkind='r' AND c.relname = ANY($1::text[])`,
    [RESTORE_TABLES],
  )).rows[0].n);
  const extraRestoredRls = ENABLE_TABLES;
  const rls = await rlsStateFor(client, extraRestoredRls);
  const spatial = await rlsStateFor(client, ['spatial_ref_sys', 'identity_accounts']);
  const policies = await policyCounts(client);
  const claims = await claimsSnapshot(client);
  const financial = await financialSnapshot(client);
  const core = await coreCounts(client);
  const identity = await identitySnapshot(client);
  const role = await applicationRoleFlags(client);
  const mismatches = [];
  if (restorePresent !== 166) mismatches.push(`restoredTables=${restorePresent} expected 166`);
  if (ENABLE_TABLES.length !== 165) mismatches.push(`enable inventory ${ENABLE_TABLES.length}`);
  if (rls.present !== 165) mismatches.push(`enable tables present ${rls.present}`);
  if (rls.forced.length) mismatches.push(`FORCE already set: ${rls.forced.join(',')}`);
  if (!(rls.enabled.length === 0 || rls.enabled.length === 165)) {
    mismatches.push(`restored RLS enabled count ${rls.enabled.length} is not 0 or 165`);
  }
  if (spatial.enabled.length) mismatches.push(`RLS on non-inventory: ${spatial.enabled.join(',')}`);
  if (policies.selectPolicies !== 165) mismatches.push(`aws_select_*=${policies.selectPolicies}`);
  if (policies.writePolicies !== 127) mismatches.push(`aws_write_*=${policies.writePolicies}`);
  if (policies.dumpPolicies !== 0) mismatches.push(`dump policies=${policies.dumpPolicies}`);
  if (policies.identityFks !== 47) mismatches.push(`identity FKs=${policies.identityFks}`);
  if (policies.writeOnServerSide !== 0) mismatches.push(`write policies on server-side tables`);
  if (policies.writeOnObsolete !== 0) mismatches.push(`write policies on obsolete tables`);
  if (policies.platformOwnerWrites !== 7) mismatches.push(`platform-owner writes=${policies.platformOwnerWrites}`);
  if (!claims.pass) mismatches.push(`claims ${JSON.stringify(claims)}`);
  if (!financial.pass) mismatches.push(`financial ${JSON.stringify(financial.mismatches)}`);
  if (!core.pass) mismatches.push('core counts');
  if (!identity.pass) mismatches.push('identity mapping');
  if (!role.pass) mismatches.push('checksops role flags');
  if (identity.realUsersWithCognito !== 0) mismatches.push('real users already invited');
  if (identity.ninthHasCognito) mismatches.push('ninth UUID has Cognito');
  return {
    restorePresent,
    expectedRestore: 166,
    expectedRlsTables: 165,
    restoredRlsEnabled: rls.enabled.length,
    restoredRlsForced: rls.forced,
    alreadyEnabled: rls.enabled.length === 165,
    policies,
    claims,
    financial,
    core,
    identity,
    role,
    mismatches,
    pass: mismatches.length === 0,
  };
};

const disableRestoredRls = async (client) => {
  await applySqlStatements(client, '27_disable_rls.sql');
  const after = await rlsStateFor(client, ENABLE_TABLES);
  return {
    disabled: after.disabled.length,
    stillEnabled: after.enabled,
    pass: after.enabled.length === 0 && after.forced.length === 0,
  };
};

const enableRestoredRls = async (client) => {
  await client.query('BEGIN');
  try {
    const applied = await applySqlStatements(client, '26_enable_rls.sql');
    if (applied !== 165) {
      await client.query('ROLLBACK');
      return { applied: false, error: `expected 165 ENABLE statements, ran ${applied}`, pass: false };
    }
    const state = await rlsStateFor(client, ENABLE_TABLES);
    if (state.enabled.length !== 165 || state.forced.length) {
      await client.query('ROLLBACK');
      return {
        applied: false,
        rolledBackEnableTxn: true,
        enabled: state.enabled.length,
        forced: state.forced,
        pass: false,
      };
    }
    await client.query('COMMIT');
    return {
      applied: true,
      enabled: state.enabled.length,
      forced: state.forced,
      usedForce: false,
      pass: true,
    };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    return { applied: false, error: String(error?.message || error).slice(0, 500), pass: false };
  }
};

export const liveAuthorizationSuite = async (client) => {
  await client.query('BEGIN');
  try {
    const assignedClaim = (await client.query(
      `SELECT id::text AS id FROM public.claims WHERE org_id = $1::uuid LIMIT 1`,
      [FREEDOM_TENANT],
    )).rows[0];
    const nullClaim = (await client.query(
      `SELECT id::text AS id FROM public.claims WHERE org_id IS NULL LIMIT 1`,
    )).rows[0];
    const freedomCheck = (await client.query(
      `SELECT id::text AS id FROM public.check_intake_items WHERE tenant_id=$1::uuid LIMIT 1`,
      [FREEDOM_TENANT],
    )).rows[0];
    const freedomDeposit = (await client.query(
      `SELECT di.id::text AS id, di.check_id::text AS check_id
       FROM public.deposit_items di
       JOIN public.check_intake_items ci ON ci.id = di.check_id
       WHERE ci.tenant_id=$1::uuid LIMIT 1`,
      [FREEDOM_TENANT],
    )).rows[0];

    const claimCountSql = `
      SELECT count(*)::int AS n,
             count(*) FILTER (WHERE org_id = '${FREEDOM_TENANT}')::int AS freedom,
             count(*) FILTER (WHERE org_id IS NULL)::int AS org_null
      FROM public.claims
    `;
    const asCounts = async (id) => {
      const result = await trySelect(client, id, claimCountSql);
      if (result?.error) return { n: 0, freedom: 0, org_null: 0, error: result.error };
      return {
        n: Number(result.n || 0),
        freedom: Number(result.freedom || 0),
        org_null: Number(result.org_null || 0),
      };
    };

    const tests = {};
    tests.staffClaims = await asCounts(TESTER_ID);
    tests.c1cClaims = await asCounts(C1C_ADMIN_ID);
    tests.masterClaims = await asCounts(MASTER_OWNER_ID);
    tests.ninthClaims = await asCounts(NINTH_ID);
    tests.unauthClaims = await asCounts(null);
    tests.cognitoSubClaims = await asCounts(COGNITO_SUB);

    tests.staffFreedomChecks = await trySelect(
      client, TESTER_ID,
      `SELECT count(*)::int AS n FROM public.check_intake_items WHERE tenant_id=$1::uuid`,
      [FREEDOM_TENANT],
    );
    tests.c1cFreedomChecks = await trySelect(
      client, C1C_ADMIN_ID,
      `SELECT count(*)::int AS n FROM public.check_intake_items WHERE tenant_id=$1::uuid`,
      [FREEDOM_TENANT],
    );
    tests.c1cFreedomEndorsements = await trySelect(
      client, C1C_ADMIN_ID,
      `SELECT count(*)::int AS n FROM public.check_endorsements WHERE tenant_id=$1::uuid`,
      [FREEDOM_TENANT],
    );
    tests.c1cFreedomDisbursements = await trySelect(
      client, C1C_ADMIN_ID,
      `SELECT count(*)::int AS n FROM public.disbursement_batches WHERE tenant_id=$1::uuid`,
      [FREEDOM_TENANT],
    );
    tests.c1cFreedomTenants = await trySelect(
      client, C1C_ADMIN_ID,
      `SELECT count(*)::int AS n FROM public.tenants WHERE id=$1::uuid`,
      [FREEDOM_TENANT],
    );
    tests.c1cOwnTenant = await trySelect(
      client, C1C_ADMIN_ID,
      `SELECT count(*)::int AS n FROM public.tenants WHERE id=$1::uuid`,
      [C1C_TENANT],
    );
    tests.staffC1cTenant = await trySelect(
      client, TESTER_ID,
      `SELECT count(*)::int AS n FROM public.tenants WHERE id=$1::uuid`,
      [C1C_TENANT],
    );
    tests.c1cFreedomFiles = await trySelect(
      client, C1C_ADMIN_ID,
      `SELECT count(*)::int AS n FROM public.claim_files cf
       JOIN public.claims c ON c.id = cf.claim_id
       WHERE c.org_id = $1::uuid`,
      [FREEDOM_TENANT],
    );
    tests.c1cFreedomDeposits = await trySelect(
      client, C1C_ADMIN_ID,
      `SELECT count(*)::int AS n FROM public.deposit_items di
       JOIN public.check_intake_items ci ON ci.id = di.check_id
       WHERE ci.tenant_id = $1::uuid`,
      [FREEDOM_TENANT],
    );
    tests.c1cFreedomDepositsNonRecipient = await trySelect(
      client, C1C_ADMIN_ID,
      `SELECT count(*)::int AS n FROM public.deposit_items di
       JOIN public.check_intake_items ci ON ci.id = di.check_id
       WHERE ci.tenant_id = $1::uuid
         AND NOT public.current_tenant_is_check_funds_recipient(di.check_id)`,
      [FREEDOM_TENANT],
    );
    tests.ninthChecks = await trySelect(
      client, NINTH_ID,
      `SELECT count(*)::int AS n FROM public.check_intake_items`,
    );
    tests.ninthTenants = await trySelect(
      client, NINTH_ID,
      `SELECT count(*)::int AS n FROM public.tenants`,
    );
    tests.ninthDeposits = await trySelect(
      client, NINTH_ID,
      `SELECT count(*)::int AS n FROM public.deposit_items`,
    );
    tests.unauthChecks = await trySelect(
      client, null,
      `SELECT count(*)::int AS n FROM public.check_intake_items`,
    );
    tests.masterNullClaims = await trySelect(
      client, MASTER_OWNER_ID,
      `SELECT count(*)::int AS n FROM public.claims WHERE org_id IS NULL`,
    );
    tests.staffNullClaims = await trySelect(
      client, TESTER_ID,
      `SELECT count(*)::int AS n FROM public.claims WHERE org_id IS NULL`,
    );
    if (nullClaim) {
      tests.staffSelectNullClaimFolders = await trySelect(
        client, TESTER_ID,
        `SELECT count(*)::int AS n FROM public.claim_folders WHERE claim_id=$1::uuid`,
        [nullClaim.id],
      );
      tests.masterSelectNullClaimFolders = await trySelect(
        client, MASTER_OWNER_ID,
        `SELECT count(*)::int AS n FROM public.claim_folders WHERE claim_id=$1::uuid`,
        [nullClaim.id],
      );
    }
    if (assignedClaim) {
      tests.c1cSelectAssignedClaim = await trySelect(
        client, C1C_ADMIN_ID,
        `SELECT count(*)::int AS n FROM public.claims WHERE id=$1::uuid`,
        [assignedClaim.id],
      );
    }
    if (freedomCheck) {
      tests.c1cUuidGuessCheck = await trySelect(
        client, C1C_ADMIN_ID,
        `SELECT count(*)::int AS n FROM public.check_intake_items WHERE id=$1::uuid`,
        [freedomCheck.id],
      );
    }

    await client.query('ROLLBACK');

    const failReasons = [];
    const add = (ok, reason) => { if (!ok) failReasons.push(reason); };
    add(tests.staffClaims.freedom === 83 && tests.staffClaims.org_null === 0, 'staff claims');
    add(tests.c1cClaims.freedom === 0 && tests.c1cClaims.org_null === 0 && tests.c1cClaims.n === 0, 'c1c claims');
    add(tests.masterClaims.n === 180 && tests.masterClaims.org_null === 97, 'master claims');
    add(tests.ninthClaims.n === 0, 'ninth claims');
    add(tests.unauthClaims.n === 0, 'unauth claims');
    add(tests.cognitoSubClaims.n === 0, 'cognito sub as uuid');
    add(expectOk(tests.staffFreedomChecks), 'staff freedom checks');
    add(tests.c1cFreedomChecks.n === 0, 'c1c freedom checks');
    add(tests.c1cFreedomEndorsements.n === 0, 'c1c freedom endorsements');
    add(tests.c1cFreedomDisbursements.n === 0, 'c1c freedom disbursements');
    add(tests.c1cFreedomTenants.n === 0, 'c1c freedom tenant');
    add(expectOk(tests.c1cOwnTenant), 'c1c own tenant');
    add(tests.staffC1cTenant.n === 0, 'staff c1c tenant');
    add(tests.c1cFreedomFiles.n === 0, 'c1c freedom files');
    add(tests.c1cFreedomDepositsNonRecipient.n === 0, 'c1c non-recipient freedom deposits');
    add(tests.ninthChecks.n === 0 && tests.ninthTenants.n === 0 && tests.ninthDeposits.n === 0, 'ninth tenant-scoped');
    add(tests.unauthChecks.n === 0, 'unauth checks');
    add(tests.masterNullClaims.n === 97, 'master null-org');
    add(tests.staffNullClaims.n === 0, 'staff null-org');
    add(!tests.staffSelectNullClaimFolders || tests.staffSelectNullClaimFolders.n === 0, 'staff null folders');
    add(!tests.masterSelectNullClaimFolders || tests.masterSelectNullClaimFolders.n > 0, 'master null folders');
    add(!tests.c1cSelectAssignedClaim || tests.c1cSelectAssignedClaim.n === 0, 'c1c assigned claim uuid');
    add(!tests.c1cUuidGuessCheck || tests.c1cUuidGuessCheck.n === 0, 'c1c uuid-guess check');

    return {
      simulatedRls: false,
      tests,
      failReasons,
      documentedFundsRecipientDeposits: Number(tests.c1cFreedomDeposits?.n || 0),
      pass: failReasons.length === 0,
    };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    return { pass: false, error: String(error?.message || error).slice(0, 800) };
  }
};

export const liveWriteSuite = async (client) => {
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL default_transaction_read_only = off');
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${WRITE_GRANT_TABLES.map((t) => `public.${t}`).join(', ')} TO checksops`,
    );

    const assignedClaim = (await client.query(
      `SELECT id::text AS id FROM public.claims WHERE org_id = $1::uuid LIMIT 1`,
      [FREEDOM_TENANT],
    )).rows[0];
    const nullClaim = (await client.query(
      `SELECT id::text AS id FROM public.claims WHERE org_id IS NULL LIMIT 1`,
    )).rows[0];
    const freedomCheck = (await client.query(
      `SELECT id::text AS id FROM public.check_intake_items WHERE tenant_id=$1::uuid LIMIT 1`,
      [FREEDOM_TENANT],
    )).rows[0];
    const freedomDeposit = (await client.query(
      `SELECT di.id::text AS id FROM public.deposit_items di
       JOIN public.check_intake_items ci ON ci.id = di.check_id
       WHERE ci.tenant_id=$1::uuid LIMIT 1`,
      [FREEDOM_TENANT],
    )).rows[0];

    const tests = {};
    if (assignedClaim) {
      tests.staffUpdateAssignedClaim = countResult(await tryWrite(
        client, TESTER_ID,
        `UPDATE public.claims SET status = status WHERE id=$1::uuid`,
        [assignedClaim.id],
      ));
      tests.c1cUpdateAssignedClaimDenied = countResult(await tryWrite(
        client, C1C_ADMIN_ID,
        `UPDATE public.claims SET status = status WHERE id=$1::uuid`,
        [assignedClaim.id],
      ));
    }
    if (nullClaim) {
      tests.staffUpdateNullClaimDenied = countResult(await tryWrite(
        client, TESTER_ID,
        `UPDATE public.claims SET status = status WHERE id=$1::uuid`,
        [nullClaim.id],
      ));
    }
    if (freedomCheck) {
      tests.staffUpdateFreedomCheck = countResult(await tryWrite(
        client, TESTER_ID,
        `UPDATE public.check_intake_items SET review_notes = coalesce(review_notes,'') WHERE id=$1::uuid`,
        [freedomCheck.id],
      ));
      tests.c1cUuidOracleCheckDenied = countResult(await tryWrite(
        client, C1C_ADMIN_ID,
        `UPDATE public.check_intake_items SET review_notes = 'uuid-guess' WHERE id=$1::uuid`,
        [freedomCheck.id],
      ));
    }
    if (freedomDeposit) {
      tests.c1cUpdateFreedomDepositDenied = countResult(await tryWrite(
        client, C1C_ADMIN_ID,
        `UPDATE public.deposit_items SET exception_reason = 'cross' WHERE id=$1::uuid`,
        [freedomDeposit.id],
      ));
    }

    tests.staffInsertWebhookDenied = countResult(await tryWrite(
      client, TESTER_ID,
      `INSERT INTO public.payment_webhook_events
         (provider, environment, external_event_id, event_type, tenant_id, payload)
       VALUES ('aws-rls-enable-test', 'sandbox', 'aws-rls-enable-test', 'test.event', $1::uuid, '{}'::jsonb)`,
      [FREEDOM_TENANT],
    ));
    tests.staffUpdateCheckaltDenied = countResult(await tryWrite(
      client, TESTER_ID,
      `UPDATE public.checkalt_config SET notes = coalesce(notes,'')`,
    ));
    tests.masterUpdateCheckaltDenied = countResult(await tryWrite(
      client, MASTER_OWNER_ID,
      `UPDATE public.checkalt_config SET notes = coalesce(notes,'')`,
    ));
    tests.staffInsertCheckaltDepositDenied = countResult(await tryWrite(
      client, TESTER_ID,
      `INSERT INTO public.checkalt_deposits (check_intake_item_id, tenant_id, amount, status)
       SELECT id, tenant_id, 0.01, 'pending'
       FROM public.check_intake_items WHERE tenant_id=$1::uuid LIMIT 1`,
      [FREEDOM_TENANT],
    ));
    tests.staffInsertIdempotencyDenied = countResult(await tryWrite(
      client, TESTER_ID,
      `INSERT INTO public.payment_idempotency_keys (tenant_id, provider, scope, idempotency_key)
       VALUES ($1::uuid, 'aws-rls-enable-test', 'rls-enable', 'aws-rls-enable-test')`,
      [FREEDOM_TENANT],
    ));
    tests.staffUpdateBrandingDenied = countResult(await tryWrite(
      client, TESTER_ID,
      `UPDATE public.company_branding SET updated_at = now()`,
    ));
    const brandingRows = Number((await client.query(
      `SELECT count(*)::int AS n FROM public.company_branding`,
    )).rows[0].n);
    if (brandingRows > 0) {
      tests.masterUpdateBranding = countResult(await tryWrite(
        client, MASTER_OWNER_ID,
        `UPDATE public.company_branding SET updated_at = now()`,
      ));
    } else {
      tests.masterUpdateBranding = countResult(await tryWrite(
        client, MASTER_OWNER_ID,
        `INSERT INTO public.company_branding (company_name) VALUES ('aws-rls-enable-test')`,
      ));
    }
    tests.ninthInsertProbeDenied = countResult(await tryWrite(
      client, NINTH_ID,
      `INSERT INTO public._aws_rls_write_probe (tenant_id, label)
       VALUES ($1::uuid, 'ninth-enable-denied')`,
      [FREEDOM_TENANT],
    ));
    tests.staffInsertFreedomProbe = countResult(await tryWrite(
      client, TESTER_ID,
      `INSERT INTO public._aws_rls_write_probe (tenant_id, label)
       VALUES ($1::uuid, 'staff-enable-ok')`,
      [FREEDOM_TENANT],
    ));
    tests.c1cInsertFreedomProbeDenied = countResult(await tryWrite(
      client, C1C_ADMIN_ID,
      `INSERT INTO public._aws_rls_write_probe (tenant_id, label)
       VALUES ($1::uuid, 'admin-enable-cross')`,
      [FREEDOM_TENANT],
    ));

    await client.query('ROLLBACK');

    const failReasons = [];
    const add = (ok, reason) => { if (!ok) failReasons.push(reason); };
    add(!tests.staffUpdateAssignedClaim || expectOk(tests.staffUpdateAssignedClaim), 'staff claim write');
    add(!tests.c1cUpdateAssignedClaimDenied || expectDenied(tests.c1cUpdateAssignedClaimDenied), 'c1c claim write');
    add(!tests.staffUpdateNullClaimDenied || expectDenied(tests.staffUpdateNullClaimDenied), 'staff null claim write');
    add(!tests.staffUpdateFreedomCheck || expectOk(tests.staffUpdateFreedomCheck), 'staff check write');
    add(!tests.c1cUuidOracleCheckDenied || expectDenied(tests.c1cUuidOracleCheckDenied), 'c1c uuid-guess write');
    add(!tests.c1cUpdateFreedomDepositDenied || expectDenied(tests.c1cUpdateFreedomDepositDenied), 'c1c deposit write');
    add(expectDenied(tests.staffInsertWebhookDenied), 'webhook write');
    add(expectDenied(tests.staffUpdateCheckaltDenied), 'staff checkalt');
    add(expectDenied(tests.masterUpdateCheckaltDenied), 'master checkalt');
    add(expectDenied(tests.staffInsertCheckaltDepositDenied), 'checkalt deposit insert');
    add(expectDenied(tests.staffInsertIdempotencyDenied), 'idempotency insert');
    add(expectDenied(tests.staffUpdateBrandingDenied), 'staff branding');
    add(expectOk(tests.masterUpdateBranding), 'master branding');
    add(expectDenied(tests.ninthInsertProbeDenied), 'ninth probe write');
    add(expectOk(tests.staffInsertFreedomProbe), 'staff probe write');
    add(expectDenied(tests.c1cInsertFreedomProbeDenied), 'c1c probe write');

    return {
      rolledBack: true,
      persistedFinancialWrites: false,
      calledExternalProviders: false,
      temporaryWriteGrantsRolledBack: true,
      apiReadOnlyBrakeRestored: true,
      tests,
      failReasons,
      pass: failReasons.length === 0,
    };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    return {
      rolledBack: true,
      persistedFinancialWrites: false,
      pass: false,
      error: String(error?.message || error).slice(0, 800),
    };
  }
};

export const regressionSuite = async (client) => {
  const rls = await rlsStateFor(client, ENABLE_TABLES);
  const probes = await rlsStateFor(client, ['_aws_rls_probe_items', '_aws_rls_write_probe']);
  const spatial = await rlsStateFor(client, ['spatial_ref_sys', 'identity_accounts']);
  const policies = await policyCounts(client);
  const claims = await claimsSnapshot(client);
  const financial = await financialSnapshot(client);
  const core = await coreCounts(client);
  const identity = await identitySnapshot(client);
  const role = await inspectApplicationRole(client);
  const remainingWritePriv = (await client.query(
    `SELECT has_table_privilege('checksops', 'public.check_intake_items', 'INSERT') AS ins,
            has_table_privilege('checksops', 'public.check_intake_items', 'UPDATE') AS upd,
            has_table_privilege('checksops', 'public.check_intake_items', 'DELETE') AS del`,
  )).rows[0];
  const failReasons = [];
  if (rls.enabled.length !== 165) failReasons.push(`rls enabled ${rls.enabled.length}`);
  if (rls.forced.length) failReasons.push(`FORCE set: ${rls.forced.join(',')}`);
  if (probes.enabled.length !== 2) failReasons.push('probe tables missing RLS');
  if (spatial.enabled.length) failReasons.push(`non-inventory RLS ${spatial.enabled.join(',')}`);
  if (policies.selectPolicies !== 165) failReasons.push('select policies');
  if (policies.writePolicies !== 127) failReasons.push('write policies');
  if (policies.dumpPolicies !== 0) failReasons.push('dump policies');
  if (policies.identityFks !== 47) failReasons.push('identity fks');
  if (!claims.pass) failReasons.push('claims');
  if (!financial.pass) failReasons.push('financial');
  if (!core.pass) failReasons.push('core counts');
  if (!identity.pass) failReasons.push('identity');
  if (!role.checksopsCannotAlterRls) failReasons.push('checksops can alter RLS');
  if (!role.checksopsCannotCreatePolicy) failReasons.push('checksops can create policy');
  if (role.checksopsHasWritePrivilege) failReasons.push('checksops still has write privilege');
  if (remainingWritePriv.ins || remainingWritePriv.upd || remainingWritePriv.del) {
    failReasons.push('temporary write grants leaked');
  }
  if (identity.realUsersWithCognito !== 0) failReasons.push('real users invited');
  return {
    rlsEnabledRestored: rls.enabled.length,
    rlsForced: rls.forced,
    publicProbeRls: probes.enabled.length,
    policies,
    claims,
    financial,
    core,
    identity,
    applicationRoleInspection: {
      checksopsCannotAlterRls: role.checksopsCannotAlterRls,
      checksopsCannotCreatePolicy: role.checksopsCannotCreatePolicy,
      checksopsHasWritePrivilege: role.checksopsHasWritePrivilege,
      checkIntakeOwner: role.checkIntakeOwner,
      checksopsBypassRls: role.roles?.find((r) => r.rolname === 'checksops')?.rolbypassrls === true,
    },
    failReasons,
    pass: failReasons.length === 0,
  };
};

export const runEnableRls = async (client, { apply = false, rollback = false } = {}) => {
  const out = {
    realUsersInvited: false,
    ninthUuidModified: false,
    usedForceRowLevelSecurity: false,
    permissiveFallbackPolicies: false,
    calledExternalProviders: false,
    productionWritesEnabled: false,
  };
  out.snapshot = await capturePreEnableSnapshot(client);
  if (!out.snapshot.pass) {
    out.abortedBeforeEnable = true;
    out.pass = false;
    out.failingTest = `pre-enable snapshot: ${out.snapshot.mismatches.join('; ')}`;
    return out;
  }

  if (rollback) {
    out.disable = await disableRestoredRls(client);
    out.rolledBackRls = true;
    out.pass = out.disable.pass;
    return out;
  }

  if (!apply) {
    out.pass = out.snapshot.pass;
    return out;
  }

  out.enabledThisRun = false;
  if (!out.snapshot.alreadyEnabled) {
    out.enable = await enableRestoredRls(client);
    if (!out.enable.pass) {
      out.disable = await disableRestoredRls(client);
      out.rolledBackRls = true;
      out.pass = false;
      out.failingTest = `ENABLE RLS: ${out.enable.error || 'count/FORCE mismatch'}`;
      return out;
    }
    out.enabledThisRun = true;
  } else {
    out.enable = { applied: false, skippedBecauseAlreadyEnabled: true, enabled: 165, pass: true };
  }

  out.authorizationTests = await liveAuthorizationSuite(client);
  out.writeTests = await liveWriteSuite(client);
  out.regression = await regressionSuite(client);

  const failed = [];
  if (!out.authorizationTests.pass) failed.push(`authorization: ${(out.authorizationTests.failReasons || [out.authorizationTests.error]).join(', ')}`);
  if (!out.writeTests.pass) failed.push(`writes: ${(out.writeTests.failReasons || [out.writeTests.error]).join(', ')}`);
  if (!out.regression.pass) failed.push(`regression: ${out.regression.failReasons.join(', ')}`);

  if (failed.length) {
    out.failingTest = failed.join(' | ');
    out.disable = await disableRestoredRls(client);
    out.rolledBackRls = true;
    out.pass = false;
    return out;
  }

  out.rolledBackRls = false;
  out.pass = true;
  out.readyForControlledCognitoOnboarding = true;
  return out;
};
