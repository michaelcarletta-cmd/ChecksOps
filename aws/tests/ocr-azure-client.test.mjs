import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AZURE_CHECK_API_VERSION,
  AZURE_CHECK_MODEL,
  AZURE_DI_SECRET_NAME_TEMPLATE,
  analyzeAzureCheck,
  deleteAzureAnalyzeResult,
  parseAzureDiSecret,
  redactOcrLog,
  safeOcrLog,
  validateOperationLocation,
} from '../functions/api/azure-check-ocr.mjs';

const ENDPOINT = 'https://di-test.example.test';
const API_KEY = 'test-azure-key-not-real';
const RESULT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OP_LOC = `${ENDPOINT}/documentintelligence/documentModels/${AZURE_CHECK_MODEL}/analyzeResults/${RESULT_ID}?api-version=${AZURE_CHECK_API_VERSION}`;
const ROUTING_OK = '111000025';
const ACCOUNT = '000111222333';
const CHECK = '778899';
const PAYEE = 'Staging Uat Homeowner';

const headers = (map = {}) => ({
  get: (name) => {
    const key = Object.keys(map).find((k) => k.toLowerCase() === String(name).toLowerCase());
    return key ? map[key] : null;
  },
});

const res = (status, body, hdrs = {}) => ({
  status,
  headers: headers(hdrs),
  text: async () => (body == null ? '' : (typeof body === 'string' ? body : JSON.stringify(body))),
});

const secretLoader = async () => ({ endpoint: ENDPOINT, api_key: API_KEY });

const succeededBody = (doc = { fields: { MICR: { valueObject: {} } } }) => ({
  status: 'succeeded',
  analyzeResult: { documents: [doc] },
});

const captureLog = () => {
  const entries = [];
  return {
    entries,
    log: (row) => entries.push(row),
    blob: () => JSON.stringify(entries),
  };
};

const assertNoSecrets = (blob) => {
  assert.ok(!blob.includes(API_KEY), 'api key leaked');
  assert.ok(!blob.includes(ROUTING_OK), 'routing leaked');
  assert.ok(!blob.includes(ACCOUNT), 'account leaked');
  assert.ok(!blob.includes(CHECK), 'micr check leaked');
  assert.ok(!blob.includes(PAYEE), 'payee leaked');
  assert.ok(!blob.includes(OP_LOC), 'operation-location leaked');
  assert.ok(!blob.includes(RESULT_ID), 'result id leaked');
  assert.ok(!blob.includes(Buffer.from('iVBORw0KGgoaaa').toString('base64')), 'base64 payload leaked');
  assert.ok(!/iVBORw0KGgo/.test(blob), 'image bytes leaked');
};

test('secret interface has expected name and shape (no hardcoded endpoint)', () => {
  assert.equal(
    AZURE_DI_SECRET_NAME_TEMPLATE,
    'checksops/{environment}/providers/azure-document-intelligence',
  );
  const parsed = parseAzureDiSecret({ endpoint: ENDPOINT, api_key: API_KEY });
  assert.equal(parsed.endpoint, ENDPOINT);
  assert.equal(parsed.host, 'di-test.example.test');
  assert.equal(parseAzureDiSecret({ endpoint: 'http://insecure.example', api_key: API_KEY }), null);
  assert.ok(!String(analyzeAzureCheck).includes('cognitiveservices.azure.com'));
});

test('existing isolated secret schema { api_key, endpoint } is recognized', () => {
  const fromObject = parseAzureDiSecret({ api_key: API_KEY, endpoint: ENDPOINT });
  assert.equal(fromObject.endpoint, ENDPOINT);
  assert.equal(fromObject.host, 'di-test.example.test');
  assert.ok(fromObject.apiKey);

  const fromJson = parseAzureDiSecret(JSON.stringify({ api_key: API_KEY, endpoint: ENDPOINT }));
  assert.equal(fromJson.endpoint, ENDPOINT);
  assert.equal(fromJson.host, fromObject.host);

  const doubleEncoded = parseAzureDiSecret(JSON.stringify(JSON.stringify({ api_key: API_KEY, endpoint: ENDPOINT })));
  assert.equal(doubleEncoded.endpoint, ENDPOINT);

  const alreadyParsed = parseAzureDiSecret({ apiKey: API_KEY, endpoint: ENDPOINT });
  assert.equal(alreadyParsed.endpoint, ENDPOINT);

  // HEAD rejected host-only endpoints (`new URL('host')` throws → azure_not_configured).
  const hostOnly = parseAzureDiSecret({ api_key: API_KEY, endpoint: 'di-test.example.test' });
  assert.equal(hostOnly.endpoint, ENDPOINT);
  assert.equal(hostOnly.host, 'di-test.example.test');
});

