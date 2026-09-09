import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { handleDataQuery, relatedFk } from '../functions/api/data.mjs';
import { LOOKUP_MAPPING_SQL } from '../functions/api/identity.mjs';
import {
  REVIEW_QUEUE_SELECT,
  isInReviewQueue,
  reviewQueuePayeeReasons,
} from '../../src/lib/reviewQueueQuery.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const C1C = '4f172140-f57a-4744-8050-95f4f07b13b4';
const APP_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const SPOOF_ID = '00000000-0000-0000-0000-000000000099';
const LAMBDA_PAYLOAD_CAP = 6 * 1024 * 1024;
const COMFORTABLE_CAP = 1 * 1024 * 1024;

const jwtEvent = (pathName, method, body) => ({
  rawPath: pathName,
  headers: {
    authorization: 'Bearer test-id-token',
    'x-user-id': SPOOF_ID,
    'x-tenant-id': 'spoof-tenant',
    'x-role': 'admin',
  },
  queryStringParameters: { user_id: SPOOF_ID, tenant_id: 'spoof-tenant' },
  body: body ? JSON.stringify(body) : undefined,
  requestContext: {
    stage: 'staging',
    http: { method, path: pathName },
    authorizer: { jwt: { claims: { sub: COGNITO_SUB, email: 'checksops-tester@freedomadj.com', token_use: 'id' } } },
  },
});

const depsFor = (client) => ({
  loadDatabaseCredentials: async () => ({
    username: 'checksops',
    password: 'unit-test-only-not-a-real-secret',
    host: 'db.example.internal',
    database: 'checksops',
  }),
  createClient: () => client,
});

const fatPayee = (checkId, i) => ({
  id: `payee-${checkId}-${i}`,
  check_id: checkId,
  payee_name: i === 0 ? 'Insured Person' : 'Freedom Adjustment',
  payee_type: i === 0 ? 'insured' : 'public_adjuster',
  endorsement_status: i === 0 ? 'pending' : 'signed',
  contact_email: `payee${i}@example.com`,
  contact_phone: '555-0100',
  notification_sent_via: 'email',
  notification_sent_at: '2026-09-03T18:40:00.000Z',
  endorsed_at: i === 0 ? null : '2026-09-03T18:40:00.000Z',
  signature_image_url: `https://files.example/${checkId}/sig-${i}.png`,
  tenant_id: FREEDOM,
});

