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

const COLUMN_SQL = `
  SELECT table_name, column_name, is_nullable, data_type, column_default
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = ANY($1::text[])
  ORDER BY table_name, ordinal_position
`;

const FK_SQL = `
  SELECT
    tc.table_name AS from_table,
    kcu.column_name AS from_column,
    ccu.table_name AS to_table,
    ccu.column_name AS to_column,
    rc.delete_rule,
    rc.update_rule,
    tc.constraint_name
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name
   AND tc.table_schema = kcu.table_schema
  JOIN information_schema.referential_constraints rc
    ON rc.constraint_name = tc.constraint_name
   AND rc.constraint_schema = tc.table_schema
  JOIN information_schema.constraint_column_usage ccu
    ON ccu.constraint_name = rc.unique_constraint_name
   AND ccu.constraint_schema = rc.unique_constraint_schema
  WHERE tc.constraint_type = 'FOREIGN KEY'
    AND tc.table_schema = 'public'
    AND (
      tc.table_name = ANY($1::text[])
      OR ccu.table_name = ANY($1::text[])
    )
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
    out.privileges = privilegeMap(privilegeRows);
    out.privilegeProbe = FIXTURE_TABLES.map((table) => ({
      table,
      SELECT: Boolean(out.privileges[table]?.SELECT),
      INSERT: Boolean(out.privileges[table]?.INSERT),
      UPDATE: Boolean(out.privileges[table]?.UPDATE),
      DELETE: Boolean(out.privileges[table]?.DELETE),
    }));
    out.grantsIssued = 0;

    const columns = (await readOnlyQuery(client, COLUMN_SQL, [FIXTURE_TABLES])).rows;
    const notNull = (await readOnlyQuery(client, NOT_NULL_SQL, [FIXTURE_TABLES])).rows;
    const fks = (await readOnlyQuery(client, FK_SQL, [FIXTURE_TABLES])).rows;
    out.schema = {
      notNullColumns: notNull,
      foreignKeys: fks,
      columnCount: columns.length,
    };

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
      initialMatches: rates.mortgage_ops_initial_rate_cents === EXPECTED_INITIAL_RATE_CENTS,
      additionalMatches: rates.mortgage_ops_additional_rate_cents === EXPECTED_ADDITIONAL_RATE_CENTS,
    } : { missing: true, initialMatches: false, additionalMatches: false };

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
      hasMortgageAgentRole: agentRoles.includes('mortgage_agent') || agentRoles.includes('admin'),
      identityAccountStatus: identityAccount?.status || null,
      hasCognitoSub: Boolean(identityAccount?.cognito_sub),
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
