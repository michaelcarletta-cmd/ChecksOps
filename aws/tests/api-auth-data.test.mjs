import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { handler } from '../functions/api/index.mjs';
import {
  applyFilters,
  applyEmbedFilters,
  belongsToEmbed,
  childFk,
  classifyDataQueryFailure,
  fkColumnFromHint,
  handleDataQuery,
  handleDataRpc,
  logDataQueryFailure,
  parseOrExpr,
  parseSelect,
  embedColumnSql,
  embedRelationTable,
  relatedFk,
  resolvePageLimit,
  resolvePageOffset,
  resolvePublicTable,
  splitEmbedFilters,
} from '../functions/api/data.mjs';
import { LOOKUP_MAPPING_SQL } from '../functions/api/identity.mjs';
import {
  handleAuthForgot,
  handleAuthLogin,
} from '../functions/api/auth-cognito.mjs';

const APP_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const SPOOF_ID = '00000000-0000-0000-0000-000000000099';

const jwtEvent = (path, method, body, extra = {}) => ({
  rawPath: path,
  headers: {
    authorization: 'Bearer test-id-token',
    'x-user-id': SPOOF_ID,
    'x-tenant-id': 'spoof-tenant',
    'x-role': 'admin',
    ...(extra.headers || {}),
  },
  queryStringParameters: { user_id: SPOOF_ID, tenant_id: 'spoof-tenant', ...(extra.query || {}) },
  body: body ? JSON.stringify(body) : undefined,
  requestContext: {
    stage: 'staging',
    http: { method, path },
    authorizer: { jwt: { claims: { sub: COGNITO_SUB, email: 'checksops-tester@freedomadj.com', token_use: 'id' } } },
  },
});

const mockClient = ({ rows = [], mapping = {
  application_user_id: APP_ID,
  cognito_sub: COGNITO_SUB,
  email: 'checksops-tester@freedomadj.com',
  status: 'active',
} } = {}) => {
  const queries = [];
  return {
    queries,
    connect: async () => {},
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
      if (sql === LOOKUP_MAPPING_SQL) {
        return { rows: params[0] === mapping.cognito_sub ? [mapping] : [] };
      }
      if (sql.includes('count(*)')) return { rows: [{ n: rows.length }] };
      return { rows };
    },
    end: async () => {},
  };
};

const depsFor = (client) => ({
  loadDatabaseCredentials: async () => ({
    username: 'checksops',
    password: 'unit-test-only-not-a-real-secret',
    host: 'db.example.internal',
    database: 'checksops',
  }),
  createClient: () => client,
});

test('parseSelect extracts inner tenant embeds used by login redirect', () => {
  const parsed = parseSelect('tenant_id, tenants!inner(slug, subscription_status)');
  assert.deepEqual(parsed.columns, ['tenant_id']);
  assert.equal(parsed.embeds[0].table, 'tenants');
  assert.equal(parsed.embeds[0].inner, true);
  assert.equal(parsed.embeds[0].fkHint, null);
});

test('parseSelect supports named FK hints and aliases used by partners/shared checks', () => {
  const shared = parseSelect('check_id, source_tenant_id, tenants!shared_checks_source_tenant_id_fkey(name)');
  assert.equal(shared.embeds[0].table, 'tenants');
  assert.equal(shared.embeds[0].fkHint, 'shared_checks_source_tenant_id_fkey');
  assert.equal(shared.embeds[0].inner, false);
  assert.equal(fkColumnFromHint('shared_checks', shared.embeds[0].fkHint), 'source_tenant_id');
  assert.equal(relatedFk('shared_checks', 'tenants', 'source_tenant_id'), 'source_tenant_id');
  assert.equal(relatedFk('disbursement_splits', 'disbursement_batches'), 'batch_id');
  assert.equal(relatedFk('deposit_items', 'deposit_batches'), 'batch_id');

  const partners = parseSelect(
    '*, inviter:tenants!tenant_partnerships_inviter_tenant_id_fkey(name), invitee:tenants!tenant_partnerships_invitee_tenant_id_fkey(name)',
  );
  assert.equal(partners.embeds[0].alias, 'inviter');
  assert.equal(partners.embeds[0].table, 'tenants');
  assert.equal(fkColumnFromHint('tenant_partnerships', partners.embeds[0].fkHint), 'inviter_tenant_id');
  assert.equal(partners.embeds[1].alias, 'invitee');
  assert.equal(fkColumnFromHint('tenant_partnerships', partners.embeds[1].fkHint), 'invitee_tenant_id');
  assert.equal(embedRelationTable('tenants', partners.embeds[0].columns), 'tenants_public');
  assert.equal(embedRelationTable('tenants', ['name']), 'tenants_public');
  assert.equal(embedRelationTable('tenants', ['*']), 'tenants');
  assert.equal(embedRelationTable('tenants_public', ['name']), 'tenants_public');
});

