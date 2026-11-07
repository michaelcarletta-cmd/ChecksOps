/**
 * Moov webhook bodies are not signed (security audit 2026-10-29): Moov's X-Signature covers
 * `timestamp|nonce|webhookID` only. These tests drive providers/webhooks.mjs with a fake database
 * and a fake Moov (no network, no AWS) and prove:
 *   - a genuine webhook is applied once, from what Moov returns;
 *   - the receipt key is the Moov event (body eventID bound to its type and resource), not the
 *     signed X-Webhook-ID, which repeats across events (production 2026-10-31..11-06: ~100
 *     accepted deliveries, 2 receipt rows): two events under one X-Webhook-ID are both stored and
 *     applied, and a redelivery of one event is a duplicate whatever its X-Webhook-ID;
 *   - a forged body under replayed signed headers is applied only as Moov's own record and cannot
 *     suppress a later genuine event;
 *   - signature failures are still 401 and store nothing;
 *   - Collection V2 settlement matches a transfer id exactly, not as a substring of notes.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { handleProviderWebhook, moovReceiptKey } from '../functions/api/providers/webhooks.mjs';
import { hmacHex } from '../functions/api/providers/hmac.mjs';
import { TRANSFER_STATUS_WRITER_SQL } from '../functions/api/providers/moov-transfer-webhook.mjs';
import {
  confirmMoovWebhookPayload,
  moovWebhookResource,
  trustedMoovPayload,
} from '../functions/api/providers/moov-webhook-confirm.mjs';
import { applyBillingProviderEvent } from '../functions/api/tenant-collection-v2-settlement.mjs';
import { resetMoovTokenCache } from '../functions/api/providers/parity/moov-client.mjs';

const SECRET = 'moov-webhook-secret';
const PLATFORM = 'platform-prod';
const TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const TRANSFER = '55555555-5555-4555-8555-555555555555';
const OBLIGATION = '66666666-6666-4666-8666-666666666666';
const SECRETS = { MOOV_WEBHOOK_SECRET: SECRET, MOOV_PUBLIC_KEY: 'pk', MOOV_SECRET_KEY: 'sk', MOOV_ACCOUNT_ID: PLATFORM };
const PRODUCTION_ENV = {
  CHECKSOPS_ENV: 'production',
  AWS_PROVIDER_EXECUTION_ENABLED: 'true',
  AWS_MOOV_ENABLED: 'true',
  AWS_PROVIDER_WEBHOOK_DRY_RUN: 'false',
  AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'false',
  AWS_FINANCIAL_PERMISSIONS_ACTIVATED: 'true',
  AWS_MOOV_ONBOARDING_PRODUCTION_ENABLED: undefined,
};

const withEnv = async (vars, fn) => {
  const previous = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.warn = originalWarn;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

/** Moov as the route reads it back. `records` maps a path suffix to a JSON body or an HTTP status. */
function fakeMoov(records = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.endsWith('/oauth2/token')) return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'tok', expires_in: 300 }) };
    const key = Object.keys(records).find((suffix) => u.endsWith(suffix));
    const value = key ? records[key] : 404;
    if (typeof value === 'number') return { ok: false, status: value, text: async () => '{}' };
    return { ok: true, status: 200, text: async () => JSON.stringify(value) };
  };
  return { calls, reads: () => calls.filter((u) => !u.endsWith('/oauth2/token')), fetchImpl };
}

/**
 * A fake webhook database: receipts are unique per (provider, external_event_id) across
 * deliveries, as aws_provider_webhook_receipts is. Every statement is recorded.
 */
