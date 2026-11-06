import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Owner, 2026-11-06: "Project Schedule should be shown through entire check process in its own
// tab next to Partners."
const src = readFileSync('src/pages/CheckCommandCenter.tsx', 'utf8');
const tabsList = src.slice(
  src.indexOf('<TabsTrigger value="overview" className="text-xs whitespace-nowrap px-2 sm:px-3">Overview</TabsTrigger>'),
);
const list = tabsList.slice(0, tabsList.indexOf('</TabsList>'));

test('the check detail has a Project Schedule tab right after Partners and before Audit', () => {
  const partners = list.indexOf('<TabsTrigger value="partners"');
  const schedule = list.indexOf('<TabsTrigger value="schedule"');
  const audit = list.indexOf('<TabsTrigger value="audit"');
  assert.ok(partners > 0, 'Partners trigger present');
  assert.ok(schedule > partners, 'Project Schedule follows Partners');
  assert.ok(audit > schedule, 'Audit stays last');
  // No other trigger sits between Partners and Project Schedule.
  assert.equal(list.slice(partners + 1, schedule).includes('<TabsTrigger'), false);
  assert.match(list.slice(schedule, audit), /Project Schedule/);
  // Same classNames as the neighbouring Partners trigger (horizontal scroll on mobile).
  assert.match(list.slice(schedule, audit), /className="text-xs whitespace-nowrap px-2 sm:px-3 gap-1"/);
});

test('the Project Schedule tab is not gated on a stage, deposit state or ownership', () => {
  const schedule = list.indexOf('<TabsTrigger value="schedule"');
  const before = list.slice(list.lastIndexOf('</TabsTrigger>', schedule), schedule);
  assert.doesNotMatch(before, /&&\s*\(/, 'trigger is not wrapped in a condition');
  const content = src.slice(src.indexOf('<TabsContent value="schedule"'));
  const block = content.slice(0, content.indexOf('</TabsContent>'));
  assert.match(block, /<CheckProjectScheduleTab/);
  assert.doesNotMatch(block, /check_stage|isDeposited|deposited_at|status ===/);
  const opener = src.slice(src.lastIndexOf('\n', src.indexOf('<TabsContent value="schedule"')), src.indexOf('<TabsContent value="schedule"'));
  assert.doesNotMatch(opener, /&&/);
  assert.match(block, /claimId=\{check\.claim_id \?\? null\}/);
  assert.match(block, /tenantId=\{checkOwnerTenantId \?\? null\}/);
  assert.match(block, /canEdit=\{isOwner\}/);
});

test('the tab edits through ProjectPlanCard only for the owner, and explains a missing claim', () => {
  const tab = readFileSync('src/components/homeowner-ledger/CheckProjectScheduleTab.tsx', 'utf8');
  assert.match(tab, /if \(!claimId\) \{[\s\S]*not linked to a claim yet/);
  assert.match(tab, /if \(!canEdit \|\| !tenantId\) \{[\s\S]*managed by the company that uploaded this check/);
  assert.match(tab, /return <ProjectPlanCard claimId=\{claimId\} tenantId=\{tenantId\} \/>;/);
  // The Funds tab keeps its owner-only card; partners (readOnly) still never get the editor there.
  const funds = readFileSync('src/components/payments/FundsTab.tsx', 'utf8');
  assert.match(funds, /\{!readOnly && claimId && tenant\?\.id && \(\s*<ProjectPlanCard/);
});
