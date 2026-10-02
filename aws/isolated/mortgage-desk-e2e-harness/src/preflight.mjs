import {
  CLAIM_MARKER_PREFIX,
  EXPECTED_ADDITIONAL_RATE_CENTS,
  EXPECTED_INITIAL_RATE_CENTS,
  FIXTURE_TABLES,
  FREEDOM_TENANT_ID,
  MORTGAGE_AGENT_EMAIL,
  MORTGAGE_AGENT_USER_ID,
  STAGING_API_URL,
  STAGING_DATABASE_NAME,
  STAGING_DB_USER,
} from './constants.mjs';
import { cleanupPlan } from './cleanup.mjs';
import { closeClient, loadStagingAppSecret, openReadOnlyClient, readOnlyQuery } from './db.mjs';
import { evaluateFailClosed } from './fail-closed.mjs';
import { describeWorkflowPlan } from './workflow-plan.mjs';

const PRIVILEGE_SQL = `
  SELECT table_name, privilege_type
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public'
    AND grantee = current_user
    AND table_name = ANY($1::text[])
  ORDER BY table_name, privilege_type
`;

const EFFECTIVE_PRIVILEGE_SQL = `
  SELECT
    t AS table_name,
    has_table_privilege(current_user, format('public.%I', t), 'SELECT') AS select,
    has_table_privilege(current_user, format('public.%I', t), 'INSERT') AS insert,
    has_table_privilege(current_user, format('public.%I', t), 'UPDATE') AS update,
    has_table_privilege(current_user, format('public.%I', t), 'DELETE') AS delete
  FROM unnest($1::text[]) AS t
`;

const COLUMN_SQL = `
  SELECT table_name, column_name, is_nullable, data_type, column_default
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = ANY($1::text[])
  ORDER BY table_name, ordinal_position
`;

const FK_SQL = `
  SELECT
    src.relname AS from_table,
    src_att.attname AS from_column,
    tgt.relname AS to_table,
    tgt_att.attname AS to_column,
    CASE con.confdeltype
      WHEN 'a' THEN 'NO ACTION'
      WHEN 'r' THEN 'RESTRICT'
      WHEN 'c' THEN 'CASCADE'
      WHEN 'n' THEN 'SET NULL'
      WHEN 'd' THEN 'SET DEFAULT'
    END AS delete_rule,
    CASE con.confupdtype
      WHEN 'a' THEN 'NO ACTION'
      WHEN 'r' THEN 'RESTRICT'
      WHEN 'c' THEN 'CASCADE'
      WHEN 'n' THEN 'SET NULL'
      WHEN 'd' THEN 'SET DEFAULT'
    END AS update_rule,
    con.conname AS constraint_name
  FROM pg_constraint con
  JOIN pg_class src ON src.oid = con.conrelid
  JOIN pg_namespace nsp ON nsp.oid = src.relnamespace
  JOIN pg_class tgt ON tgt.oid = con.confrelid
  JOIN unnest(con.conkey) WITH ORDINALITY AS src_cols(attnum, ord) ON TRUE
  JOIN unnest(con.confkey) WITH ORDINALITY AS tgt_cols(attnum, ord) ON tgt_cols.ord = src_cols.ord
  JOIN pg_attribute src_att ON src_att.attrelid = src.oid AND src_att.attnum = src_cols.attnum
  JOIN pg_attribute tgt_att ON tgt_att.attrelid = tgt.oid AND tgt_att.attnum = tgt_cols.attnum
  WHERE con.contype = 'f'
    AND nsp.nspname = 'public'
    AND (src.relname = ANY($1::text[]) OR tgt.relname = ANY($1::text[]))
  ORDER BY from_table, from_column
`;

const NOT_NULL_SQL = `
  SELECT table_name, column_name
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = ANY($1::text[])
    AND is_nullable = 'NO'
  ORDER BY table_name, column_name
`;

