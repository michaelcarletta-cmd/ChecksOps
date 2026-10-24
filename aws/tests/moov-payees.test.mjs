/**
 * Moov payees (SQL 113, providers/payees): tenant create / resend / disconnect,
 * the public link steps, PII handling, the production flag and providers.mjs
 * routing. The database fake implements the six SQL 113 functions' contracts.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LOOKUP_MAPPING_SQL, TENANT_MEMBERSHIP_SQL } from '../functions/api/identity.mjs';
import { handleProviderRequest } from '../functions/api/providers.mjs';
import { FUNCTION_BY_NAME } from '../functions/api/providers/catalog.mjs';
import { resetMoovTokenCache } from '../functions/api/providers/parity/moov-client.mjs';
import { PLATFORM_OWNER_SQL, TENANT_MOOV_ENV_SQL } from '../functions/api/providers/onboarding/context.mjs';
import {
  PAYEE_APPLY_STATUS_SQL,
  PAYEE_BY_TOKEN_SQL,
  PAYEE_CREATE_SQL,
  PAYEE_DISCONNECT_SQL,
  PAYEE_FIND_SQL,
  PAYEE_FUNCTION_NAMES,
  PAYEE_PUBLIC_FUNCTION_NAMES,
  PAYEE_RECORD_SQL,
  PAYEE_REISSUE_SQL,
  PAYEE_TENANT_FUNCTION_NAMES,
} from '../functions/api/providers/payees/handlers.mjs';
import { payeeVerdict } from '../functions/api/providers/payees/moov.mjs';
import { payeeDeployment } from '../functions/api/providers/payees/flags.mjs';
import { renderPayeeSetupEmail } from '../functions/api/providers/payees/email.mjs';

const TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const OTHER_TENANT = '9b1f7a52-1c0e-4d5a-9a3f-5d6e7f8a9b0c';
const PLATFORM_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SSN = '123456789';
const EIN = '274444321';
const DOB = '1980-04-05';
const ROUTING = '021000021';
const ACCOUNT_NUMBER = '000123456789';
const PAYEE_IP = '203.0.113.7';

const USERS = {
  owner: { sub: 'sub-owner', app: '10000000-0000-4000-8000-000000000001', memberships: [[TENANT, 'owner']] },
  viewer: { sub: 'sub-viewer', app: '10000000-0000-4000-8000-000000000005', memberships: [[TENANT, 'viewer']] },
  partner: { sub: 'sub-partner', app: '10000000-0000-4000-8000-000000000006', memberships: [[OTHER_TENANT, 'owner']] },
  platformOwner: { sub: 'sub-platform', app: '10000000-0000-4000-8000-000000000008', memberships: [], platformOwner: true },
};

const STAGING = {
  AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'true',
  AWS_PROVIDER_EXECUTION_ENABLED: 'false',
  AWS_MOOV_ENABLED: 'false',
  AWS_MOOV_PAYEES_PRODUCTION_ENABLED: undefined,
  AWS_MOOV_ONBOARDING_PRODUCTION_ENABLED: undefined,
};
const PRODUCTION = {
  ...STAGING,
  AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'false',
  AWS_PROVIDER_EXECUTION_ENABLED: 'true',
  AWS_MOOV_ENABLED: 'true',
};

const withEnv = async (vars, fn) => {
  const previous = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    resetMoovTokenCache();
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const captureConsole = async (fn) => {
  const lines = [];
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const k of Object.keys(orig)) console[k] = (...args) => lines.push(args.map(String).join(' '));
  try {
    return { result: await fn(), lines };
  } finally {
    Object.assign(console, orig);
  }
};

const jwtEvent = (name, body, user) => ({
  rawPath: `/functions/v1/${name}`,
  headers: { authorization: 'Bearer test-id-token', 'user-agent': 'node-test' },
  body: JSON.stringify(body || {}),
  requestContext: {
    stage: 'staging',
    http: { method: 'POST', path: `/functions/v1/${name}`, sourceIp: '198.51.100.1' },
    authorizer: { jwt: { claims: { sub: user.sub, email: `${user.sub}@example.com`, token_use: 'id', auth_time: '1760000000' } } },
  },
});

/** A payee's browser: no authorization header, no identity. */
const publicEvent = (name, body) => ({
  rawPath: `/functions/v1/${name}`,
  headers: { 'user-agent': 'PayeeBrowser/1.0', 'x-forwarded-for': '10.9.9.9' },
  body: JSON.stringify(body || {}),
  requestContext: { stage: 'staging', http: { method: 'POST', path: `/functions/v1/${name}`, sourceIp: PAYEE_IP } },
});

// ------------------------------------------------------------------ SQL 113 fake

