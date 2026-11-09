/**
 * Loss Draft Monitored / Not Monitored (owner, 2026-11-09: "When I click monitored or not
 * monitored on production side nothing happens but when I do on stagings it changes and
 * saves"). A click either sends set_monitoring_type or shows why it did not; a refusal is
 * shown; the saved value is what the buttons and the Status Workflow toggle display.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  LOSS_DRAFT_NO_IDENTITY_MESSAGE,
  monitoringTypeOf,
  resolveLossDraftActorId,
  runLossDraftAction,
  saveLossDraftMonitoringType,
  withMonitoringType,
} from '../../src/lib/lossDraftActions.ts';
import { SAFE_LOSS_DRAFT_ACTIONS, SAFE_WRITE_RPCS } from '../functions/api/workflow-rpc.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const DRAFT = '11111111-2222-4333-8444-555555555555';
const ACTOR = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const fakeClient = (result) => {
  const calls = [];
  return {
    calls,
    rpc: async (name, args) => {
      calls.push({ name, args });
      if (result instanceof Error) throw result;
      return result;
    },
  };
};
const fakeToast = () => {
  const toasts = [];
  const toast = (t) => { toasts.push(t); };
  toast.toasts = toasts;
  return toast;
};

test('click with a signed-in user: set_monitoring_type is sent with the right args and a success toast shows', async () => {
  const client = fakeClient({ data: { ok: true }, error: null });
  const toast = fakeToast();
  const saved = await saveLossDraftMonitoringType({
    client, toast, lossDraftId: DRAFT, actorId: ACTOR, current: 'monitored', next: 'not_monitored',
  });
  assert.equal(saved, 'not_monitored');
  assert.deepEqual(client.calls, [{
    name: 'loss_draft_action',
    args: {
      p_loss_draft_id: DRAFT,
      p_action: 'set_monitoring_type',
      p_actor_id: ACTOR,
      p_amount: null,
      p_notes: 'Changed to not_monitored',
      p_extra: { monitoring_type: 'not_monitored' },
    },
  }]);
  assert.equal(toast.toasts.length, 1);
  assert.equal(toast.toasts[0].title, 'Monitoring type updated');
  assert.equal(toast.toasts[0].description, 'Set to Not Monitored');
  assert.notEqual(toast.toasts[0].variant, 'destructive');

  // And back to Monitored from a file saved as not monitored.
  const back = fakeClient({ data: null, error: null });
  const toast2 = fakeToast();
  assert.equal(await saveLossDraftMonitoringType({
    client: back, toast: toast2, lossDraftId: DRAFT, actorId: ACTOR, current: 'not_monitored', next: 'monitored',
  }), 'monitored');
  assert.deepEqual(back.calls[0].args.p_extra, { monitoring_type: 'monitored' });
  assert.equal(toast2.toasts[0].description, 'Set to Monitored');
});

test('no identity: an error toast, no request, never a silent no-op', async () => {
  const client = fakeClient({ data: null, error: null });
  const toast = fakeToast();
  const saved = await saveLossDraftMonitoringType({
    client, toast, lossDraftId: DRAFT, actorId: null, current: 'monitored', next: 'not_monitored',
  });
  assert.equal(saved, null);
  assert.equal(client.calls.length, 0);
  assert.equal(toast.toasts.length, 1);
  assert.equal(toast.toasts[0].variant, 'destructive');
  assert.equal(toast.toasts[0].description, LOSS_DRAFT_NO_IDENTITY_MESSAGE);

  const outcome = await runLossDraftAction(client, { lossDraftId: DRAFT, action: 'mark_sent', actorId: '' });
  assert.deepEqual(outcome, { ok: false, reason: 'no_identity', message: LOSS_DRAFT_NO_IDENTITY_MESSAGE });
  assert.equal(client.calls.length, 0);
});

test('a refusal or a thrown error from the rpc shows an error toast and saves nothing', async () => {
  const refused = fakeClient({ data: null, error: { message: 'Not authorized for this loss draft' } });
  const toast = fakeToast();
  assert.equal(await saveLossDraftMonitoringType({
    client: refused, toast, lossDraftId: DRAFT, actorId: ACTOR, current: null, next: 'not_monitored',
  }), null);
  assert.equal(refused.calls.length, 1);
  assert.deepEqual(toast.toasts, [{ title: 'Error', description: 'Not authorized for this loss draft', variant: 'destructive' }]);

  const thrown = fakeClient(new Error('Failed to fetch'));
  const toast2 = fakeToast();
  assert.equal(await saveLossDraftMonitoringType({
    client: thrown, toast: toast2, lossDraftId: DRAFT, actorId: ACTOR, current: 'monitored', next: 'not_monitored',
  }), null);
  assert.deepEqual(toast2.toasts, [{ title: 'Error', description: 'Failed to fetch', variant: 'destructive' }]);

  const empty = fakeClient({ data: null, error: {} });
  const outcome = await runLossDraftAction(empty, { lossDraftId: DRAFT, action: 'mark_sent', actorId: ACTOR });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.message, 'The change was not saved.');
});

test('picking the type already saved sends nothing and says so', async () => {
  const client = fakeClient({ data: null, error: null });
  const toast = fakeToast();
  // A file with no saved type counts as monitored (the column default).
  assert.equal(await saveLossDraftMonitoringType({
    client, toast, lossDraftId: DRAFT, actorId: ACTOR, current: null, next: 'monitored',
  }), null);
  assert.equal(client.calls.length, 0);
  assert.equal(toast.toasts[0].title, 'Already Monitored');
});

test('actor: the auth context user, else the stored AWS session user, else none', () => {
  assert.equal(resolveLossDraftActorId({ id: ACTOR }, () => 'other'), ACTOR);
  assert.equal(resolveLossDraftActorId({ id: '' }, () => ACTOR), ACTOR);
  assert.equal(resolveLossDraftActorId(null, () => ACTOR), ACTOR);
  assert.equal(resolveLossDraftActorId(null, () => null), null);
  assert.equal(resolveLossDraftActorId(undefined), null);
  assert.equal(resolveLossDraftActorId(null, () => { throw new Error('no storage'); }), null);
});

test('the saved value is what is displayed: cache update and monitoringTypeOf', () => {
  const record = { id: DRAFT, monitoring_type: 'monitored', escrow_status: 'pending_send' };
  const after = withMonitoringType(record, 'not_monitored');
  assert.equal(monitoringTypeOf(after.monitoring_type), 'not_monitored');
  assert.equal(after.escrow_status, 'pending_send');
  assert.equal(record.monitoring_type, 'monitored', 'the cached record is copied, not mutated');
  assert.equal(withMonitoringType(undefined, 'monitored'), undefined);
  assert.equal(monitoringTypeOf(null), 'monitored');
  assert.equal(monitoringTypeOf('something_else'), 'monitored');
});

test('the API accepts the request the client sends; the actor comes from the verified sign-in', () => {
  assert.ok(SAFE_WRITE_RPCS.has('loss_draft_action'));
  for (const action of ['set_monitoring_type', 'mark_sent', 'admin_reset_status', 'send_for_endorsements']) {
    assert.ok(SAFE_LOSS_DRAFT_ACTIONS.has(action), action);
  }
  const api = read('aws/functions/api/workflow-rpc.mjs');
  const exec = api.slice(api.indexOf('const executeLossDraftAction = async'), api.indexOf("if (action === 'set_monitoring_type')"));
  assert.match(exec, /const actorId = mapping\.application_user_id;/);
  assert.doesNotMatch(api, /p_actor_id/, 'the API never trusts a client-sent actor');
});

test('Actions tab: no silent return on a missing user; buttons save through the shared helper', () => {
  const tab = read('src/components/loss-draft/detail/LossDraftActionsTab.tsx');
  assert.doesNotMatch(tab, /if \(!user\?\.id[^)]*\) return;/);
  assert.doesNotMatch(tab, /supabase\.rpc\("loss_draft_action"/);
  assert.match(tab, /resolveLossDraftActorId\(user, awsAuthUserId\)/);
  assert.match(tab, /onClick=\{\(\) => setMonitoringType\("monitored"\)\}/);
  assert.match(tab, /onClick=\{\(\) => setMonitoringType\("not_monitored"\)\}/);
  assert.match(tab, /aria-pressed=\{isMonitored\}/);
  assert.match(tab, /qc\.setQueryData\(queryKeys\.lossDraft\.detail\(lossDraftId\)/);
  // Every loss_draft_action in the tab goes through runLossDraftAction or the save helper.
  assert.equal((tab.match(/runLossDraftAction\(rpcClient,/g) || []).length, 2);
  assert.match(tab, /saveLossDraftMonitoringType\(\{/);
});

test('Status Workflow toggle: shows the saved type and saves through set_monitoring_type', () => {
  const wf = read('src/components/check-review/CheckStatusWorkflow.tsx');
  assert.doesNotMatch(wf, /setPath\(/, 'no client-only path state');
  assert.match(wf, /const effectivePath = monitoringTypeOf\(lossDraft\?\.monitoring_type\);/);
  assert.match(wf, /value=\{effectivePath\}/);
  assert.match(wf, /saveLossDraftMonitoringType\(\{/);
  assert.match(wf, /resolveLossDraftActorId\(user, awsAuthUserId\)/);
  assert.match(wf, /qc\.setQueryData\(workflowKey,/);
  assert.match(wf, /qc\.invalidateQueries\(\{ queryKey: workflowKey \}\)/);
});
