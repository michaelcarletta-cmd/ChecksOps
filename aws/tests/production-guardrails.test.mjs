import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  PRODUCTION_COGNITO_LOCKS,
  PRODUCTION_LOCKED_IDS,
  refusesStagingOverwrite,
  assertOneshotCognitoWriteAllowed,
  assertProductionCognitoWriteAllowed,
  PRODUCTION_COGNITO_POOL_ID,
  PRODUCTION_COGNITO_CLIENT_ID,
} from '../identity/production-cognito-locks.mjs';
import { applyLinks } from '../identity/oneshot/onboard.mjs';
import { runHireMortgageAgent, runTenantInviteUser } from '../functions/api/tenant-admin.mjs';
import { scanProductionSpaArtifact } from '../../scripts/validate-production-spa-artifact.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const STAGING_SUB = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const LOCKED = PRODUCTION_COGNITO_LOCKS[0];

test('locks exactly the 8 repaired production Cognito mappings', () => {
  assert.equal(PRODUCTION_COGNITO_LOCKS.length, 8);
  assert.deepEqual(PRODUCTION_COGNITO_LOCKS.map((row) => row.application_user_id).sort(), [
    '0160a5f3-30a4-4aba-8e54-6529f1ceb0d4',
    '30d0505c-bcfa-4732-81fd-869dc46da5dd',
    '3af0234c-de1b-4819-938d-fa4f9390811b',
    '7dbb3009-f059-4767-b5dc-1c5c72379330',
    'abd3c2a0-6dc0-4680-92dd-a013e1141c91',
    'b100f05d-9e81-4a7b-b9cc-9baf173131d9',
    'e2ad0849-c6b6-4f4a-a68a-8c52f563c6fd',
    'fd857564-9534-4b0f-95ac-624ed1273725',
  ]);
  assert.equal(
    PRODUCTION_COGNITO_LOCKS.find((row) => row.application_user_id === '3af0234c-de1b-4819-938d-fa4f9390811b').cognito_sub,
    '24d874d8-80d1-7092-7f34-48b8704702f8',
  );
});

test('a staging Cognito sub cannot replace an existing production Cognito sub', () => {
  assert.equal(refusesStagingOverwrite({
    applicationUserId: LOCKED.application_user_id,
    cognitoSub: STAGING_SUB,
  }), true);
  assert.equal(refusesStagingOverwrite({
    applicationUserId: LOCKED.application_user_id,
    cognitoSub: LOCKED.cognito_sub,
  }), false);
  assert.equal(refusesStagingOverwrite({
    applicationUserId: '11111111-1111-4111-8111-111111111111',
    cognitoSub: STAGING_SUB,
  }), false);
  assert.equal(refusesStagingOverwrite({
    applicationUserId: '11111111-1111-4111-8111-111111111111',
    cognitoSub: LOCKED.cognito_sub,
  }), true);
  assert.throws(
    () => assertOneshotCognitoWriteAllowed(LOCKED.application_user_id),
    /production_cognito_mapping_locked/,
  );
  assert.throws(
    () => assertProductionCognitoWriteAllowed({
      applicationUserId: LOCKED.application_user_id,
      cognitoSub: STAGING_SUB,
      env: 'staging',
    }),
    /production_cognito_mapping_locked/,
  );
  assert.throws(
    () => assertProductionCognitoWriteAllowed({
      applicationUserId: LOCKED.application_user_id,
      cognitoSub: LOCKED.cognito_sub,
      env: 'staging',
    }),
    /production_cognito_mapping_locked/,
  );
  assert.doesNotThrow(() => assertProductionCognitoWriteAllowed({
    applicationUserId: LOCKED.application_user_id,
    cognitoSub: LOCKED.cognito_sub,
    env: 'production-prep',
  }));
});

test('applyLinks fail-closes before writing a locked production mapping', async () => {
  let queried = false;
  const client = {
    query: async () => {
      queried = true;
      throw new Error('identity_accounts write must not run for locked rows');
    },
  };
  const links = PRODUCTION_COGNITO_LOCKS.map((row, idx) => ({
    applicationUserId: row.application_user_id,
    cognitoSub: `00000000-0000-4000-8000-00000000000${idx}`,
    email: `user${idx}@example.com`,
  }));
  const result = await applyLinks(client, links);
  assert.equal(result.applied, false);
  assert.match(result.error, /production_cognito_mapping_locked/);
  assert.equal(queried, false);
});

