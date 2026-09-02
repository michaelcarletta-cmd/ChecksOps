import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SQL_DIR = path.join(ROOT, '..', 'sql');
const readSql = (name) => fs.readFileSync(path.join(SQL_DIR, name), 'utf8');

export const TESTER_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
export const NINTH_ID = 'dd24eea5-5d12-47d1-999e-d5930c278b7d';
export const C1C_ADMIN_ID = 'fd857564-9534-4b0f-95ac-624ed1273725';
export const MASTER_OWNER_ID = '7dbb3009-f059-4767-b5dc-1c5c72379330';
export const FREEDOM_TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
export const C1C_TENANT = '4f172140-f57a-4744-8050-95f4f07b13b4';
export const COGNITO_SUB = '2418c458-c011-70b7-07ac-6b9da2d9415d';

export const WRITE_HELPER_NAMES = [
  'aws_is_authenticated',
  'aws_can_write_tenant',
  'aws_can_write_check',
  'aws_can_write_claim',
];

const asRole = async (client, appUserId, fn) => {
  await client.query('SAVEPOINT write_probe');
  try {
    await client.query('SET LOCAL ROLE checksops');
    if (appUserId) {
      await client.query("SELECT set_config('request.app_user_id', $1, true)", [appUserId]);
    } else {
      await client.query("SELECT set_config('request.app_user_id', '', true)");
    }
    const result = await fn();
    await client.query('ROLLBACK TO SAVEPOINT write_probe');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK TO SAVEPOINT write_probe'); } catch { /* ignore */ }
    return { error: String(error?.message || error).slice(0, 300) };
  }
};

const countResult = (result) => {
  if (result?.error) return { ok: false, n: 0, error: result.error };
  return { ok: true, n: Number(result?.rowCount || result?.n || 0) };
};

const rlsDenied = (t) => Boolean(t?.error && /row-level security|permission denied/i.test(t.error));
const expectOk = (t) => t && t.ok === true && t.n > 0;
const expectDenied = (t) => {
  if (!t) return false;
  if (rlsDenied(t)) return true;
  return t.n === 0;
};

export const investigateClaimsOwnership = async (client) => {
  const totals = (await client.query(`
    SELECT count(*)::int AS n,
           count(*) FILTER (WHERE org_id IS NULL)::int AS org_null
    FROM public.claims
  `)).rows[0];

  const assignable = (await client.query(`
    WITH signals AS (
      SELECT ci.claim_id AS claim_id, ci.tenant_id, 'intake.claim_id'::text AS src
      FROM public.check_intake_items ci
      WHERE ci.claim_id IS NOT NULL AND ci.tenant_id IS NOT NULL
      UNION ALL
      SELECT ci.freedom_claim_id, ci.tenant_id, 'intake.freedom_claim_id'
      FROM public.check_intake_items ci
      WHERE ci.freedom_claim_id IS NOT NULL AND ci.tenant_id IS NOT NULL
      UNION ALL
      SELECT c.id, ci.tenant_id, 'intake.detected_claim_number'
      FROM public.check_intake_items ci
      JOIN public.claims c ON c.claim_number = ci.detected_claim_number
      WHERE ci.detected_claim_number IS NOT NULL AND ci.tenant_id IS NOT NULL
      UNION ALL
      SELECT c.id, ci.tenant_id, 'intake.freedom_claim_number'
      FROM public.check_intake_items ci
      JOIN public.claims c ON c.claim_number = ci.freedom_claim_number
      WHERE ci.freedom_claim_number IS NOT NULL AND ci.tenant_id IS NOT NULL
      UNION ALL
      SELECT le.claim_id, le.tenant_id, 'homeowner_ledger_events.claim_id'
      FROM public.homeowner_ledger_events le
      WHERE le.claim_id IS NOT NULL AND le.tenant_id IS NOT NULL
      UNION ALL
      SELECT di.claim_id, ci.tenant_id, 'deposit_items.check_tenant'
      FROM public.deposit_items di
      JOIN public.check_intake_items ci ON ci.id = di.check_id
      WHERE di.claim_id IS NOT NULL AND ci.tenant_id IS NOT NULL
      UNION ALL
      SELECT cp.claim_id, ci.tenant_id, 'claim_payments.check_intake'
      FROM public.claim_payments cp
      JOIN public.check_intake_items ci ON ci.id = cp.check_intake_item_id
      WHERE cp.claim_id IS NOT NULL AND ci.tenant_id IS NOT NULL
    ),
    per_claim AS (
      SELECT claim_id, array_agg(DISTINCT tenant_id) AS tenants
      FROM signals
      GROUP BY claim_id
    )
    SELECT
      count(*) FILTER (WHERE cardinality(tenants) = 1)::int AS assignable,
      count(*) FILTER (WHERE cardinality(tenants) > 1)::int AS ambiguous
    FROM per_claim
  `)).rows[0];

  const none = Number(totals.n) - Number(assignable.assignable) - Number(assignable.ambiguous);
  const tenantDist = (await client.query(`
    WITH signals AS (
      SELECT ci.claim_id AS claim_id, ci.tenant_id
      FROM public.check_intake_items ci
      WHERE ci.claim_id IS NOT NULL AND ci.tenant_id IS NOT NULL
    )
    SELECT tenant_id::text AS tenant_id, count(DISTINCT claim_id)::int AS n
    FROM signals GROUP BY 1
  `)).rows;

  return {
    backfillApplied: false,
    claims: Number(totals.n),
    orgIdNull: Number(totals.org_null),
    assignable: Number(assignable.assignable),
    ambiguous: Number(assignable.ambiguous),
    none,
    assignableTenantDist: tenantDist,
    pass: Number(totals.n) === 180
      && Number(totals.org_null) === 180
      && Number(assignable.ambiguous) === 0,
  };
};

