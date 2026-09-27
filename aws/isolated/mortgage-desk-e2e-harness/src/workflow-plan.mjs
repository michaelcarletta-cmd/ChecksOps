import { STAGING_API_URL } from './constants.mjs';

/**
 * Actual existing Mortgage Desk application handlers.
 * Future run_initial must HTTP-invoke these routes. Copied SQL is not the workflow.
 */
export const EXISTING_MORTGAGE_DESK_HANDLERS = {
  sendToMortgageDesk: {
    spa: 'src/components/loss-draft/SendToMortgageDeskButton.tsx insert into mortgage_handling_requests',
    http: { method: 'POST', path: '/data/write', url: `${STAGING_API_URL}/data/write` },
    router: 'aws/functions/api/index.mjs POST /data/write',
    handler: 'handleWrite',
    handlerFile: 'aws/functions/api/write.mjs',
    executor: 'executeMortgageRequests insert',
    executorFile: 'aws/functions/api/write-check-workflow.mjs',
    effect: 'INSERT mortgage_handling_requests status=requested. Does not insert check_billing_events.',
    fixtureAllowed: false,
    harnessMustInvokeExisting: true,
  },
  queue: {
    spa: 'src/pages/mortgage-ops/MortgageOpsQueue.tsx select mortgage_handling_requests',
    http: { method: 'POST', path: '/data/query', url: `${STAGING_API_URL}/data/query` },
    router: 'aws/functions/api/index.mjs POST /data/query',
    handler: 'handleDataQuery',
    handlerFile: 'aws/functions/api/data.mjs',
    executor: 'runSelect mortgage_handling_requests',
    effect: 'READ queue rows. No writes.',
    fixtureAllowed: false,
    harnessMustInvokeExisting: true,
  },
  accept: {
    spa: 'MortgageOpsQueue handleAccept supabase.rpc(accept_mortgage_handling_request)',
    http: { method: 'POST', path: '/data/rpc', url: `${STAGING_API_URL}/data/rpc` },
    body: { name: 'accept_mortgage_handling_request', args: { _request_id: '<request-id>' } },
    router: 'aws/functions/api/index.mjs POST /data/rpc → handleDataRpc → handleSafeWriteRpc',
    handler: 'executeAcceptMortgage',
    handlerFile: 'aws/functions/api/workflow-rpc.mjs',
    effect: 'UPDATE request to in_progress + accepted_at. Existing trigger tr_accrue_mortgage_ops_billing fires accrue_mortgage_ops_billing. Billing is not inserted by the harness.',
    fixtureAllowed: false,
    harnessMustInvokeExisting: true,
    requiresRole: ['mortgage_agent', 'admin'],
  },
  completeReturn: {
    spa: 'MortgageOpsQueue handleStatus supabase.rpc(update_mortgage_handling_request_status)',
    http: { method: 'POST', path: '/data/rpc', url: `${STAGING_API_URL}/data/rpc` },
    body: { name: 'update_mortgage_handling_request_status', args: { _request_id: '<request-id>', _status: 'completed', _notes: '<synthetic note>' } },
    router: 'aws/functions/api/index.mjs POST /data/rpc → handleDataRpc → handleSafeWriteRpc',
    handler: 'executeUpdateMortgageStatus',
    handlerFile: 'aws/functions/api/workflow-rpc.mjs',
    effect: 'UPDATE request status=completed / completed_at. This is the existing AWS return-to-tenant closeout. SPA also writes check_received_back_date, which is not on the AWS write allowlist; complete RPC is the existing application closeout path.',
    fixtureAllowed: false,
    harnessMustInvokeExisting: true,
    requiresRole: ['mortgage_agent', 'admin'],
  },
  billing: {
    origin: 'Database trigger tr_accrue_mortgage_ops_billing on mortgage_handling_requests AFTER INSERT OR UPDATE OF status, accepted_at',
    function: 'public.accrue_mortgage_ops_billing(uuid)',
    notOrigin: [
      'harness INSERT into check_billing_events',
      'copied accrue SQL inside the harness',
      'POST /functions/v1/bill-mortgage-handling (AWS stub is fail-closed and does not write usage events)',
    ],
  },
};

export const FUTURE_RUN_INITIAL_PLAN = {
  fixtureSqlCreateOnly: [
    'INSERT new claims row with unique SYNTHETIC-MDE2E-<runId> claim_number',
    'INSERT new check_intake_items row labeled SYNTHETIC / TEST / NOT NEGOTIABLE attached to that claim',
  ],
  existingApplicationInvokes: [
    'POST /data/write mortgage_handling_requests insert — Send to Mortgage Desk',
    'POST /data/query mortgage_handling_requests — queue visibility',
    'POST /data/rpc accept_mortgage_handling_request — existing agent Accept',
    'POST /data/rpc update_mortgage_handling_request_status completed — existing Complete/Return',
    'Replay the two RPC invokes against the same request id — idempotency',
  ],
  never: [
    'INSERT check_billing_events',
    'reimplement executeAcceptMortgage / executeUpdateMortgageStatus SQL in the harness and call that the existing workflow',
    'Moov / CheckAlt / ACH / deposit / Stripe',
    'UPDATE or DELETE pre-existing rows',
  ],
  auth: 'Caller-supplied staging Cognito tokens at invoke time. Freedom staff token for send/queue; mortgage_agent token for accept/complete. Tokens are not stored in the function environment.',
};

export const describeWorkflowPlan = () => ({
  usesCopiedSqlAsWorkflow: false,
  fixtureSqlAllowedFor: ['claims', 'check_intake_items'],
  transitionsUseExistingHandlers: true,
  handlers: EXISTING_MORTGAGE_DESK_HANDLERS,
  futureRunInitial: FUTURE_RUN_INITIAL_PLAN,
});
