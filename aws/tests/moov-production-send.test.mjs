import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { LOOKUP_MAPPING_SQL } from '../functions/api/identity.mjs';
import { handleProviderRequest } from '../functions/api/providers.mjs';
import {
  parseSendRequest,
  payrollOutcome,
  planSendLegs,
  requestHash,
  selectCreditMethod,
  selectWalletMethod,
  summarizeSend,
  VENDOR_PAYEES_SQL,
} from '../functions/api/providers/production/moov-send.mjs';
import { MoovError } from '../functions/api/providers/parity/moov-client.mjs';
import { minutesAgo, stepUpWithinWindow } from './helpers/financial-stepup-window.mjs';

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
const VENDOR = '16500000-0000-4000-8000-000000000001';
/** SQL 165's aws_vendor_payees_for_tenant rows for TENANT: a live link to an active vendor. */
const VENDOR_PAYEE = Object.freeze({
  link_id: 'f1000000-0000-4000-8000-000000000001', vendor_tenant_id: VENDOR, vendor_name: 'Acme Supply', partner_code_used: 'VEND165',
  added_at: '2026-11-13T10:00:00Z', is_vendor: true, subscription_status: 'active', payable: true,
});

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
  { id: STAKEHOLDER, tenant_id: TENANT, nickname: 'Roofing Sub', provider: 'moov', provider_account_id: 'stk-acct', provider_bank_account_id: 'stk-bank', verification_status: 'verified', is_active: true, origin: 'tenant_owned', is_partner_payout: false, provider_environment: 'production' },
  { id: STAKEHOLDER_2, tenant_id: TENANT, nickname: 'Supplier', provider: 'moov', provider_account_id: 'stk2-acct', provider_bank_account_id: 'stk2-bank', verification_status: 'verified', is_active: true, origin: 'tenant_owned', is_partner_payout: false, provider_environment: null },
];