export const investigateNinthLive = async (client) => {
  const id = NINTH_ID;
  const q = async (sql, params = [id]) => (await client.query(sql, params)).rows;
  return {
    applicationUserId: id,
    emailGuessed: false,
    identityAccount: (await q(
      `SELECT application_user_id::text, cognito_sub, email, status
       FROM public.identity_accounts WHERE application_user_id = $1::uuid`,
    ))[0] || null,
    profile: (await q(`SELECT id::text, email FROM public.profiles WHERE id = $1::uuid`))[0] || null,
    userRoles: (await q(`SELECT role::text AS role FROM public.user_roles WHERE user_id = $1::uuid ORDER BY 1`))
      .map((r) => r.role),
    tenantUsers: await q(`SELECT tenant_id::text, role FROM public.tenant_users WHERE user_id = $1::uuid`),
    roleVersion: (await q(`SELECT version, updated_at FROM public.role_version_tracker WHERE user_id = $1::uuid`))[0] || null,
    vettingUploads: await q(`
      SELECT id::text, tenant_id::text, doc_type, file_name, review_status, created_at
      FROM public.tenant_vetting_documents WHERE uploaded_by = $1::uuid`),
    referrers: await q(`SELECT id::text, name, company, email, user_id::text FROM public.referrers WHERE id = $1::uuid OR user_id = $1::uuid`),
    auditLogs: Number((await q(`SELECT count(*)::int AS n FROM public.audit_logs WHERE user_id = $1::uuid`))[0].n),
    checkAuditLog: Number((await q(
      `SELECT count(*)::int AS n FROM public.check_audit_log WHERE actor_id = $1::uuid`,
    ))[0].n),
  };
};

export const inspectApplicationRole = async (client) => {
  const roles = (await client.query(`
    SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb
    FROM pg_roles
    WHERE rolname IN ('checksops', 'checksops_admin', 'authenticated', 'anon')
    ORDER BY 1
  `)).rows;
  const grants = (await client.query(`
    SELECT tableowner FROM pg_tables
    WHERE schemaname='public' AND tablename='check_intake_items'
  `)).rows[0];
  const canAlter = await asRole(client, TESTER_ID, async () => {
    await client.query('ALTER TABLE public.check_intake_items DISABLE ROW LEVEL SECURITY');
    return { rowCount: 1 };
  });
  const canCreatePolicy = await asRole(client, TESTER_ID, async () => {
    await client.query(`CREATE POLICY aws_should_not_exist ON public.check_intake_items FOR SELECT USING (true)`);
    return { rowCount: 1 };
  });
  return {
    roles,
    checkIntakeOwner: grants?.tableowner || null,
    checksopsCannotAlterRls: Boolean(canAlter.error),
    checksopsCannotCreatePolicy: Boolean(canCreatePolicy.error),
    alterError: canAlter.error || null,
    createPolicyError: canCreatePolicy.error || null,
  };
};

export const applyWriteDdl = async (client) => {
  await client.query(readSql('20_write_helpers.sql'));
  await client.query(readSql('22_write_probe_table.sql'));
  await client.query(readSql('21_proposed_write_policies.sql'));
  const policies = Number((await client.query(
    `SELECT count(*)::int AS n FROM pg_policies
     WHERE schemaname='public' AND policyname LIKE 'aws_write_%'`,
  )).rows[0].n);
  const selectPolicies = Number((await client.query(
    `SELECT count(*)::int AS n FROM pg_policies
     WHERE schemaname='public' AND policyname LIKE 'aws_select_%'`,
  )).rows[0].n);
  return { writePoliciesPrepared: policies, selectPoliciesUnchanged: selectPolicies };
};

