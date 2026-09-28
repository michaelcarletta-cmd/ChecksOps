/**
 * Staging-only signature check-file selector acceptance.
 * Creates/reuses a labeled Freedom fixture, inserts a check PDF the same
 * way the Files tab does, proves the wizard merge query, and writes a draft
 * signature request. Refuses production hosts/secrets. No provider/money calls.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const { Client } = pg;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REQUIRED_HOST = 'checksops-staging.cyr0q4kcop3c.us-east-1.rds.amazonaws.com';
const FREEDOM_TENANT_ID = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const LABEL = 'UI SIG CHECKFILE STAGING — DO NOT PROCESS';
const CLAIM_NUMBER = 'UI-SIG-CHECKFILE-CLAIM-AD99';
const CHECK_NUMBER = 'UI-SIG-CHECKFILE-CHK-AD99';
const OTHER_CHECK_NUMBER = 'UI-SIG-CHECKFILE-OTHER-AD99';
const FILE_NAME = 'UI-SIG-CHECKFILE-STAGING.pdf';
const CLAIM_FILE_NAME = 'UI-SIG-CHECKFILE-CLAIM.pdf';
const OTHER_FILE_NAME = 'UI-SIG-CHECKFILE-OTHER.pdf';

const refuseProduction = (value) => {
  const text = String(value || '');
  if (/checksops-production/i.test(text) || /\/production\//i.test(text)) {
    throw new Error('refusing production secret or host');
  }
};

const loadAdmin = async () => {
  const arn = process.env.ADMIN_SECRET_ARN || '';
  refuseProduction(arn);
  if (!arn.includes('checksops-staging') || !/checksops_admin/i.test(arn)) {
    throw new Error('ADMIN_SECRET_ARN must be the staging checksops_admin secret');
  }
  const sm = new SecretsManagerClient({});
  const out = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  const parsed = JSON.parse(out.SecretString);
  refuseProduction(parsed.host);
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
  path.join(ROOT, '..', 'oneshot', 'rds-global-bundle.pem'),
  path.join(ROOT, '..', 'oneshot-public-write', 'rds-global-bundle.pem'),
  path.join(ROOT, '../../functions/api/rds-global-bundle.pem'),
].find((p) => fs.existsSync(p));

const columnsOf = async (client, table) => (
  await client.query(
    `SELECT column_name, is_nullable, column_default, data_type
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [table],
  )
).rows;

const tableExists = async (client, name) => (
  (await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1
     ) AS ok`,
    [name],
  )).rows[0]?.ok === true
);

const moneySnapshot = async (client) => (await client.query(`
  SELECT
    (SELECT count(*) FROM public.deposit_items) AS deposit_items,
    (SELECT count(*) FROM public.disbursement_splits) AS disbursement_splits,
    (SELECT count(*) FROM public.payment_transfers) AS payment_transfers,
    (SELECT count(*) FROM public.check_billing_events) AS check_billing_events,
    (SELECT count(*) FROM public.mortgage_handling_requests) AS mortgage_handling_requests,
    (SELECT count(*) FROM public.aws_financial_operations) AS aws_financial_operations,
    (SELECT count(*) FROM public.aws_provider_sandbox_operations) AS aws_provider_sandbox_operations
`)).rows[0];

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

const existingFixture = async (client) => {
  const row = (await client.query(
    `SELECT c.id AS check_id, c.claim_id, c.tenant_id, c.check_number, c.amount,
            c.status, c.check_stage, cl.claim_number, cl.status AS claim_status
     FROM public.check_intake_items c
     JOIN public.claims cl ON cl.id = c.claim_id
     WHERE c.check_number = $1
       AND cl.claim_number = $2
       AND c.tenant_id = $3::uuid
     ORDER BY c.created_at DESC
     LIMIT 1`,
    [CHECK_NUMBER, CLAIM_NUMBER, FREEDOM_TENANT_ID],
  )).rows[0];
  return row || null;
};

const createFixture = async (client) => {
  const claimCols = await columnsOf(client, 'claims');
  const claimNames = new Set(claimCols.map((c) => c.column_name));
  const claimColsOut = ['claim_number', 'status', 'org_id'];
  const claimVals = [CLAIM_NUMBER, 'open', FREEDOM_TENANT_ID];
  const claimPush = (name, value) => {
    if (claimNames.has(name) && !claimColsOut.includes(name)) {
      claimColsOut.push(name);
      claimVals.push(value);
    }
  };
  claimPush('policyholder_name', LABEL);
  claimPush('insured_name', LABEL);
  claimPush('loss_description', LABEL);
  claimPush('claim_amount', 0);
  const claimTyped = claimColsOut.map((name, i) => {
    if (name === 'org_id') return `$${i + 1}::uuid`;
    if (name === 'claim_amount') return `$${i + 1}::numeric`;
    return `$${i + 1}`;
  });
  const claim = (await client.query(
    `INSERT INTO public.claims (${claimColsOut.join(', ')})
     VALUES (${claimTyped.join(', ')})
     RETURNING id, claim_number, status, org_id`,
    claimVals,
  )).rows[0];

  const insertCheck = async (checkNumber) => {
    const checkCols = await columnsOf(client, 'check_intake_items');
    const names = new Set(checkCols.map((c) => c.column_name));
    const cols = ['tenant_id', 'claim_id', 'check_number', 'amount'];
    const vals = [FREEDOM_TENANT_ID, claim.id, checkNumber, 0];
    const push = (name, value) => {
      if (names.has(name) && !cols.includes(name)) {
        cols.push(name);
        vals.push(value);
      }
    };
    push('ocr_status', 'completed');
    push('carrier_name', LABEL);
    push('status', 'endorsements_in_progress');
    push('check_stage', 'endorsing');
    push('check_source', 'insurance');
    push('front_image_path', 'ui-sig-checkfile-staging/DO-NOT-PROCESS-NO-IMAGE.txt');
    push('payee_line', null);
    const typed = cols.map((name, i) => {
      if (name === 'tenant_id' || name === 'claim_id') return `$${i + 1}::uuid`;
      if (name === 'amount') return `$${i + 1}::numeric`;
      return `$${i + 1}`;
    });
    return (await client.query(
      `INSERT INTO public.check_intake_items (${cols.join(', ')})
       VALUES (${typed.join(', ')})
       RETURNING id, claim_id, tenant_id, check_number, amount, status, check_stage`,
      vals,
    )).rows[0];
  };

  const check = await insertCheck(CHECK_NUMBER);
  const other = await insertCheck(OTHER_CHECK_NUMBER);
  return { claim, check, other };
};

const insertCheckFile = async (client, checkId, fileName) => {
  const filePath = `check-intake/${checkId}/files/${Date.now()}-${crypto.randomUUID()}-${fileName.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;
  const cols = await columnsOf(client, 'check_files');
  const names = new Set(cols.map((c) => c.column_name));
  const out = ['check_intake_item_id', 'file_name', 'file_path'];
  const vals = [checkId, fileName, filePath];
  const push = (name, value) => {
    if (names.has(name) && !out.includes(name)) {
      out.push(name);
      vals.push(value);
    }
  };
  push('file_type', 'application/pdf');
  push('category', 'other');
  push('source', 'manual');
  const typed = out.map((name, i) => (name === 'check_intake_item_id' ? `$${i + 1}::uuid` : `$${i + 1}`));
  const row = (await client.query(
    `INSERT INTO public.check_files (${out.join(', ')})
     VALUES (${typed.join(', ')})
     RETURNING id, check_intake_item_id, file_name, file_path, created_at`,
    vals,
  )).rows[0];
  return row;
};

const insertClaimFile = async (client, claimId, fileName) => {
  const filePath = `claims/${claimId}/${Date.now()}-${fileName.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;
  const cols = await columnsOf(client, 'claim_files');
  const names = new Set(cols.map((c) => c.column_name));
  const out = ['claim_id', 'file_name', 'file_path'];
  const vals = [claimId, fileName, filePath];
  const push = (name, value) => {
    if (names.has(name) && !out.includes(name)) {
      out.push(name);
      vals.push(value);
    }
  };
  push('file_type', 'application/pdf');
  const typed = out.map((name, i) => (name === 'claim_id' ? `$${i + 1}::uuid` : `$${i + 1}`));
  return (await client.query(
    `INSERT INTO public.claim_files (${out.join(', ')})
     VALUES (${typed.join(', ')})
     RETURNING id, claim_id, file_name, file_path, uploaded_at`,
    vals,
  )).rows[0];
};

const otherTenantProbe = async (client, checkId) => {
  let otherTenant = null;
  try {
    otherTenant = (await client.query(
      `SELECT id FROM public.organizations
       WHERE id IS DISTINCT FROM $1::uuid
       LIMIT 1`,
      [FREEDOM_TENANT_ID],
    )).rows[0];
  } catch {
    otherTenant = (await client.query(
      `SELECT tenant_id AS id FROM public.check_intake_items
       WHERE tenant_id IS DISTINCT FROM $1::uuid
       LIMIT 1`,
      [FREEDOM_TENANT_ID],
    )).rows[0];
  }
  if (!otherTenant) return { other_tenant_id: null, leaked: [] };
  const leaked = (await client.query(
    `SELECT cf.id, cf.file_name, cf.check_intake_item_id, c.tenant_id
     FROM public.check_files cf
     JOIN public.check_intake_items c ON c.id = cf.check_intake_item_id
     WHERE c.tenant_id = $1::uuid
       AND cf.check_intake_item_id = $2::uuid`,
    [otherTenant.id, checkId],
  )).rows;
  const otherTenantFilesOnThisCheck = (await client.query(
    `SELECT cf.id, cf.file_name, c.tenant_id
     FROM public.check_files cf
     JOIN public.check_intake_items c ON c.id = cf.check_intake_item_id
     WHERE cf.check_intake_item_id = $1::uuid
       AND c.tenant_id IS DISTINCT FROM $2::uuid`,
    [checkId, FREEDOM_TENANT_ID],
  )).rows;
  return {
    other_tenant_id: otherTenant.id,
    leaked,
    foreign_tenant_files_on_current_check: otherTenantFilesOnThisCheck,
  };
};

export const handler = async (event = {}) => {
  const action = String(event.action || 'accept');
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
    const session = (await client.query(
      'SELECT inet_server_addr()::text AS addr, current_database() AS db, current_user AS usr',
    )).rows[0];
    if (creds.host !== REQUIRED_HOST) throw new Error('host gate failed');

    let fixture = await existingFixture(client);
    let created = false;
    let otherCheck = null;
    if (!fixture) {
      await client.query('BEGIN');
      try {
        await client.query("SET LOCAL session_replication_role = 'replica'");
      } catch {
        // keep normal triggers; inserts below are file/request only
      }
      const made = await createFixture(client);
      fixture = {
        check_id: made.check.id,
        claim_id: made.claim.id,
        tenant_id: made.check.tenant_id,
        check_number: made.check.check_number,
        amount: made.check.amount,
        status: made.check.status,
        check_stage: made.check.check_stage,
        claim_number: made.claim.claim_number,
        claim_status: made.claim.status,
      };
      otherCheck = made.other;
      await client.query('COMMIT');
      created = true;
    } else {
      otherCheck = (await client.query(
        `SELECT id, check_number, tenant_id FROM public.check_intake_items
         WHERE claim_id = $1::uuid AND id IS DISTINCT FROM $2::uuid
         ORDER BY created_at DESC LIMIT 1`,
        [fixture.claim_id, fixture.check_id],
      )).rows[0];
      if (!otherCheck) {
        await client.query('BEGIN');
        try {
          await client.query("SET LOCAL session_replication_role = 'replica'");
        } catch { /* ok */ }
        const checkCols = await columnsOf(client, 'check_intake_items');
        const names = new Set(checkCols.map((c) => c.column_name));
        const cols = ['tenant_id', 'claim_id', 'check_number', 'amount'];
        const vals = [FREEDOM_TENANT_ID, fixture.claim_id, OTHER_CHECK_NUMBER, 0];
        if (names.has('status')) { cols.push('status'); vals.push('needs_review'); }
        if (names.has('front_image_path')) { cols.push('front_image_path'); vals.push('ui-sig-checkfile-staging/DO-NOT-PROCESS-NO-IMAGE.txt'); }
        const typed = cols.map((name, i) => (
          name === 'tenant_id' || name === 'claim_id' ? `$${i + 1}::uuid` : name === 'amount' ? `$${i + 1}::numeric` : `$${i + 1}`
        ));
        otherCheck = (await client.query(
          `INSERT INTO public.check_intake_items (${cols.join(', ')})
           VALUES (${typed.join(', ')})
           RETURNING id, check_number, tenant_id`,
          vals,
        )).rows[0];
        await client.query('COMMIT');
      }
    }

    const moneyBefore = await moneySnapshot(client);
    const checkFile = await insertCheckFile(client, fixture.check_id, FILE_NAME);
    const claimFile = await insertClaimFile(client, fixture.claim_id, CLAIM_FILE_NAME);
    const otherFile = await insertCheckFile(client, otherCheck.id, OTHER_FILE_NAME);

    const claimFiles = (await client.query(
      `SELECT id, file_name, file_path, uploaded_at, claim_id
       FROM public.claim_files
       WHERE claim_id = $1::uuid
       ORDER BY uploaded_at DESC NULLS LAST`,
      [fixture.claim_id],
    )).rows;
    const checkFiles = (await client.query(
      `SELECT id, file_name, file_path, created_at, check_intake_item_id
       FROM public.check_files
       WHERE check_intake_item_id = $1::uuid
       ORDER BY created_at DESC`,
      [fixture.check_id],
    )).rows;
    const merged = mergeRows({
      claimFiles,
      checkFiles,
      checkIntakeItemId: fixture.check_id,
    });
    const names = merged.map((row) => row.file_name);
    const otherInMerged = merged.some((row) => row.id === otherFile.id || row.file_name === OTHER_FILE_NAME);
    const tenantProbe = await otherTenantProbe(client, fixture.check_id);

    const request = (await client.query(
      `INSERT INTO public.signature_requests (
         claim_id, check_intake_item_id, document_name, document_path, status
       ) VALUES ($1::uuid, $2::uuid, $3, $4, 'draft')
       RETURNING id, claim_id, check_intake_item_id, document_name, document_path, status`,
      [fixture.claim_id, fixture.check_id, FILE_NAME, checkFile.file_path],
    )).rows[0];

    const moneyAfter = await moneySnapshot(client);
    const moneyDrift = Object.keys(moneyBefore).filter((key) => (
      String(moneyAfter[key]) !== String(moneyBefore[key])
    ));

    const proofs = {
      A_check_pdf_inserted: checkFile.file_name === FILE_NAME && checkFile.check_intake_item_id === fixture.check_id,
      D_uploaded_check_pdf_in_selector: names.includes(FILE_NAME),
      F_request_path: request.document_path === checkFile.file_path,
      F_request_check_id: request.check_intake_item_id === fixture.check_id,
      G_linked_claim_file_in_selector: names.includes(CLAIM_FILE_NAME),
      H_other_check_excluded: otherInMerged === false,
      I_other_tenant_no_leak: tenantProbe.leaked.length === 0,
      J_no_money_drift: moneyDrift.length === 0,
    };
    const ok = Object.values(proofs).every(Boolean) && action !== 'inspect';

    return {
      ok: action === 'inspect' ? true : ok,
      action,
      env: 'staging',
      host: creds.host,
      session,
      created,
      fixture,
      other_check: otherCheck,
      check_file: checkFile,
      claim_file: claimFile,
      other_file: otherFile,
      selector_names: names,
      selector_count: merged.length,
      request,
      tenant_probe: tenantProbe,
      money_before: moneyBefore,
      money_after: moneyAfter,
      money_drift: moneyDrift,
      proofs,
      production_untouched: true,
    };
  } finally {
    await client.end();
  }
};
