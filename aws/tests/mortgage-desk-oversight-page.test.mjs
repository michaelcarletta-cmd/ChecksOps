// Tenant Management → Mortgage Desk (SQL 158; owner 2026-11-12): every tenant's Desk requests by status with their
// age, assign a queued request (it starts), "Message agent" (an email and a private note), the agent directory; and on
// the agent's request page, Tenant Management's notes, shown only to the assigned agent and the platform owner.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveAdminTenantTab } from '../../src/lib/adminTenantTab.ts';
import {
  MORTGAGE_DESK_AGENT_NOTE_MAX,
  MORTGAGE_DESK_OVERSIGHT_PAGE,
  assignDeskAgent,
  canAssignDeskRequest,
  canMessageDeskAgent,
  canReadMortgageDeskAgentNotes,
  deskAgeIsLate,
  deskAgentNoteError,
  deskNoteEmailLabel,
  deskOversightStatusLabel,
  deskRequestLabel,
  formatDeskAge,
  loadDeskAgentNotes,
  loadDeskAssignableAgents,
  loadDeskOverview,
  messageDeskAgent,
} from '../../src/lib/mortgageDeskOversight.ts';
import { MORTGAGE_DESK_ESIGN_FUNCTION } from '../../src/lib/mortgageDeskEsign.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const fakeClient = (reply) => {
  const calls = [];
  return {
    calls,
    functions: {
      invoke: async (name, options) => {
        calls.push({ name, body: options.body });
        return typeof reply === 'function' ? reply(options.body) : reply;
      },
    },
  };
};

test('age: the two largest units; a day queued or three days in progress is late', () => {
  assert.equal(formatDeskAge(0), '<1m');
  assert.equal(formatDeskAge(59), '<1m');
  assert.equal(formatDeskAge(60), '1m');
  assert.equal(formatDeskAge(3600), '1h');
  assert.equal(formatDeskAge(3660 + 240), '1h 5m');
  assert.equal(formatDeskAge(86400), '1d');
  assert.equal(formatDeskAge(2 * 86400 + 4 * 3600 + 59), '2d 4h');
  assert.equal(formatDeskAge('7200'), '2h');
  for (const bad of [null, undefined, '', -1, 'x']) assert.equal(formatDeskAge(bad), '—', String(bad));
  assert.equal(deskAgeIsLate({ status: 'requested', seconds_in_status: 86399 }), false);
  assert.equal(deskAgeIsLate({ status: 'requested', seconds_in_status: 86400 }), true);
  assert.equal(deskAgeIsLate({ status: 'in_progress', seconds_in_status: 3 * 86400 - 1 }), false);
  assert.equal(deskAgeIsLate({ status: 'in_progress', seconds_in_status: 3 * 86400 }), true);
  assert.equal(deskAgeIsLate({ status: 'completed', seconds_in_status: 99 * 86400 }), false);
});

test('labels and rules: assign only a queued unassigned request; message only an assigned one; notes only for the agent or the owner', () => {
  assert.deepEqual(['requested', 'in_progress', 'completed', 'x'].map(deskOversightStatusLabel), ['Queued', 'In progress', 'Completed', 'x']);
  assert.equal(deskRequestLabel({ tenant_name: 'Owner Co', mortgage_company: 'Big Bank', loan_number: '12' }), 'Owner Co / Big Bank / loan 12');
  assert.equal(deskRequestLabel({ tenant_name: null, mortgage_company: ' ', loan_number: null }), 'Mortgage Desk request');
  assert.equal(canAssignDeskRequest({ status: 'requested', assigned_agent_id: null }), true);
  assert.equal(canAssignDeskRequest({ status: 'requested', assigned_agent_id: 'a' }), false);
  assert.equal(canAssignDeskRequest({ status: 'in_progress', assigned_agent_id: null }), false);
  assert.equal(canMessageDeskAgent({ status: 'in_progress', assigned_agent_id: 'a' }), true);
  assert.equal(canMessageDeskAgent({ status: 'completed', assigned_agent_id: 'a' }), true);
  assert.equal(canMessageDeskAgent({ status: 'requested', assigned_agent_id: null }), false);
  assert.equal(canMessageDeskAgent({ status: 'in_progress', assigned_agent_id: null }), false);
  const req = { status: 'in_progress', assigned_employee_id: 'agent-1' };
  assert.equal(canReadMortgageDeskAgentNotes(req, 'agent-1', false), true);
  assert.equal(canReadMortgageDeskAgentNotes(req, 'agent-2', false), false);
  assert.equal(canReadMortgageDeskAgentNotes(req, 'owner', true), true);
  assert.equal(canReadMortgageDeskAgentNotes({ status: 'requested', assigned_employee_id: null }, 'owner', true), false);
  assert.equal(canReadMortgageDeskAgentNotes(null, 'agent-1', false), false);
  assert.deepEqual(['sent', 'failed', 'skipped', 'pending'].map(deskNoteEmailLabel), ['Emailed', 'Email failed', 'No email on file', 'Email pending']);
  assert.equal(deskAgentNoteError('  '), 'Write a message first.');
  assert.match(deskAgentNoteError('x'.repeat(MORTGAGE_DESK_AGENT_NOTE_MAX + 1)), /at most 2000/);
  assert.equal(deskAgentNoteError('x'.repeat(MORTGAGE_DESK_AGENT_NOTE_MAX)), null);
});