const FUNDS_RELEASED_SELECT = `
          id, amount, settled_at, recipient_name, method, external_check_number,
          stakeholder_accounts (nickname, custname),
          disbursement_batches (
            id, check_intake_item_id,
            check_intake_items:check_intake_item_id (
              check_number, carrier_name, property_address, funds_type, amount,
              claim_id, detected_claim_number, payee_line,
              claims:claim_id ( claim_number, policyholder_name )
            )
          )
        `;

test('parseSelect keeps compact nested embeds and bang-inner hints', () => {
  const parsed = parseSelect(
    'id,tenants!inner(slug),disbursement_batches(id,check_intake_items:check_intake_item_id(check_number,claims:claim_id(claim_number)))',
  );
  assert.deepEqual(parsed.columns, ['id']);
  assert.equal(parsed.embeds[0].table, 'tenants');
  assert.equal(parsed.embeds[0].inner, true);
  assert.equal(parsed.embeds[1].table, 'disbursement_batches');
  assert.equal(parsed.embeds[1].embeds[0].table, 'check_intake_items');
  assert.equal(parsed.embeds[1].embeds[0].fkHint, 'check_intake_item_id');
  assert.equal(parsed.embeds[1].embeds[0].embeds[0].table, 'claims');
  assert.equal(parsed.embeds[1].embeds[0].embeds[0].fkHint, 'claim_id');
  assert.deepEqual(parsed.embeds[1].embeds[0].embeds[0].columns, ['claim_number']);
});

test('parseSelect accepts whitespace before nested embed parens and aliased FK embeds', () => {
  const parsed = parseSelect(FUNDS_RELEASED_SELECT);
  assert.deepEqual(parsed.columns, [
    'id', 'amount', 'settled_at', 'recipient_name', 'method', 'external_check_number',
  ]);
  assert.equal(parsed.embeds[0].table, 'stakeholder_accounts');
  assert.deepEqual(parsed.embeds[0].columns, ['nickname', 'custname']);
  const batches = parsed.embeds[1];
  assert.equal(batches.table, 'disbursement_batches');
  assert.deepEqual(batches.columns, ['id', 'check_intake_item_id']);
  const items = batches.embeds[0];
  assert.equal(items.table, 'check_intake_items');
  assert.equal(items.fkHint, 'check_intake_item_id');
  assert.equal(items.alias, null);
  assert.equal(items.columns.includes('check_number'), true);
  assert.equal(items.columns.includes('claim_id'), true);
  const claims = items.embeds[0];
  assert.equal(claims.table, 'claims');
  assert.equal(claims.fkHint, 'claim_id');
  assert.deepEqual(claims.columns, ['claim_number', 'policyholder_name']);
});

test('parseSelect still rejects leftover malformed identifiers as invalid column', () => {
  assert.throws(() => parseSelect('id, not a column'), /invalid column/);
  assert.throws(() => parseSelect('id, disbursement_batches (id), 1bad'), /invalid column/);
  assert.throws(() => parseSelect('id, foo-bar'), /invalid column/);
});

test('has-many star embeds do not pass * through ident', () => {
  const parsed = parseSelect('*, check_payees(*), checkalt_deposits(id, status, last_status_payload)');
  assert.equal(parsed.columns[0], '*');
  assert.equal(parsed.embeds[0].table, 'check_payees');
  assert.deepEqual(parsed.embeds[0].columns, ['*']);
  assert.equal(embedColumnSql(parsed.embeds[0].columns), '*');
  assert.equal(embedColumnSql(parsed.embeds[1].columns), 'id, status, last_status_payload');
});

test('resolvePageLimit treats null/omitted/zero as default 200, not LIMIT 1', () => {
  assert.equal(resolvePageLimit(undefined), 200);
  assert.equal(resolvePageLimit(null), 200);
  assert.equal(resolvePageLimit(''), 200);
  assert.equal(resolvePageLimit(0), 200);
  assert.equal(resolvePageLimit(-4), 200);
  assert.equal(resolvePageLimit(Number.NaN), 200);
  assert.equal(resolvePageLimit(1), 1);
  assert.equal(resolvePageLimit(200), 200);
  assert.equal(resolvePageLimit(500), 500);
  assert.equal(resolvePageLimit(2000), 500);
  assert.equal(resolvePageOffset(null), 0);
  assert.equal(resolvePageOffset(undefined), 0);
  assert.equal(resolvePageOffset(25), 25);
});

