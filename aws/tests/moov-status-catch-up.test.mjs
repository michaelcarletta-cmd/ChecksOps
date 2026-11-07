/**
 * Moov status catch-up (providers/moov-status-catch-up.mjs): a fake database that behaves like
 * the rows the plan and the apply functions touch (payment_transfers, tenant_maintenance_payments,
 * payment_event_log, the SQL 109 writer's rank rule) and a fake Moov (GET only), no network, no
 * AWS. The Moov read goes through the real confirmMoovWebhookPayload; the writes through the real
 * applyProductionMoovTransferWebhook and applyCollectionV2ProviderCompletion.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CANDIDATE_LEGS_SQL,
  CANDIDATE_OBLIGATIONS_SQL,
  CATCH_UP_PATH,
  CATCH_UP_PLAN_STATEMENT,
  LOCK_LEGS_SQL,
  LOCK_OBLIGATIONS_SQL,
  PLATFORM_OWNER_SQL,
  READ_LEGS_SQL,
  READ_OBLIGATIONS_SQL,
  READ_ONLY_PROBE_SQL,
  RELATED_LEGS_SQL,
  RELATED_OBLIGATIONS_SQL,
  catchUpEventId,
  classifyCandidate,
  handleMoovStatusCatchUp,
  isMoovStatusCatchUpInvocation,
  manifestSha256,
  parseCatchUpRequest,
  sql109Rank,
} from '../functions/api/providers/moov-status-catch-up.mjs';
import { TRANSFER_STATUS_WRITER_SQL } from '../functions/api/providers/moov-transfer-webhook.mjs';
import { resetMoovTokenCache } from '../functions/api/providers/parity/moov-client.mjs';

const PLATFORM = 'platform-prod';
const OWNER = '0f0e0d0c-0b0a-4908-8706-050403020100';
const NOT_OWNER = '11111111-2222-4333-8444-555555555555';
const SECRETS = { MOOV_PUBLIC_KEY: 'pk-test', MOOV_SECRET_KEY: 'sk-test-secret-value', MOOV_ACCOUNT_ID: PLATFORM };
const PRODUCTION_ENV = {
  CHECKSOPS_ENV: 'production',
  AWS_PROVIDER_EXECUTION_ENABLED: 'true',
  AWS_MOOV_ENABLED: 'true',
  AWS_PROVIDER_WEBHOOK_DRY_RUN: 'false',
  AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'false',
};

// The September case (Freedom Adjustment, 2026-09 fee): obligation 72b622f9, Moov transfer b31c7752.
const TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const SEPT_OBLIGATION = '72b622f9-b68f-4032-a971-a854dbcfbf57';
const SEPT_TRANSFER = 'b31c7752-031f-4b8b-9b6e-82dd0aaed2cb';
const SEPT_LEG = 'ab2895c9-0000-4000-8000-000000000001';
const T = (n) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const L = (n) => `10000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;

const withEnv = async (vars, fn) => {
  const previous = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const warn = console.warn;
  console.warn = () => {};
  try {
    resetMoovTokenCache();
    return await fn();
  } finally {
    console.warn = warn;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const leg = (id, transfer, { status = 'submitted', role = 'send_bank', amount = 2500, meta = {}, env = 'production' } = {}) => ({
  id, tenant_id: TENANT, provider: 'moov', environment: env, provider_transfer_id: transfer,
  status, provider_status: null, leg_role: role, amount_cents: amount, provider_metadata: meta,
  created_at: `2026-09-01T00:00:${id.slice(-2)}Z`, completed_at: null, failure_reason: null,
});

const septemberRows = () => ({
  legs: [leg(SEPT_LEG, SEPT_TRANSFER, {
    role: 'collection_bank',
    amount: 9900,
    meta: { collection_contract: 'tenant-collection-v2', checksops_kind: 'monthly_subscription', obligation_id: SEPT_OBLIGATION, leg_type: 'bank' },
  })],
  obligations: [{
    id: SEPT_OBLIGATION, tenant_id: TENANT, status: 'due', amount_cents: 9900, provider_transfer_id: SEPT_TRANSFER,
    provider_environment: 'production', occurrence_kind: 'monthly_subscription', billing_period: '2026-09',
    notes: 'collection_v2 status BANK_PENDING · moov:b31c7752-031f-4b8b-9b6e-82dd0aaed2cb', created_at: '2026-09-02T00:00:00Z',
  }],
});

const RANK_SQL = sql109Rank;
const OWNED = new Set(['wallet_funding', 'send_wallet', 'send_bank']);
const TERMINAL = ['completed', 'settled', 'failed', 'canceled', 'cancelled', 'returned', 'reversed'];

/** A database with transactions (BEGIN snapshot, ROLLBACK restores), read-only enforcement and the SQL 109 rule. */
function fakeDatabase({ legs = [], obligations = [], writerThrowsFor = new Set() } = {}) {
  let state = { legs: structuredClone(legs), obligations: structuredClone(obligations), events: [] };
  let snapshot = null;
  let readOnly = false;
  let actor = null;
  const statements = [];
  const writes = [];
  const flat = (row) => ({
    ...row,
    obligation_id: row.provider_metadata?.obligation_id ?? null,
    collection_contract: row.provider_metadata?.collection_contract ?? null,
    checksops_kind: row.provider_metadata?.checksops_kind ?? null,
    leg_type: row.provider_metadata?.leg_type ?? null,
  });
  const write = (sql) => {
    if (readOnly) {
      const error = new Error('cannot execute in a read-only transaction');
      error.code = '25006';
      throw error;
    }
    writes.push(sql);
  };
  const query = async (sql, params = []) => {
    const s = String(sql);
    statements.push({ sql: s, params });
    if (s === 'BEGIN READ ONLY') { snapshot = structuredClone(state); readOnly = true; return { rows: [] }; }
    if (s === 'BEGIN') { snapshot = structuredClone(state); readOnly = false; return { rows: [] }; }
    if (s === 'SET TRANSACTION READ WRITE') return { rows: [] };
    if (s === 'COMMIT') { snapshot = null; readOnly = false; actor = null; return { rows: [] }; }
    if (s === 'ROLLBACK') { if (snapshot) state = snapshot; snapshot = null; readOnly = false; actor = null; return { rows: [] }; }
    if (/^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)/.test(s)) return { rows: [] };
    if (s === READ_ONLY_PROBE_SQL) return { rows: [{ transaction_read_only: readOnly ? 'on' : 'off' }] };
    if (s.includes("set_config('request.app_user_id'")) { actor = params[0]; return { rows: [] }; }
    if (s === PLATFORM_OWNER_SQL) return { rows: [{ ok: actor === OWNER }] };
    if (s.includes('set_config')) return { rows: [] };
    if (s.includes('aws_provider_webhook_receipts')) throw new Error('the catch-up must not touch webhook receipts');

    // The catch-up's own reads.
    if (s === CANDIDATE_LEGS_SQL) {
      return { rows: state.legs.filter((r) => r.provider === 'moov' && r.environment === params[0] && r.provider_transfer_id && !params[1].includes(r.status)).slice(0, params[2]).map(flat) };
    }
    if (s === CANDIDATE_OBLIGATIONS_SQL) {
      return { rows: state.obligations.filter((r) => r.provider_transfer_id && r.status !== 'settled' && (!r.provider_environment || r.provider_environment === params[0])).slice(0, params[1]) };
    }
    if (s === RELATED_LEGS_SQL) {
      return { rows: state.legs.filter((r) => r.environment === params[0] && (params[1].includes(r.provider_transfer_id) || params[2].includes(r.provider_metadata?.obligation_id))).map(flat) };
    }
    if (s === RELATED_OBLIGATIONS_SQL) {
      return { rows: state.obligations.filter((r) => params[0].includes(r.provider_transfer_id) || params[1].includes(r.id)) };
    }
    if (s === LOCK_LEGS_SQL || s === READ_LEGS_SQL) {
      return { rows: state.legs.filter((r) => r.environment === params[0] && r.provider_transfer_id === params[1]).map(({ id, status }) => ({ id, status })) };
    }
    if (s === LOCK_OBLIGATIONS_SQL || s === READ_OBLIGATIONS_SQL) {
      return { rows: state.obligations.filter((r) => params[0].includes(r.id)).map(({ id, status }) => ({ id, status })) };
    }

    // The SQL 109 writer (aws/workflows/sql/109_moov_transfer_webhook_status.sql), as a definer.
    if (s === TRANSFER_STATUS_WRITER_SQL) {
      write(s);
      const [env, transferId, status, providerStatus, eventId] = params;
      if (writerThrowsFor.has(transferId)) { const e = new Error('writer refused'); e.code = '42501'; throw e; }
      const row = state.legs.find((r) => r.environment === env && r.provider_transfer_id === transferId);
      if (!row) return { rows: [{ result: { outcome: 'unknown_transfer' } }] };
      if (!OWNED.has(row.leg_role)) return { rows: [{ result: { outcome: 'not_owned', transfer_id: row.id } }] };
      if (state.events.some((e) => e.transfer_id === row.id && e.moov_event_id === eventId)) {
        return { rows: [{ result: { outcome: 'duplicate_event', transfer_id: row.id } }] };
      }
      const previous = row.status;
      let outcome = 'stale';
      if (status && RANK_SQL(status) > RANK_SQL(previous)) { row.status = status; row.provider_status = providerStatus; outcome = 'applied'; }
      else if (status === previous) outcome = 'unchanged';
      state.events.push({ transfer_id: row.id, moov_event_id: eventId, outcome });
      return { rows: [{ result: { outcome, transfer_id: row.id, tenant_id: row.tenant_id, leg_role: row.leg_role, previous_status: previous, new_status: row.status, notify: false } }] };
    }

    // tenant-collection-v2-settlement.mjs
    if (s.includes('FROM public.payment_provider_accounts')) return { rows: [] };
    if (s.includes('FROM public.payment_transfers') && s.includes('WHERE provider_transfer_id = $1')) {
      return { rows: state.legs.filter((r) => r.provider_transfer_id === params[0]).slice(0, 1) };
    }
    if (s.includes("provider_metadata->>'obligation_id' = $1")) {
      return { rows: state.legs.filter((r) => r.provider_metadata?.obligation_id === params[0]) };
    }
    if (s.includes('UPDATE public.payment_transfers SET')) {
      write(s);
      const row = state.legs.find((r) => r.id === params[0]);
      if (row) { row.status = params[1]; row.provider_status = params[2]; }
      return { rows: [] };
    }
    if (s.includes('FROM public.tenant_maintenance_payments') && s.includes('WHERE provider_transfer_id = $1')) {
      return { rows: state.obligations.filter((r) => r.provider_transfer_id === params[0]).slice(0, 1) };
    }
    if (s.includes('FROM public.tenant_maintenance_payments WHERE id = $1::uuid')) {
      return { rows: state.obligations.filter((r) => r.id === params[0]) };
    }
    if (s.includes('FROM public.tenant_maintenance_payments') && s.includes('string_to_array')) {
      return { rows: state.obligations.filter((r) => String(r.notes || '').split(' · ').includes(`moov:${params[0]}`)).slice(0, 1) };
    }
    if (s.includes('UPDATE public.tenant_maintenance_payments SET')) {
      write(s);
      const row = state.obligations.find((r) => r.id === params[0]);
      if (row) { row.status = params[1]; if (params[1] === 'settled') row.settled_at = params[3] || 'now'; }
      return { rows: row ? [{ ...row }] : [] };
    }
    if (s.includes('FROM public.payment_event_log')) return { rows: [] };
    if (s.includes('INSERT INTO public.payment_event_log')) {
      write(s);
      state.events.push({ provider_transfer_id: params[3], event_type: params[4], new_status: params[6] });
      return { rows: [{ id: `pel-${state.events.length}` }] };
    }
    throw new Error(`unexpected SQL in fake database: ${s.slice(0, 80)}`);
  };
  return {
    statements,
    writes,
    get state() { return state; },
    newClient: () => ({ connect: async () => {}, end: async () => {}, query }),
  };
}

