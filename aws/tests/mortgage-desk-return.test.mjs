/**
 * Mortgage Desk returns its work to the tenant (SQL 122): the agent-gated
 * message / document / shipping RPCs, the mid-work note and completion
 * hooks, the tenant "work returned" email, the Desk upload grant and the SPA
 * wiring. Fake clients only; SQL 122 itself is checked statically here (its
 * behaviour on PostgreSQL is not exercised by this file).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ATTACH_FILE_SQL,
  COMPLETION_TIMELINE_SQL,
  MORTGAGE_DESK_REQUEST_SQL,
  MORTGAGE_DESK_RPCS,
  MORTGAGE_DESK_UPLOAD_SQL,
  PLATFORM_OWNER_SQL,
  POST_MESSAGE_SQL,
  RETURN_EMAIL_CLAIM_SQL,
  UPDATE_SHIPPING_SQL,
  buildMortgageDeskNoteMessage,
  buildMortgageDeskReturnEmail,
  executeMortgageDeskRpc,
  isMortgageDeskFilePath,
  loadMortgageDeskWorkingRequest,
  mortgageDeskReturnLink,
  runMortgageDeskReturnEmail,
} from '../functions/api/mortgage-desk-return.mjs';
import {
  SAFE_WRITE_RPCS,
  SAFE_WRITE_RPC_CLASSIFICATION,
  executeSafeWriteRpc,
  handleSafeWriteRpc,
} from '../functions/api/workflow-rpc.mjs';
import { authorizeStorageWritePath } from '../functions/api/storage-write-auth.mjs';
import { CLASS_A_FUNCTIONS } from '../functions/api/app-services.mjs';
import { LOOKUP_MAPPING_SQL, USER_ROLES_SQL } from '../functions/api/identity.mjs';
import {
  attachMortgageDeskFile,
  buildMortgageDeskNoteMessage as buildNoteSpa,
  mortgageDeskFilePath,
  postMortgageDeskMessage,
  updateMortgageDeskShipping,
} from '../../src/lib/mortgageDeskWrites.ts';
import { selectMortgageDeskNotes } from '../../src/lib/mortgageDeskReturn.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const AGENT = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const OTHER_AGENT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TENANT_MEMBER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const CHECK_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_CHECK = '44444444-4444-4444-8444-444444444444';
const TENANT_A = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const TENANT_B = '55555555-5555-4555-8555-555555555555';

const PROVIDER_NAMES = /moov|check ?alt|stripe|plaid|dwolla|resend|telnyx/i;

/**
 * Fake pg client. `visibleRequest` is what RLS lets the caller see of the
 * request (null: not visible). Definer calls return canned rows and record
 * their params.
 */
const fakeClient = ({
  roles = [{ role: 'mortgage_agent' }],
  platformOwner = false,
  visibleRequest = {
    id: REQUEST_ID, tenant_id: TENANT_A, check_intake_item_id: CHECK_ID, status: 'in_progress', assigned_employee_id: AGENT,
  },
  failDefiner = false,
  claim = null,
  uploadRequestRows = [{ '?column?': 1 }],
  checkVisible = false,
} = {}) => {
  const queries = [];
  return {
    queries,
    connect: async () => {},
    end: async () => {},
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (['BEGIN', 'ROLLBACK', 'COMMIT', 'SET TRANSACTION READ WRITE'].includes(sql)) return { rows: [] };
      if (/^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)/.test(sql)) return { rows: [] };
      if (sql.startsWith('SELECT set_config')) return { rows: [] };
      if (sql === LOOKUP_MAPPING_SQL) {
        return { rows: [{ application_user_id: AGENT, cognito_sub: COGNITO_SUB, email: 'agent@checksops.test', status: 'active' }] };
      }
      if (sql === USER_ROLES_SQL) return { rows: roles };
      if (sql === PLATFORM_OWNER_SQL) return { rows: [{ is_owner: platformOwner }] };
      if (sql === MORTGAGE_DESK_REQUEST_SQL) return { rows: visibleRequest ? [visibleRequest] : [] };
      if (sql === MORTGAGE_DESK_UPLOAD_SQL) return { rows: uploadRequestRows };
      // A visible check here is the member's own, so it is writable (aws_can_write_check).
      if (sql === 'SELECT public.aws_can_write_check($1::uuid) AS ok') return { rows: [{ ok: checkVisible }] };
      if (/FROM public.check_intake_items WHERE id = \$1::uuid/.test(sql)) {
        return { rows: checkVisible ? [{ id: params[0], tenant_id: TENANT_A }] : [] };
      }
      if ([POST_MESSAGE_SQL, ATTACH_FILE_SQL, UPDATE_SHIPPING_SQL, COMPLETION_TIMELINE_SQL].includes(sql)) {
        if (failDefiner) throw Object.assign(new Error('function does not exist'), { code: '42883' });
        if (sql === POST_MESSAGE_SQL) return { rows: [{ id: 'm1', check_id: CHECK_ID, sender_id: AGENT, body: params[1] }] };
        if (sql === ATTACH_FILE_SQL) {
          return { rows: [{ id: 'f1', check_intake_item_id: CHECK_ID, file_path: params[2], source: 'mortgage_ops' }] };
        }
        if (sql === UPDATE_SHIPPING_SQL) return { rows: [{ id: REQUEST_ID, tenant_id: TENANT_A, ...JSON.parse(params[1]) }] };
        return { rows: [{ id: 'ledger-1' }] };
      }
      if (sql === RETURN_EMAIL_CLAIM_SQL) return { rows: [{ claim }] };
      if (/UPDATE public.mortgage_handling_requests/.test(sql) && /completed_at = CASE/.test(sql)) {
        return {
          rows: [{
            id: REQUEST_ID, tenant_id: TENANT_A, check_intake_item_id: CHECK_ID, status: params[1], assigned_employee_id: AGENT,
          }],
        };
      }
      if (/INSERT INTO public.email_send_log/.test(sql)) return { rows: [] };
      return { rows: [] };
    },
  };
};