test('AWS client omits null limit and offset from the query body', () => {
  const src = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/integrations/aws/client.ts'),
    'utf8',
  );
  assert.match(src, /export function compactSelectPaging/);
  assert.match(src, /\.\.\.compactSelectPaging\(state\.limit, state\.offset\)/);
  assert.match(src, /if \(limit !== null && limit !== undefined\) paging\.limit = limit/);
  assert.match(src, /if \(offset !== null && offset !== undefined\) paging\.offset = offset/);
  assert.equal(src.includes('limit: state.limit,\n        offset: state.offset,'), false);
});

test('review browser-equivalent null limit selects default 200 rows, not LIMIT 1', async () => {
  const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
  const deposited = {
    id: 'f62ce528-5566-4587-bf01-3d82d681b183',
    check_number: '2000348108',
    check_stage: 'deposited',
    status: 'deposited',
    tenant_id: FREEDOM,
    created_at: '2026-09-08T00:00:00.000Z',
  };
  const reviewRows = Array.from({ length: 30 }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
    check_number: `R${1000 + i}`,
    check_stage: 'review',
    status: 'needs_review',
    tenant_id: FREEDOM,
    created_at: `2026-09-07T00:00:${String(i).padStart(2, '0')}.000Z`,
  }));
  const catalog = [deposited, ...reviewRows];
  const isInReviewQueue = (check) => {
    const stage = check.check_stage;
    const s = check.status;
    if (['loss_draft', 'reissue', 'branch', 'deposited', 'endorsing'].includes(stage)) return false;
    if (['loss_draft_required', 'reissue_requested', 'branch_deposit_required', 'deposited', 'endorsements_in_progress', 'approved_for_deposit'].includes(s)) return false;
    return stage === 'review' || ['needs_review', 'in_review', 'ocr_complete', 'manual_review_required', 'endorsements_complete', 'uploaded'].includes(s);
  };

  const run = async (limit) => {
    const client = {
      queries: [],
      connect: async () => {},
      query: async (sql, params) => {
        client.queries.push({ sql, params });
        if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
        if (sql.startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
        if (sql === LOOKUP_MAPPING_SQL) {
          return { rows: [{
            application_user_id: APP_ID,
            cognito_sub: COGNITO_SUB,
            email: 'checksops-tester@freedomadj.com',
            status: 'active',
          }] };
        }
        if (sql.includes('FROM public.check_intake_items') && sql.includes('LIMIT')) {
          const limitN = Number((sql.match(/LIMIT (\d+)/) || [])[1]);
          return { rows: catalog.slice(0, limitN) };
        }
        return { rows: [] };
      },
      end: async () => {},
    };
    const body = {
      table: 'check_intake_items',
      select: '*, check_payees(*)',
      filters: [{ column: 'tenant_id', op: 'eq', value: FREEDOM }],
      order: { column: 'created_at', ascending: false },
    };
    if (limit !== undefined) body.limit = limit;
    const result = await handleDataQuery(jwtEvent('/data/query', 'POST', body), depsFor(client));
    const selectSql = client.queries.find((q) => String(q.sql).includes('FROM public.check_intake_items') && String(q.sql).includes('LIMIT'))?.sql || '';
    return { result, selectSql };
  };

  const omitted = await run(undefined);
  assert.equal(omitted.result.ok, true);
  assert.match(omitted.selectSql, /LIMIT 200/);
  assert.equal(omitted.result.data.length, 31);
  assert.equal(omitted.result.data.filter(isInReviewQueue).length, 30);

  const nulled = await run(null);
  assert.equal(nulled.result.ok, true);
  assert.match(nulled.selectSql, /LIMIT 200/);
  assert.doesNotMatch(nulled.selectSql, /LIMIT 1\b/);
  assert.equal(nulled.result.data.length, 31);
  assert.equal(nulled.result.data.filter(isInReviewQueue).length, 30);
  assert.equal(nulled.result.data.some((row) => row.check_number === '2000348108'), true);

  const explicitOne = await run(1);
  assert.match(explicitOne.selectSql, /LIMIT 1/);
  assert.equal(explicitOne.result.data.length, 1);
  assert.equal(explicitOne.result.data[0].check_number, '2000348108');
  assert.equal(explicitOne.result.data.filter(isInReviewQueue).length, 0);

  const explicit200 = await run(200);
  assert.match(explicit200.selectSql, /LIMIT 200/);
  assert.equal(explicit200.result.data.filter(isInReviewQueue).length, 30);
});

