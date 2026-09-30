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
        const explicitId = compact.includes('id, signature_request_id');
        rows.fields.push(explicitId ? {
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
          required: params[10],
          placeholder: params[11],
          checkbox_label: params[12],
          omitted_id: false,
        } : {
          id: null,
          signature_request_id: params[0],
          signer_index: params[1],
          field_type: params[2],
          label: params[3],
          page: params[4],
          x: params[5],
          y: params[6],
          width: params[7],
          height: params[8],
          required: params[9],
          placeholder: params[10],
          checkbox_label: params[11],
          omitted_id: true,
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

test('non-UUID field ids omit id so Postgres DEFAULT gen_random_uuid() applies', async () => {
  const client = recordingClient();
  const result = await runSendSignatureRequest({
    mapping,
    spoof,
    body: createBody({
      field_data: [{
        id: 'signature-1790706277046',
        type: 'signature',
        signerIndex: 0,
        label: 'Sign here',
        page: 2,
        x: 11,
        y: 22,
        width: 40,
        height: 8,
        required: true,
        placeholder: 'Sign',
        checkboxLabel: null,
      }, {
        id: 'date-1790691690138',
        type: 'date',
        signerIndex: 1,
        label: 'Date',
        page: 2,
        x: 50,
        y: 60,
        width: 20,
        height: 6,
        required: false,
        placeholder: null,
        checkboxLabel: 'Done',
      }],
    }),
    send: capturingMailer([]),
    client,
  });
  assert.equal(result.ok, true);
  assert.equal(wouldCommit(result), true);
  assert.equal(client.rows.fields.length, 2);
  assert.equal(client.rows.fields[0].omitted_id, true);
  assert.equal(client.rows.fields[0].id, null);
  assert.equal(client.rows.fields[0].signature_request_id, result.requestId);
  assert.equal(client.rows.fields[0].field_type, 'signature');
  assert.equal(client.rows.fields[0].label, 'Sign here');
  assert.equal(client.rows.fields[0].page, 2);
  assert.equal(client.rows.fields[0].x, 11);
  assert.equal(client.rows.fields[0].y, 22);
  assert.equal(client.rows.fields[0].width, 40);
  assert.equal(client.rows.fields[0].height, 8);
  assert.equal(client.rows.fields[0].required, true);
  assert.equal(client.rows.fields[0].placeholder, 'Sign');
  assert.equal(client.rows.fields[0].signer_index, 0);
  assert.equal(client.rows.fields[1].omitted_id, true);
  assert.equal(client.rows.fields[1].field_type, 'date');
  assert.equal(client.rows.fields[1].checkbox_label, 'Done');
  assert.equal(client.rows.fields[1].required, false);
  assert.equal(client.rows.fields[1].signer_index, 1);
  const fieldInserts = client.calls.filter((call) => call.sql.includes('INSERT INTO public.signature_fields'));
  assert.equal(fieldInserts.every((call) => !call.sql.includes('id, signature_request_id')), true);
  assert.equal(fieldInserts.every((call) => !call.params.includes('signature-1790706277046')), true);
  assert.equal(client.rows.requests.length, 1);
  assert.equal(client.rows.signers.length, 1);
});

test('valid UUID field ids are still bound as $1::uuid', async () => {
  const client = recordingClient();
  const fieldId = '11111111-1111-4111-8111-111111111111';
  const result = await runSendSignatureRequest({
    mapping,
    spoof,
    body: createBody({
      field_data: [{
        id: fieldId,
        type: 'signature',
        signerIndex: 0,
        label: 'Sign',
        page: 1,
        x: 10,
        y: 20,
        width: 33,
        height: 6,
      }],
    }),
    send: capturingMailer([]),
    client,
  });
  assert.equal(result.ok, true);
  assert.equal(client.rows.fields[0].omitted_id, false);
  assert.equal(client.rows.fields[0].id, fieldId);
  const fieldInsert = client.calls.find((call) => call.sql.includes('INSERT INTO public.signature_fields'));
  assert.match(fieldInsert.sql, /id, signature_request_id/);
  assert.equal(fieldInsert.params[0], fieldId);
  assert.equal(fieldInsert.params[1], result.requestId);
});

test('field insert error is not swallowed and prevents commit', async () => {
  const client = recordingClient();
  const original = client.query;
  client.query = async (sql, params = []) => {
    if (String(sql).includes('INSERT INTO public.signature_fields')) {
      const error = new Error('invalid input syntax for type uuid: "signature-1790706277046"');
      error.code = '22P02';
      throw error;
    }
    return original(sql, params);
  };
  await assert.rejects(
    () => runSendSignatureRequest({
      mapping,
      spoof,
      body: createBody(),
      send: capturingMailer([]),
      client,
    }),
    (error) => {
      assert.equal(error.code, '22P02');
      assert.match(String(error.message), /invalid input syntax for type uuid/);
      assert.doesNotMatch(String(error.message), /25P02|aborted/);
      return true;
    },
  );
  assert.equal(client.rows.requests.length, 1);
  assert.equal(client.rows.signers.length, 1);
  assert.equal(client.rows.fields.length, 0);
  assert.equal(wouldCommit({ ok: false, statusCode: 503 }), false);
});

test('existing requestId send still skips request/signer inserts when field_data is present', async () => {
  const sent = [];
  const inserts = [];
  const client = {
    query: async (sql, params = []) => {
      const compact = String(sql).replace(/\s+/g, ' ');
      if (compact.includes('INSERT INTO public.signature_requests') || compact.includes('INSERT INTO public.signature_signers')) {
        inserts.push(compact);
      }
      if (compact.includes('INSERT INTO public.signature_fields')) {
        inserts.push(compact);
        return { rows: [], rowCount: 1 };
      }
      if (compact.includes('FROM public.signature_requests')) {
        return { rows: [{
          id: REQUEST,
          document_name: 'Release',
          claim_id: CLAIM,
          field_data: [{ id: 'signature-1790706277046', type: 'signature', signerIndex: 0, label: 'Sign', page: 1, x: 1, y: 2, width: 33, height: 6 }],
        }] };
      }
      if (compact.includes('FROM public.signature_signers')) {
        return { rows: [{ id: SIGNER, signer_name: 'Ada', signer_email: 'ada@example.com' }] };
      }
      if (compact.includes('FROM public.signature_fields')) {
        return { rows: [] };
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
  assert.equal(inserts.filter((sql) => sql.includes('signature_requests') || sql.includes('signature_signers')).length, 0);
  assert.equal(inserts.some((sql) => sql.includes('signature_fields') && !sql.includes('id, signature_request_id')), true);
  assert.equal(sent.length, 1);
});

test('field insert no longer swallows errors in runSendSignatureRequest', () => {
  const source = readFileSync(new URL('../functions/api/esign.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('const fieldData = request.field_data || [];');
  const end = source.indexOf('if (skipEmail)', start);
  const block = source.slice(start, end);
  assert.match(block, /optionalUuid\(field\.id\)/);
  assert.doesNotMatch(block, /\.catch\(\(\) => \{\}\)/);
  assert.match(block, /VALUES \(\$1::uuid, \$2, \$3, \$4, \$5, \$6, \$7, \$8, \$9, \$10, \$11, \$12\)/);
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

const signerUpdates = (client) => client.calls.filter((call) => (
  call.sql.includes('UPDATE public.signature_signers')
));

test('sent update no longer writes NULL to access_token', async () => {
  const client = recordingClient();
  const result = await runSendSignatureRequest({
    mapping,
    spoof,
    body: createBody(),
    send: capturingMailer([]),
    client,
  });
  assert.equal(result.ok, true);
  const sent = signerUpdates(client).find((call) => call.sql.includes("delivery_status = 'sent'"));
  assert.equal(Boolean(sent), true);
  assert.match(sent.sql, /delivery_status = 'sent'/);
  assert.match(sent.sql, /email_sent_at = now\(\)/);
  assert.match(sent.sql, /email_provider_message_id = \$2/);
  assert.doesNotMatch(sent.sql, /access_token\s*=\s*NULL/i);
  assert.equal(sent.params.includes(null), false);
});

test('failed update no longer writes NULL to access_token', async () => {
  const client = recordingClient();
  const result = await runSendSignatureRequest({
    mapping,
    spoof,
    body: createBody(),
    send: async () => {
      throw new Error('ses_unavailable');
    },
    client,
  });
  assert.equal(result.ok, false);
  const failed = signerUpdates(client).find((call) => call.sql.includes("delivery_status = 'failed'"));
  assert.equal(Boolean(failed), true);
  assert.match(failed.sql, /delivery_error = \$2/);
  assert.doesNotMatch(failed.sql, /access_token\s*=\s*NULL/i);
  assert.equal(failed.params[1], 'ses_unavailable');
});

test('skipEmail path no longer writes NULL to access_token', async () => {
  const client = recordingClient();
  const result = await runSendSignatureRequest({
    mapping,
    spoof,
    body: createBody({ skipEmail: true }),
    send: capturingMailer([]),
    client,
  });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'manual_bypass');
  const nullClears = signerUpdates(client).filter((call) => /access_token\s*=\s*NULL/i.test(call.sql));
  assert.equal(nullClears.length, 0);
  assert.equal(
    signerUpdates(client).some((call) => call.sql.includes("delivery_status = 'sent'") || call.sql.includes("delivery_status = 'failed'")),
    false,
  );
});

test('send path does not UPDATE claims.latest_signature_request_id', async () => {
  const client = recordingClient();
  const result = await runSendSignatureRequest({
    mapping,
    spoof,
    body: createBody(),
    send: capturingMailer([]),
    client,
  });
  assert.equal(result.ok, true);
  assert.equal(wouldCommit(result), true);
  assert.equal(
    client.calls.some((call) => /UPDATE public\.claims/i.test(call.sql) && /latest_signature_request_id/.test(call.sql)),
    false,
  );
  assert.equal(client.calls.some((call) => call.sql.includes('INSERT INTO public.signature_requests')), true);
  assert.equal(client.calls.some((call) => call.sql.includes('INSERT INTO public.signature_signers')), true);
  assert.equal(client.calls.some((call) => call.sql.includes('UPDATE public.check_files')), true);
});

test('skipEmail path does not UPDATE claims.latest_signature_request_id', async () => {
  const client = recordingClient();
  const result = await runSendSignatureRequest({
    mapping,
    spoof,
    body: createBody({ skipEmail: true }),
    send: capturingMailer([]),
    client,
  });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'manual_bypass');
  assert.equal(
    client.calls.some((call) => /UPDATE public\.claims/i.test(call.sql) && /latest_signature_request_id/.test(call.sql)),
    false,
  );
});

test('runSendSignatureRequest source no longer contains claims pointer updates', () => {
  const esign = readFileSync(new URL('../functions/api/esign.mjs', import.meta.url), 'utf8');
  const start = esign.indexOf('export const runSendSignatureRequest');
  const end = esign.indexOf('export const handleSendSignatureRequest');
  const block = esign.slice(start, end);
  assert.equal(block.includes('latest_signature_request_id'), false);
  assert.equal(block.includes('UPDATE public.claims'), false);
  assert.match(block, /createSignatureRequestRows/);
  assert.match(block, /optionalUuid\(field\.id\)/);
  assert.match(block, /SET access_token = \$2, token_hash = \$3/);
  assert.doesNotMatch(block, /access_token\s*=\s*NULL/i);
  assert.match(esign, /UPDATE public\.check_files/);
  assert.equal((esign.match(/UPDATE public\.claims SET latest_signature_request_id/g) || []).length, 0);
});

test('token_hash remains the public lookup and token mint is unchanged', () => {
  const esign = readFileSync(new URL('../functions/api/esign.mjs', import.meta.url), 'utf8');
  const submit = readFileSync(new URL('../functions/api/signature-submit.mjs', import.meta.url), 'utf8');
  assert.match(esign, /SET access_token = \$2, token_hash = \$3, expires_at = \$4::timestamptz/);
  assert.doesNotMatch(esign, /access_token\s*=\s*NULL/i);
  assert.match(esign, /optionalUuid\(field\.id\)/);
  assert.match(submit, /aws_public_signature_by_token_hash/);
  assert.match(submit, /hashToken\(token\)/);
  assert.doesNotMatch(submit, /WHERE[\s\S]*access_token\s*=/);
});
