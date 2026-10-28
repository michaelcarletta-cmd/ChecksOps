/**
 * Mortgage Desk e-sign, reads and timeline (SQL 124): the
 * /functions/v1/mortgage-desk-esign endpoint (auth refusals, SQL error
 * mapping, token minting and hashing, the ChecksOps sender, the (g) delivery
 * record), the Desk storage read rule and the SPA wiring. Fake clients only;
 * SQL 124's behaviour on PostgreSQL is covered by
 * sql124-mortgage-desk-signature-pg.test.mjs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DESK_CAN_READ_PATH_SQL,
  DESK_CHECK_FILES_SQL,
  DESK_CREATE_SIGNATURE_SQL,
  DESK_EMAIL_CONTEXT_SQL,
  DESK_MESSAGES_SQL,
  DESK_POST_TIMELINE_SQL,
  DESK_RECORD_DELIVERY_SQL,
  DESK_SIGNATURE_REQUESTS_SQL,
  MORTGAGE_DESK_ESIGN_EXPIRY_HOURS,
  MORTGAGE_DESK_ESIGN_SENDER_NAME,
  handleMortgageDeskEsign,
  mapMortgageDeskSqlError,
  mortgageDeskEsignBranding,
  validateDeskSignatureInput,
} from '../functions/api/mortgage-desk-esign.mjs';
import { MORTGAGE_DESK_REQUEST_SQL, PLATFORM_OWNER_SQL } from '../functions/api/mortgage-desk-return.mjs';
import { CLASS_A_FUNCTIONS } from '../functions/api/app-services.mjs';
import { LOOKUP_MAPPING_SQL, USER_ROLES_SQL } from '../functions/api/identity.mjs';
import { hashToken } from '../functions/api/esign.mjs';
import {
  buildDeskSignaturePayload,
  canReadMortgageDeskRequest,
  canWorkMortgageDeskRequest,
  defaultDeskSigners,
  deskSignerMissingSignature,
  deskSignersProblem,
  invokeMortgageDeskEsign,
  isDeskSignableFile,
  loadMortgageDeskWorkspace,
  postMortgageDeskTimeline,
} from '../../src/lib/mortgageDeskEsign.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const AGENT = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const OTHER_AGENT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const CHECK_ID = '33333333-3333-4333-8333-333333333333';
const TENANT_A = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const SIG_ID = '66666666-6666-4666-8666-666666666666';
const SIGNER_1 = '77777777-7777-4777-8777-777777777777';
const SIGNER_2 = '88888888-8888-4888-8888-888888888888';
const DOC_PATH = `checks/${CHECK_ID}/mortgage-ops/1700000000000-tpa.pdf`;

const DEFINERS = [
  DESK_MESSAGES_SQL, DESK_CHECK_FILES_SQL, DESK_SIGNATURE_REQUESTS_SQL, DESK_CREATE_SIGNATURE_SQL,
  DESK_RECORD_DELIVERY_SQL, DESK_POST_TIMELINE_SQL,
];

const sqlError = (message, code = '42501') => Object.assign(new Error(message), { code });

/** Fake pg client: RLS-visible request, roles, and canned SQL 124 answers (or a raise). */
const fakeClient = ({
  roles = [{ role: 'mortgage_agent' }],
  platformOwner = false,
  visibleRequest = {
    id: REQUEST_ID, tenant_id: TENANT_A, check_intake_item_id: CHECK_ID, status: 'in_progress', assigned_employee_id: AGENT,
  },
  raise = {},
  signerIds = [SIGNER_1, SIGNER_2],
} = {}) => {
  const queries = [];
  return {
    queries,
    connect: async () => {},
    end: async () => {},
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (['BEGIN', 'ROLLBACK', 'COMMIT', 'SET TRANSACTION READ WRITE'].includes(sql)) return { rows: [], command: sql };
      if (/^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)/.test(sql)) return { rows: [] };
      if (sql.startsWith('SELECT set_config')) return { rows: [] };
      if (sql === LOOKUP_MAPPING_SQL) {
        return { rows: [{ application_user_id: AGENT, cognito_sub: COGNITO_SUB, email: 'agent@checksops.test', status: 'active' }] };
      }
      if (sql === USER_ROLES_SQL) return { rows: roles };
      if (sql === PLATFORM_OWNER_SQL) return { rows: [{ is_owner: platformOwner }] };
      if (sql === MORTGAGE_DESK_REQUEST_SQL) return { rows: visibleRequest ? [visibleRequest] : [] };
      if (sql === DESK_EMAIL_CONTEXT_SQL) {
        return { rows: [{ claim_number: 'CLM-9', homeowner_name: 'Pat Insured', policy_number: 'POL-1', mortgage_company: 'Acme Mortgage' }] };
      }
      if (DEFINERS.includes(sql) && raise[sql]) throw raise[sql];
      if (sql === DESK_MESSAGES_SQL) {
        return { rows: [{ id: 'm1', sender_id: AGENT, body: 'hello', created_at: '2026-10-28T10:00:00Z', from_desk: true }] };
      }
      if (sql === DESK_CHECK_FILES_SQL) {
        return { rows: [{ id: 'f1', file_name: 'tpa.pdf', file_path: DOC_PATH, category: 'mortgage_ops', signature_request_id: null }] };
      }
      if (sql === DESK_SIGNATURE_REQUESTS_SQL) {
        return {
          rows: [{
            requests: [{
              id: SIG_ID,
              document_name: 'tpa.pdf',
              document_path: DOC_PATH,
              status: 'pending',
              signers: [{ id: SIGNER_1, signer_name: 'Pat', signer_email: 'pat@example.com', signer_type: 'policyholder', status: 'pending' }],
            }],
          }],
        };
      }
      if (sql === DESK_CREATE_SIGNATURE_SQL) {
        const signers = JSON.parse(params[5]);
        return {
          rows: [{
            result: {
              signature_request_id: SIG_ID,
              signers: signers.map((s, i) => ({ id: signerIds[i], signer_name: s.signer_name, signer_email: s.signer_email })),
            },
          }],
        };
      }
      if (sql === DESK_RECORD_DELIVERY_SQL) {
        const results = JSON.parse(params[2]);
        const sent = results.filter((r) => r.success).length;
        return {
          rows: [{
            result: {
              signature_request_id: params[1],
              status: sent ? 'pending' : 'failed',
              provider_status: sent === results.length ? 'emails_sent' : (sent ? 'emails_partially_failed' : 'emails_failed'),
              sent,
              failed: results.length - sent,
              total: results.length,
            },
          }],
        };
      }
      if (sql === DESK_POST_TIMELINE_SQL) return { rows: [{ id: 'ledger-1' }] };
      return { rows: [] };
    },
  };
};