const catalog = () => {
  const deposited = {
    id: 'f62ce528-5566-4587-bf01-3d82d681b183',
    tenant_id: FREEDOM,
    check_number: '2000348108',
    check_stage: 'deposited',
    status: 'deposited',
    created_at: '2026-09-08T00:00:00.000Z',
    amount: 100,
    carrier_name: 'Carrier',
    payee_line: 'Deposited Payee',
    ocr_status: 'complete',
    funds_type: 'acv',
  };
  const endorsing = Array.from({ length: 24 }, (_, i) => ({
    id: `e0000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
    tenant_id: FREEDOM,
    check_number: `E${2000 + i}`,
    check_stage: 'endorsing',
    status: 'endorsements_in_progress',
    created_at: `2026-09-06T00:00:${String(i).padStart(2, '0')}.000Z`,
    amount: 1000 + i,
    carrier_name: 'Carrier',
    payee_line: 'Endorsing Payee',
    ocr_status: 'complete',
    funds_type: 'acv',
  }));
  const reviewRows = Array.from({ length: 30 }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
    tenant_id: FREEDOM,
    check_number: `R${1000 + i}`,
    check_stage: 'review',
    status: 'needs_review',
    created_at: `2026-09-07T00:00:${String(i).padStart(2, '0')}.000Z`,
    amount: 500 + i,
    carrier_name: 'Carrier',
    payee_line: 'Review Payee',
    ocr_status: i === 0 ? 'failed' : 'complete',
    ocr_needs_verification: i === 1,
    deposit_recommendation: i === 2 ? 'manual_review_required' : null,
    funds_type: 'acv',
    is_multi_payee: true,
  }));
  const other = Array.from({ length: 139 }, (_, i) => ({
    id: `a0000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
    tenant_id: FREEDOM,
    check_number: `A${3000 + i}`,
    check_stage: 'funds_released',
    status: 'released',
    created_at: `2026-09-05T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
    amount: 200,
    carrier_name: 'Carrier',
    payee_line: 'Released Payee',
    ocr_status: 'complete',
    funds_type: 'acv',
  }));
  return [deposited, ...endorsing, ...reviewRows, ...other];
};

test('Review list select is a slim projection without star or fat payee embeds', () => {
  assert.equal(REVIEW_QUEUE_SELECT.includes('*'), false);
  assert.equal(REVIEW_QUEUE_SELECT.includes('check_payees(*)'), false);
  assert.match(REVIEW_QUEUE_SELECT, /check_payees\(payee_name, payee_type, endorsement_status\)/);
  assert.match(REVIEW_QUEUE_SELECT, /\bcheck_stage\b/);
  assert.match(REVIEW_QUEUE_SELECT, /\bstatus\b/);
  assert.equal(REVIEW_QUEUE_SELECT.includes('raw_ocr_front'), false);
  assert.equal(REVIEW_QUEUE_SELECT.includes('endorsement_render_meta'), false);
  assert.equal(REVIEW_QUEUE_SELECT.includes('routing_number'), false);
  const consoleSrc = fs.readFileSync(path.join(ROOT, 'src/components/check-review/CheckReviewConsole.tsx'), 'utf8');
  assert.match(consoleSrc, /REVIEW_QUEUE_SELECT/);
  assert.equal((consoleSrc.match(/select\("\*, check_payees\(\*\)"\)/g) || []).length, 1);
  const ccc = fs.readFileSync(path.join(ROOT, 'src/pages/CheckCommandCenter.tsx'), 'utf8');
  assert.match(ccc, /check_payees\(payee_name, payee_type, endorsement_status\)/);
  assert.doesNotMatch(ccc, /from\("check_intake_items"\)[\s\S]{0,200}select\("\*, check_payees\(\*\)"\)/);
});

test('payee-dependent Review badges work from slim payee columns', () => {
  assert.deepEqual(reviewQueuePayeeReasons([
    { payee_name: 'Bank', payee_type: 'mortgage_company', endorsement_status: 'pending' },
  ]), ['Mortgage payee']);
  assert.deepEqual(reviewQueuePayeeReasons([
    { payee_name: 'A', payee_type: 'insured', endorsement_status: 'rejected' },
  ]), ['Rejected endorsement']);
  assert.deepEqual(reviewQueuePayeeReasons([
    { payee_name: 'A', payee_type: 'insured', endorsement_status: 'pending' },
    { payee_name: 'B', payee_type: 'public_adjuster', endorsement_status: 'pending' },
    { payee_name: 'C', payee_type: 'other', endorsement_status: 'pending' },
  ]), ['3+ payees', 'Unclear payee classification']);
  assert.deepEqual(reviewQueuePayeeReasons([]), []);
});

test('isInReviewQueue keeps Review filtering semantics', () => {
  assert.equal(isInReviewQueue({ check_stage: 'review', status: 'needs_review' }), true);
  assert.equal(isInReviewQueue({ check_stage: 'endorsing', status: 'endorsements_in_progress' }), false);
  assert.equal(isInReviewQueue({ check_stage: 'deposited', status: 'deposited' }), false);
  assert.equal(isInReviewQueue({ check_stage: 'funds_released', status: 'released' }), false);
  assert.equal(isInReviewQueue({ check_stage: null, status: 'needs_review' }), true);
  assert.equal(isInReviewQueue({ check_stage: 'ready', status: 'approved_for_deposit' }), false);
  assert.equal(isInReviewQueue({ check_stage: 'intake', ocr_status: 'failed', status: 'uploaded' }), true);
});

test('browser-equivalent slim Review query returns 200 with 30 qualifying checks under payload cap', async () => {
  const rows = catalog();
  assert.equal(rows.length, 194);
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
      if (sql.includes('count(*)')) return { rows: [{ n: rows.length }] };
      if (sql.includes('FROM public.check_intake_items')) {
        const limitN = Number((sql.match(/LIMIT (\d+)/) || [null, rows.length])[1]);
        return { rows: rows.slice(0, limitN) };
      }
      if (sql.includes('FROM public.check_payees')) {
        const payees = rows.flatMap((row) => [fatPayee(row.id, 0), fatPayee(row.id, 1)]);
        return {
          rows: payees.map((p) => ({
            payee_name: p.payee_name,
            payee_type: p.payee_type,
            endorsement_status: p.endorsement_status,
            check_id: p.check_id,
          })),
        };
      }
      return { rows: [] };
    },
    end: async () => {},
  };

  const result = await handleDataQuery(jwtEvent('/data/query', 'POST', {
    table: 'check_intake_items',
    select: REVIEW_QUEUE_SELECT,
    filters: [{ column: 'tenant_id', op: 'eq', value: FREEDOM }],
    order: { column: 'created_at', ascending: false },
  }), depsFor(client));

  assert.equal(result.ok, true);
  assert.equal(result.statusCode ?? 200, 200);
  assert.equal(result.error, undefined);
  const parentSelect = client.queries.find((q) => String(q.sql).includes('FROM public.check_intake_items') && !String(q.sql).includes('count(*)'));
  assert.equal(String(parentSelect.sql).includes('raw_ocr'), false);
  assert.match(String(parentSelect.sql), /check_stage/);
  const payeeSelect = client.queries.find((q) => String(q.sql).includes('FROM public.check_payees'));
  assert.match(String(payeeSelect.sql), /payee_name/);
  assert.equal(String(payeeSelect.sql).includes('signature_image_url'), false);
  assert.equal(String(payeeSelect.sql).includes('contact_email'), false);

  const review = result.data.filter(isInReviewQueue);
  assert.equal(review.length, 30);
  assert.equal(result.data.filter((row) => row.check_stage === 'endorsing').length, 24);
  const bytes = Buffer.byteLength(JSON.stringify(result.data));
  assert.equal(bytes < COMFORTABLE_CAP, true, `slim payload ${bytes} must stay under ${COMFORTABLE_CAP}`);
  assert.equal(bytes < LAMBDA_PAYLOAD_CAP, true);

  const fat = rows.map((row) => ({
    ...row,
    raw_ocr_front: 'x'.repeat(40_000),
    raw_ocr_back: 'y'.repeat(40_000),
    check_payees: [fatPayee(row.id, 0), fatPayee(row.id, 1), fatPayee(row.id, 2)],
  }));
  const fatBytes = Buffer.byteLength(JSON.stringify(fat));
  assert.equal(fatBytes > COMFORTABLE_CAP, true);
});

test('C1C slim Review query stays isolated from Freedom rows', async () => {
  const client = {
    queries: [],
    connect: async () => {},
    query: async (sql, params) => {
      client.queries.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
      if (sql === LOOKUP_MAPPING_SQL) {
        return { rows: [{
          application_user_id: 'fd857564-9534-4b0f-95ac-624ed1273725',
          cognito_sub: COGNITO_SUB,
          email: 'payments@condition1commercial.com',
          status: 'active',
        }] };
      }
      if (sql.includes('count(*)')) return { rows: [{ n: 0 }] };
      if (sql.includes('FROM public.check_intake_items')) {
        const haystack = `${sql} ${JSON.stringify(params || [])}`;
        assert.equal(haystack.includes(C1C), true);
        return { rows: [] };
      }
      return { rows: [] };
    },
    end: async () => {},
  };

  const result = await handleDataQuery(jwtEvent('/data/query', 'POST', {
    table: 'check_intake_items',
    select: REVIEW_QUEUE_SELECT,
    filters: [{ column: 'tenant_id', op: 'eq', value: C1C }],
    order: { column: 'created_at', ascending: false },
  }), depsFor(client));

  assert.equal(result.ok, true);
  assert.equal(result.data.length, 0);
  assert.equal(result.data.filter(isInReviewQueue).length, 0);
});

test('Funds Released embed still maps disbursement_batches to batch_id', () => {
  assert.equal(relatedFk('disbursement_splits', 'disbursement_batches'), 'batch_id');
  assert.equal(relatedFk('disbursement_splits', 'disbursement_batches') === 'disbursement_batch_id', false);
});