/** Transactional fake: writes are visible to later reads only once committed. */
const fakeDb = ({
  environment = 'production',
  tenantEnvironment = environment,
  memberships = [{ tenant_id: TENANT, role: 'member', tenant_name: 'Freedom', tenant_slug: 'freedom' }],
  stepUps = [{ id: 'stepup-1', user_id: APP_USER, tenant_id: TENANT, action_key: 'wallet.fund', login_session: LOGIN }],
  account = { tenant_id: TENANT, environment, provider_account_id: 'moov-acct', onboarding_status: 'active' },
  stakeholders = STAKEHOLDERS,
  shares = [{ check_id: CHECK, source_tenant_id: TENANT, target_tenant_id: PARTNER }],
  partnerships = [],
  checkTenant = TENANT,
  transfers = [],
  reservedCents = 0,
  runLockBusy = false,
  // Simulates a parallel request with the same key: these legs become committed
  // right after this request's first read of its legs.
  plantAfterFirstRead = null,
  payrollRuns = [],
  vendorPayees = [VENDOR_PAYEE],
  vendorLookup = null,
} = {}) => {
  const committed = { transfers: transfers.map((t) => ({ ...t })), events: [], payroll: payrollRuns.map((r) => ({ ...r })) };
  let pending = null;
  const begin = () => {
    pending = {
      transfers: committed.transfers.map((t) => ({ ...t })),
      events: [...committed.events],
      payroll: committed.payroll.map((r) => ({ ...r })),
    };
  };
  const state = () => pending || committed;
  const log = [];
  let nextId = committed.transfers.length + 1;
  let legReads = 0;
  const client = {
    log,
    committed,
    connect: async () => {},
    end: async () => {},
    query: async (sql, params = []) => {
      log.push({ sql, params });
      if (sql === 'BEGIN') { begin(); return { rows: [] }; }
      if (sql === 'COMMIT') {
        if (pending) { committed.transfers = pending.transfers; committed.events = pending.events; committed.payroll = pending.payroll; }
        pending = null;
        return { command: 'COMMIT', rows: [] };
      }
      if (sql === 'ROLLBACK') { pending = null; return { rows: [] }; }
      if (/^(SET TRANSACTION|SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)/.test(sql)) return { rows: [] };
      if (sql.startsWith('SELECT set_config')) return { rows: [{}] };
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [{}] };
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ ok: !runLockBusy }] };
      if (sql.includes('pg_advisory_unlock')) return { rows: [{ ok: true }] };
      if (sql === LOOKUP_MAPPING_SQL) {
        return { rows: params[0] === SUB ? [{ application_user_id: APP_USER, cognito_sub: SUB, email: 'tester@example.com', status: 'active' }] : [] };
      }
      if (sql.includes('FROM public.tenant_users')) return { rows: memberships };
      if (sql.includes('FROM public.user_roles')) return { rows: [] };
      if (sql.includes('FROM public.tenants WHERE id')) return { rows: [{ moov_allowlisted: true, moov_environment: tenantEnvironment }] };
      if (sql.includes('FROM public.financial_stepup_log')) {
        const [userId, tenantId, action, login] = params;
        return {
          rows: stepUps.filter((s) => s.user_id === userId && s.tenant_id === tenantId && s.action_key === action && s.login_session === login
            && stepUpWithinWindow(sql, params, s))
            .map((s) => ({ id: s.id, created_at: s.created_at ?? new Date().toISOString() })),
        };
      }
      if (sql.includes('FROM public.check_intake_items')) {
        // The check's owner shares it with the sender right now (the EXISTS in the handler's check query).
        const sharedWithSender = shares.some((s) => s.check_id === CHECK && !s.revoked_at
          && s.source_tenant_id === checkTenant && s.target_tenant_id === params[1]);
        return { rows: params[0] === CHECK ? [{ id: CHECK, tenant_id: checkTenant, shared_with_sender: sharedWithSender }] : [] };
      }
      if (sql.includes('FROM public.payment_provider_accounts')) {
        return { rows: account && params[0] === account.tenant_id && params[1] === account.environment ? [account] : [] };
      }
      if (sql.includes('SELECT * FROM public.payment_wallets')) {
        return {
          rows: params[1] === environment && params[2] === 'operating'
            ? [{ id: 'wallet-row', tenant_id: TENANT, environment, wallet_type: 'operating', provider_wallet_id: 'wallet-1', provider_payment_method_id: 'pm-wallet' }]
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
        const shared = shares.some((s) => s.check_id === check && !s.revoked_at
          && s.source_tenant_id === me && s.target_tenant_id === them);
        const pair = (p) => (p.inviter_tenant_id === me && p.invitee_tenant_id === them)
          || (p.inviter_tenant_id === them && p.invitee_tenant_id === me);
        const time = (v) => (v ? Date.parse(v) : -Infinity);
        const live = partnerships.filter((p) => p.status === 'active' && !p.revoked_at && pair(p));
        const since = live.length ? Math.min(...live.map((p) => Math.min(time(p.accepted_at ?? p.created_at), Date.now()))) : null;
        const partnered = since !== null
          && !partnerships.some((q) => q.revoked_at && pair(q) && time(q.revoked_at) >= since)
          && !shares.some((x) => x.check_id === check && x.revoked_at
            && x.source_tenant_id === me && x.target_tenant_id === them && time(x.revoked_at) >= since);
        return { rows: shared || partnered ? [{ ok: 1 }] : [] };
      }
      if (sql === VENDOR_PAYEES_SQL) {
        // SQL 165: only the caller's own tenant's live links (the function's member check).
        const result = vendorLookup || (params[0] === TENANT ? { ok: true, tenant_id: TENANT, payees: vendorPayees } : { ok: false, error: 'forbidden' });
        return { rows: [{ result }] };
      }
      if (sql.includes('COALESCE(sum(amount_cents)')) return { rows: [{ cents: reservedCents }] };
      if (sql.includes('SELECT * FROM public.payment_transfers') && sql.includes('left(idempotency_key')) {
        const [tenantId, prefix] = params;
        legReads += 1;
        if (legReads === 2 && plantAfterFirstRead) {
          committed.transfers.push(...plantAfterFirstRead);
          if (pending) pending.transfers.push(...plantAfterFirstRead.map((t) => ({ ...t })));
        }
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
          provider_metadata: JSON.parse(params[13]), provider_transfer_id: null, created_at: new Date().toISOString(),
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
        if (row) { row.status = 'canceled'; row.failure_reason = params[1]; }
        return { rows: row ? [{ id: row.id }] : [] };
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
      if (sql.includes('INSERT INTO public.payroll_runs')) {
        const row = {
          id: `00000000-0000-4000-9000-${String(state().payroll.length + 1).padStart(12, '0')}`,
          tenant_id: params[0], stakeholder_account_id: params[1], vendor_tenant_id: params[2], disbursement_batch_id: null, amount: params[3],
          speed: params[4], memo: params[5], initiated_by: params[6], status: 'pending', error: null,
          financial_execution: client.log.some((l) => /request\.financial_execution/.test(l.sql)),
        };
        state().payroll.push(row);
        return { rows: [{ id: row.id }] };
      }
      if (sql.includes('UPDATE public.payroll_runs')) {
        const row = state().payroll.find((r) => r.id === params[0] && r.tenant_id === params[1]);
        if (row && row.status !== params[2]) { row.status = params[2]; row.error = params[3]; }
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO public.payment_event_log')) {
        state().events.push({ environment: params[0], type: params[2], status: params[3] });
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
  'vendor-acct': [
    { paymentMethodType: 'moov-wallet', paymentMethodID: 'pm-vendor-wallet', wallet: { walletID: 'vw-1' } },
    { paymentMethodType: 'ach-credit-standard', paymentMethodID: 'pm-vendor-bank', bankAccount: { bankAccountID: 'vb-1' } },
    { paymentMethodType: 'ach-credit-same-day', paymentMethodID: 'pm-vendor-bank-sd', bankAccount: { bankAccountID: 'vb-1' } },
  ],
};
const VENDOR_ACCOUNT = Object.freeze({ accountID: 'vendor-acct', foreignID: VENDOR, displayName: 'Acme Supply LLC', metadata: { checksops_tenant_id: VENDOR } });

const moovStub = ({ available = 1_000_000, posts = [], partnerMethods = methods['partner-acct'], partnerAccounts, vendorMethods = methods['vendor-acct'], vendorAccounts = [VENDOR_ACCOUNT] } = {}) => {
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
      if (foreign === VENDOR) return reply(200, vendorAccounts);
      const list = partnerAccounts ?? (foreign === PARTNER ? [{ accountID: 'partner-acct', foreignID: PARTNER, displayName: 'Partner Co', metadata: { checksops_tenant_id: PARTNER } }] : []);
      return reply(200, list);
    }
    const pm = path.match(/^\/accounts\/([^/]+)\/payment-methods$/);
    if (method === 'GET' && pm) {
      if (pm[1] === 'partner-acct') return reply(200, partnerMethods);
      if (pm[1] === 'vendor-acct') return reply(200, vendorMethods);
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
const vendor = (amount, id = VENDOR) => ({ kind: 'vendor', vendor_tenant_id: id, amount_cents: amount });

const run = (client, moov, body = {}, claims = {}, extraDeps = {}) => handleProviderRequest(
  sendEvent({ tenant_id: TENANT, check_id: CHECK, idempotency_key: CLICK, recipients: [stakeholder(2500)], ...body }, claims),
  '/functions/v1/moov-disburse',
  'POST',
  {
    loadDatabaseCredentials: async () => ({ host: 'localhost', username: 'checksops', password: 'x', database: 'checksops' }),
    createClient: () => client,
    loadProviderSecrets: async () => ({ MOOV_PUBLIC_KEY: 'pk', MOOV_SECRET_KEY: 'sk', MOOV_ACCOUNT_ID: 'platform-acct' }),
    fetchImpl: moov.impl,
    ...extraDeps,
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

test('a partner sends from a check its owner shares with it; a revoked share or a share to someone else is not found', async () => {
  await withEnv(FLAGS, async () => {
    // The check belongs to another organization, which shares it with the sender.
    const shared = [{ check_id: CHECK, source_tenant_id: OTHER_TENANT, target_tenant_id: TENANT }];
    const client = fakeDb({ checkTenant: OTHER_TENANT, shares: shared });
    const moov = moovStub();
    const result = await run(client, moov, { recipients: [stakeholder(700)] });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(moov.posts().length, 1);
    // The leg is the sender's own row on that check; nothing is written under the check's owner.
    assert.deepEqual(client.committed.transfers.map((t) => [t.tenant_id, t.check_id, t.leg_role]), [[TENANT, CHECK, 'send_wallet']]);
    const checkRead = client.log.find((l) => l.sql.includes('FROM public.check_intake_items'));
    assert.deepEqual(checkRead.params, [CHECK, TENANT]);
    assert.match(checkRead.sql, /s\.check_id = c\.id AND s\.source_tenant_id = c\.tenant_id\s+AND s\.target_tenant_id = \$2::uuid AND s\.revoked_at IS NULL/);
    assert.equal(client.log.some((l) => /UPDATE public\.check_intake_items|INSERT INTO public\.disbursement/.test(l.sql)), false);

    for (const [name, shares] of [
      ['revoked', [{ ...shared[0], revoked_at: '2026-11-12T00:00:00Z' }]],
      ['shared with another organization', [{ ...shared[0], target_tenant_id: PARTNER }]],
      ['shared by the sender, not with it', [{ check_id: CHECK, source_tenant_id: TENANT, target_tenant_id: OTHER_TENANT }]],
      ['no share', []],
    ]) {
      const refused = fakeDb({ checkTenant: OTHER_TENANT, shares });
      const stub = moovStub();
      const out = await run(refused, stub, { recipients: [stakeholder(700)] });
      assert.equal(out.statusCode, 404, name);
      assert.equal(out.error, 'check_not_found', name);
      assert.equal(stub.posts().length, 0, name);
      assert.equal(refused.committed.transfers.length, 0, name);
    }
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

const PARTNERSHIP = { inviter_tenant_id: PARTNER, invitee_tenant_id: TENANT, status: 'active', revoked_at: null };

test('a partner chosen in the picker is paid on an active partnership, with no share or stakeholder row', async () => {
  await withEnv(FLAGS, async () => {
    for (const partnership of [PARTNERSHIP, { ...PARTNERSHIP, inviter_tenant_id: TENANT, invitee_tenant_id: PARTNER }]) {
      const client = fakeDb({ shares: [], partnerships: [partnership] });
      const result = await run(client, moovStub(), { recipients: [partner(700)] });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(client.committed.transfers[0].destination_tenant_id, PARTNER);
    }
  });
});

test('reconnecting after a partnership ended pays again on checks its end un-shared', async () => {
  await withEnv(FLAGS, async () => {
    // The old partnership ended on 10-03 (revoking the share); the pair reconnected on 10-07.
    const client = fakeDb({
      shares: [{ check_id: CHECK, source_tenant_id: TENANT, target_tenant_id: PARTNER, revoked_at: '2026-10-03' }],
      partnerships: [
        { ...PARTNERSHIP, accepted_at: '2026-10-07' },
        { inviter_tenant_id: TENANT, invitee_tenant_id: PARTNER, status: 'revoked', revoked_at: '2026-10-03' },
      ],
    });
    const result = await run(client, moovStub(), { recipients: [partner(700)] });
    assert.equal(result.ok, true, JSON.stringify(result));
  });
});

test('the partner rule no longer reads check_stakeholders', () => {
  const source = fs.readFileSync(new URL('../functions/api/providers/production/moov-send.mjs', import.meta.url), 'utf8');
  const rule = source.slice(source.indexOf('const share = (await client.query('), source.indexOf("if (!share) return { error: 'partner_not_shared'"));
  assert.doesNotMatch(rule, /check_stakeholders/);
  assert.match(rule, /p\.status = 'active' AND p\.revoked_at IS NULL/);
  // Ended rows and un-shares count only since the partnership was last accepted.
  assert.match(rule, /min\(LEAST\(COALESCE\(p\.accepted_at, p\.created_at, '-infinity'::timestamptz\), now\(\)\)\) AS since/);
  assert.equal((rule.match(/revoked_at >= live\.since/g) || []).length, 2);
});

test('partners must share this check and have exactly one production account', async () => {
  await withEnv(FLAGS, async () => {
    for (const [options, stubOptions, code] of [
      [{ shares: [] }, {}, 'partner_not_shared'],
      [{ shares: [{ check_id: CHECK, source_tenant_id: TENANT, target_tenant_id: PARTNER, revoked_at: '2026-10-01' }] }, {}, 'partner_not_shared'],
      [{}, { partnerAccounts: [] }, 'partner_setup_required'],
      [{}, { partnerAccounts: [{ accountID: 'a', foreignID: PARTNER, metadata: { checksops_tenant_id: PARTNER } }, { accountID: 'b', foreignID: PARTNER, metadata: { checksops_tenant_id: PARTNER } }] }, 'partner_account_ambiguous'],
      // A recipient account someone created with the partner's id as foreignID is not the partner.
      [{}, { partnerAccounts: [{ accountID: 'planted', foreignID: PARTNER, metadata: { checksops_tenant_id: OTHER_TENANT, checksops_recipient_id: PARTNER } }] }, 'partner_setup_required'],
      [{}, { partnerAccounts: [{ accountID: 'planted', foreignID: PARTNER, metadata: { checksops_tenant_id: PARTNER, checksops_recipient_id: PARTNER } }] }, 'partner_setup_required'],
      [{}, { partnerAccounts: [{ accountID: 'untagged', foreignID: PARTNER }] }, 'partner_setup_required'],
      // Only shares made by the sending organization count.
      [{ shares: [{ check_id: CHECK, source_tenant_id: PARTNER, target_tenant_id: TENANT }] }, {}, 'partner_not_shared'],
      [{}, { partnerMethods: [] }, 'partner_setup_required'],
      // No share: the partnership must be active (ended, pending or another pair is refused).
      [{ shares: [], partnerships: [{ ...PARTNERSHIP, status: 'revoked', revoked_at: '2026-10-01' }] }, {}, 'partner_not_shared'],
      [{ shares: [], partnerships: [{ ...PARTNERSHIP, revoked_at: '2026-10-01' }] }, {}, 'partner_not_shared'],
      [{ shares: [], partnerships: [{ ...PARTNERSHIP, status: 'pending' }] }, {}, 'partner_not_shared'],
      [{ shares: [], partnerships: [{ ...PARTNERSHIP, inviter_tenant_id: OTHER_TENANT }] }, {}, 'partner_not_shared'],
      [{ shares: [], partnerships: [{ ...PARTNERSHIP, invitee_tenant_id: OTHER_TENANT }] }, {}, 'partner_not_shared'],
      // Un-sharing this check with the partner since the partnership was accepted blocks them.
      [{ shares: [{ check_id: CHECK, source_tenant_id: TENANT, target_tenant_id: PARTNER, revoked_at: '2026-10-01' }], partnerships: [PARTNERSHIP] }, {}, 'partner_not_shared'],
      [{ shares: [{ check_id: CHECK, source_tenant_id: TENANT, target_tenant_id: PARTNER, revoked_at: '2026-10-05' }], partnerships: [{ ...PARTNERSHIP, accepted_at: '2026-10-02' }] }, {}, 'partner_not_shared'],
      // The pair's row in the other direction was ended after this one was accepted.
      [{ shares: [], partnerships: [{ ...PARTNERSHIP, accepted_at: '2026-10-02' }, { inviter_tenant_id: TENANT, invitee_tenant_id: PARTNER, status: 'revoked', revoked_at: '2026-10-05' }] }, {}, 'partner_not_shared'],
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
      [[{ ...STAKEHOLDERS[0], origin: 'homeowner_link' }], 'recipient_not_supported'],
      [[{ ...STAKEHOLDERS[0], origin: 'partner_shared' }], 'recipient_not_supported'],
      [[{ ...STAKEHOLDERS[0], origin: 'provider_connected' }], 'recipient_not_supported'],
      [[{ ...STAKEHOLDERS[0], is_partner_payout: true }], 'recipient_not_supported'],
      [[{ ...STAKEHOLDERS[0], origin: 'provider_recipient', is_partner_payout: true }], 'recipient_not_supported'],
      // A payee whose setup is unfinished, or whom the organization disconnected, is not paid.
      [[{ ...STAKEHOLDERS[0], origin: 'provider_recipient', verification_status: 'pending' }], 'recipient_not_verified'],
      [[{ ...STAKEHOLDERS[0], origin: 'provider_recipient', provider_bank_account_id: null }], 'recipient_setup_required'],
      [[{ ...STAKEHOLDERS[0], origin: 'provider_recipient', is_active: false }], 'recipient_not_found'],
      [[{ ...STAKEHOLDERS[0], provider_environment: 'sandbox' }], 'recipient_setup_required'],
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

test('a payee who finished setup (SQL 113 provider_recipient) is paid to their bank like an organization-owned stakeholder', async () => {
  await withEnv(FLAGS, async () => {
    const client = fakeDb({ stakeholders: [{ ...STAKEHOLDERS[0], origin: 'provider_recipient' }] });
    const moov = moovStub();
    const result = await run(client, moov);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(moov.posts().length > 0, 'the transfer is sent');
    assert.ok(client.committed.transfers.length > 0, 'the transfer is recorded');
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

test('finding 7: a send needs a step-up verified within 15 minutes; 16 minutes old answers totp_required', async () => {
  await withEnv(FLAGS, async () => {
    const stepUp = (minutes) => [{ id: 'stepup-1', user_id: APP_USER, tenant_id: TENANT, action_key: 'wallet.fund', login_session: LOGIN, created_at: minutesAgo(minutes) }];
    const fresh = await run(fakeDb({ stepUps: stepUp(14) }), moovStub());
    assert.equal(fresh.ok, true, JSON.stringify(fresh));
    assert.equal(fresh.send.sent_cents, 2500);

    const client = fakeDb({ stepUps: stepUp(16) });
    const moov = moovStub();
    const stale = await run(client, moov);
    // The code the SPA re-prompts on (DisbursementConsole: error.code === "totp_required").
    assert.equal(stale.statusCode, 401);
    assert.equal(stale.error, 'totp_required');
    assert.equal(stale.actionKey, 'wallet.fund');
    assert.equal(moov.calls.length, 0);
    assert.equal(client.committed.transfers.length, 0);
    const lookup = client.log.find((q) => q.sql.includes('FROM public.financial_stepup_log'));
    assert.equal(lookup.params[4], 15 * 60);
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
        { id: '00000000-0000-4000-8000-0000000000a1', tenant_id: TENANT, idempotency_key: `send:${CLICK}:0:wallet`, amount_cents: 1000, leg_role: 'send_wallet', status: 'submitted', provider_transfer_id: 'w1', created_at: new Date().toISOString(), provider_metadata: meta(0, 'pm-wallet', 'pm-stk-std') },
        { id: '00000000-0000-4000-8000-0000000000a2', tenant_id: TENANT, idempotency_key: `send:${CLICK}:1:bank`, amount_cents: 1500, leg_role: 'send_bank', status: 'ready', provider_transfer_id: null, created_at: new Date().toISOString(), provider_metadata: meta(1, 'pm-debit', 'pm-stk-std') },
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

const plannedLegs = (amounts, { createdAt = new Date().toISOString(), facilitator = 'platform-acct' } = {}) => {
  const request = parseSendRequest({ idempotency_key: CLICK, check_id: CHECK, recipients: amounts.map((a, i) => stakeholder(a, i ? STAKEHOLDER_2 : STAKEHOLDER)) });
  return {
    request,
    legs: amounts.map((amount, i) => ({
      id: `00000000-0000-4000-8000-0000000000b${i}`, tenant_id: TENANT, idempotency_key: `send:${CLICK}:${i}:wallet`, amount_cents: amount,
      leg_role: 'send_wallet', status: 'ready', provider_transfer_id: null, created_at: createdAt,
      provider_metadata: {
        request_hash: requestHash(request), leg_index: i, recipient_index: i, recipient_kind: 'stakeholder', recipient_id: i ? STAKEHOLDER_2 : STAKEHOLDER,
        source_moov_payment_method_id: 'pm-wallet', destination_moov_payment_method_id: i ? 'pm-stk2-std' : 'pm-stk-std', facilitator_account_id: facilitator,
      },
    })),
  };
};

test('a parallel request with the same key that planned first is not planned again', async () => {
  await withEnv(FLAGS, async () => {
    const { legs } = plannedLegs([2500]);
    const client = fakeDb({ plantAfterFirstRead: legs });
    const moov = moovStub({ available: 1000 });
    const result = await run(client, moov);
    assert.equal(result.ok, true, JSON.stringify(result));
    // Only the other request's single leg exists and was sent; no second plan.
    assert.equal(client.committed.transfers.length, 1);
    assert.deepEqual(moov.posts().map((p) => p.body.amount.value), [2500]);
  });
});

test('a send already running under the same key is not run twice', async () => {
  await withEnv(FLAGS, async () => {
    const { legs } = plannedLegs([400]);
    const client = fakeDb({ transfers: legs, runLockBusy: true });
    const moov = moovStub();
    const result = await run(client, moov, { recipients: [stakeholder(400)] });
    assert.equal(result.error, 'send_in_progress');
    assert.equal(moov.posts().length, 0);
    assert.equal(client.committed.transfers[0].status, 'ready');
  });
});

test('legs are only started with time left; the rest continue with the same key', async () => {
  await withEnv(FLAGS, async () => {
    const client = fakeDb();
    const moov = moovStub();
    let t = 1_000_000;
    let posted = 0;
    const original = moov.impl;
    moov.impl = async (url, init) => {
      if (String(init?.method).toUpperCase() === 'POST' && String(url).endsWith('/transfers')) { posted += 1; t += 17_000; }
      return original(url, init);
    };
    const body = { recipients: [stakeholder(400), stakeholder(300, STAKEHOLDER_2)] };
    const first = await run(client, moov, body, {}, { now: () => t });
    assert.equal(first.error, 'send_incomplete', JSON.stringify(first));
    assert.equal(posted, 1);
    assert.deepEqual(client.committed.transfers.map((x) => x.status), ['submitted', 'ready']);
    const second = await run(client, moov, body, {}, { now: () => t });
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(posted, 2);
    assert.equal(moov.posts()[1].headers['X-Idempotency-Key'], client.committed.transfers[1].id);
  });
});

test('ready legs left unsent for too long are canceled, not sent late', async () => {
  await withEnv(FLAGS, async () => {
    const { legs } = plannedLegs([400], { createdAt: new Date(Date.now() - 20 * 60_000).toISOString() });
    const client = fakeDb({ transfers: legs });
    const moov = moovStub();
    const result = await run(client, moov, { recipients: [stakeholder(400)] });
    assert.equal(result.error, 'send_failed');
    assert.equal(moov.posts().length, 0);
    assert.equal(client.committed.transfers[0].status, 'canceled');
    assert.equal(client.committed.transfers[0].failure_reason, 'expired_unsent');
  });
});

test('a resumed send must use the facilitator it was planned with', async () => {
  await withEnv(FLAGS, async () => {
    const { legs } = plannedLegs([400], { facilitator: 'old-platform-acct' });
    const client = fakeDb({ transfers: legs });
    const moov = moovStub();
    const result = await run(client, moov, { recipients: [stakeholder(400)] });
    assert.equal(result.error, 'facilitator_changed');
    assert.equal(moov.posts().length, 0);
  });
});

test('a partner with operating and trust wallets is paid to the default wallet', async () => {
  await withEnv(FLAGS, async () => {
    const client = fakeDb();
    const moov = moovStub({
      partnerMethods: [
        { paymentMethodType: 'moov-wallet', paymentMethodID: 'pm-trust', wallet: { walletID: 'pw-2', walletType: 'general' } },
        { paymentMethodType: 'moov-wallet', paymentMethodID: 'pm-operating', wallet: { walletID: 'pw-1', walletType: 'default' } },
      ],
    });
    const result = await run(client, moov, { recipients: [partner(700)] });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(moov.posts()[0].body.destination, { paymentMethodID: 'pm-operating' });
  });
});

test('request parsing, leg planning and method selection', () => {
  assert.equal(parseSendRequest({}).error, 'idempotency_key is required');
  assert.equal(parseSendRequest({ idempotency_key: CLICK }).error, 'check_id is required');
  assert.match(parseSendRequest({ idempotency_key: CLICK, check_id: CHECK, recipients: [] }).error, /at least one/);
  assert.match(parseSendRequest({ idempotency_key: CLICK, check_id: CHECK, recipients: [stakeholder(0)] }).error, /cents/);
  assert.match(parseSendRequest({ idempotency_key: CLICK, check_id: CHECK, recipients: [stakeholder(5), stakeholder(6)] }).error, /only once/);
  assert.match(parseSendRequest({ idempotency_key: CLICK, check_id: CHECK, speed: 'instant', recipients: [stakeholder(5)] }).error, /speed/);
  assert.equal(parseSendRequest({ idempotency_key: CLICK, check_id: CHECK, recipients: [{ kind: 'other', amount_cents: 5 }] }).error, 'Each recipient must be a stakeholder, a partner or a vendor.');
  assert.equal(parseSendRequest({ idempotency_key: CLICK, check_id: CHECK, recipients: [{ kind: 'vendor', vendor_tenant_id: 'nope', amount_cents: 5 }] }).error, 'Each recipient must be a stakeholder, a partner or a vendor.');

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

// Staging: the same send path against the Moov sandbox (sandbox credentials, environment='sandbox').
const STAGING_FLAGS = {
  AWS_PROVIDER_EXECUTION_ENABLED: 'false',
  AWS_MOOV_ENABLED: 'false',
  AWS_PROVIDER_LIVE_READS_ENABLED: 'false',
  AWS_MOOV_TRANSFER_POST_ENABLED: undefined,
  AWS_MOOV_SEND_POST_ENABLED: undefined,
  AWS_FINANCIAL_PERMISSIONS_ACTIVATED: 'false',
  AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'true',
};
const SANDBOX_STAKEHOLDERS = STAKEHOLDERS.map((s) => ({ ...s, provider_environment: s.provider_environment && 'sandbox' }));
const sandboxDeps = {
  loadProviderSecrets: async () => { throw new Error('production secrets read on staging'); },
  loadSandboxCredentials: async () => ({ moov: { publicKey: 'spk', secretKey: 'ssk', platformAccountId: 'sandbox-platform' } }),
};

test('staging: a check send (no batch_id) runs the send path against the Moov sandbox', async () => {
  await withEnv(STAGING_FLAGS, async () => {
    const client = fakeDb({ environment: 'sandbox', stakeholders: SANDBOX_STAKEHOLDERS });
    const moov = moovStub();
    const result = await run(client, moov, {}, {}, sandboxDeps);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.environment, 'sandbox');
    assert.equal(result.operation, 'wallet.send');
    assert.equal(result.send.sent_cents, 2500);
    const [post] = moov.posts();
    assert.equal(post.path, '/accounts/sandbox-platform/transfers');
    assert.deepEqual(post.body.destination, { paymentMethodID: 'pm-stk-std' });
    const [leg] = client.committed.transfers;
    assert.equal(leg.environment, 'sandbox');
    assert.equal(leg.status, 'submitted');
    assert.ok(client.committed.events.length > 0);
    assert.ok(client.committed.events.every((e) => e.environment === 'sandbox'));
  });
});

test('staging: a tenant flagged production still sends from its sandbox rows, never production keys', async () => {
  await withEnv(STAGING_FLAGS, async () => {
    const client = fakeDb({ environment: 'sandbox', tenantEnvironment: 'production', stakeholders: SANDBOX_STAKEHOLDERS });
    const result = await run(client, moovStub(), {}, {}, sandboxDeps);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(client.committed.transfers[0].environment, 'sandbox');
  });
});

test('staging: a production stakeholder row is not paid from the sandbox', async () => {
  await withEnv(STAGING_FLAGS, async () => {
    const client = fakeDb({ environment: 'sandbox' });
    const moov = moovStub();
    const result = await run(client, moov, {}, {}, sandboxDeps);
    assert.equal(result.error, 'recipient_setup_required', JSON.stringify(result));
    assert.equal(moov.posts().length, 0);
    assert.equal(client.committed.transfers.length, 0);
  });
});

test('staging: the send still needs this login\'s two-factor step-up', async () => {
  await withEnv(STAGING_FLAGS, async () => {
    const client = fakeDb({ environment: 'sandbox', stakeholders: SANDBOX_STAKEHOLDERS, stepUps: [] });
    const moov = moovStub();
    const result = await run(client, moov, {}, {}, sandboxDeps);
    assert.equal(result.error, 'totp_required', JSON.stringify(result));
    assert.equal(moov.posts().length, 0);
  });
});

test('staging: a Run Payroll batch (batch_id) still goes to the parity batch handler', async () => {
  await withEnv(STAGING_FLAGS, async () => {
    const client = fakeDb({ environment: 'sandbox', stakeholders: SANDBOX_STAKEHOLDERS });
    const moov = moovStub();
    const result = await run(client, moov, { batch_id: '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f' }, {}, sandboxDeps);
    assert.notEqual(result.operation, 'wallet.send', JSON.stringify(result));
    assert.ok(client.log.some(({ sql }) => sql.includes('FROM public.disbursement_batches')));
    assert.equal(moov.posts().length, 0);
  });
});

test('staging: with sandbox execution off, a send meets the hard block and nothing is written', async () => {
  await withEnv({ ...STAGING_FLAGS, AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'false' }, async () => {
    const client = fakeDb({ environment: 'sandbox', stakeholders: SANDBOX_STAKEHOLDERS });
    const moov = moovStub();
    const result = await run(client, moov, {}, {}, sandboxDeps);
    assert.notEqual(result.ok, true, JSON.stringify(result));
    assert.notEqual(result.operation, 'wallet.send');
    assert.equal(moov.calls.length, 0);
    assert.equal(client.committed.transfers.length, 0);
  });
});


// Payroll (owner decision 2026-11-04): the same send, not tied to a check, to one stakeholder.
const payroll = (body = {}) => ({
  check_id: undefined, purpose: 'payroll', speed: 'standard', recipients: [stakeholder(150_000)], description: 'Payroll: Nov 1-15', ...body,
});

test('payroll: parse accepts exactly one stakeholder and no check; check sends still need a check', () => {
  const ok = parseSendRequest({ idempotency_key: CLICK, ...payroll() });
  assert.equal(ok.error, undefined);
  assert.equal(ok.purpose, 'payroll');
  assert.equal(ok.checkId, null);
  assert.equal(parseSendRequest({ idempotency_key: CLICK, ...payroll({ check_id: CHECK }) }).error, 'A payroll payment is not tied to a check.');
  assert.equal(parseSendRequest({ idempotency_key: CLICK, ...payroll({ recipients: [partner(100)] }) }).error, 'A payroll payment pays exactly one stakeholder or vendor.');
  assert.equal(parseSendRequest({ idempotency_key: CLICK, ...payroll({ recipients: [stakeholder(100), stakeholder(100, STAKEHOLDER_2)] }) }).error, 'A payroll payment pays exactly one stakeholder or vendor.');
  assert.equal(parseSendRequest({ idempotency_key: CLICK, ...payroll({ recipients: [stakeholder(100), vendor(100)] }) }).error, 'A payroll payment pays exactly one stakeholder or vendor.');
  assert.equal(parseSendRequest({ idempotency_key: CLICK, purpose: 'other', check_id: CHECK, recipients: [stakeholder(1)] }).error, "purpose must be 'send' or 'payroll'");
  assert.equal(parseSendRequest({ idempotency_key: CLICK, recipients: [stakeholder(1)] }).error, 'check_id is required');
  // A check send hashes as before; a payroll for the same payee and amount is a different request.
  const send = parseSendRequest({ idempotency_key: CLICK, check_id: CHECK, recipients: [stakeholder(150_000)] });
  assert.equal(send.purpose, 'send');
  assert.notEqual(requestHash(send), requestHash(ok));
});

test('payroll: one wallet → stakeholder ACH credit, no check lookup, payroll_runs row written under the money-write GUC and marked submitted', async () => {
  await withEnv(FLAGS, async () => {
    const client = fakeDb();
    const moov = moovStub();
    const result = await run(client, moov, payroll());
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.send.sent_cents, 150_000);
    assert.equal(client.log.some((l) => l.sql.includes('FROM public.check_intake_items')), false);
    const [post] = moov.posts();
    assert.deepEqual(post.body.destination, { paymentMethodID: 'pm-stk-std' });
    assert.deepEqual(post.body.amount, { currency: 'USD', value: 150_000 });
    const [leg] = client.committed.transfers;
    assert.equal(leg.check_id, null);
    assert.equal(leg.speed, 'standard');
    assert.equal(leg.description, 'Payroll: Nov 1-15');
    assert.equal(leg.provider_metadata.purpose, 'payroll');
    const [row] = client.committed.payroll;
    assert.equal(leg.provider_metadata.payroll_run_id, row.id);
    assert.deepEqual(
      { tenant: row.tenant_id, payee: row.stakeholder_account_id, amount: row.amount, speed: row.speed, memo: row.memo, by: row.initiated_by, status: row.status, batch: row.disbursement_batch_id },
      { tenant: TENANT, payee: STAKEHOLDER, amount: '1500.00', speed: 'next_day', memo: 'Payroll: Nov 1-15', by: APP_USER, status: 'submitted', batch: null },
    );
    assert.equal(row.financial_execution, true, 'request.financial_execution was set before the payroll_runs insert');
  });
});

test('payroll: same_day uses the same-day rail and records same_day', async () => {
  await withEnv(FLAGS, async () => {
    const client = fakeDb();
    const moov = moovStub();
    const result = await run(client, moov, payroll({ speed: 'same_day' }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(moov.posts()[0].body.destination, { paymentMethodID: 'pm-stk-sd' });
    assert.equal(client.committed.payroll[0].speed, 'same_day');
  });
});

test('payroll: without this login\'s two-factor nothing is recorded or sent', async () => {
  await withEnv(FLAGS, async () => {
    const client = fakeDb({ stepUps: [] });
    const moov = moovStub();
    const result = await run(client, moov, payroll());
    assert.equal(result.statusCode, 401);
    assert.equal(result.error, 'totp_required');
    assert.equal(result.actionKey, 'wallet.fund');
    assert.equal(moov.posts().length, 0);
    assert.equal(client.committed.payroll.length, 0);
    assert.equal(client.committed.transfers.length, 0);
  });
});

test('payroll: a step-up from another tenant or another login does not authorize it', async () => {
  await withEnv(FLAGS, async () => {
    for (const stepUps of [
      [{ id: 's', user_id: APP_USER, tenant_id: OTHER_TENANT, action_key: 'wallet.fund', login_session: LOGIN }],
      [{ id: 's', user_id: APP_USER, tenant_id: TENANT, action_key: 'wallet.fund', login_session: `${SUB}:jti:other` }],
      [{ id: 's', user_id: APP_USER, tenant_id: TENANT, action_key: 'payroll.run', login_session: LOGIN }],
    ]) {
      const client = fakeDb({ stepUps });
      const result = await run(client, moovStub(), payroll());
      assert.equal(result.error, 'totp_required', JSON.stringify(stepUps));
      assert.equal(client.committed.payroll.length, 0);
    }
  });
});

test('payroll: a member of another tenant cannot run this tenant\'s payroll', async () => {
  await withEnv(FLAGS, async () => {
    const client = fakeDb({ memberships: [{ tenant_id: OTHER_TENANT, role: 'member', tenant_name: 'Other', tenant_slug: 'other' }] });
    const moov = moovStub();
    const result = await run(client, moov, payroll());
    assert.equal(result.statusCode, 403);
    assert.equal(moov.posts().length, 0);
    assert.equal(client.committed.payroll.length, 0);
  });
});

test('payroll: a stakeholder of another tenant is not paid and no run is recorded', async () => {
  await withEnv(FLAGS, async () => {
    const client = fakeDb({ stakeholders: STAKEHOLDERS.map((st) => ({ ...st, tenant_id: OTHER_TENANT })) });
    const moov = moovStub();
    const result = await run(client, moov, payroll());
    assert.equal(result.error, 'recipient_not_found');
    assert.equal(moov.posts().length, 0);
    assert.equal(client.committed.payroll.length, 0);
  });
});

test('payroll: the same click replayed pays once and keeps one run; a different payroll on that key is refused', async () => {
  await withEnv(FLAGS, async () => {
    const client = fakeDb();
    const moov = moovStub();
    assert.equal((await run(client, moov, payroll())).ok, true);
    const again = await run(client, moov, payroll());
    assert.equal(again.ok, true, JSON.stringify(again));
    assert.equal(again.duplicate, true);
    assert.equal(moov.posts().length, 1);
    assert.equal(client.committed.payroll.length, 1);
    assert.equal(client.committed.payroll[0].status, 'submitted');
    const other = await run(client, moov, payroll({ recipients: [stakeholder(99_999)] }));
    assert.equal(other.error, 'idempotency_key_reused');
    assert.equal(moov.posts().length, 1);
  });
});

test('payroll: a Moov refusal is recorded on the run as failed (committed, although the reply is a 409)', async () => {
  await withEnv(FLAGS, async () => {
    const client = fakeDb();
    const moov = moovStub({ posts: [{ status: 422, body: { error: 'insufficient funds' } }] });
    const result = await run(client, moov, payroll());
    assert.equal(result.ok, false);
    assert.equal(result.error, 'send_failed');
    const [row] = client.committed.payroll;
    assert.equal(row.status, 'failed');
    assert.ok(row.error);
    assert.equal(client.committed.transfers[0].status, 'failed');
  });
});

test('payroll: an unclear Moov result is recorded as unknown and never retried', async () => {
  await withEnv(FLAGS, async () => {
    const client = fakeDb();
    const moov = moovStub({ posts: [{ throw: new Error('socket hang up') }] });
    const result = await run(client, moov, payroll());
    assert.equal(result.error, 'provider_outcome_unknown');
    assert.equal(client.committed.payroll[0].status, 'unknown');
    const again = await run(client, moov, payroll());
    assert.equal(again.duplicate, true);
    assert.equal(moov.posts().length, 1);
  });
});

test('payroll: held sends record nothing', async () => {
  await withEnv({ ...FLAGS, AWS_MOOV_SEND_POST_ENABLED: undefined }, async () => {
    const client = fakeDb();
    const moov = moovStub();
    const result = await run(client, moov, payroll());
    assert.equal(result.error, 'send_post_held');
    assert.equal(client.committed.payroll.length, 0);
    assert.equal(client.committed.transfers.length, 0);
  });
});

test('payrollOutcome maps the legs to the run status', () => {
  const leg = (status, extra = {}) => ({ status, amount_cents: 100, provider_metadata: { recipient_index: 0 }, ...extra });
  assert.equal(payrollOutcome([leg('ready')]), null);
  assert.equal(payrollOutcome([leg('submitted')], { incomplete: true }), null);
  assert.deepEqual(payrollOutcome([leg('submitted')]), { status: 'submitted', error: null });
  assert.equal(payrollOutcome([leg('failed', { failure_reason: 'refused' })]).status, 'failed');
  assert.equal(payrollOutcome([leg('unknown')]).status, 'unknown');
  assert.equal(payrollOutcome([leg('submitted'), leg('canceled')]).status, 'partial');
});

test('the payroll dialog pays through the send route with the once-per-login wallet.fund step-up', () => {
  const dialog = fs.readFileSync(new URL('../../src/components/payroll/RunPayrollDialog.tsx', import.meta.url), 'utf8');
  const sends = fs.readFileSync(new URL('../../src/lib/payments/sends.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(dialog, /payroll\.run/);
  assert.doesNotMatch(dialog, /useFinancialGuard/);
  assert.doesNotMatch(dialog, /supabase\.from\(/, 'no browser writes to money tables');
  assert.doesNotMatch(dialog, /functions\.invoke/);
  assert.match(dialog, /sendPayrollPayment\(/);
  assert.match(dialog, /actionKey: "wallet\.fund"/);
  assert.match(dialog, /next_day: "standard", same_day: "same_day"/);
  // The fee schedule lives in the shared helper (one source for the dialog and Revenue & Profit).
  const speedFees = fs.readFileSync(new URL('../../src/lib/payments/payrollSpeedFees.ts', import.meta.url), 'utf8');
  assert.match(dialog, /const SPEED_FEES = PAYROLL_SPEED_FEES;/);
  assert.match(speedFees, /PAYROLL_SPEED_FEES: Readonly<Record<PayrollSpeed, number>> = \{ next_day: 0\.75, same_day: 1\.0 \}/);
  assert.match(sends, /purpose: "payroll"/);
  assert.match(sends, /functions\.invoke\("moov-disburse"/);
});

// Vendors (owner 2026-11-13, SQL 141 / SQL 165): paid wallet to wallet only, from a check or as the one
// recipient of a payroll payment, while the sender holds a live payee link to a vendor that is still payable.
test('vendor: parse and request hash include the vendor; the vendor kind is its own recipient', () => {
  const send = parseSendRequest({ idempotency_key: CLICK, check_id: CHECK, recipients: [vendor(700)] });
  assert.equal(send.error, undefined);
  assert.deepEqual(send.recipients, [{ kind: 'vendor', id: VENDOR, amount_cents: 700 }]);
  const upper = parseSendRequest({ idempotency_key: CLICK, check_id: CHECK, recipients: [vendor(700, VENDOR.toUpperCase())] });
  assert.equal(upper.recipients[0].id, VENDOR);
  // A vendor and a partner with the same id and amount are different requests.
  const asPartner = parseSendRequest({ idempotency_key: CLICK, check_id: CHECK, recipients: [partner(700, VENDOR)] });
  assert.notEqual(requestHash(send), requestHash(asPartner));
  assert.notEqual(requestHash(send), requestHash(parseSendRequest({ idempotency_key: CLICK, check_id: CHECK, recipients: [vendor(701)] })));
  // A vendor and a partner may both be paid in one send; the same vendor only once.
  assert.equal(parseSendRequest({ idempotency_key: CLICK, check_id: CHECK, recipients: [vendor(1), partner(1)] }).error, undefined);
  assert.match(parseSendRequest({ idempotency_key: CLICK, check_id: CHECK, recipients: [vendor(1), vendor(2)] }).error, /only once/);
  const pay = parseSendRequest({ idempotency_key: CLICK, purpose: 'payroll', recipients: [vendor(100)] });
  assert.equal(pay.error, undefined);
  assert.equal(pay.purpose, 'payroll');
});

test('vendor: an authorized link is paid wallet to wallet from a check, with destination_tenant_id and recipient_kind vendor', async () => {
  await withEnv(FLAGS, async () => {
    const client = fakeDb();
    const moov = moovStub();
    const result = await run(client, moov, { recipients: [vendor(700)] });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.send.sent_cents, 700);
    const [post] = moov.posts();
    assert.deepEqual(post.body.source, { paymentMethodID: 'pm-wallet' });
    assert.deepEqual(post.body.destination, { paymentMethodID: 'pm-vendor-wallet' });
    const [leg] = client.committed.transfers;
    assert.equal(leg.destination_tenant_id, VENDOR);
    assert.equal(leg.check_id, CHECK);
    assert.equal(leg.leg_role, 'send_wallet');
    assert.equal(leg.provider_metadata.recipient_kind, 'vendor');
    assert.equal(leg.provider_metadata.recipient_id, VENDOR);
    assert.equal(leg.provider_metadata.recipient_name, 'Acme Supply');
    assert.equal(leg.provider_metadata.destination_kind, 'wallet');
    assert.equal(leg.provider_metadata.vendor_account_id, 'vendor-acct');
    assert.equal(leg.provider_metadata.partner_account_id, null);
    assert.equal(result.send.recipients[0].destination, 'wallet');
    // SQL 165's lookup for the sender's own tenant, as the verified sign-in (bound before the call).
    const lookup = client.log.findIndex((l) => l.sql === VENDOR_PAYEES_SQL);
    assert.deepEqual(client.log[lookup].params, [TENANT]);
    assert.ok(client.log.slice(0, lookup).some((l) => l.sql.startsWith('SELECT set_config')));
    assert.equal(moov.calls.find((c) => c.path === '/accounts').query, `foreignID=${VENDOR}`);
    // No partnership or share is read for a vendor.
    assert.equal(client.log.some((l) => l.sql.includes('FROM public.shared_checks') && l.params?.[2] === VENDOR), false);
  });
});

test('vendor: a short wallet tops up from the sender\'s bank to the vendor\'s wallet (the vendor is still paid wallet only)', async () => {
  await withEnv(FLAGS, async () => {
    const client = fakeDb();
    const moov = moovStub({ available: 300 });
    const result = await run(client, moov, { recipients: [vendor(700)] });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(moov.posts().map((p) => [p.body.source.paymentMethodID, p.body.destination.paymentMethodID, p.body.amount.value]),
      [['pm-wallet', 'pm-vendor-wallet', 300], ['pm-debit', 'pm-vendor-wallet', 400]]);
    assert.ok(client.committed.transfers.every((t) => t.destination_tenant_id === VENDOR && t.provider_metadata.recipient_kind === 'vendor'));
  });
});

test('vendor: a removed link, an organization no longer marked a vendor or not active, another tenant\'s link and a refused lookup are vendor_not_payee; nothing is recorded or sent', async () => {
  await withEnv(FLAGS, async () => {
    for (const [label, options] of [
      ['removed (not listed)', { vendorPayees: [] }],
      ['no longer a vendor', { vendorPayees: [{ ...VENDOR_PAYEE, is_vendor: false, payable: false }] }],
      ['not active', { vendorPayees: [{ ...VENDOR_PAYEE, subscription_status: 'past_due', payable: false }] }],
      ['another vendor listed', { vendorPayees: [{ ...VENDOR_PAYEE, vendor_tenant_id: OTHER_TENANT }] }],
      ['lookup refused', { vendorLookup: { ok: false, error: 'forbidden' } }],
    ]) {
      const client = fakeDb(options);
      const moov = moovStub();
      const result = await run(client, moov, { recipients: [vendor(700)] });
      assert.equal(result.statusCode, 409, label);
      assert.equal(result.error, 'vendor_not_payee', label);
      assert.match(result.message, /vendor/i, label);
      assert.equal(moov.posts().length, 0, label);
      assert.equal(moov.calls.some((c) => c.path === '/accounts'), false, `${label}: no Moov account read`);
      assert.equal(client.committed.transfers.length, 0, label);
    }
    const self = await run(fakeDb({ vendorPayees: [{ ...VENDOR_PAYEE, vendor_tenant_id: TENANT }] }), moovStub(), { recipients: [vendor(700, TENANT)] });
    assert.equal(self.error, 'recipient_is_sender');
  });
});

test('vendor: no usable ChecksOps wallet is vendor_setup_required (never the vendor\'s bank); two wallets and no default is vendor_wallet_choice_required', async () => {
  await withEnv(FLAGS, async () => {
    const bankOnly = methods['vendor-acct'].filter((m) => m.paymentMethodType !== 'moov-wallet');
    for (const [stub, code] of [
      [{ vendorMethods: bankOnly }, 'vendor_setup_required'],
      [{ vendorMethods: [] }, 'vendor_setup_required'],
      [{ vendorAccounts: [] }, 'vendor_setup_required'],
      // A recipient account someone created with the vendor's id as foreignID is not the vendor.
      [{ vendorAccounts: [{ accountID: 'planted', foreignID: VENDOR, metadata: { checksops_tenant_id: OTHER_TENANT, checksops_recipient_id: VENDOR } }] }, 'vendor_setup_required'],
      [{ vendorAccounts: [VENDOR_ACCOUNT, { ...VENDOR_ACCOUNT, accountID: 'vendor-acct-2' }] }, 'vendor_account_ambiguous'],
      [{ vendorMethods: [
        { paymentMethodType: 'moov-wallet', paymentMethodID: 'a', wallet: { walletID: '1', walletType: 'general' } },
        { paymentMethodType: 'moov-wallet', paymentMethodID: 'b', wallet: { walletID: '2', walletType: 'general' } },
        ...bankOnly,
      ] }, 'vendor_wallet_choice_required'],
    ]) {
      const client = fakeDb();
      const moov = moovStub(stub);
      const result = await run(client, moov, { recipients: [vendor(700)] });
      assert.equal(result.statusCode, 409, code);
      assert.equal(result.error, code, JSON.stringify(stub).slice(0, 80));
      assert.equal(moov.posts().length, 0, code);
      assert.equal(client.committed.transfers.length, 0, code);
    }
    const missing = await run(fakeDb(), moovStub({ vendorMethods: bankOnly }), { recipients: [vendor(700)] });
    assert.equal(missing.message, "This vendor hasn't finished wallet setup. Nothing was sent.");
    // Operating and trust wallets: the default (operating) one.
    const client = fakeDb();
    const moov = moovStub({ vendorMethods: [
      { paymentMethodType: 'moov-wallet', paymentMethodID: 'pm-v-trust', wallet: { walletID: 'v2', walletType: 'general' } },
      { paymentMethodType: 'moov-wallet', paymentMethodID: 'pm-v-operating', wallet: { walletID: 'v1', walletType: 'default' } },
    ] });
    const ok = await run(client, moov, { recipients: [vendor(700)] });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.deepEqual(moov.posts()[0].body.destination, { paymentMethodID: 'pm-v-operating' });
  });
});

test('vendor: the check gate is unchanged (the check must be the sender\'s own or shared with the sender)', async () => {
  await withEnv(FLAGS, async () => {
    const notMine = await run(fakeDb({ checkTenant: OTHER_TENANT, shares: [] }), moovStub(), { recipients: [vendor(700)] });
    assert.equal(notMine.error, 'check_not_found');
    // Shared with the sender: the sender pays its own vendor from it.
    const client = fakeDb({ checkTenant: OTHER_TENANT, shares: [{ check_id: CHECK, source_tenant_id: OTHER_TENANT, target_tenant_id: TENANT }] });
    const moov = moovStub();
    const shared = await run(client, moov, { recipients: [vendor(700)] });
    assert.equal(shared.ok, true, JSON.stringify(shared));
    assert.equal(client.committed.transfers[0].tenant_id, TENANT);
  });
});

test('vendor payroll: one vendor is paid wallet to wallet; the payroll_runs row names vendor_tenant_id and no stakeholder', async () => {
  await withEnv(FLAGS, async () => {
    const client = fakeDb();
    const moov = moovStub();
    const result = await run(client, moov, payroll({ recipients: [vendor(150_000)], description: 'Vendor: Nov' }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(client.log.some((l) => l.sql.includes('FROM public.check_intake_items')), false);
    assert.deepEqual(moov.posts()[0].body.destination, { paymentMethodID: 'pm-vendor-wallet' });
    const [leg] = client.committed.transfers;
    assert.equal(leg.check_id, null);
    assert.equal(leg.destination_tenant_id, VENDOR);
    assert.equal(leg.provider_metadata.recipient_kind, 'vendor');
    assert.equal(leg.provider_metadata.purpose, 'payroll');
    const [row] = client.committed.payroll;
    assert.equal(leg.provider_metadata.payroll_run_id, row.id);
    assert.deepEqual(
      { payee: row.stakeholder_account_id, vendor: row.vendor_tenant_id, amount: row.amount, speed: row.speed, memo: row.memo, status: row.status },
      { payee: null, vendor: VENDOR, amount: '1500.00', speed: 'next_day', memo: 'Vendor: Nov', status: 'submitted' },
    );
    const insert = client.log.find((l) => l.sql.includes('INSERT INTO public.payroll_runs'));
    assert.match(insert.sql, /\(tenant_id, stakeholder_account_id, vendor_tenant_id, disbursement_batch_id, amount, speed, memo, initiated_by, status\)/);
    assert.equal(row.financial_execution, true);
    // A stakeholder payroll still names the stakeholder and no vendor.
    const stk = fakeDb();
    assert.equal((await run(stk, moovStub(), payroll())).ok, true);
    assert.deepEqual([stk.committed.payroll[0].stakeholder_account_id, stk.committed.payroll[0].vendor_tenant_id], [STAKEHOLDER, null]);
  });
});

test('vendor payroll: an unpayable vendor or no wallet records no run and sends nothing', async () => {
  await withEnv(FLAGS, async () => {
    for (const [options, stub, code] of [
      [{ vendorPayees: [] }, {}, 'vendor_not_payee'],
      [{}, { vendorMethods: [] }, 'vendor_setup_required'],
    ]) {
      const client = fakeDb(options);
      const moov = moovStub(stub);
      const result = await run(client, moov, payroll({ recipients: [vendor(150_000)] }));
      assert.equal(result.error, code);
      assert.equal(client.committed.payroll.length, 0, code);
      assert.equal(client.committed.transfers.length, 0, code);
      assert.equal(moov.posts().length, 0, code);
    }
  });
});

test('staging: a vendor send runs the same path against the Moov sandbox', async () => {
  await withEnv(STAGING_FLAGS, async () => {
    const client = fakeDb({ environment: 'sandbox', stakeholders: SANDBOX_STAKEHOLDERS });
    const moov = moovStub();
    const result = await run(client, moov, { recipients: [vendor(700)] }, {}, sandboxDeps);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.environment, 'sandbox');
    assert.deepEqual(moov.posts()[0].body.destination, { paymentMethodID: 'pm-vendor-wallet' });
    assert.equal(client.committed.transfers[0].environment, 'sandbox');
    assert.equal(client.committed.transfers[0].destination_tenant_id, VENDOR);
  });
});
