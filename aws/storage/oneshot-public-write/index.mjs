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

export const handler = async (event = {}) => {
  const mode = String(event.mode || process.env.APPLY_MODE || 'inspect');
  if (!['inspect', 'apply'].includes(mode)) {
    return { ok: false, error: 'mode must be inspect|apply' };
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