/** Moov answers GET /accounts/{platform}/transfers/{id}; `records` maps a transfer id to a body or an HTTP status. */
function fakeMoov(records = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method || 'GET' });
    if (u.endsWith('/oauth2/token')) return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'tok', expires_in: 300 }) };
    const id = Object.keys(records).find((key) => u.endsWith(`/accounts/${PLATFORM}/transfers/${key}`));
    const value = id ? records[id] : 404;
    if (typeof value === 'number') return { ok: false, status: value, text: async () => '{}' };
    return { ok: true, status: 200, text: async () => JSON.stringify(value) };
  };
  return { calls, reads: () => calls.filter((c) => !c.url.endsWith('/oauth2/token')), fetchImpl };
}

const moovTransfer = (transferID, status, value, extra = {}) => ({
  transferID,
  status,
  amount: { currency: 'USD', value },
  completedOn: status === 'completed' ? '2026-09-05T15:00:00Z' : undefined,
  source: { account: { accountID: 'acct-tenant-moov' }, paymentMethodID: 'pm-source-full-id-should-never-print', bankAccount: { lastFourAccountNumber: '6789', routingNumber: '021000021' } },
  destination: { account: { accountID: PLATFORM }, paymentMethodID: 'pm-dest-full-id-should-never-print' },
  ...extra,
});

