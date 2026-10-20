// Double-send protection in email.mjs (handleSendTransactionalEmail, and handleSendEmail's logging),
// against an in-memory database that keeps the PostgreSQL behaviour the protection depends on:
// transaction-scoped advisory locks held until COMMIT/ROLLBACK, rows visible to other transactions
// only after COMMIT (READ COMMITTED), the email_send_log status CHECK
// (supabase/migrations/20260430101148_email_infra.sql), and a failed statement aborting the
// transaction (COMMIT then reports ROLLBACK) unless a savepoint is rolled back.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { handleSendEmail, handleSendTransactionalEmail } from '../functions/api/email.mjs';
import { LOOKUP_MAPPING_SQL } from '../functions/api/identity.mjs';

const APP_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const RECIPIENT = 'homeowner@checksops.invalid';
const TEMPLATE = 'homeowner-claim-portal-link';
const LOG_STATUSES = new Set(['pending', 'sent', 'suppressed', 'failed', 'bounced', 'complained', 'dlq']);

const jwtEvent = (body) => ({
  rawPath: '/email/send-transactional-email',
  headers: { authorization: 'Bearer test-id-token' },
  body: JSON.stringify(body),
  requestContext: {
    stage: 'staging',
    http: { method: 'POST', path: '/email/send-transactional-email' },
    authorizer: { jwt: { claims: { sub: COGNITO_SUB, email: 'mcarletta@freedomadj.com', token_use: 'id' } } },
  },
});

const sqlError = (code, message) => Object.assign(new Error(message), { code });

class FakeDb {
  constructor() {
    this.rows = [];
    this.locks = new Map();
    this.lockCalls = 0;
    this.failInsert = null;
    this.failUpdate = false;
    this.commits = [];
  }

  async acquire(key, owner) {
    for (;;) {
      const held = this.locks.get(key);
      if (!held || held.owner === owner) {
        this.locks.set(key, { owner, waiters: held?.waiters || [] });
        return;
      }
      await new Promise((resolve) => held.waiters.push(resolve));
    }
  }

  release(owner) {
    for (const [key, held] of [...this.locks]) {
      if (held.owner !== owner) continue;
      this.locks.delete(key);
      for (const wake of held.waiters) wake();
    }
  }

