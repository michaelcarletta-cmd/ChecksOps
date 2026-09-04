import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SAFE_LOSS_DRAFT_ACTIONS,
  SAFE_WRITE_RPC_CLASSIFICATION,
  SAFE_WRITE_RPCS,
  executeSafeWriteRpc,
  handleSafeWriteRpc,
} from '../functions/api/workflow-rpc.mjs';
import { WRITE_ALLOWLIST } from '../functions/api/write-allowlist.mjs';
import { LOOKUP_MAPPING_SQL, USER_ROLES_SQL } from '../functions/api/identity.mjs';

const APP_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const DRAFT_ID = '22222222-2222-4222-8222-222222222222';
const CHECK_ID = '33333333-3333-4333-8333-333333333333';
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';

test('classifies all audit rpc_disabled names', () => {
  const expected = [
    'accept_mortgage_handling_request',
    'add_partner_stakeholder_to_check',
    'admin_delete_check',
    'admin_override_check_status',
    'admin_set_contractor_pro',
    'apply_referral_code',
    'assign_deposit_owner',
    'backfill_check_billing_events',
    'bulk_deposit_closeout',
    'bulk_resolve_deposit_exceptions',
    'bulk_sync_deposit_accounting',
    'decide_stakeholder_limit_request',
    'deposit_action',
    'ensure_partner_stakeholders',
    'generate_deposit_daily_digest',
    'generate_next_deposit_action',
    'get_or_create_notification_preferences',
    'get_payment_direction_by_token',
    'get_tenant_users_with_profiles',
    'init_loss_draft_documents',
    'invalidate_session',
    'is_approval_required',
    'log_audit',
    'loss_draft_action',
    'loss_draft_set_lender',
    'mark_deposit_closeout',
    'rebalance_deposit_workload',
    'record_check_return',
    'refresh_all_deposit_next_actions',
    'register_session',
    'resolve_check_case',
    'resolve_check_return',
    'resolve_deposit_exception',
    'review_manager_approval',
    'run_deposit_escalation_check',
    'save_deposit_manager_snapshot',
    'submit_check_review_decision_safe',
    'submit_homeowner_intro_request',
    'submit_manager_approval',
    'submit_payment_direction_by_token',
    'update_mortgage_handling_request_status',
    'validate_session',
  ];
  for (const name of expected) {
    assert.ok(SAFE_WRITE_RPC_CLASSIFICATION[name], `missing classification for ${name}`);
  }
  assert.equal(SAFE_WRITE_RPCS.has('deposit_action'), false);
  assert.equal(SAFE_WRITE_RPCS.has('accept_mortgage_handling_request'), true);
  assert.ok(SAFE_LOSS_DRAFT_ACTIONS.has('mark_sent'));
  assert.equal(SAFE_LOSS_DRAFT_ACTIONS.has('mark_escrowed'), false);
});

test('write allowlist gained non-financial workflow tables', () => {
  for (const table of [
    'audit_logs',
    'user_sessions',
    'homeowner_intro_requests',
    'check_cases',
    'contractor_profiles',
  ]) {
    assert.ok(WRITE_ALLOWLIST[table], table);
  }
  assert.ok(!WRITE_ALLOWLIST.homeowner_intro_requests.columns.has('contractor_notes'));
  assert.ok(WRITE_ALLOWLIST.contractor_profiles.clientIgnored.has('moov_account_id'));
});