const definerCalls = (client) => client.queries.filter((q) => (
  [POST_MESSAGE_SQL, ATTACH_FILE_SQL, UPDATE_SHIPPING_SQL, COMPLETION_TIMELINE_SQL, RETURN_EMAIL_CLAIM_SQL].includes(q.sql)
));

const agentMapping = { application_user_id: AGENT };

test('the Desk RPCs are safe write RPCs routed through executeSafeWriteRpc', () => {
  for (const name of ['mortgage_desk_post_message', 'mortgage_desk_attach_file', 'mortgage_desk_update_shipping']) {
    assert.ok(MORTGAGE_DESK_RPCS.has(name), name);
    assert.ok(SAFE_WRITE_RPCS.has(name), name);
    assert.equal(SAFE_WRITE_RPC_CLASSIFICATION[name], 'safe_now', name);
  }
  assert.ok(CLASS_A_FUNCTIONS.has('notify-mortgage-desk-return'));
  assert.match(read('aws/functions/api/app-services.mjs'), /case 'notify-mortgage-desk-return':\s*\n\s*return handleNotifyMortgageDeskReturn\(event\);/);
});

test('an agent not assigned to the request is refused and nothing is written', async () => {
  const client = fakeClient({
    visibleRequest: { id: REQUEST_ID, tenant_id: TENANT_A, check_intake_item_id: CHECK_ID, status: 'in_progress', assigned_employee_id: OTHER_AGENT },
  });
  for (const [name, args] of [
    ['mortgage_desk_post_message', { _request_id: REQUEST_ID, _body: 'hello' }],
    ['mortgage_desk_attach_file', { _request_id: REQUEST_ID, _file_name: 'a.pdf', _file_path: `checks/${CHECK_ID}/mortgage-ops/1-a.pdf` }],
    ['mortgage_desk_update_shipping', { _request_id: REQUEST_ID, _fields: { mail_to_name: 'Lender' } }],
  ]) {
    const result = await executeSafeWriteRpc({ client, mapping: agentMapping, name, args });
    assert.equal(result.error, 'not_assigned_to_you', name);
  }
  assert.equal(definerCalls(client).length, 0);
});

test('a request that is not in progress is refused', async () => {
  for (const status of ['requested', 'completed', 'cancelled']) {
    const client = fakeClient({
      visibleRequest: { id: REQUEST_ID, tenant_id: TENANT_A, check_intake_item_id: CHECK_ID, status, assigned_employee_id: AGENT },
    });
    const result = await executeMortgageDeskRpc({
      client, mapping: agentMapping, name: 'mortgage_desk_post_message', args: { _request_id: REQUEST_ID, _body: 'x' },
    });
    assert.equal(result.error, 'request_not_in_progress', status);
    assert.equal(definerCalls(client).length, 0);
  }
});

test('a tenant member cannot use the agent path, for its own or another tenant', async () => {
  // Own tenant: the request is visible (tenant SELECT policy) but the caller is no agent.
  const own = fakeClient({ roles: [] });
  const ownResult = await executeMortgageDeskRpc({
    client: own, mapping: { application_user_id: TENANT_MEMBER }, name: 'mortgage_desk_post_message',
    args: { _request_id: REQUEST_ID, _body: 'spoofed desk note' },
  });
  assert.equal(ownResult.error, 'not_authorized');
  // Another tenant's request: RLS hides it, so it is refused like a request it may not work.
  const other = fakeClient({ roles: [], visibleRequest: null });
  const otherResult = await executeMortgageDeskRpc({
    client: other, mapping: { application_user_id: TENANT_MEMBER }, name: 'mortgage_desk_update_shipping',
    args: { _request_id: REQUEST_ID, _fields: { mail_to_name: 'x' }, tenant_id: TENANT_B },
  });
  assert.equal(otherResult.error, 'not_authorized');
  assert.equal(definerCalls(own).length + definerCalls(other).length, 0);
});

