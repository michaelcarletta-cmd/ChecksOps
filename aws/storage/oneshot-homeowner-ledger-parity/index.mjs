import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const { Client } = pg;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CA_CANDIDATES = [
  path.join(ROOT, 'rds-global-bundle.pem'),
  path.join(ROOT, '..', 'oneshot-public-write', 'rds-global-bundle.pem'),
  path.join(ROOT, '..', 'oneshot', 'rds-global-bundle.pem'),
  path.join(ROOT, '..', '..', 'functions', 'api', 'rds-global-bundle.pem'),
  path.join(ROOT, '..', '..', 'rls', 'oneshot', 'rds-global-bundle.pem'),
];
const CA_PATH = CA_CANDIDATES.find((p) => fs.existsSync(p));
const SQL_CANDIDATES = [
  path.join(ROOT, 'sql', '69_homeowner_ledger_pending_and_sign_link.sql'),
  path.join(ROOT, '..', '..', 'workflows', 'sql', '69_homeowner_ledger_pending_and_sign_link.sql'),
];
const SQL_PATH = SQL_CANDIDATES.find((p) => fs.existsSync(p));
const FAILED_DRAFT_ID = 'c333b53d-a49a-403b-9282-f0f2e6007f05';
const FAILED_DRAFT_NAME = 'probe-check-only';
const HELPER_NAMES = [
  'aws_public_homeowner_ledger_by_token',
  'aws_public_homeowner_ledger_remint_signer',
  'aws_public_signature_mark_viewed',
  'aws_public_signature_submit',
  'aws_public_signature_attach_signed',
  'aws_public_signature_set_completion_error',
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

const inspectHelpers = async (client) => {
  const helpers = await client.query(
    `SELECT p.proname,
            pg_get_userbyid(p.proowner) AS owner,
            p.prosecdef AS security_definer,
            p.proconfig,
            pg_get_function_identity_arguments(p.oid) AS args
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = ANY($1::text[])
     ORDER BY 1`,
    [HELPER_NAMES],
  );
  const grants = await client.query(
    `SELECT p.proname, r.rolname AS grantee, a.privilege_type
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
     JOIN information_schema.routine_privileges a
       ON a.routine_schema = 'public' AND a.routine_name = p.proname
     JOIN pg_roles r ON r.rolname = a.grantee
     WHERE n.nspname = 'public'
       AND p.proname = ANY($1::text[])
     ORDER BY 1, 2`,
    [HELPER_NAMES],
  );
  return { helpers: helpers.rows, grants: grants.rows };
};

const documentFailedDraft = async (client) => {
  const request = (await client.query(
    `SELECT id, claim_id, check_intake_item_id, document_name, document_path, status, created_at
     FROM public.signature_requests
     WHERE id = $1::uuid
     LIMIT 1`,
    [FAILED_DRAFT_ID],
  )).rows[0] || null;
  const signers = request
    ? (await client.query(
      `SELECT id, signer_email, status
       FROM public.signature_signers
       WHERE signature_request_id = $1::uuid`,
      [FAILED_DRAFT_ID],
    )).rows
    : [];
  return { request, signers };
};

const cleanupFailedDraft = async (client) => {
  const before = await documentFailedDraft(client);
  if (!before.request) {
    return { deleted: false, reason: 'not_found', before };
  }
  const safe = before.request.id === FAILED_DRAFT_ID
    && before.request.document_name === FAILED_DRAFT_NAME
    && before.request.claim_id == null
    && before.request.status === 'draft';
  if (!safe) {
    return { deleted: false, reason: 'predicates_not_met', before };
  }
  const signers = await client.query(
    `DELETE FROM public.signature_signers
     WHERE signature_request_id = $1::uuid
       AND signature_request_id IN (
         SELECT id FROM public.signature_requests
         WHERE id = $1::uuid
           AND document_name = $2
           AND claim_id IS NULL
           AND status = 'draft'
       )
     RETURNING id`,
    [FAILED_DRAFT_ID, FAILED_DRAFT_NAME],
  );
  const requests = await client.query(
    `DELETE FROM public.signature_requests
     WHERE id = $1::uuid
       AND document_name = $2
       AND claim_id IS NULL
       AND status = 'draft'
     RETURNING id, document_name, claim_id, status`,
    [FAILED_DRAFT_ID, FAILED_DRAFT_NAME],
  );
  return {
    deleted: requests.rows.length === 1,
    deletedSigners: signers.rows.map((row) => row.id),
    deletedRequests: requests.rows,
    before,
  };
};

export const handler = async (event = {}) => {
  const mode = String(event.mode || process.env.APPLY_MODE || 'inspect');
  if (!['inspect', 'apply', 'cleanup', 'verify'].includes(mode)) {
    return { ok: false, error: 'mode must be inspect|apply|cleanup|verify' };
  }
  if (!CA_PATH) return { ok: false, error: 'rds ca missing' };
  if ((mode === 'apply') && !SQL_PATH) return { ok: false, error: '69 sql missing' };
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
    const before = await inspectHelpers(client);
    const draftBefore = await documentFailedDraft(client);
    if (mode === 'inspect') {
      return { ok: true, mode, before, draft: draftBefore, productionSupabaseChanged: false };
    }
    if (mode === 'cleanup') {
      await client.query('BEGIN');
      const cleanup = await cleanupFailedDraft(client);
      if (!cleanup.deleted && cleanup.reason === 'predicates_not_met') {
        await client.query('ROLLBACK');
        return { ok: false, mode, cleanup, productionSupabaseChanged: false };
      }
      await client.query('COMMIT');
      return {
        ok: true,
        mode,
        cleanup,
        draftAfter: await documentFailedDraft(client),
        productionSupabaseChanged: false,
      };
    }
    if (mode === 'verify') {
      return {
        ok: true,
        mode,
        helpers: before,
        draft: draftBefore,
        productionSupabaseChanged: false,
      };
    }
    await client.query('BEGIN');
    await client.query(fs.readFileSync(SQL_PATH, 'utf8'));
    const after = await inspectHelpers(client);
    const missing = ['aws_public_homeowner_ledger_by_token', 'aws_public_homeowner_ledger_remint_signer']
      .filter((name) => !after.helpers.some((row) => row.name === name));
    if (missing.length) throw new Error(`missing functions: ${missing.join(',')}`);
    await client.query('COMMIT');
    return {
      ok: true,
      mode,
      before,
      after,
      draft: draftBefore,
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