const makeDb = ({ tenantEnv = 'sandbox' } = {}) => {
  const state = {
    tenants: {
      [TENANT]: { id: TENANT, name: 'Freedom Adjusting', moov_allowlisted: true, moov_environment: tenantEnv, is_system_tenant: false },
      [OTHER_TENANT]: { id: OTHER_TENANT, name: 'Partner', moov_allowlisted: true, moov_environment: 'sandbox', is_system_tenant: false },
    },
    recipients: [],
    stakeholders: [],
    methods: [],
    params: [],
    calls: [],
    clients: 0,
  };
  let seq = 0;
  const nextId = () => { seq += 1; return `eeeeeeee-0000-4000-8000-${String(seq).padStart(12, '0')}`; };
  const isMember = (app, tenantId) => Object.values(USERS).some((u) => u.app === app && u.memberships.some(([t]) => t === tenantId));
  const byToken = (token) => {
    const rec = state.recipients.find((r) => r.secure_token === token && String(token).length >= 32);
    if (!rec) return { error: 'not_found' };
    if (rec.disconnected_at) return { error: 'disconnected' };
    if (!rec.token_expires_at || new Date(rec.token_expires_at) < new Date()) return { error: 'expired' };
    return {
      ok: true, recipient_id: rec.id, tenant_id: rec.tenant_id, tenant_name: state.tenants[rec.tenant_id]?.name ?? null,
      display_name: rec.display_name, email: rec.email, recipient_type: rec.recipient_type, relationship: rec.relationship,
      environment: rec.environment, provider_account_id: rec.provider_account_id, onboarding_status: rec.onboarding_status,
      tos_accepted_at: rec.tos_accepted_at, identity_submitted_at: rec.identity_submitted_at,
      provider_bank_account_id: rec.provider_bank_account_id, provider_bank_name: rec.provider_bank_name,
      provider_last_four: rec.provider_last_four, bank_linked_at: rec.bank_linked_at, bank_verified_at: rec.bank_verified_at,
      verified_at: rec.verified_at, setup_attempts: rec.setup_attempts,
    };
  };
  const now = () => new Date().toISOString();
  const fns = {
    [PAYEE_CREATE_SQL]: (p, actor) => {
      const [rid, tid, name, email, type, rel, env, acct, token, exp, claim, check] = p;
      if (!actor || !isMember(actor, tid)) return { error: 'forbidden' };
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: 'invalid_email' };
      if (!['sandbox', 'production'].includes(env)) return { error: 'invalid_environment' };
      if (!/^[A-Za-z0-9-]{8,64}$/.test(acct)) return { error: 'invalid_provider_account' };
      if (token.length < 32 || !/^[A-Za-z0-9_-]+$/.test(token)) return { error: 'invalid_token' };
      const ms = new Date(exp) - Date.now();
      if (!(ms > 0 && ms <= 30 * 86_400_000)) return { error: 'invalid_expiry' };
      const existing = state.recipients.find((r) => r.id === rid);
      if (existing) return { ok: true, replayed: true, recipient_id: rid, stakeholder_account_id: existing.stakeholder_account_id };
      const stakeholder = { id: nextId(), tenant_id: tid, origin: 'provider_recipient', is_active: true, verification_status: 'pending', provider_account_id: acct, account_type: rel };
      state.stakeholders.push(stakeholder);
      state.recipients.push({
        id: rid, tenant_id: tid, display_name: name, email, recipient_type: type, relationship: rel, environment: env,
        provider_account_id: acct, onboarding_status: 'invited', secure_token: token, token_expires_at: exp,
        claim_id: claim, check_id: check, stakeholder_account_id: stakeholder.id, setup_attempts: 0,
      });
      return { ok: true, replayed: false, recipient_id: rid, stakeholder_account_id: stakeholder.id };
    },
    [PAYEE_REISSUE_SQL]: ([rid, token, exp], actor) => {
      const rec = state.recipients.find((r) => r.id === rid);
      if (!rec || !isMember(actor, rec.tenant_id)) return { error: 'not_found' };
      if (rec.disconnected_at) return { error: 'disconnected' };
      if (rec.verified_at) return { error: 'already_verified' };
      Object.assign(rec, { secure_token: token, token_expires_at: exp, setup_attempts: 0 });
      return { ok: true, recipient_id: rec.id, email: rec.email, display_name: rec.display_name, tenant_id: rec.tenant_id };
    },
    [PAYEE_DISCONNECT_SQL]: ([rid], actor) => {
      const rec = state.recipients.find((r) => r.id === rid);
      if (!rec || !isMember(actor, rec.tenant_id)) return { error: 'not_found' };
      if (!rec.disconnected_at) {
        Object.assign(rec, { disconnected_at: now(), onboarding_status: 'disconnected', secure_token: null });
        state.stakeholders.find((s) => s.id === rec.stakeholder_account_id).is_active = false;
      }
      return { ok: true, recipient_id: rec.id, stakeholder_account_id: rec.stakeholder_account_id, provider_account_id: rec.provider_account_id, environment: rec.environment };
    },
    [PAYEE_BY_TOKEN_SQL]: ([token]) => byToken(token),
    [PAYEE_RECORD_SQL]: ([token, event, data]) => {
      const found = byToken(token);
      if (found.error) return found;
      const rec = state.recipients.find((r) => r.id === found.recipient_id);
      if (rec.setup_attempts >= 60) return { error: 'rate_limited' };
      rec.setup_attempts += 1;
      const d = JSON.parse(data || '{}');
      if (event === 'tos_accepted') rec.tos_accepted_at = rec.tos_accepted_at || now();
      else if (event === 'identity_submitted') rec.identity_submitted_at = now();
      else if (event === 'bank_linked') {
        if (!/^[A-Za-z0-9-]{8,64}$/.test(d.provider_bank_account_id || '')) return { error: 'invalid_bank_account' };
        if (!/^\d{4}$/.test(d.last_four || '')) return { error: 'invalid_last_four' };
        state.methods.push({ external_recipient_id: rec.id, ...d });
        Object.assign(rec, { provider_bank_account_id: d.provider_bank_account_id, provider_bank_name: d.bank_name, provider_last_four: d.last_four, bank_linked_at: now(), bank_verified_at: null });
      } else if (event === 'bank_verified') {
        if (d.provider_bank_account_id !== rec.provider_bank_account_id) return { error: 'bank_mismatch' };
        rec.bank_verified_at = rec.bank_verified_at || now();
      } else return { error: 'invalid_event' };
      rec.onboarding_status = rec.verified_at ? rec.onboarding_status : event;
      return byToken(token);
    },
    [PAYEE_APPLY_STATUS_SQL]: ([env, acct, status]) => {
      const rec = state.recipients.find((r) => r.environment === env && r.provider_account_id === acct);
      if (!rec) return { error: 'not_found' };
      if (status === 'verified') {
        if (!rec.tos_accepted_at || !rec.identity_submitted_at || !rec.provider_bank_account_id || !rec.bank_verified_at) return { error: 'setup_incomplete' };
        Object.assign(rec, { verified_at: now(), onboarding_status: 'verified' });
        state.stakeholders.find((s) => s.id === rec.stakeholder_account_id).verification_status = 'verified';
      } else {
        rec.onboarding_status = status;
        state.stakeholders.find((s) => s.id === rec.stakeholder_account_id).verification_status = status === 'failed' ? 'failed' : 'pending';
      }
      return { ok: true, recipient_id: rec.id, status };
    },
  };
  const create = () => {
    state.clients += 1;
    let actor = null;
    return {
      connect: async () => {},
      end: async () => {},
      query: async (sql, params = []) => {
        const text = String(sql);
        state.params.push(...params.map((p) => (p === null || p === undefined ? '' : String(p))));
        if (['BEGIN', 'ROLLBACK', 'COMMIT', 'SET TRANSACTION READ WRITE'].includes(text) || /^(SAVEPOINT|RELEASE|ROLLBACK TO)/.test(text)) {
          return { rows: [], command: text };
        }
        if (text.startsWith('SELECT set_config')) {
          if (params[0] === 'request.app_user_id') actor = params[1];
          return { rows: [{}] };
        }
        if (text === LOOKUP_MAPPING_SQL) {
          const u = Object.values(USERS).find((x) => x.sub === params[0]);
          return { rows: u ? [{ application_user_id: u.app, cognito_sub: u.sub, email: `${u.sub}@example.com`, status: 'active' }] : [] };
        }
        if (text === TENANT_MEMBERSHIP_SQL) {
          const u = Object.values(USERS).find((x) => x.app === params[0]);
          return { rows: (u?.memberships || []).map(([tenant_id, role]) => ({ tenant_id, role, tenant_name: 't', tenant_slug: 't' })) };
        }
        if (text === PLATFORM_OWNER_SQL) {
          return { rows: [{ is_platform_owner: Object.values(USERS).some((u) => u.app === actor && u.platformOwner) }] };
        }
        if (text === TENANT_MOOV_ENV_SQL) {
          const t = state.tenants[params[0]];
          return { rows: t ? [t] : [] };
        }
        if (fns[text]) {
          state.calls.push({ sql: text, params, actor });
          return { rows: [{ result: fns[text](params, actor) }] };
        }
        if (text === PAYEE_FIND_SQL) {
          const [tid, id] = params;
          const row = state.recipients.find((r) => (tid === null || r.tenant_id === tid)
            && (r.id === id || r.stakeholder_account_id === id) && isMember(actor, r.tenant_id));
          return { rows: row ? [row] : [] };
        }
        if (text.includes('FROM public.tenants WHERE id')) return { rows: state.tenants[params[0]] ? [state.tenants[params[0]]] : [] };
        if (text.includes('tenant_email_settings')) return { rows: [] };
        if (/^\s*(INSERT|UPDATE|DELETE)/i.test(text)) throw new Error(`unexpected direct write: ${text.slice(0, 60)}`);
        return { rows: [] };
      },
    };
  };
  return { state, create };
};

