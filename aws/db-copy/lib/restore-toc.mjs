/**
 * Filter a pg_restore TOC list the same way the Sept. 1 first copy did.
 * Skip policies, ACLs, excluded schemas, supabase admin owners, and auth.users FKs.
 */
import { EXCLUDED_SCHEMAS } from './catalog.mjs';

const SKIP_OWNERS = [
  'supabase_auth_admin',
  'supabase_storage_admin',
  'supabase_realtime_admin',
  'supabase_admin',
];

const SKIP_SCHEMA_RE = new RegExp(`\\s(?:${EXCLUDED_SCHEMAS.join('|')})\\s`);

export const shouldSkipRestoreTocLine = (line, authFkConstraints = new Set()) => {
  const text = String(line || '');
  if (!text.trim() || text.startsWith(';')) return false;
  const upper = text.toUpperCase();
  if (/\bPOLICY\b/.test(upper) || /ROW SECURITY/.test(upper)) return true;
  if (/\bACL\b/.test(upper)) return true;
  if (/\bEXTENSION\b/.test(upper)) return true;
  if (/TABLE ATTACH/.test(upper)) return true;
  if (SKIP_OWNERS.some((owner) => text.includes(owner))) return true;
  if (SKIP_SCHEMA_RE.test(text) && !/\spublic\s/.test(text)) return true;
  if (/FK CONSTRAINT/i.test(text)) {
    const name = text.split(/\s+/).filter(Boolean).at(-2);
    if (name && authFkConstraints.has(name)) return true;
    if (/\sauth\s/.test(text) || /auth\.users/i.test(text)) return true;
  }
  return false;
};

export const filterRestoreToc = (tocText, authFkConstraints = new Set()) => {
  const kept = [];
  const skipped = [];
  for (const line of String(tocText || '').split('\n')) {
    if (shouldSkipRestoreTocLine(line, authFkConstraints)) skipped.push(line);
    else kept.push(line);
  }
  return {
    kept: kept.join('\n'),
    skippedCount: skipped.length,
    keptCount: kept.filter((line) => line.trim() && !line.startsWith(';')).length,
  };
};