const event = (body) => ({
  rawPath: '/functions/v1/mortgage-desk-esign',
  headers: { authorization: 'Bearer test-id-token' },
  body: JSON.stringify(body),
  requestContext: {
    stage: 'staging',
    http: { method: 'POST', path: '/functions/v1/mortgage-desk-esign' },
    authorizer: { jwt: { claims: { sub: COGNITO_SUB, email: 'agent@checksops.test', token_use: 'id' } } },
  },
});

/** deps that hand out one fake client per transaction. */
const depsFor = (makeClient, extra = {}) => {
  const clients = [];
  return {
    clients,
    deps: {
      loadDatabaseCredentials: async () => ({ host: 'x', username: 'checksops', password: 'x', database: 'checksops' }),
      createClient: () => {
        const client = typeof makeClient === 'function' ? makeClient(clients.length) : makeClient;
        clients.push(client);
        return client;
      },
      ...extra,
    },
  };
};

const definerCalls = (client) => client.queries.filter((q) => DEFINERS.includes(q.sql));

const SEND_BODY = {
  action: 'send_signature_request',
  request_id: REQUEST_ID,
  document_name: 'Third Party Authorization.pdf',
  document_path: `${DOC_PATH}?token=ignored`,
  document_type: 'work_authorization',
  field_data: [
    { id: 'signature-1', type: 'signature', signerIndex: 0, page: 1, x: 10, y: 10, width: 20, height: 5, label: 'Signature 1', required: true },
    { id: 'signature-2', type: 'signature', signerIndex: 1, page: 1, x: 10, y: 30, width: 20, height: 5, label: 'Signature 2', required: true },
    { id: 'date-1', type: 'date', signerIndex: 0, page: 1, x: 40, y: 10 },
  ],
  signers: [
    { signer_name: 'Pat Insured', signer_email: 'pat@example.com', signer_type: 'policyholder' },
    { signer_name: 'Roof Co', signer_email: 'office@roofco.example', signer_type: 'contractor' },
  ],
};

test('the endpoint is a Class A function routed by app-services', () => {
  assert.ok(CLASS_A_FUNCTIONS.has('mortgage-desk-esign'));
  assert.match(read('aws/functions/api/app-services.mjs'), /case 'mortgage-desk-esign':\s*\n\s*return handleMortgageDeskEsign\(event\);/);
});

test('reads: the assigned agent gets the thread, files and signature requests through SQL 124 (b) (c) (d)', async () => {
  const { deps, clients } = depsFor(fakeClient());
  const out = await handleMortgageDeskEsign(event({ action: 'workspace', request_id: REQUEST_ID, tenant_id: 'spoof' }), deps);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.data.messages[0].from_desk, true);
  assert.equal(out.data.check_files[0].file_path, DOC_PATH);
  assert.equal(out.data.signature_requests[0].id, SIG_ID);
  const calls = definerCalls(clients[0]);
  assert.deepEqual(calls.map((q) => q.sql), [DESK_MESSAGES_SQL, DESK_CHECK_FILES_SQL, DESK_SIGNATURE_REQUESTS_SQL]);
  for (const call of calls) assert.deepEqual(call.params, [REQUEST_ID]);
  // A read is never committed.
  assert.ok(!clients[0].queries.some((q) => q.sql === 'COMMIT'));
  assert.doesNotMatch(JSON.stringify(out), /access_token|token_hash/);

  for (const action of ['messages', 'check_files', 'signature_requests']) {
    const one = depsFor(fakeClient());
    const res = await handleMortgageDeskEsign(event({ action, request_id: REQUEST_ID }), one.deps);
    assert.equal(res.ok, true, action);
    assert.ok(Array.isArray(res.data), action);
  }
});

