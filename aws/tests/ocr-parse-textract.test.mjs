import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCheckFields } from '../functions/api/ocr-parse.mjs';

const box = (Left, Top, Width = 0.2, Height = 0.03) => ({ Left, Top, Width, Height });

const line = (Text, Top, Left, Confidence = 95) => ({
  Id: `l-${Math.random().toString(16).slice(2)}`,
  BlockType: 'LINE',
  Text,
  Confidence,
  Geometry: { BoundingBox: box(Left, Top) },
});

const parse = (blocks) => parseCheckFields(blocks);

test('1) standard printed insurance check extracts core fields + MICR + memo', () => {
  const blocks = [
    line('SYNTHETIC STAGING MUTUAL INSURANCE COMPANY', 0.05, 0.10, 96),
    line('DATE: 01/15/2026', 0.10, 0.70, 94),
    line('CHECK NO: 778899', 0.12, 0.72, 93),
    line('PAY TO THE ORDER OF:', 0.28, 0.08, 95),
    line('STAGING UAT HOMEOWNER AND FREEDOM ADJUSTMENT LLC', 0.32, 0.10, 92),
    line('ONE THOUSAND TWO HUNDRED THIRTY FOUR AND 56/100 DOLLARS', 0.44, 0.10, 90),
    line('$1,234.56', 0.42, 0.78, 94),
    line('Claim # CLM-STAGING-7788', 0.55, 0.10, 91),
    line('MEMO: WATER LOSS', 0.70, 0.12, 90),
    line('FIRST SYNTHETIC BANK', 0.66, 0.10, 88),
    // Fake MICR band (digits only; not real account data)
    line('000000000 111122223333 4444', 0.90, 0.10, 80),
  ];
  const out = parse(blocks);
  assert.equal(out.carrier_name, 'Synthetic Staging Mutual Insurance Company');
  assert.equal(out.issue_date, '2026-01-15');
  assert.equal(out.check_number, '778899');
  assert.equal(out.amount, '1234.56');
  assert.equal(out.written_amount, '1234.56');
  assert.equal(out.claim_number, 'CLM-STAGING-7788');
  assert.ok(out.payee_line && out.payee_line.includes('Staging Uat Homeowner'));
  assert.equal(out.memo, 'Water Loss');
  assert.equal(out.bank_name, 'First Synthetic Bank');
  assert.equal(out.routing_number, '000000000');
  // Ensure masking helpers exist and do not expose full digits when used.
  assert.equal(out.masked.routing_number, '***0000');
});

test('2) handwritten-ish check triggers manual review when critical confidence is low', () => {
  const blocks = [
    line('HANDWRITTEN CHECK', 0.05, 0.10, 70),
    line('DATE 9/3/26', 0.12, 0.70, 60),
    line('PAY TO THE ORDER OF', 0.30, 0.10, 55),
    line('J. DOE', 0.34, 0.12, 45), // low confidence payee line
    line('$250.00', 0.42, 0.78, 50),
  ];
  const out = parse(blocks);
  assert.equal(out.needs_manual_review, true);
  assert.ok(out.low_confidence_fields.includes('payee_line') || out.low_confidence_fields.includes('check_number'));
});

test('3) multiple payees extracted; address lines rejected as payees', () => {
  const blocks = [
    line('PAY TO THE ORDER OF', 0.28, 0.08, 95),
    line('JANE DOE AND FIRST NATIONAL BANK, N.A.', 0.32, 0.10, 93),
    line('123 MAIN ST SUITE 5', 0.36, 0.10, 92),
    line('ANYTOWN, NY 10001', 0.39, 0.10, 92),
    line('$1,250.00', 0.42, 0.78, 94),
  ];
  const out = parse(blocks);
  assert.equal(out.payees.length, 2);
  assert.ok(out.payees.some((p) => p.name.includes('Jane Doe')));
  assert.ok(out.payees.some((p) => p.name.includes('First National Bank')));
  // Ensure no address fragments become payees.
  assert.ok(!out.payees.some((p) => /main st|10001/i.test(p.name)));
});

test('4) low-confidence amount flagged', () => {
  const blocks = [
    line('PAY TO THE ORDER OF', 0.28, 0.08, 95),
    line('TEST PAYEE', 0.32, 0.10, 95),
    line('$1,000.00', 0.42, 0.78, 40), // low confidence numeric amount
  ];
  const out = parse(blocks);
  assert.equal(out.needs_manual_review, true);
  assert.ok(out.low_confidence_fields.includes('amount'));
});

test('5) missing check number does not fabricate; triggers review', () => {
  const blocks = [
    line('DATE: 01/15/2026', 0.10, 0.70, 94),
    line('PAY TO THE ORDER OF', 0.28, 0.08, 95),
    line('TEST PAYEE', 0.32, 0.10, 95),
    line('$10.00', 0.42, 0.78, 94),
  ];
  const out = parse(blocks);
  assert.equal(out.check_number, null);
  assert.equal(out.needs_manual_review, true);
});