  client() {
    const db = this;
    const me = {};
    let tx = null;
    const begin = () => { tx = { inserts: [], updates: [], savepoints: [], aborted: false }; };
    const fail = (error) => { tx.aborted = true; throw error; };
    const visible = () => {
      const rows = [...db.rows, ...tx.inserts].map((row) => ({ ...row }));
      for (const update of tx.updates) Object.assign(rows.find((row) => row.id === update.id) || {}, update.patch);
      return rows;
    };
    const end = () => { db.release(me); tx = null; };
    me.connect = async () => {};
    me.end = async () => {};
    me.query = async (sql, params = []) => {
      const text = String(sql);
      if (text === 'BEGIN') { begin(); return { rows: [] }; }
      if (tx?.aborted && !/^ROLLBACK/.test(text)) {
        throw sqlError('25P02', 'current transaction is aborted, commands ignored until end of transaction block');
      }
      if (text === 'SET TRANSACTION READ WRITE') return { rows: [] };
      if (text === 'COMMIT') {
        if (tx.aborted) { db.commits.push('ROLLBACK'); end(); return { command: 'ROLLBACK', rows: [] }; }
        db.rows = visible();
        db.commits.push('COMMIT');
        end();
        return { command: 'COMMIT', rows: [] };
      }
      if (text === 'ROLLBACK') { db.commits.push('ROLLBACK'); end(); return { rows: [] }; }
      if (text.startsWith('SAVEPOINT ')) {
        tx.savepoints.push({ inserts: tx.inserts.length, updates: tx.updates.length });
        return { rows: [] };
      }
      if (text.startsWith('RELEASE SAVEPOINT ')) { tx.savepoints.pop(); return { rows: [] }; }
      if (text.startsWith('ROLLBACK TO SAVEPOINT ')) {
        const mark = tx.savepoints.at(-1);
        tx.inserts.length = mark.inserts;
        tx.updates.length = mark.updates;
        tx.aborted = false;
        return { rows: [] };
      }
      if (text.startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
      if (text === LOOKUP_MAPPING_SQL) {
        return { rows: [{ application_user_id: APP_ID, cognito_sub: COGNITO_SUB, email: 'mcarletta@freedomadj.com', status: 'active' }] };
      }
      if (text.includes('pg_advisory_xact_lock')) {
        db.lockCalls += 1;
        await db.acquire(params[0], me);
        return { rows: [{}] };
      }
      if (/FROM public\.email_send_log\s+WHERE idempotency_key = \$1/.test(text)) {
        const matches = visible().filter((row) => row.idempotency_key === params[0]);
        return { rows: matches.slice(-1) };
      }
      if (/INSERT INTO public\.email_send_log/.test(text)) {
        const row = {
          id: params[0], template_name: params[1], recipient_email: params[2], tenant_id: params[3], status: params[4],
          provider: params[5], provider_message_id: params[6], idempotency_key: params[7], error_message: params[8],
          metadata: JSON.parse(params[9]),
        };
        if (!LOG_STATUSES.has(row.status)) fail(sqlError('23514', `new row violates check constraint "email_send_log_status_check" (${row.status})`));
        if (db.failInsert?.(row)) fail(sqlError('42703', 'column "idempotency_key" does not exist'));
        tx.inserts.push(row);
        return { rows: [] };
      }
      if (/UPDATE public\.email_send_log/.test(text)) {
        if (!LOG_STATUSES.has(params[1])) fail(sqlError('23514', `new row violates check constraint "email_send_log_status_check" (${params[1]})`));
        if (db.failUpdate) fail(sqlError('57014', 'canceling statement due to statement timeout'));
        tx.updates.push({ id: params[0], patch: { status: params[1], provider_message_id: params[2], error_message: params[3], metadata: JSON.parse(params[4]) } });
        return { rows: [] };
      }
      return { rows: [] };
    };
    return me;
  }
}

const sinkMailer = (calls, { delayMs = 0, status = 'sunk' } = {}) => async ({ to }) => {
  calls.push(to);
  if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
  const list = Array.isArray(to) ? to : [to];
  return {
    mode: 'sink',
    results: list.map((email, i) => (status === 'failed'
      ? { to: email, delivery: 'sink_fallback', status: 'failed', error: 'ses down', policy: 'allowlist' }
      : { to: email, delivery: 'sink', status: 'sunk', messageId: `sink-${calls.length}-${i}`, policy: 'sink' })),
  };
};

const depsFor = (db, mailer) => ({
  createClient: () => db.client(),
  loadDatabaseCredentials: async () => ({
    username: 'checksops', password: 'unit-test-only-not-a-real-secret', host: 'db.example.internal', database: 'checksops',
  }),
  sendViaSesOrSink: mailer,
});

const send = (db, mailer, body) => handleSendTransactionalEmail(
  jwtEvent({ templateName: TEMPLATE, recipientEmail: RECIPIENT, ...body }),
  depsFor(db, mailer),
);

test('sequential requests with the same key: one send, one row, the second is a replay', async () => {
  const db = new FakeDb();
  const calls = [];
  const first = await send(db, sinkMailer(calls), { idempotencyKey: 'key-seq' });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.statusCode, 200);
  assert.equal(first.sunk, true);
  const second = await send(db, sinkMailer(calls), { idempotencyKey: 'key-seq' });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.idempotentReplay, true);
  assert.equal(second.status, 'sent');
  assert.equal(calls.length, 1);
  assert.equal(db.rows.length, 1);
  // A sink delivery is logged as 'sent' with metadata.delivery 'sink', never as 'sunk'.
  assert.equal(db.rows[0].status, 'sent');
  assert.equal(db.rows[0].metadata.delivery, 'sink');
  assert.equal(db.rows[0].idempotency_key, 'key-seq');
  assert.deepEqual(db.commits, ['COMMIT', 'COMMIT']);
});

test('parallel requests with the same key: the lock lets one send; the other waits and replays', async () => {
  const db = new FakeDb();
  const calls = [];
  const mailer = sinkMailer(calls, { delayMs: 25 });
  const results = await Promise.all([
    send(db, mailer, { idempotencyKey: 'key-par' }),
    send(db, mailer, { idempotencyKey: 'key-par' }),
  ]);
  assert.equal(calls.length, 1);
  assert.equal(results.filter((r) => r.idempotentReplay === true).length, 1, JSON.stringify(results));
  assert.ok(results.every((r) => r.ok === true && r.statusCode === 200), JSON.stringify(results));
  assert.equal(db.rows.length, 1);
  assert.equal(db.lockCalls, 2);
});

