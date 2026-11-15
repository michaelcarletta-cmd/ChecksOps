import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Owner, 2026-11-15: "Remove project schedule from funds tab since it has its own tab."
const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const page = read('src/pages/CheckCommandCenter.tsx');
const funds = read('src/components/payments/FundsTab.tsx');

const block = (src, opener) => {
  const start = src.indexOf(opener);
  assert.ok(start > 0, `${opener} present`);
  return src.slice(start, src.indexOf('</TabsContent>', start));
};

test('the Funds tab no longer shows the project schedule', () => {
  // FundsTab (rendered only by the check detail's Funds tab) mounts no schedule editor.
  assert.doesNotMatch(funds, /ProjectPlanCard|CheckProjectScheduleTab|ProjectSchedule/);
  const fundsTab = block(page, '<TabsContent value="funds"');
  assert.doesNotMatch(fundsTab, /ProjectPlanCard|CheckProjectScheduleTab|ProjectSchedule/);
  // The Funds tab keeps its money content.
  assert.match(fundsTab, /<ClaimLedgerCard/);
  assert.match(fundsTab, /<IncomingFundsTab/);
  // FundsTab is the check detail's Funds content only.
  assert.match(page, /import \{ FundsTab as IncomingFundsTab \} from "@\/components\/payments\/FundsTab";/);
});

test('the Project Schedule tab remains, with the owner-only editor', () => {
  assert.match(page, /<TabsTrigger value="schedule" className="text-xs whitespace-nowrap px-2 sm:px-3 gap-1">\s*<CalendarRange className="h-3 w-3" \/> Project Schedule\s*<\/TabsTrigger>/);
  const schedule = block(page, '<TabsContent value="schedule"');
  assert.match(schedule, /<CheckProjectScheduleTab\s+claimId=\{check\.claim_id \?\? null\}\s+tenantId=\{checkOwnerTenantId \?\? null\}\s+canEdit=\{isOwner\}/);
  const tab = read('src/components/homeowner-ledger/CheckProjectScheduleTab.tsx');
  assert.match(tab, /return <ProjectPlanCard claimId=\{claimId\} tenantId=\{tenantId\} \/>;/);
});
