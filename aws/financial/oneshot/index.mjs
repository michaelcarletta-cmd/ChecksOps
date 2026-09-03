import fs from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const { Client } = pg;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SQL_DIR = fs.existsSync(path.join(ROOT, 'sql'))
  ? path.join(ROOT, 'sql')
  : path.join(ROOT, '..', 'sql');
const RLS_SQL_DIR = fs.existsSync(path.join(ROOT, 'rls-sql'))
  ? path.join(ROOT, 'rls-sql')
  : path.join(ROOT, '..', '..', 'rls', 'sql');
const CA_PATH = [
  path.join(ROOT, 'rds-global-bundle.pem'),
  path.join(ROOT, '..', '..', 'functions', 'api', 'rds-global-bundle.pem'),
  path.join(ROOT, '..', '..', 'write-path', 'oneshot', 'rds-global-bundle.pem'),
  path.join(ROOT, '..', '..', 'rls', 'oneshot', 'rds-global-bundle.pem'),
].find((p) => fs.existsSync(p));

export const NINTH_ID = 'dd24eea5-5d12-47d1-999e-d5930c278b7d';
export const FREEDOM_TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';

const readSql = (dir, name) => fs.readFileSync(path.join(dir, name), 'utf8');

const adminClient = async () => {
  const arn = process.env.ADMIN_SECRET_ARN;
  if (!arn) throw new Error('ADMIN_SECRET_ARN is not configured');
  if (!/checksops_admin/i.test(arn)) throw new Error('ADMIN_SECRET_ARN must be the checksops_admin secret');
  const sm = new SecretsManagerClient({});
  const secret = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  const parsed = JSON.parse(secret.SecretString);
  if (!/checksops_admin/i.test(parsed.username || '')) {
    throw new Error('secret username is not checksops_admin');
  }
  const host = parsed.host && parsed.host !== 'localhost' && parsed.host !== '127.0.0.1'
    ? parsed.host
    : process.env.RDS_HOST;
  if (!host || host === 'localhost' || host === '127.0.0.1') {
    throw new Error('admin secret host is missing or loopback');
  }
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

const financialAggregates = async (client) => {
  const sql = readSql(RLS_SQL_DIR, '28_financial_aggregates.sql');
  const { rows } = await client.query(sql);
  const out = {};
  for (const row of rows) out[row.metric] = String(row.value);
  return out;
};

const tablePrivileges = async (client) => {
  const { rows } = await client.query(`
    SELECT grantee, table_name, privilege_type
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name IN (
        'aws_financial_operations', 'aws_financial_audit',
        'aws_financial_reconciliation_findings',
        'claim_payments', 'homeowner_ledger_events',
        'checkalt_deposits', 'payment_transfers',
        'disbursement_splits', 'disbursement_batches'
      )
      AND grantee IN ('checksops', 'authenticated')
    ORDER BY table_name, grantee, privilege_type
  `);
  return rows;
};

export const handler = async (event) => {
  const step = event?.step || event?.queryStringParameters?.step || 'grants';
  const client = await adminClient();
  try {
    if (step === 'financial') {
      return { ok: true, financial: await financialAggregates(client) };
    }
    if (step === 'provider_ids') {
      const accounts = (await client.query(`
        SELECT provider, provider_account_id, environment
        FROM public.payment_provider_accounts
        WHERE environment = 'production'
        ORDER BY provider, provider_account_id
      `)).rows;
      const wallets = (await client.query(`
        SELECT provider, provider_wallet_id, provider_account_id, environment
        FROM public.payment_wallets
        WHERE environment = 'production'
        ORDER BY provider, provider_wallet_id
      `)).rows;
      return {
        ok: true,
        productionExecution: false,
        productionRecordsMutated: false,
        environments: [...new Set(accounts.map((row) => row.environment))],
        productionAccountCount: accounts.length,
        productionWalletCount: wallets.length,
        moovAccountCount: accounts.filter((row) => row.provider === 'moov').length,
        moovWalletCount: wallets.filter((row) => /moov/i.test(row.provider || '')).length,
        productionAccountIds: accounts.map((row) => ({
          provider: row.provider,
          provider_account_id: row.provider_account_id,
        })),
        productionWalletIds: wallets.map((row) => ({
          provider: row.provider,
          provider_wallet_id: row.provider_wallet_id,
        })),
      };
    }
    if (step === 'sandbox_apply_grants') {
      const before = await financialAggregates(client);
      await client.query(readSql(SQL_DIR, '62_sandbox_financial_apply_grants.sql'));
      const after = await financialAggregates(client);
      const fns = (await client.query(`
        SELECT p.proname
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname LIKE 'aws_sandbox_apply%'
        ORDER BY p.proname
      `)).rows.map((row) => row.proname);
      let deniedWithoutGuc = false;
      try {
        await client.query('SET ROLE checksops');
        await client.query("SELECT set_config('request.provider_webhook_apply', '', true)");
        await client.query("SELECT * FROM public.aws_sandbox_apply_moov_transfer_status('no-such', 'completed', 'completed', NULL)");
      } catch (error) {
        deniedWithoutGuc = /sandbox_financial_apply_denied|42501/.test(String(error.message || error));
      } finally {
        try { await client.query('RESET ROLE'); } catch { /* ignore */ }
      }
      const moneyLedgersWritable = (await tablePrivileges(client)).some((row) => (
        ['claim_payments', 'homeowner_ledger_events', 'checkalt_deposits', 'payment_transfers',
          'disbursement_splits', 'disbursement_batches'].includes(row.table_name)
        && row.grantee === 'PUBLIC'
        && ['INSERT', 'UPDATE', 'DELETE'].includes(row.privilege_type)
      ));
      return {
        ok: JSON.stringify(before) === JSON.stringify(after) && deniedWithoutGuc && fns.length >= 3 && !moneyLedgersWritable,
        financialUnchanged: JSON.stringify(before) === JSON.stringify(after),
        deniedWithoutGuc,
        functions: fns,
        moneyLedgersWritableToPublic: moneyLedgersWritable,
        activationSqlApplied: false,
        AWS_FINANCIAL_PERMISSIONS_ACTIVATED: false,
      };
    }
    if (step === 'sandbox') {
      const before = await financialAggregates(client);
      await client.query(readSql(SQL_DIR, '70_provider_sandbox.sql'));
      const after = await financialAggregates(client);
      const tables = (await client.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name LIKE 'aws_provider_sandbox_%'
        ORDER BY table_name
      `)).rows.map((row) => row.table_name);
      const moneyLedgersWritable = (await tablePrivileges(client)).some((row) => (
        ['claim_payments', 'homeowner_ledger_events', 'checkalt_deposits', 'payment_transfers',
          'disbursement_splits', 'disbursement_batches'].includes(row.table_name)
        && row.grantee === 'checksops'
        && ['INSERT', 'UPDATE', 'DELETE'].includes(row.privilege_type)
      ));
      return {
        ok: JSON.stringify(before) === JSON.stringify(after) && !moneyLedgersWritable && tables.length === 4,
        financialUnchanged: JSON.stringify(before) === JSON.stringify(after),
        moneyLedgersWritable,
        sandboxTables: tables,
        financial: after,
      };
    }
    if (step === 'revoke') {
      await client.query(readSql(SQL_DIR, '61_financial_preactivation_revoke.sql'));
      return { ok: true, revoked: true, privileges: await tablePrivileges(client) };
    }
    if (step === 'cleanup-t6') {
      const marker = event?.marker || 'AWS T6 FINANCIAL%';
      const ops = await client.query(
        `DELETE FROM public.aws_financial_operations
         WHERE simulated = true
           AND (metadata->>'marker' LIKE $1 OR metadata->>'marker' = $2)
         RETURNING id`,
        [marker, String(marker).replace(/%$/, '')],
      );
      const findings = await client.query(
        `DELETE FROM public.aws_financial_reconciliation_findings
         WHERE details->>'marker' LIKE $1`,
        [marker],
      );
      const checks = await client.query(`
        SELECT id FROM public.check_intake_items
        WHERE claim_id IS NULL
          AND (
            carrier_name LIKE $1
            OR review_notes LIKE $1
            OR front_image_path LIKE 'checks/%/aws-t6%'
          )
      `, [marker]);
      const ids = checks.rows.map((row) => row.id);
      if (ids.length) {
        await client.query('DELETE FROM public.check_endorsement_events WHERE check_id = ANY($1::uuid[])', [ids]);
        await client.query('DELETE FROM public.check_endorsements WHERE check_id = ANY($1::uuid[])', [ids]);
        await client.query('DELETE FROM public.check_payees WHERE check_id = ANY($1::uuid[])', [ids]);
        await client.query('DELETE FROM public.check_messages WHERE check_id = ANY($1::uuid[])', [ids]);
        await client.query('DELETE FROM public.check_files WHERE check_intake_item_id = ANY($1::uuid[])', [ids]);
        await client.query('DELETE FROM public.check_message_reads WHERE check_id = ANY($1::uuid[])', [ids]);
        await client.query('DELETE FROM public.check_audit_log WHERE check_id = ANY($1::uuid[])', [ids]);
        await client.query('DELETE FROM public.mortgage_handling_requests WHERE check_intake_item_id = ANY($1::uuid[])', [ids]);
        const drafts = (await client.query(
          'SELECT id FROM public.loss_draft_tracking WHERE check_intake_item_id = ANY($1::uuid[])',
          [ids],
        )).rows.map((row) => row.id);
        if (drafts.length) {
          await client.query('DELETE FROM public.loss_draft_audit_log WHERE loss_draft_id = ANY($1::uuid[])', [drafts]);
          await client.query('DELETE FROM public.loss_draft_documents WHERE loss_draft_id = ANY($1::uuid[])', [drafts]);
          await client.query('DELETE FROM public.loss_draft_tracking WHERE id = ANY($1::uuid[])', [drafts]);
        }
        await client.query('DELETE FROM public.check_review_decisions WHERE check_id = ANY($1::uuid[])', [ids]);
        await client.query('DELETE FROM public.check_status_audit WHERE check_intake_item_id = ANY($1::uuid[])', [ids]);
        await client.query('DELETE FROM public.check_intake_items WHERE id = ANY($1::uuid[])', [ids]);
      }
      return {
        ok: true,
        deletedOperations: ops.rowCount,
        deletedFindings: findings.rowCount,
        deletedChecks: ids.length,
      };
    }
    const before = await financialAggregates(client);
    await client.query(readSql(SQL_DIR, '60_financial_preactivation.sql'));
    const privileges = await tablePrivileges(client);
    const after = await financialAggregates(client);
    const financialUnchanged = JSON.stringify(before) === JSON.stringify(after);
    const moneyLedgersWritable = privileges.some((row) => (
      ['claim_payments', 'homeowner_ledger_events', 'checkalt_deposits', 'payment_transfers',
        'disbursement_splits', 'disbursement_batches'].includes(row.table_name)
      && row.grantee === 'checksops'
      && ['INSERT', 'UPDATE', 'DELETE'].includes(row.privilege_type)
    ));
    const certWritable = privileges.some((row) => (
      row.table_name === 'aws_financial_operations'
      && row.grantee === 'checksops'
      && row.privilege_type === 'INSERT'
    ));
    return {
      ok: financialUnchanged && !moneyLedgersWritable && certWritable,
      step,
      financialUnchanged,
      moneyLedgersWritable,
      certWritable,
      financial: after,
      privileges,
    };
  } finally {
    await client.end();
  }
};