const tryWrite = async (client, appUserId, sql, params = []) => asRole(client, appUserId, async () => {
  const result = await client.query(sql, params);
  return { rowCount: result.rowCount };
});

export const transactionalWriteTests = async (client) => {
  const rlsTables = [
    'check_intake_items',
    'check_endorsements',
    'deposit_items',
    'disbursement_batches',
    'claims',
    'claim_files',
    'claim_folders',
    'payment_provider_accounts',
    'payment_webhook_events',
    'payment_idempotency_keys',
    'homeowner_ledger_events',
    'tenant_email_settings',
    'user_roles',
    'tenants',
  ];
  const alreadyOn = [];
  for (const table of rlsTables) {
    const on = (await client.query(
      `SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relname=$1`,
      [table],
    )).rows[0]?.relrowsecurity;
    if (on) alreadyOn.push(table);
  }
  if (alreadyOn.length) {
    return { skipped: true, reason: `RLS already enabled: ${alreadyOn.join(',')}` };
  }

  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL session_replication_role = replica');
    for (const table of rlsTables) {
      await client.query(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
    }

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
    const c1cProvider = (await client.query(
      `SELECT id::text AS id FROM public.payment_provider_accounts WHERE tenant_id=$1::uuid LIMIT 1`,
      [C1C_TENANT],
    )).rows[0];

    const tests = {};

    tests.staffInsertFreedomProbe = countResult(await tryWrite(
      client, TESTER_ID,
      `INSERT INTO public._aws_rls_write_probe (tenant_id, label, note)
       VALUES ($1::uuid, 'staff-freedom-write', 'ok')`,
      [FREEDOM_TENANT],
    ));
    tests.staffInsertC1cDenied = countResult(await tryWrite(
      client, TESTER_ID,
      `INSERT INTO public._aws_rls_write_probe (tenant_id, label)
       VALUES ($1::uuid, 'staff-c1c-denied')`,
      [C1C_TENANT],
    ));
    tests.tenantAdminInsertC1c = countResult(await tryWrite(
      client, C1C_ADMIN_ID,
      `INSERT INTO public._aws_rls_write_probe (tenant_id, label)
       VALUES ($1::uuid, 'admin-c1c-write')`,
      [C1C_TENANT],
    ));
    tests.tenantAdminInsertFreedomDenied = countResult(await tryWrite(
      client, C1C_ADMIN_ID,
      `INSERT INTO public._aws_rls_write_probe (tenant_id, label)
       VALUES ($1::uuid, 'admin-freedom-denied')`,
      [FREEDOM_TENANT],
    ));
    tests.ninthInsertDenied = countResult(await tryWrite(
      client, NINTH_ID,
      `INSERT INTO public._aws_rls_write_probe (tenant_id, label)
       VALUES ($1::uuid, 'ninth-denied')`,
      [FREEDOM_TENANT],
    ));
    tests.unauthenticatedInsertDenied = countResult(await tryWrite(
      client, null,
      `INSERT INTO public._aws_rls_write_probe (tenant_id, label)
       VALUES ($1::uuid, 'unauth-denied')`,
      [FREEDOM_TENANT],
    ));
    tests.cognitoSubInsertDenied = countResult(await tryWrite(
      client, COGNITO_SUB,
      `INSERT INTO public._aws_rls_write_probe (tenant_id, label)
       VALUES ($1::uuid, 'sub-denied')`,
      [FREEDOM_TENANT],
    ));
    tests.masterInsertC1c = countResult(await tryWrite(
      client, MASTER_OWNER_ID,
      `INSERT INTO public._aws_rls_write_probe (tenant_id, label)
       VALUES ($1::uuid, 'master-c1c-write')`,
      [C1C_TENANT],
    ));

    if (freedomCheck) {
      tests.staffUpdateFreedomCheck = countResult(await tryWrite(
        client, TESTER_ID,
        `UPDATE public.check_intake_items SET review_notes = coalesce(review_notes,'') WHERE id=$1::uuid`,
        [freedomCheck.id],
      ));
      tests.tenantAdminUpdateFreedomCheckDenied = countResult(await tryWrite(
        client, C1C_ADMIN_ID,
        `UPDATE public.check_intake_items SET review_notes = 'cross-tenant' WHERE id=$1::uuid`,
        [freedomCheck.id],
      ));
      tests.unauthUpdateFreedomCheckDenied = countResult(await tryWrite(
        client, null,
        `UPDATE public.check_intake_items SET review_notes = 'unauth' WHERE id=$1::uuid`,
        [freedomCheck.id],
      ));
    }
    if (freedomDeposit) {
      tests.uuidOracleDepositUpdateDenied = countResult(await tryWrite(
        client, C1C_ADMIN_ID,
        `UPDATE public.deposit_items SET exception_reason = 'uuid-guess' WHERE id=$1::uuid`,
        [freedomDeposit.id],
      ));
      tests.staffUpdateFreedomDeposit = countResult(await tryWrite(
        client, TESTER_ID,
        `UPDATE public.deposit_items SET exception_reason = coalesce(exception_reason,'') WHERE id=$1::uuid`,
        [freedomDeposit.id],
      ));
    }
    if (c1cProvider) {
      tests.staffUpdateC1cProviderDenied = countResult(await tryWrite(
        client, TESTER_ID,
        `UPDATE public.payment_provider_accounts SET updated_at = now() WHERE id=$1::uuid`,
        [c1cProvider.id],
      ));
      tests.tenantAdminUpdateC1cProvider = countResult(await tryWrite(
        client, C1C_ADMIN_ID,
        `UPDATE public.payment_provider_accounts SET updated_at = now() WHERE id=$1::uuid`,
        [c1cProvider.id],
      ));
    }

    tests.webhookInsertDeniedStaff = countResult(await tryWrite(
      client, TESTER_ID,
      `INSERT INTO public.payment_webhook_events
         (provider, environment, external_event_id, event_type, tenant_id, payload)
       VALUES ('aws-write-test', 'sandbox', 'aws-write-test', 'test.event', $1::uuid, '{}'::jsonb)`,
      [FREEDOM_TENANT],
    ));
    tests.idempotencyInsertDeniedAdmin = countResult(await tryWrite(
      client, C1C_ADMIN_ID,
      `INSERT INTO public.payment_idempotency_keys
         (tenant_id, provider, scope, idempotency_key, status)
       VALUES ($1::uuid, 'aws-write-test', 'test', 'aws-write-test', 'started')`,
      [C1C_TENANT],
    ));

    tests.staffInsertSyntheticCheck = countResult(await tryWrite(
      client, TESTER_ID,
      `INSERT INTO public.check_intake_items (tenant_id, front_image_path, status)
       VALUES ($1::uuid, 'aws-rls-write-test/front.png', 'uploaded')`,
      [FREEDOM_TENANT],
    ));
    tests.adminInsertSyntheticCheckCrossDenied = countResult(await tryWrite(
      client, C1C_ADMIN_ID,
      `INSERT INTO public.check_intake_items (tenant_id, front_image_path, status)
       VALUES ($1::uuid, 'aws-rls-write-test/cross.png', 'uploaded')`,
      [FREEDOM_TENANT],
    ));

    await client.query('ROLLBACK');

    const stillOn = [];
    for (const table of rlsTables) {
      const on = (await client.query(
        `SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname='public' AND c.relname=$1`,
        [table],
      )).rows[0]?.relrowsecurity;
      if (on) stillOn.push(table);
    }

    const pass = expectOk(tests.staffInsertFreedomProbe)
      && expectDenied(tests.staffInsertC1cDenied)
      && expectOk(tests.tenantAdminInsertC1c)
      && expectDenied(tests.tenantAdminInsertFreedomDenied)
      && expectDenied(tests.ninthInsertDenied)
      && expectDenied(tests.unauthenticatedInsertDenied)
      && expectDenied(tests.cognitoSubInsertDenied)
      && expectOk(tests.masterInsertC1c)
      && (!tests.staffUpdateFreedomCheck || expectOk(tests.staffUpdateFreedomCheck))
      && (!tests.tenantAdminUpdateFreedomCheckDenied || expectDenied(tests.tenantAdminUpdateFreedomCheckDenied))
      && (!tests.unauthUpdateFreedomCheckDenied || expectDenied(tests.unauthUpdateFreedomCheckDenied))
      && (!tests.uuidOracleDepositUpdateDenied || expectDenied(tests.uuidOracleDepositUpdateDenied))
      && (!tests.staffUpdateFreedomDeposit || expectOk(tests.staffUpdateFreedomDeposit))
      && (!tests.staffUpdateC1cProviderDenied || expectDenied(tests.staffUpdateC1cProviderDenied))
      && (!tests.tenantAdminUpdateC1cProvider || expectOk(tests.tenantAdminUpdateC1cProvider))
      && expectDenied(tests.webhookInsertDeniedStaff)
      && expectDenied(tests.idempotencyInsertDeniedAdmin)
      && expectOk(tests.staffInsertSyntheticCheck)
      && expectDenied(tests.adminInsertSyntheticCheckCrossDenied)
      && stillOn.length === 0;

    return {
      skipped: false,
      rolledBack: true,
      persistedFinancialWrites: false,
      calledExternalProviders: false,
      rlsLeftEnabled: stillOn,
      tests,
      pass,
    };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    return { skipped: false, rolledBack: true, error: String(error?.message || error).slice(0, 600) };
  }
};
