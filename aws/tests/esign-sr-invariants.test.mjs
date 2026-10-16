/**
 * Staging Signature Request create/send invariants.
 * Forward-reconciled from the proven 2026-09-30 esign.mjs behavior
 * onto the current live staging member. No historical wholesale restore.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  createSignatureRequestRows,
  hashToken,
  normalizeCreateSigners,
  runSendSignatureRequest,
} from '../functions/api/esign.mjs';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '55555555-5555-4555-8555-555555555555';
const CLAIM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CHECK = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FILE_PATH = `check-intake/${CHECK}/files/ui.pdf`;

const mapping = { application_user_id: USER };
const spoof = { ignored: true };
const wouldCommit = (result) => result?.ok !== false && Number(result?.statusCode || 200) < 400;
const ESIGN = new URL('../functions/api/esign.mjs', import.meta.url);
const SUBMIT = new URL('../functions/api/signature-submit.mjs', import.meta.url);

const recordingClient = ({ role = 'operator', platformOwner = false, checkFilesGrant = true } = {}) => {
  const calls = [];
  let aborted = false;
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
      if (/^ROLLBACK TO SAVEPOINT/.test(compact)) {
        aborted = false;
        return { rows: [] };
      }
      if (aborted) {
        const error = new Error('current transaction is aborted, commands ignored until end of transaction block');
        error.code = '25P02';
        throw error;
      }
      if (/^(SAVEPOINT|RELEASE SAVEPOINT)/.test(compact)) return { rows: [] };
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
        rows.fields.push({ signature_request_id: params[0] || params[1] });
        return { rows: [], rowCount: 1 };
      }
      if (compact.includes('UPDATE public.check_files')) {
        if (!checkFilesGrant) {
          aborted = true;
          const error = new Error('permission denied for table check_files');
          error.code = '42501';
          throw error;
        }
        const paths = Array.isArray(params[2]) ? params[2] : [params[2]];
        let rowCount = 0;
        for (const file of rows.checkFiles) {
          if (file.check_intake_item_id === params[1] && paths.includes(file.file_path)) {
            file.signature_request_id = params[0];
            rowCount += 1;
          }
        }
        return { rows: [], rowCount };
      }
      if (compact.includes('UPDATE public.signature_signers') && compact.includes('token_hash')) {
        const signer = rows.signers.find((row) => row.id === params[0]);
        if (signer) {
          signer.access_token = params[1];
          signer.token_hash = params[2];
          signer.expires_at = params[3];
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
        return { rows: [{ id: CHECK, claim_id: CLAIM, tenant_id: TENANT, check_number: '1001' }] };
      }
      if (compact.includes('FROM public.tenant_users')) {
        const allowed = ['owner', 'admin', 'manager', 'operator'].includes(role);
        return { rows: allowed && params[0] === USER && params[1] === TENANT ? [{ '?column?': 1 }] : [] };
      }
      if (compact.includes('is_platform_owner')) {
        return { rows: [{ is_owner: platformOwner }] };
      }
      if (compact.includes('aws_can_write_tenant')) {
        return { rows: [{ ok: true }] };
      }
      if (compact.includes('FROM public.company_branding') || compact.includes('FROM public.tenants')
        || compact.includes('FROM public.tenant_email_settings')) {
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
  field_data: [{
    id: 'signature-1790706277046',
    type: 'signature',
    signerIndex: 0,
    label: 'Sign',
    page: 1,
    x: 10,
    y: 20,
    width: 33,
    height: 6,
  }],
  signers: [{ name: 'Ada', email: 'ada@example.com', type: 'policyholder', order: 1 }],
  ...overrides,
});

const signerUpdates = (client) => client.calls.filter((call) => call.sql.includes('UPDATE public.signature_signers'));

test('source keeps Class A create, optionalUuid, token mint, and the two proven omissions', () => {
  const esign = readFileSync(ESIGN, 'utf8');
  const submit = readFileSync(SUBMIT, 'utf8');
  assert.match(esign, /export const createSignatureRequestRows/);
  assert.match(esign, /optionalUuid\(field\.id\)/);
  assert.match(esign, /SET access_token = \$2, token_hash = \$3, expires_at = \$4::timestamptz/);
  assert.match(esign, /UPDATE public\.check_files/);
  assert.match(esign, /if \(!requestId\) \{\s+const created = await createSignatureRequestRows/);
  assert.doesNotMatch(esign, /access_token\s*=\s*NULL/i);
  assert.doesNotMatch(esign, /latest_signature_request_id/);
  assert.doesNotMatch(esign, /UPDATE public\.claims/);
  assert.match(submit, /export const mapSubmittedFieldValues/);
  assert.match(submit, /export const buildSubmitSignersWithValues/);
  assert.match(submit, /export const sameFieldPlacement/);
  assert.match(submit, /export const shouldStampSignatureImage/);
  assert.match(submit, /aws_public_signature_attach_signed/);
  assert.match(submit, /signersWithValues/);
  assert.match(submit, /if \(shouldStampSignatureImage\(field\)\)/);
});

test('Class A create-payload inserts request + signers, links check_files, and mints token_hash', async () => {
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
  assert.equal(wouldCommit(result), true);
  assert.equal(client.rows.requests.length, 1);
  assert.equal(client.rows.signers.length, 1);
  assert.equal(client.rows.checkFiles[0].signature_request_id, result.requestId);
  assert.equal(client.calls.some((call) => call.sql.includes('/data/write')), false);
  assert.equal(client.calls.some((call) => call.sql.includes('INSERT INTO public.signature_requests')), true);
  assert.equal(client.calls.some((call) => call.sql.includes('INSERT INTO public.signature_signers')), true);
  const mint = signerUpdates(client).find((call) => call.sql.includes('token_hash = $3'));
  assert.equal(Boolean(mint), true);
  assert.equal(mint.params[0], client.rows.signers[0].id);
  assert.equal(typeof mint.params[1], 'string');
  assert.equal(mint.params[1].length >= 32, true);
  assert.equal(mint.params[2], hashToken(mint.params[1]));
  assert.equal(hashToken(mint.params[1]), createHash('sha256').update(mint.params[1], 'utf8').digest('hex'));
  assert.equal(sent.length, 1);
});

test('create/send does not write access_token = NULL on sent, failed, or skipEmail', async () => {
  const sentClient = recordingClient();
  const sent = await runSendSignatureRequest({
    mapping, spoof, body: createBody(), send: capturingMailer([]), client: sentClient,
  });
  assert.equal(sent.ok, true);
  const sentUpdate = signerUpdates(sentClient).find((call) => call.sql.includes("delivery_status = 'sent'"));
  assert.equal(Boolean(sentUpdate), true);
  assert.doesNotMatch(sentUpdate.sql, /access_token\s*=\s*NULL/i);

  const failedClient = recordingClient();
  const failed = await runSendSignatureRequest({
    mapping,
    spoof,
    body: createBody(),
    send: async () => { throw new Error('ses_unavailable'); },
    client: failedClient,
  });
  assert.equal(failed.ok, false);
  const failedUpdate = signerUpdates(failedClient).find((call) => call.sql.includes("delivery_status = 'failed'"));
  assert.equal(Boolean(failedUpdate), true);
  assert.doesNotMatch(failedUpdate.sql, /access_token\s*=\s*NULL/i);
  assert.equal(failedUpdate.params[1], 'ses_unavailable');

  const skipClient = recordingClient();
  const skipped = await runSendSignatureRequest({
    mapping, spoof, body: createBody({ skipEmail: true }), send: capturingMailer([]), client: skipClient,
  });
  assert.equal(skipped.ok, true);
  assert.equal(skipped.mode, 'manual_bypass');
  assert.equal(signerUpdates(skipClient).some((call) => /access_token\s*=\s*NULL/i.test(call.sql)), false);
});

test('create/send does not update claims.latest_signature_request_id', async () => {
  const client = recordingClient();
  const result = await runSendSignatureRequest({
    mapping, spoof, body: createBody(), send: capturingMailer([]), client,
  });
  assert.equal(result.ok, true);
  assert.equal(
    client.calls.some((call) => /UPDATE public\.claims/i.test(call.sql) && /latest_signature_request_id/.test(call.sql)),
    false,
  );

  const skipClient = recordingClient();
  const skipped = await runSendSignatureRequest({
    mapping, spoof, body: createBody({ skipEmail: true }), send: capturingMailer([]), client: skipClient,
  });
  assert.equal(skipped.ok, true);
  assert.equal(
    skipClient.calls.some((call) => /UPDATE public\.claims/i.test(call.sql)),
    false,
  );
});

test('generic browser inserts are not required for normal Class A create/send', async () => {
  const names = normalizeCreateSigners([{ name: 'Ada', email: 'ada@example.com', type: 'policyholder', order: 1 }]);
  assert.equal(names[0].signer_email, 'ada@example.com');
  const client = recordingClient();
  const created = await createSignatureRequestRows({
    mapping, spoof, client, body: createBody(),
  });
  assert.equal(created.ok, true);
  assert.equal(client.rows.signers[0].access_token.length >= 32, true);
  assert.equal(client.calls.some((call) => call.sql.includes('from("signature_requests")')), false);
  assert.equal(client.calls.some((call) => call.sql.includes('/data/write')), false);
});

test('viewer and partner (non-member) cannot create or send Signature Requests', async () => {
  for (const role of ['viewer', 'partner', null]) {
    const client = recordingClient({ role });
    const created = await runSendSignatureRequest({
      mapping, spoof, body: createBody(), send: capturingMailer([]), client,
    });
    assert.equal(created.ok, false, String(role));
    assert.equal(created.statusCode, 403);
    assert.equal(client.rows.requests.length, 0);
    assert.equal(client.rows.signers.length, 0);
  }
  const seeded = recordingClient({ role: 'operator' });
  const first = await createSignatureRequestRows({ mapping, spoof, client: seeded, body: createBody() });
  assert.equal(first.ok, true);
  const viewer = recordingClient({ role: 'viewer' });
  viewer.rows.requests.push(...seeded.rows.requests);
  viewer.rows.signers.push(...seeded.rows.signers);
  const resend = await runSendSignatureRequest({
    mapping, spoof, body: { requestId: first.requestId }, send: capturingMailer([]), client: viewer,
  });
  assert.equal(resend.ok, false);
  assert.equal(resend.statusCode, 403);
  assert.equal(signerUpdates(viewer).length, 0);
});

test('owner, admin, manager and operator act; the platform owner without membership is refused', async () => {
  for (const role of ['owner', 'admin', 'manager', 'operator']) {
    const client = recordingClient({ role });
    const result = await runSendSignatureRequest({
      mapping, spoof, body: createBody(), send: capturingMailer([]), client,
    });
    assert.equal(result.ok, true, role);
  }
  // Owner policy: tenant signatures are the tenant members' own; the platform
  // owner does not act on them.
  const platform = recordingClient({ role: null, platformOwner: true });
  const result = await runSendSignatureRequest({
    mapping, spoof, body: createBody(), send: capturingMailer([]), client: platform,
  });
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 403);
  assert.equal(platform.rows.requests.length, 0);
});

test('create branch keeps the /data/write document-path scope and claim/check consistency', async () => {
  const foreign = recordingClient();
  const denied = await createSignatureRequestRows({
    mapping,
    spoof,
    client: foreign,
    body: createBody({ document_path: 'check-intake/cccccccc-cccc-4ccc-8ccc-cccccccccccc/files/other.pdf' }),
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, 'not_authorized');
  assert.equal(foreign.rows.requests.length, 0);

  const mismatch = recordingClient();
  const wrongClaim = await createSignatureRequestRows({
    mapping,
    spoof,
    client: mismatch,
    body: createBody({ claim_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }),
  });
  assert.equal(wrongClaim.ok, false);
  assert.equal(wrongClaim.error, 'claim_mismatch');
  assert.equal(mismatch.rows.requests.length, 0);
});

test('check_files link failure does not abort the create/send transaction', async () => {
  const client = recordingClient({ checkFilesGrant: false });
  const result = await runSendSignatureRequest({
    mapping, spoof, body: createBody(), send: capturingMailer([]), client,
  });
  assert.equal(result.ok, true);
  assert.equal(client.rows.requests.length, 1);
  assert.equal(client.rows.checkFiles[0].signature_request_id, null);
  assert.ok(client.calls.some((call) => call.sql.startsWith('ROLLBACK TO SAVEPOINT esign_check_file_link')));
  assert.ok(signerUpdates(client).some((call) => call.sql.includes('token_hash = $3')));
});
