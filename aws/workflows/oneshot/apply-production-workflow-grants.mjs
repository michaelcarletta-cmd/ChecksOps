/**
 * Production inspect/apply of 73_production_workflow_recording_grants.sql.
 * GRANT checksops only. Never grants authenticated. Never touches provider tables.
 * Refuses non-production admin secrets and hosts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const { Client } = pg;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CA_PATH = [
  path.join(ROOT, 'rds-global-bundle.pem'),
  path.join(ROOT, '..', '..', 'functions', 'api', 'rds-global-bundle.pem'),
].find((p) => fs.existsSync(p));

const TABLES = [
  'deposit_items',
  'deposit_batches',
  'deposit_audit_log',
  'disbursement_batches',
  'disbursement_splits',
];
const FORBIDDEN = ['checkalt_deposits', 'payment_transfers', 'moov_transfers'];
const FIXTURES = [
  '546a43b8-e625-49fc-a359-03b619692f29',
  '368e8d91-bc8a-412f-89e1-5969f76b61f9',
  'ef470398-6df7-4532-b405-87ddf3dfddce',
  '31afc7c3-a9cd-436b-a902-0899dd98caae',
  'a4188a08-4583-419a-9b58-b96d8ff1fcb5',
];

const GRANT_SQL = `
GRANT SELECT, INSERT, UPDATE ON TABLE public.deposit_items TO checksops;
GRANT SELECT, INSERT, UPDATE ON TABLE public.deposit_batches TO checksops;
GRANT SELECT, INSERT ON TABLE public.deposit_audit_log TO checksops;
GRANT SELECT, INSERT, UPDATE ON TABLE public.disbursement_batches TO checksops;
GRANT SELECT, INSERT, UPDATE ON TABLE public.disbursement_splits TO checksops;
GRANT UPDATE (amount, detected_claim_number) ON TABLE public.check_intake_items TO checksops;
`;

const POLICY_SQL = `
DROP POLICY IF EXISTS aws_write_deposit_batches_insert_creator ON public.deposit_batches;
DROP POLICY IF EXISTS aws_write_deposit_batches ON public.deposit_batches;
CREATE POLICY aws_write_deposit_batches ON public.deposit_batches
  FOR ALL TO authenticated
  USING (
    (public.aws_is_authenticated() AND public.aws_is_cross_tenant_reader())
    OR created_by = auth.uid()
    OR EXISTS (
      SELECT 1
      FROM public.deposit_items di
      JOIN public.check_intake_items ci ON ci.id = di.check_id
      WHERE di.batch_id = deposit_batches.id
        AND public.aws_can_write_tenant(ci.tenant_id)
    )
  )
  WITH CHECK (
    (public.aws_is_authenticated() AND public.aws_is_cross_tenant_reader())
    OR created_by = auth.uid()
    OR EXISTS (
      SELECT 1
      FROM public.deposit_items di
      JOIN public.check_intake_items ci ON ci.id = di.check_id
      WHERE di.batch_id = deposit_batches.id
        AND public.aws_can_write_tenant(ci.tenant_id)
    )
  );
`;

const adminClient = async () => {
  const arn = process.env.ADMIN_SECRET_ARN;
  if (!arn) throw new Error('ADMIN_SECRET_ARN is not configured');
  if (!/checksops-production\/checksops_admin/i.test(arn)) {
    throw new Error('refusing non-production admin secret');
  }
  const sm = new SecretsManagerClient({});
  const secret = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  const parsed = JSON.parse(secret.SecretString);
  if (!/checksops_admin/i.test(parsed.username || '')) {
    throw new Error('secret username is not checksops_admin');
  }
  const host = parsed.host && parsed.host !== 'localhost'
    ? parsed.host
    : process.env.RDS_HOST;
  if (!host || !/checksops-production/i.test(host)) {
    throw new Error(`refusing unexpected RDS host ${host}`);
  }
  const client = new Client({
    host,
    port: Number(parsed.port || 5432),
    user: parsed.username,
    password: parsed.password,
    database: process.env.DATABASE_NAME || 'checksops',
    ssl: { rejectUnauthorized: true, ca: fs.readFileSync(CA_PATH, 'utf8') },
    connectionTimeoutMillis: 8000,
    query_timeout: 60000,
  });
  await client.connect();
  return { client, host };
};

const privileges = async (client) => {
  const { rows } = await client.query(`
    SELECT grantee, table_name, privilege_type
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name = ANY($1::text[])
      AND grantee IN ('checksops', 'authenticated')
    ORDER BY table_name, grantee, privilege_type
  `, [TABLES]);
  return rows;
};

const columnPrivs = async (client) => {
  const { rows } = await client.query(`
    SELECT grantee, column_name, privilege_type
    FROM information_schema.column_privileges
    WHERE table_schema = 'public'
      AND table_name = 'check_intake_items'
      AND column_name IN ('amount', 'detected_claim_number')
      AND grantee IN ('checksops', 'authenticated')
    ORDER BY grantee, column_name, privilege_type
  `);
  return rows;
};

const policies = async (client) => {
  const { rows } = await client.query(`
    SELECT pol.polname, pg_get_expr(pol.polwithcheck, pol.polrelid) AS with_check
    FROM pg_policy pol
    JOIN pg_class rel ON rel.oid = pol.polrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public' AND rel.relname = 'deposit_batches'
    ORDER BY pol.polname
  `);
  return rows;
};

const fixtureHits = async (client) => {
  const { rows } = await client.query(
    'SELECT id, check_number, carrier_name FROM public.check_intake_items WHERE id = ANY($1::uuid[])',
    [FIXTURES],
  );
  return rows;
};

export const handler = async (event = {}) => {
  const apply = event.apply === true || event.apply === 'true';
  const applyPolicy = event.applyPolicy === true || event.applyPolicy === 'true';
  const clientWrap = await adminClient();
  const client = clientWrap.client;
  try {
    const before = await privileges(client);
    const beforeCols = await columnPrivs(client);
    const beforePolicies = await policies(client);
    const productionFixtures = await fixtureHits(client);
    const host = clientWrap.host;
    const granted = (table, priv) => before.some((row) => (
      row.table_name === table && row.grantee === 'checksops' && row.privilege_type === priv
    ));
    const colGranted = (col) => beforeCols.some((row) => (
      row.column_name === col && row.grantee === 'checksops' && row.privilege_type === 'UPDATE'
    ));
    const authenticatedFinancial = before.filter((row) => row.grantee === 'authenticated');
    const missing = [];
    for (const table of ['deposit_items', 'deposit_batches', 'disbursement_batches', 'disbursement_splits']) {
      for (const priv of ['SELECT', 'INSERT', 'UPDATE']) {
        if (!granted(table, priv)) missing.push(`${table}.${priv}`);
      }
    }
    if (!granted('deposit_audit_log', 'SELECT')) missing.push('deposit_audit_log.SELECT');
    if (!granted('deposit_audit_log', 'INSERT')) missing.push('deposit_audit_log.INSERT');
    if (!colGranted('amount')) missing.push('check_intake_items.amount.UPDATE');
    if (!colGranted('detected_claim_number')) missing.push('check_intake_items.detected_claim_number.UPDATE');

    const policyHasCreator = beforePolicies.some((row) => /created_by/i.test(String(row.with_check || '')));
    let applied = { grants: false, policy: false };
    if (apply && missing.length) {
      await client.query(GRANT_SQL);
      applied.grants = true;
    }
    if (applyPolicy && !policyHasCreator) {
      await client.query(POLICY_SQL);
      applied.policy = true;
    }
    const after = await privileges(client);
    const afterCols = await columnPrivs(client);
    const afterPolicies = await policies(client);
    const forbiddenTouched = after.some((row) => FORBIDDEN.includes(row.table_name));
    return {
      ok: !forbiddenTouched && productionFixtures.length === 0,
      environment: 'production',
      host,
      apply,
      applyPolicy,
      applied,
      missingBefore: missing,
      policyHasCreator,
      authenticatedFinancialGrants: authenticatedFinancial,
      productionFixtureHits: productionFixtures,
      beforeCount: before.length,
      afterCount: after.length,
      afterCols,
      afterPolicies: afterPolicies.map((row) => row.polname),
      providerExecution: false,
      moovInvoked: false,
    };
  } finally {
    await client.end();
  }
};