function fakeDatabase({ writerResult = { outcome: 'applied', transfer_id: TRANSFER, tenant_id: TENANT, new_status: 'returned' }, obligation = null } = {}) {
  const receipts = new Map();
  const statements = [];
  const state = { obligation: obligation ? { ...obligation } : null };
  const newClient = () => {
    const pending = [];
    const client = {
      connect: async () => {},
      end: async () => {},
      query: async (sql, params = []) => {
        const s = String(sql);
        statements.push({ sql: s, params });
        if (s === 'COMMIT') { for (const [k, v] of pending) receipts.set(k, v); return { rows: [] }; }
        if (s.includes('INSERT INTO public.aws_provider_webhook_receipts')) {
          const key = `${params[0]}|${params[1]}`;
          if (receipts.has(key) || pending.some(([k]) => k === key)) return { rows: [] };
          const row = { id: `receipt-${receipts.size + 1}`, provider: params[0], external_event_id: params[1] };
          pending.push([key, row]);
          return { rows: [row] };
        }
        if (s.includes('FROM public.aws_provider_webhook_receipts')) {
          return { rows: [receipts.get(`${params[0]}|${params[1]}`)].filter(Boolean) };
        }
        if (s === TRANSFER_STATUS_WRITER_SQL) return { rows: [{ result: writerResult }] };
        if (s.includes('SELECT id, tenant_id, capabilities, verification_status, disabled')) {
          return { rows: [{ id: 'ppa-1', tenant_id: TENANT, capabilities: [{ capability: 'transfers', status: 'pending' }], verification_status: 'pending', disabled: false }] };
        }
        if (s.includes('FROM public.tenant_maintenance_payments') && s.includes('provider_transfer_id = $1')) {
          return { rows: state.obligation?.provider_transfer_id === params[0] ? [state.obligation] : [] };
        }
        if (s.includes('UPDATE public.tenant_maintenance_payments')) {
          if (state.obligation?.id === params[0]) state.obligation = { ...state.obligation, status: params[1] };
          return { rows: state.obligation ? [state.obligation] : [] };
        }
        return { rows: [] };
      },
    };
    return client;
  };
  return { receipts, statements, state, newClient };
}

/** One delivery: Moov's signed headers (webhookId, nonce, timestamp) and any body. */
function signedEvent({ webhookId, nonce = `n-${webhookId}`, timestamp = String(Math.floor(Date.now() / 1000)) }, body) {
  return {
    rawPath: '/webhooks/moov',
    headers: {
      'x-webhook-id': webhookId,
      'x-timestamp': timestamp,
      'x-nonce': nonce,
      'x-signature': hmacHex(SECRET, `${timestamp}|${nonce}|${webhookId}`, 'sha512'),
    },
    body: JSON.stringify(body),
    requestContext: { stage: 'production', http: { method: 'POST', path: '/webhooks/moov' } },
  };
}

const deliver = (db, moov, event) => handleProviderWebhook(event, 'moov', {
  loadProviderSecrets: async () => SECRETS,
  loadDatabaseCredentials: async () => ({ host: 'localhost', username: 'checksops', password: 'x', database: 'checksops' }),
  createClient: () => db.newClient(),
  fetchImpl: moov.fetchImpl,
});

const writerCalls = (db) => db.statements.filter((s) => s.sql === TRANSFER_STATUS_WRITER_SQL);
const RETURNED_AT_MOOV = {
  transferID: 'tr_prod_1',
  status: 'failed',
  source: { account: { accountID: 'acct-tenant' }, achDetails: { status: 'returned', return: { code: 'R01', reason: 'Insufficient funds' } } },
  destination: { account: { accountID: PLATFORM } },
};

const keyOf = (body) => moovReceiptKey(body, JSON.stringify(body));

