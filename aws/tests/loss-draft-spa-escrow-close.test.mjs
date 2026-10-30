/**
 * Loss Draft website, owner decisions of 2026-10-30:
 * 1. Monitored files never go to Endorsing: no Endorsing action or override for them.
 * 2. Not monitored: uploading the endorsed back of the check prompts to send it to
 *    Endorsing (send_for_endorsements), which closes the file.
 * 3. Override sends the check where chosen: Review (target "review", closes the file),
 *    Endorsing only when not monitored; Loss Draft, Reissue and Void are gone. After an
 *    override or a send to Endorsing the selection clears and the check queues refresh.
 * 5. Check detail Funds tab shows Total Escrowed, Released and Outstanding from
 *    loss_draft_tracking (ClaimCashFlowCard, escrow only).
 * 6. The claim ledger moved from the Actions tab to the Draws tab.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CHECK_QUEUE_QUERY_ROOTS } from '../../src/lib/checkQueueRefresh.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const actions = read('src/components/loss-draft/detail/LossDraftActionsTab.tsx');
const releases = read('src/components/loss-draft/detail/LossDraftReleasesTab.tsx');
const panel = read('src/components/loss-draft/LossDraftDetailPanel.tsx');
const dashboard = read('src/components/loss-draft/LossDraftDashboard.tsx');
const cashFlow = read('src/components/loss-draft/ClaimCashFlowCard.tsx');
const ccc = read('src/pages/CheckCommandCenter.tsx');

const actionList = (name) => {
  const start = actions.indexOf(`const ${name}: ActionDef[] = [`);
  assert.ok(start > -1, name);
  return actions.slice(start, actions.indexOf('];', start));
};

test('monitored: no Endorsing in the actions; the escrow and draw actions stay', () => {
  const monitored = actionList('MONITORED_ACTIONS');
  assert.doesNotMatch(monitored, /send_for_endorsements|endorsing/i);
  for (const action of ['mark_escrowed', 'request_draw', 'record_release', 'record_holdback', 'mark_final_release']) {
    assert.match(monitored, new RegExp(`action: "${action}"`), action);
  }
  // Not monitored keeps its send from received back.
  assert.match(actionList('NOT_MONITORED_ACTIONS'), /action: "send_for_endorsements"[^\n]*fromStatuses: \["check_received_back"\]/);
});

test('override: Review always, Endorsing only when not monitored; Loss Draft, Reissue and Void are gone', () => {
  assert.match(actions, /export const LOSS_DRAFT_OVERRIDE_REVIEW = "review";/);
  assert.match(actions, /export const LOSS_DRAFT_OVERRIDE_ENDORSING = "endorsing";/);
  assert.match(actions, /<option value=\{LOSS_DRAFT_OVERRIDE_REVIEW\}>Review<\/option>/);
  assert.match(actions, /\{!isMonitored && \(\s*<option value=\{LOSS_DRAFT_OVERRIDE_ENDORSING\}>Endorsing<\/option>\s*\)\}/);
  for (const gone of ['value="pending_send"', 'value="escrowed"', 'value="pending_reissue"', 'value="void"', '>Void<', '>Reissue<', '>Loss Draft</option>']) {
    assert.ok(!actions.includes(gone), gone);
  }
  // The override calls the bridge with the chosen target (the API branch accepts "review").
  assert.match(actions, /p_action: "admin_reset_status",[\s\S]*?p_extra: \{ target_status: adminTargetStatus \}/);
});

test('override and send to Endorsing clear the selection and refresh the check queues', () => {
  const closed = actions.slice(actions.indexOf('const afterFileClosed = () => {'), actions.indexOf('const executeAction'));
  assert.match(closed, /refreshCheckQueues\(qc, \{ includeInactive: true, checkId: draft\.check_intake_item_id \}\)/);
  assert.match(closed, /queryKey: \["loss-draft-dashboard"\]/);
  assert.match(closed, /onClosed\?\.\(\);/);
  assert.match(actions, /import \{ refreshCheckQueues \} from "@\/lib\/checkQueueRefresh";/);
  // refreshCheckQueues covers the lane lists and their counts.
  for (const root of ['check-intake-items', 'check-stage-totals', 'loss-draft-counts']) assert.ok(CHECK_QUEUE_QUERY_ROOTS.includes(root), root);
  const reset = actions.slice(actions.indexOf('const adminResetStatus = async'), actions.indexOf('return (', actions.indexOf('const adminResetStatus = async')));
  assert.match(reset, /afterFileClosed\(\);/);
  assert.doesNotMatch(reset, /onChanged\(\);/);
  assert.match(actions, /if \(action === "send_for_endorsements"\) afterFileClosed\(\);\s*else onChanged\(\);/);
  // The panel passes it through and the Loss Draft list returns to the list.
  assert.match(panel, /onClosed=\{onClosed\}/);
  assert.match(dashboard, /onClosed=\{\(\) => setSelectedId\(null\)\}/);
});

test('not monitored: the endorsed back upload prompts to send the check to Endorsing', () => {
  assert.match(actions, /onUploaded=\{\(recorded\) => \{[\s\S]*?if \(recorded && !isMonitored && isOpen\) setEndorsePromptOpen\(true\);/);
  assert.match(actions, /<AlertDialog open=\{endorsePromptOpen\} onOpenChange=\{setEndorsePromptOpen\}>/);
  assert.match(actions, /Send this check to Endorsing\?/);
  assert.match(actions, /executeAction\("send_for_endorsements"\);/);
  // The upload reports whether its audit row (the API's evidence) was written.
  assert.match(actions, /event_type: "back_image_reuploaded"/);
  assert.match(actions, /onUploaded\(!auditErr\);/);
});

test('amounts are checked before the call and sent with at most two decimals', () => {
  assert.match(actions, /def\?\.needsAmount && !\/\^\\d\{1,10\}\(\\\.\\d\{1,2\}\)\?\$\/\.test\(amountText\)/);
  assert.match(actions, /p_amount: def\?\.needsAmount \? Number\(amountText\) : null,/);
  assert.match(actions, /onClick=\{\(\) => executeAction\(a\.action, a\)\}/);
  assert.match(actions, /release_recorded === false/);
});

test('the claim ledger renders in the Draws tab, not in Actions', () => {
  assert.doesNotMatch(actions, /ClaimLedgerCard|ClaimSettlementEditor|claim-ledger-settlement/);
  assert.match(releases, /import \{ ClaimLedgerCard \} from "@\/components\/payments\/ClaimLedgerCard";/);
  assert.match(releases, /import \{ ClaimSettlementEditor \} from "@\/components\/payments\/ClaimSettlementEditor";/);
  assert.match(releases, /queryKey: \["claim-ledger-settlement", draft\.claim_id\]/);
  assert.match(releases, /<ClaimLedgerCard\s+checkIntakeItemId=\{draft\.check_intake_item_id!\}\s+claimId=\{draft\.claim_id\}[\s\S]*?onLinked=\{onChanged\}/);
  assert.match(releases, /<ClaimSettlementEditor[\s\S]*?settlement=\{settlement\}/);
  assert.match(panel, /<LossDraftReleasesTab\s+releases=\{releases\}\s+draft=\{draft\}\s+onChanged=\{handleChanged\}\s+showDraws=\{isMonitored\}\s+\/>/);
  // Every file has the tab (the ledger is there); only monitored files list draws.
  assert.match(panel, /<TabsTrigger value="releases" className="flex-1 text-xs">\s*\{isMonitored \? `Draws \(\$\{releases\.length\}\)` : "Ledger"\}/);
  assert.doesNotMatch(panel, /\{isMonitored && \(\s*<TabsTrigger value="releases"/);
  // The check detail Funds tab keeps its own ClaimLedgerCard.
  assert.match(ccc, /<TabsContent value="funds"[\s\S]*?<ClaimLedgerCard\s+checkIntakeItemId=\{checkId\}/);
});

test('the Funds tab shows Total Escrowed, Released and Outstanding from loss_draft_tracking', () => {
  assert.match(ccc, /import \{ ClaimCashFlowCard \} from "@\/components\/loss-draft\/ClaimCashFlowCard";/);
  const funds = ccc.slice(ccc.indexOf('<TabsContent value="funds"'), ccc.indexOf('<TabsContent value="files"'));
  assert.match(funds, /<ClaimCashFlowCard escrowOnly checkIntakeItemId=\{checkId\} claimId=\{check\.claim_id \?\? null\} \/>/);
  // By the check (a draft without a claim) and by its claim, deduped by id.
  assert.match(cashFlow, /\.eq\("check_intake_item_id", checkIntakeItemId\)/);
  assert.match(cashFlow, /\.eq\("claim_id", claimId\)/);
  assert.match(cashFlow, /seen\.set\(d\.id, d\)/);
  // Escrow only: no payment or check reads, nothing shown without a loss draft.
  assert.match(cashFlow, /enabled: !!claimId && !escrowOnly,[\s\S]*?enabled: !!claimId && !escrowOnly,/);
  assert.match(cashFlow, /if \(escrowOnly\) \{\s*if \(drafts\.length === 0\) return null;/);
  for (const label of ['Total Escrowed', 'Released', 'Outstanding']) assert.match(cashFlow, new RegExp(`>${label}</p>`), label);
  // Outstanding is escrowed - released - holdback, never negative.
  assert.match(cashFlow, /const outstanding = Math\.max\(0, Math\.round\(\(escrowed - released - holdback\) \* 100\) \/ 100\);/);
});

test('lossDraftEscrowTotals arithmetic (mirrors the component formula)', () => {
  // The component is TSX with "@/" imports; replay its formula on the same inputs.
  const num = (v) => { const n = Number(v ?? 0); return Number.isFinite(n) ? n : 0; };
  const totals = (drafts) => {
    const escrowed = drafts.reduce((s, d) => s + num(d.total_escrowed), 0);
    const released = drafts.reduce((s, d) => s + num(d.draw_amount_released), 0);
    const holdback = drafts.reduce((s, d) => s + num(d.holdback_amount), 0);
    return { escrowed, released, holdback, outstanding: Math.max(0, Math.round((escrowed - released - holdback) * 100) / 100) };
  };
  assert.deepEqual(totals([{ total_escrowed: '10000.00', draw_amount_released: 2500.5, holdback_amount: '1000' }]), { escrowed: 10000, released: 2500.5, holdback: 1000, outstanding: 6499.5 });
  assert.equal(totals([{ total_escrowed: 100, draw_amount_released: 150, holdback_amount: 0 }]).outstanding, 0);
  assert.equal(totals([{ total_escrowed: null, draw_amount_released: null, holdback_amount: null }]).outstanding, 0);
  assert.equal(totals([{ total_escrowed: 0.3, draw_amount_released: 0.1, holdback_amount: 0.2 }]).outstanding, 0);
});
