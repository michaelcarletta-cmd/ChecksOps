import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  decideReadyTransition,
  evaluateEndorsementMath,
  isActiveLossDraft,
  isEndorsementSatisfied,
} from '../functions/api/endorsement-completion.mjs';
import {
  AUTH_ENDORSEMENT_ACTIONS,
  applyAutoAdvanceIfEligible,
  evaluateEndorsementCompletion,
  finalizeEndorsementState,
  runAuthenticatedEndorsement,
} from '../functions/api/check-endorsement.mjs';
import { mapReviewPath } from '../functions/api/workflow-transitions.mjs';
import { reviewVoidPersistedState } from '../../src/lib/reviewDecisionMapping.ts';
import {
  buildClaimLedgerSyncPlan,
  fundsReceivedForClaim,
} from '../../src/lib/claimLedgerSync.ts';
import { mortgageAgentCanReadCheckImages } from '../../src/lib/mortgageCheckImageAccess.ts';
import {
  homeownerBankLinkQueryKey,
  queriesInvalidatedAfterBankLinkSend,
} from '../../src/lib/homeownerBankLink.ts';

const CHECK_ID = '33333333-3333-4333-8333-333333333333';
const CLAIM_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CLAIM_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CHECK_2 = '44444444-4444-4444-8444-444444444444';

const mockClient = (impl) => ({
  query: async (sql, params = []) => impl(String(sql), params || []),
  connect: async () => {},
  end: async () => {},
});