test('client: each call is one mortgage-desk-esign action with only its own fields; refusals surface the server message', async () => {
  const overview = fakeClient({ data: { ok: true, data: [{ request_id: 'r1', status: 'requested' }], total: 7 } });
  const page = await loadDeskOverview(overview, { status: 'requested', offset: 100 });
  assert.deepEqual(page, { data: { rows: [{ request_id: 'r1', status: 'requested' }], total: 7 }, error: null });
  assert.deepEqual(overview.calls, [{ name: MORTGAGE_DESK_ESIGN_FUNCTION, body: { action: 'desk_overview', limit: MORTGAGE_DESK_OVERSIGHT_PAGE, offset: 100, status: 'requested' } }]);
  const all = fakeClient({ data: { ok: true, data: [], total: 0 } });
  await loadDeskOverview(all);
  assert.deepEqual(all.calls[0].body, { action: 'desk_overview', limit: MORTGAGE_DESK_OVERSIGHT_PAGE, offset: 0 });

  const agents = fakeClient({ data: { ok: true, data: [{ agent_id: 'a1', agent_name: 'Avery', in_progress_count: 2 }] } });
  assert.equal((await loadDeskAssignableAgents(agents)).data[0].agent_id, 'a1');
  assert.deepEqual(agents.calls[0].body, { action: 'desk_agents' });

  const assign = fakeClient({ data: { ok: true, notice: { status: 'sent' } } });
  assert.deepEqual(await assignDeskAgent(assign, 'r1', 'a1'), { data: { noticeStatus: 'sent' }, error: null });
  assert.deepEqual(assign.calls[0].body, { action: 'assign_agent', request_id: 'r1', agent_id: 'a1' });
  const taken = fakeClient({ data: { ok: false, error: 'already_taken', message: 'This request is no longer queued: an agent already has it.' } });
  assert.deepEqual(await assignDeskAgent(taken, 'r1', 'a1'), { data: null, error: 'This request is no longer queued: an agent already has it.' });

  const message = fakeClient({ data: { ok: true, email: { status: 'skipped' } } });
  assert.deepEqual(await messageDeskAgent(message, 'r1', '  Call the bank  '), { data: { emailStatus: 'skipped' }, error: null });
  assert.deepEqual(message.calls[0].body, { action: 'message_agent', request_id: 'r1', body: 'Call the bank' });
  // An empty message never reaches the server.
  const empty = fakeClient({ data: { ok: true } });
  assert.equal((await messageDeskAgent(empty, 'r1', '   ')).error, 'Write a message first.');
  assert.equal(empty.calls.length, 0);

  const notes = fakeClient({ data: { ok: true, data: [{ note_id: 'n1', body: 'Hi', email_status: 'sent', created_at: '2026-11-12T00:00:00Z' }] } });
  assert.equal((await loadDeskAgentNotes(notes, 'r1')).data[0].note_id, 'n1');
  assert.deepEqual(notes.calls[0].body, { action: 'agent_notes', request_id: 'r1' });
  const transport = fakeClient({ error: { message: 'Network down' } });
  assert.deepEqual(await loadDeskAgentNotes(transport, 'r1'), { data: null, error: 'Network down' });
  const odd = fakeClient({ data: { ok: true } });
  assert.deepEqual(await loadDeskOverview(odd), { data: null, error: 'Unexpected reply' });
});

test('Tenant Management has a Mortgage Desk tab with the panel; the panel lists by status, assigns, messages and shows agents', () => {
  assert.equal(resolveAdminTenantTab('mortgage-desk'), 'mortgage-desk');
  const page = read('src/pages/admin/AdminTenants.tsx');
  assert.match(page, /<TabsTrigger value="mortgage-desk"><Inbox className="w-4 h-4 mr-1" \/> Mortgage Desk<\/TabsTrigger>/);
  assert.match(page, /<TabsContent value="mortgage-desk">\s*<MortgageDeskOversightPanel \/>\s*<\/TabsContent>/);
  const panel = read('src/components/admin/MortgageDeskOversightPanel.tsx');
  for (const status of ['requested', 'in_progress', 'completed']) assert.match(panel, new RegExp(`useDeskList\\("${status}"\\)`), status);
  for (const text of ['Assign', 'Message agent', 'Send email and note', 'Load more', 'turnaround', 'Only you and the assigned agent can read it']) {
    assert.ok(panel.includes(text), text);
  }
  assert.match(panel, /canAssignDeskRequest\(row\)/);
  assert.match(panel, /canMessageDeskAgent\(row\)/);
  // No direct table reads: everything goes through the SQL 158 actions.
  assert.doesNotMatch(panel, /\.from\(/);
});

test('agent request page: Tenant Management notes load through agent_notes only for the assigned agent or the owner, read-only', () => {
  const detail = read('src/pages/mortgage-ops/MortgageOpsRequestDetail.tsx');
  assert.match(detail, /canReadMortgageDeskAgentNotes\(r, user\?\.id, isPlatformOwner\(user\?\.email, user\?\.id\)\)/);
  assert.match(detail, /loadDeskAgentNotes\(deskEsignClient, r\.id\)/);
  assert.ok(detail.includes('Notes from Tenant Management'));
  assert.ok(detail.includes('The company on this check does not see them.'));
  assert.doesNotMatch(detail, /messageDeskAgent|assignDeskAgent/);
});