test('reads: a completed request stays readable; a requested one is refused', async () => {
  const done = depsFor(fakeClient({ visibleRequest: { id: REQUEST_ID, tenant_id: TENANT_A, check_intake_item_id: CHECK_ID, status: 'completed', assigned_employee_id: AGENT } }));
  assert.equal((await handleMortgageDeskEsign(event({ action: 'messages', request_id: REQUEST_ID }), done.deps)).ok, true);
  const open = depsFor(fakeClient({ visibleRequest: { id: REQUEST_ID, tenant_id: TENANT_A, check_intake_item_id: CHECK_ID, status: 'requested', assigned_employee_id: null } }));
  const refused = await handleMortgageDeskEsign(event({ action: 'messages', request_id: REQUEST_ID }), open.deps);
  assert.equal(refused.statusCode, 403); // not assigned comes first
  const unassignedOwner = depsFor(fakeClient({ platformOwner: true, visibleRequest: { id: REQUEST_ID, tenant_id: TENANT_A, check_intake_item_id: CHECK_ID, status: 'requested', assigned_employee_id: null } }));
  const notInStatus = await handleMortgageDeskEsign(event({ action: 'messages', request_id: REQUEST_ID }), unassignedOwner.deps);
  assert.equal(notInStatus.statusCode, 409);
  assert.equal(notInStatus.error, 'request_not_in_status');
  assert.equal(definerCalls(open.clients[0]).length + definerCalls(unassignedOwner.clients[0]).length, 0);
});

test('auth refusals: another agent, a tenant member, an invisible request, a bad id; nothing reaches SQL 124', async () => {
  const cases = [
    [fakeClient({ visibleRequest: { id: REQUEST_ID, tenant_id: TENANT_A, check_intake_item_id: CHECK_ID, status: 'in_progress', assigned_employee_id: OTHER_AGENT } }), 403, 'not_assigned_to_you'],
    [fakeClient({ roles: [{ role: 'admin' }] }), 403, 'not_authorized'],
    [fakeClient({ visibleRequest: null }), 403, 'not_authorized'],
  ];
  for (const action of ['workspace', 'post_timeline', 'send_signature_request']) {
    for (const [client, status, error] of cases) {
      const body = action === 'send_signature_request'
        ? SEND_BODY
        : { action, request_id: REQUEST_ID, kind: 'mortgage_update', note: 'n' };
      const { deps, clients } = depsFor(client);
      const out = await handleMortgageDeskEsign(event({ ...body, action }), deps);
      assert.equal(out.statusCode, status, `${action} ${error}`);
      assert.equal(out.error, error, `${action}`);
      for (const c of clients) {
        assert.equal(definerCalls(c).length, 0, `${action} ${error}`);
        assert.ok(!c.queries.some((q) => q.sql === 'COMMIT'), `${action} ${error}`);
      }
    }
  }
  const bad = depsFor(fakeClient());
  const out = await handleMortgageDeskEsign(event({ action: 'messages', request_id: 'nope' }), bad.deps);
  assert.equal(out.statusCode, 400);
  const unknown = await handleMortgageDeskEsign(event({ action: 'void' }), depsFor(fakeClient()).deps);
  assert.equal(unknown.statusCode, 400);
  assert.equal(unknown.error, 'unknown_action');
  const anonymous = await handleMortgageDeskEsign({ ...event({ action: 'messages', request_id: REQUEST_ID }), headers: {}, requestContext: { stage: 'staging' } }, depsFor(fakeClient()).deps);
  assert.equal(anonymous.statusCode, 401);
});

test('SQL 124 error codes map to clear 4xx messages; unknown errors are not masked', async () => {
  const expectations = {
    not_authorized: 403,
    not_assigned_to_you: 403,
    request_not_in_status: 409,
    request_has_no_check: 409,
    request_has_no_claim: 409,
    document_not_on_check: 400,
    invalid_document_name: 400,
    invalid_document_type: 400,
    invalid_signers: 400,
    'invalid_signer: 2': 400,
    'invalid_field_data: 3': 400,
    'missing_signature_field: 2': 400,
    invalid_expires_at: 400,
    claim_mismatch: 409,
    duplicate_signature_request: 409,
    signature_request_limit: 429,
    signature_request_not_on_check: 403,
    not_a_desk_signature_request: 403,
    not_your_signature_request: 403,
    signature_request_not_draft: 409,
    invalid_results: 400,
    invalid_kind: 400,
    invalid_note: 400,
  };
  for (const [message, status] of Object.entries(expectations)) {
    const mapped = mapMortgageDeskSqlError(sqlError(message));
    assert.equal(mapped?.statusCode, status, message);
    assert.ok(mapped.message && !/undefined/.test(mapped.message), message);
  }
  assert.equal(mapMortgageDeskSqlError(sqlError('invalid_signer: 2')).position, 2);
  assert.match(mapMortgageDeskSqlError(sqlError('missing_signature_field: 2')).message, /Signer 2 needs at least one signature field/);
  assert.equal(mapMortgageDeskSqlError(sqlError('function aws_x does not exist', '42883')), null);

  // Through the endpoint: a refusal raised inside (f) is a 4xx and nothing is sent.
  for (const [message, status] of [['claim_mismatch', 409], ['duplicate_signature_request', 409], ['signature_request_limit', 429], ['invalid_signer: 2', 400]]) {
    const sends = [];
    const { deps, clients } = depsFor(fakeClient({ raise: { [DESK_CREATE_SIGNATURE_SQL]: sqlError(message, message.startsWith('invalid') ? '22023' : '42501') } }), {
      sendViaSesOrSink: async (m) => { sends.push(m); return { results: [{ status: 'sunk' }] }; },
    });
    const out = await handleMortgageDeskEsign(event(SEND_BODY), deps);
    assert.equal(out.statusCode, status, message);
    assert.equal(out.error, message.split(':')[0]);
    assert.equal(sends.length, 0, message);
    assert.equal(clients.length, 1, message);
    assert.ok(!clients[0].queries.some((q) => q.sql === 'COMMIT'), message);
  }
  // A database failure that is not a SQL 124 refusal stays a 503.
  const broken = depsFor(fakeClient({ raise: { [DESK_MESSAGES_SQL]: sqlError('connection reset', '08006') } }));
  const out = await handleMortgageDeskEsign(event({ action: 'messages', request_id: REQUEST_ID }), broken.deps);
  assert.equal(out.statusCode, 503);
});