test('a genuine transfer webhook is applied once, from Moov; a redelivery of the same event is a duplicate and reads nothing', async () => {
  resetMoovTokenCache();
  await withEnv(PRODUCTION_ENV, async () => {
    const db = fakeDatabase();
    const moov = fakeMoov({ [`/accounts/${PLATFORM}/transfers/tr_prod_1`]: RETURNED_AT_MOOV });
    const headers = { webhookId: 'wh-genuine-1' };
    const body = { eventID: 'evt-1', type: 'transfer.updated', accountID: 'acct-tenant', data: { transferID: 'tr_prod_1', status: 'failed' } };
    const first = await deliver(db, moov, signedEvent(headers, body));
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.applied, true);
    assert.equal(first.liveProviderCalled, true);
    assert.deepEqual(first.provider_confirmation, { ok: true, resource: 'transfer', skipped: null });
    assert.deepEqual(moov.reads(), [`https://api.moov.io/accounts/${PLATFORM}/transfers/tr_prod_1`]);
    const [writer] = writerCalls(db);
    // environment, transfer, status, Moov status, event id (the receipt key), type, return code
    assert.deepEqual(writer.params.slice(0, 7), ['production', 'tr_prod_1', 'returned', 'failed', keyOf(body), 'transfer.updated', 'R01']);
    assert.deepEqual([...db.receipts.keys()], [`moov|${keyOf(body)}`]);

    // Moov redelivers the same event: a duplicate whether or not it reuses the X-Webhook-ID.
    for (const redelivery of [headers, { webhookId: 'wh-genuine-1-retry' }]) {
      const again = await deliver(db, moov, signedEvent(redelivery, body));
      assert.equal(again.ok, true);
      assert.equal(again.duplicate, true);
      assert.equal(again.apply_skipped, 'duplicate');
      assert.equal(again.collection_v2_settlement.skipped, 'duplicate');
    }
    assert.equal(db.receipts.size, 1);
    assert.equal(writerCalls(db).length, 1);
    assert.equal(moov.reads().length, 1);
  });
});

test('two different events under the same X-Webhook-ID are both stored and both applied (the production bug)', async () => {
  resetMoovTokenCache();
  await withEnv(PRODUCTION_ENV, async () => {
    const db = fakeDatabase();
    const moov = fakeMoov({
      [`/accounts/${PLATFORM}/transfers/tr_prod_1`]: RETURNED_AT_MOOV,
      [`/accounts/${PLATFORM}/transfers/tr_prod_2`]: { transferID: 'tr_prod_2', status: 'completed', completedOn: '2026-11-02T15:00:00Z' },
    });
    // Moov's X-Webhook-ID repeated across every delivery in production; each delivery has its own nonce.
    const first = { eventID: 'evt-p1', type: 'transfer.updated', data: { transferID: 'tr_prod_1', status: 'failed' } };
    const second = { eventID: 'evt-p2', type: 'transfer.updated', data: { transferID: 'tr_prod_2', status: 'completed' } };
    const third = { eventID: 'evt-p3', type: 'transfer.updated', data: { transferID: 'tr_prod_1', status: 'failed' } };
    const results = [];
    for (const [i, body] of [first, second, third].entries()) {
      results.push(await deliver(db, moov, signedEvent({ webhookId: 'wh-subscription', nonce: `n-${i}` }, body)));
    }
    for (const result of results) {
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.duplicate, false);
      assert.equal(result.liveProviderCalled, true);
    }
    assert.equal(results[0].applied, true);
    assert.equal(results[1].applied, true);
    assert.deepEqual([...db.receipts.keys()], [first, second, third].map((b) => `moov|${keyOf(b)}`));
    const writes = writerCalls(db).map((w) => [w.params[1], w.params[2], w.params[4]]);
    assert.deepEqual(writes, [
      ['tr_prod_1', 'returned', keyOf(first)],
      ['tr_prod_2', 'completed', keyOf(second)],
      ['tr_prod_1', 'returned', keyOf(third)],
    ]);
    assert.equal(writerCalls(db)[1].params[10], '2026-11-02T15:00:00.000Z');
  });
});