test('or parser supports PostgREST login/search expressions', () => {
  const params = [];
  const sql = parseOrExpr('check_stage.is.null,check_stage.neq.deposited', params);
  assert.match(sql, /IS NULL/);
  assert.match(sql, /<>/);
  assert.equal(params.includes('deposited'), true);
});

test('not-in and eq filters compile without interpolating identifiers from input ops only', () => {
  const { clauses, params } = applyFilters([
    { column: 'user_id', op: 'eq', value: APP_ID },
    { column: 'status', op: 'not', notOp: 'in', value: '(revoked,completed)' },
  ]);
  assert.equal(clauses[0], 'user_id = $1');
  assert.match(clauses[1], /NOT IN/);
  assert.equal(params[0], APP_ID);
});

test('POST /data/query maps Cognito sub to application UUID and ignores spoofed ids', async () => {
  const client = mockClient({
    rows: [{ id: 'role-1', role: 'staff', user_id: APP_ID }],
  });
  const result = await handleDataQuery(jwtEvent('/data/query', 'POST', {
    table: 'user_roles',
    select: 'role',
    filters: [{ column: 'user_id', op: 'eq', value: SPOOF_ID }],
    user_id: SPOOF_ID,
    tenant_id: 'spoof-tenant',
    role: 'admin',
  }), depsFor(client));
  assert.equal(result.ok, true);
  assert.equal(result.applicationUserId, APP_ID);
  assert.equal(result.cognitoSub, COGNITO_SUB);
  assert.notEqual(result.applicationUserId, result.cognitoSub);
  assert.equal(result.spoofFieldsIgnored.headerUserId, SPOOF_ID);
  assert.equal(result.spoofFieldsIgnored.bodyUserId, SPOOF_ID);
  const guc = client.queries.find((q) => String(q.sql).includes('set_config') && q.params?.[1] === APP_ID);
  assert.ok(guc, 'request.app_user_id must be the mapped ChecksOps UUID');
  assert.equal(client.queries.some((q) => q.params?.[1] === SPOOF_ID && String(q.sql).includes('set_config')), false);
});

test('unauthenticated tenants_public reads are allowed; other tables are not', async () => {
  const client = mockClient({ rows: [{ id: 't1', slug: 'freedom', subscription_status: 'active' }] });
  const publicEvent = {
    rawPath: '/data/query',
    requestContext: { stage: 'staging', http: { method: 'POST', path: '/data/query' } },
    body: JSON.stringify({ table: 'tenants_public', select: '*', filters: [{ column: 'slug', op: 'eq', value: 'freedom' }], maybeSingle: true }),
  };
  const allowed = await handleDataQuery(publicEvent, depsFor(client));
  assert.equal(allowed.ok, true);
  assert.equal(allowed.data.slug, 'freedom');

  const denied = await handleDataQuery({
    ...publicEvent,
    body: JSON.stringify({ table: 'claims', select: '*', op: 'select' }),
  }, depsFor(client));
  assert.equal(denied.statusCode, 401);
});

test('mutating data operations and write RPCs stay disabled', async () => {
  const client = mockClient();
  const write = await handleDataQuery(jwtEvent('/data/query', 'POST', {
    table: 'claims',
    op: 'insert',
    payload: { id: 'x' },
  }), depsFor(client));
  assert.equal(write.statusCode, 403);
  assert.equal(write.error, 'writes_disabled');

  const rpc = await handleDataRpc(jwtEvent('/data/rpc', 'POST', {
    name: 'moov_disburse',
    args: {},
  }), depsFor(client));
  assert.equal(rpc.statusCode, 403);
  assert.equal(rpc.error, 'rpc_disabled');
});

