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
  assert.match(API, /\$\{origin\}\/prep\$\{path\}/);
  assert.match(API, /host === "checksops.com"/);
  assert.match(loadBlock, /loadRecipientSession\(token/);
  assert.doesNotMatch(loadBlock, /invoke\(/);
  assert.doesNotMatch(loadBlock, /moov-recipient-session/);
  assert.doesNotMatch(API, /functions\.invoke/);
  assert.doesNotMatch(API, /supabase\.co/);
  assert.doesNotMatch(API, /console\.(log|debug|info|warn|error)/);
  assert.match(API, /JSON\.stringify\(body\)/);
  assert.match(API, /postRecipientPublic\(AWS_PUBLIC_SESSION, \{ token \}/);
  assert.match(API, /throw err/);
  assert.match(API, /mapRecipientPublicError/);
});

test('M6.4A mutation handlers stay off the session load path', () => {
  assert.match(UI, /submitRecipientKyc\(token/);
  assert.match(UI, /submitRecipientTos\(token/);
  assert.doesNotMatch(UI, /invoke\("moov-recipient-bank-add"/);
  assert.doesNotMatch(UI, /invoke\("moov-recipient-bank-verify"/);
  assert.doesNotMatch(loadBlock, /moov-recipient-kyc-update/);
  assert.doesNotMatch(loadBlock, /moov-recipient-tos-accept/);
  assert.doesNotMatch(loadBlock, /submitRecipientKyc/);
  assert.doesNotMatch(loadBlock, /submitRecipientTos/);
});
