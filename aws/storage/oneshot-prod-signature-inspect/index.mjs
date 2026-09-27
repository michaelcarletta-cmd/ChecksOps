/**
 * Production-only READ inspect of accepted signature helpers.
 * Never applies SQL. Never creates fixtures. Refuses non-production hosts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const { Client } = pg;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REQUIRED_HOST = 'checksops-production.cyr0q4kcop3c.us-east-1.rds.amazonaws.com';
const HELPERS = [
  'aws_public_signature_by_token_hash',
  'aws_public_signature_canonical_pdf_path',
  'aws_public_signature_mark_viewed',
  'aws_public_signature_submit',
  'aws_public_signature_attach_signed',
  'aws_public_signature_set_completion_error',
  'aws_public_homeowner_ledger_by_token',
  'aws_public_homeowner_ledger_remint_signer',
  'aws_mortgage_agent_can_manage_signature',
  'aws_mortgage_agent_assigned_to_context',
  'aws_mortgage_agent_can_initiate_signature',
  'aws_can_access_signature_request',
  'aws_can_write_tenant',
  'aws_select_claims',
];

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
].find((p) => fs.existsSync(p));

export const handler = async () => {
  const creds = await loadAdmin();
  const client = new Client({
    host: creds.host,
    port: creds.port,
    user: creds.username,
    password: creds.password,
    database: creds.database,
    ssl: caPath ? { ca: fs.readFileSync(caPath, 'utf8'), rejectUnauthorized: true } : { rejectUnauthorized: false },
    statement_timeout: 15000,
  });
  await client.connect();
  try {
    const host = (await client.query('SELECT inet_server_addr()::text AS addr, current_database() AS db, current_user AS usr')).rows[0];
    const helpers = (await client.query(
      `SELECT p.proname,
              pg_get_function_identity_arguments(p.oid) AS args,
              pg_get_userbyid(p.proowner) AS owner,
              p.prosecdef AS security_definer,
              p.proconfig,
              md5(pg_get_functiondef(p.oid)) AS def_md5,
              length(pg_get_functiondef(p.oid)) AS def_len
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname = ANY($1::text[])
       ORDER BY 1, 2`,
      [HELPERS],
    )).rows;
    const grants = (await client.query(
      `SELECT p.proname, r.rolname AS grantee, a.privilege_type
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       JOIN information_schema.routine_privileges a
         ON a.routine_schema = 'public' AND a.routine_name = p.proname
       JOIN pg_roles r ON r.rolname = a.grantee
       WHERE n.nspname = 'public'
         AND p.proname = ANY($1::text[])
       ORDER BY 1, 2`,
      [HELPERS],
    )).rows;
    const policies = (await client.query(
      `SELECT tablename, policyname, cmd, roles::text, qual, with_check
       FROM pg_policies
       WHERE schemaname = 'public'
         AND tablename IN ('signature_requests', 'signature_signers', 'signature_fields', 'esign_event_logs', 'claims')
       ORDER BY 1, 2`,
    )).rows;
    const tables = (await client.query(
      `SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS force_rls
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname IN ('signature_requests', 'signature_signers', 'signature_fields', 'check_files', 'claim_files', 'homeowner_access_tokens')
       ORDER BY 1`,
    )).rows;
    const missing = HELPERS.filter((name) => !helpers.some((row) => row.proname === name));
    return {
      ok: true,
      inspect_only: true,
      host: creds.host,
      session: host,
      helpers,
      grants,
      policies,
      tables,
      missing,
    };
  } finally {
    await client.end();
  }
};
