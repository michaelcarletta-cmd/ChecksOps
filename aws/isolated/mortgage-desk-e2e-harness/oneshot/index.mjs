/**
 * Ephemeral staging-admin oneshot for the Mortgage Desk E2E identity.
 * CREATE-only. Refuses production secrets/hosts. Never attached to the
 * permanent harness. Never sets Cognito passwords.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

const { Client } = pg;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CA_PATH = [
  path.join(ROOT, 'rds-global-bundle.pem'),
  '/var/task/rds-global-bundle.pem',
].find((p) => fs.existsSync(p));

const EMAIL = 'mde2e@freedomadj.com';
const LEFTOVER_PLUS_EMAIL = 'claims+mde2e@freedomadj.com';
const LEFTOVER_PLUS_USER_ID = '97a1e063-bd9d-4c28-bcbe-b9b462a52894';
const C1C_ADMIN_USER_ID = '3af0234c-de1b-4819-938d-fa4f9390811b';
const C1C_ADMIN_EMAIL = 'asukanick@condition1commercial.com';
const OTHER_ASSIGNEE_ID = '233c588f-dc33-4307-8c3f-3da49c9fd2b3';
const BILLING_TENANT_ID = '41cbc4b4-c5cd-4020-a6aa-0905e79dafe9';
const FREEDOM_TENANT_ID = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const C1C_TENANT_ID = '4f172140-f57a-4744-8050-95f4f07b13b4';
const ZERO_TENANT_ID = '22233ffe-7a69-4c46-88c3-1587dc525f1f';
const EXISTING_INVALID_ID = 'c7729c3e-d87b-46c6-973e-9c04fbdcc961';
const EXISTING_INVALID_EMAIL = 'staging-mops-4b61bc@checksops.invalid';
const UNIQUENESS_EMAILS = new Set([EMAIL, LEFTOVER_PLUS_EMAIL]);
const STAGING_HOST = 'checksops-staging.cyr0q4kcop3c.us-east-1.rds.amazonaws.com';
const SYNTHETIC_NAME = 'SYNTHETIC / MDE2E / NOT A CUSTOMER';
const SYNTHETIC_LABEL = 'SYNTHETIC / TEST / NOT NEGOTIABLE';
const MDE2E_USER_ID = '76f581d7-6c8a-48d6-932c-2e93dc68b0f4';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MARKER_RE = /^SYNTHETIC-MDE2E-[0-9a-f-]{8,}$/i;

const refuseProduction = (value) => {
  const text = String(value || '');
  if (/checksops-production/i.test(text) || /\/production\//i.test(text)) {
    throw new Error('refusing production secret or host');
  }
};

const openAdmin = async () => {
  const arn = process.env.ADMIN_SECRET_ARN;
  refuseProduction(arn);
  if (!arn || !/rds-db-credentials\/checksops-staging\/checksops_admin\//i.test(arn)) {
    throw new Error('ADMIN_SECRET_ARN must be the staging checksops_admin secret');
  }
  const sm = new SecretsManagerClient({});
  const secret = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  const parsed = JSON.parse(secret.SecretString || '{}');
  refuseProduction(parsed.host);
  if (parsed.username !== 'checksops_admin') throw new Error('secret username is not checksops_admin');
  const host = parsed.host && parsed.host !== 'localhost' ? parsed.host : process.env.RDS_HOST;
  if (host !== STAGING_HOST) throw new Error('secret host is not staging RDS');
  if ((process.env.DATABASE_NAME || 'checksops') !== 'checksops') {
    throw new Error('refusing non-checksops database');
  }
  const client = new Client({
    host,
    port: Number(parsed.port || 5432),
    user: parsed.username,
    password: parsed.password,
    database: 'checksops',
    ssl: { rejectUnauthorized: true, ca: fs.readFileSync(CA_PATH, 'utf8') },
    connectionTimeoutMillis: 8000,
    query_timeout: 20000,
  });
  await client.connect();
  return client;
};

const uniqueness = async (client, email = EMAIL) => {
  const target = String(email || EMAIL).trim().toLowerCase();
  if (!UNIQUENESS_EMAILS.has(target)) {
    throw new Error('email is not in the uniqueness allowlist');
  }
  const identity = (await client.query(
    `SELECT application_user_id, email, status, cognito_sub IS NOT NULL AS has_cognito_sub
     FROM public.identity_accounts
     WHERE lower(email) = lower($1)`,
    [target],
  )).rows;
  const profiles = (await client.query(
    `SELECT id, email, full_name FROM public.profiles WHERE lower(email) = lower($1)`,
    [target],
  )).rows;
  const roles = (await client.query(
    `SELECT ur.user_id, ur.role, ia.email
     FROM public.user_roles ur
     LEFT JOIN public.identity_accounts ia ON ia.application_user_id = ur.user_id
     WHERE lower(ia.email) = lower($1)
        OR ur.user_id IN (SELECT id FROM public.profiles WHERE lower(email) = lower($1))`,
    [target],
  )).rows;
  const memberships = (await client.query(
    `SELECT tu.user_id, tu.tenant_id, tu.role
     FROM public.tenant_users tu
     WHERE tu.user_id IN (
       SELECT application_user_id FROM public.identity_accounts WHERE lower(email) = lower($1)
       UNION
       SELECT id FROM public.profiles WHERE lower(email) = lower($1)
     )`,
    [target],
  )).rows;
  const unused = identity.length === 0 && profiles.length === 0 && roles.length === 0 && memberships.length === 0;
  return {
    email: target,
    unused,
    identityAccounts: identity,
    profiles,
    userRoles: roles,
    tenantUsers: memberships,
  };
};

const createRows = async (client, { applicationUserId, cognitoSub }) => {
  if (!UUID_RE.test(applicationUserId)) throw new Error('invalid application_user_id');
  if (!cognitoSub || String(cognitoSub) === applicationUserId) throw new Error('invalid cognito_sub');
  if (applicationUserId === EXISTING_INVALID_ID) throw new Error('refusing to reuse existing .invalid identity');
  if (applicationUserId === LEFTOVER_PLUS_USER_ID) throw new Error('refusing to reuse leftover plus-address identity');

  const probe = await uniqueness(client);
  if (!probe.unused) {
    return { ok: false, error: 'email_already_used', uniqueness: probe, rowsCreated: 0 };
  }

  await client.query('BEGIN');
  try {
    await client.query(
      `INSERT INTO public.identity_accounts (
         application_user_id, cognito_sub, email, status, linked_at, created_at
       ) VALUES ($1::uuid, $2, $3, 'active', now(), now())`,
      [applicationUserId, cognitoSub, EMAIL],
    );
    await client.query(
      `INSERT INTO public.profiles (id, email, full_name)
       VALUES ($1::uuid, $2, $3)`,
      [applicationUserId, EMAIL, SYNTHETIC_NAME],
    );
    await client.query(
      `INSERT INTO public.user_roles (user_id, role)
       VALUES ($1::uuid, 'admin')`,
      [applicationUserId],
    );
    await client.query(
      `INSERT INTO public.tenant_users (tenant_id, user_id, role)
       VALUES ($1::uuid, $2::uuid, 'admin')`,
      [BILLING_TENANT_ID, applicationUserId],
    );
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw error;
  }

  return {
    ok: true,
    rowsCreated: 4,
    applicationUserId,
    email: EMAIL,
    tenantId: BILLING_TENANT_ID,
  };
};

const verifyIsolation = async (client, applicationUserId) => {
  const catalog = (await client.query(
    `SELECT id::text AS tenant_id, name, slug
     FROM public.tenants
     ORDER BY name`,
  )).rows;
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL ROLE checksops');
    await client.query('SET LOCAL row_security = on');
    await client.query("SELECT set_config('request.app_user_id', $1, true)", [applicationUserId]);
    await client.query("SELECT set_config('request.jwt.claim.email', $1, true)", [EMAIL]);
    const uid = (await client.query('SELECT auth.uid()::text AS auth_uid')).rows[0];
    const flags = (await client.query(
      `SELECT public.is_master_owner() AS is_master_owner,
              public.is_platform_owner() AS is_platform_owner,
              public.aws_is_cross_tenant_reader() AS cross_tenant_reader,
              public.aws_can_access_tenant($1::uuid) AS can_access_billing,
              public.aws_can_write_tenant($1::uuid) AS can_write_billing,
              public.aws_can_access_tenant($2::uuid) AS can_access_freedom,
              public.aws_can_write_tenant($2::uuid) AS can_write_freedom,
              public.aws_can_access_tenant($3::uuid) AS can_access_c1c,
              public.aws_can_write_tenant($3::uuid) AS can_write_c1c,
              public.aws_can_access_tenant($4::uuid) AS can_access_zero,
              public.aws_can_write_tenant($4::uuid) AS can_write_zero`,
      [BILLING_TENANT_ID, FREEDOM_TENANT_ID, C1C_TENANT_ID, ZERO_TENANT_ID],
    )).rows[0];
    const probed = [];
    for (const tenant of catalog) {
      const row = (await client.query(
        `SELECT public.aws_can_access_tenant($1::uuid) AS can_access,
                public.aws_can_write_tenant($1::uuid) AS can_write`,
        [tenant.tenant_id],
      )).rows[0];
      probed.push({ ...tenant, ...row });
    }
    const roles = (await client.query(
      `SELECT role FROM public.user_roles WHERE user_id = $1::uuid ORDER BY role`,
      [applicationUserId],
    )).rows.map((row) => row.role);
    const memberships = (await client.query(
      `SELECT tenant_id, role FROM public.tenant_users WHERE user_id = $1::uuid ORDER BY tenant_id`,
      [applicationUserId],
    )).rows;
    const claimsByOrg = (await client.query(
      `SELECT coalesce(org_id::text, 'null') AS org_id, count(*)::int AS n
       FROM public.claims
       GROUP BY 1
       ORDER BY n DESC`,
    )).rows;
    const checksByTenant = (await client.query(
      `SELECT coalesce(tenant_id::text, 'null') AS tenant_id, count(*)::int AS n
       FROM public.check_intake_items
       GROUP BY 1
       ORDER BY n DESC`,
    )).rows;
    await client.query('ROLLBACK');
    const others = probed.filter((row) => row.tenant_id !== BILLING_TENANT_ID);
    return {
      authUid: uid?.auth_uid || null,
      roles,
      memberships,
      otherTenantsWritable: others.filter((row) => row.can_write).map((row) => row.tenant_id),
      otherTenantsAccessible: others.filter((row) => row.can_access).map((row) => row.tenant_id),
      otherTenantCount: others.length,
      claimsByOrg,
      checksByTenant,
      ...flags,
    };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw error;
  }
};

const requiredColumns = async (client, table) => (await client.query(
  `SELECT column_name, data_type, is_nullable, column_default
   FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = $1
   ORDER BY ordinal_position`,
  [table],
)).rows;

const fixturePreflight = async (client) => {
  const tenant = (await client.query(
    `SELECT id, name, mortgage_ops_initial_rate_cents, mortgage_ops_additional_rate_cents
     FROM public.tenants WHERE id = $1::uuid`,
    [BILLING_TENANT_ID],
  )).rows[0] || null;
  const ratesOk = tenant
    && Number(tenant.mortgage_ops_initial_rate_cents) === 1000
    && Number(tenant.mortgage_ops_additional_rate_cents) === 500;
  return {
    tenant,
    ratesOk,
    claimsColumns: await requiredColumns(client, 'claims'),
    checkColumns: await requiredColumns(client, 'check_intake_items'),
    billingColumns: await requiredColumns(client, 'check_billing_events'),
    requestColumns: await requiredColumns(client, 'mortgage_handling_requests'),
  };
};

const requiredWithoutDefault = (columns) => columns
  .filter((col) => col.is_nullable === 'NO' && !col.column_default)
  .map((col) => col.column_name);

const createClaim = async (client, event) => {
  const claimId = event.claimId;
  const runMarker = String(event.runMarker || '');
  if (!UUID_RE.test(claimId)) throw new Error('invalid claim_id');
  if (!MARKER_RE.test(runMarker)) throw new Error('invalid run marker');
  const exists = (await client.query(
    `SELECT id FROM public.claims WHERE id = $1::uuid OR claim_number = $2`,
    [claimId, runMarker],
  )).rows;
  if (exists.length) return { ok: false, error: 'claim_already_exists', rowsCreated: 0 };
  const columns = await requiredColumns(client, 'claims');
  const unknown = requiredWithoutDefault(columns).filter((name) => ![
    'id', 'org_id', 'claim_number', 'policyholder_name', 'status',
  ].includes(name));
  if (unknown.length) return { ok: false, error: 'unexpected_required_claim_columns', unknown, rowsCreated: 0 };
  const names = columns.map((col) => col.column_name);
  const fields = ['id', 'org_id', 'claim_number', 'policyholder_name'];
  const values = [claimId, BILLING_TENANT_ID, runMarker, SYNTHETIC_LABEL];
  if (names.includes('status')) {
    fields.push('status');
    values.push('open');
  }
  if (names.includes('insured_name')) {
    fields.push('insured_name');
    values.push(SYNTHETIC_LABEL);
  }
  const placeholders = fields.map((_, i) => `$${i + 1}`);
  const row = (await client.query(
    `INSERT INTO public.claims (${fields.join(', ')})
     VALUES (${placeholders.join(', ')})
     RETURNING id, org_id, claim_number, policyholder_name, status`,
    values,
  )).rows[0];
  return { ok: true, rowsCreated: 1, claim: row };
};

const createCheck = async (client, event) => {
  const checkId = event.checkId;
  const claimId = event.claimId;
  const runMarker = String(event.runMarker || '');
  if (!UUID_RE.test(checkId) || !UUID_RE.test(claimId)) throw new Error('invalid check or claim id');
  if (!MARKER_RE.test(runMarker)) throw new Error('invalid run marker');
  const claim = (await client.query(
    `SELECT id, org_id, claim_number FROM public.claims WHERE id = $1::uuid`,
    [claimId],
  )).rows[0];
  if (!claim || claim.org_id !== BILLING_TENANT_ID || claim.claim_number !== runMarker) {
    return { ok: false, error: 'claim_not_found_or_not_this_run', rowsCreated: 0 };
  }
  const exists = (await client.query(
    `SELECT id FROM public.check_intake_items WHERE id = $1::uuid`,
    [checkId],
  )).rows;
  if (exists.length) return { ok: false, error: 'check_already_exists', rowsCreated: 0 };
  const columns = await requiredColumns(client, 'check_intake_items');
  const names = new Set(columns.map((col) => col.column_name));
  const allowed = new Set([
    'id', 'tenant_id', 'claim_id', 'uploaded_by', 'check_number', 'payee_line',
    'front_image_path', 'status', 'review_notes', 'carrier_name', 'detected_claim_number',
    'amount',
  ]);
  const unknown = requiredWithoutDefault(columns).filter((name) => !allowed.has(name));
  if (unknown.length) return { ok: false, error: 'unexpected_required_check_columns', unknown, rowsCreated: 0 };
  const fields = ['id', 'tenant_id'];
  const values = [checkId, BILLING_TENANT_ID];
  const add = (name, value) => {
    if (names.has(name)) {
      fields.push(name);
      values.push(value);
    }
  };
  add('claim_id', claimId);
  add('uploaded_by', MDE2E_USER_ID);
  add('check_number', `${runMarker}-CHK`);
  add('payee_line', SYNTHETIC_LABEL);
  add('front_image_path', `synthetic/mde2e/${runMarker}/NOT-A-NEGOTIABLE-INSTRUMENT.txt`);
  add('status', 'pending_review');
  add('review_notes', `${runMarker} ${SYNTHETIC_LABEL}. Fake check. No deposit/provider path.`);
  add('carrier_name', SYNTHETIC_LABEL);
  add('detected_claim_number', runMarker);
  add('amount', 0);
  const placeholders = fields.map((_, i) => `$${i + 1}`);
  try {
    const row = (await client.query(
      `INSERT INTO public.check_intake_items (${fields.join(', ')})
       VALUES (${placeholders.join(', ')})
       RETURNING id, tenant_id, claim_id, uploaded_by, check_number, payee_line, status`,
      values,
    )).rows[0];
    return { ok: true, rowsCreated: 1, check: row };
  } catch (error) {
    return { ok: false, error: String(error.message || error).slice(0, 400), fields, rowsCreated: 0 };
  }
};

const linkRequestClaim = async (client, event) => {
  const requestId = event.requestId;
  const checkId = event.checkId;
  const claimId = event.claimId;
  if (![requestId, checkId, claimId].every((id) => UUID_RE.test(id))) {
    throw new Error('invalid f3 ids');
  }
  const existing = (await client.query(
    `SELECT id, tenant_id, check_intake_item_id, claim_id
     FROM public.mortgage_handling_requests
     WHERE id = $1::uuid`,
    [requestId],
  )).rows[0];
  if (!existing) return { ok: false, error: 'request_not_found', rowsUpdated: 0 };
  if (existing.tenant_id !== BILLING_TENANT_ID) return { ok: false, error: 'wrong_tenant', rowsUpdated: 0 };
  if (existing.check_intake_item_id !== checkId) return { ok: false, error: 'wrong_check', rowsUpdated: 0 };
  if (existing.claim_id === claimId) return { ok: true, rowsUpdated: 0, alreadyLinked: true, request: existing };
  const row = (await client.query(
    `UPDATE public.mortgage_handling_requests
     SET claim_id = $2::uuid, updated_at = now()
     WHERE id = $1::uuid
       AND tenant_id = $3::uuid
       AND check_intake_item_id = $4::uuid
       AND (claim_id IS NULL OR claim_id IS DISTINCT FROM $2::uuid)
     RETURNING id, tenant_id, check_intake_item_id, claim_id, status`,
    [requestId, claimId, BILLING_TENANT_ID, checkId],
  )).rows;
  if (row.length !== 1) return { ok: false, error: 'f3_did_not_update_exactly_one_row', rowsUpdated: row.length };
  return { ok: true, rowsUpdated: 1, request: row[0] };
};

const STOPPED_REQUEST_ID = '33ccc90a-d708-48bf-aa47-3a24a4743fc7';
const STOPPED_CLAIM_ID = '4627380f-34d6-44b6-88fd-8f43029640b9';
const STOPPED_CHECK_ID = 'd14033ac-51bb-4c1a-af64-da073e64ee2f';

const diagnoseAccept = async (client, event) => {
  const requestId = event.requestId || STOPPED_REQUEST_ID;
  const claimId = event.claimId || STOPPED_CLAIM_ID;
  const checkId = event.checkId || STOPPED_CHECK_ID;
  if (![requestId, claimId, checkId].every((id) => UUID_RE.test(id))) {
    throw new Error('invalid diagnose ids');
  }
  if (requestId !== STOPPED_REQUEST_ID || claimId !== STOPPED_CLAIM_ID || checkId !== STOPPED_CHECK_ID) {
    return { ok: false, error: 'diagnose_limited_to_stopped_fixture' };
  }

  const request = (await client.query(
    `SELECT id, tenant_id, check_intake_item_id, claim_id, status, assigned_employee_id,
            accepted_at, completed_at, requested_by, mortgage_company, loan_number,
            billing_status, billed_at, stripe_invoice_id, created_at, updated_at
     FROM public.mortgage_handling_requests WHERE id = $1::uuid`,
    [requestId],
  )).rows[0] || null;
  const billing = (await client.query(
    `SELECT id, event_type, status, unit_price_cents, tenant_id, claim_id,
            check_intake_item_id, mortgage_request_id
     FROM public.check_billing_events
     WHERE tenant_id = $1::uuid
       AND (
         mortgage_request_id = $2::uuid
         OR check_intake_item_id = $3::uuid
         OR claim_id = $4::uuid
       )`,
    [BILLING_TENANT_ID, requestId, checkId, claimId],
  )).rows;
  const policies = (await client.query(
    `SELECT pol.polname AS policy_name,
            CASE pol.polcmd
              WHEN 'r' THEN 'SELECT'
              WHEN 'a' THEN 'INSERT'
              WHEN 'w' THEN 'UPDATE'
              WHEN 'd' THEN 'DELETE'
              WHEN '*' THEN 'ALL'
            END AS command,
            CASE WHEN pol.polpermissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END AS permissive,
            ARRAY(SELECT r.rolname FROM pg_roles r WHERE r.oid = ANY(pol.polroles) ORDER BY 1) AS roles,
            pg_get_expr(pol.polqual, pol.polrelid) AS using_expression,
            pg_get_expr(pol.polwithcheck, pol.polrelid) AS with_check_expression
     FROM pg_policy pol
     JOIN pg_class c ON c.oid = pol.polrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'mortgage_handling_requests'
     ORDER BY command, policy_name`,
  )).rows;
  const rlsFlags = (await client.query(
    `SELECT c.relrowsecurity, c.relforcerowsecurity
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'mortgage_handling_requests'`,
  )).rows[0] || null;
  const roleMemberships = (await client.query(
    `SELECT r.rolname AS role, r.rolbypassrls, r.rolinherit,
            ARRAY(
              SELECT m.rolname FROM pg_auth_members am
              JOIN pg_roles m ON m.oid = am.roleid
              WHERE am.member = r.oid ORDER BY 1
            ) AS member_of
     FROM pg_roles r
     WHERE r.rolname IN ('checksops', 'authenticated')
     ORDER BY 1`,
  )).rows;
  const tableGrants = (await client.query(
    `SELECT grantee, privilege_type
     FROM information_schema.role_table_grants
     WHERE table_schema = 'public'
       AND table_name = 'mortgage_handling_requests'
       AND grantee IN ('checksops', 'authenticated', 'PUBLIC')
     ORDER BY 1, 2`,
  )).rows;
  const columnGrants = (await client.query(
    `SELECT column_name, grantee, privilege_type
     FROM information_schema.column_privileges
     WHERE table_schema = 'public'
       AND table_name = 'mortgage_handling_requests'
       AND privilege_type IN ('INSERT', 'UPDATE')
       AND grantee IN ('checksops', 'authenticated')
       AND column_name IN (
         'assigned_employee_id', 'status', 'accepted_at', 'updated_at',
         'claim_id', 'tenant_id', 'check_intake_item_id'
       )
     ORDER BY 1, 2, 3`,
  )).rows;
  const triggers = (await client.query(
    `SELECT t.tgname, t.tgenabled, pg_get_triggerdef(t.oid) AS def,
            p.proname AS function_name, p.prosecdef AS security_definer
     FROM pg_trigger t
     JOIN pg_class c ON c.oid = t.tgrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE n.nspname = 'public'
       AND c.relname = 'mortgage_handling_requests'
       AND NOT t.tgisinternal
     ORDER BY t.tgname`,
  )).rows;
  const triggerFunctions = {};
  for (const trig of triggers) {
    if (triggerFunctions[trig.function_name]) continue;
    triggerFunctions[trig.function_name] = ((await client.query(
      `SELECT pg_get_functiondef(p.oid) AS def
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = $1`,
      [trig.function_name],
    )).rows[0] || {}).def || null;
  }
  const helper = async (sig) => {
    try {
      return (await client.query(`SELECT pg_get_functiondef($1::regprocedure) AS def`, [sig])).rows[0]?.def || null;
    } catch (error) {
      return { error: String(error.message || error).slice(0, 200) };
    }
  };
  const helpers = {
    'auth.uid()': await helper('auth.uid()'),
    'public.aws_can_write_tenant(uuid)': await helper('public.aws_can_write_tenant(uuid)'),
    'public.aws_can_access_tenant(uuid)': await helper('public.aws_can_access_tenant(uuid)'),
    'public.aws_is_authenticated()': await helper('public.aws_is_authenticated()'),
    'public.aws_is_cross_tenant_reader()': await helper('public.aws_is_cross_tenant_reader()'),
    'public.has_role(uuid, public.app_role)': await helper('public.has_role(uuid, public.app_role)'),
    'public.accrue_mortgage_ops_billing(uuid)': await helper('public.accrue_mortgage_ops_billing(uuid)'),
  };
  const fks = (await client.query(
    `SELECT conname, pg_get_constraintdef(oid) AS def
     FROM pg_constraint
     WHERE conrelid = 'public.mortgage_handling_requests'::regclass AND contype = 'f'
     ORDER BY 1`,
  )).rows;
  const authUsersPresent = (await client.query(
    `SELECT EXISTS(SELECT 1 FROM auth.users WHERE id = $1::uuid) AS present`,
    [MDE2E_USER_ID],
  )).rows[0];
  const caller = {
    userRoles: (await client.query(
      `SELECT role FROM public.user_roles WHERE user_id = $1::uuid ORDER BY 1`,
      [MDE2E_USER_ID],
    )).rows,
    tenantUsers: (await client.query(
      `SELECT tenant_id, role FROM public.tenant_users WHERE user_id = $1::uuid ORDER BY 1`,
      [MDE2E_USER_ID],
    )).rows,
  };
  const successfulAccepts = (await client.query(
    `SELECT r.id, r.tenant_id, t.name AS tenant_name, r.status, r.assigned_employee_id,
            r.accepted_at, r.requested_by, r.claim_id IS NOT NULL AS has_claim_id,
            p.email AS assigned_email,
            ARRAY(SELECT ur.role FROM public.user_roles ur WHERE ur.user_id = r.assigned_employee_id ORDER BY 1) AS assigned_roles,
            EXISTS(
              SELECT 1 FROM public.tenant_users tu
              WHERE tu.user_id = r.assigned_employee_id AND tu.tenant_id = r.tenant_id
            ) AS assigned_is_tenant_member
     FROM public.mortgage_handling_requests r
     LEFT JOIN public.tenants t ON t.id = r.tenant_id
     LEFT JOIN public.profiles p ON p.id = r.assigned_employee_id
     WHERE r.accepted_at IS NOT NULL AND r.id <> $1::uuid
     ORDER BY r.accepted_at DESC
     LIMIT 12`,
    [requestId],
  )).rows;

  let appContext = null;
  let visibleRequest = [];
  let policyEvaluations = [];
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL ROLE checksops');
    await client.query('SET LOCAL row_security = on');
    await client.query("SELECT set_config('request.app_user_id', $1, true)", [MDE2E_USER_ID]);
    await client.query("SELECT set_config('request.jwt.claim.email', $1, true)", [EMAIL]);
    appContext = (await client.query(
      `SELECT current_user,
              current_setting('request.app_user_id', true) AS app_user_id,
              current_setting('request.jwt.claim.email', true) AS email_guc,
              auth.uid()::text AS auth_uid,
              auth.email() AS auth_email,
              public.aws_is_authenticated() AS aws_is_authenticated,
              public.aws_is_cross_tenant_reader() AS cross_tenant_reader,
              public.is_master_owner() AS is_master_owner,
              public.is_platform_owner() AS is_platform_owner,
              public.aws_can_access_tenant($1::uuid) AS can_access_billing,
              public.aws_can_write_tenant($1::uuid) AS can_write_billing,
              public.has_role(auth.uid(), 'admin'::public.app_role) AS has_admin,
              public.has_role(auth.uid(), 'staff'::public.app_role) AS has_staff,
              public.has_role(auth.uid(), 'mortgage_agent'::public.app_role) AS has_mortgage_agent`,
      [BILLING_TENANT_ID],
    )).rows[0];
    visibleRequest = (await client.query(
      `SELECT id, tenant_id, status, assigned_employee_id, accepted_at, claim_id, check_intake_item_id
       FROM public.mortgage_handling_requests WHERE id = $1::uuid`,
      [requestId],
    )).rows;
    for (const pol of policies) {
      if (!['UPDATE', 'ALL'].includes(pol.command)) continue;
      const item = {
        policy_name: pol.policy_name,
        command: pol.command,
        permissive: pol.permissive,
        roles: pol.roles,
        using_expression: pol.using_expression,
        with_check_expression: pol.with_check_expression,
      };
      try {
        item.using_current_row = (await client.query(
          `SELECT (${pol.using_expression || 'TRUE'}) AS ok
           FROM public.mortgage_handling_requests WHERE id = $1::uuid`,
          [requestId],
        )).rows[0]?.ok ?? null;
      } catch (error) {
        item.using_error = String(error.message || error).slice(0, 200);
      }
      try {
        item.with_check_proposed_row = (await client.query(
          `SELECT (${pol.with_check_expression || 'TRUE'}) AS ok
           FROM (
             SELECT $2::uuid AS tenant_id,
                    'in_progress'::text AS status,
                    $3::uuid AS assigned_employee_id,
                    now() AS accepted_at,
                    $4::uuid AS claim_id,
                    $5::uuid AS check_intake_item_id,
                    requested_by,
                    id
             FROM public.mortgage_handling_requests
             WHERE id = $1::uuid
           ) mortgage_handling_requests`,
          [requestId, BILLING_TENANT_ID, MDE2E_USER_ID, claimId, checkId],
        )).rows[0]?.ok ?? null;
      } catch (error) {
        item.with_check_error = String(error.message || error).slice(0, 200);
      }
      policyEvaluations.push(item);
    }
    await client.query('ROLLBACK');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw error;
  }

  const checksopsMemberOfAuthenticated = roleMemberships.some(
    (row) => row.role === 'checksops' && (row.member_of || []).includes('authenticated'),
  );
  const applicable = policyEvaluations.filter((pol) => {
    const roles = pol.roles || [];
    return roles.length === 0
      || roles.includes('PUBLIC')
      || roles.includes('checksops')
      || (checksopsMemberOfAuthenticated && roles.includes('authenticated'));
  });
  const permissiveUsing = applicable.filter((p) => p.permissive === 'PERMISSIVE' && p.using_current_row === true);
  const permissiveCheck = applicable.filter((p) => p.permissive === 'PERMISSIVE' && p.with_check_proposed_row === true);
  const restrictiveUsingFail = applicable.filter((p) => p.permissive === 'RESTRICTIVE' && p.using_current_row !== true);
  const restrictiveCheckFail = applicable.filter((p) => p.permissive === 'RESTRICTIVE' && p.with_check_proposed_row !== true);
  const requestAfter = (await client.query(
    `SELECT id, status, assigned_employee_id, accepted_at, claim_id, check_intake_item_id, tenant_id
     FROM public.mortgage_handling_requests WHERE id = $1::uuid`,
    [requestId],
  )).rows[0] || null;

  return {
    ok: true,
    request,
    billing,
    policies,
    rlsFlags,
    roleMemberships,
    tableGrants,
    columnGrants,
    triggers,
    triggerFunctions,
    helpers,
    fks,
    authUsersPresent,
    caller,
    successfulAccepts,
    appContext,
    visibleRequest,
    policyEvaluations,
    rlsCombination: {
      applicablePolicyNames: applicable.map((p) => p.policy_name),
      permissiveUsingPass: permissiveUsing.map((p) => p.policy_name),
      permissiveWithCheckPass: permissiveCheck.map((p) => p.policy_name),
      restrictiveUsingFail: restrictiveUsingFail.map((p) => p.policy_name),
      restrictiveWithCheckFail: restrictiveCheckFail.map((p) => p.policy_name),
      wouldReject: permissiveUsing.length === 0
        || permissiveCheck.length === 0
        || restrictiveUsingFail.length > 0
        || restrictiveCheckFail.length > 0,
    },
    proposed: {
      tenant_id: BILLING_TENANT_ID,
      status: 'in_progress',
      assigned_employee_id: MDE2E_USER_ID,
      accepted_at: 'COALESCE(accepted_at, now())',
      claim_id: request?.claim_id || null,
      check_intake_item_id: request?.check_intake_item_id || null,
    },
    requestAfter,
    unchanged: requestAfter
      && requestAfter.status === 'requested'
      && requestAfter.assigned_employee_id == null
      && requestAfter.accepted_at == null,
  };
};

const CAPTURED_UPDATE_USING = "(aws_is_cross_tenant_reader() OR aws_can_write_tenant(tenant_id) OR (has_role(auth.uid(), 'mortgage_agent'::app_role) AND (((status = 'requested'::text) AND (assigned_employee_id IS NULL)) OR (assigned_employee_id = auth.uid()))))";
const CAPTURED_UPDATE_CHECK = "(aws_is_cross_tenant_reader() OR (has_role(auth.uid(), 'mortgage_agent'::app_role) AND (((status = 'requested'::text) AND (assigned_employee_id IS NULL)) OR (assigned_employee_id = auth.uid()))) OR (aws_can_write_tenant(tenant_id) AND (status = 'requested'::text) AND (assigned_employee_id IS NULL)))";
const SELF_ASSIGN_CLAUSE = '(aws_can_write_tenant(tenant_id) AND assigned_employee_id = auth.uid())';
const CORRECTED_UPDATE_CHECK = `(${CAPTURED_UPDATE_CHECK.slice(1, -1)} OR ${SELF_ASSIGN_CLAUSE})`;
const hasSelfAssignWriterClause = (expr) => /aws_can_write_tenant\(tenant_id\) AND \(?assigned_employee_id = auth\.uid\(\)/.test(String(expr || ''));

const readUpdatePolicy = async (client) => ((await client.query(
  `SELECT pol.polname AS policy_name,
          CASE pol.polcmd WHEN 'w' THEN 'UPDATE' ELSE pol.polcmd::text END AS command,
          CASE WHEN pol.polpermissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END AS permissive,
          ARRAY(SELECT r.rolname FROM pg_roles r WHERE r.oid = ANY(pol.polroles) ORDER BY 1) AS roles,
          pg_get_expr(pol.polqual, pol.polrelid) AS using_expression,
          pg_get_expr(pol.polwithcheck, pol.polrelid) AS with_check_expression
   FROM pg_policy pol
   JOIN pg_class c ON c.oid = pol.polrelid
   JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname = 'mortgage_handling_requests'
     AND pol.polname = 'aws_update_mortgage_handling_requests'`,
)).rows[0] || null);

const readFixtureState = async (client) => {
  const request = (await client.query(
    `SELECT id, tenant_id, check_intake_item_id, claim_id, status,
            assigned_employee_id, accepted_at, completed_at, requested_by
     FROM public.mortgage_handling_requests WHERE id = $1::uuid`,
    [STOPPED_REQUEST_ID],
  )).rows[0] || null;
  const billing = (await client.query(
    `SELECT id, event_type, status, unit_price_cents
     FROM public.check_billing_events
     WHERE tenant_id = $1::uuid
       AND (
         mortgage_request_id = $2::uuid
         OR check_intake_item_id = $3::uuid
         OR claim_id = $4::uuid
       )`,
    [BILLING_TENANT_ID, STOPPED_REQUEST_ID, STOPPED_CHECK_ID, STOPPED_CLAIM_ID],
  )).rows;
  return { request, billing, billingCount: billing.length };
};

const applyAcceptRlsCorrection = async (client, event) => {
  const mode = String(event.mode || 'apply').trim();
  const beforePolicy = await readUpdatePolicy(client);
  const beforeState = await readFixtureState(client);
  if (!beforePolicy) return { ok: false, error: 'update_policy_missing', beforePolicy, beforeState };
  if (beforePolicy.using_expression !== CAPTURED_UPDATE_USING) {
    return { ok: false, error: 'using_expression_drift', beforePolicy, beforeState };
  }
  if (mode === 'apply' && beforePolicy.with_check_expression !== CAPTURED_UPDATE_CHECK) {
    return { ok: false, error: 'with_check_not_prechange_baseline', beforePolicy, beforeState };
  }
  if (mode === 'revert' && beforePolicy.with_check_expression !== CORRECTED_UPDATE_CHECK
    && beforePolicy.with_check_expression !== CAPTURED_UPDATE_CHECK) {
    return { ok: false, error: 'with_check_unknown_cannot_revert', beforePolicy, beforeState };
  }
  if (beforeState.request?.status !== 'requested'
    || beforeState.request?.assigned_employee_id
    || beforeState.request?.accepted_at
    || beforeState.billingCount !== 0) {
    return { ok: false, error: 'fixture_drift', beforePolicy, beforeState };
  }

  const nextCheck = mode === 'revert' ? CAPTURED_UPDATE_CHECK : CORRECTED_UPDATE_CHECK;
  await client.query(
    `DROP POLICY IF EXISTS aws_update_mortgage_handling_requests ON public.mortgage_handling_requests`,
  );
  await client.query(
    `CREATE POLICY aws_update_mortgage_handling_requests ON public.mortgage_handling_requests
       FOR UPDATE TO authenticated
       USING (${CAPTURED_UPDATE_USING})
       WITH CHECK (${nextCheck})`,
  );
  const afterPolicy = await readUpdatePolicy(client);
  const afterState = await readFixtureState(client);
  const expectedCheck = nextCheck;
  const usingOk = afterPolicy?.using_expression === CAPTURED_UPDATE_USING;
  const checkOk = mode === 'revert'
    ? afterPolicy?.with_check_expression === CAPTURED_UPDATE_CHECK
    : Boolean(hasSelfAssignWriterClause(afterPolicy?.with_check_expression)
      && afterPolicy?.with_check_expression?.includes("status = 'requested'"));
  const ok = usingOk
    && checkOk
    && afterState.request?.status === 'requested'
    && afterState.request?.assigned_employee_id == null
    && afterState.request?.accepted_at == null
    && afterState.billingCount === 0;
  return {
    ok,
    error: ok ? null : 'policy_apply_mismatch',
    mode,
    beforePolicy,
    afterPolicy,
    beforeState,
    afterState,
    expectedUsing: CAPTURED_UPDATE_USING,
    expectedCheck,
  };
};

const evalWithCheck = async (client, { userId, email, assignedTo, tenantId, requestId }) => {
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL ROLE checksops');
    await client.query('SET LOCAL row_security = on');
    await client.query("SELECT set_config('request.app_user_id', $1, true)", [userId]);
    await client.query("SELECT set_config('request.jwt.claim.email', $1, true)", [email || '']);
    const ctx = (await client.query(
      `SELECT auth.uid()::text AS auth_uid,
              public.aws_can_write_tenant($1::uuid) AS can_write_target_tenant,
              public.aws_can_write_tenant($2::uuid) AS can_write_billing,
              public.has_role(auth.uid(), 'admin'::public.app_role) AS has_admin,
              public.has_role(auth.uid(), 'mortgage_agent'::public.app_role) AS has_mortgage_agent,
              public.aws_is_cross_tenant_reader() AS cross_tenant_reader`,
      [tenantId, BILLING_TENANT_ID],
    )).rows[0];
    const policy = await readUpdatePolicy(client);
    const usingOk = (await client.query(
      `SELECT (${policy.using_expression}) AS ok
       FROM public.mortgage_handling_requests WHERE id = $1::uuid`,
      [requestId],
    )).rows[0]?.ok ?? null;
    const checkOk = (await client.query(
      `SELECT (${policy.with_check_expression}) AS ok
       FROM (
         VALUES (
           $1::uuid,
           'in_progress'::text,
           $2::uuid,
           now(),
           $3::uuid,
           $4::uuid,
           $5::uuid,
           $6::uuid
         )
       ) AS mortgage_handling_requests(
         tenant_id, status, assigned_employee_id, accepted_at,
         claim_id, check_intake_item_id, requested_by, id
       )`,
      [tenantId, assignedTo, STOPPED_CLAIM_ID, STOPPED_CHECK_ID, userId, requestId],
    )).rows[0]?.ok ?? null;
    await client.query('ROLLBACK');
    return { ctx, usingOk, checkOk, with_check_expression: policy.with_check_expression };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    return { error: String(error.message || error).slice(0, 300) };
  }
};

const proveAcceptRlsCorrection = async (client) => {
  const state = await readFixtureState(client);
  if (state.request?.status !== 'requested'
    || state.request?.assigned_employee_id
    || state.request?.accepted_at
    || state.billingCount !== 0) {
    return { ok: false, error: 'fixture_drift', state };
  }
  const policy = await readUpdatePolicy(client);
  if (!hasSelfAssignWriterClause(policy?.with_check_expression)
    || policy.using_expression !== CAPTURED_UPDATE_USING) {
    return { ok: false, error: 'policy_not_corrected', policy, expected: CORRECTED_UPDATE_CHECK };
  }
  const otherTenantRequest = (await client.query(
    `SELECT id, tenant_id, status, assigned_employee_id
     FROM public.mortgage_handling_requests
     WHERE tenant_id IS DISTINCT FROM $1::uuid
     ORDER BY created_at DESC
     LIMIT 1`,
    [BILLING_TENANT_ID],
  )).rows[0] || null;

  const allowSelf = await evalWithCheck(client, {
    userId: MDE2E_USER_ID,
    email: EMAIL,
    assignedTo: MDE2E_USER_ID,
    tenantId: BILLING_TENANT_ID,
    requestId: STOPPED_REQUEST_ID,
  });
  const rejectOtherAssignee = await evalWithCheck(client, {
    userId: MDE2E_USER_ID,
    email: EMAIL,
    assignedTo: OTHER_ASSIGNEE_ID,
    tenantId: BILLING_TENANT_ID,
    requestId: STOPPED_REQUEST_ID,
  });
  const rejectOtherTenantAdmin = await evalWithCheck(client, {
    userId: C1C_ADMIN_USER_ID,
    email: C1C_ADMIN_EMAIL,
    assignedTo: C1C_ADMIN_USER_ID,
    tenantId: BILLING_TENANT_ID,
    requestId: STOPPED_REQUEST_ID,
  });
  const rejectNoAccess = await evalWithCheck(client, {
    userId: EXISTING_INVALID_ID,
    email: EXISTING_INVALID_EMAIL,
    assignedTo: EXISTING_INVALID_ID,
    tenantId: BILLING_TENANT_ID,
    requestId: STOPPED_REQUEST_ID,
  });
  let rejectOtherTenantRequest = { skipped: true };
  if (otherTenantRequest) {
    rejectOtherTenantRequest = {
      otherTenantRequest,
      ...(await evalWithCheck(client, {
        userId: MDE2E_USER_ID,
        email: EMAIL,
        assignedTo: MDE2E_USER_ID,
        tenantId: otherTenantRequest.tenant_id,
        requestId: otherTenantRequest.id,
      })),
    };
  } else {
    rejectOtherTenantRequest = await evalWithCheck(client, {
      userId: MDE2E_USER_ID,
      email: EMAIL,
      assignedTo: MDE2E_USER_ID,
      tenantId: FREEDOM_TENANT_ID,
      requestId: STOPPED_REQUEST_ID,
    });
    rejectOtherTenantRequest.note = 'no other-tenant request found; evaluated Freedom tenant_id against the stopped row identity';
  }

  const proofs = {
    allow_self_assign_in_progress: {
      expect: true,
      checkOk: allowSelf.checkOk,
      usingOk: allowSelf.usingOk,
      pass: allowSelf.checkOk === true && allowSelf.usingOk === true,
      detail: allowSelf,
    },
    reject_assign_other_user: {
      expect: false,
      checkOk: rejectOtherAssignee.checkOk,
      pass: rejectOtherAssignee.checkOk === false,
      detail: rejectOtherAssignee,
    },
    reject_other_tenant_admin: {
      expect: false,
      checkOk: rejectOtherTenantAdmin.checkOk,
      pass: rejectOtherTenantAdmin.checkOk === false,
      detail: rejectOtherTenantAdmin,
    },
    reject_no_tenant_access: {
      expect: false,
      checkOk: rejectNoAccess.checkOk,
      pass: rejectNoAccess.checkOk === false,
      detail: rejectNoAccess,
    },
    reject_other_tenant_request: {
      expect: false,
      checkOk: rejectOtherTenantRequest.checkOk,
      pass: rejectOtherTenantRequest.checkOk === false,
      detail: rejectOtherTenantRequest,
    },
  };
  const unexpectedAllows = Object.entries(proofs)
    .filter(([, p]) => p.expect === false && p.checkOk === true)
    .map(([name]) => name);
  const failedRequired = Object.entries(proofs)
    .filter(([, p]) => p.pass !== true)
    .map(([name]) => name);
  return {
    ok: failedRequired.length === 0,
    error: failedRequired.length ? 'rls_proof_failed' : null,
    unexpectedAllows,
    failedRequired,
    policy,
    state,
    proofs,
  };
};

const readBilling = async (client, event) => {
  const requestId = event.requestId;
  const checkId = event.checkId;
  const claimId = event.claimId;
  return (await client.query(
    `SELECT id, event_type, status, unit_price_cents, tenant_id, claim_id,
            check_intake_item_id, mortgage_request_id, billed_at, stripe_meter_event_id,
            stripe_customer_id
     FROM public.check_billing_events
     WHERE tenant_id = $1::uuid
       AND (
         mortgage_request_id = $2::uuid
         OR check_intake_item_id = $3::uuid
         OR claim_id = $4::uuid
       )
     ORDER BY billed_at`,
    [BILLING_TENANT_ID, requestId, checkId, claimId],
  )).rows;
};

export const handler = async (event = {}) => {
  const action = String(event.action || 'uniqueness').trim();
  const out = { ok: false, action, email: EMAIL, readOnly: action !== 'create', rowsCreated: 0 };
  let client;
  try {
    client = await openAdmin();
    const identity = (await client.query(
      `SELECT current_database() AS current_database, current_user AS current_user`,
    )).rows[0];
    if (identity.current_database !== 'checksops') throw new Error('wrong database');
    out.identity = identity;

    if (action === 'uniqueness') {
      const requested = String(event.email || EMAIL).trim().toLowerCase();
      out.email = requested;
      out.uniqueness = await uniqueness(client, requested);
      out.ok = out.uniqueness.unused;
      out.error = out.ok ? null : 'email_already_used';
      return out;
    }

    if (action === 'create') {
      const created = await createRows(client, {
        applicationUserId: event.applicationUserId,
        cognitoSub: event.cognitoSub,
      });
      return { ...out, ...created, readOnly: false };
    }

    if (action === 'verify') {
      if (!UUID_RE.test(event.applicationUserId || '')) throw new Error('invalid application_user_id');
      out.isolation = await verifyIsolation(client, event.applicationUserId);
      out.ok = true;
      return out;
    }

    if (action === 'fixture_preflight') {
      out.fixturePreflight = await fixturePreflight(client);
      out.ok = Boolean(out.fixturePreflight.ratesOk);
      out.readOnly = true;
      return out;
    }

    if (action === 'f1') {
      const created = await createClaim(client, event);
      return { ...out, ...created, readOnly: false };
    }

    if (action === 'f2') {
      const created = await createCheck(client, event);
      return { ...out, ...created, readOnly: false };
    }

    if (action === 'f3') {
      const updated = await linkRequestClaim(client, event);
      return { ...out, ...updated, readOnly: false };
    }

    if (action === 'billing_read') {
      out.billing = await readBilling(client, event);
      out.ok = true;
      out.readOnly = true;
      return out;
    }

    if (action === 'diagnose_accept') {
      const diagnosed = await diagnoseAccept(client, event);
      return { ...out, ...diagnosed, readOnly: true, rowsCreated: 0 };
    }

    if (action === 'apply_accept_rls') {
      const applied = await applyAcceptRlsCorrection(client, { mode: 'apply' });
      return { ...out, ...applied, readOnly: false, rowsCreated: 0 };
    }

    if (action === 'revert_accept_rls') {
      const reverted = await applyAcceptRlsCorrection(client, { mode: 'revert' });
      return { ...out, ...reverted, readOnly: false, rowsCreated: 0 };
    }

    if (action === 'prove_accept_rls') {
      const proved = await proveAcceptRlsCorrection(client);
      return { ...out, ...proved, readOnly: true, rowsCreated: 0 };
    }

    out.error = 'unknown_action';
    return out;
  } catch (error) {
    out.error = String(error.message || error).slice(0, 400);
    return out;
  } finally {
    if (client) {
      try { await client.end(); } catch { /* ignore */ }
    }
  }
};
