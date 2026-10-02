/**
 * One-time production apply for membership-only user_can_move_tenant_checks.
 * Does not touch admin_override_check_status. No GRANT/REVOKE/RLS.
 * Restore the inspect-only handler after this runs.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const { Client } = pg;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CA_PATH = path.join(ROOT, 'rds-global-bundle.pem');
const SOURCE_PATH = path.join(ROOT, '20261002200000_user_can_move_tenant_checks_membership_only.sql');
const PINNED_SOURCE = '298506c90be829222c75781dd7c546fdefc6c5b2fa5cf86442eed30d383ef22e';
const HELPER_BEFORE = '6117128f04865fbd2dfd758bec1ecbc7f283e1fe047651d5f3b84521e61d3fe2';
const OVERRIDE_UNCHANGED = '74a234df30847cecab759c72d75fb7ced55ef6e0a0e3d7f86d78e51310ab84e5';
const HELPER_AFTER = '010a450154c4d0d97c4d5b4ab82858c83ab57a3044c9937d40dec86a6c7a749d';
const PAIR_AFTER = '0cd4a7b515656be4777a1f467aa7ca3e0160060031fca66b207cc9fb0854b48e';

const LOOKUP = `
SELECT pg_get_functiondef(p.oid) AS def
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = $1::text
  AND p.proname = $2::text
  AND p.pronargs = COALESCE(cardinality($3::text[]), 0)
  AND (
    SELECT COALESCE(ARRAY_AGG(proc_t.typ ORDER BY proc_t.ord), ARRAY[]::oid[])
    FROM unnest(p.proargtypes::oid[]) WITH ORDINALITY AS proc_t(typ, ord)
  ) = (
    SELECT COALESCE(ARRAY_AGG(u.typ::regtype::oid ORDER BY u.ord), ARRAY[]::oid[])
    FROM unnest(COALESCE($3::text[], ARRAY[]::text[])) WITH ORDINALITY AS u(typ, ord)
  )
`;

const sha256 = (text) => createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
const pairHash = (helper, override) => sha256(JSON.stringify({
  user_can_move_tenant_checks: helper || null,
  admin_override_check_status: override || null,
}));

async function connectAdmin() {
  const arn = process.env.ADMIN_SECRET_ARN;
  if (!arn || !/checksops-production/i.test(arn)) throw new Error('requires production admin secret');
  const sm = new SecretsManagerClient({});
  const secret = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  const parsed = JSON.parse(secret.SecretString);
  if (!/checksops_admin/i.test(parsed.username || '')) throw new Error('secret username is not checksops_admin');
  const host = parsed.host && parsed.host !== 'localhost' ? parsed.host : process.env.RDS_HOST;
  if (!/checksops-production/i.test(String(host || ''))) throw new Error(`refusing_non_production_host:${host}`);
  const client = new Client({
    host,
    port: Number(parsed.port || 5432),
    user: parsed.username,
    password: parsed.password,
    database: process.env.DATABASE_NAME || 'checksops',
    ssl: { rejectUnauthorized: true, ca: fs.readFileSync(CA_PATH, 'utf8') },
    connectionTimeoutMillis: 8000,
    query_timeout: 30000,
  });
  await client.connect();
  const db = (await client.query('SELECT current_database() AS d')).rows[0];
  if (db.d !== 'checksops') {
    await client.end();
    throw new Error(`connected to ${db.d}`);
  }
  return client;
}

async function readDef(client, name, args) {
  const rows = (await client.query(LOOKUP, ['public', name, args])).rows;
  if (rows.length !== 1) throw new Error(`lookup_unexpected:${name}:${rows.length}`);
  return rows[0].def;
}

function inspectDefs(helper, override) {
  return {
    helper_sha256: sha256(helper),
    override_sha256: sha256(override),
    pair_sha256: pairHash(helper, override),
    helper_has_role: helper.includes('has_role'),
    helper_membership_only: Boolean(helper.includes('user_belongs_to_tenant') && !helper.includes('has_role')),
    override_allows_deposited: /v_allowed text\[\] := ARRAY\[[\s\S]*?'deposited'/.test(override),
  };
}

export const handler = async (event = {}) => {
  if (event.sql || event.statement || event.query || event.extra_sql || event.arbitrary_sql) {
    return { ok: false, error: 'refuses_caller_sql' };
  }
  if (event.target_environment === 'staging') {
    return { ok: false, error: 'this handler is production-only' };
  }
  const source = fs.readFileSync(SOURCE_PATH, 'utf8');
  if (sha256(source) !== PINNED_SOURCE) {
    return { ok: false, error: 'pinned_source_mismatch', source: sha256(source) };
  }
  if (/GRANT|REVOKE|ENABLE ROW LEVEL SECURITY|CREATE POLICY/i.test(source)) {
    return { ok: false, error: 'source_contains_grant_or_rls' };
  }
  if (/admin_override_check_status/i.test(source)) {
    return { ok: false, error: 'source_must_not_replace_override' };
  }

  const client = await connectAdmin();
  try {
    const helperBefore = await readDef(client, 'user_can_move_tenant_checks', ['uuid', 'uuid']);
    const overrideBefore = await readDef(client, 'admin_override_check_status', ['uuid', 'text', 'uuid']);
    const before = inspectDefs(helperBefore, overrideBefore);
    const snapshot = { before, identity: (await client.query('SELECT current_user AS db_user, current_database() AS database')).rows[0] };

    if ((event.action || 'inspect') !== 'apply') {
      return { ok: true, inspect_only: true, mutated: false, ...snapshot };
    }

    if (before.helper_sha256 !== HELPER_BEFORE) {
      return { ok: false, error: 'helper_drift_before_apply', ...snapshot };
    }
    if (before.override_sha256 !== OVERRIDE_UNCHANGED) {
      return { ok: false, error: 'override_drift_refuse_apply', ...snapshot };
    }
    if (!before.helper_has_role || before.override_allows_deposited) {
      return { ok: false, error: 'unexpected_pre_apply_shape', ...snapshot };
    }

    await client.query('BEGIN');
    await client.query(source);
    const helperAfter = await readDef(client, 'user_can_move_tenant_checks', ['uuid', 'uuid']);
    const overrideAfter = await readDef(client, 'admin_override_check_status', ['uuid', 'text', 'uuid']);
    const after = inspectDefs(helperAfter, overrideAfter);
    if (after.override_sha256 !== OVERRIDE_UNCHANGED) {
      await client.query('ROLLBACK');
      return { ok: false, error: 'override_changed_rolled_back', before, after };
    }
    if (after.helper_sha256 !== HELPER_AFTER || after.pair_sha256 !== PAIR_AFTER) {
      await client.query('ROLLBACK');
      return { ok: false, error: 'helper_after_hash_mismatch_rolled_back', before, after };
    }
    if (after.helper_has_role || !after.helper_membership_only || after.override_allows_deposited) {
      await client.query('ROLLBACK');
      return { ok: false, error: 'membership_only_shape_failed_rolled_back', before, after };
    }
    await client.query('COMMIT');
    return {
      ok: true,
      mutated: true,
      result: 'applied',
      grant_revoke_rls: false,
      before,
      after,
    };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    return { ok: false, error: String(error?.message || error).slice(0, 400) };
  } finally {
    try { await client.end(); } catch { /* ignore */ }
  }
};