test('the assigned agent posts a message; check and tenant come from the request, not the client', async () => {
  const client = fakeClient();
  const result = await executeMortgageDeskRpc({
    client,
    mapping: agentMapping,
    name: 'mortgage_desk_post_message',
    args: { _request_id: REQUEST_ID, _body: '  Called the lender  ', check_id: OTHER_CHECK, tenant_id: TENANT_B },
  });
  assert.equal(result.error, undefined);
  const calls = definerCalls(client);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sql, POST_MESSAGE_SQL);
  assert.deepEqual(calls[0].params, [REQUEST_ID, 'Called the lender']);
  assert.equal(result.data.check_id, CHECK_ID);
  assert.ok(!JSON.stringify(calls[0].params).includes(TENANT_B));
  assert.ok(!JSON.stringify(calls[0].params).includes(OTHER_CHECK));
});

test('the assigned agent attaches a document under the request check mortgage-ops prefix only', async () => {
  const client = fakeClient();
  const bad = await executeMortgageDeskRpc({
    client, mapping: agentMapping, name: 'mortgage_desk_attach_file',
    args: { _request_id: REQUEST_ID, _file_name: 'a.pdf', _file_path: `checks/${OTHER_CHECK}/mortgage-ops/1-a.pdf` },
  });
  assert.equal(bad.error, 'invalid_field');
  const traversal = await executeMortgageDeskRpc({
    client, mapping: agentMapping, name: 'mortgage_desk_attach_file',
    args: { _request_id: REQUEST_ID, _file_name: 'a.pdf', _file_path: `checks/${CHECK_ID}/mortgage-ops/../front.jpg` },
  });
  assert.equal(traversal.error, 'invalid_field');
  const badCategory = await executeMortgageDeskRpc({
    client, mapping: agentMapping, name: 'mortgage_desk_attach_file',
    args: { _request_id: REQUEST_ID, _file_name: 'a.pdf', _file_path: `checks/${CHECK_ID}/mortgage-ops/1-a.pdf`, _category: 'manual' },
  });
  assert.equal(badCategory.error, 'invalid_field');
  assert.equal(definerCalls(client).length, 0);

  const ok = await executeMortgageDeskRpc({
    client, mapping: agentMapping, name: 'mortgage_desk_attach_file',
    args: {
      _request_id: REQUEST_ID,
      _file_name: 'payoff.pdf',
      _file_path: `checks/${CHECK_ID}/mortgage-ops/1700000000000-payoff.pdf`,
      _file_type: 'application/pdf',
      _file_size: 1234,
      _category: 'mortgage_ops',
      _description: 'Payoff letter',
      source: 'manual',
      uploaded_by: OTHER_AGENT,
    },
  });
  assert.equal(ok.error, undefined);
  const [call] = definerCalls(client);
  assert.equal(call.sql, ATTACH_FILE_SQL);
  assert.deepEqual(call.params, [
    REQUEST_ID, 'payoff.pdf', `checks/${CHECK_ID}/mortgage-ops/1700000000000-payoff.pdf`,
    'application/pdf', 1234, 'mortgage_ops', 'Payoff letter',
  ]);
  assert.equal(ok.data.source, 'mortgage_ops');
});

