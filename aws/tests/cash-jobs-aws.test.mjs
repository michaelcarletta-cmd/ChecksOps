/**
 * Cash Jobs on AWS work like claim checks (owner request, 2026-10-27):
 *   - the customer phone is entered and shown as XXX-XXX-XXXX;
 *   - a job saves on AWS (cash_jobs / cash_job_line_items reach /data/write);
 *   - a check uploaded from a job is created by POST /workflow/checks in Review,
 *     linked to the job server-side after a tenant check, exactly like the
 *     Command Center upload, which now also keeps the claim picked at upload.
 * Fixtures and source checks only; no database, no deploy.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { LOOKUP_MAPPING_SQL, TENANT_MEMBERSHIP_SQL, USER_ROLES_SQL } from '../functions/api/identity.mjs';
import {
  CASH_JOB_IN_TENANT_SQL,
  CLAIM_IN_TENANT_SQL,
  handleCreateCheck,
} from '../functions/api/workflow.mjs';
import { WRITE_ALLOWLIST, INTAKE_PROHIBITED_COLUMNS } from '../functions/api/write-allowlist.mjs';
import { formatPhoneForDisplay, formatPhoneNumber } from '../../src/lib/utils.ts';

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

const APP_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const TENANT_A = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const TENANT_B = '4f172140-f57a-4744-8050-95f4f07b13b4';
const JOB_A = '11111111-1111-4111-8111-111111111111';
const JOB_B = '22222222-2222-4222-8222-222222222222';
const CLAIM_A = '33333333-3333-4333-8333-333333333333';
const CLAIM_B = '44444444-4444-4444-8444-444444444444';
const CHECK_ID = '8d2b1c3e-4f5a-4678-9abc-def012345678';

const event = (body) => ({
  rawPath: '/workflow/checks',
  headers: { authorization: 'Bearer test-id-token' },
  body: JSON.stringify(body),
  requestContext: {
    stage: 'staging',
    http: { method: 'POST', path: '/workflow/checks' },
    authorizer: { jwt: { claims: { sub: COGNITO_SUB, email: 'tester@example.com', token_use: 'id' } } },
  },
});

// A fake database: the caller is a member of tenant A only; JOB_A / CLAIM_A
// belong to tenant A, JOB_B / CLAIM_B to tenant B.
const fakeClient = () => {
  const queries = [];
  const jobs = { [JOB_A]: { id: JOB_A, tenant_id: TENANT_A, job_name: 'Smith roof' }, [JOB_B]: { id: JOB_B, tenant_id: TENANT_B, job_name: 'Other' } };
  const claims = { [CLAIM_A]: TENANT_A, [CLAIM_B]: TENANT_B };
  return {
    queries,
    connect: async () => {},
    end: async () => {},
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (['BEGIN', 'ROLLBACK', 'COMMIT', 'SET TRANSACTION READ WRITE'].includes(sql)) return { rows: [] };
      if (sql.startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
      if (sql === LOOKUP_MAPPING_SQL) {
        return { rows: params[0] === COGNITO_SUB ? [{ application_user_id: APP_ID, cognito_sub: COGNITO_SUB, status: 'active' }] : [] };
      }
      if (sql === TENANT_MEMBERSHIP_SQL) {
        return { rows: [{ tenant_id: TENANT_A, role: 'admin', tenant_name: 'A', tenant_slug: 'a' }] };
      }
      if (sql === USER_ROLES_SQL) return { rows: [] };
      if (sql === CASH_JOB_IN_TENANT_SQL) {
        const job = jobs[params[0]];
        return { rows: job && job.tenant_id === params[1] ? [job] : [] };
      }
      if (sql === CLAIM_IN_TENANT_SQL) {
        return { rows: claims[params[0]] === params[1] ? [{ '?column?': 1 }] : [] };
      }
      if (/INSERT INTO public.check_intake_items/.test(sql)) {
        return { rows: [{ id: params[0], tenant_id: params[1], status: params[3], check_stage: params[4] }] };
      }
      if (/INSERT INTO public.check_audit_log/.test(sql)) return { rows: [{ id: 'audit' }] };
      return { rows: [] };
    },
  };
};

const deps = (client) => ({
  forceEnabled: true,
  forceWorkflow: true,
  loadDatabaseCredentials: async () => ({ username: 'checksops', password: 'unit-test-only', host: 'db.example.internal', database: 'checksops' }),
  createClient: () => client,
});

const insertOf = (client) => client.queries.find((q) => /INSERT INTO public.check_intake_items/.test(q.sql));

test('phone: the form formats as typed and the job shows XXX-XXX-XXXX, legacy values included', () => {
  assert.equal(formatPhoneNumber('5551234567'), '555-123-4567');
  assert.equal(formatPhoneNumber('555123'), '555-123');
  assert.equal(formatPhoneForDisplay('(555) 123-4567'), '555-123-4567');
  assert.equal(formatPhoneForDisplay('+1 555 123 4567'), '555-123-4567');
  assert.equal(formatPhoneForDisplay('555.123.4567'), '555-123-4567');
  assert.equal(formatPhoneForDisplay('ext 12'), 'ext 12');
  assert.equal(formatPhoneForDisplay(null), '');

  const form = read('src/components/cash-jobs/CashJobForm.tsx');
  assert.match(form, /customer_phone: formatPhoneNumber\(e\.target\.value\)/);
  assert.match(form, /customer_phone: formatPhoneForDisplay\(initialData\?\.customer_phone\)/);
  assert.match(form, /customer_phone: customerPhone/);
  const detail = read('src/components/cash-jobs/CashJobDetail.tsx');
  assert.match(detail, /\{formatPhoneForDisplay\(job\.customer_phone\)\}/);
  assert.doesNotMatch(detail, /\/>\{job\.customer_phone\}/);
});

test('jobs save on AWS: the client sends cash_jobs and cash_job_line_items to /data/write', () => {
  const source = read('src/integrations/aws/client.ts');
  const match = source.match(/const AWS_WRITE_TABLES = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(match);
  const tables = [...match[1].matchAll(/"([^"]+)"/g)].map((row) => row[1]);
  assert.ok(tables.includes('cash_jobs'));
  assert.ok(tables.includes('cash_job_line_items'));
  // Payments stay financial: the browser never writes them on AWS.
  assert.equal(tables.includes('cash_job_payments'), false);
  assert.equal(WRITE_ALLOWLIST.cash_job_payments, undefined);

  // The server allowlist covers every column the form sends.
  const formColumns = ['job_name', 'work_type', 'customer_name', 'customer_phone', 'customer_email',
    'property_address', 'property_city', 'property_state', 'property_zip', 'contract_amount',
    'estimate_date', 'start_date', 'completion_date', 'description', 'notes', 'tenant_id'];
  for (const column of formColumns) assert.ok(WRITE_ALLOWLIST.cash_jobs.columns.has(column), column);
  assert.ok(WRITE_ALLOWLIST.cash_jobs.clientIgnored.has('created_by'));
  for (const column of ['cash_job_id', 'tenant_id', 'description', 'quantity', 'unit_price', 'sort_order']) {
    assert.ok(WRITE_ALLOWLIST.cash_job_line_items.columns.has(column), column);
  }
  // /data/write takes one row per insert; the form inserts line items one at a time.
  const form = read('src/components/cash-jobs/CashJobForm.tsx');
  assert.match(form, /for \(const \[i, item\] of validItems\.entries\(\)\)/);
  assert.doesNotMatch(form, /insert\(\s*validItems\.map/);
  assert.match(form, /initialData\?\.cash_job_line_items/);
});

test('record payment on AWS: no browser write; the UI says the deposit records it', () => {
  const detail = read('src/components/cash-jobs/CashJobDetail.tsx');
  assert.match(detail, /const manualPayments = !isAwsStaging\(\);/);
  assert.match(detail, /\{manualPayments && \(\s*<Button[\s\S]*?Record payment/);
  assert.match(detail, /recorded automatically when the check is deposited/);
});

test('create check links a cash job of the caller tenant, server-side', async () => {
  const client = fakeClient();
  const result = await handleCreateCheck(event({
    tenant_id: TENANT_A,
    cash_job_id: JOB_A,
    cash_job_payment_class: 'final_payment',
    payee_line: 'Pat Smith',
    check_source: 'insurance',
    status: 'deposited',
  }), deps(client));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.cashJobId, JOB_A);
  assert.equal(result.cashJobName, 'Smith roof');
  assert.equal(result.imagePrefix, `checks/${result.data.id}/`);
  const insert = insertOf(client);
  assert.match(insert.sql, /cash_job_id, check_source, cash_job_payment_class/);
  assert.match(insert.sql, /'cash_job'/);
  assert.equal(insert.params[1], TENANT_A);
  assert.equal(insert.params[2], APP_ID);
  assert.equal(insert.params[3], 'uploaded');
  assert.equal(insert.params[4], 'review');
  assert.equal(insert.params[17], null); // claim_id
  assert.equal(insert.params[18], JOB_A);
  assert.equal(insert.params[19], 'final_payment');
  assert.equal(insert.params.includes('deposited'), false);
  assert.equal(insert.params.includes('insurance'), false);
  const audit = client.queries.find((q) => /INSERT INTO public.check_audit_log/.test(q.sql));
  assert.equal(JSON.parse(audit.params[3]).cash_job_id, JOB_A);
});

test('create check refuses a cash job or claim of another tenant, before any insert', async () => {
  for (const [body, error] of [
    [{ tenant_id: TENANT_A, cash_job_id: JOB_B }, 'cash_job_not_in_tenant'],
    [{ tenant_id: TENANT_B, cash_job_id: JOB_B }, 'cash_job_not_in_tenant'],
    [{ tenant_id: TENANT_A, claim_id: CLAIM_B }, 'claim_not_in_tenant'],
  ]) {
    const client = fakeClient();
    const result = await handleCreateCheck(event(body), deps(client));
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 403);
    assert.equal(result.error, error);
    assert.equal(insertOf(client), undefined);
  }
  for (const [body, field] of [
    [{ cash_job_id: 'not-a-uuid' }, 'cash_job_id'],
    [{ claim_id: 'not-a-uuid' }, 'claim_id'],
    [{ cash_job_id: JOB_A, cash_job_payment_class: 'refund' }, 'cash_job_payment_class'],
    [{ cash_job_payment_class: 'final_payment' }, 'cash_job_payment_class'],
    [{ cash_job_id: JOB_A, claim_id: CLAIM_A }, 'claim_id'],
  ]) {
    const client = fakeClient();
    const result = await handleCreateCheck(event({ tenant_id: TENANT_A, ...body }), deps(client));
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 400);
    assert.equal(result.field, field);
    assert.equal(insertOf(client), undefined);
  }
});

test('create check keeps a claim of the caller tenant; no link stays an ordinary check', async () => {
  const client = fakeClient();
  const result = await handleCreateCheck(event({ tenant_id: TENANT_A, claim_id: CLAIM_A }), deps(client));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.claimId, CLAIM_A);
  const insert = insertOf(client);
  assert.equal(insert.params[17], CLAIM_A);
  assert.doesNotMatch(insert.sql, /cash_job_id/);
  assert.doesNotMatch(insert.sql, /check_source/);

  const plain = fakeClient();
  const none = await handleCreateCheck(event({ tenant_id: TENANT_A }), deps(plain));
  assert.equal(none.ok, true);
  assert.equal(insertOf(plain).params[17], null);
  assert.equal(insertOf(plain).params.length, 18);
  assert.equal(plain.queries.some((q) => q.sql === CLAIM_IN_TENANT_SQL || q.sql === CASH_JOB_IN_TENANT_SQL), false);
});

test('cash-job columns stay closed on the generic write path', () => {
  for (const column of ['cash_job_id', 'check_source', 'cash_job_payment_class', 'claim_id']) {
    assert.ok(INTAKE_PROHIBITED_COLUMNS.has(column), column);
  }
});

test('upload from a job uses createAwsCheck and the check prefix, like the Command Center', () => {
  const upload = read('src/components/cash-jobs/CashJobCheckUpload.tsx');
  assert.match(upload, /const aws = isAwsStaging\(\);/);
  assert.match(upload, /const \{ createAwsCheck \} = await import\("@\/integrations\/aws\/workflow"\);/);
  assert.match(upload, /createAwsCheck\(token, \{[\s\S]*?tenant_id: tenant\.id,[\s\S]*?cash_job_id: cashJobId,[\s\S]*?cash_job_payment_class: paymentClass,/);
  assert.match(upload, /created\.imagePrefix/);
  assert.match(upload, /\.from\("check_intake_items"\)\s*\.update\(\{\s*front_image_path: frontPath,/);
  // The legacy (non-AWS) insert stays for the Supabase build only.
  const awsBranch = upload.slice(upload.indexOf('if (aws) {'), upload.indexOf('} else {', upload.indexOf('if (aws) {')));
  assert.doesNotMatch(awsBranch, /\.insert\(/);
  assert.doesNotMatch(awsBranch, /cash-jobs\//);

  const center = read('src/pages/CheckCommandCenter.tsx');
  assert.match(center, /createAwsCheck\(token, \{[\s\S]*?\.\.\.\(claimId \? \{ claim_id: claimId \} : \{\}\),/);
  assert.match(center, /<CashJobReviewLink cashJobId=\{check\.cash_job_id\} \/>/);
});
