/**
 * Production UI signature test fixture.
 * Inspect is read-only plus a rolled-back dry-run.
 * Create commits one Freedom-only synthetic fixture. No signature request.
 * Refuses non-production hosts. Does not change application SQL/helpers.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const { Client } = pg;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REQUIRED_HOST = 'checksops-production.cyr0q4kcop3c.us-east-1.rds.amazonaws.com';
const FREEDOM_TENANT_ID = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const FREEDOM_ADMIN_ID = '7dbb3009-f059-4767-b5dc-1c5c72379330';
const LABEL = 'UI SIGNATURE TEST — DO NOT PROCESS';
const CLAIM_NUMBER = 'UI-SIG-TEST-DO-NOT-PROCESS-AD99';
const CHECK_NUMBER = 'UI-SIG-TEST-CHK-AD99';
const HOMEOWNER_NAME = 'UI SIGNATURE TEST — DO NOT PROCESS';
const AUTHORIZED_EMAILS = [
  'checksops-tester@freedomadj.com',
  'mcarletta@freedomadj.com',
  'claims@freedomadj.com',
  'mde2e@freedomadj.com',
  'cursor-delete-check-test@freedomadj.com',
];
const PLACEHOLDER_FRONT = 'ui-signature-test/DO-NOT-PROCESS-NO-IMAGE.txt';

const loadAdmin = async () => {
  const arn = process.env.ADMIN_SECRET_ARN || '';
  if (!arn.includes('checksops-production') || !/checksops_admin/i.test(arn)) {
    throw new Error('refusing non-production admin secret arn');
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
  path.join(ROOT, '..', 'oneshot', 'rds-global-bundle.pem'),
  path.join(ROOT, '..', 'oneshot-public-write', 'rds-global-bundle.pem'),
  path.join(ROOT, '../../functions/api/rds-global-bundle.pem'),
].find((p) => fs.existsSync(p));

const tableExists = async (client, name) => {
  const row = (await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1
     ) AS ok`,
    [name],
  )).rows[0];
  return row?.ok === true;
};

const columnsOf = async (client, table) => (
  await client.query(
    `SELECT column_name, is_nullable, column_default, data_type, udt_name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [table],
  )
).rows;

const checksOf = async (client, table) => (
  await client.query(
    `SELECT conname, pg_get_constraintdef(oid) AS def
     FROM pg_constraint
     WHERE conrelid = $1::regclass
       AND contype = 'c'
     ORDER BY 1`,
    [`public.${table}`],
  )
).rows;

const triggersOf = async (client, table) => (
  await client.query(
    `SELECT t.tgname,
            pg_get_triggerdef(t.oid) AS def,
            p.proname AS fn
     FROM pg_trigger t
     JOIN pg_class c ON c.oid = t.tgrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE n.nspname = 'public'
       AND c.relname = $1
       AND NOT t.tgisinternal
     ORDER BY 1`,
    [table],
  )
).rows;

const isolationFor = async (client, ids) => {
  const q = async (sql, params = []) => {
    await client.query('SAVEPOINT iso_q');
    try {
      const rows = (await client.query(sql, params)).rows;
      await client.query('RELEASE SAVEPOINT iso_q');
      return rows;
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT iso_q');
      return [{ _error: String(error.message || error).slice(0, 240) }];
    }
  };
  const colSet = async (table) => {
    const rows = await q(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1`,
      [table],
    );
    return new Set(rows.map((row) => row.column_name).filter(Boolean));
  };
  const scoped = async (table, prefer) => {
    const cols = await colSet(table);
    if (cols.size === 0) return [];
    const { claimId, checkId } = ids;
    const clauses = [];
    const params = [];
    const add = (column, value) => {
      if (!cols.has(column)) return;
      params.push(value);
      clauses.push(`${column} = $${params.length}::uuid`);
    };
    for (const [column, value] of prefer) add(column, value);
    if (!clauses.length) {
      return [{ _note: `no scoped id column on ${table}`, columns: [...cols] }];
    }
    const selectCols = ['id', 'check_id', 'check_intake_item_id', 'claim_id', 'amount', 'event_type', 'status']
      .filter((name) => cols.has(name))
      .join(', ');
    return q(
      `SELECT ${selectCols || '1'} FROM public.${table} WHERE ${clauses.join(' OR ')}`,
      params,
    );
  };
  const { claimId, checkId, tokenId } = ids;
  return {
    signature_requests: await scoped('signature_requests', [
      ['claim_id', claimId],
      ['check_intake_item_id', checkId],
    ]),
    check_billing_events: await scoped('check_billing_events', [
      ['check_intake_item_id', checkId],
      ['check_id', checkId],
      ['claim_id', claimId],
    ]),
    deposit_items: await scoped('deposit_items', [
      ['check_intake_item_id', checkId],
      ['check_id', checkId],
      ['claim_id', claimId],
    ]),
    disbursement_splits: await scoped('disbursement_splits', [
      ['check_intake_item_id', checkId],
      ['check_id', checkId],
      ['claim_id', claimId],
    ]),
    payment_transfers: await scoped('payment_transfers', [
      ['check_intake_item_id', checkId],
      ['check_id', checkId],
      ['claim_id', claimId],
    ]),
    platform_fee_line_items: await scoped('platform_fee_line_items', [
      ['check_intake_item_id', checkId],
      ['check_id', checkId],
      ['claim_id', claimId],
    ]),
    mortgage_handling_requests: await scoped('mortgage_handling_requests', [
      ['check_id', checkId],
      ['check_intake_item_id', checkId],
      ['claim_id', claimId],
    ]),
    claim_payments: await scoped('claim_payments', [
      ['check_intake_item_id', checkId],
      ['claim_id', claimId],
    ]),
    claim_checks: await scoped('claim_checks', [
      ['check_intake_item_id', checkId],
      ['claim_id', claimId],
    ]),
    homeowner_ledger_events: await scoped('homeowner_ledger_events', [
      ['check_id', checkId],
      ['claim_id', claimId],
    ]),
    tenant_usage_logs: await q(
      `SELECT id, event_type, amount_cents, description
       FROM public.tenant_usage_logs
       WHERE tenant_id = $1::uuid
         AND created_at >= now() - interval '2 minutes'
         AND (description ILIKE '%UI SIGNATURE TEST%' OR description ILIKE '%intake%')`,
      [FREEDOM_TENANT_ID],
    ),
    check_endorsements: await scoped('check_endorsements', [['check_id', checkId]]),
    check_payees: await scoped('check_payees', [['check_id', checkId]]),
    check_files: await scoped('check_files', [['check_intake_item_id', checkId]]),
    check_cases: await scoped('check_cases', [['id', checkId]]),
    provider_ops: await scoped('aws_provider_sandbox_operations', [
      ['check_id', checkId],
      ['claim_id', claimId],
    ]),
    financial_ops: await scoped('aws_financial_operations', [
      ['check_id', checkId],
      ['claim_id', claimId],
    ]),
    ledger_tokens: await q(
      `SELECT id, homeowner_email, revoked_at, expires_at IS NULL AS never_expires
       FROM public.homeowner_ledger_tokens WHERE id = $1::uuid`,
      [tokenId],
    ),
  };
};

const countsFor = async (client, ids) => {
  const { claimId, checkId } = ids;
  const one = async (sql, params) => {
    await client.query('SAVEPOINT iso_count');
    try {
      const n = Number((await client.query(sql, params)).rows[0]?.n || 0);
      await client.query('RELEASE SAVEPOINT iso_count');
      return n;
    } catch {
      await client.query('ROLLBACK TO SAVEPOINT iso_count');
      return null;
    }
  };
  return {
    signature_request_count: await one(
      `SELECT count(*)::int AS n FROM public.signature_requests
       WHERE claim_id = $1::uuid OR check_intake_item_id = $2::uuid`,
      [claimId, checkId],
    ),
    signed_attachment_count: await one(
      `SELECT count(*)::int AS n FROM public.check_files
       WHERE check_intake_item_id = $1::uuid AND signature_request_id IS NOT NULL`,
      [checkId],
    ),
    billing_event_count: await one(
      `SELECT count(*)::int AS n FROM public.check_billing_events
       WHERE check_id = $1::uuid OR check_intake_item_id = $1::uuid`,
      [checkId],
    ),
    deposit_count: await one(
      `SELECT count(*)::int AS n FROM public.deposit_items WHERE check_intake_item_id = $1::uuid`,
      [checkId],
    ),
    disbursement_count: await one(
      `SELECT count(*)::int AS n FROM public.disbursement_splits WHERE check_intake_item_id = $1::uuid`,
      [checkId],
    ),
    payment_transfer_count: await one(
      `SELECT count(*)::int AS n FROM public.payment_transfers WHERE check_intake_item_id = $1::uuid`,
      [checkId],
    ),
    provider_operation_count: await one(
      `SELECT count(*)::int AS n FROM public.aws_provider_sandbox_operations
       WHERE check_id = $1::uuid OR claim_id = $2::uuid`,
      [checkId, claimId],
    ),
    mortgage_handling_request_count: await one(
      `SELECT count(*)::int AS n FROM public.mortgage_handling_requests
       WHERE check_id = $1::uuid OR claim_id = $2::uuid`,
      [checkId, claimId],
    ),
    financial_operation_count: await one(
      `SELECT count(*)::int AS n FROM public.aws_financial_operations
       WHERE check_id = $1::uuid OR claim_id = $2::uuid`,
      [checkId, claimId],
    ),
  };
};

const pickAuthorizedEmail = async (client) => {
  const rows = (await client.query(
    `SELECT ia.application_user_id, ia.email, tu.tenant_id, tu.role
     FROM public.identity_accounts ia
     JOIN public.tenant_users tu ON tu.user_id = ia.application_user_id
     WHERE tu.tenant_id = $1::uuid
       AND lower(ia.email) = ANY($2::text[])
     ORDER BY array_position($2::text[], lower(ia.email))`,
    [FREEDOM_TENANT_ID, AUTHORIZED_EMAILS],
  )).rows;
  return {
    candidates: rows,
    email: rows[0]?.email || null,
    user_id: rows[0]?.application_user_id || null,
  };
};

const inspectSchema = async (client) => {
  const freedom = (await client.query(
    `SELECT id, name, slug FROM public.tenants WHERE id = $1::uuid OR name ILIKE '%freedom%'`,
    [FREEDOM_TENANT_ID],
  )).rows;
  const amountZero = (await client.query(
    `SELECT conname, pg_get_constraintdef(oid) AS def
     FROM pg_constraint
     WHERE conrelid = 'public.check_intake_items'::regclass
       AND pg_get_constraintdef(oid) ILIKE '%amount%'`,
  )).rows;
  return {
    freedom,
    claims_columns: await columnsOf(client, 'claims'),
    check_columns: await columnsOf(client, 'check_intake_items'),
    token_columns: await columnsOf(client, 'homeowner_ledger_tokens'),
    claims_checks: await checksOf(client, 'claims'),
    check_checks: await checksOf(client, 'check_intake_items'),
    amount_constraints: amountZero,
    claim_triggers: await triggersOf(client, 'claims'),
    check_triggers: await triggersOf(client, 'check_intake_items'),
    token_triggers: await triggersOf(client, 'homeowner_ledger_tokens'),
    check_file_triggers: await triggersOf(client, 'check_files'),
    tables: {
      deposit_items: await tableExists(client, 'deposit_items'),
      disbursement_splits: await tableExists(client, 'disbursement_splits'),
      payment_transfers: await tableExists(client, 'payment_transfers'),
      check_billing_events: await tableExists(client, 'check_billing_events'),
      mortgage_handling_requests: await tableExists(client, 'mortgage_handling_requests'),
      aws_financial_operations: await tableExists(client, 'aws_financial_operations'),
      aws_provider_sandbox_operations: await tableExists(client, 'aws_provider_sandbox_operations'),
      claim_payments: await tableExists(client, 'claim_payments'),
      claim_checks: await tableExists(client, 'claim_checks'),
    },
  };
};

const existingFixture = async (client) => (
  await client.query(
    `SELECT c.id AS check_id, c.claim_id, c.tenant_id, c.check_number, c.amount,
            c.status, c.check_stage, c.ocr_status, c.front_image_path, c.back_image_path,
            cl.claim_number, cl.status AS claim_status, cl.policyholder_name,
            cl.policyholder_email, cl.org_id
     FROM public.check_intake_items c
     JOIN public.claims cl ON cl.id = c.claim_id
     WHERE c.check_number = $1 OR cl.claim_number = $2
     ORDER BY c.created_at DESC
     LIMIT 1`,
    [CHECK_NUMBER, CLAIM_NUMBER],
  )
).rows[0] || null;

const insertFixture = async (client, email) => {
  const claimCols = await columnsOf(client, 'claims');
  const claimNames = new Set(claimCols.map((c) => c.column_name));
  const claimColsOut = ['claim_number', 'policyholder_name', 'policyholder_email'];
  const claimVals = [CLAIM_NUMBER, HOMEOWNER_NAME, email];
  const claimPush = (name, value) => {
    if (claimNames.has(name)) {
      claimColsOut.push(name);
      claimVals.push(value);
    }
  };
  claimPush('policyholder_address', LABEL);
  claimPush('loss_description', LABEL);
  claimPush('status', 'open');
  claimPush('org_id', FREEDOM_TENANT_ID);
  claimPush('claim_amount', 0);
  const claimTyped = claimColsOut.map((name, i) => {
    if (name === 'org_id') return `$${i + 1}::uuid`;
    if (name === 'claim_amount') return `$${i + 1}::numeric`;
    return `$${i + 1}`;
  });
  const claim = (await client.query(
    `INSERT INTO public.claims (${claimColsOut.join(', ')})
     VALUES (${claimTyped.join(', ')})
     RETURNING id, claim_number, status, org_id, policyholder_email, claim_amount`,
    claimVals,
  )).rows[0];

  const checkCols = await columnsOf(client, 'check_intake_items');
  const names = new Set(checkCols.map((c) => c.column_name));
  const cols = ['tenant_id', 'claim_id', 'check_number', 'amount', 'ocr_status'];
  const vals = [FREEDOM_TENANT_ID, claim.id, CHECK_NUMBER, 0, 'completed'];
  const push = (name, value) => {
    if (names.has(name) && !cols.includes(name)) {
      cols.push(name);
      vals.push(value);
    }
  };
  push('front_image_path', PLACEHOLDER_FRONT);
  push('carrier_name', LABEL);
  push('payee_line', null);
  push('status', 'needs_review');
  push('check_stage', 'review');
  push('check_source', 'insurance');
  push('uploaded_by', FREEDOM_ADMIN_ID);
  push('deposit_recommendation', null);
  const typed = cols.map((name, i) => {
    if (name === 'tenant_id' || name === 'claim_id' || name === 'uploaded_by') return `$${i + 1}::uuid`;
    if (name === 'amount') return `$${i + 1}::numeric`;
    return `$${i + 1}`;
  });
  const check = (await client.query(
    `INSERT INTO public.check_intake_items (${cols.join(', ')})
     VALUES (${typed.join(', ')})
     RETURNING id, claim_id, tenant_id, check_number, amount, status, check_stage,
               ocr_status, front_image_path, back_image_path, payee_line, case_id`,
    vals,
  )).rows[0];

  const tokenValue = `ui-sig-test-${crypto.randomBytes(16).toString('hex')}`;
  let token;
  try {
    token = (await client.query(
      `INSERT INTO public.homeowner_ledger_tokens (
         tenant_id, claim_id, homeowner_email, homeowner_name, token, created_by
       ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid)
       RETURNING id, homeowner_email, created_at`,
      [FREEDOM_TENANT_ID, claim.id, email, HOMEOWNER_NAME, tokenValue, FREEDOM_ADMIN_ID],
    )).rows[0];
  } catch (error) {
    token = (await client.query(
      `INSERT INTO public.homeowner_ledger_tokens (
         tenant_id, claim_id, homeowner_email, homeowner_name, token
       ) VALUES ($1::uuid, $2::uuid, $3, $4, $5)
       RETURNING id, homeowner_email, created_at`,
      [FREEDOM_TENANT_ID, claim.id, email, HOMEOWNER_NAME, tokenValue],
    )).rows[0];
    token.insert_note = String(error.message || error).slice(0, 160);
  }

  return { claim, check, token, token_ref: token.id };
};

const isolationOk = (iso) => {
  const empty = (rows) => {
    if (!Array.isArray(rows)) return false;
    if (rows.length === 0) return true;
    if (rows.every((row) => row?._error || row?._note)) {
      return rows.every((row) => {
        const msg = String(row._error || row._note || '');
        return /does not exist|no scoped id column/i.test(msg);
      });
    }
    return false;
  };
  const problems = [];
  if (!empty(iso.signature_requests)) problems.push('signature_requests');
  if (!empty(iso.check_billing_events)) problems.push('check_billing_events');
  if (!empty(iso.deposit_items)) problems.push('deposit_items');
  if (!empty(iso.disbursement_splits)) problems.push('disbursement_splits');
  if (!empty(iso.payment_transfers)) problems.push('payment_transfers');
  if (!empty(iso.platform_fee_line_items)) problems.push('platform_fee_line_items');
  if (!empty(iso.mortgage_handling_requests)) problems.push('mortgage_handling_requests');
  if (!empty(iso.claim_payments)) problems.push('claim_payments');
  if (!empty(iso.provider_ops)) problems.push('provider_ops');
  if (!empty(iso.financial_ops)) problems.push('financial_ops');
  if (!empty(iso.check_endorsements)) problems.push('check_endorsements');
  if (!empty(iso.check_payees)) problems.push('check_payees');
  if (!empty(iso.check_files)) problems.push('check_files');
  const moneyEvents = (iso.homeowner_ledger_events || []).filter((row) => (
    row.event_type && !['check_received'].includes(row.event_type)
  ));
  if (moneyEvents.length) problems.push('homeowner_ledger_events_non_received');
  return { ok: problems.length === 0, problems };
};

export const handler = async (event = {}) => {
  const action = String(event.action || 'inspect');
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
    const schema = await inspectSchema(client);
    const freedomOk = schema.freedom.some((row) => row.id === FREEDOM_TENANT_ID);
    const amountPositive = schema.amount_constraints.some((row) => /amount\s*>\s*0/i.test(row.def || ''));
    const authorized = await pickAuthorizedEmail(client);
    const already = await existingFixture(client);

    const amountCol = schema.check_columns.find((c) => c.column_name === 'amount');
    const amountNullable = amountCol?.is_nullable === 'YES';
    const amountDefaultZero = /['']?0(\.0+)?['']?/.test(String(amountCol?.column_default || ''));

    const gates = {
      freedom_tenant: freedomOk,
      authorized_email: Boolean(authorized.email),
      amount_zero_schema: !amountPositive,
      amount_column: amountCol || null,
      amount_nullable: amountNullable,
      amount_default_zero: amountDefaultZero,
    };

    if (already) {
      const token = (await client.query(
        `SELECT id, homeowner_email FROM public.homeowner_ledger_tokens
         WHERE claim_id = $1::uuid ORDER BY created_at DESC LIMIT 1`,
        [already.claim_id],
      )).rows[0] || null;
      const ids = { claimId: already.claim_id, checkId: already.check_id, tokenId: token?.id };
      return {
        ok: true,
        action,
        already_exists: true,
        host: creds.host,
        session,
        gates,
        authorized_email: authorized.email,
        fixture: already,
        token_id: token?.id || null,
        isolation: await isolationFor(client, ids),
        baseline: {
          claim_id: already.claim_id,
          check_id: already.check_id,
          homeowner_email: already.policyholder_email,
          ledger_token_id: token?.id || null,
          check_status: already.status,
          check_stage: already.check_stage,
          claim_status: already.claim_status,
          amount: already.amount,
          ...(await countsFor(client, ids)),
        },
        created: false,
      };
    }

    if (!gates.freedom_tenant || !gates.authorized_email || !gates.amount_zero_schema) {
      return {
        ok: false,
        action,
        created: false,
        stop: true,
        reason: !gates.amount_zero_schema
          ? 'schema requires positive amount'
          : !gates.freedom_tenant
            ? 'freedom tenant missing'
            : 'no authorized production test email',
        host: creds.host,
        session,
        gates,
        schema_amount_constraints: schema.amount_constraints,
        authorized,
        check_triggers: schema.check_triggers,
      };
    }

    await client.query('BEGIN');
    let dry;
    try {
      dry = await insertFixture(client, authorized.email);
      dry.isolation = await isolationFor(client, {
        claimId: dry.claim.id,
        checkId: dry.check.id,
        tokenId: dry.token.id,
      });
      dry.counts = await countsFor(client, {
        claimId: dry.claim.id,
        checkId: dry.check.id,
      });
      dry.isolation_gate = isolationOk(dry.isolation);
    } catch (error) {
      await client.query('ROLLBACK');
      return {
        ok: false,
        action,
        created: false,
        stop: true,
        reason: 'dry_run_insert_failed',
        error: String(error.message || error).slice(0, 400),
        host: creds.host,
        session,
        gates,
        check_triggers: schema.check_triggers.map((t) => t.tgname),
        amount_constraints: schema.amount_constraints,
      };
    }

    if (action !== 'create') {
      await client.query('ROLLBACK');
      return {
        ok: true,
        action: 'inspect',
        created: false,
        rolled_back: true,
        host: creds.host,
        session,
        gates,
        authorized_email: authorized.email,
        dry_run: {
          claim: dry.claim,
          check: dry.check,
          token_id: dry.token.id,
          isolation: dry.isolation,
          isolation_gate: dry.isolation_gate,
          counts: dry.counts,
        },
        check_triggers: schema.check_triggers.map((t) => ({ name: t.tgname, fn: t.fn })),
        claim_triggers: schema.claim_triggers.map((t) => t.tgname),
        check_file_triggers: schema.check_file_triggers.map((t) => t.tgname),
        tables: schema.tables,
      };
    }

    if (!dry.isolation_gate.ok) {
      await client.query('ROLLBACK');
      return {
        ok: false,
        action: 'create',
        created: false,
        stop: true,
        reason: 'isolation_failed',
        problems: dry.isolation_gate.problems,
        isolation: dry.isolation,
        host: creds.host,
        session,
        gates,
      };
    }

    await client.query('COMMIT');
    const committed = await existingFixture(client);
    const token = (await client.query(
      `SELECT id, homeowner_email FROM public.homeowner_ledger_tokens
       WHERE claim_id = $1::uuid ORDER BY created_at DESC LIMIT 1`,
      [committed.claim_id],
    )).rows[0];
    const ids = { claimId: committed.claim_id, checkId: committed.check_id, tokenId: token.id };
    return {
      ok: true,
      action: 'create',
      created: true,
      host: creds.host,
      session,
      gates,
      authorized_email: authorized.email,
      search_name: LABEL,
      claim_number: CLAIM_NUMBER,
      check_number: CHECK_NUMBER,
      fixture: committed,
      token_id: token.id,
      isolation: await isolationFor(client, ids),
      baseline: {
        claim_id: committed.claim_id,
        check_id: committed.check_id,
        homeowner_email: authorized.email,
        ledger_token_id: token.id,
        check_status: committed.status,
        check_stage: committed.check_stage,
        claim_status: committed.claim_status,
        amount: committed.amount,
        ...(await countsFor(client, ids)),
      },
      pdf_attached: false,
    };
  } finally {
    await client.end();
  }
};
