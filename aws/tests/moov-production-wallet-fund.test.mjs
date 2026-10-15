import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LOOKUP_MAPPING_SQL } from '../functions/api/identity.mjs';
import { handleProviderRequest } from '../functions/api/providers.mjs';
import {
  moovRefusedTransfer,
  parseFundAmountCents,
  preferredBank,
  resolveFacilitatorId,
  selectDebitMethod,
} from '../functions/api/providers/production/moov-wallet-fund.mjs';
import { loginSessionBinding } from '../functions/api/providers/production/moov-fund-authz.mjs';
import { resolveFinancialStepUpBinding, insertAppStepUpLog } from '../functions/api/auth-financial-totp.mjs';
import { MoovError } from '../functions/api/providers/parity/moov-client.mjs';

const APP_USER = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const OTHER_TENANT = '9b1f3c55-1111-4222-8333-444455556666';
const SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const ORIGIN_JTI = 'b2c3d4e5-aaaa-4bbb-8ccc-000011112222';
const LOGIN = `${SUB}:jti:${ORIGIN_JTI}`;
const CLICK = '0b0e0c3a-5f4e-4d2c-9a1b-2c3d4e5f6a7b';

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

const fundEvent = (body, claims = {}) => ({
  rawPath: '/functions/v1/moov-wallet-fund',
  headers: { authorization: 'Bearer test-id-token' },
  body: JSON.stringify(body),
  requestContext: {
    stage: 'production',
    http: { method: 'POST', path: '/functions/v1/moov-wallet-fund' },
    authorizer: {
      jwt: {
        claims: {
          sub: SUB, email: 'tester@example.com', token_use: 'id', origin_jti: ORIGIN_JTI, auth_time: '1791000000', ...claims,
        },
      },
    },
  },
});

/**
 * A small transactional fake: writes become visible to later reads only once
 * committed, and a ROLLBACK discards uncommitted writes, so tests can prove
 * what survives a failed request.
 */
