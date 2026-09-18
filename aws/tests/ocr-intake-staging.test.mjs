import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleCheckOcrIntake, redactOcrIntakeResponse } from '../functions/api/ocr.mjs';
import { resetAzureDiSecretCache } from '../functions/api/azure-di-secret.mjs';
import { redactOcrLog, safeOcrLog } from '../functions/api/azure-check-ocr.mjs';
import { INTAKE_PROHIBITED_COLUMNS } from '../functions/api/write-allowlist.mjs';

const ROUTING_OK = '111000025';
const ACCOUNT = '000111222333';
const CHECK = '778899';
const PAYEE = 'Azure Only Payee LLC';
const ENDPOINT = 'https://di-test.example.test';
const KEY = 'test-azure-key-not-real';
const CHECK_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const RESULT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const field = (value, confidence = 0.2) => ({
  valueString: value,
  content: value,
  confidence,
});

const azureFetch = () => {
  const op = `${ENDPOINT}/documentintelligence/documentModels/prebuilt-check.us/analyzeResults/${RESULT}`;
  return async (url, init) => {
    if (init.method === 'POST') {
      return {
        status: 202,
        headers: { get: (n) => (String(n).toLowerCase() === 'operation-location' ? op : null) },
        text: async () => '',
      };
    }
    if (init.method === 'DELETE') {
      return { status: 204, headers: { get: () => null }, text: async () => '' };
    }
    return {
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({
        status: 'succeeded',
        analyzeResult: {
          documents: [{
            fields: {
              MICR: {
                valueObject: {
                  RoutingNumber: field(ROUTING_OK, 0),
                  AccountNumber: field(ACCOUNT, 0.008),
                  CheckNumber: field(CHECK, 0.168),
                },
              },
              PayTo: field(PAYEE),
              NumberAmount: { valueNumber: 99.12, confidence: 0.3 },
            },
          }],
        },
      }),
    };
  };
};

const textractSend = async () => ({
  Blocks: [
    {
      BlockType: 'LINE',
      Text: 'TEXTRACT CARRIER MUTUAL',
      Confidence: 96,
      Geometry: { BoundingBox: { Left: 0.1, Top: 0.05, Width: 0.4, Height: 0.03 } },
    },
    {
      BlockType: 'LINE',
      Text: 'PAY TO THE ORDER OF',
      Confidence: 95,
      Geometry: { BoundingBox: { Left: 0.08, Top: 0.28, Width: 0.3, Height: 0.03 } },
    },
    {
      BlockType: 'LINE',
      Text: 'Staging Uat Homeowner',
      Confidence: 93,
      Geometry: { BoundingBox: { Left: 0.10, Top: 0.32, Width: 0.4, Height: 0.03 } },
    },
    {
      BlockType: 'LINE',
      Text: `CHECK NO: ${CHECK}`,
      Confidence: 93,
      Geometry: { BoundingBox: { Left: 0.72, Top: 0.12, Width: 0.2, Height: 0.03 } },
    },
  ],
});

const runIntake = async ({ env, getSecretString, fetchImpl, logs = [] }) => {
  const persist = [];
  const client = {
    query: async (sql, params) => {
      persist.push({ sql: String(sql), params: params || [] });
      if (/FROM public\.check_intake_items WHERE id/.test(sql) && /front_image_path/.test(sql)) {
        return {
          rows: [{
            id: CHECK_ID,
            tenant_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
            front_image_path: `checks/${CHECK_ID}/front.png`,
            back_image_path: null,
            ocr_status: 'pending',
            raw_ocr_front: null,
            raw_ocr_back: null,
            carrier_name: null,
            check_number: null,
            payee_line: null,
            detected_claim_number: null,
            amount: null,
          }],
        };
      }
      return { rows: [] };
    },
  };
  const withIdentity = async (_event, fn) => fn({
    client,
    mapping: { application_user_id: '11111111-1111-1111-1111-111111111111' },
    body: { checkId: CHECK_ID },
    spoof: [],
  });
  const prevBucket = process.env.FILES_BUCKET;
  process.env.FILES_BUCKET = 'test-files-bucket';
  resetAzureDiSecretCache();
  try {
    const out = await handleCheckOcrIntake({ body: JSON.stringify({ checkId: CHECK_ID }) }, {
      withIdentity,
      ocr: {
        env,
        getSecretString,
        fetchImpl,
        textractSend,
        s3Send: async () => ({ Body: Buffer.from('png') }),
        sleep: async () => {},
        now: () => 0,
        log: (row) => logs.push(row),
      },
    });
    return { out, persist, logs };
  } finally {
    if (prevBucket == null) delete process.env.FILES_BUCKET;
    else process.env.FILES_BUCKET = prevBucket;
    resetAzureDiSecretCache();
  }
};

