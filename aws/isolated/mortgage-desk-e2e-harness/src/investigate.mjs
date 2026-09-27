import {
  C1C_TENANT_ID,
  EXPECTED_ADDITIONAL_RATE_CENTS,
  EXPECTED_INITIAL_RATE_CENTS,
  FIXTURE_TABLES,
  FREEDOM_TENANT_ID,
  READONLY_PROBE_IDENTITIES,
} from './constants.mjs';
import { closeClient, loadStagingAppSecret, openReadOnlyClient, readOnlyQuery } from './db.mjs';
import { evaluateFailClosed } from './fail-closed.mjs';

const TEST_CLAIM_REGEX = '(synthetic|mde2e|fixture|dummy|checksops-test|test[- ]claim|not negotiable)';

const applyIdentity = async (client, identity) => {
  await readOnlyQuery(
    client,
    `SELECT set_config('request.app_user_id', $1, true) AS app_user_id`,
    [identity.id],
  );
  await readOnlyQuery(
    client,
    `SELECT set_config('request.jwt.claim.email', $1, true) AS email`,
    [identity.email || ''],
  );
  const uid = (await readOnlyQuery(client, `SELECT auth.uid()::text AS auth_uid`)).rows[0]?.auth_uid || null;
  let flags = {};
  try {
    flags = (await readOnlyQuery(
      client,
      `SELECT public.is_master_owner() AS is_master_owner,
              public.is_platform_owner() AS is_platform_owner,
              public.aws_is_cross_tenant_reader() AS cross_tenant_reader`,
    )).rows[0] || {};
  } catch (error) {
    flags = { error: String(error.message || error).slice(0, 200) };
  }
  return { ...identity, authUid: uid, ...flags };
};

const tableColumns = async (client, table) => {
  const rows = (await readOnlyQuery(
    client,
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [table],
  )).rows.map((row) => row.column_name);
  return new Set(rows);
};

const pick = (columns, wanted) => wanted.filter((name) => columns.has(name));