const invocation = (fields) => ({
  checksops_operator: 'moov-status-catch-up',
  rawPath: CATCH_UP_PATH,
  requestContext: { http: { method: 'POST' } },
  actor_application_user_id: OWNER,
  ...fields,
});

const run = (db, moov, fields, runtime = { environment: 'production', production: true, applyEnabled: true }) => handleMoovStatusCatchUp(invocation(fields), {
  runtime,
  createClient: () => db.newClient(),
  loadDatabaseCredentials: async () => ({ host: 'localhost', username: 'checksops', password: 'x', database: 'checksops' }),
  loadProviderSecrets: async () => SECRETS,
  fetchImpl: moov.fetchImpl,
  log: { warn: () => {} },
});

const APPROVAL = 'apply the Moov catch-up in production';
const entryFor = (plan, id) => plan.manifest.entries.find((e) => e.provider_transfer_id === id);

/** Every case at once: completed, failed, returned, still pending, not found, amount mismatch, the September fee. */
function mixedFixture() {
  const sept = septemberRows();
  const db = fakeDatabase({
    legs: [
      ...sept.legs,
      leg(L(1), T(1), { role: 'send_bank', amount: 2500 }),
      leg(L(2), T(2), { role: 'send_wallet', amount: 1200 }),
      leg(L(3), T(3), { role: 'wallet_funding', amount: 50000 }),
      leg(L(4), T(4), { role: 'send_bank', amount: 700 }),
      leg(L(5), T(5), { role: 'send_bank', amount: 800 }),
      leg(L(6), T(6), { role: 'send_bank', amount: 1000 }),
      leg(L(7), T(7), { role: 'send_bank', amount: 300, status: 'completed' }),
      leg(L(8), T(8), { role: 'send_bank', amount: 300, env: 'sandbox' }),
    ],
    obligations: sept.obligations,
  });
  const moov = fakeMoov({
    [SEPT_TRANSFER]: moovTransfer(SEPT_TRANSFER, 'completed', 9900),
    [T(1)]: moovTransfer(T(1), 'completed', 2500),
    [T(2)]: moovTransfer(T(2), 'failed', 1200),
    [T(3)]: moovTransfer(T(3), 'completed', 50000, { source: { achDetails: { status: 'returned', return: { code: 'R01', reason: 'Insufficient funds' } } } }),
    [T(4)]: moovTransfer(T(4), 'pending', 700),
    // T(5): Moov answers 404
    [T(6)]: moovTransfer(T(6), 'completed', 1001),
    [T(7)]: moovTransfer(T(7), 'completed', 300),
  });
  return { db, moov };
}

