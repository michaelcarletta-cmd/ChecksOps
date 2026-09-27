import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const { Client } = pg;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CA_CANDIDATES = [
  path.join(ROOT, 'rds-global-bundle.pem'),
  path.join(ROOT, '..', 'oneshot', 'rds-global-bundle.pem'),
  path.join(ROOT, '..', '..', 'functions', 'api', 'rds-global-bundle.pem'),
  path.join(ROOT, '..', '..', 'rls', 'oneshot', 'rds-global-bundle.pem'),
];
const CA_PATH = CA_CANDIDATES.find((p) => fs.existsSync(p));
const sqlCandidates = (name) => [
  path.join(ROOT, 'sql', name),
  path.join(ROOT, '..', 'sql', name),
  path.join(ROOT, '..', '..', 'rls', 'sql', name),
  path.join(ROOT, '..', '..', 'storage', 'sql', name),
].find((p) => fs.existsSync(p));
const WRITE_SQL = fs.readFileSync(sqlCandidates('02_public_signature_write_helpers.sql'), 'utf8');
const AGENT_SQL = fs.readFileSync(sqlCandidates('39_mortgage_agent_signature_send.sql'), 'utf8');

const PUBLIC_FUNCS = [
  'aws_public_signature_by_token_hash(text)',
  'aws_public_signature_mark_viewed(text)',
  'aws_public_signature_submit(text,jsonb,text,text,text)',
  'aws_public_signature_attach_signed(text,text)',
  'aws_public_signature_set_completion_error(text,text)',
  'aws_public_signature_canonical_pdf_path(uuid,uuid,uuid)',
];
const AGENT_FUNCS = [
  'aws_mortgage_agent_assigned_to_context(uuid,uuid)',
  'aws_mortgage_agent_can_initiate_signature(uuid,uuid)',
  'aws_mortgage_agent_can_manage_signature(uuid)',
  'aws_can_write_tenant(uuid)',
];

const loadAdmin = async () => {
  const arn = process.env.ADMIN_SECRET_ARN;
  if (!arn) throw new Error('ADMIN_SECRET_ARN is required');
  if (!/checksops_admin/i.test(arn)) throw new Error('refusing non-admin secret arn');
  const sm = new SecretsManagerClient({});
  const out = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  const parsed = JSON.parse(out.SecretString);
  if (!/checksops_admin/i.test(parsed.username || '')) {
    throw new Error('refusing non-admin secret');
  }
  const host = parsed.host || parsed.hostname || process.env.RDS_HOST;
  if (!host || host === 'localhost' || host === '127.0.0.1') {
    throw new Error('admin secret host missing');
  }
  return {
    username: parsed.username,
    password: parsed.password,
    host,
    port: Number(parsed.port || 5432),
    database: parsed.dbname || parsed.database || process.env.DATABASE_NAME || 'checksops',
  };
};

const inspect = async (client) => {
  const helpers = await client.query(`
    SELECT p.proname,
           pg_get_userbyid(p.proowner) AS owner,
           p.prosecdef AS security_definer,
           p.proconfig,
           pg_get_functiondef(p.oid) AS def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'aws_public_signature_by_token_hash',
        'aws_public_signature_canonical_pdf_path',
        'aws_public_signature_mark_viewed',
        'aws_public_signature_submit',
        'aws_public_signature_attach_signed',
        'aws_public_signature_set_completion_error',
        'aws_mortgage_agent_assigned_to_context',
        'aws_mortgage_agent_can_manage_signature',
        'aws_mortgage_agent_can_initiate_signature',
        'aws_can_write_tenant'
      )
    ORDER BY 1
  `);
  const grants = await client.query(`
    SELECT p.proname, r.rolname AS grantee, a.privilege_type
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN information_schema.routine_privileges a
      ON a.routine_schema = 'public' AND a.routine_name = p.proname
    JOIN pg_roles r ON r.rolname = a.grantee
    WHERE n.nspname = 'public'
      AND p.proname LIKE 'aws_public_signature%'
       OR p.proname LIKE 'aws_mortgage_agent_can_%signature'
    ORDER BY 1, 2
  `);
  const tables = await client.query(`
    SELECT c.relname,
           pg_get_userbyid(c.relowner) AS owner,
           c.relrowsecurity AS rls,
           c.relforcerowsecurity AS force_rls
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname IN (
        'signature_requests', 'signature_signers', 'signature_fields',
        'signature_field_values', 'esign_event_logs', 'claim_files',
        'check_files', 'loss_draft_documents'
      )
    ORDER BY 1
  `);
  const policies = await client.query(`
    SELECT tablename, policyname, cmd, roles, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN (
        'signature_requests', 'signature_signers', 'signature_fields',
        'esign_event_logs'
      )
    ORDER BY 1, 2
  `);
  return {
    helpers: helpers.rows.map((row) => ({
      name: row.proname,
      owner: row.owner,
      security_definer: row.security_definer,
      config: row.proconfig,
      def: row.def,
    })),
    grants: grants.rows,
    tables: tables.rows,
    policies: policies.rows,
  };
};