test('mocked SecretString api_key+endpoint is configured (not azure_not_configured)', async () => {
  const logs = captureLog();
  let posts = 0;
  const fetchImpl = async (url, init) => {
    if (init.method === 'POST') {
      posts += 1;
      return res(400, {});
    }
    return res(204, null);
  };
  const out = await analyzeAzureCheck({
    imageBytes: Buffer.from('png'),
    secretLoader: async () => JSON.stringify({ api_key: API_KEY, endpoint: ENDPOINT }),
    fetchImpl,
    sleep: async () => {},
    now: () => 0,
    log: logs.log,
  });
  assert.notEqual(out.code, 'azure_not_configured');
  assert.equal(out.code, 'azure_http_400');
  assert.equal(posts, 1);
  assertNoSecrets(logs.blob());
});

test('13) Azure timeout', async () => {
  const logs = captureLog();
  let t = 0;
  const fetchImpl = async (url, init) => {
    if (init.method === 'POST') return res(202, {}, { 'Operation-Location': OP_LOC });
    if (init.method === 'DELETE') return res(204, null);
    return res(200, { status: 'running' });
  };
  const out = await analyzeAzureCheck({
    imageBytes: Buffer.from('png'),
    secretLoader,
    fetchImpl,
    sleep: async (ms) => { t += ms; },
    now: () => t,
    log: logs.log,
    pollTimeoutMs: 50,
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'azure_timeout');
  assert.equal(out.deleteConfirmed, true);
  assertNoSecrets(logs.blob());
});

test('14) Azure 429 respects Retry-After then succeeds', async () => {
  const logs = captureLog();
  const statuses = [];
  let posts = 0;
  const fetchImpl = async (url, init) => {
    statuses.push(init.method);
    if (init.method === 'POST') {
      posts += 1;
      if (posts === 1) return res(429, { error: 'throttled' }, { 'Retry-After': '1' });
      return res(202, {}, { 'Operation-Location': OP_LOC });
    }
    if (init.method === 'DELETE') return res(204, null);
    return res(200, succeededBody());
  };
  const out = await analyzeAzureCheck({
    imageBytes: Buffer.from('png'),
    secretLoader,
    fetchImpl,
    sleep: async () => {},
    now: () => 0,
    log: logs.log,
    pollTimeoutMs: 5_000,
  });
  assert.equal(out.ok, true);
  assert.ok(posts >= 2);
  assertNoSecrets(logs.blob());
});

test('14b) Azure 429 exhaustion', async () => {
  const logs = captureLog();
  let posts = 0;
  const fetchImpl = async (url, init) => {
    if (init.method === 'POST') {
      posts += 1;
      return res(429, { error: 'throttled', routing_number: ROUTING_OK }, { 'Retry-After': '0' });
    }
    return res(204, null);
  };
  const out = await analyzeAzureCheck({
    imageBytes: Buffer.from('png'),
    secretLoader,
    fetchImpl,
    sleep: async () => {},
    now: () => 0,
    log: logs.log,
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'azure_http_429');
  assert.equal(posts, 3);
  assertNoSecrets(logs.blob());
});

test('15) Azure 500 retry then success', async () => {
  const logs = captureLog();
  let posts = 0;
  const fetchImpl = async (url, init) => {
    if (init.method === 'POST') {
      posts += 1;
      if (posts === 1) return res(500, { error: 'boom' });
      return res(202, {}, { 'Operation-Location': OP_LOC });
    }
    if (init.method === 'DELETE') return res(204, null);
    return res(200, succeededBody());
  };
  const out = await analyzeAzureCheck({
    imageBytes: Buffer.from('png'),
    secretLoader,
    fetchImpl,
    sleep: async () => {},
    now: () => 0,
    log: logs.log,
    pollTimeoutMs: 5_000,
  });
  assert.equal(out.ok, true);
  assert.equal(out.code, 'ok');
  assert.equal(posts, 2);
  assertNoSecrets(logs.blob());
});

test('16) Azure 500 exhaustion', async () => {
  const logs = captureLog();
  let posts = 0;
  const fetchImpl = async (url, init) => {
    if (init.method === 'POST') {
      posts += 1;
      return res(500, { error: 'boom', account_number: ACCOUNT });
    }
    return res(204, null);
  };
  const out = await analyzeAzureCheck({
    imageBytes: Buffer.from('png'),
    secretLoader,
    fetchImpl,
    sleep: async () => {},
    now: () => 0,
    log: logs.log,
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'azure_http_500');
  assert.equal(posts, 3);
  assertNoSecrets(logs.blob());
});

test('17) Azure 400 no retry', async () => {
  const logs = captureLog();
  let posts = 0;
  const fetchImpl = async (url, init) => {
    if (init.method === 'POST') {
      posts += 1;
      return res(400, { error: 'bad request', payee: PAYEE });
    }
    return res(204, null);
  };
  const out = await analyzeAzureCheck({
    imageBytes: Buffer.from('png'),
    secretLoader,
    fetchImpl,
    sleep: async () => {},
    now: () => 0,
    log: logs.log,
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'azure_http_400');
  assert.equal(posts, 1);
  assertNoSecrets(logs.blob());
});

test('18) malformed Operation-Location', async () => {
  const logs = captureLog();
  const fetchImpl = async (url, init) => {
    if (init.method === 'POST') return res(202, {}, { 'Operation-Location': '%%%not-a-url' });
    return res(204, null);
  };
  const out = await analyzeAzureCheck({
    imageBytes: Buffer.from('png'),
    secretLoader,
    fetchImpl,
    sleep: async () => {},
    now: () => 0,
    log: logs.log,
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'malformed_operation_location');
  assertNoSecrets(logs.blob());
});

test('19) Operation-Location wrong host', async () => {
  const logs = captureLog();
  const evil = `https://evil.example.test/documentintelligence/documentModels/${AZURE_CHECK_MODEL}/analyzeResults/${RESULT_ID}`;
  const fetchImpl = async (url, init) => {
    if (init.method === 'POST') return res(202, {}, { 'Operation-Location': evil });
    return res(204, null);
  };
  const out = await analyzeAzureCheck({
    imageBytes: Buffer.from('png'),
    secretLoader,
    fetchImpl,
    sleep: async () => {},
    now: () => 0,
    log: logs.log,
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'operation_location_wrong_host');
  const loc = validateOperationLocation(evil, 'di-test.example.test');
  assert.equal(loc.ok, false);
  assertNoSecrets(logs.blob());
});

test('20) succeeded response missing documents', async () => {
  const logs = captureLog();
  const fetchImpl = async (url, init) => {
    if (init.method === 'POST') return res(202, {}, { 'Operation-Location': OP_LOC });
    if (init.method === 'DELETE') return res(204, null);
    return res(200, { status: 'succeeded', analyzeResult: {} });
  };
  const out = await analyzeAzureCheck({
    imageBytes: Buffer.from('png'),
    secretLoader,
    fetchImpl,
    sleep: async () => {},
    now: () => 0,
    log: logs.log,
    pollTimeoutMs: 5_000,
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'azure_missing_documents');
  assert.equal(out.deleteConfirmed, true);
  assertNoSecrets(logs.blob());
});

test('21) DELETE 204', async () => {
  const logs = captureLog();
  const fetchImpl = async (url, init) => {
    if (init.method === 'POST') return res(202, {}, { 'Operation-Location': OP_LOC });
    if (init.method === 'DELETE') return res(204, null);
    return res(200, succeededBody());
  };
  const out = await analyzeAzureCheck({
    imageBytes: Buffer.from('png'),
    secretLoader,
    fetchImpl,
    sleep: async () => {},
    now: () => 0,
    log: logs.log,
    pollTimeoutMs: 5_000,
  });
  assert.equal(out.ok, true);
  assert.equal(out.deleteConfirmed, true);
  assert.ok(logs.entries.some((e) => e.deleteConfirmed === true));
  assertNoSecrets(logs.blob());
});

test('21b) DELETE 429 then 204 is confirmed', async () => {
  const logs = captureLog();
  let deletes = 0;
  const fetchImpl = async (url, init) => {
    if (init.method === 'POST') return res(202, {}, { 'Operation-Location': OP_LOC });
    if (init.method === 'DELETE') {
      deletes += 1;
      if (deletes === 1) return res(429, { error: 'throttled' }, { 'Retry-After': '0' });
      return res(204, null);
    }
    return res(200, succeededBody());
  };
  const out = await analyzeAzureCheck({
    imageBytes: Buffer.from('png'),
    secretLoader,
    fetchImpl,
    sleep: async () => {},
    now: () => 0,
    log: logs.log,
    pollTimeoutMs: 5_000,
  });
  assert.equal(out.ok, true);
  assert.equal(out.deleteConfirmed, true);
  assert.equal(deletes, 2);
  assert.ok(logs.entries.some((e) => e.event === 'azure_delete' && e.deleteConfirmed === true && e.status === 204));
  assertNoSecrets(logs.blob());
  assert.equal('resultId' in out, false);
  assert.ok(!JSON.stringify(out).includes(RESULT_ID));
});

test('21c) DELETE 429 exhaustion stays unconfirmed and does not fail OCR', async () => {
  const logs = captureLog();
  let deletes = 0;
  const fetchImpl = async (url, init) => {
    if (init.method === 'POST') return res(202, {}, { 'Operation-Location': OP_LOC });
    if (init.method === 'DELETE') {
      deletes += 1;
      return res(429, { error: 'throttled', api_key: API_KEY, routing_number: ROUTING_OK }, { 'Retry-After': '0' });
    }
    return res(200, succeededBody());
  };
  const out = await analyzeAzureCheck({
    imageBytes: Buffer.from('png'),
    secretLoader,
    fetchImpl,
    sleep: async () => {},
    now: () => 0,
    log: logs.log,
    pollTimeoutMs: 5_000,
  });
  assert.equal(out.ok, true);
  assert.equal(out.code, 'ok');
  assert.equal(out.deleteConfirmed, false);
  assert.equal(deletes, 3);
  assert.ok(logs.entries.some((e) => e.event === 'azure_delete' && e.code === 'delete_http_429' && e.deleteConfirmed === false));
  assertNoSecrets(logs.blob());
  assert.equal('resultId' in out, false);
  assert.ok(!JSON.stringify(out).includes(API_KEY));
  assert.ok(!JSON.stringify(out).includes(RESULT_ID));
});

test('21d) DELETE retries after analyze failure when result id exists', async () => {
  const logs = captureLog();
  let deletes = 0;
  let t = 0;
  const fetchImpl = async (url, init) => {
    if (init.method === 'POST') return res(202, {}, { 'Operation-Location': OP_LOC });
    if (init.method === 'DELETE') {
      deletes += 1;
      if (deletes === 1) return res(429, { error: 'throttled' }, { 'Retry-After': '0' });
      return res(204, null);
    }
    return res(200, { status: 'running' });
  };
  const out = await analyzeAzureCheck({
    imageBytes: Buffer.from('png'),
    secretLoader,
    fetchImpl,
    sleep: async (ms) => { t += ms; },
    now: () => t,
    log: logs.log,
    pollTimeoutMs: 50,
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'azure_timeout');
  assert.equal(out.deleteConfirmed, true);
  assert.equal(deletes, 2);
  assertNoSecrets(logs.blob());
});

test('21e) DELETE 400 is not retried and stays unconfirmed', async () => {
  const logs = captureLog();
  let deletes = 0;
  const fetchImpl = async (url, init) => {
    if (init.method === 'POST') return res(202, {}, { 'Operation-Location': OP_LOC });
    if (init.method === 'DELETE') {
      deletes += 1;
      return res(400, { error: 'bad delete', account_number: ACCOUNT });
    }
    return res(200, succeededBody());
  };
  const out = await analyzeAzureCheck({
    imageBytes: Buffer.from('png'),
    secretLoader,
    fetchImpl,
    sleep: async () => {},
    now: () => 0,
    log: logs.log,
    pollTimeoutMs: 5_000,
  });
  assert.equal(out.ok, true);
  assert.equal(out.deleteConfirmed, false);
  assert.equal(deletes, 1);
  assert.ok(logs.entries.some((e) => e.event === 'azure_delete' && e.code === 'delete_http_400'));
  assertNoSecrets(logs.blob());
});

test('22) DELETE failure does not expose payload', async () => {
  const logs = captureLog();
  const fetchImpl = async (url, init) => {
    if (init.method === 'POST') return res(202, {}, { 'Operation-Location': OP_LOC });
    if (init.method === 'DELETE') {
      return res(500, {
        error: 'delete failed',
        api_key: API_KEY,
        routing_number: ROUTING_OK,
        account_number: ACCOUNT,
        OperationLocation: OP_LOC,
      });
    }
    return res(200, succeededBody({
      fields: {
        MICR: {
          valueObject: {
            RoutingNumber: { valueString: ROUTING_OK },
            AccountNumber: { valueString: ACCOUNT },
          },
        },
        PayTo: { valueString: PAYEE },
      },
    }));
  };
  const out = await analyzeAzureCheck({
    imageBytes: Buffer.from('png'),
    secretLoader,
    fetchImpl,
    sleep: async () => {},
    now: () => 0,
    log: logs.log,
    pollTimeoutMs: 5_000,
  });
  assert.equal(out.ok, true);
  assert.equal(out.deleteConfirmed, false);
  const isolated = await deleteAzureAnalyzeResult({
    config: { endpoint: ENDPOINT, apiKey: API_KEY },
    resultId: RESULT_ID,
    fetchImpl: async () => { throw new Error(`payload ${API_KEY} ${ROUTING_OK} ${ACCOUNT} ${OP_LOC}`); },
    log: logs.log,
  });
  assert.equal(isolated.confirmed, false);
  assert.equal(isolated.code, 'delete_failed');
  assertNoSecrets(logs.blob());
  assert.ok(!JSON.stringify(out).includes(API_KEY));
  assert.ok(!JSON.stringify(isolated).includes(API_KEY));
});

test('23) no sensitive values in logs/errors', async () => {
  const logs = captureLog();
  const fat = {
    event: 'azure_analyze',
    ok: false,
    api_key: API_KEY,
    routing_number: ROUTING_OK,
    account_number: ACCOUNT,
    micr_check_number: CHECK,
    payee: PAYEE,
    operation_location: OP_LOC,
    base64Source: Buffer.from('iVBORw0KGgoaaa').toString('base64'),
    raw: { MICR: `${ROUTING_OK} ${ACCOUNT}` },
  };
  safeOcrLog(logs.log, fat);
  const redacted = redactOcrLog(fat);
  assert.equal(redacted.api_key, '[redacted]');
  assert.equal(redacted.routing_number, '[redacted]');
  assert.equal(redacted.account_number, '[redacted]');
  assert.equal(redacted.payee, '[redacted]');
  assert.equal(redacted.base64Source, '[redacted]');
  assert.equal(redacted.operation_location, '[redacted]');
  assert.ok(!Object.keys(logs.entries[0]).includes('api_key'));
  assert.ok(!Object.keys(logs.entries[0]).includes('base64Source'));
  assertNoSecrets(logs.blob());
  assertNoSecrets(JSON.stringify(redacted));

  const fetchImpl = async (url, init) => {
    if (init.method === 'POST') return res(202, 'not-json{', { 'Operation-Location': OP_LOC });
    return res(204, null);
  };
  const out = await analyzeAzureCheck({
    imageBytes: Buffer.from('iVBORw0KGgo'),
    secretLoader,
    fetchImpl,
    sleep: async () => {},
    now: () => 0,
    log: logs.log,
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'malformed_json');
  assertNoSecrets(logs.blob());
  assert.ok(!JSON.stringify(out).includes(API_KEY));
});

test('POST uses prebuilt-check.us and api-version 2024-11-30 with base64Source', async () => {
  let posted;
  const fetchImpl = async (url, init) => {
    if (init.method === 'POST') {
      posted = { url, body: JSON.parse(init.body) };
      return res(400, {});
    }
    return res(204, null);
  };
  await analyzeAzureCheck({
    imageBytes: Buffer.from('abc'),
    secretLoader,
    fetchImpl,
    sleep: async () => {},
    now: () => 0,
  });
  assert.match(posted.url, /documentModels\/prebuilt-check\.us:analyze/);
  assert.match(posted.url, /api-version=2024-11-30/);
  assert.equal(posted.body.base64Source, Buffer.from('abc').toString('base64'));
});
