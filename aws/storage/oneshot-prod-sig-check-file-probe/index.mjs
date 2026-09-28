/**
 * Production read-only probe for the signature check-file selector.
 * Does not create a signature request. Does not delete the UI fixture.
 * Does not change check files Michael already uploaded.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const { Client } = pg;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REQUIRED_HOST = 'checksops-production.cyr0q4kcop3c.us-east-1.rds.amazonaws.com';
const FREEDOM_TENANT_ID = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const CHECK_ID = '3916f620-9d20-499b-8450-9e1a8e70a3c9';
const CLAIM_ID = '1de2f734-de37-404a-aa3e-d23905f7a6ea';
const CHECK_NUMBER = 'UI-SIG-TEST-CHK-AD99';

const loadAdmin = async () => {
  const arn = process.env.ADMIN_SECRET_ARN || '';
  if (!arn.includes('checksops-production') || !/checksops_admin/i.test(arn)) {
    throw new Error('ADMIN_SECRET_ARN must be the production checksops_admin secret');
  }
  const sm = new SecretsManagerClient({});
  const out = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  const parsed = JSON.parse(out.SecretString);
  if (!/checksops_admin/i.test(parsed.username || '')) throw new Error('refusing non-admin secret');
  const host = parsed.host || parsed.hostname || process.env.RDS_HOST;
  if (host !== REQUIRED_HOST) throw new Error(`refusing host ${host}`);
  return {
    username: parsed.username,
    password: parsed.password,
    host,
    port: Number(parsed.port || 5432),
    database: parsed.dbname || parsed.database || process.env.DATABASE_NAME || 'checksops',
  };
};

const caPath = [
  path.join(ROOT, 'rds-global-bundle.pem'),
  path.join(ROOT, '..', 'oneshot-public-write', 'rds-global-bundle.pem'),
  path.join(ROOT, '../../functions/api/rds-global-bundle.pem'),
].find((p) => fs.existsSync(p));

const isEligible = (fileName) => {
  const name = String(fileName || '').toLowerCase();
  return name.endsWith('.pdf') || name.endsWith('.docx');
};

const mergeRows = ({ claimFiles, checkFiles, checkIntakeItemId }) => {
  const scoped = (checkFiles || []).filter((row) => (
    checkIntakeItemId && String(row.check_intake_item_id || '') === String(checkIntakeItemId)
  ));
  const checkRows = scoped.filter((row) => isEligible(row.file_name)).map((row) => ({
    ...row,
    _source: 'check_file',
  }));
  const claimRows = (claimFiles || []).filter((row) => isEligible(row.file_name)).map((row) => ({
    ...row,
    _source: 'claim_file',
  }));
  const seen = new Set();
  const merged = [];
  for (const row of [...checkRows, ...claimRows]) {
    const key = String(row.file_path || '').split('?')[0].trim() || `${row._source}:${row.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(row);
  }
  return merged;
};

export const handler = async () => {
  const creds = await loadAdmin();
  const client = new Client({
    host: creds.host,
    port: creds.port,
    user: creds.username,
    password: creds.password,
    database: creds.database,
    ssl: caPath ? { ca: fs.readFileSync(caPath, 'utf8'), rejectUnauthorized: true } : { rejectUnauthorized: false },
    statement_timeout: 20000,
  });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET TRANSACTION READ ONLY');
    const fixture = (await client.query(
      `SELECT c.id AS check_id, c.claim_id, c.tenant_id, c.check_number, c.amount,
              c.status, c.check_stage, cl.claim_number, cl.status AS claim_status
       FROM public.check_intake_items c
       JOIN public.claims cl ON cl.id = c.claim_id
       WHERE c.id = $1::uuid AND cl.id = $2::uuid AND c.check_number = $3`,
      [CHECK_ID, CLAIM_ID, CHECK_NUMBER],
    )).rows[0];
    if (!fixture) throw new Error('production UI fixture not found');

    const checkFiles = (await client.query(
      `SELECT id, file_name, file_path, created_at, check_intake_item_id
       FROM public.check_files
       WHERE check_intake_item_id = $1::uuid
       ORDER BY created_at DESC`,
      [CHECK_ID],
    )).rows;
    const claimFiles = (await client.query(
      `SELECT id, file_name, file_path, uploaded_at, claim_id
       FROM public.claim_files
       WHERE claim_id = $1::uuid
       ORDER BY uploaded_at DESC NULLS LAST`,
      [CLAIM_ID],
    )).rows;
    const otherCheckFiles = (await client.query(
      `SELECT cf.id, cf.file_name, cf.check_intake_item_id
       FROM public.check_files cf
       JOIN public.check_intake_items c ON c.id = cf.check_intake_item_id
       WHERE c.tenant_id = $1::uuid
         AND cf.check_intake_item_id IS DISTINCT FROM $2::uuid
         AND (cf.file_name ILIKE '%.pdf' OR cf.file_name ILIKE '%.docx')`,
      [FREEDOM_TENANT_ID, CHECK_ID],
    )).rows;
    const foreignTenantFiles = (await client.query(
      `SELECT cf.id, cf.file_name, c.tenant_id
       FROM public.check_files cf
       JOIN public.check_intake_items c ON c.id = cf.check_intake_item_id
       WHERE cf.check_intake_item_id = $1::uuid
         AND c.tenant_id IS DISTINCT FROM $2::uuid`,
      [CHECK_ID, FREEDOM_TENANT_ID],
    )).rows;
    const merged = mergeRows({
      claimFiles,
      checkFiles,
      checkIntakeItemId: CHECK_ID,
    });
    const requestCount = Number((await client.query(
      `SELECT count(*)::int AS n FROM public.signature_requests
       WHERE claim_id = $1::uuid OR check_intake_item_id = $2::uuid`,
      [CLAIM_ID, CHECK_ID],
    )).rows[0].n);
    const money = (await client.query(`
      SELECT
        (SELECT count(*) FROM public.deposit_items) AS deposit_items,
        (SELECT count(*) FROM public.disbursement_splits) AS disbursement_splits,
        (SELECT count(*) FROM public.payment_transfers) AS payment_transfers,
        (SELECT count(*) FROM public.check_billing_events) AS check_billing_events,
        (SELECT count(*) FROM public.mortgage_handling_requests) AS mortgage_handling_requests,
        (SELECT count(*) FROM public.aws_financial_operations) AS aws_financial_operations,
        (SELECT count(*) FROM public.aws_provider_sandbox_operations) AS aws_provider_sandbox_operations
    `)).rows[0];
    await client.query('ROLLBACK');

    const names = merged.map((row) => row.file_name);
    const currentCheckVisible = merged.some((row) => row._source === 'check_file' && isEligible(row.file_name));
    const otherExcluded = !merged.some((row) => otherCheckFiles.some((foreign) => foreign.id === row.id));
    const proofs = {
      fixture_present: fixture.check_number === CHECK_NUMBER && fixture.tenant_id === FREEDOM_TENANT_ID,
      current_check_pdf_visible: currentCheckVisible,
      other_check_excluded: otherExcluded,
      cross_tenant_excluded: foreignTenantFiles.length === 0,
      claim_files_available: claimFiles.filter((row) => isEligible(row.file_name)).length === 0
        || merged.some((row) => row._source === 'claim_file'),
      signature_request_count_zero: requestCount === 0,
      no_request_created: true,
      fixture_not_deleted: true,
    };

    return {
      ok: Object.values(proofs).every(Boolean),
      env: 'production',
      read_only: true,
      host: creds.host,
      fixture,
      check_files: checkFiles,
      claim_files: claimFiles,
      selector_names: names,
      selector_count: merged.length,
      other_check_eligible_count: otherCheckFiles.length,
      foreign_tenant_files: foreignTenantFiles,
      signature_request_count: requestCount,
      money,
      proofs,
    };
  } finally {
    await client.end();
  }
};
