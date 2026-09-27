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
const BILLING_TENANT_ID = '41cbc4b4-c5cd-4020-a6aa-0905e79dafe9';
const FREEDOM_TENANT_ID = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const C1C_TENANT_ID = '4f172140-f57a-4744-8050-95f4f07b13b4';
const ZERO_TENANT_ID = '22233ffe-7a69-4c46-88c3-1587dc525f1f';
const EXISTING_INVALID_ID = 'c7729c3e-d87b-46c6-973e-9c04fbdcc961';
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
