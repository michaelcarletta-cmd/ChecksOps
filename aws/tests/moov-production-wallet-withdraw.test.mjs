import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LOOKUP_MAPPING_SQL } from '../functions/api/identity.mjs';
import { handleProviderRequest } from '../functions/api/providers.mjs';
import { classifyFunction } from '../functions/api/providers/catalog.mjs';
import {
  expectedArrival,
  selectSameDayCreditMethod,
  tenantLimitBreach,
  WALLET_WITHDRAW_LEG,
} from '../functions/api/providers/production/moov-wallet-withdraw.mjs';
import { SET_MONEY_WRITE_SQL } from '../functions/api/money-write-flag.mjs';
import { minutesAgo, stepUpWithinWindow } from './helpers/financial-stepup-window.mjs';

const APP_USER = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const OTHER_TENANT = '9b1f3c55-1111-4222-8333-444455556666';
const SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const ORIGIN_JTI = 'b2c3d4e5-aaaa-4bbb-8ccc-000011112222';
const LOGIN = `${SUB}:jti:${ORIGIN_JTI}`;
const CLICK = '0b0e0c3a-5f4e-4d2c-9a1b-2c3d4e5f6a7b';
const BANK_ROW = '8eb5b26e-6f66-435c-a578-880fb7fc14dd';
const PATH = '/functions/v1/moov-wallet-withdraw';
/** Tuesday 2026-11-10, 10:00 in New York (before the 16:45 same-day cutoff). */
const TUESDAY_MORNING = new Date('2026-11-10T15:00:00Z');