// ------------------------------------------------------------------ Moov fake

const makeMoov = () => {
  const calls = [];
  const accounts = new Map();
  let seq = 0;
  const id = (prefix) => { seq += 1; return `${prefix}-${String(seq).padStart(4, '0')}-aaaa-bbbb`; };
  const json = (status, body) => ({ ok: status < 400, status, text: async () => (body === undefined ? '' : JSON.stringify(body)) });
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || 'GET';
    const u = new URL(String(url));
    const path = u.pathname;
    const body = init.body ? (typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : init.body) : undefined;
    calls.push({ path, query: u.search, method, headers: init.headers || {}, body, raw: init.body });
    if (path === '/oauth2/token') return json(200, { access_token: 'tok', expires_in: 300 });
    if (path === '/tos-token') return json(200, { token: 'tos-token-minted-1234' });
    if (path === '/accounts' && method === 'GET') {
      const foreign = u.searchParams.get('foreignID');
      return json(200, [...accounts.values()].filter((a) => a.foreignID === foreign).map((a) => ({ accountID: a.id, foreignID: a.foreignID })));
    }
    if (path === '/accounts' && method === 'POST') {
      if (makeMoov.conflictOnce) {
        makeMoov.conflictOnce = false;
        const a = { id: id('acct'), foreignID: body.foreignID, type: body.accountType, tos: false, capStatus: 'disabled', due: ['individual.ssn'], verification: 'unverified', banks: [], reps: [], verify: null };
        accounts.set(a.id, a);
        return json(409, { error: 'duplicate foreignID' });
      }
      const a = { id: id('acct'), foreignID: body.foreignID, type: body.accountType, tos: false, capStatus: 'disabled', due: ['individual.ssn', 'individual.birthdate'], verification: 'unverified', banks: [], reps: [], verify: null };
      accounts.set(a.id, a);
      return json(200, { accountID: a.id });
    }
    const m = path.match(/^\/accounts\/([^/]+)(\/.*)?$/);
    const a = m ? accounts.get(m[1]) : null;
    if (!a) return json(404, { error: 'not found' });
    const rest = m[2] || '';
    if (rest === '' && method === 'GET') {
      const verification = { status: a.verification };
      return json(200, {
        accountID: a.id,
        termsOfService: a.tos ? { acceptedDate: '2026-10-23T00:00:00Z' } : undefined,
        profile: a.type === 'business' ? { business: { verification } } : { individual: { verification } },
        ...(a.disabled ? { disabledOn: '2026-10-23' } : {}),
      });
    }
    if (rest === '' && method === 'PATCH') {
      if (body?.termsOfService?.token) a.tos = true;
      return json(200, { accountID: a.id });
    }
    if (rest === '' && method === 'DELETE') { a.disconnected = true; return json(204); }
    if (rest === '/capabilities' && method === 'GET') {
      if (a.capsFail) return json(403, { error: 'forbidden' });
      return json(200, [{ capability: 'transfers', status: a.capStatus, requirements: { currentlyDue: a.tos ? a.due : [...a.due, 'account.tos'] } }]);
    }
    if (rest === '/capabilities' && method === 'POST') return json(200, {});
    if (rest === '/representatives' && method === 'GET') return json(200, a.reps);
    if (rest === '/representatives' && method === 'POST') {
      const rep = { representativeID: id('rep'), name: body.name };
      a.reps.push(rep);
      return json(200, rep);
    }
    if (/^\/representatives\//.test(rest)) return json(200, {});
    if (rest === '/bank-accounts' && method === 'GET') return json(200, a.banks);
    if (rest === '/bank-accounts' && method === 'POST') {
      const bank = { bankAccountID: id('bank'), bankName: 'Test Bank', lastFourAccountNumber: body.account.accountNumber.slice(-4), status: 'new' };
      a.banks.push(bank);
      return json(200, bank);
    }
    const b = rest.match(/^\/bank-accounts\/([^/]+)(\/verify)?$/);
    if (b) {
      const bank = a.banks.find((x) => x.bankAccountID === b[1]);
      if (!bank) return json(404, {});
      if (!b[2] && method === 'GET') return json(200, bank);
      if (!b[2] && method === 'DELETE') { bank.deleted = true; return json(204); }
      if (b[2] && method === 'GET') return a.verify ? json(200, { status: a.verify }) : json(404, {});
      if (b[2] && method === 'POST') { a.verify = 'new'; return json(200, {}); }
      if (b[2] && method === 'PUT') {
        if (body?.code !== 'MV1234') return json(400, { error: `code ${body?.code} invalid` });
        bank.status = 'verified';
        a.verify = 'successful';
        return json(200, {});
      }
    }
    return json(404, {});
  };
  return { fetchImpl, calls, accounts };
};

// ------------------------------------------------------------------ harness

const sandboxCreds = async () => ({
  moov: { publicKey: 'pk_sandbox', secretKey: 'sk_sandbox', platformAccountId: PLATFORM_ID, origin: 'https://checksops.com', apiVersion: 'v2024.01.00' },
});

const makeHarness = (opts = {}) => {
  const db = makeDb(opts);
  const moov = makeMoov();
  const emails = [];
  const deps = {
    loadDatabaseCredentials: async () => ({ host: 'localhost', username: 'checksops', password: 'x', database: 'checksops' }),
    createClient: () => db.create(),
    loadSandboxCredentials: sandboxCreds,
    loadProviderSecrets: async () => ({ MOOV_PUBLIC_KEY: 'pk_live', MOOV_SECRET_KEY: 'sk_live', MOOV_ACCOUNT_ID: PLATFORM_ID }),
    fetchImpl: moov.fetchImpl,
    appUrl: 'https://staging.checksops.com',
    sendEmail: async (msg) => { emails.push(msg); return { results: [{ status: 'sent', delivery: 'ses' }] }; },
  };
  const call = (name, body, user) => handleProviderRequest(
    user ? jwtEvent(name, body, user) : publicEvent(name, body), `/functions/v1/${name}`, 'POST', deps,
  );
  const tokenFromEmail = (i = emails.length - 1) => {
    const match = emails[i].text.match(/\/pay-setup\/([A-Za-z0-9_-]+)/);
    return match[1];
  };
  return { db, moov, emails, deps, call, tokenFromEmail };
};

const INDIVIDUAL = {
  first_name: 'Hannah', last_name: 'Owner', phone: '5125550100', address_line1: '1 Main St', city: 'Austin',
  state: 'TX', postal_code: '78701', birth_date: DOB, ssn: SSN,
};
const BANK = { holder_name: 'Hannah Owner', holder_type: 'individual', bank_account_type: 'checking', routing_number: ROUTING, account_number: ACCOUNT_NUMBER };
const ADDRESS = { line1: '9 Oak Ave', city: 'Austin', state: 'TX', postal_code: '78702' };

