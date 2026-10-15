import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runHomeownerLedgerSend } from '../functions/api/homeowner.mjs';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_CLAIM = '22222222-2222-4222-8222-222222222222';
const CLAIM = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';
const mapping = { application_user_id: USER };
const spoof = {};

/** Mock pg client: member/role/claim answers are configurable; records every query. */
const client = ({ member = true, actor = true, claimOwned = true } = {}) => {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      const text = String(sql);
      queries.push({ text, params });
      if (text.includes('FROM public.tenant_users') && text.includes('lower(role::text)')) {
        return { rows: actor ? [{ '?column?': 1 }] : [] };
      }
      if (text.includes('FROM public.tenant_users')) return { rows: member ? [{ '?column?': 1 }] : [] };
      if (text.includes('FROM public.claims c')) return { rows: claimOwned ? [{ '?column?': 1 }] : [] };
      if (text.includes('INSERT INTO public.homeowner_ledger_tokens')) return { rows: [{ id: 't1', token: 'tok' }] };
      return { rows: [] };
    },
  };
};

const sent = [];
const send = async (msg) => { sent.push(msg); return { ok: true }; };
const run = (body, c = client()) => runHomeownerLedgerSend({
  client: c, mapping, spoof, send, body: { homeowner_email: 'home@example.com', tenant_id: TENANT, rotate: true, ...body },
});

test('a pre-claim upload link reuses only unclaimed tokens, never another claim\'s tracking link', async () => {
  const c = client();
  const result = await run({ claim_id: null, rotate: false }, c);
  assert.equal(result.ok, true);
  assert.ok(!c.queries.some((q) => q.text.includes('FROM public.claims c')));
  const reuse = c.queries.find((q) => q.text.includes('FROM public.homeowner_ledger_tokens'));
  assert.match(reuse.text, /claim_id IS NOT DISTINCT FROM \$2::uuid/);
  assert.doesNotMatch(reuse.text, /\$2::uuid IS NULL OR/);
  assert.deepEqual(reuse.params, [TENANT, null]);
  assert.equal((await run({ claim_id: 'not-a-uuid' })).error, 'invalid_claim_id');
  assert.equal((await run({ claim_id: CLAIM, tenant_id: 'x' })).error, 'invalid_tenant_id');
});

test('viewers and partners cannot send pre-claim upload links either', async () => {
  const result = await run({ claim_id: null }, client({ actor: false }));
  assert.equal(result.error, 'role_not_allowed');
});

test('another tenant\'s claim is refused before any token is created or sent', async () => {
  const c = client({ claimOwned: false });
  const before = sent.length;
  const result = await run({ claim_id: OTHER_CLAIM }, c);
  assert.equal(result.statusCode, 403);
  assert.equal(result.error, 'claim_not_in_tenant');
  assert.equal(sent.length, before);
  assert.ok(!c.queries.some((q) => q.text.includes('homeowner_ledger_tokens')));
  const ownership = c.queries.find((q) => q.text.includes('FROM public.claims c'));
  assert.deepEqual(ownership.params, [OTHER_CLAIM, TENANT]);
});

test('viewers and partners cannot send tracking links', async () => {
  const c = client({ actor: false });
  const result = await run({ claim_id: CLAIM }, c);
  assert.equal(result.statusCode, 403);
  assert.equal(result.error, 'role_not_allowed');
  assert.ok(!c.queries.some((q) => q.text.includes('homeowner_ledger_tokens')));
});

test('a non-member of the tenant is refused', async () => {
  const result = await run({ claim_id: CLAIM }, client({ member: false }));
  assert.equal(result.error, 'cross_tenant_denied');
});

test('an acting member sends for a claim the tenant owns, and token reuse is claim-scoped', async () => {
  const c = client();
  const result = await run({ claim_id: CLAIM, rotate: false }, c);
  assert.equal(result.ok, true);
  const reuse = c.queries.find((q) => q.text.includes('FROM public.homeowner_ledger_tokens'));
  assert.match(reuse.text, /claim_id IS NOT DISTINCT FROM \$2::uuid/);
  assert.doesNotMatch(reuse.text, /\$2::uuid IS NULL/);
  assert.deepEqual(reuse.params, [TENANT, CLAIM]);
});
