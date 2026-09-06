/**
 * Local assertions for 38_parity_payee_mirror_and_returns.sql.
 * Does not connect to production. Isolated RDS apply is a separate oneshot step.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SQL_PATH = path.join(ROOT, 'write-path/sql/38_parity_payee_mirror_and_returns.sql');

export const REQUIRED_INTAKE_RETURN_COLS = [
  'returned_at',
  'return_code',
  'return_reason',
  'return_notes',
  'return_recorded_by',
  'return_source',
  'pre_return_stage',
  'return_resolved_at',
  'return_resolution',
];

export const REQUIRED_CHECKALT_RETURN_COLS = [
  'return_code',
  'return_reason',
  'returned_at',
  'return_window_until',
];

export const loadParitySql = () => fs.readFileSync(SQL_PATH, 'utf8');

const uncommentedSql = (sql) => sql
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');

export const validateParitySql = (sql = loadParitySql()) => {
  const active = uncommentedSql(sql);
  const missing = [];
  if (!/CREATE OR REPLACE FUNCTION public\.tg_mirror_payee_to_endorsement/.test(sql)) {
    missing.push('tg_mirror_payee_to_endorsement');
  }
  if (!/lower\(trim\(NEW\.payee_name\)\) IS DISTINCT FROM lower\(trim\(OLD\.payee_name\)\)/.test(sql)) {
    missing.push('rename_distinct_check');
  }
  if (!/DELETE FROM public\.check_endorsements/.test(sql)) {
    missing.push('rename_delete_stale_unsigned');
  }
  for (const col of REQUIRED_INTAKE_RETURN_COLS) {
    if (!sql.includes(col)) missing.push(`intake:${col}`);
  }
  for (const col of REQUIRED_CHECKALT_RETURN_COLS) {
    if (!new RegExp(`checkalt_deposits[\\s\\S]*${col}`).test(sql)) missing.push(`checkalt:${col}`);
  }
  const forbidden = [];
  if (/preferred_auth_method/.test(active)) forbidden.push('preferred_auth_method');
  if (/user_passkeys/.test(active)) forbidden.push('user_passkeys');
  if (/GRANT[\s\S]{0,80}platform_fee_line_items/i.test(active)) forbidden.push('financial_fee_grants');
  if (/CREATE TABLE[\s\S]{0,80}platform_fee_line_items/i.test(active)) forbidden.push('platform_fee_line_items');
  return {
    ok: missing.length === 0 && forbidden.length === 0,
    missing,
    forbidden,
    path: SQL_PATH,
  };
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = validateParitySql();
  if (!result.ok) {
    console.error(JSON.stringify(result, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, path: result.path }, null, 2));
}
