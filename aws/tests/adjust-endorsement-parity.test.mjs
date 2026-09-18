import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleWrite } from '../functions/api/write.mjs';
import { LOOKUP_MAPPING_SQL } from '../functions/api/identity.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..', '..');

test('frontend: Adjust Endorsement must not append cache-busters to presigned URLs', () => {
  const file = fs.readFileSync(path.join(repoRoot, 'src/pages/CheckCommandCenter.tsx'), 'utf8');
  assert.ok(!file.includes('&v='), 'found &v= cache-buster; breaks S3 presigned URLs');
  assert.ok(!/X-Amz-Signature/i.test(file), 'frontend must not manipulate AWS signature query params');
});

test('backend: check_intake_items endorsement JSONB binds as ::jsonb', async () => {
  const APP_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
  const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
  const CHECK_ID = '8d2b1c3e-4f5a-4678-9abc-def012345678';

  const event = {
    rawPath: '/data/write',
    headers: { authorization: 'Bearer test-id-token' },
    requestContext: {
      stage: 'staging',
      http: { method: 'POST', path: '/data/write' },
      authorizer: { jwt: { claims: { sub: COGNITO_SUB, token_use: 'id', email: 'checksops-tester@freedomadj.com' } } },
    },
    body: JSON.stringify({
      table: 'check_intake_items',
      op: 'update',
      values: {
        endorsement_override: { xPct: 0.1, yPct: 0.2, scale: 1, rotationDeg: 0, showPayToOrder: true },
        endorsement_render_status: 'position_saved',
        endorsement_render_meta: { request_id: 'req-1', width: 1920, height: 1080, bytes: 1234 },
      },
      filters: [{ column: 'id', op: 'eq', value: CHECK_ID }],
    }),
  };

  const queries = [];
  const client = {
    connect: async () => {},
    query: async (sql, params) => {
      queries.push({ sql: String(sql), params });
      if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT' || sql === 'SET TRANSACTION READ WRITE') return { rows: [] };
      if (sql.startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
      if (sql === LOOKUP_MAPPING_SQL) {
        return { rows: [{ application_user_id: APP_ID, cognito_sub: COGNITO_SUB, email: 'checksops-tester@freedomadj.com', status: 'active' }] };
      }
      if (/SELECT id, tenant_id FROM public.check_intake_items/.test(sql)) {
        return { rows: [{ id: CHECK_ID, tenant_id: '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a' }] };
      }
      if (/UPDATE public.check_intake_items/.test(sql)) {
        return { rows: [{ id: CHECK_ID, endorsement_override: { xPct: 0.1 } }] };
      }
      return { rows: [] };
    },
    end: async () => {},
  };

  const deps = {
    forceEnabled: true,
    loadDatabaseCredentials: async () => ({
      username: 'checksops',
      password: 'unit-test-only-not-a-real-secret',
      host: 'db.example.internal',
      database: 'checksops',
    }),
    createClient: () => client,
  };

  const result = await handleWrite(event, deps);
  assert.equal(result.statusCode, 200);
  const update = queries.find((q) => q.sql.includes('UPDATE public.check_intake_items'));
  assert.ok(update);
  assert.match(update.sql, /endorsement_override\s*=\s*\$\d+::jsonb/);
  assert.match(update.sql, /endorsement_render_meta\s*=\s*\$\d+::jsonb/);
});

