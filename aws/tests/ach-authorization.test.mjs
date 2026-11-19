/**
 * save-ach-authorization: the ACH debit authorization for a funding account (ach_authorizations,
 * a SQL 136 money table). Owner report 2026-11-19: "Sign & Authorize ACH" failed with
 * writes_disabled because the card inserted the table from the browser. The server now writes it:
 * members only, the tenant's own funding account, the agreement text from the stored account, the
 * money-write flag before every write, idempotent authorize, revoke of the active row.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { SET_MONEY_WRITE_SQL } from '../functions/api/money-write-flag.mjs';
import {
  achAccountLastFour,
  achAuthorizationText,
  achRequestMeta,
  runSaveAchAuthorization,
} from '../functions/api/ach-authorization.mjs';
import { CLASS_A_FUNCTIONS } from '../functions/api/app-services.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const TENANT = '33333333-3333-4333-8333-333333333333';
const OTHER_TENANT = '55555555-5555-4555-8555-555555555555';
const USER = '44444444-4444-4444-8444-444444444444';
const ACCOUNT = '66666666-6666-4666-8666-666666666666';
const mapping = { application_user_id: USER };

const STAKEHOLDER = {
  id: ACCOUNT, tenant_id: TENANT, nickname: 'Operating', custname: 'Condition Co LLC', acct_type: 'C',
  chk_acct: null, chk_aba: null, verification_status: 'verified', is_active: true, provider: 'moov',
  provider_account_id: 'acct', provider_bank_account_id: 'bank', provider_last_four: '6051', origin: 'moov',
};

const fakeClient = ({ member = true, stakeholder = STAKEHOLDER, active = null } = {}) => {
  const queries = [];
  let row = active ? { ...active } : null;
  return {
    queries,
    get row() { return row; },
    query: async (sql, params = []) => {
      const text = String(sql);
      queries.push({ sql: text, params });
      if (text.includes('FROM public.tenant_users')) return { rows: member && params[0] === TENANT && params[1] === USER ? [{ role: 'member' }] : [] };
      if (text.includes('is_master_owner')) return { rows: [{ is_master: false }] };
      if (text.includes('FROM public.stakeholder_accounts')) {
        return { rows: stakeholder && params[0] === stakeholder.id && params[1] === stakeholder.tenant_id ? [stakeholder] : [] };
      }
      if (text.includes('FROM public.ach_authorizations')) return { rows: row && row.is_active ? [row] : [] };
      if (text.includes('INSERT INTO public.ach_authorizations')) {
        const [tenantId, accountId, name, by, ip, ua, formText] = params;
        row = {
          id: 'auth-1', tenant_id: tenantId, stakeholder_account_id: accountId, authorized_name: name,
          authorized_by: by, ip_address: ip, user_agent: ua, form_text: formText, is_active: true,
          created_at: '2026-11-19T20:00:00Z', revoked_at: null, revoked_by: null,
        };
        return { rows: [row] };
      }
      if (text.includes('UPDATE public.ach_authorizations')) {
        if (!row || !row.is_active) return { rows: [] };
        row = { ...row, is_active: false, revoked_at: 'now', revoked_by: params[2], revoke_reason: params[3] };
        return { rows: [row] };
      }
      return { rows: [] };
    },
  };
};

const call = (client, body, request = { sourceIp: '203.0.113.9', userAgent: 'Browser/1.0' }) => runSaveAchAuthorization({
  client, mapping, body: { tenant_id: TENANT, stakeholder_account_id: ACCOUNT, ...body }, spoof: [], request,
});

test('authorize writes one row with the money-write flag first, from the stored account, never the request', async () => {
  const client = fakeClient();
  const result = await call(client, {
    action: 'authorize', authorized_name: 'Someone Else', form_text: 'forged', authorized_by: OTHER_TENANT, is_active: false,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.account_last4, '6051');
  const insertAt = client.queries.findIndex((q) => q.sql.includes('INSERT INTO public.ach_authorizations'));
  const flagAt = client.queries.findIndex((q) => q.sql === SET_MONEY_WRITE_SQL);
  assert.ok(flagAt >= 0 && flagAt === insertAt - 1, 'the flag is set immediately before the insert');
  const [tenantId, accountId, name, by, ip, ua, formText] = client.queries[insertAt].params;
  assert.deepEqual([tenantId, accountId, name, by, ip, ua], [TENANT, ACCOUNT, 'Condition Co LLC', USER, '203.0.113.9', 'Browser/1.0']);
  assert.equal(formText, achAuthorizationText({ name: 'Condition Co LLC', lastFour: '6051' }));
  assert.match(formText, /account ending in 6051 for the purpose/);
  assert.equal(client.row.is_active, true);
});

test('authorize is idempotent: an active authorization is returned and nothing is written', async () => {
  const client = fakeClient({ active: { id: 'auth-0', tenant_id: TENANT, stakeholder_account_id: ACCOUNT, is_active: true } });
  const result = await call(client, { action: 'authorize' });
  assert.equal(result.ok, true);
  assert.equal(result.already_active, true);
  assert.equal(result.authorization.id, 'auth-0');
  assert.equal(client.queries.some((q) => q.sql.includes('INSERT') || q.sql === SET_MONEY_WRITE_SQL), false);
});

test('revoke deactivates the active row as the signed-in user, with the flag first; a second revoke writes nothing', async () => {
  const client = fakeClient({ active: { id: 'auth-0', tenant_id: TENANT, stakeholder_account_id: ACCOUNT, is_active: true } });
  const result = await call(client, { action: 'revoke', reason: 'Closed account', revoked_by: OTHER_TENANT });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.revoked, 1);
  const updateAt = client.queries.findIndex((q) => q.sql.includes('UPDATE public.ach_authorizations'));
  assert.equal(client.queries[updateAt - 1].sql, SET_MONEY_WRITE_SQL);
  assert.deepEqual(client.queries[updateAt].params, [TENANT, ACCOUNT, USER, 'Closed account']);
  assert.equal(client.row.is_active, false);

  const again = await call(client, { action: 'revoke' });
  assert.equal(again.ok, true);
  assert.equal(again.already_revoked, true);
  assert.equal(client.queries.filter((q) => q.sql.includes('UPDATE public.ach_authorizations')).length, 1);
});

test('get reads the active authorization and the text the user will sign, and writes nothing', async () => {
  const client = fakeClient();
  const result = await call(client, {});
  assert.equal(result.ok, true);
  assert.equal(result.authorization, null);
  assert.match(result.form_text, /^I, Condition Co LLC, authorize .* ending in 6051 /);
  assert.equal(client.queries.some((q) => /INSERT|UPDATE|set_config/.test(q.sql)), false);
});

test('non-members, other tenants’ accounts, bad input and inactive accounts are refused before any write', async () => {
  const outsider = fakeClient({ member: false });
  assert.equal((await call(outsider, { action: 'authorize' })).error, 'cross_tenant_denied');

  const foreign = fakeClient({ stakeholder: { ...STAKEHOLDER, tenant_id: OTHER_TENANT } });
  const notFound = await call(foreign, { action: 'authorize' });
  assert.equal(notFound.statusCode, 404);
  assert.equal(notFound.error, 'funding_source_not_found');

  const inactive = fakeClient({ stakeholder: { ...STAKEHOLDER, is_active: false } });
  assert.equal((await call(inactive, { action: 'authorize' })).error, 'account_inactive');

  assert.equal((await call(fakeClient(), { action: 'authorize', stakeholder_account_id: 'nope' })).error, 'missing_stakeholder_account');
  assert.equal((await call(fakeClient(), { action: 'delete' })).error, 'invalid_action');
  assert.equal((await runSaveAchAuthorization({ client: fakeClient(), mapping, body: {}, spoof: [] })).error, 'missing_tenant');

  for (const client of [outsider, foreign, inactive]) {
    assert.equal(client.queries.some((q) => /INSERT|UPDATE|set_config/.test(q.sql)), false);
  }
});

test('the last four come from the stored account number, else the provider, else the text says "on file"', () => {
  assert.equal(achAccountLastFour({ chk_acct: '0001234567', provider_last_four: '9999' }), '4567');
  assert.equal(achAccountLastFour({ chk_acct: null, provider_last_four: '6051' }), '6051');
  assert.equal(achAccountLastFour({ chk_acct: '', provider_last_four: '' }), null);
  assert.match(achAuthorizationText({ name: 'A', lastFour: null }), /from my account on file for the purpose/);
});

test('IP and user agent come from API Gateway, never the body', () => {
  assert.deepEqual(
    achRequestMeta({ requestContext: { http: { sourceIp: '198.51.100.1', userAgent: 'UA' } }, body: '{"ip_address":"1.1.1.1"}' }),
    { sourceIp: '198.51.100.1', userAgent: 'UA' },
  );
  assert.deepEqual(achRequestMeta({ headers: { 'User-Agent': 'H' } }), { sourceIp: null, userAgent: 'H' });
});

test('the route is served by app-services.mjs and the browser no longer writes the table', () => {
  assert.ok(CLASS_A_FUNCTIONS.has('save-ach-authorization'));
  const router = read('aws/functions/api/app-services.mjs');
  assert.match(router, /case 'save-ach-authorization':\n\s+return handleSaveAchAuthorization\(event\);/);
  const allowlist = read('aws/functions/api/write-allowlist.mjs');
  assert.equal(allowlist.includes('ach_authorizations'), false, 'the generic /data/write route still refuses the table');
});
