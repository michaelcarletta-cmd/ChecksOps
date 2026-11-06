import assert from 'node:assert/strict';
import { test } from 'node:test';
import { separatePayeeAddress, splitPayees } from '../functions/api/ocr-parse.mjs';
import { mergeCheckExtraction } from '../functions/api/check-ocr-provider.mjs';
import { normalizeAzureMicr } from '../functions/api/ocr-normalize-azure.mjs';

// Production check 2f676a72 (owner report 2026-11-06): the scanned payee line.
const PROD_LINE = 'Freedom Adjustment And Karen Lovett 865 Route 33 Business Ste Freehold Nj 07728';
const names = (line) => splitPayees(line).map((row) => row.name);

test('production check 2f676a72: both payees survive and the address is separated', () => {
  // Before: looksLikeAddress ran on "Karen Lovett 865 Route 33 ... 07728" before the
  // trailing-address trim, so the whole part was dropped and only one payee was inserted.
  assert.deepEqual(names(PROD_LINE), ['Freedom Adjustment', 'Karen Lovett']);
  assert.deepEqual(separatePayeeAddress(PROD_LINE), {
    names: 'Freedom Adjustment And Karen Lovett',
    address: '865 Route 33 Business Ste, Freehold NJ 07728',
  });
});

test('lender clause, N.A. and a PO Box: the entity keeps ISAOA/ATIMA, the PO Box is the address', () => {
  const line = 'Jane Doe & Acme Mortgage Bank, N.A. ISAOA/ATIMA PO Box 1234 Dallas TX 75201';
  assert.deepEqual(separatePayeeAddress(line), {
    names: 'Jane Doe & Acme Mortgage Bank, N.A. ISAOA/ATIMA',
    address: 'PO Box 1234, Dallas TX 75201',
  });
  assert.deepEqual(names(line), ['Jane Doe', 'Acme Mortgage Bank, N.A. ISAOA/ATIMA']);
});

test('an address in the middle of the line belongs to the payee before it', () => {
  const line = 'John Smith 123 Main St Apt 4 Austin TX 78701 And Freedom Adjustment';
  assert.deepEqual(separatePayeeAddress(line), {
    names: 'John Smith And Freedom Adjustment',
    address: '123 Main St Apt 4, Austin TX 78701',
  });
  assert.deepEqual(names(line), ['John Smith', 'Freedom Adjustment']);
});

test('an address on its own yields no names and no payees', () => {
  const line = '865 Route 33 Business Ste Freehold NJ 07728';
  assert.deepEqual(separatePayeeAddress(line), {
    names: null,
    address: '865 Route 33 Business Ste, Freehold NJ 07728',
  });
  assert.deepEqual(names(line), []);
});

test('a line with no address is unchanged', () => {
  for (const line of [
    'Gleitman Family Trust And Second Payee LLC',
    'Alpha Adjustment & Beta Homeowner & Gamma Bank ISAOA-ATIMA',
    'Wells Fargo Bank NA ISAOA/ATIMA',
  ]) {
    assert.deepEqual(separatePayeeAddress(line), { names: line, address: null }, line);
  }
  assert.deepEqual(names('Gleitman Family Trust And Second Payee LLC'), ['Gleitman Family Trust', 'Second Payee LLC']);
  assert.deepEqual(names('Alpha Adjustment & Beta Homeowner & Gamma Bank ISAOA-ATIMA'), ['Alpha Adjustment', 'Beta Homeowner', 'Gamma Bank ISAOA-ATIMA']);
  // The lender clause is one entity suffix, not a second payee "ATIMA".
  assert.deepEqual(names('Wells Fargo Bank NA ISAOA/ATIMA'), ['Wells Fargo Bank NA ISAOA/ATIMA']);
});

test('digits inside an entity name are never cut without address markers', () => {
  assert.deepEqual(separatePayeeAddress('21st Mortgage Corporation'), { names: '21st Mortgage Corporation', address: null });
  assert.equal(splitPayees('21st Mortgage Corporation').length, 1);
  assert.match(splitPayees('21st Mortgage Corporation')[0].name, /^21st Mortgage Corporation$/i);
  assert.deepEqual(separatePayeeAddress('Local 825 Operating Engineers'), { names: 'Local 825 Operating Engineers', address: null });
  // A number followed by an entity word is a name; the address after it still separates.
  assert.deepEqual(separatePayeeAddress('Station 12 LLC 45 Main St Boston MA 02110'), {
    names: 'Station 12 LLC',
    address: '45 Main St, Boston MA 02110',
  });
});

test('conservative: a city/state/ZIP with no street is left as it was', () => {
  // No street number, PO Box or unit marker: separatePayeeAddress does not guess, and
  // splitPayees keeps its earlier behaviour for the part (an address-like part is dropped).
  const line = 'Karen Lovett Freehold NJ 07728';
  assert.deepEqual(separatePayeeAddress(line), { names: line, address: null });
  assert.deepEqual(separatePayeeAddress(''), { names: null, address: null });
  assert.deepEqual(separatePayeeAddress(null), { names: null, address: null });
});

const field = (value, confidence = 0.2) => ({ valueString: value, content: value, confidence });

test('canonical payee_line holds only the names; the address moves to payee_address', () => {
  const textractOnly = mergeCheckExtraction({
    textractParsed: { payee_line: PROD_LINE, payees: [] },
    descriptiveEngine: 'aws_textract_analyze',
  });
  assert.equal(textractOnly.payee_line, 'Freedom Adjustment And Karen Lovett');
  assert.equal(textractOnly.payee_address, '865 Route 33 Business Ste, Freehold NJ 07728');
  assert.deepEqual(textractOnly.payees.map((row) => row.name), ['Freedom Adjustment', 'Karen Lovett']);
  // The Textract snapshot keeps the scanned line as evidence.
  assert.equal(textractOnly.textract_descriptive.payee_line, PROD_LINE);

  const azure = mergeCheckExtraction({
    textractParsed: { payee_line: 'Someone Else', payees: [] },
    azureMicr: normalizeAzureMicr({ fields: { PayTo: field(PROD_LINE) } }, { printedCheckNumber: null }),
    descriptiveEngine: 'aws_textract_analyze',
    azureRan: true,
    azureOk: true,
  });
  assert.equal(azure.payee_line, 'Freedom Adjustment And Karen Lovett');
  assert.equal(azure.payee_address, '865 Route 33 Business Ste, Freehold NJ 07728');
  assert.deepEqual(azure.payees.map((row) => row.name), ['Freedom Adjustment', 'Karen Lovett']);

  const plain = mergeCheckExtraction({
    textractParsed: { payee_line: 'Gleitman Family Trust', payees: [] },
    descriptiveEngine: 'aws_textract_analyze',
  });
  assert.equal(plain.payee_line, 'Gleitman Family Trust');
  assert.equal(plain.payee_address, null);
});
