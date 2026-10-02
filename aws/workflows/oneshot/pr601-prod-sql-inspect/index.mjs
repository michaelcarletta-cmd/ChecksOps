/**
 * Inspect-only production catalog probe for the two #601 DEFINER functions.
 * SET default_transaction_read_only=on. Refuses caller SQL and every
 * non-inspect action. Does not GRANT/REVOKE, CREATE, REPLACE, or apply.
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
const SOURCE_PATH = path.join(ROOT, '20261001231500_tenant_users_same_check_permissions.sql');
const PINNED_SOURCE_SHA256 = '573ec6a0178d04a041e053aeb724560950b504d162b6f113563bec5108a0e518';
const EXPECTED_PAIR = '4138ead09bc27ebeeaf5e902f8685d945165d65501bd3fb90b1bcce168db2802';

const IDENTITIES = Object.freeze([
  {
    identity: 'public.user_can_move_tenant_checks(uuid,uuid)',
    schema: 'public',
    name: 'user_can_move_tenant_checks',
    arg_types: ['uuid', 'uuid'],
  },
  {
    identity: 'public.admin_override_check_status(uuid,text,uuid)',
    schema: 'public',
    name: 'admin_override_check_status',
    arg_types: ['uuid', 'text', 'uuid'],
  },
]);

const FUNCTION_DEF_LOOKUP_SQL = `
SELECT n.nspname AS schema_name,
       p.proname AS function_name,
       pg_get_functiondef(p.oid) AS def
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
`.trim();

const DOLLAR_BODY_RE = /\bAS\s+(\$[A-Za-z0-9_]*\$)([\s\S]*?)\1/i;

function sha256(text) {
  return createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function extractDollarQuotedBody(sql) {
  const match = String(sql || '').match(DOLLAR_BODY_RE);
  return match ? match[2].trim() : null;
}

function functionHeaderFlags(sql) {
  const text = String(sql || '');
  return {
    language: (text.match(/\bLANGUAGE\s+(\w+)/i) || [])[1]?.toLowerCase() || null,
    security_definer: /\bSECURITY\s+DEFINER\b/i.test(text),
    stable: /\bSTABLE\b/i.test(text),
    search_path_public: /SET\s+search_path\s+TO\s+'public'/i.test(text),
  };
}

function functionDefsMatchExactly(liveDef, sourceSql) {
  const liveBody = extractDollarQuotedBody(liveDef);
  const sourceBody = extractDollarQuotedBody(sourceSql);
  if (!liveBody || !sourceBody || liveBody !== sourceBody) return false;
  const live = functionHeaderFlags(liveDef);
  const source = functionHeaderFlags(sourceSql);
  return live.language === source.language
    && live.security_definer === source.security_definer
    && live.stable === source.stable
    && live.search_path_public === source.search_path_public;
}

function extractSourceFunctions(sql) {
  const text = String(sql || '');
  const blocks = [];
  const re = /CREATE\s+OR\s+REPLACE\s+FUNCTION[\s\S]*?(?=CREATE\s+OR\s+REPLACE\s+FUNCTION|$)/gi;
  let match;
  while ((match = re.exec(text))) blocks.push(match[0].trim());
  const byName = {};
  for (const block of blocks) {
    const name = (block.match(/FUNCTION\s+public\.([A-Za-z0-9_]+)/i) || [])[1];
    if (name) byName[name] = block;
  }
  return byName;
}

function pairCandidates(defs) {
  const [a, b] = defs;
  const hashA = sha256(a);
  const hashB = sha256(b);
  const bodyA = extractDollarQuotedBody(a) || '';
  const bodyB = extractDollarQuotedBody(b) || '';
  return {
    hex_concat: sha256(hashA + hashB),
    hex_newline: sha256(`${hashA}\n${hashB}`),
    hex_sorted_concat: sha256([hashA, hashB].sort().join('')),
    hex_sorted_newline: sha256([hashA, hashB].sort().join('\n')),
    def_concat: sha256(a + b),
    def_newline: sha256(`${a}\n${b}`),
    body_hex_concat: sha256(sha256(bodyA) + sha256(bodyB)),
    identity_labeled: sha256(
      `${IDENTITIES[0].identity}=${hashA}\n${IDENTITIES[1].identity}=${hashB}`,
    ),
    official_pair: sha256([hashA, hashB].join('')),
  };
}

async function connectAdmin() {
  const arn = process.env.ADMIN_SECRET_ARN;
  if (!arn || !/checksops-production/i.test(arn)) {
    throw new Error('inspect requires production admin secret');
  }
  const sm = new SecretsManagerClient({});
  const secret = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  const parsed = JSON.parse(secret.SecretString);
  if (!/checksops_admin/i.test(parsed.username || '')) {
    throw new Error('secret username is not checksops_admin');
  }
  const host = parsed.host && parsed.host !== 'localhost' ? parsed.host : process.env.RDS_HOST;
  if (!/checksops-production/i.test(String(host || ''))) {
    throw new Error(`refusing_non_production_host:${host}`);
  }
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
  return client;
}

export const handler = async (event = {}) => {
  if (event.sql || event.statement || event.query || event.extra_sql) {
    return { ok: false, error: 'refuses_caller_sql' };
  }
  if ((event.action || 'inspect') !== 'inspect') {
    return { ok: false, error: `refuses_action:${event.action}` };
  }

  const sourceSql = fs.readFileSync(SOURCE_PATH, 'utf8');
  const sourceHash = sha256(sourceSql);
  if (sourceHash !== PINNED_SOURCE_SHA256) {
    return { ok: false, error: 'pinned_source_mismatch', sourceHash };
  }
  const sourceFns = extractSourceFunctions(sourceSql);

  const client = await connectAdmin();
  try {
    await client.query('SET default_transaction_read_only = on');
    const identity = (await client.query(`
      SELECT current_database() AS database,
             current_user AS db_user,
             current_setting('transaction_read_only') AS read_only,
             current_setting('server_version') AS server_version
    `)).rows[0];
    if (identity.database !== 'checksops') {
      return { ok: false, error: `connected_to_${identity.database}` };
    }
    if (identity.read_only !== 'on') {
      return { ok: false, error: 'read_only_not_on' };
    }

    const functions = [];
    for (const spec of IDENTITIES) {
      const rows = (await client.query(FUNCTION_DEF_LOOKUP_SQL, [
        spec.schema,
        spec.name,
        spec.arg_types,
      ])).rows;
      if (rows.length !== 1 || typeof rows[0]?.def !== 'string') {
        return {
          ok: false,
          error: 'function_lookup_unexpected',
          identity: spec.identity,
          matches: rows.length,
        };
      }
      const liveDef = rows[0].def;
      const sourceDef = sourceFns[spec.name] || '';
      const exact = functionDefsMatchExactly(liveDef, sourceDef);
      functions.push({
        identity: spec.identity,
        exists: true,
        exact,
        live_definition_sha256: sha256(liveDef),
        live_body_sha256: sha256(extractDollarQuotedBody(liveDef) || ''),
        source_body_sha256: sha256(extractDollarQuotedBody(sourceDef) || ''),
        flags: functionHeaderFlags(liveDef),
        def: liveDef,
      });
    }

    const pair = pairCandidates(functions.map((row) => row.def));
    const matching = Object.entries(pair)
      .filter(([, value]) => value === EXPECTED_PAIR)
      .map(([key]) => key);
    const allExact = functions.every((row) => row.exact === true);
    const pairExact = matching.length > 0;

    return {
      ok: allExact && pairExact,
      inspect_only: true,
      mutated: false,
      source_sha256: sourceHash,
      identity,
      functions: functions.map(({ def, ...rest }) => rest),
      pair_candidates: pair,
      pair_fingerprint: matching[0] ? pair[matching[0]] : pair.hex_concat,
      pair_algorithm: matching[0] || null,
      expected_pair_fingerprint: EXPECTED_PAIR,
      pair_matches_expected: pairExact,
      both_exact: allExact,
    };
  } finally {
    try { await client.end(); } catch { /* ignore */ }
  }
};