test('plan is read-only: one BEGIN READ ONLY, no write, no webhook receipt, Moov read with GET only', async () => {
  await withEnv(PRODUCTION_ENV, async () => {
    const { db, moov } = mixedFixture();
    const before = structuredClone(db.state);
    const plan = await run(db, moov, { phase: 'plan' });
    assert.equal(plan.ok, true, JSON.stringify(plan));
    assert.equal(plan.read_only, true);
    assert.deepEqual(db.writes, []);
    assert.deepEqual(db.state, before);
    assert.equal(db.statements.filter((s) => s.sql === 'BEGIN READ ONLY').length, 1);
    assert.equal(db.statements.some((s) => s.sql === 'BEGIN' || s.sql === 'COMMIT'), false);
    assert.ok(moov.reads().every((c) => c.method === 'GET'));
    // Candidates: the 7 non-final production transfers; the completed T(7) and sandbox T(8) are not read.
    assert.equal(plan.counts.candidates, 7);
    assert.equal(moov.reads().some((c) => c.url.endsWith(T(7)) || c.url.endsWith(T(8))), false);

    assert.deepEqual(entryFor(plan, T(1)).legs[0], { id: L(1), tenant_id: TENANT, leg_role: 'send_bank', status: 'submitted', amount_cents: 2500, predicted_status: 'completed' });
    assert.equal(entryFor(plan, T(1)).action, 'apply');
    assert.equal(entryFor(plan, T(2)).legs[0].predicted_status, 'failed');
    assert.equal(entryFor(plan, T(3)).legs[0].predicted_status, 'returned');
    assert.equal(entryFor(plan, T(3)).moov.return_code, 'R01');
    assert.deepEqual([entryFor(plan, T(4)).action, entryFor(plan, T(4)).reason], ['skip', 'moov_not_final']);
    assert.deepEqual([entryFor(plan, T(5)).action, entryFor(plan, T(5)).reason], ['skip', 'moov_not_found']);
    assert.deepEqual([entryFor(plan, T(6)).action, entryFor(plan, T(6)).reason], ['refuse', 'amount_mismatch']);
    const sept = entryFor(plan, SEPT_TRANSFER);
    assert.equal(sept.action, 'apply');
    assert.equal(sept.obligations[0].status, 'due');
    assert.equal(sept.obligations[0].predicted_status, 'settled');
    assert.equal(sept.legs[0].predicted_status, 'settled');
    assert.deepEqual(plan.transfer_ids, [T(1), T(2), T(3), SEPT_TRANSFER].sort());
    assert.equal(plan.counts.apply, 4);
    assert.equal(plan.counts.refuse, 1);
    assert.equal(plan.manifest_sha256, manifestSha256(plan.manifest));
  });
});

