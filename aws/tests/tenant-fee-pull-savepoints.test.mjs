/**
 * Tenant fee pull, production incident 2026-11-06 (Freedom Adjustment, period
 * 2026-10, $132.00).
 *
 * Attempt 1: Moov created ACH debit a4d1ca95 (CCD), then a statement in the
 * pull's transaction failed; a swallowed .catch() kept JavaScript going but
 * PostgreSQL had aborted the transaction, the audit SAVEPOINT failed with 25P02
 * ("current transaction is aborted"), the API answered 503 and everything
 * rolled back: no leg, no occurrence, the transfer id lost.
 * Attempt 2: the same idempotency key, Moov answered with the transfer it had
 * already created (non-2xx, the transfer JSON as body); moovFetch threw it, the
 * collector recorded "Collection failed: {transferID ...}".
 *
 * These tests run the pull's database code against a miniature PostgreSQL
 * transaction (a failed statement aborts it: every later statement fails with
 * 25P02 until ROLLBACK TO SAVEPOINT; the money-write flag is transaction-local
 * and a rollback to a savepoint undoes a set_config made after it; a money
 * write without the flag is refused as SQL 136's restrictive policy refuses
 * it) and a fake Moov that answers a repeated idempotency key with HTTP 409 and
 * the original transfer, through the real postTransfer and moovFetch.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BILLING_VERIFICATION_AMOUNT_CENTS,
  postTransfer,
  submitOccurrence,
  submitVerificationOccurrence,
} from '../functions/api/tenant-billing-engine.mjs';
import {
  CHECKSOPS_SANDBOX_MERCHANT_ACCOUNT_ID,
  COLLECTION_INSERT_LEG_SQL,
  bankLegIdempotencyKey,
  idempotentReplayTransfer,
  savepointQuery,
  withSavepoint,
} from '../functions/api/tenant-collection-v2.mjs';
import { MoovError, resetMoovTokenCache } from '../functions/api/providers/parity/moov-client.mjs';

const TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const OCCURRENCE = '7b0c4b7e-3a52-4d52-9a3c-0f0e7e1a2b3c';
const ROLLED_BACK_OCCURRENCE = '0d6c1f8e-5b7a-4c1d-8e2f-3a4b5c6d7e8f';
const OTHER_LIVE_OCCURRENCE = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const TRANSFER = 'a4d1ca95-5905-4235-b1f3-f0693d75b733';
const DEST_PM = 'a1000000-0000-4000-8000-000000000001';
const PERIOD = '2026-10';
const AMOUNT = 13200;
const BANK_KEY = bankLegIdempotencyKey({ tenantId: TENANT, billingPeriod: PERIOD });

// The collection leg is written by SQL 145's DEFINER function (the platform owner is not a member of the
// billed tenant, and no payment_transfers INSERT policy admits it since SQL 90); the function refuses
// without the money-write flag as SQL 136's policy refuses a direct write.
const LEG_INSERT_RE = /^SELECT \* FROM public\.aws_platform_owner_insert_billing_collection_leg\(/;
const MONEY_WRITE_RE = /\b(?:(?:INSERT\s+INTO|UPDATE)\s+public\.(payment_transfers|tenant_maintenance_payments|check_billing_events)\b|public\.aws_platform_owner_insert_billing_collection_leg\()/;

const pgError = (code, message) => Object.assign(new Error(message), { code, severity: 'ERROR' });

/**
 * A miniature PostgreSQL transaction. `failOn`: [{ re, code, message, times }]
 * makes a matching statement fail (and abort the transaction). `rows(sql,
 * params)` answers reads. Each executed statement is logged with the flag value
 * and the innermost savepoint at that moment.
 */