test('send: tokens are minted 64-hex and unique, (f) gets them in signing order, the server hashes them', async () => {
  const sends = [];
  const { deps, clients } = depsFor(() => fakeClient(), {
    sendViaSesOrSink: async (message) => {
      sends.push(message);
      return { mode: 'sink', results: [{ to: message.to, status: 'sunk', messageId: `sink-${sends.length}` }] };
    },
  });
  const out = await handleMortgageDeskEsign(event(SEND_BODY), deps);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(clients.length, 2, 'create and record are two transactions');

  const create = clients[0].queries.find((q) => q.sql === DESK_CREATE_SIGNATURE_SQL);
  assert.ok(create);
  assert.equal(create.params[0], REQUEST_ID);
  assert.equal(create.params[1], 'Third Party Authorization.pdf');
  assert.equal(create.params[2], DOC_PATH, 'query string dropped');
  assert.equal(create.params[3], 'work_authorization');
  assert.equal(JSON.parse(create.params[4]).length, 3);
  const signers = JSON.parse(create.params[5]);
  assert.deepEqual(signers.map((s) => s.signing_order), [1, 2]);
  assert.deepEqual(signers.map((s) => s.signer_type), ['policyholder', 'contractor']);
  for (const signer of signers) {
    assert.match(signer.access_token, /^[0-9a-f]{64}$/);
    assert.deepEqual(Object.keys(signer).sort(), ['access_token', 'signer_email', 'signer_name', 'signer_type', 'signing_order']);
  }
  assert.notEqual(signers[0].access_token, signers[1].access_token);
  // The expiry is the database's now() + 72 hours, the bound SQL 124 checks.
  assert.match(DESK_CREATE_SIGNATURE_SQL, /now\(\) \+ interval '72 hours'/);
  assert.equal(create.params.length, 6);
  assert.ok(clients[0].queries.some((q) => q.sql === 'COMMIT'), 'the create commits before any email');

  // Each email carries its own signer's token; the stored hash is sha256 of it.
  assert.equal(sends.length, 2);
  for (let i = 0; i < 2; i += 1) {
    const token = signers[i].access_token;
    assert.equal(sends[i].to, signers[i].signer_email);
    assert.ok(sends[i].html.includes(`/sign?token=${token}`));
    assert.ok(sends[i].text.includes(`/sign?token=${token}`));
    assert.equal(hashToken(token), (await import('node:crypto')).createHash('sha256').update(token, 'utf8').digest('hex'));
  }
  // The response never carries a token or a sign link.
  const json = JSON.stringify(out);
  for (const signer of signers) assert.ok(!json.includes(signer.access_token));
  assert.doesNotMatch(json, /sign\?token=/);
});

test('send: the email sender name is ChecksOps and the body is the tenant e-sign email', async () => {
  const sends = [];
  const { deps } = depsFor(() => fakeClient(), {
    sendViaSesOrSink: async (message) => { sends.push(message); return { results: [{ status: 'sunk', messageId: 'x' }] }; },
  });
  await handleMortgageDeskEsign(event(SEND_BODY), deps);
  for (const message of sends) {
    assert.match(message.from, /^ChecksOps <[^>]+@[^>]+>$/);
    assert.equal(message.subject, 'Action Required: Sign Third Party Authorization.pdf');
    assert.match(message.html, /Review &amp; Sign Document|Review & Sign Document/);
    assert.match(message.html, /CLM-9/);
    assert.match(message.html, /expires in 72 hours/);
  }
  assert.equal(MORTGAGE_DESK_ESIGN_SENDER_NAME, 'ChecksOps');
  const branding = mortgageDeskEsignBranding({ fromAddress: 'noreply@checksops.com', replyTo: 'support@checksops.com', primaryColor: '#123456', fromName: 'ChecksOps Staging' });
  assert.equal(branding.from, 'ChecksOps <noreply@checksops.com>');
  assert.equal(branding.company_name, 'ChecksOps');
});