const noSecretsIn = (label, haystack, extra = []) => {
  for (const secret of [SSN, '123-45-6789', EIN, DOB, ROUTING, ACCOUNT_NUMBER, ...extra]) {
    assert.equal(String(haystack).includes(secret), false, `${label} contains ${secret}`);
  }
};

// ------------------------------------------------------------------ tests

test('catalog and routing names: tenant and public payee functions', () => {
  assert.deepEqual([...PAYEE_TENANT_FUNCTION_NAMES].sort(), ['homeowner-bank-link-send', 'moov-recipient-create', 'moov-recipient-disconnect', 'moov-recipient-link-resend']);
  assert.deepEqual([...PAYEE_PUBLIC_FUNCTION_NAMES].sort(), ['moov-recipient-bank-add', 'moov-recipient-bank-verify', 'moov-recipient-kyc-update', 'moov-recipient-session', 'moov-recipient-tos-accept']);
  for (const name of PAYEE_FUNCTION_NAMES) assert.equal(FUNCTION_BY_NAME[name]?.provider, 'moov', name);
  assert.equal(FUNCTION_BY_NAME['homeowner-bank-link-send'].aws, 'sandbox_parity');
});

test('payee deployment: staging sandbox, production only behind its own flag', async () => {
  await withEnv(STAGING, async () => assert.equal(payeeDeployment(), 'sandbox'));
  await withEnv({ ...STAGING, AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'false' }, async () => assert.equal(payeeDeployment(), null));
  for (const flag of [undefined, 'false', 'TRUE', '1']) {
    await withEnv({ ...PRODUCTION, AWS_MOOV_PAYEES_PRODUCTION_ENABLED: flag }, async () => assert.equal(payeeDeployment(), null, String(flag)));
  }
  await withEnv({ ...PRODUCTION, AWS_MOOV_PAYEES_PRODUCTION_ENABLED: 'true' }, async () => assert.equal(payeeDeployment(), 'production'));
  await withEnv({ ...PRODUCTION, AWS_MOOV_ONBOARDING_PRODUCTION_ENABLED: 'true' }, async () => assert.equal(payeeDeployment(), null));
});

test('create individual payee: Moov account first (transfers, foreignID, idempotency), then aws_payee_create, then the emailed link', async () => {
  await withEnv(STAGING, async () => {
    const h = makeHarness();
    const { result: r, lines } = await captureConsole(() => h.call('moov-recipient-create', {
      tenant_id: TENANT, name: 'Hannah Owner', email: 'Hannah@Example.com', recipient_type: 'individual', relationship: 'subcontractor',
      environment: 'production',
    }, USERS.owner));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.environment, 'sandbox');
    assert.equal(r.status, 'invited');
    assert.equal(r.email_sent, true);
    assert.equal(r.setup_link_returned, false);

    const post = h.moov.calls.find((c) => c.path === '/accounts' && c.method === 'POST');
    assert.equal(post.body.accountType, 'individual');
    assert.deepEqual(post.body.capabilities, ['transfers']);
    assert.deepEqual(post.body.profile.individual.name, { firstName: 'Hannah', lastName: 'Owner' });
    assert.equal(post.body.profile.individual.email, 'hannah@example.com');
    assert.equal(post.body.foreignID, r.recipient_id);
    assert.equal(post.body.metadata.checksops_tenant_id, TENANT);
    assert.match(post.headers['X-Idempotency-Key'], /^[0-9a-f-]{36}$/);
    assert.equal(post.headers['x-moov-version'], 'v2025.07.00');

    const create = h.db.state.calls.find((c) => c.sql === PAYEE_CREATE_SQL);
    const [rid, tid, name, email, type, rel, env, acct, token, expires] = create.params;
    assert.equal(rid, r.recipient_id);
    assert.equal(tid, TENANT);
    assert.deepEqual([name, email, type, rel, env], ['Hannah Owner', 'hannah@example.com', 'individual', 'subcontractor', 'sandbox']);
    assert.equal(acct, r.recipient.provider_account_id);
    assert.equal(create.actor, USERS.owner.app);
    assert.ok(token.length >= 43 && /^[A-Za-z0-9_-]+$/.test(token));
    const days = (new Date(expires) - Date.now()) / 86_400_000;
    assert.ok(days > 13.9 && days <= 14);

    assert.equal(h.emails.length, 1);
    assert.equal(h.emails[0].to, 'hannah@example.com');
    assert.ok(h.emails[0].text.includes(`https://staging.checksops.com/pay-setup/${token}`));
    assert.match(h.emails[0].subject, /Freedom Adjusting wants to pay you/);
    assert.equal(/moov/i.test(h.emails[0].html + h.emails[0].text + h.emails[0].subject), false);

    // The token reaches only the payee's inbox.
    assert.equal(JSON.stringify(r).includes(token), false);
    assert.equal(lines.join('\n').includes(token), false);
    assert.equal(h.db.state.stakeholders[0].origin, 'provider_recipient');
  });
});

test('create business payee and homeowner-bank-link-send map to the right Moov account and payee rows', async () => {
  await withEnv(STAGING, async () => {
    const h = makeHarness();
    const b = await h.call('moov-recipient-create', {
      tenant_id: TENANT, display_name: 'Acme Roofing LLC', email: 'ap@acme.test', recipient_type: 'business', relationship: 'vendor',
      check_id: '11111111-2222-4333-8444-555555555555',
    }, USERS.owner);
    assert.equal(b.ok, true, JSON.stringify(b));
    const post = h.moov.calls.find((c) => c.path === '/accounts' && c.method === 'POST');
    assert.equal(post.body.accountType, 'business');
    assert.deepEqual(post.body.profile.business, { legalBusinessName: 'Acme Roofing LLC', email: 'ap@acme.test' });
    assert.equal(h.db.state.recipients[0].check_id, '11111111-2222-4333-8444-555555555555');

    const ho = await h.call('homeowner-bank-link-send', {
      tenant_id: TENANT, scope: 'check', homeowner_name: 'Pat Home', homeowner_email: 'pat@home.test',
      check_intake_item_id: '11111111-2222-4333-8444-555555555556',
    }, USERS.owner);
    assert.equal(ho.ok, true, JSON.stringify(ho));
    assert.equal(ho.payout_url, null);
    const row = h.db.state.recipients[1];
    assert.deepEqual([row.recipient_type, row.relationship, row.email, row.check_id], ['individual', 'homeowner', 'pat@home.test', '11111111-2222-4333-8444-555555555556']);
    assert.equal(h.emails.length, 2);

    const bad = await h.call('moov-recipient-create', { tenant_id: TENANT, name: 'X Y', email: 'not-an-email' }, USERS.owner);
    assert.equal(bad.statusCode, 400);
    assert.equal(h.moov.calls.filter((c) => c.path === '/accounts' && c.method === 'POST').length, 2, 'invalid input never reaches Moov');
  });
});