test('live staging path uses real secret loader and redacts banking fields', async () => {
  let secretLoads = 0;
  const { out, persist, logs } = await runIntake({
    env: { CHECKSOPS_ENV: 'staging' },
    getSecretString: async (id) => {
      secretLoads += 1;
      assert.equal(id, 'checksops/staging/providers/azure-document-intelligence');
      return JSON.stringify({ api_key: KEY, endpoint: ENDPOINT });
    },
    fetchImpl: azureFetch(),
  });
  assert.equal(secretLoads, 1);
  assert.equal(handleCheckOcrIntake.__azureDeps, undefined);
  assert.equal(out.success, true);
  assert.equal(out.ocr_success, true);
  assert.equal(out.micr_engine, 'azure_prebuilt_check_us');
  assert.equal(out.micr_routing_state, 'VERIFIED');
  assert.equal(out.micr_account_state, 'VERIFIED');
  assert.equal(out.micr_check_state, 'VERIFIED');
  assert.equal(out.aba_valid, true);
  assert.equal(out.azure_delete_confirmed, true);
  assert.equal(out.azure_error, null);
  assert.ok(out.descriptive);
  assert.equal(typeof out.descriptive.printed_check_number.present, 'boolean');
  assert.equal('parsed' in out, false);
  assert.equal('routing_number' in out, false);
  assert.equal('account_number' in out, false);
  assert.equal('micr_check_number' in out, false);
  assert.equal('payees' in out, false);
  const blob = JSON.stringify({ out, logs });
  assert.ok(!blob.includes(ROUTING_OK));
  assert.ok(!blob.includes(ACCOUNT));
  assert.ok(!blob.includes(CHECK));
  assert.ok(!blob.includes(KEY));
  assert.ok(!blob.includes(ENDPOINT));
  assert.ok(!blob.includes(PAYEE));
  assert.ok(!blob.includes(RESULT));

  const update = persist.find((row) => /UPDATE public\.check_intake_items SET/.test(row.sql) && /carrier_name/.test(row.sql));
  assert.ok(update);
  assert.equal(update.params.length, 4);
  assert.equal(update.sql.includes('routing_number'), false);
  assert.equal(update.sql.includes('account_number'), false);
  assert.equal(update.sql.includes('amount'), false);
  const persistBlob = JSON.stringify(update);
  assert.ok(!persistBlob.includes(ROUTING_OK));
  assert.ok(!persistBlob.includes(ACCOUNT));
});

test('Azure VERIFIED MICR stays internal and DELETE is boolean only', async () => {
  const { out } = await runIntake({
    env: { CHECKSOPS_ENV: 'staging' },
    getSecretString: async () => JSON.stringify({ api_key: KEY, endpoint: ENDPOINT }),
    fetchImpl: azureFetch(),
  });
  assert.equal(out.micr_routing_state, 'VERIFIED');
  assert.equal(out.micr_account_state, 'VERIFIED');
  assert.equal(out.micr_check_state, 'VERIFIED');
  assert.equal(typeof out.azure_delete_confirmed, 'boolean');
  assert.equal(out.azure_delete_confirmed, true);
  assert.equal('resultId' in out, false);
  assert.equal('Operation-Location' in out, false);
  assert.equal('operationLocation' in out, false);
  assert.equal('raw' in out, false);
  const blob = JSON.stringify(out);
  assert.ok(!blob.includes(ROUTING_OK));
  assert.ok(!blob.includes(ACCOUNT));
  assert.ok(!blob.includes(CHECK));
});

test('intake DELETE 429 then 204 propagates azure_delete_confirmed', async () => {
  let deletes = 0;
  const fetchImpl = async (url, init) => {
    if (init.method === 'DELETE') {
      deletes += 1;
      if (deletes === 1) {
        return { status: 429, headers: { get: () => '0' }, text: async () => '' };
      }
      return { status: 204, headers: { get: () => null }, text: async () => '' };
    }
    return azureFetch()(url, init);
  };
  const logs = [];
  const { out } = await runIntake({
    env: { CHECKSOPS_ENV: 'staging' },
    getSecretString: async () => JSON.stringify({ api_key: KEY, endpoint: ENDPOINT }),
    fetchImpl,
    logs,
  });
  assert.equal(out.ocr_success, true);
  assert.equal(out.azure_delete_confirmed, true);
  assert.equal(deletes, 2);
  assert.equal('resultId' in out, false);
  const blob = JSON.stringify({ out, logs });
  assert.ok(!blob.includes(KEY));
  assert.ok(!blob.includes(ENDPOINT));
  assert.ok(!blob.includes(ROUTING_OK));
  assert.ok(!blob.includes(ACCOUNT));
  assert.ok(!blob.includes(RESULT));
});

