/**
 * SQL / RPC apply safety.
 *
 * Track migrations by filename, id, source SHA-256, target environment,
 * and expected live definition. Never CREATE OR REPLACE an RPC whose live
 * definition drifted. Never silently backfill unrelated data.
 *
 * This module plans applies. It does not connect to a database.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODES, fail, ok, SHA256_RE, sha256Text } from './lib.mjs';

export const SILENT_MUTATION_RE = /\b(BACKFILL|UPDATE\s+[\w.]+\s+SET|DELETE\s+FROM|TRUNCATE)\b/i;

export function sqlDefinitionHash(definition) {
  if (definition == null) return null;
  return sha256Text(String(definition).replace(/\s+/g, ' ').trim());
}

export function validateSqlRecord(record) {
  if (!record?.filename) return fail(CODES.INVALID_MANIFEST, 'SQL record requires filename');
  if (!record.migration_id) return fail(CODES.INVALID_MANIFEST, `SQL record ${record.filename} requires migration_id`);
  if (!SHA256_RE.test(String(record.source_sha256 || ''))) {
    return fail(CODES.INVALID_MANIFEST, `SQL record ${record.filename} requires source_sha256`);
  }
  if (!['staging', 'production'].includes(record.target_environment)) {
    return fail(CODES.INVALID_TARGET, `SQL record ${record.filename} target_environment must be staging or production`);
  }
  return ok({ record });
}

export function assertSqlReplace(record) {
  const checked = validateSqlRecord(record);
  if (!checked.ok) return checked;
  if (record.contains_unrelated_backfill === true) {
    return fail(CODES.SQL_COLLISION, `migration ${record.migration_id} declares unrelated data mutation; refusing silent backfill`, { record });
  }
  if (record.source_text && SILENT_MUTATION_RE.test(record.source_text) && record.allow_data_mutation !== true) {
    return fail(CODES.SQL_COLLISION, `migration ${record.migration_id} contains DML/backfill without explicit allow_data_mutation`, { record });
  }
  if (record.replacing_existing === true || record.expected_live_definition_sha256) {
    const expected = record.expected_live_definition_sha256;
    const live = record.current_live_definition_sha256 || sqlDefinitionHash(record.current_live_definition);
    if (!expected || !live) {
      return fail(CODES.SQL_COLLISION, `CREATE OR REPLACE of ${record.filename} requires live and expected definition hashes`, { record });
    }
    if (expected !== live) {
      return fail(CODES.SQL_COLLISION, `live SQL definition drifted for ${record.filename}; never automatically replace it`, {
        filename: record.filename,
        migration_id: record.migration_id,
        expected_live_definition_sha256: expected,
        current_live_definition_sha256: live,
        target_environment: record.target_environment,
      });
    }
  }
  return ok({ record });
}

export function planSqlApply(input = {}) {
  const records = Array.isArray(input.records) ? input.records : (input.record ? [input.record] : []);
  if (!records.length) {
    return fail(CODES.INVALID_MANIFEST, 'sql-apply requires at least one SQL record');
  }
  const accepted = [];
  for (const record of records) {
    const result = assertSqlReplace(record);
    if (!result.ok) return result;
    accepted.push(result.record);
  }
  return ok({
    records: accepted,
    note: 'SQL apply is plan-only; this workstream does not execute CREATE OR REPLACE',
  });
}

export function commitSqlApply(_plan, aws) {
  if (!aws || typeof aws.applySql !== 'function') {
    return fail(CODES.AWS_WRITE_FORBIDDEN, 'no database adapter supplied; refusing SQL write');
  }
  try {
    aws.applySql();
  } catch (error) {
    return fail(error.code || CODES.AWS_WRITE_FORBIDDEN, error.message);
  }
  return fail(CODES.AWS_WRITE_FORBIDDEN, 'SQL write is not implemented in this safeguard workstream');
}

export function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help')) {
    console.log('sql-apply plans a fail-closed RPC/migration apply. It never connects to a database.');
    return 0;
  }
  console.log(JSON.stringify({
    ok: true,
    message: 'sql-apply is plan-only; invoke planSqlApply() from preflight',
  }, null, 2));
  return 0;
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  process.exitCode = main();
}
