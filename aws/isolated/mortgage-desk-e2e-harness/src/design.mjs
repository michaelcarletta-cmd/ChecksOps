import {
  BILLING_TENANT_ID,
  C1C_TENANT_ID,
  CANDIDATE_SYNTHETIC_IDENTITIES,
  CUSTOMER_EMAIL_SUFFIXES,
  FIXTURE_TABLES,
  FREEDOM_TENANT_ID,
  READONLY_PROBE_IDENTITIES,
  ZERO_TENANT_ID,
} from './constants.mjs';
import { closeClient, loadStagingAppSecret, openReadOnlyClient, readOnlyQuery } from './db.mjs';
import { evaluateFailClosed } from './fail-closed.mjs';

const isCustomerEmail = (email) => {
  const value = String(email || '').toLowerCase();
  return CUSTOMER_EMAIL_SUFFIXES.some((suffix) => value.endsWith(suffix));
};

const catalogIdentity = async (client, identity) => {
  const applied = await applyIdentity(client, identity);
  let memberships = [];
  let roles = [];
  let profile = null;
  try {
    memberships = (await readOnlyQuery(
      client,
      `SELECT tenant_id, role
       FROM public.tenant_users
       WHERE user_id = $1::uuid
       ORDER BY tenant_id, role`,
      [identity.id],
    )).rows;
  } catch (error) {
    memberships = { error: String(error.message || error).slice(0, 200) };
  }
  try {
    roles = (await readOnlyQuery(
      client,
      `SELECT role FROM public.user_roles WHERE user_id = $1::uuid ORDER BY role`,
      [identity.id],
    )).rows.map((row) => row.role);
  } catch (error) {
    roles = { error: String(error.message || error).slice(0, 200) };
  }
  try {
    profile = (await readOnlyQuery(
      client,
      `SELECT id, email, full_name, approval_status
       FROM public.profiles
       WHERE id = $1::uuid`,
      [identity.id],
    )).rows[0] || null;
  } catch (error) {
    profile = { error: String(error.message || error).slice(0, 200) };
  }
  let tenantFlags = {};
  try {
    tenantFlags = (await readOnlyQuery(
      client,
      `SELECT public.aws_can_access_tenant($1::uuid) AS can_access_billing,
              public.aws_can_write_tenant($1::uuid) AS can_write_billing,
              public.aws_can_access_tenant($2::uuid) AS can_access_zero,
              public.aws_can_write_tenant($2::uuid) AS can_write_zero,
              public.aws_can_access_tenant($3::uuid) AS can_access_freedom,
              public.aws_can_write_tenant($3::uuid) AS can_write_freedom,
              public.aws_can_access_tenant($4::uuid) AS can_access_c1c,
              public.aws_can_write_tenant($4::uuid) AS can_write_c1c`,
      [BILLING_TENANT_ID, ZERO_TENANT_ID, FREEDOM_TENANT_ID, C1C_TENANT_ID],
    )).rows[0] || {};
  } catch (error) {
    tenantFlags = { error: String(error.message || error).slice(0, 200) };
  }
  const membershipList = Array.isArray(memberships) ? memberships : [];
  const roleList = Array.isArray(roles) ? roles : [];
  const tenantIds = membershipList.map((row) => row.tenant_id);
  return {
    ...applied,
    customerEmail: isCustomerEmail(identity.email),
    memberships,
    roles,
    profile,
    ...tenantFlags,
    dedicatedToBillingTenant: tenantIds.length === 1 && tenantIds[0] === BILLING_TENANT_ID,
    hasFreedomOrC1cMembership: tenantIds.includes(FREEDOM_TENANT_ID) || tenantIds.includes(C1C_TENANT_ID),
    hasAdminRole: roleList.includes('admin'),
    hasStaffRole: roleList.includes('staff'),
    hasMortgageAgentRole: roleList.includes('mortgage_agent'),
    canCoverSendAndAccept: roleList.includes('admin')
      || (roleList.includes('staff') && roleList.includes('mortgage_agent')),
  };
};