test('the assigned agent updates shipping fields; other columns are refused', async () => {
  const client = fakeClient();
  const refused = await executeMortgageDeskRpc({
    client, mapping: agentMapping, name: 'mortgage_desk_update_shipping',
    args: { _request_id: REQUEST_ID, _fields: { status: 'completed' } },
  });
  assert.equal(refused.error, 'column_not_allowlisted');
  const billing = await executeMortgageDeskRpc({
    client, mapping: agentMapping, name: 'mortgage_desk_update_shipping',
    args: { _request_id: REQUEST_ID, _fields: { invoice_shipping_cents: '100' } },
  });
  assert.equal(billing.error, 'column_not_allowlisted');
  const badLabel = await executeMortgageDeskRpc({
    client, mapping: agentMapping, name: 'mortgage_desk_update_shipping',
    args: { _request_id: REQUEST_ID, _fields: { shipping_label_path: `checks/${OTHER_CHECK}/mortgage-ops/label.pdf` } },
  });
  assert.equal(badLabel.error, 'invalid_field');
  assert.equal(definerCalls(client).length, 0);

  const fields = {
    mail_to_name: 'Lender Loss Drafts',
    mail_to_address: 'PO Box 1\nCity, ST 00000',
    shipping_label_carrier: 'UPS',
    shipping_label_tracking: '1Z999',
    check_sent_date: '2026-10-27T15:00:00.000Z',
  };
  const ok = await executeMortgageDeskRpc({
    client, mapping: agentMapping, name: 'mortgage_desk_update_shipping', args: { _request_id: REQUEST_ID, _fields: fields },
  });
  assert.equal(ok.error, undefined);
  const [call] = definerCalls(client);
  assert.equal(call.sql, UPDATE_SHIPPING_SQL);
  assert.equal(call.params[0], REQUEST_ID);
  assert.deepEqual(JSON.parse(call.params[1]), fields);
  assert.equal(ok.data.tenant_id, TENANT_A);
});

test('the platform owner may write for an in-progress request it is not assigned to', async () => {
  const client = fakeClient({
    roles: [],
    platformOwner: true,
    visibleRequest: { id: REQUEST_ID, tenant_id: TENANT_A, check_intake_item_id: CHECK_ID, status: 'in_progress', assigned_employee_id: OTHER_AGENT },
  });
  const gate = await loadMortgageDeskWorkingRequest(client, AGENT, REQUEST_ID);
  assert.equal(gate.platformOwner, true);
  assert.equal(gate.request.tenant_id, TENANT_A);
});