test('create replays by request_id and adopts an existing Moov account on 409', async () => {
  await withEnv(STAGING, async () => {
    const h = makeHarness();
    const body = { tenant_id: TENANT, name: 'Sam Sub', email: 'sam@sub.test', request_id: '22222222-3333-4444-8555-666666666666' };
    const first = await h.call('moov-recipient-create', body, USERS.owner);
    const second = await h.call('moov-recipient-create', body, USERS.owner);
    assert.equal(first.recipient_id, second.recipient_id);
    assert.equal(second.replayed, true);
    assert.equal(h.db.state.recipients.length, 1);
    assert.equal(h.emails.length, 1, 'a replay sends no second email');

    makeMoov.conflictOnce = true;
    const h2 = makeHarness();
    makeMoov.conflictOnce = true;
    const adopted = await h2.call('moov-recipient-create', { tenant_id: TENANT, name: 'Ada Adopt', email: 'ada@x.test' }, USERS.owner);
    assert.equal(adopted.ok, true, JSON.stringify(adopted));
    const lookup = h2.moov.calls.find((c) => c.path === '/accounts' && c.method === 'GET');
    assert.equal(new URLSearchParams(lookup.query).get('foreignID'), adopted.recipient_id);
    assert.equal(h2.db.state.recipients[0].provider_account_id, [...h2.moov.accounts.values()][0].id);
  });
});

test('non-members, the non-member platform owner and anonymous callers cannot create; nothing reaches Moov', async () => {
  await withEnv(STAGING, async () => {
    const h = makeHarness();
    const body = { tenant_id: TENANT, name: 'Hannah Owner', email: 'h@example.com' };
    const partner = await h.call('moov-recipient-create', body, USERS.partner);
    assert.equal(partner.statusCode, 403);
    assert.equal(partner.error, 'cross_tenant_denied');
    const owner = await h.call('moov-recipient-create', body, USERS.platformOwner);
    assert.equal(owner.statusCode, 403);
    assert.equal(owner.error, 'tenant_member_required');
    for (const name of PAYEE_TENANT_FUNCTION_NAMES) {
      const anon = await h.call(name, body);
      assert.equal(anon.statusCode, 401, name);
    }
    assert.equal(h.moov.calls.length, 0);
    assert.equal(h.db.state.calls.length, 0);
    // Any member may create (no role tiers).
    const viewer = await h.call('moov-recipient-create', body, USERS.viewer);
    assert.equal(viewer.ok, true);
  });
});

test('production: every payee name is hard-blocked while the flag is off; other names stay blocked with it on', async () => {
  for (const flag of [undefined, 'false', 'TRUE']) {
    await withEnv({ ...PRODUCTION, AWS_MOOV_PAYEES_PRODUCTION_ENABLED: flag, AWS_MOOV_ONBOARDING_PRODUCTION_ENABLED: 'true' }, async () => {
      const h = makeHarness({ tenantEnv: 'production' });
      for (const name of PAYEE_FUNCTION_NAMES) {
        const r = await h.call(name, { tenant_id: TENANT, token: 'a'.repeat(43) }, PAYEE_PUBLIC_FUNCTION_NAMES.includes(name) ? null : USERS.owner);
        assert.equal(r.error, 'production_execution_blocked', `${name} ${flag}`);
        assert.equal(r.tranche4HardBlock, true);
      }
      assert.equal(h.db.state.clients, 0);
      assert.equal(h.moov.calls.length, 0);
    });
  }
  await withEnv({ ...PRODUCTION, AWS_MOOV_PAYEES_PRODUCTION_ENABLED: 'true' }, async () => {
    const h = makeHarness({ tenantEnv: 'production' });
    for (const name of ['moov-transfer-create', 'moov-tenant-fee-charge', 'moov-platform-bank', 'moov-account-create', 'stakeholder-resend-verification']) {
      const r = await h.call(name, { tenant_id: TENANT }, USERS.owner);
      assert.equal(r.error, 'production_execution_blocked', name);
    }
  });
});

test('production with the flag on: production tenants use production credentials; sandbox tenants are refused before Moov', async () => {
  await withEnv({ ...PRODUCTION, AWS_MOOV_PAYEES_PRODUCTION_ENABLED: 'true' }, async () => {
    const h = makeHarness({ tenantEnv: 'production' });
    let sandboxLoaded = false;
    h.deps.loadSandboxCredentials = async () => { sandboxLoaded = true; return {}; };
    const r = await h.call('moov-recipient-create', { tenant_id: TENANT, name: 'Prod Payee', email: 'p@x.test' }, USERS.owner);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.environment, 'production');
    assert.equal(r.productionExecution, true);
    assert.equal(sandboxLoaded, false);
    assert.equal(h.db.state.recipients[0].environment, 'production');
    const oauth = h.moov.calls.find((c) => c.path === '/oauth2/token');
    assert.equal(oauth.headers.Authorization, `Basic ${Buffer.from('pk_live:sk_live').toString('base64')}`);

    const token = h.tokenFromEmail();
    const s = await h.call('moov-recipient-session', { token });
    assert.equal(s.ok, true, JSON.stringify(s));
    assert.equal(s.environment, 'production');

    const sandboxTenant = makeHarness({ tenantEnv: 'sandbox' });
    const refused = await sandboxTenant.call('moov-recipient-create', { tenant_id: TENANT, name: 'Prod Payee', email: 'p@x.test' }, USERS.owner);
    assert.equal(refused.error, 'production_provider_context_unresolved');
    assert.equal(sandboxTenant.moov.calls.length, 0);
  });
});

