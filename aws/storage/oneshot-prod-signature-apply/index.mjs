/**
 * Production SQL apply for the accepted signature-workflow helpers only.
 * Refuses non-production hosts. Does not create customer fixtures.
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
];

const sqlPath = (name) => [
  path.join(ROOT, 'sql', name),
  path.join(ROOT, '..', 'sql', name),
  path.join(ROOT, '..', '..', 'rls', 'sql', name),
  path.join(ROOT, '..', '..', 'workflows', 'sql', name),
].find((p) => fs.existsSync(p));

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

const inspect = async (client) => {
  const helpers = (await client.query(
    `SELECT p.proname,
            pg_get_function_identity_arguments(p.oid) AS args,
            p.prosecdef AS security_definer,
            p.proconfig,
            md5(pg_get_functiondef(p.oid)) AS def_md5
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = ANY($1::text[])
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
     WHERE n.nspname = 'public' AND p.proname = ANY($1::text[])
     ORDER BY 1, 2`,
    [HELPERS],
  )).rows;
  const policies = (await client.query(
    `SELECT tablename, policyname, cmd, qual, with_check
     FROM pg_policies
     WHERE schemaname = 'public'
       AND (
         tablename IN ('signature_requests', 'signature_signers', 'signature_fields', 'esign_event_logs')
         OR (tablename = 'claims' AND policyname IN ('aws_select_claims', 'aws_write_claims'))
       )
     ORDER BY 1, 2`,
  )).rows;
  return { helpers, grants, policies };
};

const schemaPreflight = async (client) => {
  const cols = (await client.query(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND (
         (table_name = 'check_files' AND column_name IN ('signature_request_id', 'category', 'source', 'file_path', 'check_intake_item_id'))
         OR (table_name = 'claim_files' AND column_name IN ('claim_id', 'file_path', 'file_name', 'file_type'))
         OR (table_name = 'homeowner_ledger_tokens' AND column_name IN ('token', 'claim_id', 'tenant_id', 'homeowner_email', 'revoked_at', 'expires_at'))
         OR (table_name = 'loss_draft_documents' AND column_name IN ('signature_request_id', 'signature_status', 'signed_at', 'is_submitted', 'submitted_at'))
         OR (table_name = 'signature_requests' AND column_name IN ('claim_id', 'check_intake_item_id', 'document_path', 'final_pdf_path', 'status'))
         OR (table_name = 'signature_signers' AND column_name IN ('token_hash', 'status', 'viewed_at', 'signed_at'))
       )
     ORDER BY 1, 2`,
  )).rows;
  const required = {
    'check_files.signature_request_id': false,
    'check_files.category': false,
    'claim_files.file_path': false,
    'homeowner_ledger_tokens.token': false,
    'loss_draft_documents.signature_request_id': false,
    'signature_requests.document_path': false,
    'signature_signers.token_hash': false,
  };
  for (const row of cols) required[`${row.table_name}.${row.column_name}`] = true;
  const missing = Object.entries(required).filter(([, ok]) => !ok).map(([name]) => name);
  return { cols, missing };
};

export const handler = async (event = {}) => {
  const apply = event.apply === true || event.apply === 'true';
  const creds = await loadAdmin();
  const client = new Client({
    host: creds.host,
    port: creds.port,
    user: creds.username,
    password: creds.password,
    database: creds.database,
    ssl: caPath ? { ca: fs.readFileSync(caPath, 'utf8'), rejectUnauthorized: true } : { rejectUnauthorized: false },
    statement_timeout: 30000,
  });
  await client.connect();
  try {
    const before = await inspect(client);
    const schema = await schemaPreflight(client);
    const claimsBefore = before.policies.find((row) => row.tablename === 'claims' && row.policyname === 'aws_select_claims');
    if (schema.missing.length) {
      return { ok: false, error: 'schema_preflight_failed', schema, before };
    }
    if (!apply) {
      return { ok: true, dry_run: true, host: creds.host, schema, before };
    }
    const files = [
      '02_public_signature_write_helpers.sql',
      '69_homeowner_ledger_pending_and_sign_link.sql',
      '39_mortgage_agent_signature_send.sql',
    ];
    const applied = [];
    for (const name of files) {
      const file = sqlPath(name);
      if (!file) throw new Error(`missing sql ${name}`);
      await client.query(fs.readFileSync(file, 'utf8'));
      applied.push({ name, path: file });
    }
    const after = await inspect(client);
    const claimsAfter = after.policies.find((row) => row.tablename === 'claims' && row.policyname === 'aws_select_claims');
    const missing = HELPERS.filter((name) => !after.helpers.some((row) => row.proname === name));
    const publicExec = after.grants.filter((row) => row.grantee === 'PUBLIC' || row.grantee === 'public');
    const claimsUnchanged = JSON.stringify(claimsBefore) === JSON.stringify(claimsAfter);
    return {
      ok: missing.length === 0 && publicExec.length === 0 && claimsUnchanged,
      applied,
      host: creds.host,
      missing,
      public_execute: publicExec,
      claims_select_unchanged: claimsUnchanged,
      claims_select: claimsAfter,
      after,
    };
  } finally {
    await client.end();
  }
};
