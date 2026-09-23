import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AUTO_APPROVE_BACKOFF_MS,
  AUTO_APPROVE_MAX_ATTEMPTS,
  asOptionalCents,
  attemptAutoApproveWithLockRetry,
  decideAutoApprove,
  depositIsFlagged,
  maybeAutoApproveAfterProcess,
  resolveAutoApprovePolicy,
} from '../functions/api/providers/production/checkalt-auto-approve.mjs';
import { persistAutoApproveOutcome } from '../functions/api/providers/production/checkalt-idempotency.mjs';
import { dollarsToAutoApproveCents, echoAutoDepositSave } from '../../src/lib/autoDepositUiState.ts';

const ROW_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';

test('NULL and non-integer ceilings fail closed; $2000 Settings dollars are 200000 cents', () => {
  assert.equal(asOptionalCents(null), null);
  assert.equal(asOptionalCents(undefined), null);
  assert.equal(asOptionalCents(''), null);
  assert.equal(asOptionalCents(12.5), null);
  assert.equal(asOptionalCents(-1), null);
  assert.equal(asOptionalCents(200000), 200000);
  assert.equal(dollarsToAutoApproveCents('2000'), 200000);
  assert.equal(dollarsToAutoApproveCents('2000.00'), 200000);
  assert.equal(dollarsToAutoApproveCents(''), null);
  assert.throws(() => dollarsToAutoApproveCents('-5'), /Invalid maximum amount/);
  const echoed = echoAutoDepositSave(
    { auto_approve_enabled: true, auto_approve_max_cents: 200000 },
    { enabled: true, cents: 200000 },
  );
  assert.equal(echoed.ok, true);
  const mismatch = echoAutoDepositSave(
    { auto_approve_enabled: true, auto_approve_max_cents: null },
    { enabled: true, cents: 200000 },
  );
  assert.equal(mismatch.ok, false);
});

test('tenant-over-global policy; tenant NULL does not inherit unlimited from missing global', () => {
  const tenantEnabledNull = resolveAutoApprovePolicy(
    { auto_approve_enabled: true, auto_approve_max_cents: null },
    { auto_approve_enabled: false, auto_approve_max_cents: 50000 },
  );
  assert.equal(tenantEnabledNull.enabled, true);
  assert.equal(tenantEnabledNull.maxCents, 50000);
  assert.equal(tenantEnabledNull.source, 'checkalt_tenant_accounts');

  const freedomToday = resolveAutoApprovePolicy(
    { auto_approve_enabled: true, auto_approve_max_cents: null },
    { auto_approve_enabled: null, auto_approve_max_cents: null },
  );
  assert.equal(freedomToday.enabled, true);
  assert.equal(freedomToday.maxCents, null);

  const tenantCeiling = resolveAutoApprovePolicy(
    { auto_approve_enabled: true, auto_approve_max_cents: 200000 },
    { auto_approve_enabled: true, auto_approve_max_cents: 999999 },
  );
  assert.equal(tenantCeiling.maxCents, 200000);
});

test('decideAutoApprove: clean + enabled + amount <= ceiling approves; NULL ceiling stays pending', () => {
  const base = {
    processRequiresApproval: true,
    reference: '9001555',
    enabled: true,
    maxCents: 200000,
    amountCents: 154672,
    flagged: false,
  };
  assert.deepEqual(decideAutoApprove(base), { approve: true, skipReason: null });
  assert.equal(decideAutoApprove({ ...base, amountCents: 154672 }).approve, true);
  assert.equal(decideAutoApprove({ ...base, amountCents: 200000 }).approve, true);
  assert.equal(decideAutoApprove({ ...base, amountCents: 200001 }).skipReason, 'over_max_amount');
  assert.equal(decideAutoApprove({ ...base, processRequiresApproval: false }).skipReason, 'not_pending_approval');
  assert.equal(decideAutoApprove({ ...base, reference: null }).skipReason, 'missing_reference');
  assert.equal(decideAutoApprove({ ...base, enabled: false }).skipReason, 'auto_approve_disabled');
  assert.equal(decideAutoApprove({ ...base, flagged: true }).skipReason, 'flagged_by_checkalt');
  assert.equal(decideAutoApprove({ ...base, amountCents: 12.3 }).skipReason, 'invalid_amount');
  assert.equal(decideAutoApprove({ ...base, maxCents: null }).skipReason, 'missing_auto_approve_ceiling');
  assert.equal(decideAutoApprove({ ...base, maxCents: 12.5 }).skipReason, 'missing_auto_approve_ceiling');
});