test('handler CORS preflight and storage/function stubs', async () => {
  const options = await handler({
    rawPath: '/data/query',
    requestContext: { stage: 'staging', http: { method: 'OPTIONS', path: '/data/query' } },
  });
  assert.equal(options.statusCode, 204);
  assert.equal(options.headers['access-control-allow-origin'], '*');

  const storage = await handler({
    rawPath: '/storage/sign',
    requestContext: { stage: 'staging', http: { method: 'GET', path: '/storage/sign' } },
  });
  assert.equal(storage.statusCode, 403);
  assert.equal(JSON.parse(storage.body).error, 'uploads_disabled');

  const fn = await handler({
    rawPath: '/functions/invoke',
    requestContext: { stage: 'staging', http: { method: 'POST', path: '/functions/invoke' } },
    body: JSON.stringify({ name: 'moov-disburse' }),
  });
  assert.equal(fn.statusCode, 403);
  assert.equal(JSON.parse(fn.body).error, 'provider_disabled');
});

test('forgot-password is Tester mailbox only and does not call Cognito for C1C', async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, text: async () => '{}' };
  };
  try {
    const suppressed = await handleAuthForgot({
      body: JSON.stringify({ email: 'payments@condition1commercial.com' }),
      requestContext: { http: { method: 'POST' } },
    });
    assert.equal(suppressed.suppressed, true);
    assert.equal(suppressed.sent, false);
    assert.equal(calls.length, 0);

    const tester = await handleAuthForgot({
      body: JSON.stringify({ email: 'checksops-tester@freedomadj.com' }),
      requestContext: { http: { method: 'POST' } },
    });
    assert.equal(tester.sent, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0].init.headers['x-amz-target'], /ForgotPassword/);
    assert.equal(String(calls[0].init.body).includes('Password'), false);
  } finally {
    globalThis.fetch = original;
  }
});

test('check queue has-many embeds do not select nonexistent parent FKs', async () => {
  assert.equal(belongsToEmbed('check_intake_items', 'check_payees'), false);
  assert.equal(belongsToEmbed('check_intake_items', 'checkalt_deposits'), false);
  assert.equal(belongsToEmbed('check_intake_items', 'tenants'), true);
  assert.equal(relatedFk('check_intake_items', 'check_payees'), 'check_payee_id');
  assert.equal(childFk('check_intake_items', 'check_payees'), 'check_id');
  assert.equal(childFk('check_intake_items', 'checkalt_deposits'), 'check_intake_item_id');

  const parentId = '7dbb3009-f059-4767-b5dc-1c5c72379330';
  const client = {
    queries: [],
    connect: async () => {},
    query: async (sql, params) => {
      client.queries.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
      if (sql === LOOKUP_MAPPING_SQL) {
        return { rows: params[0] === COGNITO_SUB ? [{
          application_user_id: APP_ID,
          cognito_sub: COGNITO_SUB,
          email: 'checksops-tester@freedomadj.com',
          status: 'active',
        }] : [] };
      }
      if (sql.includes('count(*)')) return { rows: [{ n: 1 }] };
      if (sql.includes('FROM public.check_intake_items')) {
        return { rows: [{
          id: parentId,
          check_number: '0044343937',
          front_image_path: 'checks/7dbb3009-f059-4767-b5dc-1c5c72379330/unclaimed/front.jpg',
          endorsement_packet_path: 'packets/93fa0063-3a1c-4f47-b679-26357b3ac163/packet.svg',
        }] };
      }
      if (sql.includes('FROM public.check_payees')) {
        return { rows: [{
          payee_name: 'Freedom Insured',
          payee_type: 'insured',
          endorsement_status: 'pending',
          check_id: parentId,
        }] };
      }
      if (sql.includes('FROM public.checkalt_deposits')) {
        return { rows: [] };
      }
      return { rows: [] };
    },
    end: async () => {},
  };

  const result = await handleDataQuery(jwtEvent('/data/query', 'POST', {
    table: 'check_intake_items',
    select: 'id, check_number, front_image_path, endorsement_packet_path, check_payees(payee_name, payee_type, endorsement_status), checkalt_deposits(id, status)',
    filters: [{ column: 'tenant_id', op: 'eq', value: '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a' }],
    limit: 2000,
  }), depsFor(client));

  assert.equal(result.ok, true);
  const parentSelect = client.queries.find((q) => String(q.sql).includes('FROM public.check_intake_items') && !String(q.sql).includes('count(*)'));
  assert.ok(parentSelect, 'parent SELECT must run');
  assert.equal(String(parentSelect.sql).includes('check_payee_id'), false);
  assert.equal(String(parentSelect.sql).includes('checkalt_deposit_id'), false);
  const payeeSelect = client.queries.find((q) => String(q.sql).includes('FROM public.check_payees'));
  assert.match(String(payeeSelect.sql), /check_id/);
  assert.equal(String(payeeSelect.sql).includes('check_intake_item_id'), false);
  assert.equal(Array.isArray(result.data[0].check_payees), true);
  assert.equal(result.data[0].check_payees[0].payee_name, 'Freedom Insured');
  assert.deepEqual(result.data[0].checkalt_deposits, []);
});

