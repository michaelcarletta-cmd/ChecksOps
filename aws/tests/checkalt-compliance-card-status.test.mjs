import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const card = readFileSync('src/components/checks/CheckAltImageComplianceCard.tsx', 'utf8');
const compliance = readFileSync('src/lib/checkaltImageCompliance.ts', 'utf8');
const prep = readFileSync('src/lib/prepareCheckAltDeposit.ts', 'utf8');

test('Deposit image check treats a present source without official artifact as unprepared, not missing', () => {
  assert.match(compliance, /export const reportOfficialMissing/);
  assert.match(compliance, /reason: `\$\{side\}_unprepared`/);
  assert.match(card, /reportOfficialMissing/);
  assert.match(card, /rearPresencePath/);
  assert.match(card, /inspectOfficialOrSource/);
  assert.doesNotMatch(card, /prepareCheckAltDeposit/);
  assert.match(card, /Adjust Received Endorsement/);
});

test('prepareCheckAltDeposit uses production front_image_path and back_image_deposit_path only', () => {
  assert.match(prep, /const frontSource = isRasterPath\(row\.front_image_path\)/);
  assert.match(prep, /const backSource = isRasterPath\(row\.back_image_deposit_path\)/);
  assert.doesNotMatch(prep, /front_image_deposit_path/);
  assert.match(prep, /export async function ensureOfficialCheckAltArtifact/);
});