test('output never carries a secret, a payment method id, a Moov account id, an account or routing number, or notes', async () => {
  await withEnv(PRODUCTION_ENV, async () => {
    const { db, moov } = mixedFixture();
    const plan = await run(db, moov, { phase: 'plan' });
    const applied = await run(db, moov, { phase: 'apply', approval_statement: APPROVAL, manifest_sha256: plan.manifest_sha256, transfer_ids: plan.transfer_ids });
    for (const out of [plan, applied]) {
      const textOut = JSON.stringify(out);
      for (const forbidden of ['sk-test-secret-value', 'pk-test', 'pm-source', 'pm-dest', 'acct-tenant-moov', PLATFORM, '021000021', '6789', 'BANK_PENDING', 'notes', 'localhost']) {
        assert.equal(textOut.includes(forbidden), false, forbidden);
      }
    }
  });
});

test('apply with the reviewed manifest: completed, failed, returned and the September fee settled; skipped and refused rows untouched', async () => {
  await withEnv(PRODUCTION_ENV, async () => {
    const { db, moov } = mixedFixture();
    const plan = await run(db, moov, { phase: 'plan' });
    const result = await run(db, moov, { phase: 'apply', approval_statement: APPROVAL, manifest_sha256: plan.manifest_sha256, transfer_ids: plan.transfer_ids });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.approval_statement, APPROVAL);
    assert.equal(result.applied.length, 4);
    const status = (id) => db.state.legs.find((r) => r.id === id).status;
    assert.equal(status(L(1)), 'completed');
    assert.equal(status(L(2)), 'failed');
    assert.equal(status(L(3)), 'returned');
    assert.equal(status(L(4)), 'submitted');
    assert.equal(status(L(5)), 'submitted');
    assert.equal(status(L(6)), 'submitted');
    // September: the fee leg and the obligation, through applyCollectionV2ProviderCompletion.
    assert.equal(status(SEPT_LEG), 'settled');
    const obligation = db.state.obligations.find((r) => r.id === SEPT_OBLIGATION);
    assert.equal(obligation.status, 'settled');
    assert.ok(obligation.settled_at);
    assert.ok(db.state.events.some((e) => e.provider_transfer_id === SEPT_TRANSFER && e.event_type === 'collection_v2.completed' && e.new_status === 'settled'));
    const septResult = result.applied.find((r) => r.provider_transfer_id === SEPT_TRANSFER);
    assert.equal(septResult.collection_outcome, 'applied');
    assert.equal(septResult.transfer_outcome, 'not_owned');
    // The SQL 109 writer got one deterministic catch-up event id per transfer.
    const writer = db.statements.filter((s) => s.sql === TRANSFER_STATUS_WRITER_SQL);
    assert.deepEqual(writer.map((s) => s.params[4]).sort(), [T(1), T(2), T(3), SEPT_TRANSFER].map((id, i) => catchUpEventId(id, ['completed', 'failed', 'completed', 'completed'][i])).sort());
    // One transaction per transfer.
    assert.equal(db.statements.filter((s) => s.sql === 'BEGIN').length, 4);
    assert.equal(db.statements.filter((s) => s.sql === 'COMMIT').length, 4);
  });
});

test('idempotent: the same manifest again is refused as changed and writes nothing; a new plan has nothing to apply', async () => {
  await withEnv(PRODUCTION_ENV, async () => {
    const { db, moov } = mixedFixture();
    const plan = await run(db, moov, { phase: 'plan' });
    const args = { phase: 'apply', approval_statement: APPROVAL, manifest_sha256: plan.manifest_sha256, transfer_ids: plan.transfer_ids };
    assert.equal((await run(db, moov, args)).ok, true);
    const writes = db.writes.length;
    const again = await run(db, moov, args);
    assert.equal(again.ok, false);
    assert.equal(again.error, 'catch_up_plan_changed');
    assert.equal(db.writes.length, writes);
    const fresh = await run(db, moov, { phase: 'plan' });
    assert.equal(fresh.counts.apply, 0);
    assert.deepEqual(fresh.transfer_ids, []);
  });
});