test('send: (g) is called with one result per signer, failures included', async () => {
  let n = 0;
  const { deps, clients } = depsFor(() => fakeClient(), {
    sendViaSesOrSink: async () => {
      n += 1;
      if (n === 1) return { results: [{ status: 'sent', messageId: 'ses-1' }] };
      return { results: [{ status: 'failed', error: 'MessageRejected' }] };
    },
  });
  const out = await handleMortgageDeskEsign(event(SEND_BODY), deps);
  assert.equal(out.ok, true);
  assert.equal(out.sent, 1);
  assert.equal(out.failed, 1);
  const record = clients[1].queries.find((q) => q.sql === DESK_RECORD_DELIVERY_SQL);
  assert.ok(record);
  assert.equal(record.params[0], REQUEST_ID);
  assert.equal(record.params[1], SIG_ID);
  assert.deepEqual(JSON.parse(record.params[2]), [
    { signer_id: SIGNER_1, success: true, message_id: 'ses-1', error: null },
    { signer_id: SIGNER_2, success: false, message_id: null, error: 'MessageRejected' },
  ]);
  assert.ok(clients[1].queries.some((q) => q.sql === 'COMMIT'));
  assert.equal(out.delivery.provider_status, 'emails_partially_failed');

  // Every send throws: still recorded, reported as a failure.
  const all = depsFor(() => fakeClient(), { sendViaSesOrSink: async () => { throw new Error('ses down'); } });
  const failed = await handleMortgageDeskEsign(event(SEND_BODY), all.deps);
  assert.equal(failed.ok, false);
  assert.equal(failed.error, 'email_send_failed');
  assert.ok(all.clients[1].queries.some((q) => q.sql === DESK_RECORD_DELIVERY_SQL));

  // The record is refused: the caller is told not to resend.
  const refused = depsFor((i) => (i === 0 ? fakeClient() : fakeClient({ raise: { [DESK_RECORD_DELIVERY_SQL]: sqlError('signature_request_not_draft') } })), {
    sendViaSesOrSink: async () => ({ results: [{ status: 'sunk' }] }),
  });
  const notRecorded = await handleMortgageDeskEsign(event(SEND_BODY), refused.deps);
  assert.equal(notRecorded.ok, false);
  assert.equal(notRecorded.error, 'delivery_not_recorded');
  assert.equal(notRecorded.deliveryError, 'signature_request_not_draft');
});

test('send: input is checked before any write, with the SQL 124 rules', async () => {
  const bad = [
    [{ document_path: 'checks/x/photo.png' }, 'document_not_on_check'],
    [{ document_path: 'checks/../x.pdf' }, 'document_not_on_check'],
    [{ document_name: '' }, 'invalid_document_name'],
    [{ document_type: 'authorization' }, 'invalid_document_type'],
    [{ signers: [] }, 'invalid_signers'],
    [{ signers: Array.from({ length: 5 }, (_, i) => ({ signer_name: `S${i}`, signer_email: `s${i}@x.example` })) }, 'invalid_signers'],
    [{ signers: [SEND_BODY.signers[0], { ...SEND_BODY.signers[1], signer_type: 'staff' }] }, 'invalid_signer'],
    [{ signers: [SEND_BODY.signers[0], { ...SEND_BODY.signers[1], signer_email: 'nope' }] }, 'invalid_signer'],
    [{ signers: [SEND_BODY.signers[0], { ...SEND_BODY.signers[1], signing_order: 1 }] }, 'invalid_signer'],
    [{ field_data: [SEND_BODY.field_data[0]] }, 'missing_signature_field'],
    [{ field_data: [...SEND_BODY.field_data, { type: 'signature', signerIndex: 2 }] }, 'invalid_field_data'],
  ];
  for (const [patch, error] of bad) {
    const v = validateDeskSignatureInput({ ...SEND_BODY, ...patch });
    assert.equal(v.ok, false, error);
    assert.equal(v.error, error, JSON.stringify(patch));
    const { deps, clients } = depsFor(fakeClient());
    const out = await handleMortgageDeskEsign(event({ ...SEND_BODY, ...patch }), deps);
    assert.equal(out.error, error);
    assert.ok(out.statusCode >= 400 && out.statusCode < 500);
    assert.equal(definerCalls(clients[0]).length, 0);
  }
  assert.equal(validateDeskSignatureInput({ ...SEND_BODY, signers: [SEND_BODY.signers[0], SEND_BODY.signers[1]] }).signers[1].signing_order, 2);
  assert.equal(validateDeskSignatureInput({ ...SEND_BODY, document_path: `checks/${CHECK_ID}/files/a.DOCX` }).ok, true);
  assert.equal(validateDeskSignatureInput({ ...SEND_BODY, document_type: '' }).documentType, null);
});

