import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const spaRoot = path.join(ROOT, '../src');

/** Same contract as BankDepositReconciliation.bankDepositDayKey */
const bankDepositDayKey = (iso) => {
  if (!iso) return 'unknown';
  const day = String(iso).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : 'unknown';
};

/** Live DSbVZXu8 / 82460c8c2 / current src */
const liveDayKey = (row) => bankDepositDayKey(row.cleared_at ?? row.submitted_at);

/** QDJiUFF1 / #581 / #584 recover */
const settingsDayKey = (row) => bankDepositDayKey(row.submitted_at);

const EXISTING_ROWS = Object.freeze([
  {
    id: 'dep-existing-both-dates',
    check_intake_item_id: 'chk-existing-1',
    created_at: '2026-08-01T12:00:00.000Z',
    submitted_at: '2026-08-02T15:00:00.000Z',
    cleared_at: '2026-08-04T18:00:00.000Z',
  },
  {
    id: 'dep-existing-cleared-only',
    check_intake_item_id: 'chk-existing-2',
    created_at: '2026-07-15T09:00:00.000Z',
    submitted_at: null,
    cleared_at: '2026-07-20T11:00:00.000Z',
  },
  {
    id: 'dep-existing-neither-date',
    check_intake_item_id: 'chk-existing-3',
    created_at: '2026-06-01T08:00:00.000Z',
    submitted_at: null,
    cleared_at: null,
  },
]);

test('Date unknown is a client regroup of the same deposit ids, not an insert', () => {
  const liveUnknown = EXISTING_ROWS.filter((row) => liveDayKey(row) === 'unknown').map((row) => row.id);
  const settingsUnknown = EXISTING_ROWS.filter((row) => settingsDayKey(row) === 'unknown').map((row) => row.id);

  assert.deepEqual(liveUnknown, ['dep-existing-neither-date']);
  assert.deepEqual(settingsUnknown, ['dep-existing-cleared-only', 'dep-existing-neither-date']);

  const liveIds = EXISTING_ROWS.map((row) => row.id);
  const settingsIds = EXISTING_ROWS.map((row) => row.id);
  assert.deepEqual(liveIds, settingsIds);
  assert.equal(EXISTING_ROWS.every((row) => row.created_at < '2026-09-30T20:15:00.000Z'), true);
});

test('candidate Bank Deposits query is select-only and groups by submitted_at', () => {
  const src = fs.readFileSync(path.join(spaRoot, 'components/deposit-ops/BankDepositReconciliation.tsx'), 'utf8');
  assert.match(src, /\.from\("checkalt_deposits"\)/);
  assert.match(src, /\.select\(/);
  assert.match(src, /groupDepositsBySubmissionDate/);
  assert.match(src, /bankDepositDayKey\(row\.submitted_at\)/);
  assert.equal(/cleared_at \?\?/.test(src), false);
  assert.equal(/\.insert\(/.test(src), false);
  assert.equal(/\.upsert\(/.test(src), false);
  assert.equal(/\.delete\(/.test(src), false);
  assert.match(src, /Insured Name/);
  assert.match(src, /if \(dayKey === "unknown"\) return "Date unknown"/);
});

test('Unknown insured is a Check Command Center label fallback, not a new row', () => {
  const src = fs.readFileSync(path.join(spaRoot, 'pages/CheckCommandCenter.tsx'), 'utf8');
  const matches = src.match(/"Unknown insured"/g) || [];
  assert.equal(matches.length >= 3, true);
  assert.match(src, /policyholder_name \|\| .* \|\| "Unknown insured"/);
});

test('recovered-candidate sources restore Moov badges and tenant logo resolver', () => {
  const show = (rev, file) => execFileSync('git', ['show', `${rev}:${file}`], { encoding: 'utf8' });
  const moov = show('84ba11f4c5fbc5a98652768dc72cb1e58757ea14', 'src/components/disbursement/StakeholderAccountSettings.tsx');
  assert.match(moov, /Bank verified/);
  assert.match(moov, /Provider linked/);
  const liveMoov = show('82460c8c2ebbc8c7996b9cc233058015933120df', 'src/components/disbursement/StakeholderAccountSettings.tsx');
  assert.equal(/Bank verified/.test(liveMoov), false);
  assert.equal(/Provider linked/.test(liveMoov), false);
  const logoUrl = show('b97a8dc6de16305c11b9e52e92ea167abdfabc8d', 'src/lib/tenantLogoUrl.ts');
  assert.match(logoUrl, /\/prep\/branding\/logo/);
  assert.match(logoUrl, /persistableLogoField/);
  const logoCmp = show('b97a8dc6de16305c11b9e52e92ea167abdfabc8d', 'src/components/branding/TenantLogo.tsx');
  assert.match(logoCmp, /tenantLogoUrl/);
});
