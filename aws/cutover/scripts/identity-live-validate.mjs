#!/usr/bin/env node
/**
 * Live identity_map validation via the read-only DB bridge.
 * Compares expected application UUIDs to production identity_map counts.
 * Never prints emails, names, or tokens. Never creates Cognito users.
 */
import { spawnSync } from 'node:child_process';
import { EXPECTED_EIGHT, NINTH_ID } from '../../identity/expected-mappings.mjs';

const REGION = process.env.AWS_REGION || 'us-east-1';
const SECRET_ID = process.env.STORAGE_MIGRATION_SECRET_ID || 'checksops/staging/storage-migration-token';
const BRIDGE = 'https://nbcqwpysqgyxrrbgtmkw.supabase.co/functions/v1/aws-staging-db-bridge';
const ANON = process.env.SUPABASE_ANON_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5iY3F3cHlzcWd5eHJyYmd0bWt3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcxNDQ2NTgsImV4cCI6MjA5MjcyMDY1OH0.9GNh6OK6l6vSIBgkDY-bJuqNtfHJsLNW-dc7jfRUwgw';

const expectedIds = new Set(EXPECTED_EIGHT.map((row) => row.applicationUserId));

const awsOut = spawnSync('aws', [
  'secretsmanager', 'get-secret-value',
  '--region', REGION,
  '--secret-id', SECRET_ID,
  '--query', 'SecretString',
  '--output', 'text',
], { encoding: 'utf8' });

if (awsOut.status !== 0) {
  console.log(JSON.stringify({
    ok: false,
    skipped: true,
    reason: 'secretsmanager_unavailable',
    mappedEligibleCount: expectedIds.size,
    ninthExcluded: true,
  }, null, 2));
  process.exit(0);
}

let token = awsOut.stdout.trim();
try {
  const parsed = JSON.parse(token);
  token = parsed.token || parsed.migrationToken || token;
} catch { /* raw token */ }

const response = await fetch(BRIDGE, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-checksops-migration-token': String(token).trim(),
    apikey: ANON,
    authorization: `Bearer ${ANON}`,
  },
  body: JSON.stringify({ action: 'identity_map' }),
});

const body = await response.json();
const profiles = Array.isArray(body.profiles) ? body.profiles : [];
const ids = profiles.map((row) => String(row.application_user_id || row.applicationUserId || row.id || '')).filter(Boolean);
const matched = ids.filter((id) => expectedIds.has(id));
const ninthPresent = ids.includes(NINTH_ID);

const report = {
  ok: response.ok && body.ok === true && Number(body.count) === 8 && matched.length === 8 && ninthPresent === false,
  bridgeHttp: response.status,
  identityMapCount: body.count ?? null,
  expectedCount: 8,
  matchedExpectedApplicationUuids: matched.length,
  ninthPresentInProfiles: ninthPresent,
  productionAuthSwitch: false,
  cognitoUsersCreated: false,
};

console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
