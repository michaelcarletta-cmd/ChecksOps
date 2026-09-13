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
  investigateClaimsOwnership,
} from './writePlan.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SQL_DIR = path.join(ROOT, '..', 'sql');
const CLASS_DIR = path.join(ROOT, '..', 'classification');
const readSql = (name) => fs.readFileSync(path.join(SQL_DIR, name), 'utf8');

const ASSIGNABLE_IDS = JSON.parse(
  fs.readFileSync(path.join(CLASS_DIR, 'claims_ownership.json'), 'utf8'),
).assignable.map((row) => row.claim_id);

const asRole = async (client, appUserId, fn) => {
  await client.query('SAVEPOINT complete_probe');
  try {
    await client.query('SET LOCAL ROLE checksops');
    if (appUserId) {
      await client.query("SELECT set_config('request.app_user_id', $1, true)", [appUserId]);
    } else {
      await client.query("SELECT set_config('request.app_user_id', '', true)");
    }
    const result = await fn();
    await client.query('ROLLBACK TO SAVEPOINT complete_probe');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK TO SAVEPOINT complete_probe'); } catch { /* ignore */ }
    return { error: String(error?.message || error).slice(0, 400) };
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

const tryWrite = async (client, appUserId, sql, params = []) => asRole(client, appUserId, async () => {
  const result = await client.query(sql, params);
  return { rowCount: result.rowCount };
});

const trySelectN = async (client, appUserId, sql, params = []) => asRole(client, appUserId, async () => {
  const result = await client.query(sql, params);
  return { n: Number(result.rows[0]?.n || 0), rowCount: Number(result.rows[0]?.n || 0) };
});

const applySqlFile = async (client, name) => {
  const sql = readSql(name);
  const stmts = sql.split(/;\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('--'));
  for (const stmt of stmts) {
    try {
      await client.query(`${stmt};`);
    } catch (error) {
      throw new Error(`${name} near ${stmt.slice(0, 140)}: ${error?.message || error}`);
    }
  }
};

export const applyCompleteDdl = async (client) => {
  await client.query(readSql('11_access_helpers.sql'));
  await client.query(readSql('20_write_helpers.sql'));
  await client.query(readSql('15_access_grants.sql'));
  await client.query(readSql('31_partner_safe_read.sql'));
  await client.query(readSql('22_write_probe_table.sql'));
  await client.query(readSql('21_proposed_write_policies.sql'));
  await client.query(readSql('24_complete_write_policies.sql'));
  // 29 requires 11 + 20 + 24. Immediate PUBLIC revokes live inside 29 itself.
  await client.query(readSql('29_mortgage_ops_library_parity.sql'));
  // 30_tenant_documents_mortgage_doc_type.sql is a separate unapplied operator
  // package. Do not apply it from completeAuth.
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
  return {
    selectPolicies,
    writePolicies,
    dumpPolicies,
    expectedWritePolicies: 127,
    selectPoliciesUnchanged: selectPolicies === 165,
  };
};

const parseFkTargets = () => {
  const sql = readSql('25_fk_retarget.sql');
  const targets = [];
  const re = /ALTER TABLE public\.(\w+) ADD CONSTRAINT (\w+) FOREIGN KEY \((\w+)\) REFERENCES public\.identity_accounts\(application_user_id\) (ON DELETE .+? NOT VALID);/g;
  let match;
  while ((match = re.exec(sql))) {
    targets.push({
      table: match[1],
      constraint: match[2],
      column: match[3],
      onDelete: match[4],
    });
  }
  return targets;
};

export const applyFkRetargets = async (client, orphanScan) => {
  if (!orphanScan?.pass) {
    return { applied: false, skipped: true, reason: 'orphans present or ninth UUID missing from identity_accounts' };
  }
  const targets = parseFkTargets();
  if (targets.length !== 47) {
    return { applied: false, skipped: true, reason: `parsed ${targets.length} FK targets, expected 47` };
  }
  const truncated = (await client.query(`
    SELECT n.nspname AS schema_name, c.relname AS table_name, con.conname
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND con.conname LIKE '%identity_fke'
      AND con.conname NOT LIKE '%_identity_fkey'
  `)).rows;
  for (const row of truncated) {
    await client.query(`ALTER TABLE public.${row.table_name} DROP CONSTRAINT IF EXISTS ${row.conname}`);
  }
  const added = [];
  const existed = [];
  const errors = [];
  for (const target of targets) {
    const found = (await client.query(
      `SELECT conname FROM pg_constraint WHERE conname = $1`,
      [target.constraint],
    )).rows[0];
    if (found) {
      existed.push(target.constraint);
    } else {
      try {
        await client.query(
          `ALTER TABLE public.${target.table}
             ADD CONSTRAINT ${target.constraint}
             FOREIGN KEY (${target.column})
             REFERENCES public.identity_accounts(application_user_id)
             ${target.onDelete}`,
        );
        added.push(target.constraint);
      } catch (error) {
        errors.push({ constraint: target.constraint, error: String(error?.message || error).slice(0, 240) });
      }
    }
    try {
      await client.query(`ALTER TABLE public.${target.table} VALIDATE CONSTRAINT ${target.constraint}`);
    } catch (error) {
      errors.push({ constraint: target.constraint, phase: 'validate', error: String(error?.message || error).slice(0, 240) });
    }
  }
  const present = (await client.query(
    `SELECT conname FROM pg_constraint WHERE conname LIKE '%_identity_fkey' ORDER BY 1`,
  )).rows.map((row) => row.conname);
  const missing = targets.map((t) => t.constraint).filter((name) => !present.includes(name));
  return {
    applied: true,
    skipped: false,
    droppedTruncated: truncated.map((row) => row.conname),
    added: added.length,
    alreadyExisted: existed.length,
    identityFkeys: present.length,
    expected: 47,
    missing,
    errors,
    pass: present.length === 47 && missing.length === 0 && errors.length === 0,
  };
};

export const scanFkOrphans = async (client) => {
  const targets = parseFkTargets();
  if (targets.length !== 47) {
    return { pass: false, error: `expected 47 FK targets, parsed ${targets.length}` };
  }
  const ninthPresent = Boolean((await client.query(
    `SELECT 1 FROM public.identity_accounts WHERE application_user_id = $1::uuid`,
    [NINTH_ID],
  )).rows[0]);
  const identityCount = Number((await client.query(
    `SELECT count(*)::int AS n FROM public.identity_accounts`,
  )).rows[0].n);
  const perConstraint = [];
  const orphanValues = [];
  for (const target of targets) {
    const { rows } = await client.query(`
      SELECT DISTINCT t.${target.column}::text AS application_user_id
      FROM public.${target.table} t
      WHERE t.${target.column} IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM public.identity_accounts ia
          WHERE ia.application_user_id = t.${target.column}
        )
    `);
    perConstraint.push({
      table: target.table,
      column: target.column,
      constraint: target.constraint,
      orphanDistinct: rows.length,
    });
    for (const row of rows) orphanValues.push({ ...target, application_user_id: row.application_user_id });
  }
  return {
    constraintCount: targets.length,
    identityAccountRows: identityCount,
    ninthUuidInIdentityAccounts: ninthPresent,
    ninthCognitoRequired: false,
    orphanDistinct: [...new Set(orphanValues.map((r) => r.application_user_id))].length,
    orphanRows: orphanValues.slice(0, 50),
    perConstraint: perConstraint.filter((r) => r.orphanDistinct > 0),
    pass: ninthPresent && orphanValues.length === 0,
  };
};

export const backfillAssignableClaims = async (client) => {
  const live = await investigateClaimsOwnership(client);
  const jsonSet = new Set(ASSIGNABLE_IDS);
  if (jsonSet.size !== 83) {
    return { applied: false, error: `claims_ownership.json has ${jsonSet.size} ids, expected 83` };
  }
  if (live.assignable !== 83 || live.ambiguous !== 0) {
    return { applied: false, live, error: 'live mapping is not 83 assignable / 0 ambiguous' };
  }
  const liveIds = (await client.query(`
    WITH signals AS (
      SELECT c.id AS claim_id, s.tenant_id
      FROM public.claims c
      JOIN (
        SELECT ci.claim_id AS claim_id, ci.tenant_id
        FROM public.check_intake_items ci
        WHERE ci.claim_id IS NOT NULL AND ci.tenant_id IS NOT NULL
        UNION ALL
        SELECT ci.freedom_claim_id, ci.tenant_id
        FROM public.check_intake_items ci
        WHERE ci.freedom_claim_id IS NOT NULL AND ci.tenant_id IS NOT NULL
        UNION ALL
        SELECT c2.id, ci.tenant_id
        FROM public.check_intake_items ci
        JOIN public.claims c2 ON c2.claim_number = ci.detected_claim_number
        WHERE ci.detected_claim_number IS NOT NULL AND ci.tenant_id IS NOT NULL
        UNION ALL
        SELECT c2.id, ci.tenant_id
        FROM public.check_intake_items ci
        JOIN public.claims c2 ON c2.claim_number = ci.freedom_claim_number
        WHERE ci.freedom_claim_number IS NOT NULL AND ci.tenant_id IS NOT NULL
        UNION ALL
        SELECT le.claim_id, le.tenant_id
        FROM public.homeowner_ledger_events le
        WHERE le.claim_id IS NOT NULL AND le.tenant_id IS NOT NULL
        UNION ALL
        SELECT di.claim_id, ci.tenant_id
        FROM public.deposit_items di
        JOIN public.check_intake_items ci ON ci.id = di.check_id
        WHERE di.claim_id IS NOT NULL AND ci.tenant_id IS NOT NULL
        UNION ALL
        SELECT cp.claim_id, ci.tenant_id
        FROM public.claim_payments cp
        JOIN public.check_intake_items ci ON ci.id = cp.check_intake_item_id
        WHERE cp.claim_id IS NOT NULL AND ci.tenant_id IS NOT NULL
      ) s ON s.claim_id = c.id
    ),
    per_claim AS (
      SELECT claim_id, array_agg(DISTINCT tenant_id) AS tenants
      FROM signals
      GROUP BY claim_id
      HAVING cardinality(array_agg(DISTINCT tenant_id)) = 1
    )
    SELECT claim_id::text AS claim_id, tenants[1]::text AS tenant_id
    FROM per_claim
  `)).rows;
  if (liveIds.length !== 83) {
    return { applied: false, error: `live assignable id list is ${liveIds.length}` };
  }
  const mismatch = liveIds.filter((row) => !jsonSet.has(row.claim_id) || row.tenant_id !== FREEDOM_TENANT);
  const missingFromLive = [...jsonSet].filter((id) => !liveIds.some((row) => row.claim_id === id));
  if (mismatch.length || missingFromLive.length) {
    return {
      applied: false,
      error: 'JSON assignable set does not match live deterministic set',
      mismatch: mismatch.slice(0, 10),
      missingFromLive: missingFromLive.slice(0, 10),
    };
  }

  const before = (await client.query(`
    SELECT
      count(*)::int AS n,
      count(*) FILTER (WHERE org_id IS NULL)::int AS org_null,
      count(*) FILTER (WHERE org_id = $1::uuid)::int AS freedom,
      count(*) FILTER (WHERE org_id IS NOT NULL AND org_id <> $1::uuid)::int AS other
    FROM public.claims
  `, [FREEDOM_TENANT])).rows[0];
  const beforeIds = (await client.query(`
    SELECT id::text AS claim_id, org_id::text AS org_id
    FROM public.claims
    WHERE id = ANY($1::uuid[])
    ORDER BY 1
  `, [ASSIGNABLE_IDS])).rows;

  let rowsUpdated = 0;
  let skippedBecauseAlreadyApplied = false;
  if (Number(before.freedom) === 83 && Number(before.org_null) === 97 && Number(before.other) === 0) {
    skippedBecauseAlreadyApplied = true;
  } else if (Number(before.org_null) === 180 && Number(before.freedom) === 0) {
    const updated = await client.query(readSql('23_claims_org_backfill.sql'));
    rowsUpdated = Number(updated.rowCount || 0);
  } else {
    return { applied: false, before, error: 'unexpected claims.org_id distribution before backfill' };
  }

  const after = (await client.query(`
    SELECT
      count(*)::int AS n,
      count(*) FILTER (WHERE org_id IS NULL)::int AS org_null,
      count(*) FILTER (WHERE org_id = $1::uuid)::int AS freedom,
      count(*) FILTER (WHERE org_id IS NOT NULL AND org_id <> $1::uuid)::int AS other
    FROM public.claims
  `, [FREEDOM_TENANT])).rows[0];
  const afterIds = (await client.query(`
    SELECT id::text AS claim_id, org_id::text AS org_id
    FROM public.claims
    WHERE id = ANY($1::uuid[])
    ORDER BY 1
  `, [ASSIGNABLE_IDS])).rows;
  const stillNullAssignable = afterIds.filter((row) => row.org_id !== FREEDOM_TENANT);
  const unassignedTouched = Number((await client.query(`
    SELECT count(*)::int AS n
    FROM public.claims
    WHERE org_id IS NOT NULL
      AND id <> ALL($1::uuid[])
  `, [ASSIGNABLE_IDS])).rows[0].n);

  return {
    applied: true,
    liveBefore: live,
    jsonIds: 83,
    before,
    after,
    rowsUpdated,
    skippedBecauseAlreadyApplied,
    assignableAfterFreedom: afterIds.filter((row) => row.org_id === FREEDOM_TENANT).length,
    stillNullAssignable: stillNullAssignable.length,
    unassignedClaimsTouched: unassignedTouched,
    beforeSample: beforeIds.slice(0, 5),
    afterSample: afterIds.slice(0, 5),
    pass: Number(after.n) === 180
      && Number(after.freedom) === 83
      && Number(after.org_null) === 97
      && Number(after.other) === 0
      && (skippedBecauseAlreadyApplied || rowsUpdated === 83)
      && stillNullAssignable.length === 0
      && unassignedTouched === 0,
  };
};

export const completeAuthorizationTests = async (client) => {
  const rlsTables = [
    'check_intake_items',
    'deposit_items',
    'claims',
    'claim_files',
    'claim_folders',
    'payment_provider_accounts',
    'payment_webhook_events',
    'checkalt_config',
    'company_branding',
    'user_roles',
    'tenants',
    'homeowner_ledger_events',
    'tenant_email_settings',
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
    await client.query(`
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
        public.check_intake_items,
        public.deposit_items,
        public.claims,
        public.claim_files,
        public.claim_folders,
        public.payment_provider_accounts,
        public.payment_webhook_events,
        public.checkalt_config,
        public.company_branding,
        public.user_roles,
        public.tenants,
        public.homeowner_ledger_events,
        public.tenant_email_settings
      TO checksops
    `);

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
    const claimCountSql = `
      SELECT count(*)::int AS n,
             count(*) FILTER (WHERE org_id = '${FREEDOM_TENANT}')::int AS freedom,
             count(*) FILTER (WHERE org_id IS NULL)::int AS org_null
      FROM public.claims
    `;
    const asCounts = async (id) => {
      const result = await asRole(client, id, async () => {
        const { rows } = await client.query(claimCountSql);
        return rows[0];
      });
      if (result?.error) return { n: 0, freedom: 0, org_null: 0, error: result.error };
      return {
        n: Number(result.n || 0),
        freedom: Number(result.freedom || 0),
        org_null: Number(result.org_null || 0),
      };
    };
    tests.staffClaims = await asCounts(TESTER_ID);
    tests.c1cClaims = await asCounts(C1C_ADMIN_ID);
    tests.masterClaims = await asCounts(MASTER_OWNER_ID);
    tests.ninthClaims = await asCounts(NINTH_ID);
    tests.unauthClaims = await asCounts(null);
    tests.cognitoSubClaims = await asCounts(COGNITO_SUB);

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
      tests.c1cUpdateNullClaimDenied = countResult(await tryWrite(
        client, C1C_ADMIN_ID,
        `UPDATE public.claims SET status = status WHERE id=$1::uuid`,
        [nullClaim.id],
      ));
      tests.staffSelectNullClaimFolders = countResult(await trySelectN(
        client, TESTER_ID,
        `SELECT count(*)::int AS n FROM public.claim_folders WHERE claim_id=$1::uuid`,
        [nullClaim.id],
      ));
      tests.c1cSelectNullClaimFolders = countResult(await trySelectN(
        client, C1C_ADMIN_ID,
        `SELECT count(*)::int AS n FROM public.claim_folders WHERE claim_id=$1::uuid`,
        [nullClaim.id],
      ));
      tests.masterSelectNullClaimFolders = countResult(await trySelectN(
        client, MASTER_OWNER_ID,
        `SELECT count(*)::int AS n FROM public.claim_folders WHERE claim_id=$1::uuid`,
        [nullClaim.id],
      ));
    }
    if (freedomCheck) {
      tests.uuidOracleCheckUpdateDenied = countResult(await tryWrite(
        client, C1C_ADMIN_ID,
        `UPDATE public.check_intake_items SET review_notes = 'uuid-guess' WHERE id=$1::uuid`,
        [freedomCheck.id],
      ));
      tests.staffUpdateFreedomCheck = countResult(await tryWrite(
        client, TESTER_ID,
        `UPDATE public.check_intake_items SET review_notes = coalesce(review_notes,'') WHERE id=$1::uuid`,
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
       VALUES ('aws-complete-test', 'sandbox', 'aws-complete-test', 'test.event', $1::uuid, '{}'::jsonb)`,
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
        `INSERT INTO public.company_branding (company_name) VALUES ('aws-complete-test')`,
      ));
    }
    tests.ninthInsertProbeDenied = countResult(await tryWrite(
      client, NINTH_ID,
      `INSERT INTO public._aws_rls_write_probe (tenant_id, label)
       VALUES ($1::uuid, 'ninth-complete-denied')`,
      [FREEDOM_TENANT],
    ));
    tests.staffInsertFreedomProbe = countResult(await tryWrite(
      client, TESTER_ID,
      `INSERT INTO public._aws_rls_write_probe (tenant_id, label)
       VALUES ($1::uuid, 'staff-complete-ok')`,
      [FREEDOM_TENANT],
    ));
    tests.c1cInsertFreedomProbeDenied = countResult(await tryWrite(
      client, C1C_ADMIN_ID,
      `INSERT INTO public._aws_rls_write_probe (tenant_id, label)
       VALUES ($1::uuid, 'admin-complete-cross')`,
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

    const pass = tests.staffClaims.freedom === 83
      && tests.staffClaims.org_null === 0
      && tests.c1cClaims.freedom === 0
      && tests.c1cClaims.org_null === 0
      && tests.masterClaims.n === 180
      && tests.masterClaims.org_null === 97
      && tests.ninthClaims.n === 0
      && tests.unauthClaims.n === 0
      && tests.cognitoSubClaims.n === 0
      && (!tests.staffUpdateAssignedClaim || expectOk(tests.staffUpdateAssignedClaim))
      && (!tests.c1cUpdateAssignedClaimDenied || expectDenied(tests.c1cUpdateAssignedClaimDenied))
      && (!tests.staffUpdateNullClaimDenied || expectDenied(tests.staffUpdateNullClaimDenied))
      && (!tests.c1cUpdateNullClaimDenied || expectDenied(tests.c1cUpdateNullClaimDenied))
      && (!tests.staffSelectNullClaimFolders || tests.staffSelectNullClaimFolders.n === 0)
      && (!tests.c1cSelectNullClaimFolders || tests.c1cSelectNullClaimFolders.n === 0)
      && (!tests.masterSelectNullClaimFolders || tests.masterSelectNullClaimFolders.n > 0)
      && (!tests.uuidOracleCheckUpdateDenied || expectDenied(tests.uuidOracleCheckUpdateDenied))
      && (!tests.staffUpdateFreedomCheck || expectOk(tests.staffUpdateFreedomCheck))
      && (!tests.c1cUpdateFreedomDepositDenied || expectDenied(tests.c1cUpdateFreedomDepositDenied))
      && expectDenied(tests.staffInsertWebhookDenied)
      && expectDenied(tests.staffUpdateCheckaltDenied)
      && expectDenied(tests.masterUpdateCheckaltDenied)
      && expectDenied(tests.staffUpdateBrandingDenied)
      && expectOk(tests.masterUpdateBranding)
      && expectDenied(tests.ninthInsertProbeDenied)
      && expectOk(tests.staffInsertFreedomProbe)
      && expectDenied(tests.c1cInsertFreedomProbeDenied)
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
    return { skipped: false, rolledBack: true, error: String(error?.message || error).slice(0, 800) };
  }
};

export const runCompleteAuth = async (client) => {
  const out = {};
  out.writeDdl = await applyCompleteDdl(client);
  out.claimsBackfill = await backfillAssignableClaims(client);
  out.fkOrphans = await scanFkOrphans(client);
  out.fkRetarget = await applyFkRetargets(client, out.fkOrphans);
  out.applicationRoleInspection = await inspectApplicationRole(client);
  out.authorizationTests = await completeAuthorizationTests(client);
  return out;
};