const sqlClient = (handlers) => mockClient((sql, params) => {
  const compact = sql.replace(/\s+/g, ' ');
  if (/^BEGIN|COMMIT|ROLLBACK|SET TRANSACTION/i.test(compact.trim())) return { rows: [], rowCount: 0 };
  for (const handler of handlers) {
    if (handler.match(compact, params)) return handler.result(params, compact);
  }
  if (compact.includes('UPDATE public.check_payees')) {
    return { rows: [{ id: params[0], endorsement_status: params[1] || params[2] }], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
});

test('FIX1 A: loss draft + homeowner signed + mortgage manual_required stays loss draft', () => {
  const evaluation = evaluateEndorsementMath([
    { status: 'signed', payee_type: 'insured' },
    { status: 'manual_required', payee_type: 'mortgage_company' },
  ]);
  assert.equal(evaluation.allRequiredSatisfied, true);
  assert.equal(isEndorsementSatisfied({ status: 'manual_required', payee_type: 'mortgage_company' }), true);
  const decision = decideReadyTransition(
    { status: 'loss_draft_required', check_stage: 'loss_draft' },
    evaluation,
  );
  assert.equal(decision.action, 'hold_loss_draft');
  assert.equal(isActiveLossDraft({ status: 'loss_draft_required' }), true);
});

test('FIX1 B: loss draft + all non-mortgage endorsements complete stays loss draft', () => {
  const evaluation = evaluateEndorsementMath([
    { status: 'signed', payee_type: 'insured' },
    { status: 'waived', payee_type: 'public_adjuster' },
    { status: 'pending', payee_type: 'contractor' },
  ]);
  assert.equal(evaluation.allRequiredSatisfied, true);
  const decision = decideReadyTransition(
    { status: 'loss_draft_required', check_stage: 'loss_draft', deposit_recommendation: 'loss_draft_required' },
    evaluation,
  );
  assert.equal(decision.action, 'hold_loss_draft');
});

test('FIX1 C: after tenant leaves loss draft, satisfied endorsements may go Ready', () => {
  const evaluation = evaluateEndorsementMath([
    { status: 'signed', payee_type: 'insured' },
    { status: 'manual_required', payee_type: 'mortgage_company' },
  ]);
  const decision = decideReadyTransition(
    { status: 'endorsements_in_progress', check_stage: 'endorsing' },
    evaluation,
  );
  assert.equal(decision.action, 'ready');
});

test('FIX1 D: Mortgage Ops completion by itself does not release Ready', () => {
  const rpc = readFileSync('supabase/migrations/20260715122103_5e731951-bea3-49d4-a508-8bdff4edcafc.sql', 'utf8');
  assert.match(rpc, /update_mortgage_handling_request_status/);
  assert.equal(/UPDATE public\.check_intake_items/i.test(rpc), false);
  assert.equal(/approved_for_deposit|ready_for_deposit/.test(rpc), false);
  const stillHeld = decideReadyTransition(
    { status: 'loss_draft_required', check_stage: 'loss_draft' },
    { allRequiredSatisfied: true, anyRejected: false },
  );
  assert.equal(stillHeld.action, 'hold_loss_draft');
});

test('FIX3 contractor CC-only does not stall Ready math', () => {
  const evaluation = evaluateEndorsementMath([
    { status: 'signed', payee_type: 'insured' },
    { status: 'pending', payee_type: 'contractor' },
  ]);
  assert.equal(evaluation.allRequiredSatisfied, true);
  assert.equal(isEndorsementSatisfied({ status: 'pending', payee_type: 'contractor' }), true);
});

test('FIX3 completion is idempotent once already Ready', () => {
  const decision = decideReadyTransition(
    { status: 'approved_for_deposit', deposit_recommendation: 'ready_for_deposit', check_stage: 'ready_for_deposit' },
    { allRequiredSatisfied: true, anyRejected: false },
  );
  assert.equal(decision.action, 'already_ready');
});

test('FIX3 force-complete is an authenticated completion action', () => {
  assert.equal(AUTH_ENDORSEMENT_ACTIONS.has('force_complete_endorsements'), true);
});

test('FIX1 AWS auto-advance holds Ready while Loss Draft is active', async () => {
  const previous = process.env.AWS_ENDORSEMENT_AUTO_ADVANCE;
  process.env.AWS_ENDORSEMENT_AUTO_ADVANCE = 'true';
  const updates = [];
  const client = sqlClient([
    {
      match: (sql) => sql.includes('FROM public.check_intake_items'),
      result: () => ({
        rows: [{
          id: CHECK_ID,
          status: 'loss_draft_required',
          check_stage: 'loss_draft',
          deposit_recommendation: 'loss_draft_required',
        }],
      }),
    },
    {
      match: (sql) => sql.includes('UPDATE public.check_intake_items'),
      result: (_params, sql) => {
        updates.push(sql);
        return { rows: [], rowCount: 1 };
      },
    },
  ]);
  try {
    const result = await applyAutoAdvanceIfEligible(client, CHECK_ID, {
      allSigned: true,
      anyRejected: false,
    }, { officialRearReady: true });
    assert.equal(result.advance_check_on_endorsement_complete, 'held_loss_draft');
    assert.equal(result.newStatus, 'loss_draft_required');
    assert.equal(updates.some((sql) => /approved_for_deposit/.test(sql)), false);
  } finally {
    if (previous === undefined) delete process.env.AWS_ENDORSEMENT_AUTO_ADVANCE;
    else process.env.AWS_ENDORSEMENT_AUTO_ADVANCE = previous;
  }
});

test('FIX3 force-complete uses finalize path and never resets signed rows', async () => {
  const updates = [];
  const client = sqlClient([
    {
      match: (sql) => sql.includes('FROM public.check_intake_items'),
      result: () => ({ rows: [{ id: CHECK_ID, tenant_id: '11111111-1111-4111-8111-111111111111', status: 'endorsements_in_progress' }] }),
    },
    {
      match: (sql) => sql.includes('aws_can_write_tenant'),
      result: () => ({ rows: [{ ok: true }] }),
    },
    {
      match: (sql) => sql.includes('FROM public.check_endorsements WHERE check_id'),
      result: () => ({
        rows: [
          {
            id: 'e1',
            payee_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
            payee_name: 'Insured',
            check_id: CHECK_ID,
            status: 'signed',
            payee_type: 'insured',
            signature_image_url: 'data:image/png;base64,keep',
          },
          {
            id: 'e2',
            payee_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
            payee_name: 'PA',
            check_id: CHECK_ID,
            status: 'pending',
            payee_type: 'public_adjuster',
            signature_image_url: null,
          },
        ],
      }),
    },
    {
      match: (sql) => sql.includes("SET status = 'signed'"),
      result: (_params, sql) => {
        updates.push(sql);
        return { rows: [], rowCount: 1 };
      },
    },
    {
      match: (sql) => sql.includes('SELECT status, payee_type'),
      result: () => ({ rows: [{ status: 'signed', payee_type: 'insured' }] }),
    },
  ]);
  const result = await runAuthenticatedEndorsement({
    client,
    mapping: { application_user_id: '55555555-5555-4555-8555-555555555555' },
    body: { action: 'force_complete_endorsements', checkId: CHECK_ID },
    spoof: { ignored: true },
    event: { headers: {} },
  });
  assert.equal(result.ok, true);
  assert.equal(updates.length, 1);
  assert.match(updates[0], /status IS DISTINCT FROM 'signed'/);
  assert.match(updates[0], /COALESCE\(signed_at, now\(\)\)/);
  assert.equal(/signature_image_url\s*=\s*NULL/.test(updates[0]), false);
});

test('FIX2 Review Void maps to voided/review and AWS stays denied', () => {
  const persisted = reviewVoidPersistedState({ deposit_recommendation: 'endorsements_pending' });
  assert.equal(persisted.status, 'voided');
  assert.equal(persisted.check_stage, 'review');
  assert.equal(persisted.deposit_recommendation, 'endorsements_pending');
  assert.equal(persisted.decision, 'voided');
  assert.equal(persisted.deposit_path, 'voided');
  assert.equal(persisted.auditEvent, 'review_decision');
  const aws = mapReviewPath('voided');
  assert.equal(aws.error, 'not_in_tranche_5_machine');
  const sql = readFileSync('supabase/migrations/20260918170000_review_void_deposit_path.sql', 'utf8');
  assert.match(sql, /WHEN p_deposit_path = 'voided' THEN 'voided'/);
  assert.match(sql, /'voided'\) THEN 'review'/);
});

test('FIX4 claim link/relink keeps one-check-one-claim Funds Received non-duplicated', () => {
  const check1 = { id: CHECK_ID, claim_id: null, amount: 1000, check_number: '100', carrier_name: 'A' };
  const first = buildClaimLedgerSyncPlan({
    check: check1,
    newClaimId: CLAIM_A,
    claimNumber: 'CL-A',
  });
  assert.equal(first.sameClaim, false);
  assert.equal(first.claimChecks.op, 'insert');
  assert.equal(first.claimPayments.op, 'insert');
  assert.equal(first.insertCheckReceived, true);
  assert.equal(first.claimPayments.values.payment_method, 'insurance_check');

  const relink = buildClaimLedgerSyncPlan({
    check: { ...check1, claim_id: CLAIM_A },
    newClaimId: CLAIM_B,
    claimNumber: 'CL-B',
    existingClaimCheckId: 'cc-1',
    existingPaymentId: 'pay-1',
    existingEvents: [{ check_id: CHECK_ID, claim_id: CLAIM_A, event_type: 'check_received' }],
  });
  assert.equal(relink.sameClaim, false);
  assert.equal(relink.claimChecks.op, 'update');
  assert.equal(relink.claimChecks.values.claim_id, CLAIM_B);
  assert.equal(relink.claimPayments.op, 'update');
  assert.equal(relink.moveLedgerEvents.claim_id, CLAIM_B);
  assert.equal(relink.insertCheckReceived, false);

  const resave = buildClaimLedgerSyncPlan({
    check: { ...check1, claim_id: CLAIM_B },
    newClaimId: CLAIM_B,
    claimNumber: 'CL-B',
    existingClaimCheckId: 'cc-1',
    existingPaymentId: 'pay-1',
    existingEvents: [{ check_id: CHECK_ID, claim_id: CLAIM_B, event_type: 'check_received' }],
  });
  assert.equal(resave.sameClaim, true);
  assert.equal(resave.skipWrites, true);
  assert.equal(resave.insertCheckReceived, false);

  const twoChecks = [
    { id: CHECK_ID, claim_id: CLAIM_A, amount: 1000 },
    { id: CHECK_2, claim_id: CLAIM_A, amount: 250 },
    { id: CHECK_ID, claim_id: CLAIM_A, amount: 1000 },
  ];
  assert.equal(fundsReceivedForClaim(twoChecks, CLAIM_A), 1250);
});

test('FIX5 Funds UI bank-link query is invalidated after send', () => {
  const keys = queriesInvalidatedAfterBankLinkSend(CHECK_ID);
  assert.deepEqual(homeownerBankLinkQueryKey(CHECK_ID), ['homeowner-bank-link', CHECK_ID]);
  assert.deepEqual(keys[1], ['homeowner-bank-link', CHECK_ID]);
  const dialog = readFileSync('src/components/disbursement/SendHomeownerBankLinkDialog.tsx', 'utf8');
  assert.match(dialog, /queriesInvalidatedAfterBankLinkSend/);
  const funds = readFileSync('src/components/payments/FundsTab.tsx', 'utf8');
  assert.match(funds, /homeownerBankLinkQueryKey/);
});

test('Mortgage Ops image auth is limited to an active authorized request', () => {
  const allowed = mortgageAgentCanReadCheckImages({
    userRoles: ['mortgage_agent'],
    request: { tenant_id: CLAIM_A, check_intake_item_id: CHECK_ID, status: 'in_progress' },
    checkId: CHECK_ID,
    checkTenantId: CLAIM_A,
  });
  assert.equal(allowed, true);

  const unrelated = mortgageAgentCanReadCheckImages({
    userRoles: ['mortgage_agent'],
    request: null,
    checkId: CHECK_ID,
    checkTenantId: CLAIM_A,
  });
  assert.equal(unrelated, false);

  const crossRequest = mortgageAgentCanReadCheckImages({
    userRoles: ['mortgage_agent'],
    request: { tenant_id: CLAIM_A, check_intake_item_id: CHECK_2, status: 'in_progress' },
    checkId: CHECK_ID,
    checkTenantId: CLAIM_A,
  });
  assert.equal(crossRequest, false);

  const crossTenant = mortgageAgentCanReadCheckImages({
    userRoles: ['mortgage_agent'],
    request: { tenant_id: CLAIM_B, check_intake_item_id: CHECK_ID, status: 'requested' },
    checkId: CHECK_ID,
    checkTenantId: CLAIM_A,
  });
  assert.equal(crossTenant, false);

  const completed = mortgageAgentCanReadCheckImages({
    userRoles: ['mortgage_agent'],
    request: { tenant_id: CLAIM_A, check_intake_item_id: CHECK_ID, status: 'completed' },
    checkId: CHECK_ID,
    checkTenantId: CLAIM_A,
  });
  assert.equal(completed, false);

  const cancelled = mortgageAgentCanReadCheckImages({
    userRoles: ['mortgage_agent'],
    request: { tenant_id: CLAIM_A, check_intake_item_id: CHECK_ID, status: 'cancelled' },
    checkId: CHECK_ID,
    checkTenantId: CLAIM_A,
  });
  assert.equal(cancelled, false);
});

test('image handler accepts both checkId and check_id contracts', () => {
  const lovable = readFileSync('supabase/functions/get-check-image-urls/index.ts', 'utf8');
  assert.match(lovable, /body\?\.checkId \|\| body\?\.check_id/);
  assert.match(lovable, /front_url: frontUrl/);
  assert.match(lovable, /in\("status", \["requested", "in_progress"\]\)/);
  const ui = readFileSync('src/pages/mortgage-ops/MortgageOpsRequestDetail.tsx', 'utf8');
  assert.match(ui, /checkId: r.check_intake_item_id/);
  assert.match(ui, /img\?\.frontUrl \|\| img\?\.front_url/);
});

test('evaluateEndorsementCompletion still fail-closes deposit advance by default', () => {
  const done = evaluateEndorsementCompletion([
    { status: 'signed', payee_type: 'insured' },
    { status: 'manual_required', payee_type: 'mortgage_company' },
  ]);
  assert.equal(done.allSigned, true);
  assert.equal(done.depositAdvanceDenied, true);
});

test('finalizeEndorsementState is exported for the shared completion path', () => {
  assert.equal(typeof finalizeEndorsementState, 'function');
});