const FLAGS = {
  AWS_PROVIDER_EXECUTION_ENABLED: 'true',
  AWS_MOOV_ENABLED: 'true',
  AWS_PROVIDER_LIVE_READS_ENABLED: 'true',
  AWS_MOOV_TRANSFER_POST_ENABLED: 'true',
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

const withdrawEvent = (body, claims = {}) => ({
  rawPath: PATH,
  headers: { authorization: 'Bearer test-id-token' },
  body: JSON.stringify(body),
  requestContext: {
    stage: 'production',
    http: { method: 'POST', path: PATH },
    authorizer: {
      jwt: {
        claims: {
          sub: SUB, email: 'tester@example.com', token_use: 'id', origin_jti: ORIGIN_JTI, auth_time: '1791000000', ...claims,
        },
      },
    },
  },
});

const BAD = new Set(['failed', 'canceled', 'returned']);

/**
 * A small transactional fake: writes become visible to later reads only once
 * committed, and a ROLLBACK discards uncommitted writes. `limits` is the
 * tenant_wallet_funding_settings row (SQL 164 columns); `limits: 'missing'`
 * answers 42703 as PostgreSQL does before SQL 164 is applied.
 */
const fakeDb = ({
  memberships = [{ tenant_id: TENANT, role: 'member', tenant_name: 'Freedom', tenant_slug: 'freedom' }],
  stepUps = [{ id: 'stepup-1', user_id: APP_USER, tenant_id: TENANT, action_key: 'wallet.fund', login_session: LOGIN }],
  account = { tenant_id: TENANT, environment: 'production', provider_account_id: 'moov-acct', onboarding_status: 'active' },
  banks = [{ id: BANK_ROW, provider_bank_account_id: 'bank-1', is_default: true }],
  limits = null,
  transfers = [],
} = {}) => {
  const committed = { transfers: transfers.map((t) => ({ ...t })), events: [] };
  let pending = null;
  let moneyFlag = false;
  const begin = () => { pending = { transfers: committed.transfers.map((t) => ({ ...t })), events: [...committed.events] }; moneyFlag = false; };
  const state = () => pending || committed;
  const log = [];
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
        moneyFlag = false;
        return { command: 'COMMIT', rows: [] };
      }
      if (sql === 'ROLLBACK') { pending = null; moneyFlag = false; return { rows: [] }; }
      if (/^(SET TRANSACTION|SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)/.test(sql)) return { rows: [] };
      if (sql === SET_MONEY_WRITE_SQL) { moneyFlag = true; return { rows: [{}] }; }
      if (sql.startsWith('SELECT set_config')) return { rows: [{}] };
      if (sql.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [{}] };
      if (sql === LOOKUP_MAPPING_SQL) {
        return { rows: params[0] === SUB ? [{ application_user_id: APP_USER, cognito_sub: SUB, email: 'tester@example.com', status: 'active' }] : [] };
      }
      if (sql.includes('FROM public.tenant_users')) return { rows: memberships };
      if (sql.includes('FROM public.user_roles')) return { rows: [] };
      if (sql.includes('FROM public.tenants WHERE id')) return { rows: [{ moov_allowlisted: true, moov_environment: 'production' }] };
      if (sql.includes('FROM public.financial_stepup_log')) {
        const [userId, tenantId, action, login] = params;
        return {
          rows: stepUps.filter((s) => s.user_id === userId && s.tenant_id === tenantId && s.action_key === action && s.login_session === login
            && stepUpWithinWindow(sql, params, s))
            .map((s) => ({ id: s.id, created_at: s.created_at ?? new Date().toISOString() })),
        };
      }
      if (sql.includes('wallet_withdraw_max_per_transfer_cents')) {
        if (limits === 'missing') {
          const error = new Error('column "wallet_withdraw_max_per_transfer_cents" does not exist'); error.code = '42703'; throw error;
        }
        return { rows: limits ? [limits] : [] };
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
      if (sql.includes('FROM public.payment_provider_methods')) return { rows: banks };
      if (sql.includes('COALESCE(sum(amount_cents)') && sql.includes('ANY($3::text[])')) {
        const cents = state().transfers
          .filter((t) => t.tenant_id === params[0] && params[2].includes(t.leg_role) && t.id !== params[3]
            && ['ready', 'submitting'].includes(t.status))
          .reduce((sum, t) => sum + Number(t.amount_cents), 0);
        return { rows: [{ cents }] };
      }
      if (sql.includes('COALESCE(sum(amount_cents)')) {
        const cents = state().transfers
          .filter((t) => t.tenant_id === params[0] && t.leg_role === params[2] && t.id !== params[3] && !BAD.has(t.status))
          .reduce((sum, t) => sum + Number(t.amount_cents), 0);
        return { rows: [{ cents }] };
      }
      if (sql.includes('SELECT * FROM public.payment_transfers')) {
        return { rows: state().transfers.filter((t) => t.tenant_id === params[0] && t.idempotency_key === params[1]) };
      }
      if (sql.includes('INSERT INTO public.payment_transfers')) {
        assert.equal(moneyFlag, true, 'the money-write flag is set before the transfer row is written');
        if (state().transfers.some((t) => t.tenant_id === params[0] && t.idempotency_key === params[2])) {
          const error = new Error('duplicate key value'); error.code = '23505'; throw error;
        }
        const row = {
          id: `00000000-0000-4000-8000-00000000000${state().transfers.length + 1}`,
          tenant_id: params[0], environment: params[1], status: 'ready', idempotency_key: params[2],
          amount_cents: params[3], description: params[4], source_tenant_account_id: params[5],
          destination_payment_method_id: params[6], wallet_id: params[7], leg_role: params[8],
          provider_metadata: JSON.parse(params[9]), created_by: params[10], provider_transfer_id: null,
          sql,
        };
        state().transfers.push(row);
        return { rows: [row] };
      }
      if (sql.includes("SET status = 'submitting'")) {
        assert.equal(moneyFlag, true);
        const row = state().transfers.find((t) => t.id === params[0] && t.status === 'ready' && !t.provider_transfer_id);
        if (!row) return { rows: [] };
        row.status = 'submitting';
        return { rows: [{ id: row.id }] };
      }
      if (sql.includes('UPDATE public.payment_transfers') && sql.includes('failure_reason = $3')) {
        const row = state().transfers.find((t) => t.id === params[0] && t.status === 'submitting');
        if (row) { row.status = params[1]; row.failure_reason = params[2]; }
        return { rows: row ? [row] : [] };
      }
      if (sql.includes('UPDATE public.payment_transfers') && sql.includes('provider_transfer_id = $2')) {
        const row = state().transfers.find((t) => t.id === params[0]);
        Object.assign(row, { provider_transfer_id: params[1], provider_status: params[2], status: params[3] });
        return { rows: [row] };
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

const sameDay = (id, bank, status = 'verified') => ({
  paymentMethodType: 'ach-credit-same-day', paymentMethodID: id, bankAccount: { bankAccountID: bank, status },
});

const moovStub = ({
  postResult = { status: 201, body: { transferID: 'moov-xfer-1', status: 'created' } },
  availableCents = 100_000,
  credits = [sameDay('pm-same-day', 'bank-1')],
} = {}) => {
  const calls = [];
  const impl = async (url, init = {}) => {
    const method = String(init.method || 'GET').toUpperCase();
    const path = String(url).replace(/^https:\/\/[^/]+/, '').split('?')[0];
    let body = null;
    try { body = init.body ? JSON.parse(init.body) : null; } catch { body = String(init.body); }
    calls.push({ method, path, headers: init.headers || {}, body });
    const reply = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
    if (path.includes('/oauth2/token')) return reply(200, { access_token: 't', expires_in: 300 });
    if (method === 'GET' && /\/accounts\/[^/]+\/wallets$/.test(path)) {
      return reply(200, [{ walletID: 'wallet-1', walletType: 'default', availableBalance: { value: availableCents }, pendingBalance: { value: 500 } }]);
    }
    if (method === 'GET' && path.endsWith('/payment-methods')) {
      return reply(200, [
        { paymentMethodType: 'moov-wallet', paymentMethodID: 'pm-wallet', wallet: { walletID: 'wallet-1' } },
        { paymentMethodType: 'ach-debit-fund', paymentMethodID: 'pm-debit', bankAccount: { bankAccountID: 'bank-1', status: 'verified' } },
        { paymentMethodType: 'ach-credit-standard', paymentMethodID: 'pm-standard', bankAccount: { bankAccountID: 'bank-1', status: 'verified' } },
        ...credits,
      ]);
    }
    if (method === 'POST' && path.endsWith('/transfers')) {
      if (postResult.throw) throw postResult.throw;
      return reply(postResult.status, postResult.body);
    }
    return reply(500, { message: `unexpected ${method} ${path}` });
  };
  return { calls, impl, posts: () => calls.filter((c) => c.method === 'POST' && c.path.endsWith('/transfers')) };
};

const run = (client, moov, body = {}, claims = {}, now = TUESDAY_MORNING) => handleProviderRequest(
  withdrawEvent({ tenant_id: TENANT, amount_cents: 2500, idempotency_key: CLICK, ...body }, claims),
  PATH,
  'POST',
  {
    loadDatabaseCredentials: async () => ({ host: 'localhost', username: 'checksops', password: 'x', database: 'checksops' }),
    createClient: () => client,
    loadProviderSecrets: async () => ({ MOOV_PUBLIC_KEY: 'pk', MOOV_SECRET_KEY: 'sk', MOOV_ACCOUNT_ID: 'platform-acct' }),
    fetchImpl: moov.impl,
    now: () => now,
  },
);

const nothingHappened = (client, moov) => {
  assert.equal(moov.posts().length, 0);
  assert.equal(client.committed.transfers.length, 0);
};

test('the route is catalogued and reaches the production handler', () => {
  assert.equal(classifyFunction('moov-wallet-withdraw').provider, 'moov');
  assert.equal(classifyFunction('moov-wallet-withdraw').class, 6);
});

test('transfer to bank moves operating wallet → own bank by same-day ACH, once, row committed before Moov is called', async () => {
  await withEnv(FLAGS, async () => {
    const client = fakeDb();
    const moov = moovStub();
    const commitsBeforePost = [];
    const original = moov.impl;
    moov.impl = async (url, init) => {
      if (String(init?.method).toUpperCase() === 'POST' && String(url).endsWith('/transfers')) {
        commitsBeforePost.push(client.committed.transfers.map((t) => t.status));
      }
      return original(url, init);
    };
    const result = await run(client, moov);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.statusCode, 200);
    assert.equal(result.duplicate, false);
    assert.equal(result.operation, 'wallet.withdraw');
    assert.equal(result.environment, 'production');
    assert.equal(result.transfer.status, 'submitted');
    assert.equal(result.transfer.provider_transfer_id, 'moov-xfer-1');
    assert.equal(result.fee_cents, 0);
    assert.deepEqual(result.expected_arrival, { arrives: 'today', date: '2026-11-10' });
    assert.match(result.message, /Arrives today/);

    const [post] = moov.posts();
    assert.equal(post.path, '/accounts/platform-acct/transfers');
    assert.deepEqual(post.body.source, { paymentMethodID: 'pm-wallet' });
    assert.deepEqual(post.body.destination, { paymentMethodID: 'pm-same-day' });
    assert.deepEqual(post.body.amount, { currency: 'USD', value: 2500 });
    assert.equal(post.body.metadata.checksops_leg, 'wallet_withdrawal');
    const row = client.committed.transfers[0];
    assert.equal(post.headers['X-Idempotency-Key'], row.id);
    assert.deepEqual(commitsBeforePost, [['submitting']]);
    assert.equal(row.idempotency_key, `wallet-withdraw:${CLICK}`);
    assert.equal(row.leg_role, WALLET_WITHDRAW_LEG);
    assert.equal(row.destination_payment_method_id, BANK_ROW);
    assert.equal(row.wallet_id, 'wallet-row');
    assert.equal(row.created_by, APP_USER);
    assert.match(row.sql, /'ready', \$3, \$4, 0, \$4, 'same_day'/, 'no fee: platform_fee 0, net = amount');
    assert.equal(row.provider_metadata.rail, 'ach-credit-same-day');
    assert.equal(row.provider_metadata.checksops_leg, 'wallet_withdrawal');
    assert.equal(row.provider_metadata.source_moov_payment_method_id, 'pm-wallet');
    assert.equal(row.provider_metadata.destination_moov_payment_method_id, 'pm-same-day');
    assert.equal(row.provider_metadata.stepup_id, 'stepup-1');
    assert.equal(row.status, 'submitted');
    assert.deepEqual(client.committed.events.map((e) => e.type), ['wallet.withdrawal.created', 'wallet.withdrawal.submitted']);
  });
});

test('any tenant member may transfer; the platform owner of another tenant may not', async () => {
  await withEnv(FLAGS, async () => {
    const viewer = await run(fakeDb({ memberships: [{ tenant_id: TENANT, role: 'viewer' }] }), moovStub());
    assert.equal(viewer.ok, true, JSON.stringify(viewer));

    const client = fakeDb({ memberships: [{ tenant_id: OTHER_TENANT, role: 'owner' }] });
    const moov = moovStub();
    const outsider = await run(client, moov);
    assert.equal(outsider.statusCode, 403, JSON.stringify(outsider));
    nothingHappened(client, moov);
  });
});

test('only the operating wallet: trust or anything else is refused before anything is read or sent', async () => {
  await withEnv(FLAGS, async () => {
    for (const wallet_type of ['trust', 'escrow', '']) {
      const client = fakeDb();
      const moov = moovStub();
      const result = await run(client, moov, { wallet_type });
      assert.equal(result.statusCode, 400, wallet_type);
      assert.equal(moov.calls.length, 0);
      nothingHappened(client, moov);
    }
  });
});

test('bad amounts and missing click keys are refused', async () => {
  await withEnv(FLAGS, async () => {
    for (const body of [{ amount_cents: 0 }, { amount_cents: -1 }, { amount_cents: 12.5 }, { amount_cents: '1e3' }, { idempotency_key: 'not-a-uuid' }]) {
      const client = fakeDb();
      const moov = moovStub();
      const result = await run(client, moov, body);
      assert.equal(result.statusCode, 400, JSON.stringify(body));
      nothingHappened(client, moov);
    }
  });
});

test('the same wallet.fund two-factor step-up, fresh (15 minutes) and bound to this login', async () => {
  await withEnv(FLAGS, async () => {
    for (const [stepUps, claims] of [
      [[], {}],
      [undefined, { origin_jti: 'a-different-login' }],
      [[{ id: 's', user_id: APP_USER, tenant_id: TENANT, action_key: 'deposit.submit', login_session: LOGIN }], {}],
      [[{ id: 's', user_id: APP_USER, tenant_id: TENANT, action_key: 'wallet.fund', login_session: LOGIN, created_at: minutesAgo(16) }], {}],
    ]) {
      const client = fakeDb(stepUps ? { stepUps } : {});
      const moov = moovStub();
      const result = await run(client, moov, {}, claims);
      assert.equal(result.statusCode, 401, JSON.stringify(result));
      assert.equal(result.error, 'totp_required');
      assert.equal(result.actionKey, 'wallet.fund');
      assert.equal(moov.calls.length, 0);
      nothingHappened(client, moov);
    }
  });
});

test('the amount is capped at the available balance Moov reports now, less wallet money already in flight', async () => {
  await withEnv(FLAGS, async () => {
    let client = fakeDb();
    let moov = moovStub({ availableCents: 2499 });
    let result = await run(client, moov);
    assert.equal(result.statusCode, 409, JSON.stringify(result));
    assert.equal(result.error, 'insufficient_available_balance');
    assert.equal(result.available_cents, 2499);
    nothingHappened(client, moov);

    // Exactly the available balance ("Transfer all available") goes through.
    client = fakeDb();
    moov = moovStub({ availableCents: 2500 });
    result = await run(client, moov);
    assert.equal(result.ok, true, JSON.stringify(result));

    // A send leg still being submitted from the wallet is not spendable twice.
    client = fakeDb({
      transfers: [{ id: '00000000-0000-4000-8000-0000000000aa', tenant_id: TENANT, idempotency_key: 'send:x', amount_cents: 1000, leg_role: 'send_wallet', status: 'submitting' }],
    });
    moov = moovStub({ availableCents: 3000 });
    result = await run(client, moov);
    assert.equal(result.error, 'insufficient_available_balance', JSON.stringify(result));
    assert.equal(result.available_cents, 2000);
    assert.equal(moov.posts().length, 0);
  });
});

test('tenant limits: above the per-transfer or daily limit is tenant_limit_exceeded; no limit set means none', async () => {
  await withEnv(FLAGS, async () => {
    let client = fakeDb({ limits: { wallet_withdraw_max_per_transfer_cents: '2000', wallet_withdraw_max_per_day_cents: null } });
    let moov = moovStub();
    let result = await run(client, moov);
    assert.equal(result.statusCode, 409, JSON.stringify(result));
    assert.equal(result.error, 'tenant_limit_exceeded');
    assert.equal(result.limit, 'per_transfer');
    nothingHappened(client, moov);

    // Earlier transfers today count (failed ones do not).
    client = fakeDb({
      limits: { wallet_withdraw_max_per_transfer_cents: null, wallet_withdraw_max_per_day_cents: '5000' },
      transfers: [
        { id: '00000000-0000-4000-8000-0000000000b1', tenant_id: TENANT, idempotency_key: 'wallet-withdraw:a', amount_cents: 2000, leg_role: 'wallet_withdrawal', status: 'pending' },
        { id: '00000000-0000-4000-8000-0000000000b2', tenant_id: TENANT, idempotency_key: 'wallet-withdraw:b', amount_cents: 9000, leg_role: 'wallet_withdrawal', status: 'failed' },
      ],
    });
    moov = moovStub();
    result = await run(client, moov, { amount_cents: 3001 });
    assert.equal(result.error, 'tenant_limit_exceeded', JSON.stringify(result));
    assert.equal(result.limit, 'per_day');
    assert.equal(result.used_today_cents, 2000);
    assert.equal(moov.posts().length, 0);
    result = await run(client, moov, { amount_cents: 3000 });
    assert.equal(result.ok, true, JSON.stringify(result));

    // A settings row with both limits empty, or no row at all: no limit.
    for (const limits of [{ wallet_withdraw_max_per_transfer_cents: null, wallet_withdraw_max_per_day_cents: null }, null]) {
      const big = await run(fakeDb({ limits }), moovStub({ availableCents: 250_000_000 }), { amount_cents: 250_000_000 });
      assert.equal(big.ok, true, JSON.stringify(big));
    }
  });
});

test('before SQL 164 is live (no limit columns) nothing is recorded or sent', async () => {
  await withEnv(FLAGS, async () => {
    const client = fakeDb({ limits: 'missing' });
    const moov = moovStub();
    const result = await run(client, moov);
    assert.equal(result.statusCode, 503, JSON.stringify(result));
    assert.equal(result.error, 'withdrawal_not_ready');
    assert.equal(moov.calls.length, 0);
    nothingHappened(client, moov);
  });
});

test('the destination is the tenant\'s default bank only, verified at Moov with a same-day credit method', async () => {
  await withEnv(FLAGS, async () => {
    const OTHER_ROW = '1eb5b26e-6f66-435c-a578-880fb7fc14dd';
    const cases = [
      // Moov has the default bank but not verified.
      [{}, { credits: [sameDay('pm-same-day', 'bank-1', 'new')] }, 'same_day_unavailable'],
      // Only standard ACH credit at Moov.
      [{}, { credits: [] }, 'same_day_unavailable'],
      // The default bank has no same-day method; another bank does: never used.
      [{ banks: [
        { id: BANK_ROW, provider_bank_account_id: 'bank-1', is_default: true },
        { id: OTHER_ROW, provider_bank_account_id: 'bank-2', is_default: false },
      ] }, { credits: [sameDay('pm-other', 'bank-2')] }, 'same_day_unavailable'],
      // No default bank: refused, even with a single connected bank (owner decision 2026-11-13).
      [{ banks: [{ id: BANK_ROW, provider_bank_account_id: 'bank-1', is_default: false }] }, {}, 'default_bank_required'],
      [{ banks: [
        { id: BANK_ROW, provider_bank_account_id: 'bank-1', is_default: false },
        { id: OTHER_ROW, provider_bank_account_id: 'bank-2', is_default: false },
      ] }, { credits: [sameDay('pm-same-day', 'bank-1'), sameDay('pm-other', 'bank-2')] }, 'default_bank_required'],
      // No connected ChecksOps bank of this tenant at all (a recipient's bank is never listed).
      [{ banks: [] }, {}, 'default_bank_required'],
    ];
    for (const [db, stub, error] of cases) {
      const client = fakeDb(db);
      const moov = moovStub(stub);
      const result = await run(client, moov);
      assert.equal(result.statusCode, 409, JSON.stringify(result));
      assert.equal(result.error, error, JSON.stringify({ db, stub }));
      assert.match(result.message, /Nothing was sent/);
      nothingHappened(client, moov);
    }
  });
});

test('with a default bank and another verified bank, the default one is credited', async () => {
  await withEnv(FLAGS, async () => {
    const client = fakeDb({ banks: [
      { id: BANK_ROW, provider_bank_account_id: 'bank-1', is_default: true },
      { id: '1eb5b26e-6f66-435c-a578-880fb7fc14dd', provider_bank_account_id: 'bank-2', is_default: false },
    ] });
    const moov = moovStub({ credits: [sameDay('pm-other', 'bank-2'), sameDay('pm-same-day', 'bank-1')] });
    const result = await run(client, moov);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(moov.posts()[0].body.destination, { paymentMethodID: 'pm-same-day' });
    assert.equal(client.committed.transfers[0].destination_payment_method_id, BANK_ROW);
  });
});

test('the same click never sends twice; the key cannot be reused for another amount', async () => {
  await withEnv(FLAGS, async () => {
    const client = fakeDb();
    const moov = moovStub();
    const first = await run(client, moov);
    assert.equal(first.ok, true);
    const second = await run(client, moov);
    assert.equal(second.ok, true);
    assert.equal(second.duplicate, true);
    assert.equal(second.transfer.provider_transfer_id, 'moov-xfer-1');
    assert.equal(moov.posts().length, 1);

    const reused = await run(client, moov, { amount_cents: 999 });
    assert.equal(reused.statusCode, 409);
    assert.equal(reused.error, 'idempotency_key_reused');
    assert.equal(moov.posts().length, 1);
  });
});

test('a funding key is never accepted as a transfer to bank', async () => {
  await withEnv(FLAGS, async () => {
    const client = fakeDb({
      transfers: [{ id: '00000000-0000-4000-8000-000000000009', tenant_id: TENANT, idempotency_key: `wallet-withdraw:${CLICK}`, amount_cents: 2500, leg_role: 'wallet_funding', status: 'ready', provider_transfer_id: null }],
    });
    const moov = moovStub();
    const result = await run(client, moov);
    assert.equal(result.error, 'idempotency_key_reused');
    assert.equal(moov.posts().length, 0);
  });
});

test('a row already claimed or settled is reported, not posted again', async () => {
  await withEnv(FLAGS, async () => {
    for (const status of ['submitting', 'unknown', 'failed', 'pending']) {
      const client = fakeDb({
        transfers: [{ id: '00000000-0000-4000-8000-000000000009', tenant_id: TENANT, idempotency_key: `wallet-withdraw:${CLICK}`, amount_cents: 2500, leg_role: 'wallet_withdrawal', status, provider_transfer_id: null }],
      });
      const moov = moovStub();
      const result = await run(client, moov);
      assert.equal(result.duplicate, true, status);
      assert.equal(moov.posts().length, 0, status);
    }
  });
});

test('a timeout or 5xx is recorded as unknown, committed, and never retried automatically', async () => {
  await withEnv(FLAGS, async () => {
    for (const postResult of [
      { throw: new TypeError('fetch failed') },
      { status: 503, body: { error: 'unavailable' } },
      { status: 429, body: { error: 'slow down' } },
    ]) {
      const client = fakeDb();
      const moov = moovStub({ postResult });
      const result = await run(client, moov);
      assert.equal(result.ok, false);
      assert.equal(client.committed.transfers[0].status, 'unknown', JSON.stringify(postResult));
      assert.equal(client.committed.events.at(-1).type, 'wallet.withdrawal.unknown');
      const retry = await run(client, moov);
      assert.equal(retry.duplicate, true);
      assert.equal(retry.error, 'provider_outcome_unknown');
      assert.equal(moov.posts().length, 1);
    }
  });
});

test('a Moov refusal (4xx) is recorded as failed and says nothing was sent', async () => {
  await withEnv(FLAGS, async () => {
    const client = fakeDb();
    const moov = moovStub({ postResult: { status: 422, body: { error: 'insufficient funds' } } });
    const result = await run(client, moov);
    assert.equal(result.error, 'provider_transfer_refused');
    assert.match(result.message, /Nothing was sent/);
    assert.equal(client.committed.transfers[0].status, 'failed');
    assert.equal(client.committed.events.at(-1).type, 'wallet.withdrawal.failed');
  });
});

test('with transfer posting held, nothing is recorded or sent', async () => {
  await withEnv({ ...FLAGS, AWS_MOOV_TRANSFER_POST_ENABLED: 'false' }, async () => {
    const client = fakeDb();
    const moov = moovStub();
    const result = await run(client, moov);
    assert.equal(result.statusCode, 403);
    assert.equal(result.error, 'transfer_post_held');
    nothingHappened(client, moov);
  });
});

test('production gate: financial permissions off or sandbox execution on refuses', async () => {
  for (const env of [
    { ...FLAGS, AWS_FINANCIAL_PERMISSIONS_ACTIVATED: 'false' },
    { ...FLAGS, AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'true' },
  ]) {
    await withEnv(env, async () => {
      const client = fakeDb();
      const moov = moovStub();
      const result = await run(client, moov);
      assert.equal(result.ok, false, JSON.stringify(env));
      nothingHappened(client, moov);
    });
  }
});

/** A New York wall-clock time (November and October 2026 are EST/EDT; offsets given explicitly). */
const et = (iso) => new Date(iso);

test('expected arrival: today before the cutoff on a banking day, else the next banking day (weekends and Fed holidays skipped)', () => {
  // Plain week: Tuesday 10:00 ET → today; Friday 17:00 ET and the weekend → Monday.
  assert.deepEqual(expectedArrival(TUESDAY_MORNING), { arrives: 'today', date: '2026-11-10' });
  assert.deepEqual(expectedArrival(et('2026-11-13T17:00:00-05:00')), { arrives: 'next_banking_day', date: '2026-11-16' });
  assert.deepEqual(expectedArrival(et('2026-11-14T10:00:00-05:00')), { arrives: 'next_banking_day', date: '2026-11-16' });
  assert.deepEqual(expectedArrival(et('2026-11-15T10:00:00-05:00')), { arrives: 'next_banking_day', date: '2026-11-16' });
  // Friday 23:30 ET is already Saturday in UTC: still Monday.
  assert.deepEqual(expectedArrival(et('2026-11-13T23:30:00-05:00')), { arrives: 'next_banking_day', date: '2026-11-16' });
  // The cutoff itself: 16:44 ET is today, 16:45 ET is the next banking day.
  assert.deepEqual(expectedArrival(et('2026-11-10T16:44:00-05:00')), { arrives: 'today', date: '2026-11-10' });
  assert.deepEqual(expectedArrival(et('2026-11-10T16:45:00-05:00')).arrives, 'next_banking_day');
});

test('expected arrival: after the cutoff on the day before a holiday skips the holiday (Veterans Day 2026, a Wednesday)', () => {
  assert.deepEqual(expectedArrival(et('2026-11-10T16:45:00-05:00')), { arrives: 'next_banking_day', date: '2026-11-12' });
  assert.deepEqual(expectedArrival(et('2026-11-10T17:00:00-05:00')), { arrives: 'next_banking_day', date: '2026-11-12' });
  // On the holiday itself, even in the morning, nothing settles today.
  assert.deepEqual(expectedArrival(et('2026-11-11T09:00:00-05:00')), { arrives: 'next_banking_day', date: '2026-11-12' });
});

test('expected arrival: a Monday holiday (Columbus Day 2026-10-12) moves Friday-after-cutoff and the holiday to Tuesday', () => {
  assert.deepEqual(expectedArrival(et('2026-10-09T10:00:00-04:00')), { arrives: 'today', date: '2026-10-09' });
  assert.deepEqual(expectedArrival(et('2026-10-09T17:00:00-04:00')), { arrives: 'next_banking_day', date: '2026-10-13' });
  assert.deepEqual(expectedArrival(et('2026-10-10T12:00:00-04:00')), { arrives: 'next_banking_day', date: '2026-10-13' });
  assert.deepEqual(expectedArrival(et('2026-10-12T09:00:00-04:00')), { arrives: 'next_banking_day', date: '2026-10-13' });
  assert.deepEqual(expectedArrival(et('2026-10-13T09:00:00-04:00')), { arrives: 'today', date: '2026-10-13' });
});

test('expected arrival: Thanksgiving week 2026 (Thursday 11-26 closed, Friday 11-27 open)', () => {
  assert.deepEqual(expectedArrival(et('2026-11-25T10:00:00-05:00')), { arrives: 'today', date: '2026-11-25' });
  assert.deepEqual(expectedArrival(et('2026-11-25T17:00:00-05:00')), { arrives: 'next_banking_day', date: '2026-11-27' });
  assert.deepEqual(expectedArrival(et('2026-11-26T10:00:00-05:00')), { arrives: 'next_banking_day', date: '2026-11-27' });
  assert.deepEqual(expectedArrival(et('2026-11-27T10:00:00-05:00')), { arrives: 'today', date: '2026-11-27' });
  assert.deepEqual(expectedArrival(et('2026-11-27T17:00:00-05:00')), { arrives: 'next_banking_day', date: '2026-11-30' });
});

test('expected arrival: a Sunday holiday is observed Monday; a Saturday holiday is not observed', () => {
  // Independence Day 2027 is a Sunday: Friday after cutoff → Tuesday 07-06.
  assert.deepEqual(expectedArrival(et('2027-07-02T17:00:00-04:00')), { arrives: 'next_banking_day', date: '2027-07-06' });
  // Christmas 2027 is a Saturday: Friday 12-24 is a banking day.
  assert.deepEqual(expectedArrival(et('2027-12-24T10:00:00-05:00')), { arrives: 'today', date: '2027-12-24' });
  // New Year's Day 2028 is a Saturday: Friday 2027-12-31 is a banking day; after its cutoff → Monday 01-03.
  assert.deepEqual(expectedArrival(et('2027-12-31T10:00:00-05:00')), { arrives: 'today', date: '2027-12-31' });
  assert.deepEqual(expectedArrival(et('2027-12-31T17:00:00-05:00')), { arrives: 'next_banking_day', date: '2028-01-03' });
});

test('limit and method helpers', () => {
  assert.equal(tenantLimitBreach({ amount: 100, perTransfer: null, perDay: null, todayCents: 1e9 }), null);
  assert.deepEqual(tenantLimitBreach({ amount: 101, perTransfer: 100, perDay: null }), { limit: 'per_transfer', limit_cents: 100 });
  assert.equal(tenantLimitBreach({ amount: 100, perTransfer: 100, perDay: 300, todayCents: 200 }), null);
  assert.deepEqual(tenantLimitBreach({ amount: 101, perTransfer: null, perDay: 300, todayCents: 200 }), { limit: 'per_day', limit_cents: 300, used_today_cents: 200 });

  assert.equal(selectSameDayCreditMethod([sameDay('a', 'b1')], 'b1').method.paymentMethodID, 'a');
  assert.equal(selectSameDayCreditMethod([sameDay('a', 'b1'), sameDay('c', 'b2')], 'b2').method.paymentMethodID, 'c');
  assert.equal(selectSameDayCreditMethod([sameDay('a', 'b1')], null).error, 'default_bank_required');
  assert.equal(selectSameDayCreditMethod([sameDay('a', 'b1'), sameDay('c', 'b2')], null).error, 'default_bank_required');
  assert.equal(selectSameDayCreditMethod([sameDay('a', 'b1', 'pending')], 'b1').error, 'same_day_unavailable');
  assert.equal(selectSameDayCreditMethod([{ ...sameDay('a', 'b1'), paymentMethodType: 'ach-credit-standard' }], 'b1').error, 'same_day_unavailable');
  assert.equal(selectSameDayCreditMethod([sameDay('c', 'b2')], 'b1').error, 'same_day_unavailable');
  assert.equal(selectSameDayCreditMethod(null, 'b1').error, 'same_day_unavailable');
});
