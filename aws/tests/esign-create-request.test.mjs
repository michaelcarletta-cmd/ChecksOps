import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  createSignatureRequestRows,
  normalizeCreateSigners,
  runSendSignatureRequest,
} from '../functions/api/esign.mjs';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '55555555-5555-4555-8555-555555555555';
const CLAIM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CHECK = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const REQUEST = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SIGNER = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const FILE_PATH = `check-intake/${CHECK}/files/ui.pdf`;

const mapping = { application_user_id: USER };
const spoof = { ignored: true };

const wouldCommit = (result) => result?.ok !== false && Number(result?.statusCode || 200) < 400;

const recordingClient = () => {
  const calls = [];
  const rows = {
    requests: [],
    signers: [],
    fields: [],
    checkFiles: [{ check_intake_item_id: CHECK, file_path: FILE_PATH, signature_request_id: null }],
  };
  const client = {
    calls,
    rows,
    query: async (sql, params = []) => {
      const compact = String(sql).replace(/\s+/g, ' ');
      calls.push({ sql: compact, params });
      if (compact.includes('INSERT INTO public.signature_requests')) {
        const row = {
          id: params[0],
          claim_id: params[1],
          check_intake_item_id: params[2],
          document_name: params[3],
          document_path: params[4],
          document_type: params[5],
          field_data: JSON.parse(params[6] || '[]'),
          status: 'draft',
          created_by: params[7],
        };
        rows.requests.push(row);
        return { rows: [row], rowCount: 1 };
      }
      if (compact.includes('INSERT INTO public.signature_signers')) {
        const row = {
          id: params[0],
          signature_request_id: params[1],
          signer_name: params[2],
          signer_email: params[3],
          signer_type: params[4],
          signing_order: params[5],
          status: 'pending',
          access_token: params[6],
        };
        rows.signers.push(row);
        return { rows: [row], rowCount: 1 };
      }
      if (compact.includes('INSERT INTO public.signature_fields')) {
        rows.fields.push({
          id: params[0],
          signature_request_id: params[1],
          signer_index: params[2],
          field_type: params[3],
          label: params[4],
          page: params[5],
          x: params[6],
          y: params[7],
          width: params[8],
          height: params[9],
        });
        return { rows: [], rowCount: 1 };
      }
      if (compact.includes('UPDATE public.check_files')) {
        for (const file of rows.checkFiles) {
          if (file.check_intake_item_id === params[1] && file.file_path === params[2]) {
            file.signature_request_id = params[0];
          }
        }
        return { rows: [], rowCount: 1 };
      }
      if (compact.includes('FROM public.signature_requests WHERE id')) {
        return { rows: rows.requests.filter((row) => row.id === params[0]) };
      }
      if (compact.includes('FROM public.signature_signers WHERE signature_request_id')) {
        return { rows: rows.signers.filter((row) => row.signature_request_id === params[0]) };
      }
      if (compact.includes('FROM public.signature_fields')) {
        return { rows: rows.fields.filter((row) => row.signature_request_id === params[0]) };
      }
      if (compact.includes('FROM public.claims')) {
        return { rows: [{ id: CLAIM, claim_number: 'CL-1', policyholder_name: 'Ada', tenant_id: TENANT }] };
      }
      if (compact.includes('FROM public.check_intake_items')) {
        return { rows: [{ id: CHECK, tenant_id: TENANT, check_number: '1001' }] };
      }
      if (compact.includes('aws_can_write_tenant')) {
        return { rows: [{ ok: true }] };
      }
      if (compact.includes('FROM public.company_branding')) {
        return { rows: [{}] };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return client;
};

const capturingMailer = (sent) => async (payload) => {
  sent.push(payload);
  return { deliveredCount: 0, sunkCount: 1, mode: 'sink', results: [{ delivery: 'sink', messageId: 'sink-1' }] };
};

const createBody = (overrides = {}) => ({
  claim_id: CLAIM,
  check_intake_item_id: CHECK,
  document_name: 'Release.pdf',
  document_path: FILE_PATH,
  document_type: 'authorization',
  field_data: [{ id: '11111111-1111-4111-8111-111111111111', type: 'signature', signerIndex: 0, label: 'Sign', page: 1, x: 10, y: 20, width: 33, height: 6 }],
  signers: [{ name: 'Ada', email: 'ada@example.com', type: 'policyholder', order: 1 }],
  ...overrides,
});

test('normalizeCreateSigners accepts wizard name/email/type/order', () => {
  const rows = normalizeCreateSigners([{ name: 'Ada', email: 'ada@example.com', type: 'policyholder', order: 2 }]);
  assert.deepEqual(rows, [{
    signer_name: 'Ada',
    signer_email: 'ada@example.com',
    signer_type: 'policyholder',
    signing_order: 2,
  }]);
});

test('create branch inserts request + signers, links check_files, persists fields, and returns requestId', async () => {
  const sent = [];
  const client = recordingClient();
  const result = await runSendSignatureRequest({
    mapping,
    spoof,
    body: createBody(),
    send: capturingMailer(sent),
    client,
  });
  assert.equal(result.ok, true);
  assert.equal(typeof result.requestId, 'string');
  assert.equal(client.rows.requests.length, 1);
  assert.equal(client.rows.signers.length, 1);
  assert.equal(client.rows.fields.length, 1);
  assert.equal(client.rows.requests[0].document_path, FILE_PATH);
  assert.equal(client.rows.signers[0].signer_email, 'ada@example.com');
  assert.equal(client.rows.fields[0].field_type, 'signature');
  assert.equal(client.rows.checkFiles[0].signature_request_id, result.requestId);
  assert.equal(sent.length, 1);
  assert.equal(client.calls.some((call) => call.sql.includes('/data/write')), false);
  assert.equal(wouldCommit(result), true);
});

test('create skipEmail uses manual_bypass and still inserts rows + fields', async () => {
  const sent = [];
  const client = recordingClient();
  const result = await runSendSignatureRequest({
    mapping,
    spoof,
    body: createBody({ skipEmail: true }),
    send: capturingMailer(sent),
    client,
  });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'manual_bypass');
  assert.equal(Array.isArray(result.signerLinks), true);
  assert.equal(result.signerLinks.length, 1);
  assert.equal(sent.length, 0);
  assert.equal(client.rows.requests.length, 1);
  assert.equal(client.rows.signers.length, 1);
  assert.equal(client.rows.fields.length, 1);
  assert.equal(wouldCommit(result), true);
});

test('existing requestId path does not insert signature_requests or signature_signers', async () => {
  const sent = [];
  const inserts = [];
  const client = {
    query: async (sql, params = []) => {
      const compact = String(sql).replace(/\s+/g, ' ');
      if (compact.includes('INSERT INTO public.signature_requests') || compact.includes('INSERT INTO public.signature_signers')) {
        inserts.push(compact);
      }
      if (compact.includes('FROM public.signature_requests')) {
        return { rows: [{ id: REQUEST, document_name: 'Release', claim_id: CLAIM, field_data: [] }] };
      }
      if (compact.includes('FROM public.signature_signers')) {
        return { rows: [{ id: SIGNER, signer_name: 'Ada', signer_email: 'ada@example.com' }] };
      }
      if (compact.includes('FROM public.claims')) {
        return { rows: [{ id: CLAIM, claim_number: 'CL-1', policyholder_name: 'Ada', tenant_id: TENANT }] };
      }
      if (compact.includes('aws_can_write_tenant')) {
        return { rows: [{ ok: true }] };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const result = await runSendSignatureRequest({
    mapping,
    spoof,
    body: { requestId: REQUEST },
    send: capturingMailer(sent),
    client,
  });
  assert.equal(result.ok, true);
  assert.equal(result.requestId, REQUEST);
  assert.equal(inserts.length, 0);
  assert.equal(sent.length, 1);
});

test('create validation failures insert nothing and do not commit', async () => {
  const client = recordingClient();
  const missingDoc = await createSignatureRequestRows({
    mapping, spoof, client, body: { claim_id: CLAIM, signers: [{ name: 'Ada', email: 'ada@example.com' }] },
  });
  assert.equal(missingDoc.ok, false);
  assert.equal(wouldCommit(missingDoc), false);
  const missingSigner = await createSignatureRequestRows({
    mapping, spoof, client, body: { claim_id: CLAIM, document_name: 'x', document_path: FILE_PATH, signers: [] },
  });
  assert.equal(missingSigner.ok, false);
  assert.equal(client.rows.requests.length, 0);
  assert.equal(client.rows.signers.length, 0);
});

test('create forbidden tenant returns before inserts', async () => {
  const client = recordingClient();
  const original = client.query;
  client.query = async (sql, params = []) => {
    if (String(sql).includes('aws_can_write_tenant')) return { rows: [{ ok: false }] };
    return original(sql, params);
  };
  const result = await createSignatureRequestRows({
    mapping, spoof, client, body: createBody(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 403);
  assert.equal(client.rows.requests.length, 0);
  assert.equal(wouldCommit(result), false);
});

test('signer insert throw rolls back via withIdentityWrite commit policy', async () => {
  const client = recordingClient();
  const original = client.query;
  client.query = async (sql, params = []) => {
    if (String(sql).includes('INSERT INTO public.signature_signers')) {
      throw new Error('signer_insert_failed');
    }
    return original(sql, params);
  };
  await assert.rejects(
    () => createSignatureRequestRows({ mapping, spoof, client, body: createBody() }),
    /signer_insert_failed/,
  );
  assert.equal(client.rows.requests.length, 1);
  assert.equal(client.rows.signers.length, 0);
});

test('frontend AWS write allowlist still excludes signature tables', () => {
  const source = readFileSync(new URL('../../src/integrations/aws/client.ts', import.meta.url), 'utf8');
  assert.match(source, /const AWS_WRITE_TABLES = new Set\(/);
  assert.doesNotMatch(source, /AWS_WRITE_TABLES = new Set\(\[[^\]]*signature_requests/);
  assert.equal(source.includes('"signature_requests"'), false);
  assert.equal(source.includes('"signature_signers"'), false);
  assert.equal(source.includes('"signature_fields"'), false);
});

test('backend WRITE_ALLOWLIST still excludes signature tables', () => {
  const source = readFileSync(new URL('../functions/api/write-allowlist.mjs', import.meta.url), 'utf8');
  assert.equal(source.includes('signature_requests'), false);
  assert.equal(source.includes('signature_signers'), false);
  assert.equal(source.includes('signature_fields'), false);
});
