import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Owner request: Endorsing, Deposited, Ready for Deposit, Funds Received and
// Funds Released look like the Review tab (Manual Review Queue): a title, the
// class filter with one count/total line, checks grouped per claim, and a
// compact card per check, so a tenant does not scroll before clicking a check.

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const page = read('src/pages/CheckCommandCenter.tsx');
const review = read('src/components/check-review/CheckReviewConsole.tsx');
const compact = read('src/components/check-review/CompactCheckList.tsx');

function section(src, startRe, endRe) {
  const start = src.search(startRe);
  assert.ok(start >= 0, `start ${startRe}`);
  const rest = src.slice(start);
  const end = rest.slice(1).search(endRe);
  return end >= 0 ? rest.slice(0, end + 1) : rest;
}

const fundsReleased = section(page, /\{activeTab === "fundsreleased" && \(/, /\{activeTab === "fundsreceived" && \(/);
const fundsReceived = section(page, /\{activeTab === "fundsreceived" && \(/, /\{\/\* Review Tab/);
const lane = section(page, /\{\/\* All other tabs — only render the active one \*\//, /<\/Tabs>\s*\n\s*\{\/\* Bank return capture/);

test('the shared compact list exports the Review tab pieces', () => {
  for (const name of ['CompactClaimGroupHeader', 'CompactCheckRow', 'CompactCheckListBody', 'COMPACT_LIST_SCROLL_CLASS']) {
    assert.match(compact, new RegExp(`export (function|const) ${name}\\b`), name);
  }
  // Same group band and card as the Manual Review Queue.
  assert.match(compact, /rounded-md border-t-4 border-primary bg-primary\/20 px-3 py-3/);
  assert.match(compact, />Claim Check File<\/Badge>/);
  assert.match(compact, /Claim #\{claimNumber\}/);
  assert.match(compact, /<CardContent className="p-3">/);
  assert.match(compact, /text-xs text-muted-foreground truncate/);
  // Phones scroll the page, not a small inner box.
  assert.match(compact, /COMPACT_LIST_SCROLL_CLASS = "max-h-none lg:h-\[calc\(100vh-460px\)\]"/);
});

test('the Review tab renders through the shared compact list', () => {
  assert.match(review, /from "@\/components\/check-review\/CompactCheckList"/);
  assert.match(review, /<ScrollArea className=\{COMPACT_LIST_SCROLL_CLASS\}>/);
  assert.match(review, /<CompactClaimGroupHeader[\s\S]*?details=\{\["Awaiting routing"\]\}/);
  assert.match(review, /<CompactCheckRow[\s\S]*?onClick=\{\(\) => onSelectCheck\(check\.id\)\}/);
  // Its inline Claim # field stays in the row footer.
  assert.match(review, /footer=\{[\s\S]*?placeholder="Add claim #"/);
});

test('Endorsing, Ready for Deposit and Deposited use the compact list, not a wide table', () => {
  assert.match(page, /from "@\/components\/check-review\/CompactCheckList"/);
  for (const [key, title] of [['endorsements', 'Endorsing'], ['ready', 'Ready for Deposit'], ['deposited', 'Deposited']]) {
    assert.match(page, new RegExp(`${key}: \\{ title: "${title}"`), key);
  }
  assert.match(lane, /LANE_TITLES\[activeTab\]/);
  assert.match(lane, /<CompactClaimGroupHeader/);
  assert.match(lane, /<CompactCheckRow/);
  assert.match(lane, /<ScrollArea className=\{COMPACT_LIST_SCROLL_CLASS\}>/);
  assert.doesNotMatch(lane, /<Table\b/);
  assert.doesNotMatch(lane, /min-w-\[760px\]/);
  // One count/total line under the class filter.
  assert.match(lane, /Total: \$\{laneCumulativeTotal/);
});

test('lane rows keep their stage info, actions and click behaviour', () => {
  assert.match(lane, /getTabStatusLabel\(check, activeTab\)/);
  assert.match(lane, /claimFileStageDetails\(group, hideReadySignal\)/);
  assert.match(page, /endorsements received/);
  assert.match(lane, /<CheckValidityBadge issueDate=\{check\.issue_date\}/);
  assert.match(lane, /<SharedChecksBadge/);
  assert.match(lane, /<DuplicateCheckBadge/);
  assert.match(lane, /onClick=\{\(\) => setSelectedCheck\(isSelected \? null : check\.id\)\}/);
  assert.match(lane, /onMouseEnter=\{\(\) => prefetchCheckDetail\(check\.id\)\}/);
  assert.match(lane, /toggleBulk\(check\.id\)/);
  assert.match(lane, /title="Select all checks in this file"/);
  assert.match(lane, /setShareCheckId\(check\.id\)/);
  assert.match(lane, /setMarkReturnedCheck\(/);
  assert.match(lane, /<AdminDeleteCheckButton/);
  // Large lanes stay virtualized.
  assert.match(lane, /queueVirtualizer\.measureElement/);
  // Deposited keeps its paging.
  assert.match(lane, /Load \$\{DEPOSITED_PAGE_SIZE\} more/);
});

test('Funds Released and Funds Received use the compact list grouped per claim', () => {
  for (const [name, src, party, date] of [
    ['released', fundsReleased, /`To \$\{split\.recipient_name/, /Settled \{split\.settled_at/],
    ['received', fundsReceived, /`From \$\{split\.sender\?\.name \?\? "Partner tenant"\}`/, /Received \{split\.settled_at/],
  ]) {
    assert.match(src, /<ClassFilterBar/, name);
    assert.match(src, /<ScrollArea className=\{COMPACT_LIST_SCROLL_CLASS\}>/, name);
    assert.match(src, /groupSplitsByClaim\(visible,/, name);
    assert.match(src, /<CompactClaimGroupHeader/, name);
    assert.match(src, /<CompactCheckRow/, name);
    assert.match(src, /onClick=\{\(\) => checkId && setSelectedCheck\(isSelected \? null : checkId\)\}/, name);
    assert.match(src, party, name);
    assert.match(src, date, name);
    assert.match(src, /Ck #\$\{split\.external_check_number\}/, name);
    assert.doesNotMatch(src, /<Table\b/, name);
  }
});
