#!/usr/bin/env node
/**
 * Read-only ninth UUID investigation via the DB bridge.
 * Never prints emails, names, or tokens. Never creates Cognito users.
 */
import { spawnSync } from 'node:child_process';
import { NINTH_ID } from '../../identity/expected-mappings.mjs';

const REGION = process.env.AWS_REGION || 'us-east-1';
const SECRET_ID = process.env.STORAGE_MIGRATION_SECRET_ID || 'checksops/staging/storage-migration-token';
const BRIDGE = 'https://nbcqwpysqgyxrrbgtmkw.supabase.co/functions/v1/aws-staging-db-bridge';
const ANON = process.env.SUPABASE_ANON_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5iY3F3cHlzcWd5eHJyYmd0bWt3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcxNDQ2NTgsImV4cCI6MjA5MjcyMDY1OH0.9GNh6OK6l6vSIBgkDY-bJuqNtfHJsLNW-dc7jfRUwgw';

const awsOut = spawnSync('aws', [
  'secretsmanager', 'get-secret-value',
  '--region', REGION,
  '--secret-id', SECRET_ID,
  '--query', 'SecretString',
  '--output', 'text',
], { encoding: 'utf8' });

if (awsOut.status !== 0) {
  console.log(JSON.stringify({ ok: false, skipped: true, reason: 'secretsmanager_unavailable' }, null, 2));
  process.exit(0);
}

let token = awsOut.stdout.trim();
try {
  const parsed = JSON.parse(token);
  token = parsed.token || parsed.migrationToken || token;
} catch { /* raw */ }

const bridge = async (payload) => {
  const response = await fetch(BRIDGE, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-checksops-migration-token': String(token).trim(),
      apikey: ANON,
      authorization: `Bearer ${ANON}`,
    },
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  return { http: response.status, body };
};

const scanTable = async (table, idFields) => {
  let after = null;
  let pages = 0;
  let scanned = 0;
  const hits = [];
  while (pages < 40) {
    const { http, body } = await bridge({
      action: 'rows',
      table,
      keysOnly: true,
      limit: 500,
      ...(after ? { after } : {}),
    });
    if (http !== 200 || body.ok !== true) {
      return { ok: false, http, error: body.error || 'rows_failed', scanned, pages, hitCount: 0, hits: [] };
    }
    const rows = Array.isArray(body.rows) ? body.rows : [];
    scanned += rows.length;
    pages += 1;
    for (const row of rows) {
      for (const field of idFields) {
        if (String(row[field] || '') === NINTH_ID) {
          hits.push({
            role: row.role || null,
            cognitoSubPresent: Boolean(row.cognito_sub),
            emailPresent: Boolean(row.email),
            status: row.status || row.approval_status || null,
          });
        }
      }
    }
    if (!body.hasMore) break;
    after = body.nextAfter;
    if (after == null) break;
  }
  return { ok: true, scanned, pages, hitCount: hits.length, hits };
};

const health = await bridge({ action: 'health' });
const identity = await bridge({ action: 'identity_map' });
const profiles = Array.isArray(identity.body.profiles) ? identity.body.profiles : [];
const ninthInProfiles = profiles.some((row) => String(row.id || row.application_user_id || '') === NINTH_ID);

const [userRoles, tenantUsers, identityAccounts, profileRows] = await Promise.all([
  scanTable('user_roles', ['user_id']),
  scanTable('tenant_users', ['user_id']),
  scanTable('identity_accounts', ['application_user_id', 'user_id', 'id']),
  scanTable('profiles', ['id']),
]);

const hasProfile = profileRows.hitCount > 0 || ninthInProfiles;
const hasTenant = tenantUsers.hitCount > 0;
const hasRoles = userRoles.hitCount > 0;
const classification = !hasProfile && !hasTenant && hasRoles
  ? 'orphan_unlinked'
  : (hasProfile || hasTenant)
    ? 'possible_production_user'
    : 'not_found';

const report = {
  ok: health.http === 200 && health.body.mode === 'read_only',
  applicationUserId: NINTH_ID,
  classification,
  cognitoInvite: false,
  productionAuthSwitch: false,
  bridge: {
    http: health.http,
    mode: health.body.mode || null,
    writes: health.body.writes,
    rawSql: health.body.rawSql,
  },
  identityMapCount: identity.body.count ?? null,
  ninthInIdentityMapProfiles: ninthInProfiles,
  tables: {
    profiles: { hit: hasProfile, scanned: profileRows.scanned },
    tenant_users: { hit: hasTenant, scanned: tenantUsers.scanned },
    user_roles: {
      hit: hasRoles,
      scanned: userRoles.scanned,
      roles: [...new Set((userRoles.hits || []).map((h) => h.role).filter(Boolean))],
    },
    identity_accounts: {
      hit: identityAccounts.hitCount > 0,
      scanned: identityAccounts.scanned,
      cognitoSubPresent: (identityAccounts.hits || []).some((h) => h.cognitoSubPresent),
      emailPresent: (identityAccounts.hits || []).some((h) => h.emailPresent),
    },
  },
};

console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