test('plan -> apply binding: a wrong hash, other ids, or Moov moving since the plan writes nothing', async () => {
  await withEnv(PRODUCTION_ENV, async () => {
    const { db, moov } = mixedFixture();
    const plan = await run(db, moov, { phase: 'plan' });
    const wrongHash = await run(db, moov, { phase: 'apply', approval_statement: APPROVAL, manifest_sha256: 'a'.repeat(64), transfer_ids: plan.transfer_ids });
    assert.equal(wrongHash.error, 'catch_up_plan_changed');
    const fewerIds = await run(db, moov, { phase: 'apply', approval_statement: APPROVAL, manifest_sha256: plan.manifest_sha256, transfer_ids: plan.transfer_ids.slice(1) });
    assert.equal(fewerIds.error, 'catch_up_transfer_ids_differ_from_plan');
    const extraId = await run(db, moov, { phase: 'apply', approval_statement: APPROVAL, manifest_sha256: plan.manifest_sha256, transfer_ids: [...plan.transfer_ids, T(4)] });
    assert.equal(extraId.error, 'catch_up_transfer_ids_differ_from_plan');
    assert.deepEqual(db.writes, []);

    // Moov finishes T(4) after the review: the manifest no longer matches.
    const moved = fakeMoov({
      [SEPT_TRANSFER]: moovTransfer(SEPT_TRANSFER, 'completed', 9900),
      [T(1)]: moovTransfer(T(1), 'completed', 2500),
      [T(2)]: moovTransfer(T(2), 'failed', 1200),
      [T(3)]: moovTransfer(T(3), 'completed', 50000, { source: { achDetails: { status: 'returned', return: { code: 'R01' } } } }),
      [T(4)]: moovTransfer(T(4), 'completed', 700),
      [T(6)]: moovTransfer(T(6), 'completed', 1001),
    });
    const drift = await run(db, moved, { phase: 'apply', approval_statement: APPROVAL, manifest_sha256: plan.manifest_sha256, transfer_ids: plan.transfer_ids });
    assert.equal(drift.error, 'catch_up_plan_changed');
    assert.deepEqual(db.writes, []);
  });
});

test('apply needs the owner statement; the plan words are not an apply approval; apply switches off refuse before any read', async () => {
  await withEnv(PRODUCTION_ENV, async () => {
    const { db, moov } = mixedFixture();
    const plan = await run(db, moov, { phase: 'plan' });
    const base = { phase: 'apply', manifest_sha256: plan.manifest_sha256, transfer_ids: plan.transfer_ids };
    assert.equal((await run(db, moov, base)).error, 'catch_up_approval_statement_required');
    assert.equal((await run(db, moov, { ...base, approval_statement: '   ' })).error, 'catch_up_approval_statement_required');
    assert.equal((await run(db, moov, { ...base, approval_statement: CATCH_UP_PLAN_STATEMENT })).error, 'catch_up_plan_statement_is_not_apply_approval');
    const reads = moov.reads().length;
    const off = await run(db, moov, { ...base, approval_statement: APPROVAL }, { environment: 'production', production: true, applyEnabled: false });
    assert.equal(off.error, 'catch_up_apply_disabled');
    assert.equal(moov.reads().length, reads);
    assert.deepEqual(db.writes, []);
    // A plan never takes apply fields.
    assert.equal((await run(db, moov, { phase: 'plan', approval_statement: APPROVAL })).error, 'catch_up_plan_takes_no_apply_fields');
  });
});

test('the actor must be the platform owner (row security); otherwise nothing is read from Moov', async () => {
  await withEnv(PRODUCTION_ENV, async () => {
    const { db, moov } = mixedFixture();
    const refused = await run(db, moov, { phase: 'plan', actor_application_user_id: NOT_OWNER });
    assert.equal(refused.ok, false);
    assert.equal(refused.error, 'catch_up_actor_not_platform_owner');
    assert.equal(moov.reads().length, 0);
  });
});

test('stops on the first unexpected outcome: that transfer rolls back, later ones are not attempted, earlier ones stay', async () => {
  await withEnv(PRODUCTION_ENV, async () => {
    // Ids sort T(1) < T(2) < T(3); the writer refuses T(2).
    const db = fakeDatabase({
      legs: [leg(L(1), T(1)), leg(L(2), T(2), { amount: 1200 }), leg(L(3), T(3), { amount: 50000 })],
      obligations: [],
      writerThrowsFor: new Set([T(2)]),
    });
    const moov = fakeMoov({
      [T(1)]: moovTransfer(T(1), 'completed', 2500),
      [T(2)]: moovTransfer(T(2), 'failed', 1200),
      [T(3)]: moovTransfer(T(3), 'completed', 50000),
    });
    const plan = await run(db, moov, { phase: 'plan' });
    assert.deepEqual(plan.transfer_ids, [T(1), T(2), T(3)]);
    const result = await run(db, moov, { phase: 'apply', approval_statement: APPROVAL, manifest_sha256: plan.manifest_sha256, transfer_ids: plan.transfer_ids });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'catch_up_outcome_differs_from_plan');
    assert.equal(result.stopped_at, T(2));
    assert.equal(result.failure.transfer_outcome, 'status_writer_unavailable');
    assert.equal(result.applied.length, 1);
    const status = (id) => db.state.legs.find((r) => r.id === id).status;
    assert.equal(status(L(1)), 'completed');
    assert.equal(status(L(2)), 'submitted');
    assert.equal(status(L(3)), 'submitted');
    assert.equal(db.statements.filter((s) => s.sql === TRANSFER_STATUS_WRITER_SQL && s.params[1] === T(3)).length, 0);
  });
});

