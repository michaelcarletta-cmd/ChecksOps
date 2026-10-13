import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LOOKUP_MAPPING_SQL } from '../functions/api/identity.mjs';
import { handleProviderRequest } from '../functions/api/providers.mjs';
import {
  parseSendRequest,
  planSendLegs,
  requestHash,
  selectCreditMethod,
  selectWalletMethod,
  summarizeSend,
} from '../functions/api/providers/production/moov-send.mjs';
import { MoovError } from '../functions/api/providers/parity/moov-client.mjs';

const APP_USER = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const PARTNER = '7c1d2e3f-4a5b-4c6d-8e7f-901234567890';
const OTHER_TENANT = '9b1f3c55-1111-4222-8333-444455556666';
const CHECK = '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d';
const STAKEHOLDER = '1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b';
const STAKEHOLDER_2 = '2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d';
const SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const ORIGIN_JTI = 'b2c3d4e5-aaaa-4bbb-8ccc-000011112222';
const LOGIN = `${SUB}:jti:${ORIGIN_JTI}`;
const CLICK = '0b0e0c3a-5f4e-4d2c-9a1b-2c3d4e5f6a7b';

const FLAGS = {
  AWS_PROVIDER_EXECUTION_ENABLED: 'true',
  AWS_MOOV_ENABLED: 'true',
  AWS_PROVIDER_LIVE_READS_ENABLED: 'true',
  AWS_MOOV_TRANSFER_POST_ENABLED: 'true',
  AWS_MOOV_SEND_POST_ENABLED: 'true',
  AWS_FINANCIAL_PERMISSIONS_ACTIVATED: 'true',
  AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: undefined,
};