const pgTransaction = ({ failOn = [], rows = () => null } = {}) => {
  const state = { aborted: false, flag: null, savepoints: [], log: [], failures: [] };
  const rules = failOn.map((rule) => ({ times: 1, ...rule }));
  const top = () => state.savepoints.at(-1)?.name || null;
  const client = {
    state,
    async query(sql, params = []) {
      const text = String(sql).trim();
      const rollbackTo = text.match(/^ROLLBACK TO SAVEPOINT (\w+)$/);
      if (rollbackTo) {
        const index = state.savepoints.map((sp) => sp.name).lastIndexOf(rollbackTo[1]);
        if (index < 0) throw pgError('3B001', `savepoint "${rollbackTo[1]}" does not exist`);
        state.savepoints.length = index + 1;
        state.flag = state.savepoints[index].flagAtOpen;
        state.aborted = false;
        state.log.push({ sql: text, params, flag: state.flag, savepoint: top() });
        return { rows: [] };
      }
      if (state.aborted) {
        const error = pgError('25P02', 'current transaction is aborted, commands ignored until end of transaction block');
        state.log.push({ sql: text, params, flag: state.flag, savepoint: top(), error: error.code });
        throw error;
      }
      const savepoint = text.match(/^SAVEPOINT (\w+)$/);
      if (savepoint) {
        state.savepoints.push({ name: savepoint[1], flagAtOpen: state.flag });
        state.log.push({ sql: text, params, flag: state.flag, savepoint: top() });
        return { rows: [] };
      }
      const release = text.match(/^RELEASE SAVEPOINT (\w+)$/);
      if (release) {
        const index = state.savepoints.map((sp) => sp.name).lastIndexOf(release[1]);
        if (index < 0) throw pgError('3B001', `savepoint "${release[1]}" does not exist`);
        state.log.push({ sql: text, params, flag: state.flag, savepoint: top() });
        state.savepoints.length = index;
        return { rows: [] };
      }
      const entry = { sql: text, params, flag: state.flag, savepoint: top() };
      state.log.push(entry);
      if (/set_config\('request\.money_write', '1', true\)/.test(text)) {
        state.flag = '1';
        return { rows: [{ set_config: '1' }] };
      }
      const rule = rules.find((r) => r.times > 0 && r.re.test(text));
      if (rule) {
        rule.times -= 1;
        state.aborted = true;
        entry.error = rule.code;
        state.failures.push(text);
        throw pgError(rule.code, rule.message);
      }
      if (MONEY_WRITE_RE.test(text) && state.flag !== '1') {
        state.aborted = true;
        entry.error = '42501';
        const table = text.match(MONEY_WRITE_RE)[1];
        throw pgError('42501', table ? `new row violates row-level security policy for table "${table}"` : 'billing_collection_leg_not_server_write');
      }
      return rows(text, params) || { rows: [] };
    },
  };
  return client;
};

/** Default reads: the occurrence row answers its own UPDATE ... RETURNING. */
const occurrenceRows = (live = {}) => (sql, params) => {
  if (/^UPDATE public\.tenant_maintenance_payments/.test(sql)) {
    return { rows: [{ id: params[0], tenant_id: TENANT, billing_period: PERIOD, amount_cents: AMOUNT, status: params[1], provider_transfer_id: params[params.length === 5 && /notes = CASE/.test(sql) ? 4 : 2] }] };
  }
  if (/^SELECT \* FROM public\.tenant_maintenance_payments WHERE id = \$1::uuid/.test(sql)) {
    return { rows: live[params[0]] ? [live[params[0]]] : [] };
  }
  if (LEG_INSERT_RE.test(sql)) {
    return { rows: [{ id: 'leg-1', idempotency_key: params[3], provider_transfer_id: params[9], status: params[2], amount_cents: params[4] }] };
  }
  return null;
};