const AGENT_ID = 'b100f05d-9e81-4a7b-b9cc-9baf173131d9';
const OTHER_ASSIGNEE = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';

const runFixture = async (client) => {
  const assigned = (await client.query(
    `SELECT id, tenant_id, claim_id, check_intake_item_id, status, assigned_employee_id
     FROM public.mortgage_handling_requests
     WHERE assigned_employee_id = $1::uuid
     ORDER BY CASE WHEN status = 'in_progress' THEN 0 ELSE 1 END, updated_at DESC NULLS LAST
     LIMIT 5`,
    [AGENT_ID],
  )).rows;
  const primary = assigned.find((row) => row.check_intake_item_id) || assigned[0];
  if (!primary) throw new Error('no assigned MHR for agent');
  const file = (await client.query(
    `SELECT file_path, file_name, check_intake_item_id
     FROM public.check_files
     WHERE check_intake_item_id = $1::uuid
       AND file_path IS NOT NULL
     ORDER BY created_at DESC NULLS LAST
     LIMIT 1`,
    [primary.check_intake_item_id],
  )).rows[0] || (await client.query(
    `SELECT document_path AS file_path, document_name AS file_name, check_intake_item_id
     FROM public.signature_requests
     WHERE document_path IS NOT NULL
     ORDER BY created_at DESC NULLS LAST
     LIMIT 1`,
  )).rows[0] || (await client.query(
    `SELECT file_path, file_name, check_intake_item_id
     FROM public.check_files
     WHERE file_path IS NOT NULL
     ORDER BY created_at DESC NULLS LAST
     LIMIT 1`,
  )).rows[0];
  if (!file?.file_path) throw new Error('no reusable document path found');
  const otherMhr = (await client.query(
    `SELECT id, claim_id, check_intake_item_id, assigned_employee_id, status
     FROM public.mortgage_handling_requests mhr
     WHERE mhr.assigned_employee_id IS NOT NULL
       AND mhr.assigned_employee_id IS DISTINCT FROM $1::uuid
       AND mhr.check_intake_item_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
         FROM public.mortgage_handling_requests mine
         WHERE mine.assigned_employee_id = $1::uuid
           AND (
             mine.check_intake_item_id = mhr.check_intake_item_id
             OR (mine.claim_id IS NOT NULL AND mine.claim_id = mhr.claim_id)
           )
       )
     ORDER BY mhr.updated_at DESC NULLS LAST
     LIMIT 1`,
    [AGENT_ID],
  )).rows[0];
  const reqA = (await client.query(
    `INSERT INTO public.signature_requests (
       claim_id, check_intake_item_id, document_name, document_path, document_type, field_data, status
     ) VALUES ($1::uuid, $2::uuid, $3, $4, 'other', $5::jsonb, 'draft')
     RETURNING id, claim_id, check_intake_item_id, document_path, status`,
    [
      primary.claim_id,
      primary.check_intake_item_id,
      file.file_name || 'DTP',
      file.file_path,
      JSON.stringify([{
        id: crypto.randomUUID(),
        type: 'signature',
        field_type: 'signature',
        label: 'Sign',
        required: true,
        signerIndex: 0,
        page: 1,
        x: 10,
        y: 10,
        width: 30,
        height: 8,
      }]),
    ],
  )).rows[0];
  const signerA = (await client.query(
    `INSERT INTO public.signature_signers (
       signature_request_id, signer_name, signer_email, signer_type, signing_order, status
     ) VALUES ($1::uuid, 'Synthetic Homeowner', 'staging-signer@checksops.invalid', 'policyholder', 1, 'pending')
     RETURNING id, status`,
    [reqA.id],
  )).rows[0];
  await client.query(
    `INSERT INTO public.signature_fields (
       signature_request_id, signer_index, field_type, label, page, x, y, width, height, required
     ) VALUES ($1::uuid, 0, 'signature', 'Sign', 1, 10, 10, 30, 8, true)`,
    [reqA.id],
  );
  let reqB = null;
  let signerB = null;
  if (otherMhr?.check_intake_item_id) {
    reqB = (await client.query(
      `INSERT INTO public.signature_requests (
         claim_id, check_intake_item_id, document_name, document_path, document_type, field_data, status
       ) VALUES ($1::uuid, $2::uuid, 'Other Request', $3, 'other', '[]'::jsonb, 'pending')
       RETURNING id, claim_id, check_intake_item_id, status`,
      [otherMhr.claim_id, otherMhr.check_intake_item_id, file.file_path],
    )).rows[0];
    signerB = (await client.query(
      `INSERT INTO public.signature_signers (
         signature_request_id, signer_name, signer_email, signer_type, signing_order, status,
         access_token, token_hash, expires_at
       ) VALUES (
         $1::uuid, 'Other Signer', 'other-signer@checksops.invalid', 'policyholder', 1, 'pending',
         'other-raw-token-not-for-a', repeat('b', 64), now() + interval '2 hours'
       )
       RETURNING id, token_hash, expires_at`,
      [reqB.id],
    )).rows[0];
  }
  const reqE = (await client.query(
    `INSERT INTO public.signature_requests (
       claim_id, check_intake_item_id, document_name, document_path, document_type, field_data, status
     ) VALUES ($1::uuid, $2::uuid, 'Expired Request', $3, 'other', '[]'::jsonb, 'pending')
     RETURNING id`,
    [primary.claim_id, primary.check_intake_item_id, file.file_path],
  )).rows[0];
  const expired = (await client.query(
    `INSERT INTO public.signature_signers (
       signature_request_id, signer_name, signer_email, signer_type, signing_order, status,
       access_token, token_hash, expires_at
     ) VALUES (
       $1::uuid, 'Expired Extra', 'expired@checksops.invalid', 'other', 1, 'pending',
       'expired-raw-token', repeat('c', 64), now() - interval '1 hour'
     )
     RETURNING id, token_hash, expires_at, signature_request_id`,
    [reqE.id],
  )).rows[0];
  const checkBefore = (await client.query(
    `SELECT id, status, check_stage, amount FROM public.check_intake_items WHERE id = $1::uuid`,
    [primary.check_intake_item_id],
  )).rows[0];
  const claimBefore = primary.claim_id
    ? (await client.query(`SELECT id, status FROM public.claims WHERE id = $1::uuid`, [primary.claim_id])).rows[0]
    : null;
  const billingBefore = (await client.query(
    `SELECT count(*)::int AS n FROM public.check_billing_events
     WHERE check_intake_item_id = $1::uuid`,
    [primary.check_intake_item_id],
  )).rows[0];
  return {
    agentId: AGENT_ID,
    otherAssignee: OTHER_ASSIGNEE,
    mhr: primary,
    assigned,
    otherMhr,
    file,
    requestA: reqA,
    signerA,
    requestB: reqB,
    signerB,
    requestE: reqE,
    expired,
    checkBefore,
    claimBefore,
    billingBefore,
  };
};