const mockClient = ({ roles = [{ role: 'mortgage_agent' }], mortgageRow = null, draft = null } = {}) => {
  const queries = [];
  return {
    queries,
    connect: async () => {},
    end: async () => {},
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT' || sql === 'SET TRANSACTION READ WRITE') {
        return { rows: [] };
      }
      if (sql.startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
      if (sql === LOOKUP_MAPPING_SQL) {
        return {
          rows: [{
            application_user_id: APP_ID,
            cognito_sub: COGNITO_SUB,
            email: 'checksops-tester@freedomadj.com',
            status: 'active',
          }],
        };
      }
      if (sql === USER_ROLES_SQL) return { rows: roles };
      if (/UPDATE public.mortgage_handling_requests/.test(sql) && /assigned_employee_id/.test(sql)) {
        return {
          rows: mortgageRow || [{
            id: REQUEST_ID,
            status: 'in_progress',
            assigned_employee_id: APP_ID,
          }],
        };
      }
      if (/UPDATE public.mortgage_handling_requests/.test(sql) && /completed_at/.test(sql)) {
        return {
          rows: [{
            id: REQUEST_ID,
            status: params[1],
            assigned_employee_id: APP_ID,
            work_notes: params[2],
          }],
        };
      }
      if (/FROM public.loss_draft_tracking/.test(sql) && /FOR UPDATE/.test(sql)) {
        return {
          rows: draft || [{
            id: DRAFT_ID,
            check_intake_item_id: CHECK_ID,
            escrow_status: 'pending_send',
            monitoring_type: 'not_monitored',
          }],
        };
      }
      if (/UPDATE public.loss_draft_tracking/.test(sql)) return { rows: [{ id: DRAFT_ID, escrow_status: 'sent_to_lender' }] };
      if (/INSERT INTO public.loss_draft_audit_log/.test(sql)) return { rows: [{ id: 'audit' }] };
      if (/SELECT escrow_status, monitoring_type/.test(sql)) {
        return { rows: [{ escrow_status: 'sent_to_lender', monitoring_type: 'not_monitored' }] };
      }
      if (/INSERT INTO public.audit_logs/.test(sql)) return { rows: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }] };
      if (/INSERT INTO public.user_sessions/.test(sql)) return { rows: [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }] };
      if (/UPDATE public.user_sessions SET is_active = false/.test(sql) && /session_token/.test(sql)) {
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE public.user_sessions SET is_active = false/.test(sql)) return { rows: [], rowCount: 1 };
      if (/FROM public.role_version_tracker/.test(sql)) return { rows: [{ version: 1 }] };
      if (/FROM public.user_sessions/.test(sql) && /session_token/.test(sql)) {
        return {
          rows: [{
            id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            user_id: APP_ID,
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
            last_activity_at: new Date().toISOString(),
            is_active: true,
          }],
        };
      }
      if (/UPDATE public.user_sessions SET last_activity_at/.test(sql)) return { rows: [] };
      return { rows: [] };
    },
  };
};

const jwtEvent = (body) => ({
  rawPath: '/data/rpc',
  headers: { authorization: 'Bearer test-id-token' },
  body: JSON.stringify(body),
  requestContext: {
    stage: 'staging',
    http: { method: 'POST', path: '/data/rpc' },
    authorizer: {
      jwt: { claims: { sub: COGNITO_SUB, email: 'checksops-tester@freedomadj.com', token_use: 'id' } },
    },
  },
});

test('accept_mortgage_handling_request assigns caller', async () => {
  const client = mockClient();
  const result = await executeSafeWriteRpc({
    client,
    mapping: { application_user_id: APP_ID },
    name: 'accept_mortgage_handling_request',
    args: { _request_id: REQUEST_ID },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.data.status, 'in_progress');
  assert.equal(result.data.assigned_employee_id, APP_ID);
});

test('loss_draft_action blocks financial amount actions', async () => {
  const client = mockClient();
  const result = await executeSafeWriteRpc({
    client,
    mapping: { application_user_id: APP_ID },
    name: 'loss_draft_action',
    args: {
      p_loss_draft_id: DRAFT_ID,
      p_action: 'mark_escrowed',
      p_amount: 1000,
    },
  });
  assert.equal(result.error, 'rpc_financial_disabled');
});

test('loss_draft_action mark_sent updates tracking metadata', async () => {
  process.env.AWS_APPLICATION_WORKFLOW_WRITES_ENABLED = 'true';
  process.env.AWS_WRITES_ENABLED = 'true';
  const client = mockClient();
  const result = await handleSafeWriteRpc(
    jwtEvent({
      name: 'loss_draft_action',
      args: {
        p_loss_draft_id: DRAFT_ID,
        p_action: 'mark_sent',
        p_extra: { tracking_number: '1Z999' },
      },
    }),
    {
      loadDatabaseCredentials: async () => ({ host: 'x', username: 'checksops', password: 'x', database: 'checksops' }),
      createClient: () => client,
      forceEnabled: true,
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.providerExecution, false);
  assert.ok(client.queries.some((q) => /escrow_status = 'sent_to_lender'/.test(q.sql)));
});

test('log_audit inserts with server-derived user_id', async () => {
  const client = mockClient();
  const result = await executeSafeWriteRpc({
    client,
    mapping: { application_user_id: APP_ID },
    name: 'log_audit',
    args: { p_action: 'reveal_pii', p_record_type: 'check', p_record_id: CHECK_ID },
  });
  assert.equal(result.data, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  const insert = client.queries.find((q) => /INSERT INTO public.audit_logs/.test(q.sql));
  assert.equal(insert.params[0], APP_ID);
});

test('deposit_action remains classified financial_sensitive', () => {
  assert.equal(SAFE_WRITE_RPC_CLASSIFICATION.deposit_action, 'financial_sensitive');
  assert.equal(SAFE_WRITE_RPC_CLASSIFICATION.add_partner_stakeholder_to_check, 'provider_dependent');
  assert.equal(SAFE_WRITE_RPC_CLASSIFICATION.get_tenant_users_with_profiles, 'read_only');
});