test('a forged body under replayed signed headers is read back from Moov and cannot suppress a later genuine event', async () => {
  resetMoovTokenCache();
  await withEnv(PRODUCTION_ENV, async () => {
    const db = fakeDatabase({ writerResult: { outcome: 'unchanged' } });
    const moov = fakeMoov({
      [`/accounts/${PLATFORM}/transfers/tr_prod_1`]: RETURNED_AT_MOOV,
      [`/accounts/${PLATFORM}/transfers/tr_victim`]: { transferID: 'tr_victim', status: 'pending' },
    });
    const headers = { webhookId: 'wh-replayed', nonce: 'n-fixed', timestamp: String(Math.floor(Date.now() / 1000)) };
    const genuine = { eventID: 'evt-a', type: 'transfer.updated', data: { transferID: 'tr_prod_1', status: 'failed' } };
    await deliver(db, moov, signedEvent(headers, genuine));
    // Same headers (still inside the 5-minute window), new body, new body eventID: a receipt of its own,
    // and the only write is what Moov says about tr_victim (pending), never the body's completed.
    const forged = await deliver(db, moov, signedEvent(headers, {
      eventID: 'evt-forged', type: 'transfer.completed', data: { transferID: 'tr_victim', status: 'completed', completedOn: '2026-11-01T00:00:00Z' },
    }));
    assert.equal(forged.ok, true);
    assert.equal(forged.duplicate, false);
    const victimWrite = writerCalls(db).find((w) => w.params[1] === 'tr_victim');
    assert.deepEqual([victimWrite.params[2], victimWrite.params[3], victimWrite.params[10]], ['pending', 'pending', null]);
    // A forged body that reuses a genuine eventID with another type or resource is a different key:
    // the genuine event, delivered after it, is still stored and applied.
    const later = { eventID: 'evt-b', type: 'transfer.updated', data: { transferID: 'tr_prod_1', status: 'failed' } };
    const squat = await deliver(db, moov, signedEvent(headers, { ...later, data: { transferID: 'tr_victim' } }));
    assert.equal(squat.duplicate, false);
    const squatType = await deliver(db, moov, signedEvent(headers, { ...later, type: 'transfer.created' }));
    assert.equal(squatType.duplicate, false);
    const genuineLater = await deliver(db, moov, signedEvent({ webhookId: 'wh-replayed', nonce: 'n-later' }, later));
    assert.equal(genuineLater.ok, true);
    assert.equal(genuineLater.duplicate, false);
    assert.equal(genuineLater.apply_skipped, 'unchanged');
    const last = writerCalls(db).at(-1);
    assert.deepEqual([last.params[1], last.params[2], last.params[4]], ['tr_prod_1', 'returned', keyOf(later)]);
    assert.ok(db.receipts.has(`moov|${keyOf(later)}`));
  });
});

test('a body under signed headers never seen before is applied only as Moov\'s record, never the body\'s status', async () => {
  resetMoovTokenCache();
  await withEnv(PRODUCTION_ENV, async () => {
    const db = fakeDatabase({ writerResult: { outcome: 'unchanged' } });
    // Moov says the transfer is still pending; the body claims it completed.
    const moov = fakeMoov({ [`/accounts/${PLATFORM}/transfers/tr_victim`]: { transferID: 'tr_victim', status: 'pending' } });
    const result = await deliver(db, moov, signedEvent({ webhookId: 'wh-unseen' }, {
      eventID: 'evt-x', type: 'transfer.completed', data: { transferID: 'tr_victim', status: 'completed', completedOn: '2026-10-31T00:00:00Z' },
    }));
    assert.equal(result.ok, true);
    const [writer] = writerCalls(db);
    assert.equal(writer.params[1], 'tr_victim');
    assert.equal(writer.params[2], 'pending');
    assert.equal(writer.params[3], 'pending');
    assert.equal(writer.params[10], null, 'no completion time from the body');
    // Collection V2 sees Moov's pending: nothing to settle.
    assert.equal(result.collection_v2_settlement.skipped, 'unmapped_status');
    assert.ok(!db.statements.some((s) => s.sql.includes('UPDATE public.tenant_maintenance_payments')));
  });
});