export const handler = async (event = {}) => {
  const mode = String(event.mode || process.env.APPLY_MODE || 'inspect');
  if (!['inspect', 'apply', 'fixture', 'isolation', 'verify', 'adversary'].includes(mode)) {
    return { ok: false, error: 'mode must be inspect|apply|fixture|isolation|verify|adversary' };
  }
  const credentials = await loadAdmin();
  delete process.env.PGHOST;
  delete process.env.PGPORT;
  const client = new Client({
    host: credentials.host,
    port: credentials.port,
    user: credentials.username,
    password: credentials.password,
    database: process.env.DATABASE_NAME || credentials.database || 'checksops',
    ssl: { rejectUnauthorized: true, ca: fs.readFileSync(CA_PATH, 'utf8') },
    connectionTimeoutMillis: 8000,
    query_timeout: 120000,
  });
  try {
    await client.connect();
    const before = await inspect(client);
    if (mode === 'inspect') {
      return { ok: true, mode, before, productionSupabaseChanged: false };
    }
    if (mode === 'adversary') {
      const expiredHash = (await client.query(
        `SELECT encode(sha256('expired-raw-token-known'::bytea), 'hex') AS h`,
      )).rows[0].h;
      await client.query(
        `UPDATE public.signature_signers
         SET token_hash = $2, expires_at = now() - interval '1 hour'
         WHERE id = $1::uuid`,
        [event.expiredSignerId, expiredHash],
      );
      await client.query('SET ROLE checksops');
      const mismatch = (await client.query(
        'SELECT public.aws_public_signature_attach_signed($1, $2) AS doc',
        [event.tokenHashA, 'signed/00000000-0000-4000-8000-000000000099/hijack-final.pdf'],
      )).rows[0]?.doc;
      const cross = (await client.query(
        'SELECT public.aws_public_signature_submit($1, $2::jsonb, $3, $4, $5) AS doc',
        [event.tokenHashB, JSON.stringify({ hijack: true }), '1.1.1.1', 'adversary', 'no'],
      )).rows[0]?.doc;
      const expired = (await client.query(
        'SELECT public.aws_public_signature_submit($1, $2::jsonb, $3, $4, $5) AS doc',
        [expiredHash, JSON.stringify({}), '1.1.1.1', 'adversary', 'no'],
      )).rows[0]?.doc;
      await client.query('RESET ROLE');
      return {
        ok: true,
        mode,
        expiredHash,
        mismatch,
        cross,
        expired,
        productionSupabaseChanged: false,
      };
    }
    if (mode === 'isolation') {
      await client.query('BEGIN');
      const file = (await client.query(
        `SELECT document_path AS file_path FROM public.signature_requests WHERE document_path IS NOT NULL LIMIT 1`,
      )).rows[0];
      const otherMhr = (await client.query(
        `SELECT id, claim_id, check_intake_item_id, assigned_employee_id, status
         FROM public.mortgage_handling_requests mhr
         WHERE mhr.assigned_employee_id IS NOT NULL
           AND mhr.assigned_employee_id IS DISTINCT FROM $1::uuid
           AND mhr.check_intake_item_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM public.mortgage_handling_requests mine
             WHERE mine.assigned_employee_id = $1::uuid
               AND (
                 mine.check_intake_item_id = mhr.check_intake_item_id
                 OR (mine.claim_id IS NOT NULL AND mine.claim_id = mhr.claim_id)
               )
           )
         ORDER BY mhr.updated_at DESC NULLS LAST
         LIMIT 1`,
        [AGENT_ID],
      )).rows[0];
      if (!otherMhr) throw new Error('no isolated foreign MHR');
      const reqB = (await client.query(
        `INSERT INTO public.signature_requests (
           claim_id, check_intake_item_id, document_name, document_path, document_type, field_data, status
         ) VALUES ($1::uuid, $2::uuid, 'Isolated Other Request', $3, 'other', '[]'::jsonb, 'pending')
         RETURNING id, claim_id, check_intake_item_id, status`,
        [otherMhr.claim_id, otherMhr.check_intake_item_id, file.file_path],
      )).rows[0];
      const signerB = (await client.query(
        `INSERT INTO public.signature_signers (
           signature_request_id, signer_name, signer_email, signer_type, signing_order, status,
           access_token, token_hash, expires_at
         ) VALUES (
           $1::uuid, 'Other Signer', 'other-signer@checksops.invalid', 'policyholder', 1, 'pending',
           'other-raw-token-not-for-a', repeat('b', 64), now() + interval '2 hours'
         )
         RETURNING id, token_hash`,
        [reqB.id],
      )).rows[0];
      await client.query('COMMIT');
      return { ok: true, mode, otherMhr, requestB: reqB, signerB, productionSupabaseChanged: false };
    }
    if (mode === 'fixture') {
      await client.query('BEGIN');
      const fixture = await runFixture(client);
      await client.query('COMMIT');
      return { ok: true, mode, fixture, productionSupabaseChanged: false };
    }
    if (mode === 'verify') {
      const requestId = event.requestId;
      const checkId = event.checkId;
      const claimId = event.claimId;
      const request = requestId
        ? (await client.query(`SELECT * FROM public.signature_requests WHERE id = $1::uuid`, [requestId])).rows[0]
        : null;
      const signers = requestId
        ? (await client.query(`SELECT id, status, viewed_at, signed_at, expires_at FROM public.signature_signers WHERE signature_request_id = $1::uuid`, [requestId])).rows
        : [];
      const claimFiles = request
        ? (await client.query(`SELECT id, file_path, file_name FROM public.claim_files WHERE claim_id = $1::uuid AND file_path = $2`, [request.claim_id, request.final_pdf_path])).rows
        : [];
      const checkFiles = request
        ? (await client.query(`SELECT id, file_path, file_name, category, signature_request_id FROM public.check_files WHERE signature_request_id = $1::uuid OR (check_intake_item_id = $2::uuid AND file_path = $3)`, [request.id, request.check_intake_item_id, request.final_pdf_path])).rows
        : [];
      const check = checkId
        ? (await client.query(`SELECT id, status, check_stage, amount FROM public.check_intake_items WHERE id = $1::uuid`, [checkId])).rows[0]
        : null;
      const claim = claimId
        ? (await client.query(`SELECT id, status FROM public.claims WHERE id = $1::uuid`, [claimId])).rows[0]
        : null;
      const billing = checkId
        ? (await client.query(`SELECT count(*)::int AS n FROM public.check_billing_events WHERE check_intake_item_id = $1::uuid`, [checkId])).rows[0]
        : null;
      const agentMhrs = (await client.query(
        `SELECT id, status, assigned_employee_id, claim_id, check_intake_item_id, tenant_id
         FROM public.mortgage_handling_requests
         WHERE assigned_employee_id = $1::uuid
            OR claim_id = $2::uuid
            OR check_intake_item_id = $3::uuid
         ORDER BY updated_at DESC NULLS LAST`,
        [AGENT_ID, claimId || '00000000-0000-0000-0000-000000000000', checkId || '00000000-0000-0000-0000-000000000000'],
      )).rows;
      await client.query('BEGIN');
      await client.query("SELECT set_config('request.app_user_id', $1, true)", [AGENT_ID]);
      const manage = requestId
        ? (await client.query('SELECT public.aws_mortgage_agent_can_manage_signature($1::uuid) AS ok, public.aws_can_write_tenant($2::uuid) AS tenant_write', [requestId, event.tenantId || null])).rows[0]
        : null;
      await client.query('ROLLBACK');
      return {
        ok: true,
        mode,
        request,
        signers,
        claimFiles,
        checkFiles,
        check,
        claim,
        billing,
        agentMhrs,
        manage,
        productionSupabaseChanged: false,
      };
    }
    await client.query('BEGIN');
    await client.query(WRITE_SQL);
    await client.query(AGENT_SQL);
    const after = await inspect(client);
    const missing = [...PUBLIC_FUNCS, ...AGENT_FUNCS].filter((sig) => {
      const name = sig.slice(0, sig.indexOf('('));
      return !after.helpers.some((row) => row.name === name);
    });
    if (missing.length) {
      throw new Error(`missing functions: ${missing.join(',')}`);
    }
    await client.query('COMMIT');
    return {
      ok: true,
      mode,
      before: {
        helpers: before.helpers.map((row) => ({ name: row.name, owner: row.owner, security_definer: row.security_definer, config: row.config })),
        tables: before.tables,
        policies: before.policies,
      },
      after: {
        helpers: after.helpers.map((row) => ({ name: row.name, owner: row.owner, security_definer: row.security_definer, config: row.config })),
        grants: after.grants,
        tables: after.tables,
        policies: after.policies,
      },
      productionSupabaseChanged: false,
    };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    return {
      ok: false,
      mode,
      error: String(error.message || error).slice(0, 800),
      hostSuffix: String(credentials.host || '').slice(-40),
    };
  } finally {
    try { await client.end(); } catch { /* ignore */ }
  }
};