test('funds-released nested select returns 200 instead of invalid-column 503', async () => {
  const splitId = '11111111-1111-4111-8111-111111111111';
  const accountId = '22222222-2222-4222-8222-222222222222';
  const batchId = '33333333-3333-4333-8333-333333333333';
  const itemId = '44444444-4444-4444-8444-444444444444';
  const claimId = '55555555-5555-4555-8555-555555555555';
  const client = {
    queries: [],
    connect: async () => {},
    query: async (sql, params) => {
      client.queries.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
      if (sql === LOOKUP_MAPPING_SQL) {
        return { rows: params[0] === COGNITO_SUB ? [{
          application_user_id: APP_ID,
          cognito_sub: COGNITO_SUB,
          email: 'checksops-tester@freedomadj.com',
          status: 'active',
        }] : [] };
      }
      if (sql.includes('count(*)')) return { rows: [{ n: 1 }] };
      if (sql.includes('FROM public.disbursement_splits')) {
        return { rows: [{
          id: splitId,
          amount: 100,
          settled_at: '2026-09-01T00:00:00Z',
          recipient_name: 'Freedom Adjustment',
          method: 'ach',
          external_check_number: '271682',
          stakeholder_account_id: accountId,
          batch_id: batchId,
        }] };
      }
      if (sql.includes('FROM public.stakeholder_accounts')) {
        return { rows: [{ id: accountId, nickname: 'Operating', custname: 'Freedom' }] };
      }
      if (sql.includes('FROM public.disbursement_batches')) {
        return { rows: [{ id: batchId, check_intake_item_id: itemId }] };
      }
      if (sql.includes('FROM public.check_intake_items')) {
        return { rows: [{
          id: itemId,
          check_number: '271682',
          carrier_name: 'Test Carrier',
          property_address: '1 Main St',
          funds_type: 'acv',
          amount: 100,
          claim_id: claimId,
          detected_claim_number: '38-99V2-97X',
          payee_line: 'Freedom Adjustment',
        }] };
      }
      if (sql.includes('FROM public.claims')) {
        return { rows: [{ id: claimId, claim_number: '38-99V2-97X', policyholder_name: 'Anissa Nassry' }] };
      }
      return { rows: [] };
    },
    end: async () => {},
  };

  const result = await handleDataQuery(jwtEvent('/data/query', 'POST', {
    table: 'disbursement_splits',
    select: FUNDS_RELEASED_SELECT,
    filters: [
      { column: 'tenant_id', op: 'eq', value: '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a' },
      { column: 'status', op: 'eq', value: 'settled' },
    ],
    order: { column: 'settled_at', ascending: false },
    limit: 100,
  }), depsFor(client));

  assert.equal(result.ok, true);
  assert.equal(result.statusCode, 200);
  assert.equal(result.error, undefined);
  const parentSelect = client.queries.find((q) => String(q.sql).includes('FROM public.disbursement_splits') && !String(q.sql).includes('count(*)'));
  assert.match(String(parentSelect.sql), /stakeholder_account_id/);
  assert.match(String(parentSelect.sql), /batch_id/);
  assert.equal(String(parentSelect.sql).includes('disbursement_batch_id'), false);
  assert.equal(String(parentSelect.sql).includes('not a col'), false);
  assert.equal(result.data[0].stakeholder_accounts.nickname, 'Operating');
  assert.equal(result.data[0].disbursement_batches.check_intake_items.check_number, '271682');
  assert.equal(result.data[0].disbursement_batches.check_intake_items.claims.claim_number, '38-99V2-97X');
});