test('flagged/risky/discrepant CheckAlt payloads stay pending_approval', () => {
  assert.equal(depositIsFlagged({}), false);
  assert.equal(depositIsFlagged({ exceptions: ['hold'] }), true);
  assert.equal(depositIsFlagged({ warnings: ['image quality'] }), true);
  assert.equal(depositIsFlagged({ riskFactors: ['mismatch'] }), true);
  assert.equal(depositIsFlagged({ errors: ['unreadable'] }), true);
  assert.equal(depositIsFlagged({ amountDiscrepancyDetected: true }), true);
  assert.equal(depositIsFlagged({ statusDescription: 'Possible duplicate' }), true);
  assert.equal(depositIsFlagged({ statusDescription: 'Pending Approval', status: 40 }), false);
  // Clean production process-40 payloads include these keys; they must not skip auto-approve.
  assert.equal(depositIsFlagged({
    status: 40,
    statusDescription: 'Pending Approval',
    riskRating: 2,
    riskRatingDescription: 'Low Risk',
    amountDiscrepancyDetected: false,
    errors: [],
    messages: [],
  }), false);
});

test('lock/retry uses proven backoff and never posts /deposit/process', async () => {
  assert.equal(AUTO_APPROVE_MAX_ATTEMPTS, 5);
  assert.deepEqual([...AUTO_APPROVE_BACKOFF_MS], [1500, 2500, 4000, 6000, 8000]);
  const sleeps = [];
  const paths = [];
  let calls = 0;
  const checkAltFetch = async ({ path }) => {
    paths.push(path);
    calls += 1;
    if (calls < 3) {
      return { ok: false, status: 404 };
    }
    return { ok: true, status: 200 };
  };
  const parseProviderJson = async (resp) => ({
    json: resp.status === 404
      ? { message: 'Unable to locate transaction — locked' }
      : { success: true, status: 'Approved' },
  });
  const result = await attemptAutoApproveWithLockRetry({
    checkAltFetch,
    cfg: { fi_key: 'fi' },
    credentials: {},
    fetchImpl: fetch,
    jwtCache: {},
    reference: '9001555',
    fiKey: 'fi',
    parseProviderJson,
    sleepFn: async (ms) => { sleeps.push(ms); },
  });
  assert.equal(result.approved, true);
  assert.equal(result.attempts, 3);
  assert.deepEqual(sleeps, [1500, 2500]);
  assert.deepEqual(paths, [
    '/fincapture/deposit/approve',
    '/fincapture/deposit/approve',
    '/fincapture/deposit/approve',
  ]);
});

