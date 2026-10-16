/**
 * SQL 89 test support: the API's UPDATE statements on public.check_intake_items,
 * read from the source, and a PostgreSQL fixture of the table with every SQL 89
 * column plus the identity and financial columns SQL 89 must not grant.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const API_DIR = path.join(REPO_ROOT, 'aws/functions/api');

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.mjs')) out.push(full);
  }
  return out.sort();
}

const UPDATE_RE = /\bUPDATE\s+(?:ONLY\s+)?(?:public\s*\.\s*)?"?check_intake_items\b/i;

/** Split on commas outside parentheses. */
function topLevelSplit(text) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}

/** The SET targets of one UPDATE statement (null for a target built at runtime). */
export function setTargets(sql) {
  const set = String(sql).match(/\bSET\b([\s\S]*?)\bWHERE\b/i);
  if (!set) throw new Error(`no SET ... WHERE in: ${sql.slice(0, 120)}`);
  return topLevelSplit(set[1]).map((part) => {
    const target = part.match(/^\s*([a-z_][a-z0-9_]*)\s*=/i);
    return target ? target[1] : null;
  });
}

/**
 * The template literals in one source text that UPDATE check_intake_items, with the
 * file, line, text, whether it interpolates (built at runtime) and the SET targets;
 * and any quoted ('...' or "...") string that does, which must be none.
 */
export function updateStatementsInText(text, rel) {
  const statements = [];
  const quoted = [];
  for (const m of text.matchAll(/`([^`]*)`/g)) {
    if (!UPDATE_RE.test(m[1])) continue;
    const line = text.slice(0, m.index).split('\n').length;
    const dynamic = m[1].includes('${');
    statements.push({ file: rel, line, sql: m[1], dynamic, targets: dynamic ? null : setTargets(m[1]) });
  }
  for (const m of text.matchAll(/'([^'\n]*)'|"([^"\n]*)"/g)) {
    if (UPDATE_RE.test(m[1] || m[2] || '')) quoted.push({ file: rel, line: text.slice(0, m.index).split('\n').length });
  }
  return { statements, quoted };
}

/** updateStatementsInText over every .mjs in aws/functions/api (main's bytes). */
export function apiUpdateStatements() {
  const statements = [];
  const quoted = [];
  for (const file of walk(API_DIR)) {
    const found = updateStatementsInText(fs.readFileSync(file, 'utf8'), path.relative(REPO_ROOT, file));
    statements.push(...found.statements);
    quoted.push(...found.quoted);
  }
  return { statements, quoted };
}

const SQL_DIRS = ['supabase/migrations', 'aws/write-path/sql', 'aws/rls/sql', 'aws/workflows/sql'];

/** Every CREATE FUNCTION in the repo's SQL whose body UPDATEs check_intake_items, with its SECURITY DEFINER flag. */
export function repoUpdateFunctions() {
  const out = [];
  for (const dir of SQL_DIRS) {
    const abs = path.join(REPO_ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs).filter((n) => n.endsWith('.sql')).sort()) {
      const text = fs.readFileSync(path.join(abs, name), 'utf8');
      const fnRe = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+((?:public\.)?"?[A-Za-z0-9_]+"?)\s*\(/gi;
      for (const m of text.matchAll(fnRe)) {
        const rest = text.slice(m.index + m[0].length);
        const as = rest.match(/AS\s+(\$[A-Za-z_]*\$)/i);
        if (!as) continue;
        const bodyStart = m.index + m[0].length + as.index + as[0].length;
        const bodyEnd = text.indexOf(as[1], bodyStart);
        if (bodyEnd < 0) continue;
        const body = text.slice(bodyStart, bodyEnd);
        if (!UPDATE_RE.test(body)) continue;
        const header = text.slice(m.index, m.index + m[0].length + as.index);
        const tail = text.slice(bodyEnd, text.indexOf(';', bodyEnd + as[1].length));
        out.push({
          file: `${dir}/${name}`,
          name: m[1].replace(/^public\./, '').replace(/"/g, '').toLowerCase(),
          security_definer: /SECURITY\s+DEFINER/i.test(header + tail),
        });
      }
    }
  }
  return out;
}

// --- PostgreSQL fixture -------------------------------------------------------

const TYPES = Object.freeze({
  amount: 'numeric(12,2)',
  check_stage: 'public.check_stage',
  pre_return_stage: 'public.check_stage',
  endorsement_override: 'jsonb',
  endorsement_render_meta: 'jsonb',
  endorsement_render_version: 'integer',
  expiration_days: 'integer',
  is_multi_payee: 'boolean',
  ocr_needs_verification: 'boolean',
  issue_date: 'date',
  mortgage_received_at: 'timestamptz',
  mortgage_sent_at: 'timestamptz',
  return_resolved_at: 'timestamptz',
  returned_at: 'timestamptz',
  reviewed_at: 'timestamptz',
  updated_at: 'timestamptz',
  return_recorded_by: 'uuid',
  reviewed_by: 'uuid',
});
// Columns SQL 89 must not grant: identity, ownership, money-movement and system columns.
export const NOT_GRANTED_COLUMNS = Object.freeze({
  id: 'uuid PRIMARY KEY DEFAULT gen_random_uuid()',
  tenant_id: 'uuid',
  created_at: 'timestamptz DEFAULT now()',
  uploaded_by: 'uuid',
  deposited_by_tenant_id: 'uuid',
  deposited_at: 'timestamptz',
  claim_id: 'uuid',
  detected_claim_number: 'text',
  payment_classification: 'text',
  freedom_claim_id: 'text',
  freedom_claim_number: 'text',
  partner_status: 'text',
  partner_status_label: 'text',
  partner_status_updated_at: 'timestamptz',
  raw_ocr_front: 'jsonb',
});

/** DDL of the fixture table (owner and grants are the caller's). */
export function checkIntakeTableSql(sql89Columns) {
  const cols = [
    ...Object.entries(NOT_GRANTED_COLUMNS).map(([name, type]) => `${name} ${type}`),
    ...sql89Columns.map((name) => `${name} ${TYPES[name] || 'text'}`),
  ];
  return `
    CREATE TYPE public.check_stage AS ENUM ('review', 'endorsing', 'ready_for_deposit', 'deposited', 'returned', 'loss_draft');
    CREATE TABLE public.check_intake_items (\n      ${cols.join(',\n      ')}\n    );`;
}

export const ALL_FIXTURE_COLUMNS = (sql89Columns) => [...Object.keys(NOT_GRANTED_COLUMNS), ...sql89Columns].sort();