test('classifyDataQueryFailure logs shape only and redacts secrets, SQL URLs, and emails', () => {
  const classified = classifyDataQueryFailure(
    new Error('invalid column password=supersecret token=abc123 postgres://user:pass@db/checksops for checksops-tester@freedomadj.com'),
    {
      table: 'disbursement_splits',
      select: FUNDS_RELEASED_SELECT.replace('settled_at', 'settled_at, 2eff5f1a-929d-4ce3-9a8b-cd96b98df42a'),
      filters: [{ column: 'contact_email', op: 'eq', value: 'owner@example.com' }],
    },
  );
  assert.equal(classified.errorClass, 'invalid_column');
  assert.equal(classified.table, 'disbursement_splits');
  assert.match(classified.selectShape, /disbursement_batches/);
  assert.match(classified.selectShape, /\[id\]/);
  assert.equal(classified.selectShape.includes('2eff5f1a-929d-4ce3-9a8b-cd96b98df42a'), false);
  assert.equal(classified.message.includes('supersecret'), false);
  assert.equal(classified.message.includes('abc123'), false);
  assert.equal(classified.message.includes('postgres://'), false);
  assert.equal(classified.message.includes('checksops-tester@freedomadj.com'), false);
  assert.equal(classified.message.includes('owner@example.com'), false);
  assert.equal(JSON.stringify(classified).includes('password='), false);

  const logs = [];
  const original = console.error;
  console.error = (...args) => logs.push(args.join(' '));
  try {
    logDataQueryFailure(new Error('invalid column Bearer eyJhbGciOiJIUzI1NiJ9.payload'), {
      table: 'disbursement_splits; drop table checks',
      select: FUNDS_RELEASED_SELECT,
    });
  } finally {
    console.error = original;
  }
  assert.equal(logs.length, 1);
  const payload = JSON.parse(logs[0]);
  assert.equal(payload.event, 'data_query_failed');
  assert.equal(payload.table, '[rejected]');
  assert.equal(payload.errorClass, 'invalid_column');
  assert.equal(logs[0].includes('eyJhbGciOiJIUzI1NiJ9'), false);
  assert.equal(logs[0].includes('DROP TABLE'), false);
  assert.equal(logs[0].includes('contact_email'), false);
});

test('login challenge is returned without treating Cognito sub as the application UUID', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      ChallengeName: 'NEW_PASSWORD_REQUIRED',
      Session: 'challenge-session',
    }),
  });
  try {
    const result = await handleAuthLogin({
      body: JSON.stringify({ email: 'checksops-tester@freedomadj.com', password: 'unused-in-test' }),
    });
    assert.equal(result.challenge, 'NEW_PASSWORD_REQUIRED');
    assert.equal(result.session, 'challenge-session');
    assert.equal(result.authentication, undefined);
  } finally {
    globalThis.fetch = original;
  }
});

test('Bank Deposits embed is belongs-to via check_intake_item_id, not checkalt_deposit_id', () => {
  assert.equal(belongsToEmbed('checkalt_deposits', 'check_intake_items'), true);
  assert.equal(relatedFk('checkalt_deposits', 'check_intake_items'), 'check_intake_item_id');
  assert.equal(childFk('checkalt_deposits', 'check_intake_items'), 'checkalt_deposit_id');
});

test('Deposit Ops tenant filter uses deposit_items.check_id → check_intake_items.id', () => {
  assert.equal(belongsToEmbed('deposit_items', 'check_intake_items'), true);
  assert.equal(relatedFk('deposit_items', 'check_intake_items'), 'check_id');
  const { parent, embed } = splitEmbedFilters([
    { column: 'check_intake_items.tenant_id', op: 'eq', value: '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a' },
  ]);
  assert.deepEqual(parent, []);
  assert.equal(embed[0].embedTable, 'check_intake_items');
  assert.equal(embed[0].embedColumn, 'tenant_id');
  const params = [];
  const clauses = applyEmbedFilters('deposit_items', embed, params);
  assert.match(clauses[0], /EXISTS/);
  assert.match(clauses[0], /check_intake_items\.id = deposit_items\.check_id/);
  assert.match(clauses[0], /tenant_id = \$1/);
  assert.equal(params[0], '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a');
});

test('secret config tables rewrite to public-column views', () => {
  assert.equal(resolvePublicTable('checkalt_config'), 'checkalt_config_public');
  assert.equal(resolvePublicTable('deposit_provider_config'), 'deposit_provider_config_public');
  assert.equal(resolvePublicTable('tenants_public'), 'tenants_public');
});

const OWNER_ID = '7dbb3009-f059-4767-b5dc-1c5c72379330';
const FREEDOM_ID = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const LOGIN_SELECT = 'tenant_id, tenants!inner(slug, subscription_status)';
const C1C_ID = '4f172140-f57a-4744-8050-95f4f07b13b4';

const embedQueryClient = (onQuery) => {
  const queries = [];
  return {
    queries,
    connect: async () => {},
    end: async () => {},
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
      if (sql === LOOKUP_MAPPING_SQL) {
        return {
          rows: params[0] === COGNITO_SUB ? [{
            application_user_id: OWNER_ID,
            cognito_sub: COGNITO_SUB,
            email: 'mcarletta@freedomadj.com',
            status: 'active',
          }] : [],
        };
      }
      if (sql.includes('count(*)')) return { rows: [{ n: 1 }] };
      return onQuery(sql, params);
    },
  };
};