test('public individual setup end to end: no login, terms with the payee IP, identity, bank, micro-deposit, verified only when Moov says so', async () => {
  await withEnv(STAGING, async () => {
    const h = makeHarness();
    const { lines } = await captureConsole(async () => {
      const created = await h.call('moov-recipient-create', { tenant_id: TENANT, name: 'Hannah Owner', email: 'hannah@example.com' }, USERS.owner);
      const token = h.tokenFromEmail();
      const acct = h.moov.accounts.get(created.recipient.provider_account_id);

      const s1 = await h.call('moov-recipient-session', { token });
      assert.equal(s1.ok, true, JSON.stringify(s1));
      assert.equal(s1.payer.name, 'Freedom Adjusting');
      assert.equal(s1.recipient.name, 'Hannah Owner');
      assert.equal(s1.onboarding.terms_accepted, false);
      assert.equal(s1.onboarding.tos_requirement_outstanding, true);
      assert.deepEqual(s1.onboarding.identity_requirements_outstanding, ['individual.ssn', 'individual.birthdate']);
      assert.equal(s1.token, null, 'no provider access token reaches the browser');
      assert.equal(JSON.stringify(s1).includes(acct.id), false, 'no provider account id reaches the browser');
      assert.equal('email' in s1.recipient, false);

      const notAccepted = await h.call('moov-recipient-tos-accept', { token });
      assert.equal(notAccepted.statusCode, 400);
      const tos = await h.call('moov-recipient-tos-accept', { token, accepted: true });
      assert.equal(tos.ok, true, JSON.stringify(tos));
      const minted = h.moov.calls.find((c) => c.path === '/tos-token');
      assert.equal(minted.headers['X-Forwarded-For'], PAYEE_IP);
      assert.equal(minted.headers['User-Agent'], 'PayeeBrowser/1.0');
      const patch = h.moov.calls.find((c) => c.method === 'PATCH' && c.body?.termsOfService);
      assert.equal(patch.body.termsOfService.token, 'tos-token-minted-1234');
      assert.ok(h.db.state.recipients[0].tos_accepted_at);

      const earlyBank = await h.call('moov-recipient-bank-add', { token, ...BANK });
      assert.equal(earlyBank.error, 'identity_required');

      const incomplete = await h.call('moov-recipient-kyc-update', { token, first_name: 'Hannah' });
      assert.equal(incomplete.error, 'identity_fields_incomplete');
      const kyc = await h.call('moov-recipient-kyc-update', { token, ...INDIVIDUAL });
      assert.equal(kyc.ok, true, JSON.stringify(kyc));
      const kycPatch = h.moov.calls.find((c) => c.method === 'PATCH' && c.body?.profile?.individual);
      assert.deepEqual(kycPatch.body.profile.individual.governmentID, { ssn: { full: SSN } });
      assert.deepEqual(kycPatch.body.profile.individual.birthDate, { year: 1980, month: 4, day: 5 });
      assert.equal(kycPatch.body.profile.individual.email, 'hannah@example.com');
      acct.due = [];

      const bank = await h.call('moov-recipient-bank-add', { token, ...BANK });
      assert.equal(bank.ok, true, JSON.stringify(bank));
      assert.equal(bank.last_four, '6789');
      assert.deepEqual(h.db.state.methods[0], {
        external_recipient_id: h.db.state.recipients[0].id, provider_bank_account_id: acct.banks[0].bankAccountID,
        bank_name: 'Test Bank', last_four: '6789', account_type: 'checking', holder_name: 'Hannah Owner',
      });
      const resumed = await h.call('moov-recipient-bank-add', { token, ...BANK });
      assert.equal(resumed.resumed, true);
      assert.equal(acct.banks.length, 1);

      const init = await h.call('moov-recipient-bank-verify', { token, action: 'initiate' });
      assert.equal(init.initiated, true, JSON.stringify(init));
      const wrong = await h.call('moov-recipient-bank-verify', { token, action: 'confirm', code: '9999' });
      assert.equal(wrong.error, 'invalid_code');
      assert.equal(h.db.state.recipients[0].bank_verified_at ?? null, null);

      // Moov has not enabled transfers yet: bank verified, payee not payable.
      acct.capStatus = 'pending';
      const confirm = await h.call('moov-recipient-bank-verify', { token, action: 'confirm', code: '1234' });
      assert.equal(confirm.ok, true, JSON.stringify(confirm));
      assert.equal(confirm.complete, false);
      assert.equal(h.db.state.stakeholders[0].verification_status, 'pending');
      const applied = h.db.state.calls.filter((c) => c.sql === PAYEE_APPLY_STATUS_SQL).map((c) => c.params[2]);
      assert.deepEqual(applied, ['pending_review']);
      assert.equal(h.db.state.recipients[0].verified_at, undefined);

      // Moov verifies: the next session makes the payee payable.
      acct.capStatus = 'enabled';
      acct.verification = 'verified';
      const s2 = await h.call('moov-recipient-session', { token });
      assert.equal(s2.onboarding.complete, true, JSON.stringify(s2));
      assert.equal(h.db.state.stakeholders[0].verification_status, 'verified');
      const verified = h.db.state.calls.filter((c) => c.sql === PAYEE_APPLY_STATUS_SQL).at(-1);
      assert.deepEqual(verified.params, ['sandbox', acct.id, 'verified']);
      for (const r of [s1, tos, kyc, bank, confirm, s2]) noSecretsIn('response', JSON.stringify(r), [token]);
    });
    noSecretsIn('database parameters', h.db.state.params.join('\n'));
    noSecretsIn('logs', lines.join('\n'), [h.db.state.recipients[0].secure_token]);
  });
});