test('lock-retry does not retry CheckAlt rejection or network/ambiguous errors', async () => {
  const rejectedPaths = [];
  const rejected = await attemptAutoApproveWithLockRetry({
    checkAltFetch: async ({ path }) => {
      rejectedPaths.push(path);
      return { ok: true, status: 200 };
    },
    parseProviderJson: async () => ({ json: { success: false, status: 40, statusDescription: 'Declined' } }),
    reference: '9001555',
    fiKey: 'fi',
    cfg: { fi_key: 'fi' },
    sleepFn: async () => { throw new Error('must not backoff on reject'); },
  });
  assert.equal(rejected.approved, false);
  assert.equal(rejected.attempts, 1);
  assert.match(rejected.skipReason, /auto_approve_failed/);
  assert.deepEqual(rejectedPaths, ['/fincapture/deposit/approve']);

  const network = await attemptAutoApproveWithLockRetry({
    checkAltFetch: async () => { throw new Error('ECONNRESET'); },
    parseProviderJson: async () => ({ json: {} }),
    reference: '9001555',
    fiKey: 'fi',
    cfg: { fi_key: 'fi' },
    sleepFn: async () => { throw new Error('must not backoff on network'); },
  });
  assert.equal(network.approved, false);
  assert.equal(network.attempts, 1);
  assert.match(network.skipReason, /auto_approve_error:ECONNRESET/);

  const ambiguous = await attemptAutoApproveWithLockRetry({
    checkAltFetch: async () => ({ ok: false, status: 500 }),
    parseProviderJson: async () => ({ json: { message: 'upstream' } }),
    reference: '9001555',
    fiKey: 'fi',
    cfg: { fi_key: 'fi' },
    sleepFn: async () => { throw new Error('must not backoff on 500'); },
  });
  assert.equal(ambiguous.approved, false);
  assert.equal(ambiguous.attempts, 1);
  assert.match(ambiguous.skipReason, /auto_approve_failed/);
});

