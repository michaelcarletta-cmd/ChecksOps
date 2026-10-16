import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  appOrigin,
  handleHomeownerLedgerUpload,
  runHomeownerLedgerSend,
  runSendFileToHomeowner,
  runSendPortalInvite,
} from '../functions/api/homeowner.mjs';

const TENANT = '11111111-1111-4111-8111-111111111111';
const CLAIM = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';
const FILE = '55555555-5555-4555-8555-555555555555';
const CHECK = '66666666-6666-4666-8666-666666666666';
const mapping = { application_user_id: USER };
const EVIL = 'https://evil.example';

const withEnv = async (vars, fn) => {
  const saved = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const STAGING_ENV = {
  CHECKSOPS_ENV: 'staging',
  VITE_APP_URL: undefined,
  SIGN_BASE_URL: 'https://staging.checksops.com',
  APP_PUBLIC_URL: undefined,
};
const PRODUCTION_ENV = {
  CHECKSOPS_ENV: 'production',
  VITE_APP_URL: undefined,
  SIGN_BASE_URL: 'https://checksops.com',
  APP_PUBLIC_URL: undefined,
};

const client = () => ({
  async query(sql) {
    const text = String(sql);
    if (text.includes('FROM public.tenant_users')) return { rows: [{ '?column?': 1 }] };
    if (text.includes('FROM public.claims c')) return { rows: [{ '?column?': 1 }] };
    if (text.includes('INSERT INTO public.homeowner_ledger_tokens')) return { rows: [{ id: 't1', token: 'tok' }] };
    if (text.includes('FROM public.check_files')) {
      return { rows: [{ id: FILE, check_id: CHECK, tenant_id: TENANT, file_path: 'p', file_name: 'f.pdf' }] };
    }
    if (text.includes('FROM public.check_intake_items')) return { rows: [{ claim_id: CLAIM }] };
    if (text.includes('FROM public.homeowner_ledger_tokens')) {
      return { rows: [{ token: 'tok', homeowner_email: 'home@example.com', homeowner_name: 'Home Owner' }] };
    }
    return { rows: [] };
  },
});

const mails = [];
const send = async (msg) => { mails.push(msg); return { ok: true }; };
const lastMail = () => mails[mails.length - 1];

test('appOrigin never reflects a non-ChecksOps origin', () => withEnv(STAGING_ENV, () => {
  for (const bad of [
    EVIL,
    'https://checksops.com.evil.example',
    'https://evil.example/?https://checksops.com',
    'http://checksops.com',
    'https://user:pw@checksops.com',
    'javascript:alert(1)',
    '//evil.example',
    'not a url',
  ]) {
    assert.equal(appOrigin(bad), 'https://staging.checksops.com', bad);
  }
}));

test('non-production accepts only the staging origin, without its path', () => withEnv(STAGING_ENV, () => {
  assert.equal(appOrigin('https://staging.checksops.com'), 'https://staging.checksops.com');
  assert.equal(appOrigin('https://staging.checksops.com/some/path'), 'https://staging.checksops.com');
  assert.equal(appOrigin('https://checksops.com'), 'https://staging.checksops.com');
  assert.equal(appOrigin('https://www.checksops.com/'), 'https://staging.checksops.com');
}));

test('production accepts checksops.com and www, never staging, else falls back to checksops.com', () => withEnv(PRODUCTION_ENV, () => {
  assert.equal(appOrigin(EVIL), 'https://checksops.com');
  assert.equal(appOrigin('https://staging.checksops.com'), 'https://checksops.com');
  assert.equal(appOrigin('https://www.checksops.com'), 'https://www.checksops.com');
  assert.equal(appOrigin('https://checksops.com/x'), 'https://checksops.com');
}));

test('production-prep uses the production list', () => withEnv({ ...PRODUCTION_ENV, CHECKSOPS_ENV: 'production-prep' }, () => {
  assert.equal(appOrigin('https://www.checksops.com'), 'https://www.checksops.com');
  assert.equal(appOrigin('https://staging.checksops.com'), 'https://checksops.com');
}));

test('the fallback is emailAssetOrigin: SIGN_BASE_URL wins as in the templates; production never staging', async () => {
  await withEnv({ ...STAGING_ENV, SIGN_BASE_URL: 'https://staging.checksops.com', VITE_APP_URL: undefined }, () => {
    assert.equal(appOrigin(undefined), 'https://staging.checksops.com');
  });
  await withEnv({ ...PRODUCTION_ENV, SIGN_BASE_URL: undefined, VITE_APP_URL: 'https://staging.checksops.com' }, () => {
    assert.equal(appOrigin(EVIL), 'https://checksops.com');
  });
});

test('the emailed and returned ledger link ignores a malicious origin', () => withEnv(PRODUCTION_ENV, async () => {
  const result = await runHomeownerLedgerSend({
    client: client(), mapping, spoof: {}, send,
    body: { homeowner_email: 'home@example.com', tenant_id: TENANT, claim_id: CLAIM, rotate: true, origin: EVIL },
  });
  assert.equal(result.ok, true);
  assert.equal(result.url, 'https://checksops.com/h/ledger/tok');
  assert.doesNotMatch(lastMail().html + lastMail().text, /evil\.example/);
  assert.match(lastMail().text, /https:\/\/checksops\.com\/h\/ledger\/tok/);
}));

test('the ledger link uses an allowed origin', () => withEnv(PRODUCTION_ENV, async () => {
  const result = await runHomeownerLedgerSend({
    client: client(), mapping, spoof: {}, send,
    body: {
      homeowner_email: 'home@example.com', tenant_id: TENANT, claim_id: CLAIM, rotate: true,
      origin: 'https://www.checksops.com',
    },
  });
  assert.equal(result.url, 'https://www.checksops.com/h/ledger/tok');
}));

test('the shared-document portal link ignores a malicious origin', () => withEnv(STAGING_ENV, async () => {
  const result = await runSendFileToHomeowner({
    client: client(), mapping, spoof: {}, send, body: { check_file_id: FILE, origin: EVIL },
  });
  assert.equal(result.ok, true);
  assert.equal(result.portal_url, 'https://staging.checksops.com/h/ledger/tok');
  assert.doesNotMatch(lastMail().html + lastMail().text, /evil\.example/);
}));

test('the portal invite login link ignores a malicious appUrl', () => withEnv(STAGING_ENV, async () => {
  await runSendPortalInvite({
    client: client(), mapping, spoof: {}, send, body: { email: 'user@example.com', appUrl: `${EVIL}/portal` },
  });
  assert.doesNotMatch(lastMail().html + lastMail().text, /evil\.example/);
  assert.match(lastMail().text, /https:\/\/staging\.checksops\.com\/login/);
}));

test('the unauthenticated upload alert ignores a request-supplied origin', () => withEnv(PRODUCTION_ENV, async () => {
  const STAFF = '77777777-7777-4777-8777-777777777777';
  const alerts = [];
  const db = {
    async query(sql) {
      const text = String(sql);
      if (text.includes('aws_public_homeowner_ledger_by_token')) {
        return { rows: [{ doc: { ok: true, token: { id: 't1', tenant_id: TENANT, claim_id: CLAIM } } }] };
      }
      if (text.includes('INSERT INTO public.homeowner_ledger_check_uploads')) {
        return { rows: [{ id: 'u1', front_path: 'p', status: 'uploaded', created_at: 'now' }] };
      }
      if (text.includes('FROM public.homeowner_ledger_tokens')) {
        return { rows: [{ id: 't1', tenant_id: TENANT, claim_id: CLAIM, sent_by_user_id: STAFF, homeowner_name: 'Ada', homeowner_email: 'home@example.com' }] };
      }
      if (text.includes('FROM public.profiles')) return { rows: [{ email: 'staff@checksops.com', full_name: 'Pat' }] };
      return { rows: [] };
    },
  };
  const result = await handleHomeownerLedgerUpload(
    { body: JSON.stringify({ token: 'ledger-token-1', front_base64: 'A'.repeat(200), origin: EVIL }) },
    { client: db, putObject: async () => ({}), sendViaSesOrSink: async (msg) => { alerts.push(msg); return { ok: true }; } },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.notified, true);
  assert.equal(alerts.length, 1);
  assert.doesNotMatch(alerts[0].html + alerts[0].text, /evil\.example/);
  assert.match(alerts[0].text, /https:\/\/checksops\.com\/checks/);
}));