test('6) numeric vs written amount disagreement triggers review', () => {
  const blocks = [
    line('PAY TO THE ORDER OF', 0.28, 0.08, 95),
    line('TEST PAYEE', 0.32, 0.10, 95),
    line('ONE THOUSAND AND 00/100 DOLLARS', 0.44, 0.10, 92),
    line('$100.00', 0.42, 0.78, 94),
  ];
  const out = parse(blocks);
  assert.equal(out.amount, '100.00');
  assert.equal(out.written_amount, '1000.00');
  assert.equal(out.needs_manual_review, true);
  assert.ok(out.low_confidence_fields.includes('amount'));
});

test('7) front-only check supported (no rear required)', () => {
  const blocks = [
    line('INSURANCE CO', 0.05, 0.10, 95),
    line('CHECK NO 12345', 0.10, 0.72, 95),
    line('PAY TO THE ORDER OF', 0.28, 0.08, 95),
    line('TEST PAYEE', 0.32, 0.10, 95),
    line('$55.00', 0.42, 0.78, 95),
  ];
  const out = parse(blocks);
  assert.equal(out.check_number, '12345');
  assert.equal(out.amount, '55.00');
});

test('9) malformed / non-check upload yields nulls and review-required', () => {
  const blocks = [
    line('THIS IS NOT A CHECK', 0.10, 0.10, 90),
    line('RANDOM TEXT ONLY', 0.20, 0.10, 90),
  ];
  const out = parse(blocks);
  assert.equal(out.amount, null);
  assert.equal(out.payee_line, null);
  assert.equal(out.needs_manual_review, true);
});

test('13) extracted routing/account are masked in helper output (no fixture leaks)', () => {
  const blocks = [
    line('000000000 111122223333 4444', 0.90, 0.10, 80),
    line('PAY TO THE ORDER OF', 0.28, 0.08, 95),
    line('TEST PAYEE', 0.32, 0.10, 95),
    line('$10.00', 0.42, 0.78, 95),
  ];
  const out = parse(blocks);
  assert.equal(out.routing_number, '000000000');
  assert.equal(out.masked.routing_number, '***0000');
});

test('14) claim number label wins over MICR digits (no MICR/claim confusion)', () => {
  const blocks = [
    line('Claim # CLM-ABC-12345', 0.55, 0.10, 92),
    line('000000000 111122223333 4444', 0.90, 0.10, 80),
    line('PAY TO THE ORDER OF', 0.28, 0.08, 95),
    line('TEST PAYEE', 0.32, 0.10, 95),
    line('$10.00', 0.42, 0.78, 95),
  ];
  const out = parse(blocks);
  assert.equal(out.claim_number, 'CLM-ABC-12345');
});

test('15) address text near payee does not become a payee entity', () => {
  const blocks = [
    line('PAY TO THE ORDER OF', 0.28, 0.08, 95),
    line('JOHN DOE', 0.32, 0.10, 93),
    line('865 ROUTE 33 BUSINESS STE 3 UNIT #231', 0.36, 0.10, 92),
    line('FREEHOLD NJ 07728', 0.39, 0.10, 92),
    line('$10.00', 0.42, 0.78, 95),
  ];
  const out = parse(blocks);
  assert.equal(out.payees.length, 1);
  assert.ok(out.payees[0].name.includes('John Doe'));
});


test('16) unrelated nearby OCR text is not appended to a completed payee line', () => {
  const blocks = [
    line('PAY TO THE ORDER OF', 0.28, 0.08, 95),
    line('FREEDOM ADJUSTMENT & KRISTOPHER HALSEY', 0.32, 0.10, 95),
    line('JONCJARNEY', 0.35, 0.10, 91),
    line('$1,250.00', 0.42, 0.78, 94),
  ];
  const out = parse(blocks);
  assert.equal(out.payee_line, 'Freedom Adjustment & Kristopher Halsey');
  assert.equal(out.payees.length, 2);
  assert.ok(out.payees.some((p) => p.name === 'Freedom Adjustment'));
  assert.ok(out.payees.some((p) => p.name === 'Kristopher Halsey'));
  assert.ok(!out.payee_line.includes('Joncjarney'));
});

test('17) explicit separator still allows a legitimate multiline payee continuation', () => {
  const blocks = [
    line('PAY TO THE ORDER OF', 0.28, 0.08, 95),
    line('FREEDOM ADJUSTMENT &', 0.32, 0.10, 95),
    line('KRISTOPHER HALSEY', 0.35, 0.10, 94),
    line('$1,250.00', 0.42, 0.78, 94),
  ];
  const out = parse(blocks);
  assert.equal(out.payee_line, 'Freedom Adjustment & Kristopher Halsey');
  assert.equal(out.payees.length, 2);
});
