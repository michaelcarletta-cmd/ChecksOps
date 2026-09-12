#!/usr/bin/env node
/**
 * Fail if a future file under supabase/migrations/ both:
 *   - references recipient_tax_profiles, and
 *   - performs GRANT / REVOKE / CREATE|DROP POLICY / ALTER TABLE RLS /
 *     TIN-related privilege changes
 * unless the basename is listed in the repository allowlist.
 *
 * Ordinary unrelated migrations are ignored. The 2026-07-31 blanket GRANT
 * does not name this table and is therefore not flagged here; do not re-run it.
 *
 * Usage:
 *   node scripts/check-recipient-tax-profile-migrations.mjs
 *   node scripts/check-recipient-tax-profile-migrations.mjs /path/to/migrations /path/to/allowlist.txt
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_MIGRATIONS = path.join(ROOT, 'supabase/migrations');
const DEFAULT_ALLOWLIST = path.join(ROOT, 'scripts/recipient-tax-profile-migration-allowlist.txt');

const TABLE_RE = /recipient_tax_profiles/i;
const PRIVILEGE_RE = new RegExp(
  [
    '\\bGRANT\\b',
    '\\bREVOKE\\b',
    '\\bCREATE\\s+POLICY\\b',
    '\\bDROP\\s+POLICY\\b',
    '\\bALTER\\s+POLICY\\b',
    '\\bENABLE\\s+ROW\\s+LEVEL\\s+SECURITY\\b',
    '\\bDISABLE\\s+ROW\\s+LEVEL\\s+SECURITY\\b',
    '\\bFORCE\\s+ROW\\s+LEVEL\\s+SECURITY\\b',
    '\\bNO\\s+FORCE\\s+ROW\\s+LEVEL\\s+SECURITY\\b',
    '\\bALTER\\s+DEFAULT\\s+PRIVILEGES\\b',
  ].join('|'),
  'i',
);

export function loadAllowlist(allowlistPath) {
  const text = fs.readFileSync(allowlistPath, 'utf8');
  return new Set(
    text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#')),
  );
}

export function scanMigrations(migrationsDir, allowlist) {
  const names = fs.readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort();
  const violations = [];
  for (const name of names) {
    const text = fs.readFileSync(path.join(migrationsDir, name), 'utf8');
    if (!TABLE_RE.test(text)) continue;
    if (!PRIVILEGE_RE.test(text)) continue;
    if (allowlist.has(name)) continue;
    violations.push(name);
  }
  return { names, violations };
}

export function main(argv = process.argv.slice(2)) {
  const migrationsDir = argv[0] || DEFAULT_MIGRATIONS;
  const allowlistPath = argv[1] || DEFAULT_ALLOWLIST;
  const allowlist = loadAllowlist(allowlistPath);
  const { violations } = scanMigrations(migrationsDir, allowlist);
  if (violations.length > 0) {
    console.error('recipient_tax_profiles migration guard failed:');
    for (const name of violations) {
      console.error(`  ${name} names recipient_tax_profiles and changes privileges/policies/RLS without an allowlist entry`);
    }
    console.error('Authorized future migrations: add the filename to scripts/recipient-tax-profile-migration-allowlist.txt in the same PR, with a security review.');
    return 1;
  }
  console.log('recipient_tax_profiles migration guard: ok');
  return 0;
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  process.exitCode = main();
}