test('a forged settled body does not settle a Collection V2 obligation; Moov\'s completed does', async () => {
  const obligation = {
    id: OBLIGATION, tenant_id: TENANT, status: 'submitted', amount_cents: 13900, provider_environment: 'production',
    provider_transfer_id: 'tr_fee_1', occurrence_kind: 'monthly_subscription', notes: 'Moov ACH pull (monthly_subscription) for 2026-10 · moov:tr_fee_1',
  };
  for (const [moovStatus, expected] of [['pending', null], ['completed', 'settled']]) {
    resetMoovTokenCache();
    await withEnv(PRODUCTION_ENV, async () => {
      const db = fakeDatabase({ obligation });
      const moov = fakeMoov({ [`/accounts/${PLATFORM}/transfers/tr_fee_1`]: { transferID: 'tr_fee_1', status: moovStatus } });
      const result = await deliver(db, moov, signedEvent({ webhookId: `wh-fee-${moovStatus}` }, {
        eventID: 'evt-fee', type: 'transfer.completed', data: { transferID: 'tr_fee_1', status: 'completed' },
      }));
      assert.equal(result.ok, true, JSON.stringify(result));
      const update = db.statements.find((s) => s.sql.includes('UPDATE public.tenant_maintenance_payments'));
      if (expected === null) {
        assert.equal(update, undefined, moovStatus);
        assert.equal(db.state.obligation.status, 'submitted');
      } else {
        assert.equal(update.params[1], expected);
        assert.equal(db.state.obligation.status, 'settled');
      }
    });
  }
});

test('the receipt key is the Moov event (eventID, type, resource), never the X-Webhook-ID; it fits the table and never matches a legacy key', async () => {
  resetMoovTokenCache();
  await withEnv(PRODUCTION_ENV, async () => {
    const db = fakeDatabase();
    const moov = fakeMoov({ [`/accounts/${PLATFORM}/transfers/tr_prod_1`]: RETURNED_AT_MOOV });
    const body = { eventID: 'evt-shared', type: 'transfer.updated', data: { transferID: 'tr_prod_1' } };
    const a = await deliver(db, moov, signedEvent({ webhookId: 'wh-a' }, body));
    const b = await deliver(db, moov, signedEvent({ webhookId: 'wh-b' }, body));
    assert.equal(a.duplicate, false);
    assert.equal(b.duplicate, true);
    assert.deepEqual([...db.receipts.keys()], [`moov|${keyOf(body)}`]);
    const inserted = db.statements.filter((s) => s.sql.includes('INSERT INTO public.aws_provider_webhook_receipts')).map((s) => s.params[1]);
    assert.deepEqual(inserted, [keyOf(body), keyOf(body)]);
    assert.ok(!inserted.some((k) => k.includes('wh-a') || k.includes('wh-b')));
  });
  // Format: evt:<eventID>:<64 hex>; the same event whatever the status text or key order of the body.
  const key = keyOf({ eventID: 'b31c7752-031f-4b8b-9b6e-82dd0aaed2cb', type: 'transfer.updated', data: { transferID: 'tr_1', status: 'completed' } });
  assert.match(key, /^evt:b31c7752-031f-4b8b-9b6e-82dd0aaed2cb:[0-9a-f]{64}$/);
  assert.equal(keyOf({ data: { status: 'pending', transferID: 'tr_1' }, type: 'transfer.updated', eventID: 'b31c7752-031f-4b8b-9b6e-82dd0aaed2cb' }), key);
  // Bound to the type and every resource id the confirmation reads.
  for (const other of [
    { eventID: 'b31c7752-031f-4b8b-9b6e-82dd0aaed2cb', type: 'transfer.created', data: { transferID: 'tr_1' } },
    { eventID: 'b31c7752-031f-4b8b-9b6e-82dd0aaed2cb', type: 'transfer.updated', data: { transferID: 'tr_2' } },
    { eventID: 'b31c7752-031f-4b8b-9b6e-82dd0aaed2cb', type: 'transfer.updated', accountID: 'acct', data: { transferID: 'tr_1' } },
    { eventID: 'other', type: 'transfer.updated', data: { transferID: 'tr_1' } },
  ]) assert.notEqual(keyOf(other), key, JSON.stringify(other));
  assert.notEqual(
    keyOf({ eventID: 'e', type: 'capability.updated', accountID: 'a', data: { capabilityID: 'transfers' } }),
    keyOf({ eventID: 'e', type: 'capability.updated', accountID: 'a', data: { capabilityID: 'wallet' } }),
  );
  assert.notEqual(
    keyOf({ eventID: 'e', type: 'bankAccount.updated', accountID: 'a', data: { bankAccountID: 'b1' } }),
    keyOf({ eventID: 'e', type: 'bankAccount.updated', accountID: 'a', data: { bankAccountID: 'b2' } }),
  );
  // The longest accepted eventID stays inside the 200 characters SQL 109 keeps; external_event_id is text.
  assert.equal(keyOf({ eventID: 'x'.repeat(120), type: 'transfer.updated', data: { transferID: 'tr_1' } }).length, 189);
  // No usable eventID: the raw body's sha256 (an identical redelivery is still a duplicate).
  for (const body of [{ type: 'balance.updated' }, { eventID: 'x'.repeat(121), type: 't' }, { eventID: 'a b', type: 't' }, { eventID: { $ne: 1 }, type: 't' }]) {
    assert.match(keyOf(body), /^body:[0-9a-f]{64}$/, JSON.stringify(body));
  }
  assert.equal(moovReceiptKey({}, '{"type":"balance.updated"}'), moovReceiptKey({}, '{"type":"balance.updated"}'));
  // Keys stored before this change are the bare X-Webhook-ID (a uuid); the new forms never equal one.
  assert.ok(!/^[0-9a-f-]{36}$/.test(key));
});

