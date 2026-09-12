#!/usr/bin/env node
/**
 * Fail closed on unauthorized recipient_tax_profiles privilege changes and on
 * blanket GRANT / ALTER DEFAULT PRIVILEGES to Data API roles under
 * supabase/migrations/.
 *
 * Historical exceptions are content-hash-pinned in
 * supabase/security/hosted-tax-profile-containment.pins.json.
 * Filename-only allowlisting is not sufficient: editing a pinned file fails
 * until the new hash is reviewed in the same PR.
 *
 * Static scanning cannot prove arbitrary SQL safe. Suspicious concealment
 * (dynamic EXECUTE, concatenation, psql includes, encoded privilege SQL)
 * fails closed.
 *
 * Usage:
 *   node scripts/check-recipient-tax-profile-migrations.mjs
 *   node scripts/check-recipient-tax-profile-migrations.mjs /path/to/migrations /path/to/pins.json
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_MIGRATIONS = path.join(ROOT, 'supabase/migrations');
const DEFAULT_PINS = path.join(ROOT, 'supabase/security/hosted-tax-profile-containment.pins.json');
const LEGACY_ALLOWLIST = path.join(ROOT, 'scripts/recipient-tax-profile-migration-allowlist.txt');

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
const DATA_API_ROLE = String.raw`["']?(authenticated|anon|public)["']?`;
const BLANKET_GRANT_RE = new RegExp(
  String.raw`\bGRANT\b[\s\S]{0,800}\bON\s+ALL\s+TABLES\b[\s\S]{0,400}\bTO\b[\s\S]{0,240}${DATA_API_ROLE}`,
  'i',
);
const DEFAULT_PRIV_RE = new RegExp(
  String.raw`\bALTER\s+DEFAULT\s+PRIVILEGES\b[\s\S]{0,800}\bGRANT\b[\s\S]{0,400}\bTO\b[\s\S]{0,240}${DATA_API_ROLE}`,
  'i',
);
const PSQL_INCLUDE_RE = /(^|\n)\s*\\(i|ir|include|copy|gexec)\b/i;
const DYNAMIC_EXECUTE_RE = /\bEXECUTE\s+(format\s*\(|'[^']*'|\$)/i;
const CONCAT_RE = /\|\|/;
const ENCODED_RE = /\b(decode|convert_from|from_base64|convert_to)\s*\(/i;
const CHR_RE = /\bchr\s*\(/i;

export function sha256Buffer(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function loadPins(pinsPath = DEFAULT_PINS) {
  return JSON.parse(fs.readFileSync(pinsPath, 'utf8'));
}

export function loadAllowlist(pinsPath = DEFAULT_PINS) {
  const pins = loadPins(pinsPath);
  return new Set((pins.historical_migrations || []).map((row) => row.basename));
}

function pinnedRecord(pins, name) {
  return (pins.historical_migrations || []).find((row) => row.basename === name) || null;
}

export function classifyMigrationText(text) {
  const reasons = [];
  if (TABLE_RE.test(text) && PRIVILEGE_RE.test(text)) {
    reasons.push('recipient_tax_profiles privilege/policy/RLS change');
  }
  if (BLANKET_GRANT_RE.test(text)) {
    reasons.push('GRANT ON ALL TABLES to Data API role');
  }
  if (DEFAULT_PRIV_RE.test(text)) {
    reasons.push('ALTER DEFAULT PRIVILEGES GRANT to Data API role');
  }
  const concealmentTarget = TABLE_RE.test(text) || BLANKET_GRANT_RE.test(text) || DEFAULT_PRIV_RE.test(text);
  if (PSQL_INCLUDE_RE.test(text)) {
    reasons.push('psql include/meta command');
  }
  if (concealmentTarget && DYNAMIC_EXECUTE_RE.test(text)) {
    reasons.push('dynamic EXECUTE privilege SQL');
  }
  if (concealmentTarget && CONCAT_RE.test(text) && /\b(GRANT|REVOKE)\b/i.test(text)) {
    reasons.push('string-concatenated privilege SQL');
  }
  if (concealmentTarget && (ENCODED_RE.test(text) || CHR_RE.test(text)) && /\b(GRANT|REVOKE)\b/i.test(text)) {
    reasons.push('encoded or generated privilege SQL');
  }
  return reasons;
}

export function scanMigrations(migrationsDir, pins) {
  const resolvedPins = pins && pins.historical_migrations ? pins : loadPins();
  const names = fs.readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort();
  const violations = [];
  for (const name of names) {
    const buf = fs.readFileSync(path.join(migrationsDir, name));
    const digest = sha256Buffer(buf);
    const pin = pinnedRecord(resolvedPins, name);
    if (pin) {
      if (!pin.review || String(pin.review).trim().length < 20) {
        violations.push({
          name,
          reasons: ['hash-pinned exception is missing visible review metadata'],
        });
      }
      if (digest !== pin.sha256) {
        violations.push({
          name,
          reasons: [`hash-pinned historical file was modified (expected ${pin.sha256})`],
        });
      }
      continue;
    }
    const reasons = classifyMigrationText(buf.toString('utf8'));
    if (reasons.length > 0) {
      violations.push({ name, reasons });
    }
  }
  return { names, violations };
}

export function main(argv = process.argv.slice(2)) {
  const migrationsDir = argv[0] || DEFAULT_MIGRATIONS;
  const pinsPath = argv[1] && argv[1].endsWith('.json') ? argv[1] : DEFAULT_PINS;
  if (argv[1] && argv[1].endsWith('.txt') && path.resolve(argv[1]) === LEGACY_ALLOWLIST) {
    // Compatibility: old tests passed the txt path; pins are the source of truth.
  }
  const pins = loadPins(pinsPath);
  const { violations } = scanMigrations(migrationsDir, pins);
  if (violations.length > 0) {
    console.error('recipient_tax_profiles migration guard failed:');
    for (const row of violations) {
      console.error(`  ${row.name}: ${row.reasons.join('; ')}`);
    }
    console.error('Authorized exceptions: add basename + SHA-256 + review note to supabase/security/hosted-tax-profile-containment.pins.json in the same PR.');
    return 1;
  }
  console.log('recipient_tax_profiles migration guard: ok');
  return 0;
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  process.exitCode = main();
}