test('post_timeline calls SQL 124 (h) with the kind and note; bad input is refused first', async () => {
  const { deps, clients } = depsFor(fakeClient());
  const out = await handleMortgageDeskEsign(event({ action: 'post_timeline', request_id: REQUEST_ID, kind: 'mortgage_followup', note: '  Called Acme  ', tenant_id: 'spoof', claim_id: 'spoof' }), deps);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.id, 'ledger-1');
  const call = clients[0].queries.find((q) => q.sql === DESK_POST_TIMELINE_SQL);
  assert.deepEqual(call.params, [REQUEST_ID, 'mortgage_followup', 'Called Acme']);
  assert.ok(clients[0].queries.some((q) => q.sql === 'COMMIT'));

  for (const body of [{ kind: 'note', note: 'x' }, { kind: 'mortgage_update', note: '' }, { kind: 'mortgage_update', note: 'x'.repeat(2001) }]) {
    const one = depsFor(fakeClient());
    const res = await handleMortgageDeskEsign(event({ action: 'post_timeline', request_id: REQUEST_ID, ...body }), one.deps);
    assert.equal(res.statusCode, 400);
    assert.equal(definerCalls(one.clients[0]).length, 0);
  }
  const noClaim = depsFor(fakeClient({ raise: { [DESK_POST_TIMELINE_SQL]: sqlError('request_has_no_claim', '22023') } }));
  const res = await handleMortgageDeskEsign(event({ action: 'post_timeline', request_id: REQUEST_ID, kind: 'mortgage_update', note: 'x' }), noClaim.deps);
  assert.equal(res.statusCode, 409);
  assert.ok(!noClaim.clients[0].queries.some((q) => q.sql === 'COMMIT'));
});

test('sign_url: Desk reads of claim-files are signed through SQL 124 (e); storage.mjs is not changed', async () => {
  const s3Calls = [];
  const s3 = (exists = true) => ({
    send: async (command) => {
      s3Calls.push(command.constructor.name);
      if (!exists) throw Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
      return {};
    },
  });
  const signed = [];
  const getSignedUrl = async (_s3, command, options) => {
    signed.push({ input: command.input, options });
    return `https://s3.example/${command.input.Key}?X-Amz-Signature=t`;
  };
  const withPath = (allowed) => {
    const base = fakeClient();
    const query = base.query;
    base.query = async (sql, params) => {
      if (sql === DESK_CAN_READ_PATH_SQL) {
        base.queries.push({ sql, params });
        return { rows: [{ ok: allowed }] };
      }
      return query(sql, params);
    };
    return base;
  };

  const ok = depsFor(withPath(true), { s3: s3(), getSignedUrl, filesBucket: 'files-bucket' });
  const out = await handleMortgageDeskEsign(event({ action: 'sign_url', request_id: REQUEST_ID, path: `${DOC_PATH}?x=1`, download: 'TPA.pdf' }), ok.deps);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.path, DOC_PATH);
  assert.match(out.signedUrl, /X-Amz-Signature/);
  const check = ok.clients[0].queries.find((q) => q.sql === DESK_CAN_READ_PATH_SQL);
  assert.equal(check.params[1], DOC_PATH);
  assert.ok(Array.isArray(check.params[0]) && check.params[0].includes(DOC_PATH));
  assert.equal(signed[0].input.Bucket, 'files-bucket');
  assert.equal(signed[0].input.Key, `files/claim-files/${DOC_PATH}`);
  assert.equal(signed[0].options.expiresIn, 300);
  assert.match(signed[0].input.ResponseContentDisposition, /filename="TPA.pdf"/);
  assert.deepEqual(s3Calls, ['HeadObjectCommand']);

  const denied = depsFor(withPath(false), { s3: s3(), getSignedUrl });
  const refused = await handleMortgageDeskEsign(event({ action: 'sign_url', request_id: REQUEST_ID, path: DOC_PATH }), denied.deps);
  assert.equal(refused.statusCode, 403);
  assert.equal(refused.error, 'storage_forbidden');
  assert.equal(signed.length, 1, 'nothing signed for a refused path');

  const missing = await handleMortgageDeskEsign(event({ action: 'sign_url', request_id: REQUEST_ID, path: DOC_PATH }), depsFor(withPath(true), { s3: s3(false), getSignedUrl }).deps);
  assert.equal(missing.statusCode, 404);
  const bad = await handleMortgageDeskEsign(event({ action: 'sign_url', request_id: REQUEST_ID, path: '' }), depsFor(withPath(true), { s3: s3(), getSignedUrl }).deps);
  assert.equal(bad.statusCode, 400);
  assert.match(DESK_CAN_READ_PATH_SQL, /public\.aws_mortgage_desk_can_read_path\(\$1::text\[\], \$2::text\)/);
  // storage.mjs keeps its rules: the Desk rule lives in the Desk module only.
  assert.doesNotMatch(read('aws/functions/api/storage.mjs'), /aws_mortgage_desk/);
});