test('intake DELETE 429 exhaustion keeps OCR success and hides identifiers', async () => {
  let deletes = 0;
  const fetchImpl = async (url, init) => {
    if (init.method === 'DELETE') {
      deletes += 1;
      return {
        status: 429,
        headers: { get: () => '0' },
        text: async () => JSON.stringify({ api_key: KEY, routing_number: ROUTING_OK }),
      };
    }
    return azureFetch()(url, init);
  };
  const logs = [];
  const { out } = await runIntake({
    env: { CHECKSOPS_ENV: 'staging' },
    getSecretString: async () => JSON.stringify({ api_key: KEY, endpoint: ENDPOINT }),
    fetchImpl,
    logs,
  });
  assert.equal(out.ocr_success, true);
  assert.equal(out.azure_delete_confirmed, false);
  assert.equal(out.micr_routing_state, 'VERIFIED');
  assert.equal(deletes, 3);
  const blob = JSON.stringify({ out, logs });
  assert.ok(!blob.includes(KEY));
  assert.ok(!blob.includes(ENDPOINT));
  assert.ok(!blob.includes(ROUTING_OK));
  assert.ok(!blob.includes(ACCOUNT));
  assert.ok(!blob.includes(RESULT));
});

test('production path does not call Azure or Secrets Manager', async () => {
  let secretLoads = 0;
  let fetches = 0;
  const { out } = await runIntake({
    env: { CHECKSOPS_ENV: 'production' },
    getSecretString: async () => {
      secretLoads += 1;
      return JSON.stringify({ api_key: KEY, endpoint: ENDPOINT });
    },
    fetchImpl: async () => {
      fetches += 1;
      return { status: 500, headers: { get: () => null }, text: async () => '' };
    },
  });
  assert.equal(secretLoads, 0);
  assert.equal(fetches, 0);
  assert.equal(out.micr_engine, 'none');
  assert.equal(out.azure_error, null);
  assert.equal(out.azure_delete_confirmed, false);
  assert.equal(out.ocr_success, true);
});

test('response redaction strips banking fields while keeping states', () => {
  const out = redactOcrIntakeResponse({
    parsed: {
      routing_number: ROUTING_OK,
      account_number: ACCOUNT,
      micr_check_number: CHECK,
      payee_line: PAYEE,
      payees: [{ name: PAYEE }],
      amount: '99.12',
      check_number: CHECK,
      carrier_name: 'Textract Carrier Mutual',
      descriptive_engine: 'aws_textract_analyze',
      micr_engine: 'azure_prebuilt_check_us',
      micr_routing_state: 'VERIFIED',
      micr_account_state: 'VERIFIED',
      micr_check_state: 'VERIFIED',
      needs_manual_review: false,
      filled_from_azure: ['payee_line'],
      descriptive_sources: {
        payee_line: 'azure_prebuilt_check_us',
        check_number: 'aws_textract_analyze',
        amount: 'azure_prebuilt_check_us',
      },
    },
    eligibility: { recommendation: 'proceed' },
    azureRan: true,
    azureError: null,
    azureDeleteConfirmed: true,
  });
  assert.equal(out.micr_routing_state, 'VERIFIED');
  assert.equal(out.aba_valid, true);
  assert.equal(out.azure_delete_confirmed, true);
  assert.equal(out.descriptive.amount.present, true);
  assert.equal(out.descriptive.amount.source, 'azure_prebuilt_check_us');
  assert.equal(out.descriptive.payee_line.present, true);
  assert.ok(!('value' in out.descriptive.amount));
  const blob = JSON.stringify(out);
  assert.ok(!blob.includes(ROUTING_OK));
  assert.ok(!blob.includes(ACCOUNT));
  assert.ok(!blob.includes(CHECK));
  assert.ok(!blob.includes(PAYEE));
  assert.ok(!blob.includes('99.12'));
});

test('descriptive persistence allowlist and prohibited MICR columns stay unchanged', () => {
  assert.equal(INTAKE_PROHIBITED_COLUMNS.has('routing_number'), true);
  assert.equal(INTAKE_PROHIBITED_COLUMNS.has('account_number'), true);
  assert.equal(INTAKE_PROHIBITED_COLUMNS.has('amount'), true);
  assert.equal(INTAKE_PROHIBITED_COLUMNS.has('detected_claim_number'), true);
});

test('logs contain no key, endpoint, MICR, account, or routing', () => {
  const logs = [];
  safeOcrLog((row) => logs.push(row), {
    event: 'azure_analyze',
    ok: true,
    code: 'ok',
    api_key: KEY,
    endpoint: ENDPOINT,
    routing_number: ROUTING_OK,
    account_number: ACCOUNT,
    micr_check_number: CHECK,
  });
  const redacted = redactOcrLog({
    routing_number: ROUTING_OK,
    account_number: ACCOUNT,
    api_key: KEY,
  });
  const blob = JSON.stringify({ logs, redacted });
  assert.ok(!blob.includes(KEY));
  assert.ok(!blob.includes(ENDPOINT));
  assert.ok(!blob.includes(ROUTING_OK));
  assert.ok(!blob.includes(ACCOUNT));
  assert.ok(!blob.includes(CHECK));
  assert.equal(redacted.routing_number, '[redacted]');
});