test('public business setup (KYB): business profile with EIN, representatives with SSN, owners provided; EIN/SSN never stored or logged', async () => {
  await withEnv(STAGING, async () => {
    const h = makeHarness();
    const { lines } = await captureConsole(async () => {
      await h.call('moov-recipient-create', { tenant_id: TENANT, name: 'Acme Roofing LLC', email: 'ap@acme.test', recipient_type: 'business' }, USERS.owner);
      const token = h.tokenFromEmail();
      const noOwners = await h.call('moov-recipient-kyc-update', {
        token, business: { legal_name: 'Acme Roofing LLC', type: 'llc', ein: EIN, phone: '5125550199', website: 'acme.test', address: ADDRESS },
      });
      assert.equal(noOwners.statusCode, 400);
      const noEin = await h.call('moov-recipient-kyc-update', {
        token, business: { legal_name: 'Acme Roofing LLC', type: 'llc', phone: '5125550199', website: 'acme.test', address: ADDRESS },
        representatives: [],
      });
      assert.equal(noEin.error, 'validation_failed');
      assert.equal(noEin.field, 'business.ein');
      const r = await h.call('moov-recipient-kyc-update', {
        token,
        business: { legal_name: 'Acme Roofing LLC', type: 'llc', ein: EIN, phone: '5125550199', website: 'acme.test', description: 'Roofing', address: ADDRESS },
        representatives: [{
          first_name: 'Rita', last_name: 'Roof', dob: DOB, ssn: SSN, address: ADDRESS, ownership_pct: 100,
          is_owner: true, is_controller: true, title: 'CEO', email: 'rita@acme.test',
        }],
      });
      assert.equal(r.ok, true, JSON.stringify(r));
      const profile = h.moov.calls.find((c) => c.method === 'PATCH' && c.body?.profile?.business?.legalBusinessName);
      assert.deepEqual(profile.body.profile.business.taxID, { ein: { number: EIN } });
      assert.equal(profile.body.profile.business.businessType, 'llc');
      assert.equal(profile.body.profile.business.email, 'ap@acme.test');
      const rep = h.moov.calls.find((c) => c.method === 'POST' && /\/representatives$/.test(c.path));
      assert.deepEqual(rep.body.governmentID, { ssn: { full: SSN } });
      assert.deepEqual(rep.body.responsibilities, { isController: true, isOwner: true, ownershipPercentage: 100, jobTitle: 'CEO' });
      const owners = h.moov.calls.find((c) => c.method === 'PATCH' && c.body?.profile?.business?.ownersProvided === true);
      assert.ok(owners);
      assert.ok(h.db.state.recipients[0].identity_submitted_at);

      // A resubmission updates the same person instead of adding a second one.
      await h.call('moov-recipient-kyc-update', {
        token,
        business: { legal_name: 'Acme Roofing LLC', type: 'llc', ein: EIN, phone: '5125550199', website: 'acme.test', address: ADDRESS },
        representatives: [{ first_name: 'Rita', last_name: 'Roof', dob: DOB, ssn: SSN, address: ADDRESS, ownership_pct: 100, is_controller: true }],
      });
      assert.equal(h.moov.calls.filter((c) => c.method === 'POST' && /\/representatives$/.test(c.path)).length, 1);
      assert.equal(h.moov.calls.filter((c) => c.method === 'PATCH' && /\/representatives\//.test(c.path)).length, 1);
    });
    noSecretsIn('database parameters', h.db.state.params.join('\n'));
    noSecretsIn('logs', lines.join('\n'));
  });
});

test('Moov rejection of identity is reported by field name only (no values, no vendor name)', async () => {
  await withEnv(STAGING, async () => {
    const h = makeHarness();
    await h.call('moov-recipient-create', { tenant_id: TENANT, name: 'Hannah Owner', email: 'hannah@example.com' }, USERS.owner);
    const token = h.tokenFromEmail();
    const realFetch = h.deps.fetchImpl;
    h.deps.fetchImpl = async (url, init = {}) => {
      if ((init.method === 'PATCH') && String(init.body).includes('governmentID')) {
        return { ok: false, status: 422, text: async () => JSON.stringify({ error: `Moov: ssn ${SSN} invalid`, profile: { individual: { governmentID: 'invalid' } } }) };
      }
      return realFetch(url, init);
    };
    const { result: r, lines } = await captureConsole(() => h.call('moov-recipient-kyc-update', { token, ...INDIVIDUAL }));
    assert.equal(r.statusCode, 422);
    assert.equal(r.error, 'provider_rejected');
    assert.deepEqual(r.rejected_fields, ['profile.individual.governmentID']);
    assert.equal(/moov/i.test(`${r.error} ${r.message}`), false);
    noSecretsIn('response', JSON.stringify(r));
    noSecretsIn('logs', lines.join('\n'));
    assert.equal(h.db.state.recipients[0].identity_submitted_at, undefined);
  });
});

test('a payee left unverified after identity logs which Moov check is open: codes and field names only', async () => {
  await withEnv(STAGING, async () => {
    const h = makeHarness();
    const notVerified = (lines) => lines.map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((e) => e?.event === 'payee_not_verified');
    const lines = [];
    const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
    for (const k of Object.keys(orig)) console[k] = (...args) => lines.push(args.map(String).join(' '));
    try {
      const created = await h.call('moov-recipient-create', { tenant_id: TENANT, name: 'Hannah Owner', email: 'hannah@example.com' }, USERS.owner);
      const token = h.tokenFromEmail();
      const acct = h.moov.accounts.get(created.recipient.provider_account_id);
      assert.equal((await h.call('moov-recipient-session', { token })).ok, true);
      await h.call('moov-recipient-tos-accept', { token, accepted: true });
      assert.equal(notVerified(lines).length, 0, 'nothing logged before identity is submitted');

      await h.call('moov-recipient-kyc-update', { token, ...INDIVIDUAL });
      acct.due = [];
      await h.call('moov-recipient-bank-add', { token, ...BANK });
      await h.call('moov-recipient-bank-verify', { token, action: 'initiate' });
      await h.call('moov-recipient-bank-verify', { token, action: 'confirm', code: '1234' });

      // Transfers enabled and the bank verified, but identity still unverified.
      acct.capStatus = 'enabled';
      acct.verification = 'unverified';
      lines.length = 0;
      const stuck = await h.call('moov-recipient-session', { token });
      assert.equal(stuck.onboarding.complete, false);
      const [{ service, ...entry }] = notVerified(lines);
      assert.equal(service, 'checksops-api');
      assert.deepEqual(entry, {
        event: 'payee_not_verified',
        tenant: TENANT,
        environment: 'sandbox',
        stored_status: h.db.state.recipients[0].onboarding_status,
        verdict: null,
        capabilities_read: 'ok',
        banks_read: 'ok',
        transfers_status: 'enabled',
        identity_verification: 'unverified',
        terms_confirmed: true,
        bank_verified: true,
        steps: { terms: true, identity: true, bank: true },
        outstanding: [],
      });

      // A failed capabilities read is named by its code instead of passing silently.
      acct.capsFail = true;
      acct.due = ['individual.address'];
      lines.length = 0;
      await h.call('moov-recipient-session', { token });
      const [failedRead] = notVerified(lines);
      assert.equal(failedRead.capabilities_read, 'moov_auth_failed');
      assert.deepEqual(failedRead.outstanding, []);

      // Requirement field names are listed once the read works.
      acct.capsFail = false;
      lines.length = 0;
      await h.call('moov-recipient-session', { token });
      assert.deepEqual(notVerified(lines)[0].outstanding, ['individual.address']);

      // Verified: no further line.
      acct.due = [];
      acct.verification = 'verified';
      lines.length = 0;
      const done = await h.call('moov-recipient-session', { token });
      assert.equal(done.onboarding.complete, true, JSON.stringify(done));
      await h.call('moov-recipient-session', { token });
      assert.equal(notVerified(lines).length, 0);
      noSecretsIn('logs', lines.join('\n'), [token, acct.id, acct.banks[0].bankAccountID, 'Hannah', 'hannah@example.com']);
    } finally {
      Object.assign(console, orig);
    }
  });
});

test('Moov failure marks the payee failed; never verified', async () => {
  await withEnv(STAGING, async () => {
    const h = makeHarness();
    const created = await h.call('moov-recipient-create', { tenant_id: TENANT, name: 'Hannah Owner', email: 'hannah@example.com' }, USERS.owner);
    const token = h.tokenFromEmail();
    h.moov.accounts.get(created.recipient.provider_account_id).verification = 'failed';
    const s = await h.call('moov-recipient-session', { token });
    assert.equal(s.ok, true);
    assert.equal(h.db.state.stakeholders[0].verification_status, 'failed');
    assert.deepEqual(h.db.state.calls.filter((c) => c.sql === PAYEE_APPLY_STATUS_SQL).map((c) => c.params[2]), ['failed']);
  });
});

test('payeeVerdict: verified only with transfers enabled, nothing due, terms, the recorded bank verified', () => {
  const account = { termsOfService: { acceptedDate: 'x' }, profile: { individual: { verification: { status: 'verified' } } } };
  const caps = [{ capability: 'transfers', status: 'enabled', requirements: { currentlyDue: [] } }];
  const banks = [{ bankAccountID: 'bank-1', status: 'verified' }];
  const live = { account, capabilities: caps, capabilitiesReadOk: true, banks };
  assert.equal(payeeVerdict(live, { bankAccountId: 'bank-1' }).status, 'verified');
  assert.equal(payeeVerdict(live, { bankAccountId: 'bank-2' }).status, null);
  assert.equal(payeeVerdict({ ...live, capabilitiesReadOk: false }, { bankAccountId: 'bank-1' }).status, null);
  assert.equal(payeeVerdict({ ...live, capabilities: [{ ...caps[0], requirements: { currentlyDue: ['individual.ssn'] } }] }, { bankAccountId: 'bank-1' }).complete, false);
  assert.equal(payeeVerdict({ ...live, account: { ...account, termsOfService: undefined } }, { bankAccountId: 'bank-1' }).complete, false);
  assert.equal(payeeVerdict({ ...live, capabilities: [{ ...caps[0], status: 'pending' }] }, { bankAccountId: 'bank-1' }).status, 'pending_review');
  assert.equal(payeeVerdict({ ...live, account: { ...account, disabledOn: 'x' } }, { bankAccountId: 'bank-1' }).status, 'failed');
});

test('public links: malformed, unknown, expired and disconnected tokens are refused with clear codes', async () => {
  await withEnv(STAGING, async () => {
    const h = makeHarness();
    for (const name of PAYEE_PUBLIC_FUNCTION_NAMES) {
      const r = await h.call(name, { token: 'short' });
      assert.equal(r.statusCode, 404, name);
      assert.equal(r.error, 'link_invalid');
    }
    assert.equal(h.db.state.clients, 0, 'malformed tokens never reach the database');
    const unknown = await h.call('moov-recipient-session', { token: 'x'.repeat(43) });
    assert.equal(unknown.error, 'link_invalid');

    await h.call('moov-recipient-create', { tenant_id: TENANT, name: 'Hannah Owner', email: 'hannah@example.com' }, USERS.owner);
    const token = h.tokenFromEmail();
    h.db.state.recipients[0].token_expires_at = new Date(Date.now() - 1000).toISOString();
    const expired = await h.call('moov-recipient-kyc-update', { token, ...INDIVIDUAL });
    assert.equal(expired.statusCode, 410);
    assert.equal(expired.error, 'link_expired');
    assert.equal(h.moov.calls.some((c) => c.method === 'PATCH'), false);

    // Resend issues a new link; the old one stops working.
    const resent = await h.call('moov-recipient-link-resend', { tenant_id: TENANT, recipient_id: h.db.state.recipients[0].id }, USERS.owner);
    assert.equal(resent.ok, true, JSON.stringify(resent));
    assert.equal(resent.email_sent, true);
    const fresh = h.tokenFromEmail();
    assert.notEqual(fresh, token);
    assert.equal(JSON.stringify(resent).includes(fresh), false);
    assert.equal((await h.call('moov-recipient-session', { token })).error, 'link_invalid');
    assert.equal((await h.call('moov-recipient-session', { token: fresh })).ok, true);
    assert.equal((await h.call('moov-recipient-link-resend', { tenant_id: TENANT, recipient_id: h.db.state.recipients[0].id }, USERS.partner)).statusCode, 403);

    // Disconnect by stakeholder id only (Settings page body): DB first, then best-effort at Moov.
    h.db.state.recipients[0].secure_token = fresh;
    const acct = h.moov.accounts.get(h.db.state.recipients[0].provider_account_id);
    acct.banks.push({ bankAccountID: 'bank-9999-aaaa-bbbb', status: 'new' });
    const disc = await h.call('moov-recipient-disconnect', { stakeholder_account_id: h.db.state.stakeholders[0].id }, USERS.owner);
    assert.equal(disc.ok, true, JSON.stringify(disc));
    assert.equal(disc.provider.banks_disabled, 1);
    assert.equal(disc.provider.account_disconnected, true);
    assert.equal(h.db.state.stakeholders[0].is_active, false);
    assert.ok(h.moov.calls.some((c) => c.method === 'DELETE' && c.path === `/accounts/${acct.id}`));
    h.db.state.recipients[0].secure_token = fresh;
    const closed = await h.call('moov-recipient-session', { token: fresh });
    assert.equal(closed.statusCode, 410);
    assert.equal(closed.error, 'link_closed');
  });
});

test('disconnect still succeeds when Moov is down', async () => {
  await withEnv(STAGING, async () => {
    const h = makeHarness();
    const created = await h.call('moov-recipient-create', { tenant_id: TENANT, name: 'Hannah Owner', email: 'hannah@example.com' }, USERS.owner);
    h.deps.fetchImpl = async (url) => (String(url).endsWith('/oauth2/token')
      ? { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 't', expires_in: 300 }) }
      : { ok: false, status: 503, text: async () => '{}' });
    const r = await h.call('moov-recipient-disconnect', { tenant_id: TENANT, recipient_id: created.recipient_id }, USERS.owner);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.provider.account_disconnected, false);
    assert.ok(h.db.state.recipients[0].disconnected_at);
  });
});

