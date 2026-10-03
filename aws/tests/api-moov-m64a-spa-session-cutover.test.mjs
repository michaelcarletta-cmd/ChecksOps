import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const UI = readFileSync(new URL('../../src/pages/RecipientPaymentSetup.tsx', import.meta.url), 'utf8');
const API = readFileSync(new URL('../../src/lib/recipientSessionApi.ts', import.meta.url), 'utf8');

const loadBlock = UI.slice(
  UI.indexOf('async function load()'),
  UI.indexOf('useEffect(() => { void load(); }'),
);

test('M6.4A session load targets same-origin AWS public route, not Lovable invoke', () => {
  assert.match(API, /\/public\/moov-recipient-session/);
  assert.match(API, /\$\{origin\}\/prep\$\{AWS_PUBLIC_SESSION\}/);
  assert.match(API, /host === "checksops.com"/);
  assert.match(loadBlock, /loadRecipientSession\(token/);
  assert.doesNotMatch(loadBlock, /invoke\(/);
  assert.doesNotMatch(loadBlock, /moov-recipient-session/);
  assert.doesNotMatch(API, /functions\.invoke/);
  assert.doesNotMatch(API, /supabase\.co/);
  assert.doesNotMatch(API, /console\.(log|debug|info|warn|error)/);
  assert.match(API, /JSON\.stringify\(\{ token \}\)/);
  assert.match(API, /throw new Error\(message\)/);
});

test('M6.4A mutation handlers stay explicit invoke and are unchanged on load', () => {
  assert.match(UI, /invoke\("moov-recipient-kyc-update"/);
  assert.match(UI, /invoke\("moov-recipient-tos-accept"/);
  assert.match(UI, /invoke\("moov-recipient-bank-add"/);
  assert.match(UI, /invoke\("moov-recipient-bank-verify"/);
  assert.doesNotMatch(loadBlock, /moov-recipient-kyc-update/);
  assert.doesNotMatch(loadBlock, /moov-recipient-tos-accept/);
  assert.doesNotMatch(loadBlock, /moov-recipient-bank-add/);
  assert.doesNotMatch(loadBlock, /moov-recipient-bank-verify/);
});