const moovTransfer = ({ amount = AMOUNT, paymentId = OCCURRENCE, period = PERIOD, tenant = TENANT, leg = 'ach_debit' } = {}) => ({
  transferID: TRANSFER,
  createdOn: '2026-11-06T19:18:03.412Z',
  status: 'created',
  amount: { currency: 'USD', value: amount },
  description: `ChecksOps subscription ${period} bank`,
  source: { paymentMethodType: 'ach-debit-fund', achDetails: { status: 'initiated', secCode: 'CCD' } },
  destination: { paymentMethodType: 'moov-wallet' },
  metadata: {
    checksops_kind: 'monthly_subscription',
    checksops_leg: leg,
    checksops_tenant_id: tenant,
    checksops_payment_id: paymentId,
    checksops_period: period,
    collection_contract: 'tenant-collection-v2',
  },
});

/**
 * Moov over fetch: a token endpoint, and POST /transfers that creates once per
 * X-Idempotency-Key and answers a repeat with 409 and the original transfer.
 */
const fakeMoov = ({ preexisting = null } = {}) => {
  const byKey = new Map();
  const posts = [];
  if (preexisting) byKey.set('*', preexisting);
  const fetchImpl = async (url, init = {}) => {
    if (String(url).endsWith('/oauth2/token')) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    }
    const key = init.headers?.['X-Idempotency-Key'];
    const body = JSON.parse(init.body);
    posts.push({ url: String(url), key, body });
    const prior = byKey.get(key) || byKey.get('*');
    if (prior) return new Response(JSON.stringify(prior), { status: 409 });
    const created = moovTransfer({ amount: body.amount.value, paymentId: body.metadata.checksops_payment_id });
    byKey.set(key, created);
    return new Response(JSON.stringify(created), { status: 200 });
  };
  return { fetchImpl, posts };
};

const MOOV_CONTEXT = { environment: 'sandbox', sandboxPublicKey: 'pk_test', sandboxSecretKey: 'sk_test' };

const pull = (client, moov, extraDeps = {}) => {
  resetMoovTokenCache();
  return submitOccurrence(client, {
    occurrence: { id: OCCURRENCE, tenant_id: TENANT, billing_period: PERIOD, amount_cents: AMOUNT, status: 'due' },
    readiness: {
      environment: 'sandbox',
      authorization: { tenant_id: TENANT, provider_payment_method_id: 'pm-bank', provider_account_id: 'acct-tenant' },
      settings: { billing_day_of_month: 1 },
    },
    destination: { accountId: CHECKSOPS_SANDBOX_MERCHANT_ACCOUNT_ID, paymentMethodId: DEST_PM, environment: 'sandbox' },
    fetchImpl: moov.fetchImpl,
    deps: {
      simulate: false,
      bankOnly: true,
      moovContext: MOOV_CONTEXT,
      postTransfer,
      resolveBillingDebitSource: async () => ({ ok: true, sourceMethodId: 'debit-pm-bank', sourceAccountId: 'acct-tenant' }),
      ...extraDeps,
    },
  });
};

const captureErrors = async (fn) => {
  const original = console.error;
  const lines = [];
  console.error = (...args) => { lines.push(args.join(' ')); };
  try {
    return { result: await fn(), lines };
  } finally {
    console.error = original;
  }
};

const parsedLogs = (lines) => lines.map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
const ran = (client, re) => client.state.log.filter((q) => re.test(q.sql) && !q.error);

