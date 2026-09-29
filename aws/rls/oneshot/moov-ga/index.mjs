/**
 * Apply Moov GA defaults on the target AWS RDS database. No CheckAlt changes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const { Client } = pg;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CA_PATH = path.join(ROOT, 'rds-global-bundle.pem');
const SQL = fs.readFileSync(path.join(ROOT, '42_moov_generally_available.sql'), 'utf8');
const C1C = '4f172140-f57a-4744-8050-95f4f07b13b4';
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';

const adminClient = async () => {
  const arn = process.env.ADMIN_SECRET_ARN;
  if (!arn || !/checksops_admin/i.test(arn)) throw new Error('ADMIN_SECRET_ARN must be checksops_admin');
  const sm = new SecretsManagerClient({});
  const secret = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  const parsed = JSON.parse(secret.SecretString);
  const host = parsed.host && parsed.host !== 'localhost' ? parsed.host : process.env.RDS_HOST;
  const client = new Client({
    host,
    port: Number(parsed.port || 5432),
    user: parsed.username,
    password: parsed.password,
    database: process.env.DATABASE_NAME || 'checksops',
    ssl: { rejectUnauthorized: true, ca: fs.readFileSync(CA_PATH, 'utf8') },
    connectionTimeoutMillis: 8000,
    query_timeout: 120000,
  });
  await client.connect();
  return client;
};

export const handler = async () => {
  let client;
  try {
    client = await adminClient();
  } catch (error) {
    return {
      ok: false,
      phase: 'connect',
      error: String(error.message || error).slice(0, 500),
    };
  }
  try {
    await client.query('BEGIN');
    await client.query(SQL);
    const tenants = (await client.query(`
      SELECT id, slug, name, is_test_account, payment_provider, moov_environment, moov_allowlisted,
             EXISTS (
               SELECT 1 FROM public.payment_provider_accounts p
               WHERE p.tenant_id = t.id AND p.provider = 'moov'
             ) AS has_moov_account
      FROM public.tenants t
      WHERE id IN ($1::uuid, $2::uuid)
      ORDER BY slug
    `, [FREEDOM, C1C])).rows;
    const defaults = (await client.query(`
      SELECT column_name, column_default
      FROM information_schema.columns
      WHERE table_schema='public' AND table_name='tenants'
        AND column_name IN ('payment_provider','moov_environment','moov_allowlisted')
      ORDER BY 1
    `)).rows;
    const trigger = (await client.query(`
      SELECT tgname FROM pg_trigger
      WHERE tgname = 'trg_apply_tenant_moov_ga_defaults'
    `)).rows;
    const checkalt = (await client.query(`
      SELECT count(*)::int AS n FROM public.checkalt_tenant_accounts
    `)).rows[0];
    const probeSlug = `moov-ga-probe-${Date.now()}`;
    const inserted = (await client.query(`
      INSERT INTO public.tenants (name, slug) VALUES ('Moov GA Probe', $1)
      RETURNING payment_provider, moov_environment, moov_allowlisted, is_test_account
    `, [probeSlug])).rows[0];
    await client.query('DELETE FROM public.tenants WHERE slug = $1', [probeSlug]);
    await client.query('COMMIT');
    return {
      ok: true,
      database: process.env.DATABASE_NAME || 'checksops',
      tenants,
      defaults,
      triggerPresent: trigger.length > 0,
      checkaltTenantAccounts: checkalt.n,
      newTenantDefaults: inserted,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    return { ok: false, error: String(error.message || error).slice(0, 500) };
  } finally {
    await client.end();
  }
};