test('a staging deployment never serves a production payee row (and the reverse)', async () => {
  await withEnv(STAGING, async () => {
    const h = makeHarness();
    await h.call('moov-recipient-create', { tenant_id: TENANT, name: 'Hannah Owner', email: 'hannah@example.com' }, USERS.owner);
    const token = h.tokenFromEmail();
    h.db.state.recipients[0].environment = 'production';
    const r = await h.call('moov-recipient-session', { token });
    assert.equal(r.error, 'payee_environment_mismatch');
    assert.equal(h.moov.calls.filter((c) => c.path.startsWith('/accounts/')).length, 0);
  });
});

test('payee-setup-link template names the payer, links /pay-setup and never names the provider', () => {
  const r = renderPayeeSetupEmail({
    payeeName: 'Hannah', payerName: 'Freedom Adjusting', setupUrl: 'https://staging.checksops.com/pay-setup/abc',
    branding: { primaryColor: '#123456', companySubtitle: 'Freedom Adjusting' },
  });
  assert.match(r.subject, /Freedom Adjusting/);
  assert.ok(r.html.includes('https://staging.checksops.com/pay-setup/abc'));
  assert.equal(/moov/i.test(r.html + r.text + r.subject), false);
  assert.ok(r.html.includes('#123456'));
  assert.ok(r.text.includes('https://staging.checksops.com/pay-setup/abc'));
});

test('an unsent setup email logs only its status and reason codes, never the address, name or link', async () => {
  await withEnv(STAGING, async () => {
    for (const result of [
      { status: 'blocked', reason: 'recipient_not_allowlisted' },
      { status: 'failed', reason: 'resend_403' },
      { status: 'failed', reason: 'contains https://x/pay-setup/abc' },
    ]) {
      const h = makeHarness();
      const sent = [];
      h.deps.sendEmail = async (msg) => { sent.push(msg); return { mode: 'resend', results: [result] }; };
      const { result: r, lines } = await captureConsole(() => h.call('moov-recipient-create', {
        tenant_id: TENANT, name: 'Hannah Owner', email: 'Hannah@Example.com', recipient_type: 'individual', relationship: 'subcontractor',
      }, USERS.owner));
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.email_sent, false);
      assert.equal(r.email_delivery, result.status);
      const logged = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter((e) => e?.event === 'payee_setup_email_not_sent');
      assert.equal(logged.length, 1, lines.join('\n'));
      const safeReason = /^[a-z0-9_]+$/.test(result.reason) ? result.reason : null;
      assert.deepEqual({ status: logged[0].status, reason: logged[0].reason }, { status: result.status, reason: safeReason });
      const token = sent[0].text.match(/\/pay-setup\/([A-Za-z0-9_-]+)/)[1];
      const all = lines.join('\n');
      for (const secret of [token, 'hannah@example.com', 'Hannah@Example.com', 'Hannah Owner']) {
        assert.ok(!all.includes(secret), `log carries ${secret}`);
      }
    }
  });
});