const fakeDb = ({
  memberships = [{ tenant_id: TENANT, role: 'member', tenant_name: 'Freedom', tenant_slug: 'freedom' }],
  stepUps = [{ id: 'stepup-1', user_id: APP_USER, tenant_id: TENANT, action_key: 'wallet.fund', login_session: LOGIN }],
  account = { tenant_id: TENANT, environment: 'production', provider_account_id: 'moov-acct', onboarding_status: 'active' },
  transfers = [],
} = {}) => {
  const committed = { transfers: transfers.map((t) => ({ ...t })), events: [] };
  let pending = null;
  const begin = () => { pending = { transfers: committed.transfers.map((t) => ({ ...t })), events: [...committed.events] }; };
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
        return { command: 'COMMIT', rows: [] };
      }
      if (sql === 'ROLLBACK') { pending = null; return { rows: [] }; }
      if (/^(SET TRANSACTION|SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)/.test(sql)) return { rows: [] };
      if (sql.startsWith('SELECT set_config')) return { rows: [{}] };
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
        return { rows: [{ id: '8eb5b26e-6f66-435c-a578-880fb7fc14dd', provider_bank_account_id: 'bank-1', provider_payment_method_id: 'pm-bank-credit', is_default: true }] };
      }
      if (sql.includes('SELECT * FROM public.payment_transfers')) {
        return { rows: state().transfers.filter((t) => t.tenant_id === params[0] && t.idempotency_key === params[1]) };
      }
      if (sql.includes('INSERT INTO public.payment_transfers')) {
        if (state().transfers.some((t) => t.tenant_id === params[0] && t.idempotency_key === params[2])) {
          const error = new Error('duplicate key value'); error.code = '23505'; throw error;
        }
        const row = {
          id: `00000000-0000-4000-8000-00000000000${state().transfers.length + 1}`,
          tenant_id: params[0], environment: params[1], status: 'ready', idempotency_key: params[2],
          amount_cents: params[3], source_payment_method_id: params[6], wallet_id: params[7],
          leg_role: 'wallet_funding', provider_metadata: JSON.parse(params[8]), provider_transfer_id: null,
        };
        state().transfers.push(row);
        return { rows: [row] };
      }
      if (sql.includes("SET status = 'submitting'")) {
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

const moovStub = ({ postResult = { status: 201, body: { transferID: 'moov-xfer-1', status: 'created' } }, debit = [{ id: 'pm-debit', bank: 'bank-1' }] } = {}) => {
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
      return reply(200, [{ walletID: 'wallet-1', walletType: 'default', availableBalance: { value: 0 }, pendingBalance: { value: 0 } }]);
    }
    if (method === 'GET' && path.endsWith('/payment-methods')) {
      return reply(200, [
        { paymentMethodType: 'moov-wallet', paymentMethodID: 'pm-wallet', wallet: { walletID: 'wallet-1' } },
        ...debit.map((d) => ({ paymentMethodType: 'ach-debit-fund', paymentMethodID: d.id, bankAccount: { bankAccountID: d.bank } })),
        { paymentMethodType: 'ach-credit-standard', paymentMethodID: 'pm-bank-credit', bankAccount: { bankAccountID: 'bank-1' } },
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

const run = (client, moov, body = {}, claims = {}) => handleProviderRequest(
  fundEvent({ tenant_id: TENANT, amount_cents: 2500, idempotency_key: CLICK, ...body }, claims),
  '/functions/v1/moov-wallet-fund',
  'POST',
  {
    loadDatabaseCredentials: async () => ({ host: 'localhost', username: 'checksops', password: 'x', database: 'checksops' }),
    createClient: () => client,
    loadProviderSecrets: async () => ({ MOOV_PUBLIC_KEY: 'pk', MOOV_SECRET_KEY: 'sk', MOOV_ACCOUNT_ID: 'platform-acct' }),
    fetchImpl: moov.impl,
  },
);

test('funding moves bank → wallet once, with the transfer row committed before Moov is called', async () => {
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
    assert.equal(result.transfer.status, 'submitted');
    assert.equal(result.transfer.provider_transfer_id, 'moov-xfer-1');
    assert.equal(result.environment, 'production');

    const [post] = moov.posts();
    assert.equal(post.path, '/accounts/platform-acct/transfers');
    assert.deepEqual(post.body.source, { paymentMethodID: 'pm-debit' });
    assert.deepEqual(post.body.destination, { paymentMethodID: 'pm-wallet' });
    assert.deepEqual(post.body.amount, { currency: 'USD', value: 2500 });
    const row = client.committed.transfers[0];
    assert.equal(post.headers['X-Idempotency-Key'], row.id);
    assert.deepEqual(commitsBeforePost, [['submitting']]);
    assert.equal(row.environment, 'production');
    assert.equal(row.idempotency_key, `wallet-fund:${CLICK}`);
    assert.equal(row.status, 'submitted');
    assert.deepEqual(client.committed.events.map((e) => e.type), ['wallet.funding.created', 'wallet.funding.submitted']);
  });
});

test('any tenant member can fund; no role or amount limit applies', async () => {
  await withEnv(FLAGS, async () => {
    const client = fakeDb({ memberships: [{ tenant_id: TENANT, role: 'viewer' }] });
    const moov = moovStub();
    const result = await run(client, moov, { amount_cents: 250_000_000 });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(moov.posts()[0].body.amount.value, 250_000_000);
  });
});

test('without a two-factor code in this login, nothing is recorded or sent', async () => {
  await withEnv(FLAGS, async () => {
    for (const [stepUps, claims] of [
      [[], {}],
      [undefined, { origin_jti: 'a-different-login' }],
      [undefined, { origin_jti: undefined, auth_time: undefined }],
      [[{ id: 's', user_id: APP_USER, tenant_id: OTHER_TENANT, action_key: 'wallet.fund', login_session: LOGIN }], {}],
      [[{ id: 's', user_id: APP_USER, tenant_id: TENANT, action_key: 'deposit.submit', login_session: LOGIN }], {}],
    ]) {
      const client = fakeDb(stepUps ? { stepUps } : {});
      const moov = moovStub();
      const result = await run(client, moov, {}, claims);
      assert.equal(result.statusCode, 401, JSON.stringify(result));
      assert.equal(result.error, 'totp_required');
      assert.equal(moov.calls.length, 0);
      assert.equal(client.committed.transfers.length, 0);
    }
  });
});

test('the same click never sends twice', async () => {
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

test('a row already claimed by another request is not posted again', async () => {
  await withEnv(FLAGS, async () => {
    for (const status of ['submitting', 'unknown', 'failed', 'pending']) {
      const client = fakeDb({
        transfers: [{ id: '00000000-0000-4000-8000-000000000009', tenant_id: TENANT, idempotency_key: `wallet-fund:${CLICK}`, amount_cents: 2500, leg_role: 'wallet_funding', status, provider_transfer_id: null }],
      });
      const moov = moovStub();
      const result = await run(client, moov);
      assert.equal(result.duplicate, true, status);
      assert.equal(moov.posts().length, 0, status);
    }
  });
});

test('a committed but never-sent row is resumed with the same Moov idempotency key', async () => {
  await withEnv(FLAGS, async () => {
    const id = '00000000-0000-4000-8000-000000000007';
    const client = fakeDb({
      transfers: [{
        id, tenant_id: TENANT, idempotency_key: `wallet-fund:${CLICK}`, amount_cents: 2500, leg_role: 'wallet_funding',
        status: 'ready', provider_transfer_id: null, wallet_id: 'wallet-row',
        provider_metadata: { source_moov_payment_method_id: 'pm-debit', destination_moov_payment_method_id: 'pm-wallet' },
      }],
    });
    const moov = moovStub();
    const result = await run(client, moov);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(moov.posts().length, 1);
    assert.equal(moov.posts()[0].headers['X-Idempotency-Key'], id);
    assert.equal(client.committed.transfers.length, 1);
  });
});

test('a timeout or 5xx is recorded as unknown and committed even though the request fails', async () => {
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
      assert.equal(client.committed.events.at(-1).type, 'wallet.funding.unknown');
      const retry = await run(client, moov);
      assert.equal(retry.duplicate, true);
      assert.equal(moov.posts().length, 1);
    }
  });
});

test('a Moov refusal is recorded as failed and committed', async () => {
  await withEnv(FLAGS, async () => {
    const client = fakeDb();
    const moov = moovStub({ postResult: { status: 422, body: { error: 'insufficient capabilities', errors: { source: 'internal detail' } } } });
    const result = await run(client, moov);
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 502);
    assert.equal(result.error, 'provider_transfer_refused');
    assert.doesNotMatch(JSON.stringify(result), /internal detail|insufficient capabilities/);
    assert.equal(client.committed.transfers[0].status, 'failed');
    assert.match(client.committed.transfers[0].failure_reason, /insufficient capabilities/);
  });
});