test('the API calls each SQL 124 function with its exact signature, granted to checksops', () => {
  const sql = read('aws/workflows/sql/124_mortgage_desk_signature_and_reads.sql');
  const grants = [
    'aws_mortgage_desk_messages(uuid)',
    'aws_mortgage_desk_check_files(uuid)',
    'aws_mortgage_desk_signature_requests(uuid)',
    'aws_mortgage_desk_can_read_path(text[], text)',
    'aws_mortgage_desk_create_signature_request(uuid, text, text, text, jsonb, jsonb, timestamptz)',
    'aws_mortgage_desk_record_signature_delivery(uuid, uuid, jsonb)',
    'aws_mortgage_desk_post_timeline(uuid, text, text)',
  ];
  for (const fn of grants) {
    assert.ok(sql.includes(`GRANT EXECUTE ON FUNCTION public.${fn} TO checksops;`), fn);
  }
  assert.ok(!sql.includes('GRANT EXECUTE ON FUNCTION public.aws_mortgage_desk_readable_request(uuid)'));
  // The token lifetime matches the tenant flow and the SQL bound.
  assert.match(read('aws/functions/api/esign.mjs'), /const TOKEN_EXPIRY_HOURS = 72;/);
  assert.equal(MORTGAGE_DESK_ESIGN_EXPIRY_HOURS, 72);
  assert.match(sql, /_expires_at > now\(\) \+ interval '72 hours'/);
  // Tokens: 64 lowercase hex, stored with sha256 of the UTF-8 bytes (esign.mjs hashToken).
  assert.match(sql, /\^\[0-9a-f\]\{64\}\$/);
  assert.match(sql, /encode\(sha256\(convert_to\(v_tokens\[v_i\], 'UTF8'\)\), 'hex'\)/);
  assert.match(read('aws/functions/api/esign.mjs'), /export const generateRawToken = \(\) => randomBytes\(32\)\.toString\('hex'\);/);
});

