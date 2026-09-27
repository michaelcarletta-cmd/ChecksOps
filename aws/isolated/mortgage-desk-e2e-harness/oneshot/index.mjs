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

const EMAIL = 'claims+mde2e@freedomadj.com';
const BILLING_TENANT_ID = '41cbc4b4-c5cd-4020-a6aa-0905e79dafe9';
const FREEDOM_TENANT_ID = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const C1C_TENANT_ID = '4f172140-f57a-4744-8050-95f4f07b13b4';
const ZERO_TENANT_ID = '22233ffe-7a69-4c46-88c3-1587dc525f1f';
const EXISTING_INVALID_ID = 'c7729c3e-d87b-46c6-973e-9c04fbdcc961';
const STAGING_HOST = 'checksops-staging.cyr0q4kcop3c.us-east-1.rds.amazonaws.com';
const SYNTHETIC_NAME = 'SYNTHETIC / MDE2E / NOT A CUSTOMER';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

const uniqueness = async (client) => {
  const identity = (await client.query(
    `SELECT application_user_id, email, status, cognito_sub IS NOT NULL AS has_cognito_sub
     FROM public.identity_accounts
     WHERE lower(email) = lower($1)`,
    [EMAIL],
  )).rows;
  const profiles = (await client.query(
    `SELECT id, email, full_name FROM public.profiles WHERE lower(email) = lower($1)`,
    [EMAIL],
  )).rows;
  const roles = (await client.query(
    `SELECT ur.user_id, ur.role, ia.email
     FROM public.user_roles ur
     LEFT JOIN public.identity_accounts ia ON ia.application_user_id = ur.user_id
     WHERE lower(ia.email) = lower($1)
        OR ur.user_id IN (SELECT id FROM public.profiles WHERE lower(email) = lower($1))`,
    [EMAIL],
  )).rows;
  const memberships = (await client.query(
    `SELECT tu.user_id, tu.tenant_id, tu.role
     FROM public.tenant_users tu
     WHERE tu.user_id IN (
       SELECT application_user_id FROM public.identity_accounts WHERE lower(email) = lower($1)
       UNION
       SELECT id FROM public.profiles WHERE lower(email) = lower($1)
     )`,
    [EMAIL],
  )).rows;
  const unused = identity.length === 0 && profiles.length === 0 && roles.length === 0 && memberships.length === 0;
  return {
    email: EMAIL,
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
      out.uniqueness = await uniqueness(client);
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
