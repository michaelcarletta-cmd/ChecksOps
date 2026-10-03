import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { isHomeownerLedgerPath, isPublicTokenRoute } from '../../src/lib/publicTokenRoutes.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('AWS tracking emails /h/ledger/:token; SPA must treat it as public, not org slug h', () => {
  const token = 'a'.repeat(48);
  assert.equal(isPublicTokenRoute(`/h/ledger/${token}`), true);
  assert.equal(isHomeownerLedgerPath(`/h/ledger/${token}`), true);
  assert.equal(isPublicTokenRoute(`/ledger/${token}`), true);
  assert.equal(isHomeownerLedgerPath(`/ledger/${token}`), true);

  assert.equal(isPublicTokenRoute('/h/claim/abc'), true);
  assert.equal(isPublicTokenRoute('/h/upload'), true);

  assert.equal(isPublicTokenRoute('/h/checks'), false);
  assert.equal(isPublicTokenRoute('/h'), false);
  assert.equal(isPublicTokenRoute(`/${token}`), false);
  assert.equal(isHomeownerLedgerPath('/h/claim/abc'), false);
});

test('App mounts HomeownerLedger on /h/ledger/:token before /:slug', () => {
  const app = read('src/App.tsx');
  const awsSend = read('aws/functions/api/homeowner.mjs');
  const whiteLabel = read('src/pages/WhiteLabelApp.tsx');

  const hLedger = app.indexOf('path="/h/ledger/:token"');
  const slug = app.indexOf('path="/:slug/*"');
  const ledger = app.indexOf('path="/ledger/:token"');

  assert.ok(hLedger > 0, 'explicit /h/ledger/:token route exists');
  assert.ok(ledger > 0, 'legacy /ledger/:token route remains');
  assert.ok(slug > 0, 'tenant slug route exists');
  assert.ok(hLedger < slug, '/h/ledger/:token is registered before /:slug/*');
  assert.match(app, /isPublicTokenRoute/);
  assert.match(app, /HomeownerLedger/);

  const sendFn = awsSend.slice(
    awsSend.indexOf('export const runHomeownerLedgerSend'),
    awsSend.indexOf('export const handleHomeownerLedgerSend'),
  );
  assert.match(sendFn, /\/h\/ledger\/\$\{tokenRow\.token\}/);
  assert.doesNotMatch(sendFn, /\/\$\{tenant.*slug\}/);

  assert.match(whiteLabel, /Organization Not Found/);
  assert.match(whiteLabel, /useParams<\{ slug: string \}>/);
});