test('the transfer switch off records nothing and sends nothing', async () => {
  await withEnv({ ...FLAGS, AWS_MOOV_TRANSFER_POST_ENABLED: undefined }, async () => {
    const client = fakeDb();
    const moov = moovStub();
    const result = await run(client, moov);
    assert.equal(result.statusCode, 403);
    assert.equal(result.error, 'transfer_post_held');
    assert.equal(moov.calls.length, 0);
    assert.equal(client.committed.transfers.length, 0);
  });
});

test('funding needs financial permissions on and sandbox execution off', async () => {
  for (const env of [{ AWS_FINANCIAL_PERMISSIONS_ACTIVATED: undefined }, { AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'true' }]) {
    await withEnv({ ...FLAGS, ...env }, async () => {
      const client = fakeDb();
      const moov = moovStub();
      const result = await run(client, moov);
      assert.equal(result.statusCode, 403, JSON.stringify(env));
      assert.equal(moov.calls.length, 0);
      assert.equal(client.committed.transfers.length, 0);
    });
  }
});

test('a resumed request whose bank or wallet changed is refused, not sent', async () => {
  await withEnv(FLAGS, async () => {
    const client = fakeDb({
      transfers: [{
        id: '00000000-0000-4000-8000-000000000008', tenant_id: TENANT, idempotency_key: `wallet-fund:${CLICK}`, amount_cents: 2500,
        leg_role: 'wallet_funding', status: 'ready', provider_transfer_id: null, wallet_id: 'wallet-row',
        provider_metadata: { source_moov_payment_method_id: 'pm-old-bank', destination_moov_payment_method_id: 'pm-wallet' },
      }],
    });
    const moov = moovStub();
    const result = await run(client, moov);
    assert.equal(result.error, 'idempotency_key_reused');
    assert.equal(moov.posts().length, 0);
  });
});