/** Every money write ran with the flag on, set inside the same savepoint as the write. */
const assertFlagScopedToWrites = (client) => {
  const writes = client.state.log.map((q, i) => ({ q, i })).filter(({ q }) => MONEY_WRITE_RE.test(q.sql));
  assert.ok(writes.length > 0, 'no money write ran');
  for (const { q, i } of writes) {
    assert.equal(q.flag, '1', `money write without the flag: ${q.sql.slice(0, 60)}`);
    const flagSet = client.state.log.slice(0, i).findLastIndex((p) => /set_config\('request\.money_write'/.test(p.sql));
    assert.ok(flagSet >= 0, 'no set_config before the write');
    assert.ok(q.savepoint, `money write outside a savepoint: ${q.sql.slice(0, 60)}`);
    assert.equal(client.state.log[flagSet].savepoint, q.savepoint, `flag set outside the write's savepoint: ${q.sql.slice(0, 60)}`);
  }
};

test('the miniature transaction aborts like PostgreSQL: 25P02 until ROLLBACK TO SAVEPOINT, which also undoes a later set_config', async () => {
  const client = pgTransaction({ failOn: [{ re: /^SELECT broken/, code: '42703', message: 'column "x" does not exist' }] });
  await client.query("SELECT set_config('request.money_write', '1', true)");
  await client.query('SAVEPOINT a');
  await assert.rejects(client.query('SELECT broken'), (e) => e.code === '42703');
  await assert.rejects(client.query('SELECT 1'), (e) => e.code === '25P02');
  await client.query('ROLLBACK TO SAVEPOINT a');
  assert.equal(client.state.flag, '1', 'a flag set before the savepoint survives the rollback');
  await client.query('RELEASE SAVEPOINT a');
  client.state.flag = null; // as at the start of a new transaction
  await client.query('SAVEPOINT b');
  await client.query("SELECT set_config('request.money_write', '1', true)");
  await client.query('ROLLBACK TO SAVEPOINT b');
  assert.equal(client.state.flag, null, 'a flag set inside the savepoint is undone by the rollback');
  await assert.rejects(client.query('UPDATE public.payment_transfers SET status = $1'), (e) => e.code === '42501');
});

test('incident attempt 1: the leg INSERT fails after Moov created the transfer; the transaction stays usable and the occurrence records the transfer as submitted', async () => {
  const client = pgTransaction({
    failOn: [{ re: LEG_INSERT_RE, code: 'P0001', message: 'send speed fee trigger refused the leg' }],
    rows: occurrenceRows(),
  });
  const moov = fakeMoov();
  const { result, lines } = await captureErrors(() => pull(client, moov));

  assert.equal(moov.posts.length, 1);
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(result.persist_failed, true);
  assert.equal(result.error, null);
  assert.equal(result.obligation_status, 'submitted');
  assert.equal(result.legs[0].provider_transfer_id, TRANSFER);
  // PostgreSQL never stayed aborted: the leg insert was rolled back to its savepoint and every later statement ran.
  assert.equal(client.state.aborted, false);
  assert.deepEqual(client.state.savepoints, []);
  assert.equal(client.state.log.filter((q) => q.error === '25P02').length, 0);
  assert.ok(ran(client, /^ROLLBACK TO SAVEPOINT collection_insert_leg$/).length === 1);
  // The collector's obligation update and submitOccurrence's update both carry the transfer id, status submitted.
  const updates = ran(client, /^UPDATE public\.tenant_maintenance_payments/);
  assert.equal(updates.length, 2);
  assert.deepEqual([updates[0].params[1], updates[0].params[4]], ['submitted', TRANSFER]);
  assert.match(updates[0].params[3], /"persist_failed":true/);
  assert.deepEqual([updates[1].params[1], updates[1].params[2], updates[1].params[3]], ['submitted', TRANSFER, null]);
  assert.match(updates[1].params[4], new RegExp(`moov:${TRANSFER} · leg_persist_failed$`));
  assert.equal(ran(client, /^UPDATE public\.tenant_billing_settings/).length, 1);
  assert.equal(result.occurrence.status, 'submitted');
  // The log names the failing statement and its SQLSTATE (no parameters, no account numbers).
  const logged = parsedLogs(lines).filter((l) => l.event === 'billing_pull_statement_failed');
  assert.deepEqual(logged.map((l) => [l.statement, l.sqlstate, l.swallowed]), [['collection_insert_leg', 'P0001', false]]);
  assert.equal(logged[0].message, 'send speed fee trigger refused the leg');
  assert.ok(!lines.join('\n').includes('debit-pm-bank'));
  assertFlagScopedToWrites(client);
});

test('incident 2026-11-06T22:53:11Z: the leg goes through SQL 145 (no direct INSERT INTO payment_transfers); the values are the earlier INSERT\'s, in its order', async () => {
  const client = pgTransaction({ rows: occurrenceRows() });
  const { result } = await captureErrors(() => pull(client, fakeMoov()));
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(result.persist_failed, false);
  assert.equal(ran(client, /INSERT\s+INTO\s+public\.payment_transfers/).length, 0, 'no direct leg INSERT');
  const [leg] = ran(client, LEG_INSERT_RE);
  assert.ok(leg, 'the leg ran through the function');
  assert.equal(leg.sql, COLLECTION_INSERT_LEG_SQL);
  assert.equal(leg.savepoint, 'collection_insert_leg');
  const metadata = JSON.parse(leg.params[12]);
  assert.deepEqual(leg.params.slice(0, 12), [
    TENANT, 'sandbox', 'submitted', BANK_KEY, AMOUNT, `ChecksOps collection v2 ${PERIOD} ach_debit`,
    'acct-tenant', null, 'ach_debit', TRANSFER, 'created', null,
  ]);
  assert.deepEqual(
    [metadata.collection_contract, metadata.obligation_id, metadata.billing_period, metadata.leg_type],
    ['tenant-collection-v2', OCCURRENCE, PERIOD, 'ach_debit'],
  );
  assertFlagScopedToWrites(client);
});

test('the leg function refused (42501, as before SQL 145 or for a non-owner) or absent (42883, the API live before SQL 145): rolled back to its savepoint, logged, the occurrence still records the transfer as submitted', async () => {
  for (const [code, message] of [
    ['42501', 'new row violates row-level security policy for table "payment_transfers"'],
    ['42883', 'function public.aws_platform_owner_insert_billing_collection_leg(uuid, text, text, text, bigint, text, text, uuid, text, text, text, text, jsonb) does not exist'],
  ]) {
    const client = pgTransaction({ failOn: [{ re: LEG_INSERT_RE, code, message }], rows: occurrenceRows() });
    const { result, lines } = await captureErrors(() => pull(client, fakeMoov()));
    assert.equal(result.ok, true, code);
    assert.equal(result.persist_failed, true, code);
    assert.equal(result.obligation_status, 'submitted', code);
    assert.equal(client.state.aborted, false, code);
    assert.equal(ran(client, /^ROLLBACK TO SAVEPOINT collection_insert_leg$/).length, 1, code);
    const submit = ran(client, /^UPDATE public\.tenant_maintenance_payments/).at(-1);
    assert.deepEqual([submit.params[1], submit.params[2]], ['submitted', TRANSFER], code);
    assert.match(submit.params[4], /leg_persist_failed$/, code);
    const logged = parsedLogs(lines).filter((l) => l.event === 'billing_pull_statement_failed');
    assert.deepEqual(logged.map((l) => [l.statement, l.sqlstate, l.swallowed]), [['collection_insert_leg', code, false]], code);
  }
});

test('the tenant_billing_settings UPDATE failing is logged and rolled back to its savepoint; the pull still succeeds', async () => {
  const client = pgTransaction({
    failOn: [{ re: /^UPDATE public\.tenant_billing_settings/, code: '42501', message: 'permission denied for table tenant_billing_settings' }],
    rows: occurrenceRows(),
  });
  const { result, lines } = await captureErrors(() => pull(client, fakeMoov()));
  assert.equal(result.ok, true);
  assert.equal(result.persist_failed, false);
  assert.equal(result.occurrence.status, 'submitted');
  assert.equal(client.state.aborted, false);
  const leg = ran(client, LEG_INSERT_RE);
  assert.equal(leg.length, 1);
  assert.equal(leg[0].params[9], TRANSFER);
  // A statement after the failure still runs (what recordBillingAudit's SAVEPOINT would be next).
  await client.query('SAVEPOINT billing_audit');
  await client.query('RELEASE SAVEPOINT billing_audit');
  const logged = parsedLogs(lines).filter((l) => l.event === 'billing_pull_statement_failed');
  assert.deepEqual(logged.map((l) => [l.statement, l.sqlstate, l.swallowed]), [['billing_settings_next_period', '42501', true]]);
  assertFlagScopedToWrites(client);
});

test('a failed read in the collection store (listLegs) no longer aborts the pull: the leg and the occurrence still save', async () => {
  const client = pgTransaction({
    failOn: [{ re: /^SELECT \* FROM public\.payment_transfers\s+WHERE provider_metadata/, code: '42P01', message: 'relation does not exist' }],
    rows: occurrenceRows(),
  });
  const { result } = await captureErrors(() => pull(client, fakeMoov()));
  assert.equal(result.ok, true);
  assert.equal(client.state.aborted, false);
  assert.equal(ran(client, LEG_INSERT_RE).length, 1);
  assert.equal(ran(client, /^UPDATE public\.tenant_maintenance_payments/).length, 2);
});

test('incident attempt 2: Moov answers the repeated idempotency key with 409 and the original transfer; that is the leg, submitted, not "Collection failed"', async () => {
  const client = pgTransaction({ rows: occurrenceRows() });
  const moov = fakeMoov({ preexisting: moovTransfer() });
  const { result, lines } = await captureErrors(() => pull(client, moov));
  assert.equal(moov.posts.length, 1);
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(result.error, null);
  assert.equal(result.idempotent_replay, true);
  assert.equal(result.obligation_status, 'submitted');
  assert.equal(result.occurrence.status, 'submitted');
  const leg = ran(client, LEG_INSERT_RE);
  assert.equal(leg.length, 1);
  assert.equal(leg[0].params[3], BANK_KEY);
  assert.equal(leg[0].params[9], TRANSFER);
  assert.equal(leg[0].params[2], 'submitted');
  const submit = ran(client, /^UPDATE public\.tenant_maintenance_payments/).at(-1);
  assert.equal(submit.params[3], null, 'no failure_reason');
  assert.ok(!String(submit.params[4]).includes('transferID'), 'the transfer JSON is not a failure note');
  assert.match(submit.params[4], /moov_idempotent_replay/);
  assert.equal(parsedLogs(lines).length, 0);
  assertFlagScopedToWrites(client);
});

test('409 replay of a transfer whose payment id belongs to a rolled-back attempt (no such row) is this period\'s leg', async () => {
  const client = pgTransaction({ rows: occurrenceRows() });
  const moov = fakeMoov({ preexisting: moovTransfer({ paymentId: ROLLED_BACK_OCCURRENCE }) });
  const { result } = await captureErrors(() => pull(client, moov));
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(result.legs[0].provider_transfer_id, TRANSFER);
  assert.equal(result.legs[0].replayed_from_payment_id, ROLLED_BACK_OCCURRENCE);
  // The lookup ran (and found nothing) before the transfer was accepted.
  const lookup = ran(client, /^SELECT \* FROM public\.tenant_maintenance_payments WHERE id = \$1::uuid/);
  assert.deepEqual(lookup.map((q) => q.params[0]), [ROLLED_BACK_OCCURRENCE]);
  const leg = ran(client, LEG_INSERT_RE)[0];
  assert.equal(JSON.parse(leg.params[12]).replayed_from_payment_id, ROLLED_BACK_OCCURRENCE);
});

test('409 replay whose body does not match this leg fails closed, without the transfer JSON as the reason', async () => {
  const cases = [
    ['amount', moovTransfer({ amount: AMOUNT + 1 }), {}],
    ['period', moovTransfer({ period: '2026-09' }), {}],
    ['tenant', moovTransfer({ tenant: OTHER_LIVE_OCCURRENCE }), {}],
    ['leg', moovTransfer({ leg: 'wallet' }), {}],
    ['live other obligation', moovTransfer({ paymentId: OTHER_LIVE_OCCURRENCE }), { [OTHER_LIVE_OCCURRENCE]: { id: OTHER_LIVE_OCCURRENCE } }],
    ['no metadata', { ...moovTransfer(), metadata: undefined }, {}],
  ];
  for (const [label, body, live] of cases) {
    const client = pgTransaction({ rows: occurrenceRows(live) });
    const { result, lines } = await captureErrors(() => pull(client, fakeMoov({ preexisting: body })));
    assert.equal(result.ok, false, label);
    assert.equal(result.error, 'provider_idempotent_replay_mismatch', label);
    assert.equal(result.obligation_status, 'failed', label);
    assert.equal(ran(client, LEG_INSERT_RE).length, 0, label);
    const submit = ran(client, /^UPDATE public\.tenant_maintenance_payments/).at(-1);
    assert.equal(submit.params[1], 'failed', label);
    assert.equal(submit.params[3], 'provider_idempotent_replay_mismatch', label);
    assert.ok(!JSON.stringify(submit.params).includes(TRANSFER), `${label}: the mismatched transfer is not recorded as ours`);
    assert.equal(client.state.aborted, false, label);
    const logged = parsedLogs(lines).find((l) => l.statement === 'moov_transfer_idempotent_replay');
    assert.ok(logged, label);
    assert.equal(logged.provider_status_code, 409, label);
  }
});

test('a real Moov rejection (no transfer in the body) still fails as before', async () => {
  const client = pgTransaction({ rows: occurrenceRows() });
  const fetchImpl = async (url) => (String(url).endsWith('/oauth2/token')
    ? new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 })
    : new Response(JSON.stringify({ error: 'insufficient funds' }), { status: 422 }));
  const { result } = await captureErrors(() => pull(client, { fetchImpl }));
  assert.equal(result.ok, false);
  assert.equal(result.error, 'insufficient funds');
  assert.equal(result.obligation_status, 'failed');
  assert.equal(ran(client, LEG_INSERT_RE).length, 0);
});

