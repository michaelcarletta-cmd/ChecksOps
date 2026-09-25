import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  PAYEE_LINE_LOCKED,
  isCheckDeposited,
  rejectPayeeLineIfDeposited,
  resolveWritablePayeeLine,
} from '../functions/api/check-deposited.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECK_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const createClient = ({
  depositedAt = null,
  payeeLine = 'Original Payee',
  confirmed = false,
  missing = false,
} = {}) => {
  const statements = [];
  return {
    statements,
    query: async (sql) => {
      const text = String(sql);
      statements.push(text);
      if (/SAVEPOINT |RELEASE SAVEPOINT |ROLLBACK TO SAVEPOINT |set_config\(/.test(text)) {
        return { rows: [] };
      }
      if (/FROM public\.check_intake_items/.test(text) && /deposited_at/.test(text)) {
        if (missing) return { rows: [] };
        return { rows: [{ deposited_at: depositedAt, payee_line: payeeLine }] };
      }
      if (/FROM public\.aws_financial_operations/.test(text)) {
        return { rows: confirmed ? [{ found: 1 }] : [] };
      }
      return { rows: [] };
    },
  };
};

test('live check-deposited.mjs matches the pinned S14 hash', () => {
  const buf = readFileSync(path.join(ROOT, 'functions/api/check-deposited.mjs'));
  assert.equal(
    createHash('sha256').update(buf).digest('hex'),
    '395ddec5c88e2290fc72f2ab86ef2c934fe7654c7f2309a8176e1147ce32edf1',
  );
});

test('undeposited check allows a different payee_line write', async () => {
  const client = createClient();
  const resolved = await resolveWritablePayeeLine(client, CHECK_ID, 'New Payee');
  assert.equal(resolved.value, 'New Payee');
  assert.equal(resolved.locked, false);
  assert.equal(resolved.deposited, undefined);
});

test('deposited_at locks payee_line changes and keeps the current value', async () => {
  const client = createClient({ depositedAt: '2026-09-01T00:00:00Z' });
  const resolved = await resolveWritablePayeeLine(client, CHECK_ID, 'Attacker');
  assert.equal(resolved.value, null);
  assert.equal(resolved.locked, true);
  assert.equal(resolved.error, PAYEE_LINE_LOCKED);
  const rejected = await rejectPayeeLineIfDeposited(client, CHECK_ID, {
    current: 'Original Payee',
    next: 'Attacker',
  });
  assert.equal(rejected.locked, true);
  assert.equal(rejected.error, PAYEE_LINE_LOCKED);
});

test('same payee_line on a deposited check is a no-op, not a lock error', async () => {
  const client = createClient({ depositedAt: '2026-09-01T00:00:00Z' });
  const resolved = await resolveWritablePayeeLine(client, CHECK_ID, 'Original Payee');
  assert.equal(resolved.noop, true);
  assert.equal(resolved.locked, false);
  assert.equal(resolved.value, null);
});

test('confirmed provider deposit locks payee_line without deposited_at', async () => {
  const client = createClient({ confirmed: true });
  const state = await isCheckDeposited(client, CHECK_ID);
  assert.equal(state.deposited, true);
  assert.equal(state.reason, 'confirmed_provider_deposit');
  const resolved = await resolveWritablePayeeLine(client, CHECK_ID, 'Attacker');
  assert.equal(resolved.locked, true);
  assert.equal(resolved.value, null);
});

test('lookup failure fail-closes as deposited', async () => {
  const state = await isCheckDeposited(null, CHECK_ID);
  assert.equal(state.deposited, true);
  assert.equal(state.failClosed, true);
});