test('without a platform account id the facilitator comes only from this tenant\'s wallet, else nothing is sent', async () => {
  const methods = [{ paymentMethodType: 'moov-wallet', paymentMethodID: 'pm-wallet', wallet: { walletID: 'w', partnerAccountID: 'partner-1' } }];
  assert.equal(resolveFacilitatorId('platform-acct', methods, 'pm-wallet'), 'platform-acct');
  assert.equal(resolveFacilitatorId(null, methods, 'pm-wallet'), 'partner-1');
  assert.equal(resolveFacilitatorId(null, methods, 'pm-other'), null);
  assert.equal(resolveFacilitatorId(null, [], 'pm-wallet'), null);
  await withEnv(FLAGS, async () => {
    const client = fakeDb();
    const moov = moovStub();
    const result = await handleProviderRequest(
      fundEvent({ tenant_id: TENANT, amount_cents: 2500, idempotency_key: CLICK }),
      '/functions/v1/moov-wallet-fund',
      'POST',
      {
        loadDatabaseCredentials: async () => ({ host: 'localhost', username: 'checksops', password: 'x', database: 'checksops' }),
        createClient: () => client,
        loadProviderSecrets: async () => ({ MOOV_PUBLIC_KEY: 'pk', MOOV_SECRET_KEY: 'sk' }),
        fetchImpl: moov.impl,
      },
    );
    assert.equal(result.error, 'facilitator_unavailable');
    assert.equal(moov.posts().length, 0);
    assert.equal(client.committed.transfers.length, 0);
  });
});

test('non-members, platform roles and other tenants cannot fund', async () => {
  await withEnv(FLAGS, async () => {
    const client = fakeDb({ memberships: [{ tenant_id: OTHER_TENANT, role: 'owner' }] });
    const moov = moovStub();
    const result = await run(client, moov);
    assert.equal(result.statusCode, 403);
    assert.equal(moov.calls.length, 0);
  });
});

test('bad input is refused before anything happens', async () => {
  await withEnv(FLAGS, async () => {
    for (const body of [
      { amount_cents: 0 }, { amount_cents: -5 }, { amount_cents: 12.5 }, { amount_cents: '1e3' },
      { idempotency_key: undefined }, { idempotency_key: 'not-a-uuid' }, { wallet_type: 'savings' },
    ]) {
      const client = fakeDb();
      const moov = moovStub();
      const result = await run(client, moov, body);
      assert.equal(result.statusCode, 400, JSON.stringify(body));
      assert.equal(moov.calls.length, 0);
    }
  });
});

test('no verified bank, or several banks without a default, stops before any row is written', async () => {
  await withEnv(FLAGS, async () => {
    const none = fakeDb();
    const noneResult = await run(none, moovStub({ debit: [] }));
    assert.equal(noneResult.error, 'bank_not_ready');
    assert.equal(none.committed.transfers.length, 0);

    const preferred = fakeDb();
    const moov = moovStub({ debit: [{ id: 'pm-other', bank: 'bank-2' }, { id: 'pm-debit', bank: 'bank-1' }] });
    const ok = await run(preferred, moov);
    assert.equal(ok.ok, true);
    assert.deepEqual(moov.posts()[0].body.source, { paymentMethodID: 'pm-debit' });
  });
});

test('staging keeps using the sandbox path (production handler not reached)', async () => {
  await withEnv({ ...FLAGS, AWS_PROVIDER_EXECUTION_ENABLED: undefined, AWS_MOOV_ENABLED: undefined }, async () => {
    const client = fakeDb();
    const moov = moovStub();
    const result = await run(client, moov);
    assert.equal(result.statusCode, 403);
    assert.equal(result.error, 'provider_disabled');
    // The generic deny names the route; the production handler would say 'wallet.fund'.
    assert.equal(result.operation, 'moov-wallet-fund');
    assert.equal(moov.calls.length, 0);
  });
});

test('Moov answering with a failed transfer, or a repeat of a failed click, is not reported as success', async () => {
  await withEnv(FLAGS, async () => {
    const client = fakeDb();
    const moov = moovStub({ postResult: { status: 200, body: { transferID: 'moov-xfer-9', status: 'failed' } } });
    const result = await run(client, moov);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'funding_failed');
    assert.equal(client.committed.transfers[0].status, 'failed');
    const again = await run(client, moov);
    assert.equal(again.ok, false);
    assert.equal(again.duplicate, true);
    assert.equal(moov.posts().length, 1);
  });
});

test('the funding bank is the Automatic Funding choice or the default; otherwise exactly one bank', async () => {
  assert.equal(preferredBank([{ id: 'a', is_default: false }, { id: 'b', is_default: true }], 'a').id, 'a');
  assert.equal(preferredBank([{ id: 'a', is_default: false }, { id: 'b', is_default: true }], null).id, 'b');
  assert.equal(preferredBank([{ id: 'a', is_default: false }, { id: 'b', is_default: false }], null), null);
  assert.equal(preferredBank([{ id: 'a', is_default: false }], 'missing'), null);
});