const applyIdentity = async (client, identity) => {
  await readOnlyQuery(client, `SELECT set_config('request.app_user_id', $1, true) AS app_user_id`, [identity.id]);
  await readOnlyQuery(client, `SELECT set_config('request.jwt.claim.email', $1, true) AS email`, [identity.email || '']);
  const uid = (await readOnlyQuery(client, `SELECT auth.uid()::text AS auth_uid`)).rows[0]?.auth_uid || null;
  let flags = {};
  try {
    flags = (await readOnlyQuery(
      client,
      `SELECT public.is_master_owner() AS is_master_owner,
              public.is_platform_owner() AS is_platform_owner,
              public.aws_is_cross_tenant_reader() AS cross_tenant_reader,
              public.aws_can_access_tenant($1::uuid) AS can_access_billing_tenant,
              public.aws_can_write_tenant($1::uuid) AS can_write_billing_tenant`,
      [BILLING_TENANT_ID],
    )).rows[0] || {};
  } catch (error) {
    flags = { error: String(error.message || error).slice(0, 200) };
  }
  return { ...identity, authUid: uid, ...flags };
};

export const runReadOnlyDesign = async ({
  shas,
  getSecretString,
  openClient = openReadOnlyClient,
} = {}) => {
  const started = Date.now();
  const out = {
    ok: false,
    action: 'design',
    readOnly: true,
    rowsCreated: 0,
    rowsUpdated: 0,
    rowsDeleted: 0,
    grantsIssued: 0,
    schemaChanged: false,
    iamChanged: false,
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
    out.identity = identity;

    out.loginRoles = (await readOnlyQuery(
      client,
      `SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolcanlogin, rolbypassrls, rolinherit
       FROM pg_roles
       WHERE rolcanlogin
       ORDER BY rolname`,
    )).rows;

    out.roleMembership = (await readOnlyQuery(
      client,
      `SELECT r.rolname AS role, m.rolname AS member
       FROM pg_auth_members am
       JOIN pg_roles r ON r.oid = am.roleid
       JOIN pg_roles m ON m.oid = am.member
       WHERE r.rolname IN ('checksops', 'checksops_admin', 'authenticated', 'anon')
          OR m.rolname IN ('checksops', 'checksops_admin')
       ORDER BY 1, 2`,
    )).rows;

    const roleNames = out.loginRoles.map((row) => row.rolname);
    out.claimsPrivilegesByRole = [];
    for (const role of roleNames) {
      try {
        const row = (await readOnlyQuery(
          client,
          `SELECT $1::text AS rolname,
                  has_table_privilege($1::name, 'public.claims', 'SELECT') AS claims_select,
                  has_table_privilege($1::name, 'public.claims', 'INSERT') AS claims_insert,
                  has_table_privilege($1::name, 'public.claims', 'UPDATE') AS claims_update,
                  has_table_privilege($1::name, 'public.claims', 'DELETE') AS claims_delete,
                  has_table_privilege($1::name, 'public.check_intake_items', 'INSERT') AS checks_insert,
                  has_table_privilege($1::name, 'public.check_intake_items', 'UPDATE') AS checks_update,
                  has_table_privilege($1::name, 'public.mortgage_handling_requests', 'INSERT') AS requests_insert,
                  has_table_privilege($1::name, 'public.check_billing_events', 'INSERT') AS billing_insert`,
          [role],
        )).rows[0];
        out.claimsPrivilegesByRole.push(row);
      } catch (error) {
        out.claimsPrivilegesByRole.push({
          rolname: role,
          error: String(error.message || error).slice(0, 200),
        });
      }
    }

    out.tableGrants = (await readOnlyQuery(
      client,
      `SELECT table_name, grantee, privilege_type, is_grantable
       FROM information_schema.role_table_grants
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name, grantee, privilege_type`,
      [FIXTURE_TABLES],
    )).rows;
    out.columnGrants = (await readOnlyQuery(
      client,
      `SELECT table_name, column_name, grantee, privilege_type
       FROM information_schema.column_privileges
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
         AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE')
       ORDER BY table_name, column_name, grantee, privilege_type`,
      [FIXTURE_TABLES],
    )).rows;
    out.claimsGrants = (await readOnlyQuery(
      client,
      `SELECT grantee, privilege_type, is_grantable
       FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = 'claims'
       ORDER BY grantee, privilege_type`,
    )).rows;

    out.tableOwners = (await readOnlyQuery(
      client,
      `SELECT c.relname, pg_get_userbyid(c.relowner) AS owner, c.relrowsecurity AS rls, c.relforcerowsecurity AS force_rls
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname = ANY($1::text[])
       ORDER BY c.relname`,
      [FIXTURE_TABLES.concat(['tenants', 'tenant_users', 'user_roles'])],
    )).rows;

    out.claimsPolicies = (await readOnlyQuery(
      client,
      `SELECT polname, polcmd, pg_get_expr(polqual, polrelid) AS using_expr,
              pg_get_expr(polwithcheck, polrelid) AS with_check
       FROM pg_policy
       WHERE polrelid = 'public.claims'::regclass
       ORDER BY polname`,
    )).rows;

    out.claimsRequiredColumns = (await readOnlyQuery(
      client,
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'claims'
         AND is_nullable = 'NO' AND column_default IS NULL
       ORDER BY ordinal_position`,
    )).rows;

    out.claimsDefaults = (await readOnlyQuery(
      client,
      `SELECT column_name, data_type, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'claims'
         AND column_name IN ('id', 'claim_number', 'org_id', 'status', 'created_at', 'policyholder_name')
       ORDER BY ordinal_position`,
    )).rows;

    await applyIdentity(client, READONLY_PROBE_IDENTITIES[0]);
    try {
      out.tenantUsersOnBilling = (await readOnlyQuery(
        client,
        `SELECT user_id, tenant_id, role
         FROM public.tenant_users
         WHERE tenant_id = $1::uuid
         ORDER BY role, user_id`,
        [BILLING_TENANT_ID],
      )).rows;
    } catch (error) {
      out.tenantUsersOnBilling = { error: String(error.message || error).slice(0, 200) };
    }

    try {
      out.userRolesOnBillingMembers = (await readOnlyQuery(
        client,
        `SELECT ur.user_id, ur.role, ia.email
         FROM public.user_roles ur
         LEFT JOIN public.identity_accounts ia ON ia.application_user_id = ur.user_id
         WHERE ur.user_id IN (
           SELECT user_id FROM public.tenant_users WHERE tenant_id = $1::uuid
         )
         ORDER BY ur.role, ia.email`,
        [BILLING_TENANT_ID],
      )).rows;
    } catch (error) {
      out.userRolesOnBillingMembers = { error: String(error.message || error).slice(0, 200) };
    }

    out.writeCapabilityByIdentity = [];
    for (const probe of READONLY_PROBE_IDENTITIES) {
      out.writeCapabilityByIdentity.push(await applyIdentity(client, probe));
    }

    await applyIdentity(client, READONLY_PROBE_IDENTITIES[0]);
    out.fixtureRequestSummary = (await readOnlyQuery(
      client,
      `SELECT count(*)::int AS n,
              count(DISTINCT claim_id)::int AS distinct_claim_ids,
              count(DISTINCT check_intake_item_id)::int AS distinct_check_ids,
              count(DISTINCT requested_by)::int AS distinct_requested_by,
              min(created_at) AS first_created,
              max(created_at) AS last_created,
              count(*) FILTER (WHERE accepted_at >= '2026-09-01')::int AS accepted_after_launch,
              count(*) FILTER (WHERE accepted_at < '2026-09-01')::int AS accepted_before_launch,
              count(*) FILTER (WHERE billing_status = 'unbilled')::int AS unbilled,
              count(*) FILTER (WHERE note IS NOT NULL)::int AS with_note
       FROM public.mortgage_handling_requests
       WHERE tenant_id = $1::uuid`,
      [BILLING_TENANT_ID],
    )).rows[0];

    out.fixtureRequestActors = (await readOnlyQuery(
      client,
      `SELECT requested_by, assigned_employee_id, status, count(*)::int AS n
       FROM public.mortgage_handling_requests
       WHERE tenant_id = $1::uuid
       GROUP BY 1, 2, 3
       ORDER BY n DESC`,
      [BILLING_TENANT_ID],
    )).rows;

    out.zeroTenantRequestSummary = (await readOnlyQuery(
      client,
      `SELECT count(*)::int AS n, count(DISTINCT claim_id)::int AS distinct_claim_ids
       FROM public.mortgage_handling_requests
       WHERE tenant_id = $1::uuid`,
      [ZERO_TENANT_ID],
    )).rows[0];

    out.classificationIndependence = {
      priorKey: 'tenant_id + claim_id on check_billing_events',
      existingFixtureClaimIdsDoNotMatchANewUuid: true,
      newClaimUuidWouldHaveHasPriorFalse: true,
      leavingFortyFiveRequestsDoesNotChangeNewClaimClassification: true,
    };

    out.applicationPathNotes = {
      claimsOnWriteAllowlist: false,
      checkIntakeItemsWriteOps: ['update'],
      createCheckPath: 'POST /workflow/checks handleCreateCheck — inserts check without claim_id',
      sendPathSetsRequestClaimIdInSpaOnly: true,
      awsExecuteMortgageRequestsOmitsClaimId: true,
      accrueFallsBackToCheckClaimIdThenNullMeansInitial: true,
      checkClaimIdColumnGrantToChecksops: false,
      requestClaimIdInsertGrantToChecksops: true,
      requestClaimIdUpdateGrantToChecksops: false,
      classificationUsesCoalesceRequestThenCheck: true,
    };

    try {
      out.identityAccounts = (await readOnlyQuery(
        client,
        `SELECT application_user_id, email, status, cognito_sub IS NOT NULL AS has_cognito_sub
         FROM public.identity_accounts
         ORDER BY email NULLS LAST`,
      )).rows;
    } catch (error) {
      out.identityAccounts = { error: String(error.message || error).slice(0, 200) };
    }

    const accountList = Array.isArray(out.identityAccounts) ? out.identityAccounts : [];
    const accountById = new Map(accountList.map((row) => [row.application_user_id, row]));
    out.identityCatalog = [];
    const seen = new Set();
    const toCatalog = [
      ...CANDIDATE_SYNTHETIC_IDENTITIES,
      ...READONLY_PROBE_IDENTITIES,
      ...accountList.map((row) => ({
        id: row.application_user_id,
        email: row.email,
        label: row.email || row.application_user_id,
        status: row.status,
        has_cognito_sub: row.has_cognito_sub,
      })),
    ];
    for (const identity of toCatalog) {
      if (!identity?.id || seen.has(identity.id)) continue;
      seen.add(identity.id);
      const account = accountById.get(identity.id) || {};
      out.identityCatalog.push({
        ...(await catalogIdentity(client, identity)),
        status: identity.status || account.status || null,
        has_cognito_sub: identity.has_cognito_sub ?? account.has_cognito_sub ?? null,
      });
    }

    out.dedicatedSyntheticCandidates = out.identityCatalog.filter((row) => (
      !row.customerEmail
      && row.has_cognito_sub !== false
      && !row.hasFreedomOrC1cMembership
    ));

    out.identityTableColumns = (await readOnlyQuery(
      client,
      `SELECT table_name, column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name IN ('tenant_users', 'user_roles', 'identity_accounts', 'profiles')
       ORDER BY table_name, ordinal_position`,
    )).rows;
    out.identityTableRequired = (await readOnlyQuery(
      client,
      `SELECT table_name, column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name IN ('tenant_users', 'user_roles', 'identity_accounts', 'profiles')
         AND is_nullable = 'NO' AND column_default IS NULL
       ORDER BY table_name, ordinal_position`,
    )).rows;
    out.identityForeignKeys = (await readOnlyQuery(
      client,
      `SELECT conname, conrelid::regclass AS from_table, confrelid::regclass AS to_table,
              pg_get_constraintdef(oid) AS def
       FROM pg_constraint
       WHERE contype = 'f'
         AND conrelid IN (
           'public.tenant_users'::regclass,
           'public.user_roles'::regclass,
           'public.identity_accounts'::regclass,
           'public.profiles'::regclass
         )
       ORDER BY 1`,
    )).rows;
    out.checkRequiredColumns = (await readOnlyQuery(
      client,
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'check_intake_items'
         AND is_nullable = 'NO' AND column_default IS NULL
       ORDER BY ordinal_position`,
    )).rows;
    out.checkClaimIdDefault = (await readOnlyQuery(
      client,
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'check_intake_items'
         AND column_name IN ('id', 'tenant_id', 'claim_id', 'uploaded_by', 'status', 'check_stage')
       ORDER BY ordinal_position`,
    )).rows;
    out.checkClaimIdGrants = (out.columnGrants || []).filter((row) => (
      row.table_name === 'check_intake_items' && row.column_name === 'claim_id'
    ));

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