test('a mid-work note is also posted on the check thread for the tenant', async () => {
  const client = fakeClient();
  const result = await executeSafeWriteRpc({
    client, mapping: agentMapping, name: 'update_mortgage_handling_request_status',
    args: { _request_id: REQUEST_ID, _status: 'in_progress', _notes: 'Lender wants a W-9' },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.data.tenant_message_posted, true);
  const [call] = definerCalls(client);
  assert.equal(call.sql, POST_MESSAGE_SQL);
  assert.deepEqual(call.params, [REQUEST_ID, '📝 ChecksOps Mortgage Desk note: Lender wants a W-9']);
  assert.ok(client.queries.some((q) => q.sql === 'SAVEPOINT mortgage_desk_note_message'));
});

test('a failed note post never fails the note append; it is rolled back to the savepoint and reported', async () => {
  const client = fakeClient({ failDefiner: true });
  const result = await executeSafeWriteRpc({
    client, mapping: agentMapping, name: 'update_mortgage_handling_request_status',
    args: { _request_id: REQUEST_ID, _status: 'in_progress', _notes: 'note' },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.data.tenant_message_posted, false);
  assert.ok(client.queries.some((q) => q.sql === 'ROLLBACK TO SAVEPOINT mortgage_desk_note_message'));
});

test('a status change without a note posts nothing; completion posts the homeowner timeline row', async () => {
  const quiet = fakeClient();
  await executeSafeWriteRpc({
    client: quiet, mapping: agentMapping, name: 'update_mortgage_handling_request_status',
    args: { _request_id: REQUEST_ID, _status: 'in_progress', _notes: '   ' },
  });
  assert.equal(definerCalls(quiet).length, 0);

  const done = fakeClient();
  const result = await executeSafeWriteRpc({
    client: done, mapping: agentMapping, name: 'update_mortgage_handling_request_status',
    args: { _request_id: REQUEST_ID, _status: 'completed', _notes: 'Endorsed and mailed back' },
  });
  assert.equal(result.data.homeowner_timeline_posted, true);
  const calls = definerCalls(done);
  assert.deepEqual(calls.map((c) => c.sql), [COMPLETION_TIMELINE_SQL]);
  assert.deepEqual(calls[0].params, [REQUEST_ID]);
});

const CLAIM = {
  claimed: true,
  request_id: REQUEST_ID,
  tenant_id: TENANT_A,
  tenant_name: 'Freedom Adjusting',
  tenant_slug: 'freedom',
  check_id: CHECK_ID,
  check_number: '100234',
  mortgage_company: 'Acme Mortgage',
  completed_at: '2026-10-27T15:00:00Z',
  note: 'Endorsed by Acme; original check mailed back by UPS 1Z999.',
  documents: [{ file_name: 'endorsed-check.pdf', category: 'mortgage_ops' }, { file_name: 'label.pdf', category: 'mortgage_ops_shipping_label' }],
  recipients: ['Owner@Freedom.test'],
  recipient_source: 'requester',
};

test('the completion email carries the Desk note, the documents and the check link, and no provider name', () => {
  const link = mortgageDeskReturnLink(CLAIM, 'https://app.checksops.test/');
  assert.equal(link, 'https://app.checksops.test/freedom/checks');
  const email = buildMortgageDeskReturnEmail(CLAIM, { link, branding: { logoUrl: null } });
  for (const part of [email.text, email.html]) {
    assert.ok(part.includes('Endorsed by Acme; original check mailed back by UPS 1Z999.'));
    assert.ok(part.includes('endorsed-check.pdf'));
    assert.ok(part.includes('label.pdf'));
    assert.ok(part.includes('https://app.checksops.test/freedom/checks'));
    assert.doesNotMatch(part, PROVIDER_NAMES);
  }
  assert.match(email.subject, /check #100234/);
  assert.match(email.subject, /Acme Mortgage/);
  assert.doesNotMatch(email.subject, PROVIDER_NAMES);
  const bare = buildMortgageDeskReturnEmail({ ...CLAIM, note: null, documents: [] }, { link, branding: {} });
  assert.match(bare.text, /left no closing note/);
  assert.match(bare.text, /No documents were attached/);
});

test('the return email is sent once to the claimed recipients; a failed send rolls the claim back', async () => {
  const sends = [];
  const send = async (message) => {
    sends.push(message);
    return { mode: 'sink', results: message.to.map((to) => ({ to, status: 'sunk', delivery: 'sink', messageId: 'sink-1' })) };
  };
  const client = fakeClient({
    claim: CLAIM,
    visibleRequest: { id: REQUEST_ID, tenant_id: TENANT_A, check_intake_item_id: CHECK_ID, status: 'completed', assigned_employee_id: AGENT },
  });
  const out = await runMortgageDeskReturnEmail({ client, mapping: agentMapping, requestId: REQUEST_ID, send, env: {} });
  assert.equal(out.ok, true);
  assert.equal(out.emailed, true);
  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0].to, ['owner@freedom.test']);
  assert.ok(sends[0].text.includes(CLAIM.note));
  assert.ok(client.queries.some((q) => /INSERT INTO public.email_send_log/.test(q.sql)));

  const already = fakeClient({
    claim: { claimed: false, reason: 'already_sent' },
    visibleRequest: { id: REQUEST_ID, tenant_id: TENANT_A, check_intake_item_id: CHECK_ID, status: 'completed', assigned_employee_id: AGENT },
  });
  const again = await runMortgageDeskReturnEmail({ client: already, mapping: agentMapping, requestId: REQUEST_ID, send, env: {} });
  assert.equal(again.status, 'already_sent');
  assert.equal(sends.length, 1);

  const failing = fakeClient({
    claim: CLAIM,
    visibleRequest: { id: REQUEST_ID, tenant_id: TENANT_A, check_intake_item_id: CHECK_ID, status: 'completed', assigned_employee_id: AGENT },
  });
  const failed = await runMortgageDeskReturnEmail({
    client: failing, mapping: agentMapping, requestId: REQUEST_ID, env: {},
    send: async (m) => ({ mode: 'ses', results: m.to.map((to) => ({ to, status: 'failed', error: 'throttled' })) }),
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.error, 'email_send_failed');

  const notAssigned = fakeClient({
    claim: CLAIM,
    visibleRequest: { id: REQUEST_ID, tenant_id: TENANT_A, check_intake_item_id: CHECK_ID, status: 'completed', assigned_employee_id: OTHER_AGENT },
  });
  const refused = await runMortgageDeskReturnEmail({ client: notAssigned, mapping: agentMapping, requestId: REQUEST_ID, send, env: {} });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'not_assigned_to_you');
  assert.equal(definerCalls(notAssigned).length, 0);

  const off = await runMortgageDeskReturnEmail({
    client: fakeClient(), mapping: agentMapping, requestId: REQUEST_ID, send, env: { AWS_MORTGAGE_DESK_RETURN_EMAIL_ENABLED: 'false' },
  });
  assert.equal(off.status, 'disabled');
});

test('completing through /data/rpc emails the tenant after the completion commits', async () => {
  const prev = process.env.AWS_APPLICATION_WORKFLOW_WRITES_ENABLED;
  process.env.AWS_APPLICATION_WORKFLOW_WRITES_ENABLED = 'true';
  const sends = [];
  const clients = [];
  try {
    const result = await handleSafeWriteRpc({
      rawPath: '/data/rpc',
      headers: { authorization: 'Bearer test-id-token' },
      body: JSON.stringify({
        name: 'update_mortgage_handling_request_status',
        args: { _request_id: REQUEST_ID, _status: 'completed', _notes: 'done' },
      }),
      requestContext: {
        stage: 'staging',
        http: { method: 'POST', path: '/data/rpc' },
        authorizer: { jwt: { claims: { sub: COGNITO_SUB, email: 'agent@checksops.test', token_use: 'id' } } },
      },
    }, {
      loadDatabaseCredentials: async () => ({ host: 'x', username: 'checksops', password: 'x', database: 'checksops' }),
      createClient: () => {
        // First transaction: the completion. Second: the email claim (request now completed).
        const client = clients.length === 0
          ? fakeClient()
          : fakeClient({
            claim: CLAIM,
            visibleRequest: { id: REQUEST_ID, tenant_id: TENANT_A, check_intake_item_id: CHECK_ID, status: 'completed', assigned_employee_id: AGENT },
          });
        clients.push(client);
        return client;
      },
      forceEnabled: true,
      sendViaSesOrSink: async (message) => {
        sends.push(message);
        return { mode: 'sink', results: message.to.map((to) => ({ to, status: 'sunk', delivery: 'sink' })) };
      },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(clients.length, 2);
    assert.ok(clients[0].queries.some((q) => q.sql === 'COMMIT'));
    assert.ok(clients[1].queries.some((q) => q.sql === RETURN_EMAIL_CLAIM_SQL));
    assert.equal(sends.length, 1);
    assert.deepEqual(result.data.return_email, { status: 'sent', emailed: true });
  } finally {
    if (prev === undefined) delete process.env.AWS_APPLICATION_WORKFLOW_WRITES_ENABLED;
    else process.env.AWS_APPLICATION_WORKFLOW_WRITES_ENABLED = prev;
  }
});

test('storage: the assigned agent may create objects under the check mortgage-ops prefix only', async () => {
  const deskPath = `checks/${CHECK_ID}/mortgage-ops/1700000000000-payoff.pdf`;
  const ok = await authorizeStorageWritePath(fakeClient(), 'claim-files', deskPath, AGENT);
  assert.equal(ok.ok, true);
  assert.equal(ok.strategy, 'mortgage_desk');
  assert.equal(ok.createOnly, true);

  const elsewhere = await authorizeStorageWritePath(fakeClient(), 'claim-files', `checks/${CHECK_ID}/front.jpg`, AGENT);
  assert.equal(elsewhere.ok, false);
  const nested = await authorizeStorageWritePath(fakeClient(), 'claim-files', `checks/${CHECK_ID}/mortgage-ops/a/b.pdf`, AGENT);
  assert.equal(nested.ok, false);
  const notAssigned = await authorizeStorageWritePath(fakeClient({ uploadRequestRows: [] }), 'claim-files', deskPath, AGENT);
  assert.equal(notAssigned.ok, false);
  const notAgent = await authorizeStorageWritePath(fakeClient({ roles: [] }), 'claim-files', deskPath, TENANT_MEMBER);
  assert.equal(notAgent.ok, false);
  // A tenant member who can see its own check keeps the existing check strategy.
  const member = await authorizeStorageWritePath(fakeClient({ roles: [], checkVisible: true }), 'claim-files', deskPath, TENANT_MEMBER);
  assert.equal(member.strategy, 'check');
});

test('Desk file paths and note bodies', () => {
  assert.equal(isMortgageDeskFilePath(`checks/${CHECK_ID}/mortgage-ops/x.pdf`, CHECK_ID), true);
  assert.equal(isMortgageDeskFilePath(`checks/${CHECK_ID}/mortgage-ops/`, CHECK_ID), false);
  assert.equal(isMortgageDeskFilePath(`checks/${CHECK_ID}/files/x.pdf`, CHECK_ID), false);
  assert.equal(buildMortgageDeskNoteMessage('  hi '), '📝 ChecksOps Mortgage Desk note: hi');
  assert.equal(buildMortgageDeskNoteMessage(''), null);
  assert.equal(buildNoteSpa('hi'), buildMortgageDeskNoteMessage('hi'));
  const p = mortgageDeskFilePath(CHECK_ID, 'my ../file.pdf', 'label-', 42);
  assert.equal(p, `checks/${CHECK_ID}/mortgage-ops/label-42-my___file.pdf`);
  assert.equal(isMortgageDeskFilePath(p, CHECK_ID), true);
});

const fakeSpaClient = () => {
  const calls = [];
  return {
    calls,
    rpc: async (name, args) => { calls.push({ kind: 'rpc', name, args }); return { data: {}, error: null }; },
    from: (table) => ({
      insert: async (values) => { calls.push({ kind: 'insert', table, values }); return { data: null, error: null }; },
      update: (values) => ({
        eq: async (column, value) => { calls.push({ kind: 'update', table, values, column, value }); return { data: null, error: null }; },
      }),
    }),
  };
};

test('SPA write helpers: AWS calls the agent-gated RPCs, Supabase keeps direct writes', async () => {
  const aws = fakeSpaClient();
  await postMortgageDeskMessage(aws, true, { requestId: REQUEST_ID, checkId: CHECK_ID, senderId: AGENT, body: 'b' });
  await attachMortgageDeskFile(aws, true, {
    requestId: REQUEST_ID, checkId: CHECK_ID, senderId: AGENT, fileName: 'a.pdf', filePath: 'p', fileType: null, fileSize: 1, category: 'mortgage_ops', description: null,
  });
  await updateMortgageDeskShipping(aws, true, { requestId: REQUEST_ID, senderId: AGENT, fields: { mail_to_name: 'x' } });
  assert.deepEqual(aws.calls.map((c) => c.kind), ['rpc', 'rpc', 'rpc']);
  assert.deepEqual(aws.calls.map((c) => c.name), ['mortgage_desk_post_message', 'mortgage_desk_attach_file', 'mortgage_desk_update_shipping']);
  assert.deepEqual(aws.calls[0].args, { _request_id: REQUEST_ID, _body: 'b' });

  const legacy = fakeSpaClient();
  await postMortgageDeskMessage(legacy, false, { requestId: REQUEST_ID, checkId: CHECK_ID, senderId: AGENT, body: 'b' });
  await attachMortgageDeskFile(legacy, false, {
    requestId: REQUEST_ID, checkId: CHECK_ID, senderId: AGENT, fileName: 'a.pdf', filePath: 'p', fileType: null, fileSize: 1, category: 'mortgage_ops', description: null,
  });
  await updateMortgageDeskShipping(legacy, false, { requestId: REQUEST_ID, senderId: AGENT, fields: { shipping_label_path: 'p' } });
  assert.deepEqual(legacy.calls.map((c) => `${c.kind}:${c.table}`), ['insert:check_messages', 'insert:check_files', 'update:mortgage_handling_requests']);
  assert.equal(legacy.calls[1].values.source, 'mortgage_ops');
  assert.equal(legacy.calls[2].values.shipping_label_uploaded_by, AGENT);
});

test('tenant view selects every Desk note and leaves out the return bookkeeping', () => {
  const messages = [
    { id: '1', sender_id: AGENT, body: '📝 ChecksOps Mortgage Desk note: called lender', created_at: '2026-10-20T10:00:00Z', is_deleted: false },
    { id: '2', sender_id: TENANT_MEMBER, body: 'tenant chatter', created_at: '2026-10-20T11:00:00Z', is_deleted: false },
    { id: '3', sender_id: AGENT, body: `MORTGAGE_DESK_RETURN:${REQUEST_ID} Mortgage Desk completed work on this check.`, created_at: '2026-10-21T10:00:00Z', is_deleted: false },
    { id: '4', sender_id: AGENT, body: '✅ ChecksOps Mortgage Desk completed work with Acme. Notes: done', created_at: '2026-10-21T09:59:00Z', is_deleted: false },
    { id: '5', sender_id: AGENT, body: 'deleted', created_at: '2026-10-20T12:00:00Z', is_deleted: true },
    { id: '6', sender_id: OTHER_AGENT, body: '📎 Mortgage Ops attached a document: "a.pdf".', created_at: '2026-10-19T12:00:00Z', is_deleted: false },
  ];
  assert.deepEqual(selectMortgageDeskNotes(messages, [AGENT]).map((m) => m.id), ['6', '1', '4']);
});

test('SPA wiring: Desk writes go through the helpers, the tenant sees notes and documents, Review opens them', () => {
  const detail = read('src/pages/mortgage-ops/MortgageOpsRequestDetail.tsx');
  assert.doesNotMatch(detail, /from\("check_messages"\)\.insert/);
  assert.doesNotMatch(detail, /from\("check_files"\)\.insert/);
  assert.match(detail, /postMortgageDeskMessage\(deskClient, mortgageUsesAwsBackend/);
  assert.match(detail, /attachMortgageDeskFile\(deskClient, mortgageUsesAwsBackend/);
  assert.match(detail, /updateMortgageDeskShipping\(deskClient, mortgageUsesAwsBackend/);
  assert.match(detail, /category: "mortgage_ops_shipping_label"/);
  assert.match(detail, /fields: \{ \[field\]: new Date\(\)\.toISOString\(\) \}/);
  // The tenant updates card needs only the request's check id (an agent cannot
  // read the check row on AWS), and its composer follows the server rule.
  assert.match(detail, /\{req\.check_intake_item_id && \(\s*\n\s*<Card>\s*\n\s*<CardContent className="pt-4 space-y-3">\s*\n\s*<div[^>]*>\s*\n\s*<Send className="h-4 w-4" \/> Updates to tenant/);
  assert.match(detail, /req\.status === "in_progress" &&\s*\n\s*\(req\.assigned_employee_id === user\?\.id \|\| isPlatformOwner\(user\?\.email, user\?\.id\)\) && \(\s*\n\s*<div className="space-y-2">\s*\n\s*<Textarea/);
  assert.match(detail, /checkId: req\.check_intake_item_id,/);

  const queue = read('src/pages/mortgage-ops/MortgageOpsQueue.tsx');
  assert.match(queue, /toast\.success\("Marked complete"\);/);
  assert.doesNotMatch(queue, /title: "Mortgage company step complete",\s*\n\s*description:/);
  assert.match(queue, /if \(!mortgageUsesAwsBackend && row\.claim_id\) \{\s*\n\s*void supabase\.from\("homeowner_ledger_events"\)\.insert\(\{\s*\n\s*tenant_id: row\.tenant_id,/);
  assert.match(queue, /tenant_message_posted/);
  assert.match(queue, /buildMortgageDeskNoteMessage\(notes\)/);
  assert.match(queue, /return_email/);

  const work = read('src/components/loss-draft/MortgageDeskReturnedWork.tsx');
  assert.match(work, /\.eq\("source", MORTGAGE_DESK_FILE_SOURCE\)/);
  assert.match(work, /selectMortgageDeskNotes\(/);
  assert.match(work, /id=\{mortgageDeskReturnedWorkAnchorId\(checkId\)\}/);
  assert.match(work, /\.from\("claim-files"\)\s*\n\s*\.createSignedUrl\(file\.file_path/);

  const panel = read('src/components/loss-draft/LossDraftDetailPanel.tsx');
  assert.match(panel, /<MortgageDeskReturnedWork checkId=\{draft\.check_intake_item_id\} \/>/);
  assert.match(panel, /scrollToMortgageDeskReturnedWork\(draft\.check_intake_item_id\)/);
  assert.doesNotMatch(panel, /onReview=\{\(\) => setActiveTab\("docs"\)\}/);

  const monitoring = read('src/components/checks/CheckMortgageMonitoring.tsx');
  assert.match(monitoring, /<MortgageDeskReturnedWork checkId=\{checkId\} \/>/);
  assert.match(monitoring, /onReview=\{\(\) => scrollToMortgageDeskReturnedWork\(checkId\)\}/);
});

test('SQL 122 is a guarded, idempotent DEFINER-function migration with no policy or table grant', () => {
  const sql = read('aws/workflows/sql/122_mortgage_desk_return_to_tenant.sql');
  assert.match(sql, /sql122_prerequisite_missing/);
  assert.match(sql, /sql122_definer_cannot_write/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS return_emailed_at timestamptz/);
  assert.doesNotMatch(sql, /^\s*(BEGIN|COMMIT)\s*;/m);
  assert.doesNotMatch(sql, /CREATE POLICY|ALTER POLICY|ENABLE ROW LEVEL SECURITY|FORCE ROW LEVEL SECURITY;/);
  assert.doesNotMatch(sql, /GRANT [^;]* ON TABLE/);
  assert.doesNotMatch(sql, /SET row_security/);
  const fns = [
    'aws_mortgage_desk_post_message(uuid, text)',
    'aws_mortgage_desk_attach_file(uuid, text, text, text, bigint, text, text)',
    'aws_mortgage_desk_update_shipping(uuid, jsonb)',
    'aws_mortgage_desk_completion_timeline(uuid)',
    'aws_mortgage_desk_return_email_claim(uuid)',
  ];
  for (const fn of fns) {
    assert.ok(sql.includes(`REVOKE ALL ON FUNCTION public.${fn} FROM PUBLIC;`), fn);
    assert.ok(sql.includes(`GRANT EXECUTE ON FUNCTION public.${fn} TO checksops;`), fn);
  }
  assert.ok(sql.includes('REVOKE ALL ON FUNCTION public.aws_mortgage_desk_working_request(uuid, text[]) FROM PUBLIC;'));
  assert.doesNotMatch(sql, /GRANT EXECUTE ON FUNCTION public\.aws_mortgage_desk_working_request/);
  assert.equal((sql.match(/SECURITY DEFINER\nSET search_path = public/g) || []).length, 6);
  // Every Desk write is gated by the assigned-agent check.
  assert.equal((sql.match(/v_req := public\.aws_mortgage_desk_working_request\(/g) || []).length, 5);
  assert.match(sql, /assigned_employee_id IS DISTINCT FROM v_uid/);
  assert.match(sql, /'checks\/' \|\| v_req\.check_intake_item_id::text \|\| '\/mortgage-ops\/'/);
  assert.doesNotMatch(sql, /moov|checkalt|stripe/i);
});