test('helpers', () => {
  assert.equal(parseFundAmountCents(100), 100);
  assert.equal(parseFundAmountCents('100'), 100);
  for (const bad of [0, -1, 1.5, '1.5', '', null, undefined, Number.MAX_SAFE_INTEGER + 1, '1e3']) {
    assert.equal(parseFundAmountCents(bad), null, String(bad));
  }
  assert.equal(moovRefusedTransfer(new MoovError('no', 422)), true);
  assert.equal(moovRefusedTransfer(new MoovError('slow', 429)), false);
  assert.equal(moovRefusedTransfer(new MoovError('conflict', 409)), false);
  assert.equal(moovRefusedTransfer(new MoovError('down', 503)), false);
  assert.equal(moovRefusedTransfer(new TypeError('fetch failed')), false);
  assert.deepEqual(selectDebitMethod([], null), { error: 'bank_not_ready' });
  assert.equal(selectDebitMethod([
    { paymentMethodType: 'ach-debit-fund', paymentMethodID: 'a', bankAccount: { bankAccountID: 'b1' } },
    { paymentMethodType: 'ach-debit-fund', paymentMethodID: 'b', bankAccount: { bankAccountID: 'b2' } },
  ], null).error, 'bank_choice_required');
  assert.equal(loginSessionBinding({ sub: 's', origin_jti: 'j-1' }), 's:jti:j-1');
  assert.equal(loginSessionBinding({ sub: 's', auth_time: 1791000000 }), 's:auth:1791000000');
  assert.equal(loginSessionBinding({ sub: 's' }), null);
  assert.equal(loginSessionBinding({ origin_jti: 'j' }), null);
});

test('the step-up endpoint binds wallet.fund to the tenant and this login', async () => {
  const client = {
    query: async (sql, params) => {
      if (sql.includes('tenant_users')) return { rows: [{ tenant_id: TENANT, role: 'member' }] };
      if (sql.includes('INSERT INTO public.financial_stepup_log')) {
        return { rows: [{ id: 'new-stepup', created_at: 'now', params }] };
      }
      return { rows: [] };
    },
  };
  const mapping = { application_user_id: APP_USER };
  const claims = { sub: SUB, origin_jti: ORIGIN_JTI };
  const bound = await resolveFinancialStepUpBinding({ client, mapping, claims, body: { action_key: 'wallet.fund', tenant_id: TENANT } });
  assert.equal(bound.ok, true);
  assert.equal(bound.loginSession, LOGIN);
  const denied = await resolveFinancialStepUpBinding({ client, mapping, claims, body: { action_key: 'wallet.fund', tenant_id: OTHER_TENANT } });
  assert.equal(denied.statusCode, 403);
  const unbound = await resolveFinancialStepUpBinding({ client, mapping, claims: { sub: SUB }, body: { action_key: 'wallet.fund', tenant_id: TENANT } });
  assert.equal(unbound.error, 'login_session_unbound');
  const other = await resolveFinancialStepUpBinding({ client, mapping, claims, body: { action_key: 'wallet.send', tenant_id: TENANT } });
  assert.equal(other.error, 'action_mismatch');

  let inserted;
  const recordClient = { query: async (sql, params) => { inserted = params; return { rows: [{ id: 'new-stepup' }] }; } };
  const recorded = await insertAppStepUpLog(recordClient, mapping, bound);
  assert.equal(recorded.ok, true);
  assert.equal(inserted[1], TENANT);
  assert.equal(inserted[2], 'wallet.fund');
  assert.equal(JSON.parse(inserted[3]).login_session, LOGIN);
});

