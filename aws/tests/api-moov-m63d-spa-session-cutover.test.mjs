import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { recipientSessionTokenShape } from '../functions/api/production-recipient-token.mjs';

const UI = readFileSync(new URL('../../src/pages/RecipientPaymentSetup.tsx', import.meta.url), 'utf8');
const API = readFileSync(new URL('../../src/lib/recipientSessionApi.ts', import.meta.url), 'utf8');
const HANDLER = readFileSync(new URL('../functions/api/public-moov-recipient-session.mjs', import.meta.url), 'utf8');
const MOOV_CLIENT = readFileSync(new URL('../functions/api/providers/production/moov-client.mjs', import.meta.url), 'utf8');

const loadBlock = UI.slice(
  UI.indexOf('async function load()'),
  UI.indexOf('useEffect(() => { void load(); }'),
);

test('M6.3D session load targets same-origin AWS public route, not Lovable invoke', () => {
  assert.match(API, /\/public\/moov-recipient-session/);
  assert.match(API, /\$\{origin\}\/prep\$\{AWS_PUBLIC_SESSION\}/);
  assert.match(API, /host === "checksops.com"/);
  assert.match(loadBlock, /loadRecipientSession\(token/);
  assert.doesNotMatch(loadBlock, /invoke\(/);
  assert.doesNotMatch(loadBlock, /moov-recipient-session/);
  assert.doesNotMatch(API, /functions\.invoke/);
  assert.doesNotMatch(API, /console\.(log|debug|info|warn|error)/);
  assert.match(API, /JSON\.stringify\(\{ token \}\)/);
  assert.match(API, /throw new Error\(message\)/);
});

test('M6.3D mutation handlers stay explicit invoke and are unchanged on load', () => {
  assert.match(UI, /invoke\("moov-recipient-kyc-update"/);
  assert.match(UI, /invoke\("moov-recipient-tos-accept"/);
  assert.match(UI, /invoke\("moov-recipient-bank-add"/);
  assert.match(UI, /invoke\("moov-recipient-bank-verify"/);
  assert.doesNotMatch(loadBlock, /moov-recipient-kyc-update/);
  assert.doesNotMatch(loadBlock, /moov-recipient-tos-accept/);
  assert.doesNotMatch(loadBlock, /moov-recipient-bank-add/);
  assert.doesNotMatch(loadBlock, /moov-recipient-bank-verify/);
  const kycIdx = UI.indexOf('invoke("moov-recipient-kyc-update"');
  const tosIdx = UI.indexOf('invoke("moov-recipient-tos-accept"');
  const bankIdx = UI.indexOf('invoke("moov-recipient-bank-add"');
  const verifyIdx = UI.indexOf('invoke("moov-recipient-bank-verify"');
  assert.ok(kycIdx > UI.indexOf('async function submitIdentity'));
  assert.ok(tosIdx > UI.indexOf('async function submitTerms'));
  assert.ok(bankIdx > UI.indexOf('async function submitBank'));
  assert.ok(verifyIdx > UI.indexOf('async function initiateBankVerify'));
});

test('M6.3D AWS session handler cannot POST/PATCH/PUT Moov resources and does not consume tokens', () => {
  assert.match(HANDLER, /method: 'GET'/);
  assert.doesNotMatch(HANDLER, /method:\s*'PATCH'/);
  assert.doesNotMatch(HANDLER, /method:\s*'PUT'/);
  assert.doesNotMatch(HANDLER, /method:\s*'DELETE'/);
  assert.doesNotMatch(HANDLER, /token_used_at\s*=/);
  assert.doesNotMatch(HANDLER, /UPDATE public.external_payment_recipients/);
  assert.match(HANDLER, /token: null/);
  assert.match(HANDLER, /token_consumed: false/);
  assert.match(MOOV_CLIENT, /read_only_method_denied/);
  assert.equal(recipientSessionTokenShape('x'), '');
  assert.equal(recipientSessionTokenShape('*,id=eq.62a858ff-ee6a-49d7-9898-1c8e4a44227b'), '');
  assert.ok(recipientSessionTokenShape('00000000-0000-4000-8000-000000000000'));
});