test('a row that changed between the plan and its transaction is not written', async () => {
  await withEnv(PRODUCTION_ENV, async () => {
    const db = fakeDatabase({ legs: [leg(L(1), T(1))] });
    const moov = fakeMoov({ [T(1)]: moovTransfer(T(1), 'completed', 2500) });
    const plan = await run(db, moov, { phase: 'plan' });
    const client = db.newClient();
    // Someone else moves the leg after the apply re-plan read it: simulate by the lock read seeing 'pending'.
    const { applyOneTransfer } = await import('../functions/api/providers/moov-status-catch-up.mjs');
    db.state.legs[0].status = 'pending';
    const done = await applyOneTransfer(client, { entry: plan.manifest.entries[0], payload: { type: 'transfer.updated', data: moovTransfer(T(1), 'completed', 2500) }, environment: 'production', actorId: OWNER, log: { warn: () => {} } });
    assert.equal(done.ok, false);
    assert.equal(done.error, 'catch_up_state_changed_since_plan');
    assert.equal(db.state.legs[0].status, 'pending');
    assert.deepEqual(db.writes, []);
  });
});

test('already terminal: skipped, and a terminal row the settlement code would rewrite is refused', () => {
  const completed = { ok: true, payload: { type: 'transfer.updated', data: moovTransfer(T(1), 'completed', 2500) } };
  const skipped = classifyCandidate({
    providerTransferId: T(1), legs: [leg(L(1), T(1), { status: 'completed' })], moov: completed, environment: 'production',
  });
  assert.deepEqual([skipped.action, skipped.reason], ['skip', 'already_terminal']);

  // A returned fee obligation whose leg is returned, and Moov now says completed:
  // applyBillingProviderEvent would rewrite the leg to settled; the catch-up refuses instead.
  const sept = septemberRows();
  const returnedLeg = { ...sept.legs[0], status: 'returned', obligation_id: SEPT_OBLIGATION, collection_contract: 'tenant-collection-v2' };
  const refused = classifyCandidate({
    providerTransferId: SEPT_TRANSFER,
    legs: [returnedLeg],
    obligations: [{ ...sept.obligations[0], status: 'returned' }],
    siblingsByObligation: { [SEPT_OBLIGATION]: [returnedLeg] },
    moov: { ok: true, payload: { type: 'transfer.updated', data: moovTransfer(SEPT_TRANSFER, 'completed', 9900) } },
    environment: 'production',
  });
  assert.deepEqual([refused.action, refused.reason], ['refuse', 'terminal_row_would_change']);
});

test('the September fee alone: due -> settled through applyCollectionV2ProviderCompletion, the leg settled, one event row', async () => {
  await withEnv(PRODUCTION_ENV, async () => {
    const db = fakeDatabase(septemberRows());
    const moov = fakeMoov({ [SEPT_TRANSFER]: moovTransfer(SEPT_TRANSFER, 'completed', 9900) });
    const plan = await run(db, moov, { phase: 'plan' });
    assert.deepEqual(plan.transfer_ids, [SEPT_TRANSFER]);
    assert.equal(plan.manifest.entries[0].obligations[0].billing_period, '2026-09');
    const result = await run(db, moov, { phase: 'apply', approval_statement: APPROVAL, manifest_sha256: plan.manifest_sha256, transfer_ids: plan.transfer_ids });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.applied[0].before, { legs: { [SEPT_LEG]: 'submitted' }, obligations: { [SEPT_OBLIGATION]: 'due' } });
    assert.deepEqual(result.applied[0].after, { legs: { [SEPT_LEG]: 'settled' }, obligations: { [SEPT_OBLIGATION]: 'settled' } });
    assert.equal(db.state.events.filter((e) => e.event_type === 'collection_v2.completed').length, 1);
  });
});