test('signature failures are still 401 and store nothing', async () => {
  resetMoovTokenCache();
  await withEnv(PRODUCTION_ENV, async () => {
    const db = fakeDatabase();
    const moov = fakeMoov({ [`/accounts/${PLATFORM}/transfers/tr_prod_1`]: RETURNED_AT_MOOV });
    const body = { eventID: 'evt-sig', type: 'transfer.updated', data: { transferID: 'tr_prod_1' } };
    const good = signedEvent({ webhookId: 'wh-sig' }, body);
    const cases = {
      invalid_signature: { ...good, headers: { ...good.headers, 'x-signature': 'f'.repeat(128) } },
      tampered_webhook_id: { ...good, headers: { ...good.headers, 'x-webhook-id': 'wh-other' } },
      stale_timestamp: signedEvent({ webhookId: 'wh-sig', timestamp: String(Math.floor(Date.now() / 1000) - 3600) }, body),
      missing_signature_headers: { ...good, headers: { 'x-webhook-id': 'wh-sig' } },
    };
    for (const [name, event] of Object.entries(cases)) {
      const result = await deliver(db, moov, event);
      assert.equal(result.ok, false, name);
      assert.equal(result.statusCode, 401, name);
      assert.equal(result.error, name === 'missing_signature_headers' ? 'missing_signature_headers' : 'invalid_signature', name);
    }
    assert.equal(db.statements.length, 0);
    assert.equal(db.receipts.size, 0);
    assert.equal(moov.calls.length, 0);
  });
});

test('a resource Moov does not know is not applied; a Moov outage rolls the receipt back and answers 503', async () => {
  resetMoovTokenCache();
  await withEnv(PRODUCTION_ENV, async () => {
    const db = fakeDatabase();
    const missing = await deliver(db, fakeMoov({}), signedEvent({ webhookId: 'wh-missing' }, {
      type: 'transfer.completed', data: { transferID: 'tr_made_up', status: 'completed' },
    }));
    assert.equal(missing.ok, true);
    assert.equal(missing.applied, false);
    assert.equal(missing.apply_skipped, 'moov_resource_not_found');
    assert.equal(missing.collection_v2_settlement.skipped, 'moov_resource_not_found');
    assert.equal(writerCalls(db).length, 0);

    const outage = fakeDatabase();
    const down = await deliver(outage, fakeMoov({ [`/accounts/${PLATFORM}/transfers/tr_prod_1`]: 503 }), signedEvent({ webhookId: 'wh-down' }, {
      type: 'transfer.updated', data: { transferID: 'tr_prod_1', status: 'failed' },
    }));
    assert.equal(down.ok, false);
    assert.equal(down.statusCode, 503);
    assert.equal(down.error, 'provider_confirmation_unavailable');
    assert.ok(outage.statements.some((s) => s.sql === 'ROLLBACK'));
    assert.ok(!outage.statements.some((s) => s.sql === 'COMMIT'));
    assert.equal(outage.receipts.size, 0);
    assert.equal(writerCalls(outage).length, 0);
  });
});