test('tenant visibility: Desk requests carry the check and its claim, which the tenant list and RLS use', () => {
  const sql = read('aws/workflows/sql/124_mortgage_desk_signature_and_reads.sql');
  assert.match(sql, /INSERT INTO public\.signature_requests \(\s*id, claim_id, check_intake_item_id,[\s\S]*?VALUES \(\s*v_sig_id, v_check_claim, v_req\.check_intake_item_id,/);
  assert.match(sql, /SELECT ci\.claim_id INTO v_check_claim\s+FROM public\.check_intake_items ci/);
  // The tenant's Files tab lists signature_requests by the check's claim_id ...
  const files = read('src/components/check-review/CheckFilesSection.tsx');
  assert.match(files, /<SignatureRequests\s+claimId=\{linkedClaim\.id\}/);
  const list = read('src/components/claim-detail/SignatureRequests.tsx');
  assert.match(list, /\.from\("signature_requests"\)\s*\n\s*\.select\(`\s*\n\s*\*,\s*\n\s*signature_signers\(\*\)\s*\n\s*`\)\s*\n\s*\.eq\("claim_id", claimId\)/);
  assert.match(read('src/pages/CheckCommandCenter.tsx'), /<CheckFilesSection checkIntakeItemId=\{checkId\} claimId=\{check\?\.claim_id \?\? null\} \/>/);
  // ... and RLS admits a row by its check.
  assert.match(read('aws/rls/sql/12_final_select_policies.sql'), /CREATE POLICY aws_select_signature_requests ON public\.signature_requests\s+FOR SELECT TO authenticated\s+USING \(public\.aws_can_access_check\(check_intake_item_id\)\);/);
});

test('SPA helpers: payload, gates, signers and the function call', async () => {
  const payload = buildDeskSignaturePayload({
    requestId: REQUEST_ID,
    documentName: ' TPA.pdf ',
    documentPath: `${DOC_PATH}?x=1`,
    documentType: null,
    fieldData: [{ type: 'signature', signerIndex: 0 }],
    signers: [{ name: ' Pat ', email: ' pat@example.com ', type: 'policyholder' }],
  });
  assert.deepEqual(payload, {
    action: 'send_signature_request',
    request_id: REQUEST_ID,
    document_name: 'TPA.pdf',
    document_path: DOC_PATH,
    document_type: null,
    field_data: [{ type: 'signature', signerIndex: 0 }],
    signers: [{ signer_name: 'Pat', signer_email: 'pat@example.com', signer_type: 'policyholder' }],
  });
  assert.equal(validateDeskSignatureInput(payload).ok, true, 'the SPA payload passes the server check');

  const req = { status: 'in_progress', assigned_employee_id: AGENT };
  assert.equal(canWorkMortgageDeskRequest(req, AGENT, false), true);
  assert.equal(canWorkMortgageDeskRequest(req, OTHER_AGENT, false), false);
  assert.equal(canWorkMortgageDeskRequest(req, OTHER_AGENT, true), true);
  assert.equal(canWorkMortgageDeskRequest({ ...req, status: 'completed' }, AGENT, false), false);
  assert.equal(canReadMortgageDeskRequest({ ...req, status: 'completed' }, AGENT, false), true);
  assert.equal(canReadMortgageDeskRequest({ ...req, status: 'requested' }, AGENT, true), false);
  assert.equal(isDeskSignableFile('a/b.PDF?x'), true);
  assert.equal(isDeskSignableFile('a/b.docx'), true);
  assert.equal(isDeskSignableFile('a/b.doc'), false);
  assert.deepEqual(defaultDeskSigners({ homeownerName: 'Pat', homeownerEmail: 'p@x.example' }), [{ name: 'Pat', email: 'p@x.example', type: 'policyholder' }]);
  assert.match(deskSignersProblem([{ name: 'Pat', email: 'bad', type: 'policyholder' }]), /Signer 1/);
  assert.equal(deskSignersProblem([{ name: 'Pat', email: 'p@x.example', type: 'contractor' }]), null);
  assert.equal(deskSignerMissingSignature([{ type: 'signature', signerIndex: 0 }], 2), 2);

  const calls = [];
  const client = {
    functions: {
      invoke: async (name, { body }) => {
        calls.push({ name, body });
        if (body.action === 'workspace') return { data: { ok: true, data: { messages: [], check_files: [{ id: 'f1' }], signature_requests: [] } } };
        return { data: { ok: false, error: 'claim_mismatch', message: 'nice message' } };
      },
    },
  };
  const ws = await loadMortgageDeskWorkspace(client, REQUEST_ID);
  assert.equal(ws.data.check_files.length, 1);
  const tl = await postMortgageDeskTimeline(client, { requestId: REQUEST_ID, kind: 'mortgage_update', note: ' hi ' });
  assert.equal(tl.error, 'nice message');
  assert.deepEqual(calls.map((c) => c.name), ['mortgage-desk-esign', 'mortgage-desk-esign']);
  assert.deepEqual(calls[1].body, { action: 'post_timeline', request_id: REQUEST_ID, kind: 'mortgage_update', note: 'hi' });
  const thrown = await invokeMortgageDeskEsign({ functions: { invoke: async () => ({ data: null, error: new Error('HTTP 429') }) } }, {});
  assert.equal(thrown.error, 'HTTP 429');
});

test('SPA wiring: the Desk detail reads, uploads, sends and posts through SQL 124 on AWS', () => {
  const detail = read('src/pages/mortgage-ops/MortgageOpsRequestDetail.tsx');
  assert.match(detail, /loadMortgageDeskWorkspace\(deskEsignClient, r\.id\)/);
  assert.match(detail, /canReadMortgageDeskRequest\(r, user\?\.id, isPlatformOwner\(user\?\.email, user\?\.id\)\)/);
  assert.match(detail, /if \(!mortgageUsesAwsBackend\) \{\s*\n\s*const \{ data: fRows \} = await supabase\s*\n\s*\.from\("check_files"\)/);
  assert.match(detail, /if \(!mortgageUsesAwsBackend\) \{\s*\n\s*const \{ data: msgs \} = await supabase\s*\n\s*\.from\("check_messages"\)/);
  // Send for signature on each pdf/docx check file, for the working agent or the owner.
  assert.match(detail, /mortgageUsesAwsBackend && canWork && isDeskSignableFile\(f\.file_path\) && \(/);
  assert.match(detail, /openDeskSignature\(\{ name: f\.file_name, path: f\.file_path \}\)/);
  assert.match(detail, /const canWork = canWorkMortgageDeskRequest\(req, user\?\.id, platformOwner\);/);
  // Upload uses the SQL 122 attach path from the request's check id, then opens the Desk dialog.
  assert.match(detail, /\{req\.check_intake_item_id && canWork && \(/);
  assert.match(detail, /const checkId = check\?\.id \|\| req\?\.check_intake_item_id;/);
  assert.match(detail, /mortgageUsesAwsBackend && uploadForSignature && isDeskSignableFile\(path\)/);
  assert.match(detail, /<MortgageDeskSignatureDialog\s*\n\s*client=\{deskEsignClient\}/);
  assert.match(detail, /contractorDefaults=\{\{ tenantName: tenant\?\.name \}\}/);
  // Timeline note through (h) on AWS; Supabase keeps its direct insert.
  assert.match(detail, /postMortgageDeskTimeline\(\s*\n\s*deskEsignClient,\s*\n\s*\{ requestId: req\.id, kind: updateKind, note: updateNote \}/);
  assert.match(detail, /mortgageUsesAwsBackend \? canWork && !!req\.check_intake_item_id : !!req\.claim_id/);
  // Signature list per signer, signed PDFs readable, Desk messages labeled.
  assert.match(detail, /deskSignerStatusLabel\(sg\)/);
  assert.match(detail, /downloadFile\(s\.final_pdf_path \|\| s\.document_path, s\.document_name\)/);
  assert.match(detail, /m\.from_desk \? "Mortgage Desk" : "Tenant"/);

  const dialog = read('src/components/mortgage-ops/MortgageDeskSignatureDialog.tsx');
  assert.match(dialog, /import\("@\/components\/claim-detail\/FieldPlacementEditor"\)/);
  assert.match(dialog, /signerCount=\{signers\.length\}/);
  assert.match(dialog, /buildDeskSignaturePayload\(\{/);
  assert.match(dialog, /detectDocumentType\(document\.name\)/);
  assert.match(dialog, /<SelectItem value="policyholder">/);
  assert.match(dialog, /<SelectItem value="contractor">/);
  assert.doesNotMatch(dialog, /value="staff"|value="other"/);
  assert.doesNotMatch(dialog, /from\("signature_requests"\)|from\("signature_signers"\)/);
  assert.match(dialog, /signMortgageDeskFile\(client, \{ requestId, path: document\.path \}\)/);
  assert.match(detail, /signMortgageDeskFile\(deskEsignClient, \{ requestId: req\.id, path, download: name \}\)/);
});