test('tenant-admin invite and hire refuse staging overwrite of a locked mapping', async () => {
  const prev = process.env.CHECKSOPS_ENV;
  process.env.CHECKSOPS_ENV = 'staging';
  const sqlClient = {
    query: async (sql) => {
      if (String(sql).includes('FROM public.tenant_users') && String(sql).includes('SELECT role')) {
        return { rows: [{ role: 'admin' }] };
      }
      if (String(sql).includes('FROM public.tenants')) {
        return { rows: [{ id: '11111111-1111-4111-8111-111111111111', name: 'Acme', custom_domain: null }] };
      }
      if (String(sql).includes('FROM public.profiles')) {
        return { rows: [{ id: LOCKED.application_user_id }] };
      }
      if (String(sql).includes('is_master_owner')) {
        return { rows: [{ is_master: true }] };
      }
      if (String(sql).includes("role = 'admin'")) {
        return { rows: [{ role: 'admin' }] };
      }
      if (String(sql).includes('FROM public.user_roles')) {
        return { rows: [] };
      }
      if (String(sql).includes('INSERT INTO public.identity_accounts')) {
        throw new Error('identity_accounts write must not run for locked rows');
      }
      return { rows: [] };
    },
  };
  try {
    const invite = await runTenantInviteUser({
      mapping: { application_user_id: '55555555-5555-4555-8555-555555555555' },
      spoof: { ignored: true },
      send: async () => ({ deliveredCount: 0, sunkCount: 1, mode: 'sink', results: [] }),
      body: {
        tenant_id: '11111111-1111-4111-8111-111111111111',
        email: 'member@example.com',
        role: 'member',
      },
      cognitoJson: async () => ({
        User: { Username: 'cog', Attributes: [{ Name: 'sub', Value: STAGING_SUB }] },
      }),
      client: sqlClient,
    });
    assert.equal(invite.ok, false);
    assert.equal(invite.error, 'production_cognito_mapping_locked');

    const hire = await runHireMortgageAgent({
      mapping: { application_user_id: '55555555-5555-4555-8555-555555555555' },
      spoof: { ignored: true },
      send: async () => ({ deliveredCount: 0, sunkCount: 1, mode: 'sink', results: [] }),
      body: { email: 'agent@example.com', full_name: 'Mo Agent' },
      cognitoJson: async () => ({
        User: { Username: 'cog', Attributes: [{ Name: 'sub', Value: STAGING_SUB }] },
      }),
      client: sqlClient,
    });
    assert.equal(hire.ok, false);
    assert.equal(hire.error, 'production_cognito_mapping_locked');
  } finally {
    if (prev == null) delete process.env.CHECKSOPS_ENV;
    else process.env.CHECKSOPS_ENV = prev;
  }
});

test('SQL 11 locks the 8 rows and requires the production identity write GUC', () => {
  const sql = read('aws/identity/sql/11_protect_production_cognito.sql');
  assert.match(sql, /identity_production_cognito_locks/);
  assert.match(sql, /identity_protect_production_cognito/);
  assert.match(sql, /request\.production_identity_write/);
  assert.match(sql, /production_cognito_mapping_locked/);
  assert.match(sql, /24d874d8-80d1-7092-7f34-48b8704702f8/);
  for (const id of PRODUCTION_LOCKED_IDS) {
    assert.match(sql, new RegExp(id));
  }
  const clear = read('aws/identity/sql/09_clear_isolated_test.sql');
  assert.match(clear, /NOT IN/);
  assert.match(clear, /abd3c2a0-6dc0-4680-92dd-a013e1141c91/);
});

test('known cognito_sub writers are inventoried and guarded', () => {
  const inventory = read('aws/identity/COGNITO_SUB_WRITERS.md');
  assert.match(inventory, /applyLinks/);
  assert.match(inventory, /runTenantInviteUser/);
  assert.match(inventory, /runHireMortgageAgent/);
  assert.match(inventory, /09_clear_isolated_test/);
  const writers = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(mjs|js|sql)$/.test(entry.name)) writers.push(full);
    }
  };
  walk(path.join(ROOT, 'aws'));
  const unexpected = [];
  for (const file of writers) {
    const rel = path.relative(ROOT, file);
    const text = fs.readFileSync(file, 'utf8');
    if (!/identity_accounts/.test(text)) continue;
    if (!/(SET\s+cognito_sub|INSERT INTO public\.identity_accounts \([^\)]*cognito_sub)/i.test(text)) continue;
    if (
      rel === 'aws/identity/oneshot/onboard.mjs'
      || rel === 'aws/functions/api/tenant-admin.mjs'
      || rel === 'aws/identity/sql/09_clear_isolated_test.sql'
      || rel === 'aws/identity/sql/11_protect_production_cognito.sql'
      || rel === 'aws/tests/production-guardrails.test.mjs'
    ) continue;
    unexpected.push(rel);
  }
  assert.deepEqual(unexpected, []);
});