test('without production Moov credentials nothing is applied (fail closed), and dry-run reads nothing', async () => {
  resetMoovTokenCache();
  await withEnv(PRODUCTION_ENV, async () => {
    const db = fakeDatabase();
    const moov = fakeMoov({ [`/accounts/${PLATFORM}/transfers/tr_prod_1`]: RETURNED_AT_MOOV });
    const result = await handleProviderWebhook(signedEvent({ webhookId: 'wh-nocreds' }, {
      type: 'transfer.updated', data: { transferID: 'tr_prod_1', status: 'failed' },
    }), 'moov', {
      loadProviderSecrets: async () => ({ MOOV_WEBHOOK_SECRET: SECRET }),
      loadDatabaseCredentials: async () => ({}),
      createClient: () => db.newClient(),
      fetchImpl: moov.fetchImpl,
    });
    assert.equal(result.ok, true);
    assert.equal(result.applied, false);
    assert.equal(result.apply_skipped, 'provider_confirmation_unconfigured');
    assert.equal(writerCalls(db).length, 0);
    assert.equal(moov.calls.length, 0);
  });
  await withEnv({ ...PRODUCTION_ENV, AWS_PROVIDER_WEBHOOK_DRY_RUN: 'true' }, async () => {
    const db = fakeDatabase();
    const moov = fakeMoov({ [`/accounts/${PLATFORM}/transfers/tr_prod_1`]: RETURNED_AT_MOOV });
    const result = await deliver(db, moov, signedEvent({ webhookId: 'wh-dry' }, { type: 'transfer.updated', data: { transferID: 'tr_prod_1' } }));
    assert.equal(result.applied, false);
    assert.equal(result.collection_v2_settlement.skipped, 'dry_run');
    assert.equal(moov.calls.length, 0);
    assert.equal(writerCalls(db).length, 0);
  });
});

