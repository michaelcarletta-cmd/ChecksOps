import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  COMMA_IF,
  IF_THEN_C,
  IF_THEN_CONST_C,
  IF_THEN_CONST_K,
  IF_THEN_K,
  SEMICOLON_IF,
  patchLiveFilesSignatureUploads,
  repairLiveFilesCommaIf,
  repairLiveFilesConstRestore,
} from './sig-upload-check-prefix-patch.mjs';

const require = createRequire(import.meta.url);
const acorn = require('acorn');
const LAST_WORKING = '/tmp/prod-spa/CheckFilesSection-0Fmhwbep-reread.js';
const BROKEN_OVERLAY = '/tmp/files-syntax-diag/files-live.js';

test('live Files chunk Signature uploads retarget to the check UUID', () => {
  assert.equal(existsSync(LAST_WORKING), true, 'need the last-working Files chunk');
  const source = readFileSync(LAST_WORKING, 'utf8');
  const patched = patchLiveFilesSignatureUploads(source);
  assert.equal(source.includes('signatures/${r}/'), true);
  assert.equal(patched.includes('signatures/${r}/'), false);
  assert.match(patched, /check-intake\/\$\{j\}\/files\/\$\{Date\.now\(\)\}-\$\{crypto\.randomUUID\(\)\}-\$\{s\.fileName\}/);
  assert.match(patched, /check-intake\/\$\{j\}\/files\/\$\{Date\.now\(\)\}-\$\{crypto\.randomUUID\(\)\}-\$\{a\}/);
  assert.equal(patched.includes('check-intake/${l}/files/${Date.now()}-${crypto.randomUUID()}-${i}'), true);
  assert.equal((patched.match(/Signature upload requires a check-scoped path/g) || []).length, 2);
  assert.equal(patched.includes(COMMA_IF), false);
  assert.equal((patched.split(SEMICOLON_IF).length - 1), 2);
  assert.equal(patched.includes(IF_THEN_C), false);
  assert.equal(patched.includes(IF_THEN_K), false);
  assert.equal(patched.includes(IF_THEN_CONST_C), true);
  assert.equal(patched.includes(IF_THEN_CONST_K), true);
  acorn.parse(patched, { ecmaVersion: 'latest', sourceType: 'module' });
});

test('comma-if repair changes only two bytes and parses', () => {
  const sample = [
    'const P="application/pdf"',
    COMMA_IF,
    ';K=`check-intake/${j}/files/${Date.now()}-${crypto.randomUUID()}-${s.fileName}`;',
    'const a="x.pdf"',
    COMMA_IF,
    ';c=`check-intake/${j}/files/${Date.now()}-${crypto.randomUUID()}-${a}`;',
    'const c=`check-intake/${l}/files/${Date.now()}-${crypto.randomUUID()}-${i}`;',
  ].join('');
  const repaired = repairLiveFilesCommaIf(sample);
  assert.equal(repaired.includes(COMMA_IF), false);
  assert.equal((repaired.split(SEMICOLON_IF).length - 1), 2);
  assert.equal(repaired.length, sample.length);
  assert.equal(repaired.includes('check-intake/${j}/files/${Date.now()}-${crypto.randomUUID()}-${s.fileName}'), true);
  assert.equal(repaired.includes('check-intake/${j}/files/${Date.now()}-${crypto.randomUUID()}-${a}'), true);
  assert.equal(repaired.includes('check-intake/${l}/files/${Date.now()}-${crypto.randomUUID()}-${i}'), true);
});

test('broken overlay SHA bytes take the two-character repair', (t) => {
  if (!existsSync(BROKEN_OVERLAY)) {
    t.skip('broken overlay fixture not present');
    return;
  }
  const source = readFileSync(BROKEN_OVERLAY, 'utf8');
  assert.throws(() => acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module' }), /if/);
  const repaired = repairLiveFilesCommaIf(source);
  acorn.parse(repaired, { ecmaVersion: 'latest', sourceType: 'module' });
  assert.equal(repaired.includes(COMMA_IF), false);
  assert.equal((repaired.split(SEMICOLON_IF).length - 1), 2);
  assert.equal(repaired.includes('check-intake/${j}/files/${Date.now()}-${crypto.randomUUID()}-${s.fileName}'), true);
  assert.equal(repaired.includes('check-intake/${j}/files/${Date.now()}-${crypto.randomUUID()}-${a}'), true);
  assert.equal(repaired.includes('check-intake/${l}/files/${Date.now()}-${crypto.randomUUID()}-${i}'), true);
  assert.equal(repaired.includes('signatures/${r}/'), false);
});

const SEMICOLON_LIVE = '/tmp/sig-wizard-next-diag/files.js';

test('const restore reattaches c and K to the comma declaration chain', () => {
  const sample = [
    'const P="application/pdf"',
    IF_THEN_K,
    '`check-intake/${j}/files/${Date.now()}-${crypto.randomUUID()}-${s.fileName}`,H=new Blob([S],{type:P}),{error:U}=await d.storage.from("claim-files").upload(K,H);',
    'const a="x.pdf"',
    IF_THEN_C,
    '`check-intake/${j}/files/${Date.now()}-${crypto.randomUUID()}-${a}`,{error:S}=await d.storage.from("claim-files").upload(c,E);',
  ].join('');
  const repaired = repairLiveFilesConstRestore(sample);
  assert.equal(repaired.includes(IF_THEN_C), false);
  assert.equal(repaired.includes(IF_THEN_K), false);
  assert.equal(repaired.includes(IF_THEN_CONST_C), true);
  assert.equal(repaired.includes(IF_THEN_CONST_K), true);
  assert.match(repaired, /const K=`check-intake\/\$\{j\}\/files\/[^`]+`,H=new Blob\(\[S\],\{type:P\}\),\{error:U\}=/);
  assert.match(repaired, /const c=`check-intake\/\$\{j\}\/files\/[^`]+`,\{error:S\}=/);
});

test('semicolon-repaired live Files bytes take the const restore', (t) => {
  if (!existsSync(SEMICOLON_LIVE)) {
    t.skip('semicolon-repaired Files fixture not present');
    return;
  }
  const source = readFileSync(SEMICOLON_LIVE, 'utf8');
  acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const repaired = repairLiveFilesConstRestore(source);
  const ast = acorn.parse(repaired, { ecmaVersion: 'latest', sourceType: 'module' });
  assert.equal(repaired.includes(IF_THEN_C), false);
  assert.equal(repaired.includes(IF_THEN_K), false);
  assert.match(repaired, /const K=`check-intake\/\$\{j\}\/files\/\$\{Date\.now\(\)\}-\$\{crypto\.randomUUID\(\)\}-\$\{s\.fileName\}`,H=new Blob\(\[S\],\{type:P\}\),\{error:U\}=/);
  assert.match(repaired, /const c=`check-intake\/\$\{j\}\/files\/\$\{Date\.now\(\)\}-\$\{crypto\.randomUUID\(\)\}-\$\{a\}`,\{error:S\}=/);
  assert.equal(repaired.includes('check-intake/${l}/files/${Date.now()}-${crypto.randomUUID()}-${i}'), true);
  assert.equal(repaired.includes('signatures/${r}/'), false);
  assert.equal(ast.type, 'Program');
});
