import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mailtoAddress, telNumber } from '../../src/lib/contactLinks.ts';

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

test('mailtoAddress keeps a normal address and encodes anything that could add mail fields', () => {
  assert.equal(mailtoAddress('jane.doe+claims@example.com'), 'jane.doe%2Bclaims@example.com');
  assert.equal(mailtoAddress('  jane@example.com '), 'jane@example.com');
  const crafted = mailtoAddress('a@example.com?cc=evil@example.net&body=Pay%20here');
  assert.doesNotMatch(crafted, /[?&=\s]/);
  assert.equal(decodeURIComponent(crafted), 'a@example.com?cc=evil@example.net&body=Pay%20here');
  assert.equal(mailtoAddress(null), '');
});

test('telNumber keeps only dialable characters', () => {
  assert.equal(telNumber('+1 (555) 010-2000'), '+15550102000');
  assert.equal(telNumber('555-0102;ext=12'), '5550102;12');
  assert.equal(telNumber('555?body=x&y'), '555');
  assert.equal(telNumber(undefined), '');
});

test('contractor lead links use the helpers', () => {
  const card = read('src/components/networking/ContractorLeadsCard.tsx');
  assert.equal(card.match(/mailto:\$\{mailtoAddress\(l\.homeowner_email\)\}/g)?.length, 2);
  assert.equal(card.match(/tel:\$\{telNumber\(l\.homeowner_phone\)\}/g)?.length, 2);
  assert.doesNotMatch(card, /mailto:\$\{l\.homeowner_email\}|tel:\$\{l\.homeowner_phone\}/);
});

test('document viewers open new tabs with noopener', () => {
  for (const path of [
    'src/components/claim-detail/FieldPlacementEditor.tsx',
    'src/components/loss-draft/LossDraftDocsManager.tsx',
    'src/components/settings/TenantDocumentLibrary.tsx',
  ]) {
    const opens = read(path).match(/window\.open\([^)]*\)/g) ?? [];
    assert.ok(opens.length > 0, path);
    for (const call of opens) assert.match(call, /noopener/, `${path}: ${call}`);
  }
});