test('idempotentReplayTransfer reads MoovError bodies (object or text) and ignores anything without a transfer', () => {
  const metadata = moovTransfer().metadata;
  const ok = idempotentReplayTransfer(new MoovError('x', 409, moovTransfer()), { amountCents: AMOUNT, metadata });
  assert.deepEqual([ok.replay, ok.ok, ok.transferId], [true, true, TRANSFER]);
  const text = idempotentReplayTransfer(new MoovError('x', 409, JSON.stringify(moovTransfer())), { amountCents: AMOUNT, metadata });
  assert.equal(text.ok, true);
  assert.equal(idempotentReplayTransfer(new Error('socket hang up'), { amountCents: AMOUNT, metadata }).replay, false);
  assert.equal(idempotentReplayTransfer(new MoovError('x', 500, moovTransfer()), { amountCents: AMOUNT, metadata }).replay, false);
  assert.equal(idempotentReplayTransfer(new MoovError('x', 409, { error: 'duplicate' }), { amountCents: AMOUNT, metadata }).replay, false);
  const other = idempotentReplayTransfer(new MoovError('x', 409, moovTransfer({ paymentId: ROLLED_BACK_OCCURRENCE })), { amountCents: AMOUNT, metadata });
  assert.deepEqual([other.ok, other.mismatches, other.paymentIdMismatch], [false, [], ROLLED_BACK_OCCURRENCE]);
  const euro = moovTransfer();
  euro.amount.currency = 'EUR';
  assert.deepEqual(idempotentReplayTransfer(new MoovError('x', 409, euro), { amountCents: AMOUNT, metadata }).mismatches, ['currency']);
});