test('a pending reservation already committed for the key replays without a second send', async () => {
  const db = new FakeDb();
  db.rows.push({
    id: '0f0e0d0c-0b0a-4908-8706-050403020100', template_name: TEMPLATE, recipient_email: RECIPIENT, status: 'pending',
    idempotency_key: 'key-pending', provider_message_id: null, metadata: {},
  });
  const calls = [];
  const result = await send(db, sinkMailer(calls), { idempotencyKey: 'key-pending' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.idempotentReplay, true);
  assert.equal(result.status, 'pending');
  assert.equal(result.success, false);
  assert.equal(calls.length, 0);
  assert.equal(db.rows.length, 1);
});

test('a log failure after the send does not abort the request: it commits and returns 200', async () => {
  const db = new FakeDb();
  db.failUpdate = true;
  const calls = [];
  const result = await send(db, sinkMailer(calls), { idempotencyKey: 'key-logfail' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.statusCode, 200);
  assert.deepEqual(db.commits, ['COMMIT']);
  assert.equal(calls.length, 1);
  // The reservation committed, so a retry replays instead of sending again.
  assert.equal(db.rows.length, 1);
  assert.equal(db.rows[0].status, 'pending');
  db.failUpdate = false;
  const retry = await send(db, sinkMailer(calls), { idempotencyKey: 'key-logfail' });
  assert.equal(retry.idempotentReplay, true);
  assert.equal(calls.length, 1);
});

test('an unknown template with a key writes no row, takes no lock and sends nothing', async () => {
  const db = new FakeDb();
  const calls = [];
  const result = await send(db, sinkMailer(calls), { templateName: 'no-such-template', idempotencyKey: 'key-unknown' });
  assert.equal(result.statusCode, 400);
  assert.equal(result.error, 'unknown_template');
  assert.equal(calls.length, 0);
  assert.equal(db.rows.length, 0);
  assert.equal(db.lockCalls, 0);
});

test('a failed send for the key may be retried; it delivered nothing', async () => {
  const db = new FakeDb();
  const calls = [];
  const failed = await send(db, sinkMailer(calls, { status: 'failed' }), { idempotencyKey: 'key-retry' });
  assert.equal(failed.ok, true, JSON.stringify(failed));
  assert.equal(db.rows.at(-1).status, 'failed');
  const retried = await send(db, sinkMailer(calls), { idempotencyKey: 'key-retry' });
  assert.equal(retried.idempotentReplay, undefined, JSON.stringify(retried));
  assert.equal(calls.length, 2);
  assert.deepEqual(db.rows.map((row) => row.status), ['failed', 'sent']);
});

test('the same key for a different recipient or template is refused with 409 and sends nothing', async () => {
  const db = new FakeDb();
  const calls = [];
  await send(db, sinkMailer(calls), { idempotencyKey: 'key-conflict' });
  const other = await send(db, sinkMailer(calls), { idempotencyKey: 'key-conflict', recipientEmail: 'someone-else@checksops.invalid' });
  assert.equal(other.statusCode, 409);
  assert.equal(other.error, 'idempotency_key_conflict');
  assert.equal(calls.length, 1);
  assert.equal(db.rows.length, 1);
});

test('with a key, a reservation that cannot be written refuses (503) instead of sending', async () => {
  const db = new FakeDb();
  db.failInsert = (row) => row.status === 'pending';
  const calls = [];
  const result = await send(db, sinkMailer(calls), { idempotencyKey: 'key-noreserve' });
  assert.equal(result.statusCode, 503);
  assert.equal(result.error, 'idempotency_reservation_failed');
  assert.equal(calls.length, 0);
  assert.equal(db.rows.length, 0);
});

test('without a key: no lock and no lookup, and the send is logged once as before', async () => {
  const db = new FakeDb();
  const calls = [];
  const a = await send(db, sinkMailer(calls), {});
  const b = await send(db, sinkMailer(calls), {});
  assert.equal(a.ok && b.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(db.lockCalls, 0);
  assert.equal(db.rows.length, 2);
  assert.notEqual(db.rows[0].idempotency_key, db.rows[1].idempotency_key);
});

test('handleSendEmail in sink mode: its log rows no longer abort the request after the send', async () => {
  const db = new FakeDb();
  const calls = [];
  const result = await handleSendEmail(
    jwtEvent({ to: ['a@checksops.invalid', 'b@checksops.invalid'], subject: 'Hello', body: '<p>Hi</p>' }),
    depsFor(db, sinkMailer(calls)),
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.statusCode, 200);
  assert.deepEqual(db.commits, ['COMMIT']);
  assert.equal(calls.length, 1);
  assert.deepEqual(db.rows.map((row) => [row.status, row.metadata.delivery]), [['sent', 'sink'], ['sent', 'sink']]);
});