export const probeStagingApiReadOnly = async (fetchImpl = fetch) => {
  const results = {};
  const getStatus = await fetchImpl(`${STAGING_API_URL}/workflow/status`, { method: 'GET' });
  let statusJson = {};
  try { statusJson = await getStatus.json(); } catch { statusJson = {}; }
  results.workflowStatus = {
    httpStatus: getStatus.status,
    applicationWorkflowWritesEnabled: statusJson.flags?.AWS_APPLICATION_WORKFLOW_WRITES_ENABLED ?? null,
    providerExecutionEnabled: statusJson.flags?.AWS_PROVIDER_EXECUTION_ENABLED ?? null,
    moovEnabled: statusJson.flags?.AWS_MOOV_ENABLED ?? null,
    checkaltEnabled: statusJson.flags?.AWS_CHECKALT_ENABLED ?? null,
  };
  for (const path of ['/data/query', '/data/write', '/data/rpc']) {
    const response = await fetchImpl(`${STAGING_API_URL}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    results[path] = { httpStatus: response.status, expectedUnauthenticated: [401, 403].includes(response.status) };
  }
  return results;
};

const privilegeMap = (rows) => {
  const out = {};
  for (const row of rows) {
    out[row.table_name] ||= { SELECT: false, INSERT: false, UPDATE: false, DELETE: false };
    out[row.table_name][row.privilege_type] = true;
  }
  return out;
};

const effectivePrivilegeMap = (rows) => {
  const out = {};
  for (const row of rows) {
    out[row.table_name] = {
      SELECT: Boolean(row.select),
      INSERT: Boolean(row.insert),
      UPDATE: Boolean(row.update),
      DELETE: Boolean(row.delete),
    };
  }
  return out;
};

const applyReadOnlyIdentityContext = async (client) => {
  await readOnlyQuery(
    client,
    `SELECT set_config('request.app_user_id', $1, true) AS app_user_id`,
    [MORTGAGE_AGENT_USER_ID],
  );
  await readOnlyQuery(
    client,
    `SELECT set_config('request.jwt.claim.email', $1, true) AS email`,
    [MORTGAGE_AGENT_EMAIL],
  );
  const uid = (await readOnlyQuery(client, `SELECT auth.uid()::text AS auth_uid`)).rows[0]?.auth_uid || null;
  return { applied: true, authUid: uid };
};

export const runReadOnlyPreflight = async ({
  shas,
  getSecretString,
  fetchImpl = fetch,
  openClient = openReadOnlyClient,
} = {}) => {
  const started = Date.now();
  const out = {
    ok: false,
    action: 'preflight',
    readOnly: true,
    rowsCreated: 0,
    rowsUpdated: 0,
    rowsDeleted: 0,
    syntheticRowsCreated: 0,
    preExistingRowsMutated: 0,
    grantsIssued: 0,
    workflowPlan: describeWorkflowPlan(),
    shas,
  };

  const envGate = evaluateFailClosed(process.env, {
    functionName: process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.HARNESS_FUNCTION_NAME,
  });
  out.envGate = envGate;
  if (!envGate.ok) {
    out.error = 'fail_closed_env';
    return out;
  }
  if (!shas?.unchanged) {
    out.error = 'application_sha_drift';
    return out;
  }

  let client;
  try {
    const credentials = await loadStagingAppSecret(getSecretString);
    client = await openClient(credentials);
    const identity = (await readOnlyQuery(
      client,
      `SELECT current_database() AS current_database,
              current_user AS current_user,
              inet_server_addr()::text AS server_addr,
              current_setting('default_transaction_read_only') AS default_transaction_read_only,
              current_setting('transaction_read_only') AS transaction_read_only`,
    )).rows[0];
    if (!identity) {
      out.error = 'database_identity_missing';
      return out;
    }
    const dbGate = evaluateFailClosed(process.env, {
      functionName: process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.HARNESS_FUNCTION_NAME,
      currentDatabase: identity.current_database,
      currentUser: identity.current_user,
      secretUser: credentials.username,
      secretHost: credentials.host,
      secretName: credentials.secretName,
    });
    out.identity = {
      current_database: identity.current_database,
      current_user: identity.current_user,
      transaction_read_only: identity.transaction_read_only,
      default_transaction_read_only: identity.default_transaction_read_only,
      secretName: credentials.secretName,
      secretUser: credentials.username,
      secretHost: credentials.host,
    };
    out.dbGate = dbGate;
    if (!dbGate.ok) {
      out.error = 'fail_closed_database_identity';
      return out;
    }
    if (identity.transaction_read_only !== 'on') {
      out.error = 'transaction_not_read_only';
      return out;
    }

    const privilegeRows = (await readOnlyQuery(client, PRIVILEGE_SQL, [FIXTURE_TABLES])).rows;
    const effectiveRows = (await readOnlyQuery(client, EFFECTIVE_PRIVILEGE_SQL, [FIXTURE_TABLES])).rows;
    out.directGrantsToCurrentUser = privilegeMap(privilegeRows);
    out.privileges = effectivePrivilegeMap(effectiveRows);
    out.privilegeProbe = FIXTURE_TABLES.map((table) => ({
      table,
      SELECT: Boolean(out.privileges[table]?.SELECT),
      INSERT: Boolean(out.privileges[table]?.INSERT),
      UPDATE: Boolean(out.privileges[table]?.UPDATE),
      DELETE: Boolean(out.privileges[table]?.DELETE),
      source: 'has_table_privilege including inherited roles; no GRANT issued',
    }));
    out.grantsIssued = 0;

    const columns = (await readOnlyQuery(client, COLUMN_SQL, [FIXTURE_TABLES])).rows;
    const notNull = (await readOnlyQuery(client, NOT_NULL_SQL, [FIXTURE_TABLES])).rows;
    const fks = (await readOnlyQuery(client, FK_SQL, [FIXTURE_TABLES])).rows;
    const requiredWithoutDefault = columns.filter((col) => col.is_nullable === 'NO' && !col.column_default);
    const rls = (await readOnlyQuery(
      client,
      `SELECT c.relname AS table_name, c.relrowsecurity AS rls, c.relforcerowsecurity AS force_rls
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
       ORDER BY c.relname`,
      [FIXTURE_TABLES.concat(['tenants', 'user_roles', 'identity_accounts'])],
    )).rows;
    out.schema = {
      notNullColumns: notNull,
      requiredWithoutDefault: requiredWithoutDefault,
      foreignKeys: fks,
      columnCount: columns.length,
      rowLevelSecurity: rls,
    };

    out.readOnlyIdentityContext = await applyReadOnlyIdentityContext(client);

    const rates = (await readOnlyQuery(
      client,
      `SELECT id, name,
              mortgage_ops_initial_rate_cents,
              mortgage_ops_additional_rate_cents
       FROM public.tenants
       WHERE id = $1::uuid`,
      [FREEDOM_TENANT_ID],
    )).rows[0] || null;
    out.freedomRates = rates ? {
      tenantId: rates.id,
      tenantName: rates.name,
      mortgage_ops_initial_rate_cents: rates.mortgage_ops_initial_rate_cents,
      mortgage_ops_additional_rate_cents: rates.mortgage_ops_additional_rate_cents,
      initialMatches: Number(rates.mortgage_ops_initial_rate_cents) === EXPECTED_INITIAL_RATE_CENTS,
      additionalMatches: Number(rates.mortgage_ops_additional_rate_cents) === EXPECTED_ADDITIONAL_RATE_CENTS,
      observedAfterReadOnlyIdentityContext: true,
    } : { missing: true, initialMatches: false, additionalMatches: false, observedAfterReadOnlyIdentityContext: true };

    const launch = (await readOnlyQuery(
      client,
      `SELECT singleton, launched_at, environment, note
       FROM public.mortgage_ops_billing_launch
       WHERE singleton IS TRUE
       LIMIT 1`,
    )).rows[0] || null;
    out.billingLaunch = launch ? {
      present: true,
      launched_at: launch.launched_at,
      environment: launch.environment,
      note: launch.note,
    } : { present: false };

    const agentRoles = (await readOnlyQuery(
      client,
      `SELECT role FROM public.user_roles WHERE user_id = $1::uuid ORDER BY role`,
      [MORTGAGE_AGENT_USER_ID],
    )).rows.map((row) => row.role);
    let hasRoleFn = null;
    try {
      hasRoleFn = (await readOnlyQuery(
        client,
        `SELECT public.has_role($1::uuid, 'mortgage_agent'::public.app_role) AS mortgage_agent,
                public.has_role($1::uuid, 'admin'::public.app_role) AS admin`,
        [MORTGAGE_AGENT_USER_ID],
      )).rows[0] || null;
    } catch (error) {
      hasRoleFn = { error: String(error.message || error).slice(0, 200) };
    }
    let identityAccount = null;
    const identityPresent = (await readOnlyQuery(
      client,
      `SELECT to_regclass('public.identity_accounts') IS NOT NULL AS ok`,
    )).rows[0].ok;
    if (identityPresent) {
      identityAccount = (await readOnlyQuery(
        client,
        `SELECT application_user_id, status, cognito_sub
         FROM public.identity_accounts
         WHERE application_user_id = $1::uuid
         LIMIT 1`,
        [MORTGAGE_AGENT_USER_ID],
      )).rows[0] || null;
    }
    out.mortgageAgent = {
      userId: MORTGAGE_AGENT_USER_ID,
      email: MORTGAGE_AGENT_EMAIL,
      roles: agentRoles,
      hasRoleFunction: hasRoleFn,
      hasMortgageAgentRole: agentRoles.includes('mortgage_agent')
        || agentRoles.includes('admin')
        || hasRoleFn?.mortgage_agent === true
        || hasRoleFn?.admin === true,
      identityAccountStatus: identityAccount?.status || null,
      hasCognitoSub: Boolean(identityAccount?.cognito_sub),
      readOnlyIdentityAuthUid: out.readOnlyIdentityContext?.authUid || null,
    };

    const functionDef = (await readOnlyQuery(
      client,
      `SELECT pg_get_functiondef('public.accrue_mortgage_ops_billing(uuid)'::regprocedure) AS def`,
    )).rows[0]?.def || '';
    const triggerPresent = (await readOnlyQuery(
      client,
      `SELECT count(*)::int AS n
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname = 'mortgage_handling_requests'
         AND t.tgname = 'tr_accrue_mortgage_ops_billing'
         AND NOT t.tgisinternal`,
    )).rows[0].n;
    out.billingTrigger = {
      triggerPresent: triggerPresent > 0,
      functionMentionsInitial: functionDef.includes('mortgage_ops_initial'),
      functionMentionsAdditional: functionDef.includes('mortgage_ops_additional_check'),
      functionMentionsLaunchCutoff: functionDef.includes('mortgage_ops_billing_launch'),
      functionDoesNotInsertFromHarness: true,
    };

    const markerCount = (await readOnlyQuery(
      client,
      `SELECT
         (SELECT count(*)::int FROM public.claims WHERE claim_number LIKE $1) AS claims,
         (SELECT count(*)::int FROM public.check_intake_items WHERE review_notes LIKE $2 OR carrier_name LIKE $2) AS checks,
         (SELECT count(*)::int FROM public.mortgage_handling_requests WHERE note LIKE $2) AS requests`,
      [`${CLAIM_MARKER_PREFIX}%`, `%${CLAIM_MARKER_PREFIX}%`],
    )).rows[0];
    out.existingSyntheticMarkers = markerCount;

    const inboundToClaims = fks.filter((fk) => fk.to_table === 'claims' && !FIXTURE_TABLES.includes(fk.from_table));
    const cascadeRisk = fks.filter((fk) => (
      FIXTURE_TABLES.includes(fk.to_table)
      && fk.delete_rule === 'CASCADE'
      && !FIXTURE_TABLES.includes(fk.from_table)
    ));
    out.cleanupSafety = {
      plan: cleanupPlan({}),
      inboundForeignKeysOutsideFixtureTables: inboundToClaims.length,
      cascadeFromFixtureToNonFixture: cascadeRisk,
      canCleanupWithoutTouchingPreexistingParents: cascadeRisk.length === 0,
      method: 'exact UUID allowlist DELETE only, child-first, never prefix/date/tenant-wide',
    };

    const classification = {
      newClaimWithNoPriorEventsIsInitial: Boolean(
        functionDef.includes("v_event_type := 'mortgage_ops_initial'")
        || functionDef.includes('mortgage_ops_initial'),
      ),
      requiresClaimId: functionDef.includes('v_claim_id'),
      additionalWhenPriorExists: functionDef.includes('mortgage_ops_additional_check'),
      failClosedWithoutLaunchRow: functionDef.includes('v_cutoff IS NULL') || functionDef.includes('mortgage_ops_billing_launch'),
    };
    out.classification = classification;

    out.apiRoutes = await probeStagingApiReadOnly(fetchImpl);

    const blockers = [];
    if (!out.freedomRates.initialMatches || !out.freedomRates.additionalMatches) blockers.push('freedom_rates_unexpected');
    if (!out.billingLaunch.present) blockers.push('billing_launch_missing');
    if (!out.mortgageAgent.hasMortgageAgentRole) blockers.push('mortgage_agent_role_missing');
    if (!out.billingTrigger.triggerPresent) blockers.push('billing_trigger_missing');
    if (!out.privileges.claims?.INSERT) blockers.push('claims_insert_missing');
    if (!out.privileges.check_intake_items?.INSERT) blockers.push('check_insert_missing');
    if (!out.privileges.mortgage_handling_requests?.SELECT) blockers.push('request_select_missing');
    if (!out.privileges.check_billing_events?.SELECT) blockers.push('billing_select_missing');
    if (cascadeRisk.length) blockers.push('cleanup_cascade_risk');
    if (!out.apiRoutes['/data/rpc']?.expectedUnauthenticated) blockers.push('rpc_route_unexpected');
    if (!out.apiRoutes['/data/write']?.expectedUnauthenticated) blockers.push('write_route_unexpected');
    out.blockers = blockers;
    out.ok = blockers.length === 0;
    out.error = out.ok ? null : 'preflight_blockers';
    out.elapsedMs = Date.now() - started;
    return out;
  } catch (error) {
    out.error = String(error.message || error).slice(0, 500);
    out.elapsedMs = Date.now() - started;
    return out;
  } finally {
    await closeClient(client);
  }
};