test('compiled Supabase-mode artifact fails; Cognito /prep artifact passes', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spa-guard-'));
  const supabaseDir = path.join(tmp, 'supabase');
  const cognitoDir = path.join(tmp, 'cognito');
  fs.mkdirSync(supabaseDir);
  fs.mkdirSync(cognitoDir);
  fs.writeFileSync(path.join(supabaseDir, 'index.html'), '<html>supabase</html>');
  fs.writeFileSync(path.join(supabaseDir, 'app.js'), 'https://nbcqwpysqgyxrrbgtmkw.supabase.co\nVITE_AUTH_PROVIDER=supabase\n');
  const supabase = scanProductionSpaArtifact(supabaseDir);
  assert.equal(supabase.ok, false);
  assert.ok(supabase.missing.includes('production_cognito_pool'));
  assert.ok(supabase.forbidden.includes('supabase_host'));

  fs.writeFileSync(path.join(cognitoDir, 'index.html'), '<html>cognito</html>');
  fs.writeFileSync(
    path.join(cognitoDir, 'app.js'),
    `const auth="cognito"; const pool="${PRODUCTION_COGNITO_POOL_ID}"; const client="${PRODUCTION_COGNITO_CLIENT_ID}"; const api="/prep";`,
  );
  const cognito = scanProductionSpaArtifact(cognitoDir);
  assert.equal(cognito.ok, true);
  assert.equal(cognito.userPoolId, PRODUCTION_COGNITO_POOL_ID);
  assert.equal(cognito.apiTarget, '/prep');

  fs.writeFileSync(
    path.join(cognitoDir, 'bad.js'),
    'us-east-1_vPmQ7cL1F psr19uhop4',
  );
  const stagingLeak = scanProductionSpaArtifact(cognitoDir);
  assert.equal(stagingLeak.ok, false);
  assert.ok(stagingLeak.forbidden.includes('staging_cognito_pool'));
  assert.ok(stagingLeak.forbidden.includes('staging_api'));
});

test('production-aws vite config fingerprints Cognito pool and client in the compiled HTML', () => {
  const vite = read('vite.config.ts');
  assert.match(vite, /mode === "production-aws"/);
  assert.match(vite, /checksops-cognito-artifact-fingerprint/);
  assert.match(vite, /checksops-cognito-pool/);
  assert.match(vite, /VITE_COGNITO_USER_POOL_ID/);
  const client = read('src/integrations/aws/client.ts');
  assert.match(client, /AWS_STAGING_PUBLIC_CONFIG/);
  assert.match(client, /cognitoPublicConfig/);
});

test('deploy-production-spa --apply is locked after cutover and still guards the artifact before any upload', () => {
  const source = read('scripts/deploy-production-spa.mjs');
  const lock = read('aws/cutover/PRODUCTION_SPA_LOCK.json');
  assert.match(source, /--mode', 'production-aws'/);
  assert.match(source, /scanProductionSpaArtifact/);
  assert.match(source, /assertProductionSpaApplyAllowed/);
  assert.match(lock, /checksops-production-frontend-806168576068/);
  assert.match(lock, /E1B0ZWWO5559U5/);
  assert.match(source, /PRODUCTION_SPA_LOCK\.knownGood\.s3Bucket/);
  assert.match(source, /PRODUCTION_SPA_LOCK\.knownGood\.cloudfrontDistributionId/);
  assert.match(source, /s3',\s*'sync'/);
  assert.match(source, /--delete/);
  assert.match(source, /create-invalidation/);
  assert.match(source, /production_spa_cutover_locked|assertProductionSpaApplyAllowed/);
  assert.ok(
    source.indexOf('assertProductionSpaApplyAllowed') < source.indexOf("s3',\n    'sync'")
      || source.indexOf('if (APPLY)') < source.indexOf("s3'"),
    'cutover lock must run before S3 upload',
  );
  assert.ok(
    source.indexOf('scanProductionSpaArtifact') < source.indexOf("s3',\n    'sync'")
      || source.indexOf('scanProductionSpaArtifact') < source.indexOf('s3 sync')
      || source.indexOf('if (!validation.ok)') < source.indexOf("s3'"),
    'artifact guard must run before S3 upload',
  );

  const hmac = read('aws/functions/api/providers/hmac.mjs');
  assert.match(hmac, /verifyMoovSignature/);
  const supabaseWebhook = read('supabase/functions/moov-webhook/index.ts');
  assert.match(supabaseWebhook, /moov-webhook/);
  const catalog = read('aws/functions/api/providers/catalog.mjs');
  assert.match(catalog, /POST \/webhooks\/moov/);
});