test('withSavepoint: a rethrown failure leaves the transaction usable; outside a transaction block the statement runs directly', async () => {
  const client = pgTransaction({ failOn: [{ re: /^SELECT boom/, code: '23505', message: 'duplicate key' }] });
  const { lines } = await captureErrors(async () => {
    await assert.rejects(savepointQuery(client, 'probe_rethrow', 'SELECT boom'), (e) => e.code === '23505');
  });
  assert.equal(client.state.aborted, false);
  assert.deepEqual((await client.query('SELECT 1')).rows, []);
  assert.equal(JSON.parse(lines[0]).statement, 'probe_rethrow');
  await assert.rejects(withSavepoint(client, 'bad name; DROP', async () => null), /invalid_savepoint_name/);

  // No transaction block: SAVEPOINT is refused, the statement still runs once, with the fallback on failure.
  const queries = [];
  const autocommit = {
    async query(sql) {
      queries.push(sql);
      if (/^SAVEPOINT/.test(sql)) throw pgError('25P01', 'SAVEPOINT can only be used in transaction blocks');
      if (/^SELECT boom/.test(sql)) throw pgError('23505', 'duplicate key');
      return { rows: [{ ok: true }] };
    },
  };
  const { result } = await captureErrors(async () => [
    await savepointQuery(autocommit, 'probe_direct', 'SELECT 1', [], { fallback: { rows: [] } }),
    await savepointQuery(autocommit, 'probe_direct', 'SELECT boom', [], { fallback: { rows: [] } }),
  ]);
  assert.deepEqual(result, [{ rows: [{ ok: true }] }, { rows: [] }]);
  assert.deepEqual(queries, ['SAVEPOINT probe_direct', 'SELECT 1', 'SAVEPOINT probe_direct', 'SELECT boom']);
});

