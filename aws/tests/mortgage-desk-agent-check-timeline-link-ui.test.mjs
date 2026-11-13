// Owner 2026-11-12/13: the Mortgage Desk agent sees the request's check and the homeowner contact log, sends the
// homeowner link from the Desk, and every check image carries VOID. This checks the SPA wires those up.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

test('the Desk request page shows the check and timeline from the Desk API and VOID-stamps images', () => {
  const page = read('src/pages/mortgage-ops/MortgageOpsRequestDetail.tsx');
  // The check row and timeline come from the workspace (SQL 163), not a direct check_intake_items read.
  assert.match(page, /if \(ws\?\.check\) \{/);
  assert.match(page, /setCheck\(deskCheckToRow\(ws\.check, r\.tenant_id\)\)/);
  assert.match(page, /setHomeownerTimeline\(ws\?\.homeowner_timeline \|\| \[\]\)/);
  // The mapping never carries routing or account numbers to the agent.
  assert.match(page, /routing_number: null,\s*\n\s*account_number: null,/);
  // Images are the VOID canvas, not a linked <img>.
  assert.match(page, /<VoidStampedCheckImage src=\{images\.front\} label="Front" \/>/);
  assert.doesNotMatch(page, /<img src=\{images\.front\}/);
  // The contact log lists the homeowner timeline.
  assert.match(page, /Contact log/);
  assert.match(page, /homeownerTimeline\.map\(/);
  // The homeowner link is sent through the Desk button on AWS.
  assert.match(page, /<DeskSendHomeownerLinkButton/);
});

test('the VOID image component draws to canvas and offers no link or download', () => {
  const comp = read('src/components/mortgage-ops/VoidStampedCheckImage.tsx');
  assert.match(comp, /drawVoidWatermark\(ctx, canvas\.width, canvas\.height\)/);
  assert.match(comp, /<canvas/);
  assert.doesNotMatch(comp, /<a\b[^-]/);
  assert.doesNotMatch(comp, /\.toDataURL\(/);
  assert.match(comp, /onContextMenu=\{\(e\) => e\.preventDefault\(\)\}/);
  // The shared watermark helper exists.
  assert.match(read('src/utils/watermarkCheck.ts'), /export function drawVoidWatermark/);
});

test('the Desk link button uses the Desk API send action, never a client address', () => {
  const btn = read('src/components/mortgage-ops/DeskSendHomeownerLinkButton.tsx');
  assert.match(btn, /sendMortgageDeskTrackingLink\(client, requestId/);
  // No email/phone input: the server uses the homeowner on file.
  assert.doesNotMatch(btn, /type="email"/);
  const lib = read('src/lib/mortgageDeskEsign.ts');
  assert.match(lib, /action: "send_tracking_link"/);
  assert.match(lib, /action: "workspace"/);
  assert.match(lib, /homeowner_timeline: Array\.isArray/);
});