test('WalletOps asks for two-factor once per login and sends one key per click', async () => {
  const fs = await import('node:fs');
  const read = (file) => fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
  const hook = read('src/hooks/useWallet.ts');
  const fundBlock = hook.slice(hook.indexOf('const fund = useMutation'), hook.indexOf('const refresh = useMutation'));
  assert.match(fundBlock, /actionKey: "wallet\.fund"/);
  assert.equal((fundBlock.match(/crypto\.randomUUID\(\)/g) || []).length, 1);
  // The key is created before the first send and reused by the retry after a fresh code.
  assert.ok(fundBlock.indexOf('crypto.randomUUID()') < fundBlock.indexOf('const send'));
  assert.match(fundBlock, /error\.code !== "totp_required"/);
  // The code is asked for only when the server says this login has not confirmed it.
  assert.equal((fundBlock.match(/requireStepUp\(/g) || []).length, 1);
  assert.match(fundBlock, /requireStepUp\(stepUp, \{ force: true \}\)/);

  const wallets = read('src/lib/payments/wallets.ts');
  assert.match(wallets, /idempotencyKey: string;/);
  assert.match(wallets, /context\?\.body/);

  const dialog = read('src/components/auth/StepUpDialog.tsx');
  // Setup records this login's wallet.fund confirmation (a login-bound action).
  assert.match(dialog, /isLoginBoundAction\(request\.actionKey\)/);
  assert.match(read('src/lib/financialStepUp.ts'), /LOGIN_BOUND_ACTIONS = Object\.freeze\(\[\s*"wallet\.fund",/);
});

test('SQL 72 lets only tenant members write, and only while the server has set the financial GUCs', async () => {
  const fs = await import('node:fs');
  const sql = fs.readFileSync(new URL('../../aws/workflows/sql/72_member_payment_writes.sql', import.meta.url), 'utf8');
  const statements = sql.split('\n').filter((line) => !line.startsWith('--')).join('\n')
    .split(';').map((s) => s.trim()).filter(Boolean);
  const policies = statements.filter((s) => s.startsWith('CREATE POLICY'));
  assert.deepEqual(policies.map((s) => s.match(/^CREATE POLICY (\S+) ON (\S+)\s+FOR (\w+) TO (\w+)/).slice(1)), [
    ['aws_member_insert_payment_transfers', 'public.payment_transfers', 'INSERT', 'authenticated'],
    ['aws_member_update_payment_transfers', 'public.payment_transfers', 'UPDATE', 'authenticated'],
    ['aws_member_insert_payment_wallets', 'public.payment_wallets', 'INSERT', 'authenticated'],
    ['aws_member_update_payment_wallets', 'public.payment_wallets', 'UPDATE', 'authenticated'],
    ['aws_member_insert_payment_event_log', 'public.payment_event_log', 'INSERT', 'authenticated'],
  ]);
  for (const policy of policies) {
    const clauses = policy.match(/\((?:[^()]|\([^()]*(?:\([^()]*\))*[^()]*\))*\)/g).filter((c) => c.includes('aws_'));
    assert.equal(clauses.length, /FOR UPDATE/.test(policy) ? 2 : 1, policy);
    for (const clause of clauses) {
      assert.match(clause, /public\.aws_is_authenticated\(\)/, policy);
      assert.match(clause, /COALESCE\(public\.aws_financial_execution_active\(\), false\)/, policy);
      assert.match(clause, /tenant_id IN \(SELECT public\.aws_user_tenant_ids\(\)\)/, policy);
      // No cross-tenant reader or platform-role shortcut.
      assert.doesNotMatch(clause, /cross_tenant|has_role|aws_can_access_tenant|aws_can_write_tenant/, policy);
    }
  }
  // Only DROP/CREATE POLICY: no grants, deletes, function changes or other tables.
  for (const statement of statements) {
    assert.match(statement, /^(DROP POLICY IF EXISTS aws_member_\w+ ON public\.payment_(transfers|wallets|event_log)|CREATE POLICY aws_member_)/, statement);
  }
});

test('balance refresh sets the server-only financial GUCs before saving the wallet', async () => {
  await withEnv(FLAGS, async () => {
    const client = fakeDb();
    const moov = moovStub();
    const result = await handleProviderRequest(
      { ...fundEvent({ tenant_id: TENANT, wallet_type: 'operating', force: true }), rawPath: '/functions/v1/moov-wallet-sync' },
      '/functions/v1/moov-wallet-sync',
      'POST',
      {
        loadDatabaseCredentials: async () => ({ host: 'localhost', username: 'checksops', password: 'x', database: 'checksops' }),
        createClient: () => client,
        loadProviderSecrets: async () => ({ MOOV_PUBLIC_KEY: 'pk', MOOV_SECRET_KEY: 'sk', MOOV_ACCOUNT_ID: 'platform-acct' }),
        fetchImpl: moov.impl,
      },
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    const sqls = client.log.map((q) => q.sql);
    const marker = sqls.findIndex((q) => q.includes("'request.financial_execution', '1'"));
    const activated = client.log.findIndex((q) => q.params?.[0] === 'request.aws_financial_permissions_activated' && q.params?.[1] === '1');
    const upsert = sqls.findIndex((q) => q.includes('INSERT INTO public.payment_wallets'));
    assert.ok(marker >= 0 && activated >= 0 && upsert > marker && upsert > activated, JSON.stringify({ marker, activated, upsert }));
    assert.equal(moov.posts().length, 0);
  });
});