test('maybeAutoApproveAfterProcess never processes and persists skip/success audit', async () => {
  const updates = [];
  const client = {
    query: async (sql, params) => {
      if (/FROM public\.checkalt_tenant_accounts/.test(sql)) {
        return { rows: [{ auto_approve_enabled: true, auto_approve_max_cents: 200000 }] };
      }
      if (/FROM public\.checkalt_config/.test(sql)) {
        return { rows: [] };
      }
      if (/UPDATE public\.checkalt_deposits/.test(sql)) {
        updates.push({ sql, params });
        return {
          rows: [{
            id: params[0],
            status: params[1] === true ? 'submitted' : 'pending_approval',
            approved_at: params[1] === true ? '2026-09-23T00:00:00Z' : null,
            last_status_payload: JSON.parse(params[2]),
          }],
        };
      }
      return { rows: [] };
    },
  };
  const skipped = await maybeAutoApproveAfterProcess({
    client,
    rowId: ROW_ID,
    tenantId: TENANT,
    amountCents: 154672,
    processStatus: 'pending_approval',
    reference: '9001555',
    providerJson: { exceptions: ['risk'] },
    persistAutoApproveOutcome,
    checkAltFetch: async () => { throw new Error('must not approve flagged'); },
    parseProviderJson: async () => ({ json: {} }),
  });
  assert.equal(skipped.attempted, false);
  assert.equal(skipped.approvePosted, false);
  assert.equal(skipped.skipReason, 'flagged_by_checkalt');
  assert.equal(skipped.saved.status, 'pending_approval');
  assert.equal(skipped.saved.last_status_payload._auto_approve.approved, false);

  let approveCalls = 0;
  const approved = await maybeAutoApproveAfterProcess({
    client,
    rowId: ROW_ID,
    tenantId: TENANT,
    amountCents: 154672,
    processStatus: 'pending_approval',
    reference: '9001555',
    providerJson: { status: 40, statusDescription: 'Pending Approval' },
    persistAutoApproveOutcome,
    checkAltFetch: async ({ path, body }) => {
      approveCalls += 1;
      assert.equal(path, '/fincapture/deposit/approve');
      assert.equal(body.referenceNumber, 9001555);
      assert.equal(body.action, 1);
      assert.ok(!String(path).includes('/process'));
      return { ok: true, status: 200 };
    },
    cfg: { fi_key: 'fi' },
    parseProviderJson: async () => ({ json: { success: true, status: 127, statusDescription: 'Approved' } }),
    sleepFn: async () => {},
  });
  assert.equal(approved.attempted, true);
  assert.equal(approved.approved, true);
  assert.equal(approved.saved.status, 'submitted');
  assert.equal(approved.saved.last_status_payload._auto_approve.approved, true);
  assert.equal(approveCalls, 1);

  const notPending = await maybeAutoApproveAfterProcess({
    client,
    rowId: ROW_ID,
    tenantId: TENANT,
    amountCents: 154672,
    processStatus: 'submitted',
    reference: '9001555',
    providerJson: {},
    persistAutoApproveOutcome,
    checkAltFetch: async () => { throw new Error('must not approve submitted'); },
    parseProviderJson: async () => ({ json: {} }),
  });
  assert.equal(notPending.attempted, false);
  assert.equal(notPending.approvePosted, false);
  assert.equal(notPending.skipReason, 'not_pending_approval');

  const missingRef = await maybeAutoApproveAfterProcess({
    client,
    rowId: ROW_ID,
    tenantId: TENANT,
    amountCents: 154672,
    processStatus: 'pending_approval',
    reference: null,
    providerJson: { status: 40, statusDescription: 'Pending Approval' },
    persistAutoApproveOutcome,
    checkAltFetch: async () => { throw new Error('must not approve without reference'); },
    parseProviderJson: async () => ({ json: {} }),
  });
  assert.equal(missingRef.attempted, false);
  assert.equal(missingRef.approvePosted, false);
  assert.equal(missingRef.skipReason, 'missing_reference');

  const rejected = await maybeAutoApproveAfterProcess({
    client,
    rowId: ROW_ID,
    tenantId: TENANT,
    amountCents: 154672,
    processStatus: 'pending_approval',
    reference: '9001555',
    providerJson: { status: 40, statusDescription: 'Pending Approval' },
    persistAutoApproveOutcome,
    checkAltFetch: async () => ({ ok: true, status: 200 }),
    cfg: { fi_key: 'fi' },
    parseProviderJson: async () => ({ json: { success: false, status: 40, statusDescription: 'Declined' } }),
    sleepFn: async () => {},
  });
  assert.equal(rejected.attempted, true);
  assert.equal(rejected.approved, false);
  assert.equal(rejected.saved.status, 'pending_approval');
  assert.equal(rejected.saved.last_status_payload._auto_approve.approved, false);

  const network = await maybeAutoApproveAfterProcess({
    client,
    rowId: ROW_ID,
    tenantId: TENANT,
    amountCents: 154672,
    processStatus: 'pending_approval',
    reference: '9001555',
    providerJson: { status: 40, statusDescription: 'Pending Approval' },
    persistAutoApproveOutcome,
    checkAltFetch: async () => { throw new Error('socket hang up'); },
    cfg: { fi_key: 'fi' },
    parseProviderJson: async () => ({ json: {} }),
    sleepFn: async () => {},
  });
  assert.equal(network.attempted, true);
  assert.equal(network.approved, false);
  assert.equal(network.saved.status, 'pending_approval');
  assert.match(network.skipReason, /auto_approve_error/);
});

test('persistAutoApproveOutcome maps 127/Approved to submitted and never writes cleared', async () => {
  const source = persistAutoApproveOutcome.toString();
  assert.match(source, /THEN 'submitted'/);
  assert.doesNotMatch(source, /cleared_at/);
  assert.doesNotMatch(source, /INSERT INTO public\.checkalt_deposits/);
  assert.doesNotMatch(source, /checkalt_reference/);
  const client = {
    query: async (sql, params) => ({
      rows: [{
        id: params[0],
        status: params[1] === true ? 'submitted' : 'pending_approval',
        approved_at: params[1] === true ? '2026-09-23T00:00:00Z' : null,
        cleared_at: null,
        checkalt_reference: '9001555',
        last_status_payload: JSON.parse(params[2]),
      }],
    }),
  };
  const saved = await persistAutoApproveOutcome(client, {
    rowId: ROW_ID,
    approved: true,
    approvePayload: { success: true, status: 127, statusDescription: 'Approved' },
  });
  assert.equal(saved.status, 'submitted');
  assert.equal(saved.cleared_at, null);
  assert.equal(saved.checkalt_reference, '9001555');
  assert.equal(saved.last_status_payload._auto_approve.status_code, 127);
});