const loginFilter = (rows) => (rows ?? []).filter((m) => m.tenants?.subscription_status === 'active' && m.tenants?.slug);

test('login tenant_users embed queries tenants_public but returns tenants', async () => {
  const parsed = parseSelect(LOGIN_SELECT);
  assert.equal(parsed.embeds[0].table, 'tenants');
  assert.equal(parsed.embeds[0].alias, null);
  assert.equal(embedRelationTable(parsed.embeds[0].table, parsed.embeds[0].columns), 'tenants_public');

  const client = embedQueryClient((sql) => {
    if (/FROM public\.tenants(?:\s|$)/.test(sql) && !sql.includes('tenants_public')) {
      throw new Error('base tenants must not be queried for public-column login embed');
    }
    if (sql.includes('FROM public.tenant_users')) {
      return { rows: [{ tenant_id: FREEDOM_ID, user_id: OWNER_ID }] };
    }
    if (sql.includes('FROM public.tenants_public')) {
      return { rows: [{ id: FREEDOM_ID, slug: 'freedom', subscription_status: 'active' }] };
    }
    return { rows: [] };
  });

  const result = await handleDataQuery(jwtEvent('/data/query', 'POST', {
    table: 'tenant_users',
    select: LOGIN_SELECT,
    filters: [{ column: 'user_id', op: 'eq', value: OWNER_ID }],
  }), depsFor(client));

  assert.equal(result.ok, true, result.message || result.error);
  const embedSql = client.queries.find((q) => String(q.sql).includes('FROM public.tenants_public'));
  assert.ok(embedSql, 'login embed must SELECT tenants_public internally');
  assert.match(String(embedSql.sql), /FROM public\.tenants_public/);
  assert.equal(client.queries.some((q) => /FROM public\.tenants(?:\s|$)/.test(q.sql) && !String(q.sql).includes('tenants_public')), false);
  assert.equal(result.data[0].tenants_public, undefined);
  assert.equal(result.data[0].tenants?.slug, 'freedom');
  assert.equal(result.data[0].tenants?.subscription_status, 'active');

  const memberships = loginFilter(result.data);
  assert.equal(memberships.length, 1);
  assert.equal(memberships[0].tenants.slug, 'freedom');

  const loginSrc = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/pages/checkops/CheckOpsLogin.tsx'), 'utf8');
  assert.match(loginSrc, /tenants!inner\(slug, subscription_status\)/);
  assert.match(loginSrc, /m\.tenants\?\.subscription_status === "active"/);
  assert.equal(loginSrc.includes('tenants_public'), false);
});

test('aliased partner tenant embeds keep inviter/invitee keys while querying tenants_public', async () => {
  const client = embedQueryClient((sql) => {
    if (/FROM public\.tenants(?:\s|$)/.test(sql) && !sql.includes('tenants_public')) {
      throw new Error('base tenants must not be queried for partner name embeds');
    }
    if (sql.includes('FROM public.tenant_partnerships')) {
      return { rows: [{
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        inviter_tenant_id: FREEDOM_ID,
        invitee_tenant_id: C1C_ID,
        status: 'accepted',
      }] };
    }
    if (sql.includes('FROM public.tenants_public')) {
      return { rows: [
        { id: FREEDOM_ID, name: 'Freedom Adjustment' },
        { id: C1C_ID, name: 'Condition 1 Commercial' },
      ] };
    }
    return { rows: [] };
  });

  const result = await handleDataQuery(jwtEvent('/data/query', 'POST', {
    table: 'tenant_partnerships',
    select: 'id, inviter:tenants!tenant_partnerships_inviter_tenant_id_fkey(name), invitee:tenants!tenant_partnerships_invitee_tenant_id_fkey(name)',
  }), depsFor(client));

  assert.equal(result.ok, true, result.message || result.error);
  const publicSelects = client.queries.filter((q) => String(q.sql).includes('FROM public.tenants_public'));
  assert.equal(publicSelects.length >= 1, true);
  assert.equal(result.data[0].tenants_public, undefined);
  assert.equal(result.data[0].tenants, undefined);
  assert.equal(result.data[0].inviter?.name, 'Freedom Adjustment');
  assert.equal(result.data[0].invitee?.name, 'Condition 1 Commercial');
});
