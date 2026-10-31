/**
 * The identity tables as SQL 137 (aws/workflows/sql/137_platform_owner_identity.sql) finds them, for
 * the release PostgreSQL 16 fixture (helpers/release-sql-pg.mjs, which already has
 * public.identity_accounts, public.profiles, the real aws/rls/sql/10 is_platform_owner() and
 * aws/rls/sql/15's EXECUTE grants, and the platform owner's identity and profile rows). Run as the
 * superuser before ownership passes to checksops_admin.
 *
 *   'staging'    aws/identity/sql/01's unique lower(email) index and aws/identity/sql/07's
 *                staging-only GRANT SELECT, INSERT, UPDATE ON identity_accounts TO checksops
 *   'production' the index and aws/identity/sql/03's SELECT only (the fixture's SELECT for
 *                checksops and authenticated)
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './release-sql-pg.mjs';

export const TABLE = 'public.identity_accounts';
export const FUNCTION = 'public.is_platform_owner()';
export const OWNER_MAILBOX = 'checksopsadmin@gmail.com';
export const SQL10_FILE = path.join(REPO_ROOT, 'aws/rls/sql/10_owner_helpers_from_identity.sql');

/** aws/identity/sql/01's unique index, exactly as the file has it. */
export function emailIndexStatement() {
  const text = fs.readFileSync(path.join(REPO_ROOT, 'aws/identity/sql/01_identity_accounts.sql'), 'utf8');
  const match = /CREATE UNIQUE INDEX IF NOT EXISTS identity_accounts_email_lower_key\s+ON public\.identity_accounts \(lower\(email\)\)\s+WHERE email IS NOT NULL;/.exec(text);
  if (!match) throw new Error('aws/identity/sql/01 index layout changed');
  return match[0];
}

/** aws/identity/sql/07's identity_accounts grant, exactly as the file has it. */
export function stagingIdentityGrant() {
  const text = fs.readFileSync(path.join(REPO_ROOT, 'aws/identity/sql/07_hire_mortgage_agent_grants.sql'), 'utf8');
  const line = 'GRANT SELECT, INSERT, UPDATE ON TABLE public.identity_accounts TO checksops;';
  if (!text.includes(line)) throw new Error('aws/identity/sql/07 grant layout changed');
  return line;
}

export function identitySchema(mode) {
  if (!['staging', 'production'].includes(mode)) throw new Error(`unknown mode ${mode}`);
  return [emailIndexStatement(), ...(mode === 'staging' ? [stagingIdentityGrant()] : [])].join('\n');
}