test('onboarding: the account status written is Moov\'s, not the body\'s', async () => {
  resetMoovTokenCache();
  await withEnv({ ...PRODUCTION_ENV, AWS_MOOV_ONBOARDING_PRODUCTION_ENABLED: 'true' }, async () => {
    const db = fakeDatabase();
    const moov = fakeMoov({
      '/accounts/acct-tenant': { accountID: 'acct-tenant', verification: { verificationStatus: 'pending' } },
      '/accounts/acct-tenant/capabilities': [{ capability: 'transfers', status: 'pending' }],
    });
    const result = await deliver(db, moov, signedEvent({ webhookId: 'wh-acct' }, {
      type: 'capability.updated', accountID: 'acct-tenant',
      data: { accountID: 'acct-tenant', capabilityID: 'transfers', status: 'enabled', verification: { verificationStatus: 'verified' } },
    }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(moov.reads(), ['https://api.moov.io/accounts/acct-tenant', 'https://api.moov.io/accounts/acct-tenant/capabilities']);
    assert.equal(result.applied, true);
    const update = db.statements.find((st) => st.sql.includes('UPDATE public.payment_provider_accounts SET'));
    // capabilities, verification and onboarding status are Moov's (pending), not the body's (enabled / verified)
    assert.deepEqual(JSON.parse(update.params[1]), [{ capability: 'transfers', status: 'pending' }]);
    assert.equal(update.params[2], 'pending');
    assert.notEqual(update.params[3], 'active');
  });
});

test('confirmation: only the resource id and event type come from the body; ids are restricted', async () => {
  assert.deepEqual(moovWebhookResource({ type: 'transfer.updated', data: { transferID: 'tr_1', status: 'completed' } }),
    { kind: 'transfer', eventType: 'transfer.updated', transferId: 'tr_1', accountId: null });
  assert.equal(moovWebhookResource({ type: 'transfer.updated', data: { transferID: '../accounts/x' } }).kind, 'none');
  assert.equal(moovWebhookResource({ type: 'account.updated' }).kind, 'none');
  assert.equal(moovWebhookResource({ type: 'bankAccount.updated', accountID: 'a', data: {} }).kind, 'none');
  assert.equal(moovWebhookResource({ type: 'something.else', accountID: 'a' }).kind, 'none');
  // The body's status, return code and account never survive; Moov's record replaces data.
  const trusted = trustedMoovPayload(
    { kind: 'transfer', eventType: 'transfer.completed', transferId: 'tr_1', accountId: 'acct-forged' },
    { transfer: { transferID: 'tr_1', status: 'pending', source: { account: { accountID: 'acct-real' } } } },
  );
  assert.deepEqual(trusted, {
    type: 'transfer.completed',
    accountID: null,
    data: { transferID: 'tr_1', status: 'pending', source: { account: { accountID: 'acct-real' } } },
  });
  const unconfirmable = await confirmMoovWebhookPayload({ type: 'ping' }, { environment: 'production' });
  assert.deepEqual(unconfirmable, { ok: false, skipped: 'unconfirmable_event', liveProviderCalled: false });
  // Moov answering for another transfer is refused.
  resetMoovTokenCache();
  await withEnv({ CHECKSOPS_ENV: 'production' }, async () => {
    const moov = fakeMoov({ '/transfers/tr_1': { transferID: 'tr_2', status: 'completed' } });
    const out = await confirmMoovWebhookPayload({ type: 'transfer.updated', data: { transferID: 'tr_1' } }, {
      environment: 'production', secrets: SECRETS, fetchImpl: moov.fetchImpl,
    });
    assert.deepEqual(out, { ok: false, skipped: 'moov_resource_mismatch', liveProviderCalled: true });
  });
  // Off the production runtime, production keys are never used.
  await withEnv({ CHECKSOPS_ENV: 'staging' }, async () => {
    const out = await confirmMoovWebhookPayload({ type: 'transfer.updated', data: { transferID: 'tr_1' } }, {
      environment: 'production', secrets: SECRETS, fetchImpl: async () => { throw new Error('no call expected'); },
    });
    assert.equal(out.skipped, 'provider_confirmation_unconfigured');
  });
});

test('settlement: a transfer id that is a substring of another obligation\'s notes token does not match', async () => {
  const notesObligation = {
    id: OBLIGATION, tenant_id: TENANT, status: 'submitted', amount_cents: 13900, provider_environment: 'production',
    provider_transfer_id: null, occurrence_kind: 'monthly_subscription',
    notes: 'Moov ACH pull (monthly_subscription) for 2026-10 · moov:tr_12345 · collection_v2:{}',
  };
  const run = async (transferId) => {
    const queries = [];
    let obligation = { ...notesObligation };
    const client = {
      query: async (sql, params = []) => {
        queries.push({ sql, params });
        if (sql.includes('FROM public.tenant_maintenance_payments') && sql.includes('string_to_array')) {
          // Postgres: ('moov:' || $1) = ANY (string_to_array(COALESCE(notes, ''), ' · '))
          const tokens = String(obligation.notes ?? '').split(' · ');
          return { rows: tokens.includes(`moov:${params[0]}`) ? [obligation] : [] };
        }
        if (sql.includes('UPDATE public.tenant_maintenance_payments')) {
          obligation = { ...obligation, status: params[1] };
          return { rows: [obligation] };
        }
        return { rows: [] };
      },
    };
    const out = await applyBillingProviderEvent(client, { providerTransferId: transferId, status: 'completed', environment: 'production' });
    return { out, queries, obligation };
  };
  for (const id of ['tr_1', 'tr_1234', '12345', 'tr_%', 'tr__2345']) {
    const { out, queries, obligation } = await run(id);
    assert.equal(out.applied, false, id);
    assert.equal(out.skipped, 'no_billing_occurrence', id);
    assert.equal(obligation.status, 'submitted', id);
    const notesQuery = queries.find((q) => q.sql.includes('string_to_array'));
    // The id is a bound value, never a pattern.
    assert.deepEqual(notesQuery.params, [id]);
    assert.ok(!queries.some((q) => /\bLIKE\b/.test(q.sql)), id);
  }
  const exact = await run('tr_12345');
  assert.equal(exact.out.applied, true);
  assert.equal(exact.obligation.status, 'settled');
});