test('billing verification: a 409 replay of the same $1.00 verification debit is submitted; a different one fails closed', async () => {
  const saved = process.env.AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED;
  process.env.AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED = 'true';
  try {
    const occurrence = {
      id: OCCURRENCE, tenant_id: TENANT, status: 'due', idempotence_key: `billing-verify:${TENANT}:ver-1`,
    };
    const verification = (amount) => ({
      transferID: TRANSFER,
      status: 'created',
      amount: { currency: 'USD', value: amount },
      metadata: {
        checksops_kind: 'billing_verification',
        checksops_tenant_id: TENANT,
        checksops_verification_id: 'ver-1',
        checksops_payment_id: OCCURRENCE,
      },
    });
    const run = async (body) => {
      resetMoovTokenCache();
      const client = pgTransaction({ rows: (sql, params) => (/^UPDATE public\.tenant_maintenance_payments/.test(sql) ? { rows: [{ id: params[0], status: params[1], provider_transfer_id: params[2], failure_reason: params[3] }] } : null) });
      const moov = fakeMoov({ preexisting: body });
      const { result } = await captureErrors(() => submitVerificationOccurrence(client, {
        occurrence,
        readiness: { environment: 'sandbox', authorization: { tenant_id: TENANT, provider_payment_method_id: 'pm-bank', provider_account_id: 'acct-tenant' } },
        destination: { accountId: CHECKSOPS_SANDBOX_MERCHANT_ACCOUNT_ID, paymentMethodId: DEST_PM, environment: 'sandbox' },
        fetchImpl: moov.fetchImpl,
        deps: {
          simulate: false,
          verificationId: 'ver-1',
          moovContext: MOOV_CONTEXT,
          resolveBillingDebitSource: async () => ({ ok: true, sourceMethodId: 'debit-pm-bank', sourceAccountId: 'acct-tenant' }),
        },
      }));
      return { result, client };
    };
    const replayed = await run(verification(BILLING_VERIFICATION_AMOUNT_CENTS));
    assert.equal(replayed.result.ok, true);
    assert.equal(replayed.result.occurrence.status, 'submitted');
    assert.equal(replayed.result.occurrence.provider_transfer_id, TRANSFER);
    const writes = ran(replayed.client, MONEY_WRITE_RE);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].flag, '1');
    const different = await run(verification(BILLING_VERIFICATION_AMOUNT_CENTS + 1));
    assert.equal(different.result.ok, false);
    assert.equal(different.result.error, 'provider_idempotent_replay_mismatch');
    assert.equal(different.result.occurrence.status, 'failed');
  } finally {
    if (saved === undefined) delete process.env.AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED;
    else process.env.AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED = saved;
  }
});
