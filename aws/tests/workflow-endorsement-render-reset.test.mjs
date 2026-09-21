import assert from 'node:assert/strict';
import { test } from 'node:test';

import { handleWorkflowRequest } from '../functions/api/workflow.mjs';
import { LOOKUP_MAPPING_SQL } from '../functions/api/identity.mjs';

const APP_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const CHECK_ID = '8d2b1c3e-4f5a-4678-9abc-def012345678';

const jwtEvent = (path, method, body) => ({
  rawPath: path,
  headers: { authorization: 'Bearer test-id-token' },
  body: body ? JSON.stringify(body) : undefined,
  requestContext: {
    stage: 'staging',
    http: { method, path },
    authorizer: { jwt: { claims: { sub: COGNITO_SUB, email: 'mcarletta@freedomadj.com', token_use: 'id' } } },
  },
});

const mockClient = (state) => ({
  queries: [],
  connect: async () => {},
  query: async (sql, params) => {
    state.queries.push({ sql, params });
    if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT' || sql === 'SET TRANSACTION READ WRITE') return { rows: [] };
    if (String(sql).startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
    if (sql === LOOKUP_MAPPING_SQL) return { rows: [{ application_user_id: APP_ID, cognito_sub: COGNITO_SUB, email: 'mcarletta@freedomadj.com', status: 'active' }] };
    if (/FROM public\.tenant_users/.test(sql)) return { rows: [{ role: 'admin', tenant_id: TENANT }] };
    if (/FROM public\.check_intake_items/.test(sql) && String(sql).includes('SELECT id, tenant_id, check_number')) {
      return { rows: [state.before] };
    }
    if (/UPDATE public\.check_intake_items/.test(sql) && String(sql).includes('back_image_deposit_path = NULL')) {
      state.after = {
        ...state.before,
        back_image_deposit_path: null,
        endorsement_render_status: 'idle',
        endorsement_render_meta: null,
      };
      return { rows: [state.after] };
    }
    if (/INSERT INTO public\.check_audit_log/.test(sql)) return { rows: [{ id: 'audit' }] };
    return { rows: [] };
  },
  end: async () => {},
});

const depsFor = (client) => ({
  forceEnabled: true,
  forceWorkflow: true,
  createClient: () => client,
  loadDatabaseCredentials: async () => ({
    username: 'checksops',
    password: 'unit-test-only-not-a-real-secret',
    host: 'db.example.internal',
    database: 'checksops',
  }),
});

test('endorsement render reset is restricted to check_number 9562 and only clears deposit/render fields', async () => {
  const state = {
    queries: [],
    before: {
      id: CHECK_ID,
      tenant_id: TENANT,
      check_number: '9562',
      back_image_path: `checks/${CHECK_ID}/back.jpg`,
      back_image_original_path: `checks/${CHECK_ID}/back.jpg`,
      back_image_deposit_path: `checks/${CHECK_ID}/endorsed_deposit_x.checkalt.jpg`,
      endorsement_render_status: 'completed',
      endorsement_render_meta: { renderer: 1 },
    },
    after: null,
  };
  const client = mockClient(state);
  const event = jwtEvent('/workflow/endorsement-render-reset', 'POST', { checkId: CHECK_ID });
  const result = await handleWorkflowRequest(event, '/workflow/endorsement-render-reset', 'POST', depsFor(client));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.before.back_image_deposit_path.endsWith('.checkalt.jpg'), true);
  assert.equal(result.after.back_image_deposit_path, null);
  assert.equal(result.after.endorsement_render_status, 'idle');
  assert.equal(result.after.back_image_original_path, state.before.back_image_original_path);
  assert.equal(result.after.back_image_path, state.before.back_image_path);
});

test('endorsement render reset denies non-9562 checks', async () => {
  const state = {
    queries: [],
    before: {
      id: CHECK_ID,
      tenant_id: TENANT,
      check_number: '9999',
      back_image_path: `checks/${CHECK_ID}/back.jpg`,
      back_image_original_path: `checks/${CHECK_ID}/back.jpg`,
      back_image_deposit_path: null,
      endorsement_render_status: 'idle',
      endorsement_render_meta: null,
    },
  };
  const client = mockClient(state);
  const event = jwtEvent('/workflow/endorsement-render-reset', 'POST', { checkId: CHECK_ID });
  const result = await handleWorkflowRequest(event, '/workflow/endorsement-render-reset', 'POST', depsFor(client));
  assert.equal(result.statusCode, 403);
  assert.equal(result.error, 'reset_scope_denied');
});