const withEnv = async (vars, fn) => {
  const previous = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const sendEvent = (body, claims = {}) => ({
  rawPath: '/functions/v1/moov-disburse',
  headers: { authorization: 'Bearer test-id-token' },
  body: JSON.stringify(body),
  requestContext: {
    stage: 'production',
    http: { method: 'POST', path: '/functions/v1/moov-disburse' },
    authorizer: {
      jwt: {
        claims: {
          sub: SUB, email: 'tester@example.com', token_use: 'id', origin_jti: ORIGIN_JTI, auth_time: '1791000000', ...claims,
        },
      },
    },
  },
});

const STAKEHOLDERS = [
  { id: STAKEHOLDER, tenant_id: TENANT, nickname: 'Roofing Sub', provider: 'moov', provider_account_id: 'stk-acct', provider_bank_account_id: 'stk-bank', verification_status: 'verified', is_active: true },
  { id: STAKEHOLDER_2, tenant_id: TENANT, nickname: 'Supplier', provider: 'moov', provider_account_id: 'stk2-acct', provider_bank_account_id: 'stk2-bank', verification_status: 'verified', is_active: true },
];

/** Transactional fake: writes are visible to later reads only once committed. */
const fakeDb = ({
  memberships = [{ tenant_id: TENANT, role: 'member', tenant_name: 'Freedom', tenant_slug: 'freedom' }],
  stepUps = [{ id: 'stepup-1', user_id: APP_USER, tenant_id: TENANT, action_key: 'wallet.fund', login_session: LOGIN }],
  account = { tenant_id: TENANT, environment: 'production', provider_account_id: 'moov-acct', onboarding_status: 'active' },
  stakeholders = STAKEHOLDERS,
  shares = [{ check_id: CHECK, source_tenant_id: TENANT, target_tenant_id: PARTNER }],
  checkTenant = TENANT,
  transfers = [],
  reservedCents = 0,
} = {}) => {
  const committed = { transfers: transfers.map((t) => ({ ...t })), events: [] };
  let pending = null;
  const begin = () => { pending = { transfers: committed.transfers.map((t) => ({ ...t })), events: [...committed.events] }; };
  const state = () => pending || committed;
  const log = [];
  let nextId = committed.transfers.length + 1;
  const client = {
    log,
    committed,
    connect: async () => {},
    end: async () => {},
    query: async (sql, params = []) => {
      log.push({ sql, params });
      if (sql === 'BEGIN') { begin(); return { rows: [] }; }
      if (sql === 'COMMIT') {
        if (pending) { committed.transfers = pending.transfers; committed.events = pending.events; }
        pending = null;
        return { command: 'COMMIT', rows: [] };
      }
      if (sql === 'ROLLBACK') { pending = null; return { rows: [] }; }
      if (/^(SET TRANSACTION|SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)/.test(sql)) return { rows: [] };
      if (sql.startsWith('SELECT set_config')) return { rows: [{}] };
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [{}] };
      if (sql === LOOKUP_MAPPING_SQL) {
        return { rows: params[0] === SUB ? [{ application_user_id: APP_USER, cognito_sub: SUB, email: 'tester@example.com', status: 'active' }] : [] };
      }
      if (sql.includes('FROM public.tenant_users')) return { rows: memberships };
      if (sql.includes('FROM public.user_roles')) return { rows: [] };
      if (sql.includes('FROM public.tenants WHERE id')) return { rows: [{ moov_allowlisted: true, moov_environment: 'production' }] };
      if (sql.includes('FROM public.financial_stepup_log')) {
        const [userId, tenantId, action, login] = params;
        return {
          rows: stepUps.filter((s) => s.user_id === userId && s.tenant_id === tenantId && s.action_key === action && s.login_session === login)
            .map((s) => ({ id: s.id, created_at: '2026-10-13T00:00:00Z' })),
        };
      }
      if (sql.includes('FROM public.check_intake_items')) {
        return { rows: params[0] === CHECK ? [{ id: CHECK, tenant_id: checkTenant }] : [] };
      }
      if (sql.includes('FROM public.payment_provider_accounts')) {
        return { rows: account && params[0] === account.tenant_id && params[1] === account.environment ? [account] : [] };
      }
      if (sql.includes('SELECT * FROM public.payment_wallets')) {
        return {
          rows: params[1] === 'production' && params[2] === 'operating'
            ? [{ id: 'wallet-row', tenant_id: TENANT, environment: 'production', wallet_type: 'operating', provider_wallet_id: 'wallet-1', provider_payment_method_id: 'pm-wallet' }]
            : [],
        };
      }
      if (sql.includes('INSERT INTO public.payment_wallets')) {
        return { rows: [{ id: 'wallet-row', tenant_id: params[0], environment: params[1], wallet_type: params[2], provider_wallet_id: params[4], provider_payment_method_id: params[6], available_cents: params[7], pending_cents: params[8] }] };
      }
      if (sql.includes('FROM public.payment_provider_methods')) {
        return { rows: [{ id: '8eb5b26e-6f66-435c-a578-880fb7fc14dd', provider_bank_account_id: 'bank-1', is_default: true }] };
      }
      if (sql.includes('FROM public.stakeholder_accounts')) {
        return { rows: stakeholders.filter((s) => s.id === params[0] && s.tenant_id === params[1]) };
      }
      if (sql.includes('FROM public.shared_checks')) {
        const [check, me, them] = params;
        return {
          rows: shares.filter((s) => s.check_id === check && !s.revoked_at
            && ((s.source_tenant_id === me && s.target_tenant_id === them) || (s.source_tenant_id === them && s.target_tenant_id === me)))
            .map(() => ({ '?column?': 1 })),
        };
      }
      if (sql.includes('COALESCE(sum(amount_cents)')) return { rows: [{ cents: reservedCents }] };
      if (sql.includes('SELECT * FROM public.payment_transfers') && sql.includes('left(idempotency_key')) {
        const [tenantId, prefix] = params;
        return {
          rows: state().transfers
            .filter((t) => t.tenant_id === tenantId && t.idempotency_key.startsWith(prefix))
            .sort((a, b) => a.provider_metadata.leg_index - b.provider_metadata.leg_index),
        };
      }
      if (sql.includes('INSERT INTO public.payment_transfers')) {
        if (state().transfers.some((t) => t.tenant_id === params[0] && t.idempotency_key === params[2])) {
          const error = new Error('duplicate key value'); error.code = '23505'; throw error;
        }
        const row = {
          id: `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`,
          tenant_id: params[0], environment: params[1], status: 'ready', idempotency_key: params[2],
          amount_cents: params[3], speed: params[4], description: params[5], source_payment_method_id: params[7],
          destination_tenant_id: params[8], wallet_id: params[9], leg_role: params[10], check_id: params[11],
          provider_metadata: JSON.parse(params[13]), provider_transfer_id: null,
        };
        state().transfers.push(row);
        return { rows: [] };
      }
      if (sql.includes("SET status = 'submitting'")) {
        const row = state().transfers.find((t) => t.id === params[0] && t.status === 'ready' && !t.provider_transfer_id);
        if (!row) return { rows: [] };
        row.status = 'submitting';
        return { rows: [{ ...row }] };
      }
      if (sql.includes("SET status = 'canceled'")) {
        const row = state().transfers.find((t) => t.id === params[0] && t.status === 'ready');
        if (row) { row.status = 'canceled'; row.failure_reason = 'not_sent_after_earlier_leg'; }
        return { rows: [] };
      }
      if (sql.includes('UPDATE public.payment_transfers') && sql.includes('failure_reason = $3')) {
        const row = state().transfers.find((t) => t.id === params[0] && t.status === 'submitting');
        if (row) { row.status = params[1]; row.failure_reason = params[2]; }
        return { rows: row ? [{ ...row }] : [] };
      }
      if (sql.includes('UPDATE public.payment_transfers') && sql.includes('provider_transfer_id = $2')) {
        const row = state().transfers.find((t) => t.id === params[0]);
        Object.assign(row, { provider_transfer_id: params[1], provider_status: params[2], status: params[3] });
        return { rows: [{ ...row }] };
      }
      if (sql.includes('INSERT INTO public.payment_event_log')) {
        state().events.push({ type: params[2], status: params[3] });
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
  return client;
};

const methods = {
  'moov-acct': [
    { paymentMethodType: 'moov-wallet', paymentMethodID: 'pm-wallet', wallet: { walletID: 'wallet-1' } },
    { paymentMethodType: 'ach-debit-fund', paymentMethodID: 'pm-debit', bankAccount: { bankAccountID: 'bank-1' } },
  ],
  'stk-acct': [
    { paymentMethodType: 'ach-credit-standard', paymentMethodID: 'pm-stk-std', bankAccount: { bankAccountID: 'stk-bank' } },
    { paymentMethodType: 'ach-credit-same-day', paymentMethodID: 'pm-stk-sd', bankAccount: { bankAccountID: 'stk-bank' } },
  ],
  'stk2-acct': [
    { paymentMethodType: 'ach-credit-standard', paymentMethodID: 'pm-stk2-std', bankAccount: { bankAccountID: 'stk2-bank' } },
  ],
  'partner-acct': [
    { paymentMethodType: 'moov-wallet', paymentMethodID: 'pm-partner-wallet', wallet: { walletID: 'pw-1' } },
    { paymentMethodType: 'ach-credit-standard', paymentMethodID: 'pm-partner-bank', bankAccount: { bankAccountID: 'pb-1' } },
  ],
};

const moovStub = ({ available = 1_000_000, posts = [], partnerMethods = methods['partner-acct'], partnerAccounts } = {}) => {
  const calls = [];
  let postIndex = 0;
  const impl = async (url, init = {}) => {
    const method = String(init.method || 'GET').toUpperCase();
    const full = String(url).replace(/^https:\/\/[^/]+/, '');
    const [path, query = ''] = full.split('?');
    let body = null;
    try { body = init.body ? JSON.parse(init.body) : null; } catch { body = String(init.body); }
    calls.push({ method, path, query, headers: init.headers || {}, body });
    const reply = (status, data) => ({ ok: status < 400, status, text: async () => JSON.stringify(data) });
    if (path.includes('/oauth2/token')) return reply(200, { access_token: 't', expires_in: 300 });
    if (method === 'GET' && /\/accounts\/moov-acct\/wallets$/.test(path)) {
      return reply(200, [{ walletID: 'wallet-1', walletType: 'default', availableBalance: { value: available }, pendingBalance: { value: 0 } }]);
    }
    if (method === 'GET' && path === '/accounts') {
      const foreign = new URLSearchParams(query).get('foreignID');
      const list = partnerAccounts ?? (foreign === PARTNER ? [{ accountID: 'partner-acct', foreignID: PARTNER, displayName: 'Partner Co' }] : []);
      return reply(200, list);
    }
    const pm = path.match(/^\/accounts\/([^/]+)\/payment-methods$/);
    if (method === 'GET' && pm) {
      if (pm[1] === 'partner-acct') return reply(200, partnerMethods);
      return methods[pm[1]] ? reply(200, methods[pm[1]]) : reply(404, { error: 'not found' });
    }
    if (method === 'POST' && path.endsWith('/transfers')) {
      const result = posts[postIndex++] || { status: 201, body: { transferID: `moov-xfer-${postIndex}`, status: 'created' } };
      if (result.throw) throw result.throw;
      return reply(result.status, result.body);
    }
    return reply(500, { message: `unexpected ${method} ${path}` });
  };
  return { calls, impl, posts: () => calls.filter((c) => c.method === 'POST' && c.path.endsWith('/transfers')) };
};

const stakeholder = (amount, id = STAKEHOLDER) => ({ kind: 'stakeholder', stakeholder_account_id: id, amount_cents: amount });
const partner = (amount, id = PARTNER) => ({ kind: 'partner', partner_tenant_id: id, amount_cents: amount });

const run = (client, moov, body = {}, claims = {}) => handleProviderRequest(
  sendEvent({ tenant_id: TENANT, check_id: CHECK, idempotency_key: CLICK, recipients: [stakeholder(2500)], ...body }, claims),
  '/functions/v1/moov-disburse',
  'POST',
  {
    loadDatabaseCredentials: async () => ({ host: 'localhost', username: 'checksops', password: 'x', database: 'checksops' }),
    createClient: () => client,
    loadProviderSecrets: async () => ({ MOOV_PUBLIC_KEY: 'pk', MOOV_SECRET_KEY: 'sk', MOOV_ACCOUNT_ID: 'platform-acct' }),
    fetchImpl: moov.impl,
  },
);

test('a covered send is one wallet → stakeholder bank transfer, committed before Moov is called', async () => {
  await withEnv(FLAGS, async () => {
    const client = fakeDb();
    const moov = moovStub();
    const before = [];
    const original = moov.impl;
    moov.impl = async (url, init) => {
      if (String(init?.method).toUpperCase() === 'POST' && String(url).endsWith('/transfers')) before.push(client.committed.transfers.map((t) => t.status));
      return original(url, init);
    };
    const result = await run(client, moov);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.send.sent_cents, 2500);
    const [post] = moov.posts();
    assert.equal(post.path, '/accounts/platform-acct/transfers');
    assert.deepEqual(post.body.source, { paymentMethodID: 'pm-wallet' });
    assert.deepEqual(post.body.destination, { paymentMethodID: 'pm-stk-std' });
    assert.deepEqual(post.body.amount, { currency: 'USD', value: 2500 });
    const [leg] = client.committed.transfers;
    assert.equal(post.headers['X-Idempotency-Key'], leg.id);
    assert.deepEqual(before, [['submitting']]);
    assert.equal(leg.leg_role, 'send_wallet');
    assert.equal(leg.check_id, CHECK);
    assert.equal(leg.idempotency_key, `send:${CLICK}:0:wallet`);
    assert.equal(leg.status, 'submitted');
  });
});

test('top-up: a short wallet sends the available part, then the shortfall bank → recipient', async () => {
  await withEnv(FLAGS, async () => {
    const client = fakeDb();
    const moov = moovStub({ available: 1000 });
    const result = await run(client, moov, { recipients: [stakeholder(2500)] });
    assert.equal(result.ok, true, JSON.stringify(result));
    const [walletPost, bankPost] = moov.posts();
    assert.deepEqual([walletPost.body.source, walletPost.body.amount.value], [{ paymentMethodID: 'pm-wallet' }, 1000]);
    assert.deepEqual([bankPost.body.source, bankPost.body.amount.value], [{ paymentMethodID: 'pm-debit' }, 1500]);
    assert.deepEqual(bankPost.body.destination, { paymentMethodID: 'pm-stk-std' });
    assert.deepEqual(client.committed.transfers.map((t) => t.leg_role), ['send_wallet', 'send_bank']);
    assert.equal(client.committed.transfers[1].source_payment_method_id, '8eb5b26e-6f66-435c-a578-880fb7fc14dd');
  });
});

test('an empty wallet sends the whole amount from the bank; same-day uses the same-day rail', async () => {
  await withEnv(FLAGS, async () => {
    const client = fakeDb();
    const moov = moovStub({ available: 0 });
    const result = await run(client, moov, { speed: 'same_day' });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(moov.posts().length, 1);
    assert.deepEqual(moov.posts()[0].body.source, { paymentMethodID: 'pm-debit' });
    assert.deepEqual(moov.posts()[0].body.destination, { paymentMethodID: 'pm-stk-sd' });
  });
});

test('recent unsent wallet parts of other sends are not counted as available', async () => {
  await withEnv(FLAGS, async () => {
    const client = fakeDb({ reservedCents: 900 });
    const moov = moovStub({ available: 1000 });
    const result = await run(client, moov, { recipients: [stakeholder(500)] });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(moov.posts().map((p) => [p.body.source.paymentMethodID, p.body.amount.value]), [['pm-wallet', 100], ['pm-debit', 400]]);
  });
});

test('partners the check is shared with are paid wallet to wallet, else to their bank', async () => {
  await withEnv(FLAGS, async () => {
    let client = fakeDb();
    let moov = moovStub();
    let result = await run(client, moov, { recipients: [partner(700)] });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(moov.posts()[0].body.destination, { paymentMethodID: 'pm-partner-wallet' });
    assert.equal(client.committed.transfers[0].destination_tenant_id, PARTNER);
    assert.equal(moov.calls.find((c) => c.path === '/accounts').query, `foreignID=${PARTNER}`);

    client = fakeDb();
    moov = moovStub({ partnerMethods: [methods['partner-acct'][1]] });
    result = await run(client, moov, { recipients: [partner(700)] });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(moov.posts()[0].body.destination, { paymentMethodID: 'pm-partner-bank' });
    assert.equal(result.send.recipients[0].destination, 'bank');
  });
});

test('partners must share this check and have exactly one production account', async () => {
  await withEnv(FLAGS, async () => {
    for (const [options, stubOptions, code] of [
      [{ shares: [] }, {}, 'partner_not_shared'],
      [{ shares: [{ check_id: CHECK, source_tenant_id: TENANT, target_tenant_id: PARTNER, revoked_at: '2026-10-01' }] }, {}, 'partner_not_shared'],
      [{}, { partnerAccounts: [] }, 'partner_setup_required'],
      [{}, { partnerAccounts: [{ accountID: 'a', foreignID: PARTNER }, { accountID: 'b', foreignID: PARTNER }] }, 'partner_account_ambiguous'],
      [{}, { partnerMethods: [] }, 'partner_setup_required'],
    ]) {
      const client = fakeDb(options);
      const moov = moovStub(stubOptions);
      const result = await run(client, moov, { recipients: [partner(700)] });
      assert.equal(result.statusCode, 409, code);
      assert.equal(result.error, code);
      assert.equal(moov.posts().length, 0, code);
      assert.equal(client.committed.transfers.length, 0, code);
    }
    const self = await run(fakeDb(), moovStub(), { recipients: [partner(700, TENANT)] });
    assert.equal(self.error, 'recipient_is_sender');
  });
});

test('stakeholders must belong to this organization, be verified and have a production bank', async () => {
  await withEnv(FLAGS, async () => {
    for (const [stakeholders, code] of [
      [[], 'recipient_not_found'],
      [[{ ...STAKEHOLDERS[0], tenant_id: OTHER_TENANT }], 'recipient_not_found'],
      [[{ ...STAKEHOLDERS[0], verification_status: 'pending' }], 'recipient_not_verified'],
      [[{ ...STAKEHOLDERS[0], provider_bank_account_id: null }], 'recipient_setup_required'],
      [[{ ...STAKEHOLDERS[0], provider_account_id: 'sandbox-only' }], 'recipient_setup_required'],
      [[{ ...STAKEHOLDERS[0], provider_bank_account_id: 'other-bank' }], 'recipient_bank_not_ready'],
    ]) {
      const client = fakeDb({ stakeholders });
      const moov = moovStub();
      const result = await run(client, moov);
      assert.equal(result.error, code);
      assert.equal(moov.posts().length, 0, code);
      assert.equal(client.committed.transfers.length, 0, code);
    }
  });
});

test('any member can send; platform roles without membership, other checks and no two-factor are refused', async () => {
  await withEnv(FLAGS, async () => {
    const viewer = await run(fakeDb({ memberships: [{ tenant_id: TENANT, role: 'viewer' }] }), moovStub(), { recipients: [stakeholder(250_000_000)] });
    assert.equal(viewer.ok, true, JSON.stringify(viewer));

    const otherCheck = await run(fakeDb({ checkTenant: OTHER_TENANT }), moovStub());
    assert.equal(otherCheck.statusCode, 404);

    for (const [options, claims] of [[{ stepUps: [] }, {}], [{}, { origin_jti: 'another-login' }]]) {
      const client = fakeDb(options);
      const moov = moovStub();
      const result = await run(client, moov, {}, claims);
      assert.equal(result.statusCode, 401);
      assert.equal(result.error, 'totp_required');
      assert.equal(result.actionKey, 'wallet.fund');
      assert.equal(moov.calls.length, 0);
      assert.equal(client.committed.transfers.length, 0);
    }
  });
});

test('with the send switch or the general transfer switch off nothing is recorded or sent', async () => {
  for (const off of [{ AWS_MOOV_SEND_POST_ENABLED: 'false' }, { AWS_MOOV_SEND_POST_ENABLED: undefined }, { AWS_MOOV_TRANSFER_POST_ENABLED: 'false' }]) {
    await withEnv({ ...FLAGS, ...off }, async () => {
      const client = fakeDb();
      const moov = moovStub();
      const result = await run(client, moov);
      assert.equal(result.statusCode, 403, JSON.stringify(off));
      assert.equal(result.error, 'send_post_held');
      assert.equal(moov.posts().length, 0);
      assert.equal(client.committed.transfers.length, 0);
    });
  }
});

test('a refused bank shortfall leaves the wallet part sent, reports partial, and cancels later legs', async () => {
  await withEnv(FLAGS, async () => {
    const client = fakeDb();
    const moov = moovStub({
      available: 1000,
      posts: [{ status: 201, body: { transferID: 'w1', status: 'created' } }, { status: 422, body: { error: 'insufficient funds' } }],
    });
    const result = await run(client, moov, { recipients: [stakeholder(2500), stakeholder(300, STAKEHOLDER_2)] });
    assert.equal(result.statusCode, 409);
    assert.equal(result.error, 'send_partial');
    assert.equal(moov.posts().length, 2);
    assert.deepEqual(client.committed.transfers.map((t) => [t.leg_role, t.status]), [
      ['send_wallet', 'submitted'], ['send_bank', 'failed'], ['send_bank', 'canceled'],
    ]);
    assert.equal(result.send.sent_cents, 1000);
    assert.equal(result.send.unsent_cents, 1800);
    assert.deepEqual(result.send.recipients.map((r) => [r.sent_cents, r.unsent_cents]), [[1000, 1500], [0, 300]]);
  });
});

test('an unclear Moov result is unknown, stops the send, and is never retried', async () => {
  await withEnv(FLAGS, async () => {
    const client = fakeDb();
    const moov = moovStub({ posts: [{ throw: new MoovError('timeout', 504) }] });
    const first = await run(client, moov, { recipients: [stakeholder(400), stakeholder(300, STAKEHOLDER_2)] });
    assert.equal(first.error, 'provider_outcome_unknown');
    assert.deepEqual(client.committed.transfers.map((t) => t.status), ['unknown', 'canceled']);
    const again = await run(client, moov, { recipients: [stakeholder(400), stakeholder(300, STAKEHOLDER_2)] });
    assert.equal(again.error, 'provider_outcome_unknown');
    assert.equal(again.duplicate, true);
    assert.equal(moov.posts().length, 1);
  });
});

test('the same click never sends twice, and a reused key with a different request is refused', async () => {
  await withEnv(FLAGS, async () => {
    const client = fakeDb();
    const moov = moovStub();
    assert.equal((await run(client, moov)).ok, true);
    const again = await run(client, moov);
    assert.equal(again.ok, true);
    assert.equal(again.duplicate, true);
    assert.equal(moov.posts().length, 1);
    const reused = await run(client, moov, { recipients: [stakeholder(999)] });
    assert.equal(reused.error, 'idempotency_key_reused');
    assert.equal(moov.posts().length, 1);
  });
});

test('committed but unsent legs are resumed in order with their own Moov keys', async () => {
  await withEnv(FLAGS, async () => {
    const request = parseSendRequest({ idempotency_key: CLICK, check_id: CHECK, recipients: [stakeholder(2500)] });
    const meta = (i, source, dest) => ({ request_hash: requestHash(request), leg_index: i, recipient_index: 0, recipient_kind: 'stakeholder', recipient_id: STAKEHOLDER, source_moov_payment_method_id: source, destination_moov_payment_method_id: dest });
    const client = fakeDb({
      transfers: [
        { id: '00000000-0000-4000-8000-0000000000a1', tenant_id: TENANT, idempotency_key: `send:${CLICK}:0:wallet`, amount_cents: 1000, leg_role: 'send_wallet', status: 'submitted', provider_transfer_id: 'w1', provider_metadata: meta(0, 'pm-wallet', 'pm-stk-std') },
        { id: '00000000-0000-4000-8000-0000000000a2', tenant_id: TENANT, idempotency_key: `send:${CLICK}:1:bank`, amount_cents: 1500, leg_role: 'send_bank', status: 'ready', provider_transfer_id: null, provider_metadata: meta(1, 'pm-debit', 'pm-stk-std') },
      ],
    });
    const moov = moovStub();
    const result = await run(client, moov);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(moov.posts().length, 1);
    assert.equal(moov.posts()[0].headers['X-Idempotency-Key'], '00000000-0000-4000-8000-0000000000a2');
    assert.deepEqual(moov.posts()[0].body.source, { paymentMethodID: 'pm-debit' });
  });
});

test('request parsing, leg planning and method selection', () => {
  assert.equal(parseSendRequest({}).error, 'idempotency_key is required');
  assert.equal(parseSendRequest({ idempotency_key: CLICK }).error, 'check_id is required');
  assert.match(parseSendRequest({ idempotency_key: CLICK, check_id: CHECK, recipients: [] }).error, /at least one/);
  assert.match(parseSendRequest({ idempotency_key: CLICK, check_id: CHECK, recipients: [stakeholder(0)] }).error, /cents/);
  assert.match(parseSendRequest({ idempotency_key: CLICK, check_id: CHECK, recipients: [stakeholder(5), stakeholder(6)] }).error, /only once/);
  assert.match(parseSendRequest({ idempotency_key: CLICK, check_id: CHECK, speed: 'instant', recipients: [stakeholder(5)] }).error, /speed/);
  assert.equal(parseSendRequest({ idempotency_key: CLICK, check_id: CHECK, recipients: [{ kind: 'other', amount_cents: 5 }] }).error, 'Each recipient must be a stakeholder or a partner.');

  const plan = planSendLegs([{ amount_cents: 600 }, { amount_cents: 600 }, { amount_cents: 600 }], 1000);
  assert.deepEqual(plan.map((p) => [p.wallet_cents, p.bank_cents]), [[600, 0], [400, 200], [0, 600]]);
  assert.deepEqual(planSendLegs([{ amount_cents: 5 }], -10).map((p) => p.bank_cents), [5]);

  assert.equal(selectCreditMethod(methods['stk-acct'], 'standard', 'stk-bank').method.paymentMethodID, 'pm-stk-std');
  assert.equal(selectCreditMethod(methods['stk-acct'], 'standard', 'nope').error, 'recipient_bank_not_ready');
  assert.equal(selectCreditMethod([...methods['stk-acct'], ...methods['stk2-acct']], 'standard').error, 'recipient_bank_choice_required');
  assert.equal(selectWalletMethod(methods['partner-acct']).method.paymentMethodID, 'pm-partner-wallet');
  assert.equal(selectWalletMethod([]).error, 'partner_wallet_missing');
  assert.equal(selectWalletMethod([
    { paymentMethodType: 'moov-wallet', paymentMethodID: 'a', wallet: { walletID: '1' } },
    { paymentMethodType: 'moov-wallet', paymentMethodID: 'b', wallet: { walletID: '2' } },
  ]).error, 'partner_wallet_choice_required');

  const summary = summarizeSend([
    { amount_cents: 100, status: 'completed', leg_role: 'send_wallet', provider_metadata: { recipient_index: 0 } },
    { amount_cents: 50, status: 'unknown', leg_role: 'send_bank', provider_metadata: { recipient_index: 0 } },
  ]);
  assert.deepEqual([summary.sent_cents, summary.unknown_cents, summary.unsent_cents], [100, 50, 0]);
});