test('direct invocation shape: an API Gateway event, extra keys or another path are refused', () => {
  const ok = invocation({ phase: 'plan' });
  assert.equal(isMoovStatusCatchUpInvocation(ok), true);
  assert.equal(isMoovStatusCatchUpInvocation({ ...ok, headers: {} }), false);
  assert.equal(isMoovStatusCatchUpInvocation({ ...ok, version: '2.0' }), false);
  assert.equal(isMoovStatusCatchUpInvocation({ ...ok, body: '{}' }), false);
  assert.equal(isMoovStatusCatchUpInvocation({ ...ok, routeKey: 'POST /scheduled/{proxy+}' }), false);
  assert.equal(isMoovStatusCatchUpInvocation({ ...ok, requestContext: { http: { method: 'POST' }, apiId: 'x' } }), false);
  assert.equal(isMoovStatusCatchUpInvocation({ ...ok, tenant_id: TENANT }), false);
  assert.equal(isMoovStatusCatchUpInvocation({ ...ok, rawPath: '/scheduled/other' }), false);
  assert.equal(isMoovStatusCatchUpInvocation({ ...ok, checksops_operator: 'other' }), false);
  assert.equal(parseCatchUpRequest({ ...ok, actor_application_user_id: 'not-a-uuid' }).error, 'catch_up_actor_required');
  assert.equal(parseCatchUpRequest({ ...ok, limit: 1000 }).error, 'catch_up_limit_invalid');
  assert.equal(parseCatchUpRequest({ ...ok, phase: 'apply', approval_statement: APPROVAL, manifest_sha256: 'a'.repeat(64), transfer_ids: ['x', 'x'] }).error, 'catch_up_transfer_ids_invalid');
});

test('the plan does not depend on webhook receipts (receipts are keyed on a header Moov repeats)', async () => {
  await withEnv(PRODUCTION_ENV, async () => {
    const { db, moov } = mixedFixture();
    const plan = await run(db, moov, { phase: 'plan' });
    assert.equal(plan.ok, true);
    assert.equal(db.statements.some((s) => s.sql.includes('aws_provider_webhook_receipts')), false);
  });
});

test('invoker script: plan event, apply event bound to the plan file, refusals', async () => {
  const { buildCatchUpEvent, main } = await import('../../scripts/deployment-guard/moov-status-catch-up.mjs');
  const plan = buildCatchUpEvent({ environment: 'production', phase: 'plan', 'actor-application-user-id': OWNER, limit: '25' });
  assert.equal(plan.ok, true);
  assert.equal(plan.functionName, 'checksops-production-prep-api');
  assert.equal(isMoovStatusCatchUpInvocation(plan.event), true);
  assert.equal(parseCatchUpRequest(plan.event).limit, 25);

  const planFile = JSON.stringify({ ok: true, phase: 'plan', environment: 'production', manifest: { limit: 25 }, manifest_sha256: 'b'.repeat(64), transfer_ids: [T(1)], truncated: false });
  const apply = buildCatchUpEvent({
    environment: 'production', phase: 'apply', 'actor-application-user-id': OWNER, plan: 'plan.json',
    'approval-statement-b64': Buffer.from(APPROVAL).toString('base64'),
  }, { readFile: () => planFile });
  assert.equal(apply.ok, true, JSON.stringify(apply));
  assert.deepEqual(parseCatchUpRequest(apply.event), {
    ok: true, phase: 'apply', actorId: OWNER, limit: 25, statement: APPROVAL, manifestSha256: 'b'.repeat(64), transferIds: [T(1)],
  });
  const read = { readFile: () => planFile };
  const base = { environment: 'production', phase: 'apply', 'actor-application-user-id': OWNER, plan: 'p' };
  assert.equal(buildCatchUpEvent({ ...base }, read).error, 'pass_exactly_one_approval_statement_flag');
  assert.equal(buildCatchUpEvent({ ...base, 'approval-statement': APPROVAL, limit: '9' }, read).error, 'apply_takes_the_limit_from_the_plan');
  assert.equal(buildCatchUpEvent({ ...base, environment: 'staging', 'approval-statement': APPROVAL }, read).error, 'plan_file_is_not_a_successful_plan_for_this_environment');
  assert.equal(buildCatchUpEvent({ ...base, 'approval-statement': APPROVAL, force: true }, read).error, 'unknown_flags');
  assert.equal(buildCatchUpEvent({ environment: 'prod', phase: 'plan', 'actor-application-user-id': OWNER }).error, 'environment_must_be_production_or_staging');
  let invoked = null;
  const out = await main(['--environment', 'staging', '--phase', 'plan', '--actor-application-user-id', OWNER], {
    invoke: async (args) => { invoked = args; return { ok: true }; },
  });
  assert.equal(out.code, 0);
  assert.equal(invoked.functionName, 'checksops-staging-api');
});