export const runReadOnlyInvestigate = async ({
  shas,
  getSecretString,
  openClient = openReadOnlyClient,
} = {}) => {
  const started = Date.now();
  const out = {
    ok: false,
    action: 'investigate',
    readOnly: true,
    rowsCreated: 0,
    rowsUpdated: 0,
    rowsDeleted: 0,
    syntheticRowsCreated: 0,
    preExistingRowsMutated: 0,
    grantsIssued: 0,
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
              current_setting('transaction_read_only') AS transaction_read_only`,
    )).rows[0];
    if (!identity || identity.transaction_read_only !== 'on') {
      out.error = 'transaction_not_read_only';
      return out;
    }
    out.identity = {
      current_database: identity.current_database,
      current_user: identity.current_user,
      transaction_read_only: identity.transaction_read_only,
    };

    const privileges = (await readOnlyQuery(
      client,
      `SELECT t AS table_name,
              has_table_privilege(current_user, format('public.%I', t), 'INSERT') AS insert,
              has_table_privilege(current_user, format('public.%I', t), 'UPDATE') AS update,
              has_table_privilege(current_user, format('public.%I', t), 'DELETE') AS delete,
              has_table_privilege(current_user, format('public.%I', t), 'SELECT') AS select
       FROM unnest($1::text[]) AS t`,
      [FIXTURE_TABLES],
    )).rows;
    out.privileges = Object.fromEntries(privileges.map((row) => [row.table_name, {
      SELECT: Boolean(row.select),
      INSERT: Boolean(row.insert),
      UPDATE: Boolean(row.update),
      DELETE: Boolean(row.delete),
    }]));

    const tenantCols = await tableColumns(client, 'tenants');
    const claimCols = await tableColumns(client, 'claims');
    const checkCols = await tableColumns(client, 'check_intake_items');
    const requestCols = await tableColumns(client, 'mortgage_handling_requests');
    const billingCols = await tableColumns(client, 'check_billing_events');
    out.columnInventory = {
      tenants: [...tenantCols],
      claims: [...claimCols],
      check_intake_items: [...checkCols],
      mortgage_handling_requests: [...requestCols],
      check_billing_events: [...billingCols],
    };

    let identityAccounts = [];
    try {
      identityAccounts = (await readOnlyQuery(
        client,
        `SELECT application_user_id, email, status, cognito_sub IS NOT NULL AS has_cognito_sub
         FROM public.identity_accounts
         ORDER BY email NULLS LAST`,
      )).rows;
    } catch (error) {
      identityAccounts = [{ error: String(error.message || error).slice(0, 200) }];
    }
    out.identityAccounts = identityAccounts;

    const tenantSelect = pick(tenantCols, [
      'id', 'name', 'slug', 'mortgage_ops_initial_rate_cents', 'mortgage_ops_additional_rate_cents',
      'moov_allowlisted', 'moov_environment', 'payment_provider', 'stripe_customer_id',
    ]);
    const claimSelect = pick(claimCols, [
      'id', 'claim_number', 'org_id', 'tenant_id', 'insured_name', 'claimant_name', 'status',
      'is_closed', 'created_at', 'created_by', 'homeowner_name',
    ]);
    const claimTenantCol = claimCols.has('org_id') ? 'org_id' : (claimCols.has('tenant_id') ? 'tenant_id' : null);

    const tenantsById = new Map();
    const claimsById = new Map();
    const probeResults = [];

    for (const probe of READONLY_PROBE_IDENTITIES) {
      const applied = await applyIdentity(client, probe);
      const tenants = tenantSelect.length
        ? (await readOnlyQuery(
          client,
          `SELECT ${tenantSelect.map((name) => `"${name}"`).join(', ')} FROM public.tenants ORDER BY name`,
        )).rows
        : [];
      for (const tenant of tenants) tenantsById.set(tenant.id, { ...tenantsById.get(tenant.id), ...tenant });

      let claims = [];
      if (claimSelect.length) {
        const where = [];
        const params = [];
        if (claimCols.has('claim_number')) {
          params.push(TEST_CLAIM_REGEX);
          where.push(`claim_number ~* $` + params.length);
        }
        for (const col of ['insured_name', 'claimant_name', 'homeowner_name']) {
          if (claimCols.has(col)) {
            params.push(TEST_CLAIM_REGEX);
            where.push(`${col} ~* $` + params.length);
          }
        }
        const sql = where.length
          ? `SELECT ${claimSelect.map((name) => `"${name}"`).join(', ')}
             FROM public.claims
             WHERE ${where.join(' OR ')}
             ORDER BY created_at DESC NULLS LAST
             LIMIT 50`
          : `SELECT ${claimSelect.map((name) => `"${name}"`).join(', ')}
             FROM public.claims
             ORDER BY created_at DESC NULLS LAST
             LIMIT 20`;
        claims = (await readOnlyQuery(client, sql, params)).rows;
        for (const claim of claims) claimsById.set(claim.id, claim);
      }
      probeResults.push({
        ...applied,
        tenantCount: tenants.length,
        tenantIds: tenants.map((row) => row.id),
        testLikeClaimCount: claims.length,
        testLikeClaimIds: claims.map((row) => row.id),
      });
    }
    out.probes = probeResults;
    out.tenantsVisible = [...tenantsById.values()];

    const functionDef = (await readOnlyQuery(
      client,
      `SELECT pg_get_functiondef('public.accrue_mortgage_ops_billing(uuid)'::regprocedure) AS def`,
    )).rows[0]?.def || '';
    out.classificationSource = {
      function: 'public.accrue_mortgage_ops_billing(uuid)',
      mentionsInitial: functionDef.includes('mortgage_ops_initial'),
      mentionsAdditional: functionDef.includes('mortgage_ops_additional_check'),
      mentionsClaimId: functionDef.includes('v_claim_id') || /claim_id/.test(functionDef),
      assignsInitial: /v_event_type\s*:=\s*'mortgage_ops_initial'/.test(functionDef),
      excerpt: functionDef.slice(0, 6000),
    };

    const launch = (await readOnlyQuery(
      client,
      `SELECT singleton, launched_at, environment, note
       FROM public.mortgage_ops_billing_launch
       WHERE singleton IS TRUE
       LIMIT 1`,
    )).rows[0] || null;
    out.billingLaunch = launch;

    let stripeConfig = null;
    try {
      stripeConfig = (await readOnlyQuery(
        client,
        `SELECT id, active, stripe_meter_event_name, created_at
         FROM public.check_billing_config
         ORDER BY created_at DESC
         LIMIT 3`,
      )).rows;
    } catch (error) {
      stripeConfig = { error: String(error.message || error).slice(0, 200) };
    }
    out.checkBillingConfig = stripeConfig;

    let creditBalances = [];
    try {
      creditBalances = (await readOnlyQuery(
        client,
        `SELECT tenant_id, stripe_customer_id IS NOT NULL AS has_stripe_customer
         FROM public.tenant_credit_balances`,
      )).rows;
    } catch (error) {
      creditBalances = [{ error: String(error.message || error).slice(0, 200) }];
    }
    out.tenantCreditBalances = creditBalances;

    await applyIdentity(client, READONLY_PROBE_IDENTITIES[2] || READONLY_PROBE_IDENTITIES[0]);

    const candidateClaims = [];
    const seen = new Set();
    const allClaimIds = [...claimsById.keys()];
    if (claimTenantCol) {
      const testTenantIds = out.tenantsVisible
      .filter((tenant) => /test|synth|sandbox|demo|fixture|e2e/i.test(`${tenant.name || ''} ${tenant.slug || ''}`))
      .map((tenant) => tenant.id);
    const extra = testTenantIds.length
      ? (await readOnlyQuery(
        client,
        `SELECT ${claimSelect.map((name) => `"${name}"`).join(', ')}
         FROM public.claims
         WHERE ${claimTenantCol} = ANY($1::uuid[])
         ORDER BY created_at DESC NULLS LAST
         LIMIT 40`,
        [testTenantIds],
      )).rows
      : [];
      for (const claim of extra) {
        claimsById.set(claim.id, claim);
        allClaimIds.push(claim.id);
      }
    }

    for (const claimId of allClaimIds) {
      if (seen.has(claimId)) continue;
      seen.add(claimId);
      const claim = claimsById.get(claimId);
      const tenantId = claim.org_id || claim.tenant_id || null;
      const tenant = tenantId ? tenantsById.get(tenantId) : null;

      const checks = checkCols.has('claim_id')
        ? (await readOnlyQuery(
          client,
          `SELECT id, check_number, carrier_name, check_stage, created_at
           FROM public.check_intake_items
           WHERE claim_id = $1::uuid
           ORDER BY created_at DESC NULLS LAST
           LIMIT 20`,
          [claimId],
        )).rows
        : [];
      const checkIds = checks.map((row) => row.id);

      let requests = [];
      if (checkIds.length && requestCols.has('check_intake_item_id')) {
        requests = (await readOnlyQuery(
          client,
          `SELECT id, status, accepted_at, completed_at, check_intake_item_id, note, created_at
           FROM public.mortgage_handling_requests
           WHERE check_intake_item_id = ANY($1::uuid[])
           ORDER BY created_at DESC NULLS LAST
           LIMIT 20`,
          [checkIds],
        )).rows;
      }

      const billingWhere = [];
      const billingParams = [];
      if (billingCols.has('claim_id')) {
        billingParams.push(claimId);
        billingWhere.push(`claim_id = $${billingParams.length}::uuid`);
      }
      if (checkIds.length && billingCols.has('check_intake_item_id')) {
        billingParams.push(checkIds);
        billingWhere.push(`check_intake_item_id = ANY($${billingParams.length}::uuid[])`);
      }
      let billing = [];
      if (billingWhere.length) {
        billing = (await readOnlyQuery(
          client,
          `SELECT id, event_type, status, unit_price_cents, tenant_id, check_intake_item_id,
                  ${billingCols.has('claim_id') ? 'claim_id,' : ''} billed_at
           FROM public.check_billing_events
           WHERE (${billingWhere.join(' OR ')})
             AND event_type IN ('mortgage_ops_initial', 'mortgage_ops_additional_check')
           ORDER BY billed_at DESC NULLS LAST
           LIMIT 20`,
          billingParams,
        )).rows;
      }

      const testLike = /synthetic|mde2e|e2e|fixture|dummy|not negotiable|checksops-test|test claim|test-claim/i
        .test([claim.claim_number, claim.insured_name, claim.claimant_name, claim.homeowner_name].filter(Boolean).join(' '));
      const hasInitial = billing.some((row) => row.event_type === 'mortgage_ops_initial');
      const hasAdditional = billing.some((row) => row.event_type === 'mortgage_ops_additional_check');
      const hasDeskHistory = requests.length > 0;
      const ratesMatch = tenant
        && Number(tenant.mortgage_ops_initial_rate_cents) === EXPECTED_INITIAL_RATE_CENTS
        && Number(tenant.mortgage_ops_additional_rate_cents) === EXPECTED_ADDITIONAL_RATE_CENTS;
      const dedicatedTenant = tenant && !['2eff5f1a-929d-4ce3-9a8b-cd96b98df42a', '4f172140-f57a-4744-8050-95f4f07b13b4'].includes(tenant.id)
        && /test|synth|sandbox|demo|fixture|e2e/i.test(`${tenant.name || ''} ${tenant.slug || ''}`);

      candidateClaims.push({
        claimId: claim.id,
        claimNumber: claim.claim_number || null,
        tenantId,
        tenantName: tenant?.name || null,
        tenantSlug: tenant?.slug || null,
        dedicatedTestTenant: Boolean(dedicatedTenant),
        testLikeClaim: testLike,
        isClosed: claim.is_closed ?? null,
        createdAt: claim.created_at || null,
        createdBy: claim.created_by || null,
        rates: tenant ? {
          mortgage_ops_initial_rate_cents: tenant.mortgage_ops_initial_rate_cents ?? null,
          mortgage_ops_additional_rate_cents: tenant.mortgage_ops_additional_rate_cents ?? null,
          initialMatches: Number(tenant.mortgage_ops_initial_rate_cents) === EXPECTED_INITIAL_RATE_CENTS,
          additionalMatches: Number(tenant.mortgage_ops_additional_rate_cents) === EXPECTED_ADDITIONAL_RATE_CENTS,
        } : null,
        checkCount: checks.length,
        requestCount: requests.length,
        mortgageOpsBilling: billing,
        hasMortgageOpsInitial: hasInitial,
        hasMortgageOpsAdditional: hasAdditional,
        hasMortgageDeskHistory: hasDeskHistory,
        wouldClassifyNewCheckAsInitial: !hasInitial && !hasAdditional,
        canUseWithoutUpdatingClaim: true,
        likelyRealCustomerClaim: !testLike && !dedicatedTenant,
        ratesMatch: Boolean(ratesMatch),
      });
    }

    out.candidateClaims = candidateClaims.sort((a, b) => {
      const score = (row) => (
        (row.dedicatedTestTenant ? 8 : 0)
        + (row.testLikeClaim ? 4 : 0)
        + (row.wouldClassifyNewCheckAsInitial ? 2 : 0)
        + (row.ratesMatch ? 1 : 0)
        - (row.likelyRealCustomerClaim ? 6 : 0)
        - (row.hasMortgageDeskHistory ? 2 : 0)
      );
      return score(b) - score(a);
    });

    out.safeCleanupWithoutExtraPrivileges = {
      check_intake_items: Boolean(out.privileges.check_intake_items?.DELETE),
      mortgage_handling_requests: Boolean(out.privileges.mortgage_handling_requests?.DELETE),
      check_audit_log: Boolean(out.privileges.check_audit_log?.DELETE),
      check_messages: Boolean(out.privileges.check_messages?.DELETE),
      check_billing_events: Boolean(out.privileges.check_billing_events?.DELETE),
      claims: Boolean(out.privileges.claims?.DELETE),
      note: 'claims and billing DELETE remain false. Parent claim would be reused and not deleted. Billing event would remain if DELETE is unavailable.',
    };

    out.billingIsolation = {
      awsBillMortgageHandlingWritesFees: false,
      stagingProviderExecutionExpected: false,
      stripeReporterSelectsAllRecordedEvents: true,
      stripeReporterRequiresCustomer: true,
      leftoverBillingEventRisk: 'If status=recorded and the tenant has stripe_customer_id, a later Stripe reporter (if still wired to this database) could meter it. Isolation requires a tenant without stripe_customer_id, or an event type/status the reporter will not pick up.',
    };

    out.ok = true;
    out.error = null;
    out.elapsedMs = Date.now() - started;
    return out;
  } catch (error) {
    out.error = String(error.message || error).slice(0, 800);
    out.elapsedMs = Date.now() - started;
    return out;
  } finally {
    await closeClient(client);
  }
};
