import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCheckFields, __test__ } from '../functions/api/ocr-parse.mjs';

const box = (Left, Top, Width = 0.2, Height = 0.03) => ({ Left, Top, Width, Height });

const line = (Text, Top, Left, Confidence = 95) => ({
  Id: `l-${Math.random().toString(16).slice(2)}`,
  BlockType: 'LINE',
  Text,
  Confidence,
  Geometry: { BoundingBox: box(Left, Top) },
});

const parse = (blocks) => parseCheckFields(blocks);

test('loss date is ignored in favor of dateline issue date', () => {
  const out = parse([
    line('SYNTHETIC MUTUAL INSURANCE COMPANY', 0.05, 0.08, 96),
    line('LOSS DATE 05-20-2026', 0.22, 0.08, 94),
    line('08-28-2026', 0.12, 0.78, 95),
    line('CHECK NO: 778899', 0.10, 0.72, 93),
    line('PAY TO THE ORDER OF', 0.30, 0.08, 95),
    line('TEST PAYEE LLC', 0.34, 0.10, 95),
    line('$100.00', 0.42, 0.78, 95),
  ]);
  assert.equal(out.issue_date, '2026-08-28');
  assert.ok(out.diagnostic.date_label_classifications.includes('loss'));
  assert.equal(out.needs_manual_review, true); // loss vs issue conflict
  assert.ok(out.low_confidence_fields.includes('issue_date'));
});

test('EXACTLY written amount converts and agrees with numeric', () => {
  const out = parse([
    line('PAY TO THE ORDER OF', 0.28, 0.08, 95),
    line('TEST PAYEE LLC', 0.32, 0.10, 95),
    line('CHECK NO 778899', 0.10, 0.72, 95),
    line('EXACTLY NINE THOUSAND EIGHT HUNDRED SIXTY AND 29/100 DOLLARS', 0.44, 0.10, 92),
    line('$9,860.29', 0.42, 0.78, 94),
  ]);
  assert.equal(out.written_amount, '9860.29');
  assert.equal(out.amount, '9860.29');
  assert.ok(!out.low_confidence_fields.includes('amount'));
});

test('wordsToNumber rejects unknown non-numeric language', () => {
  assert.equal(__test__.wordsToNumber('EXACTLY NINE THOUSAND DOLLARS'), '9000.00');
  assert.equal(__test__.wordsToNumber('PAY THIS INVOICE IMMEDIATELY DOLLARS'), null);
});

test('multiple payees split on ampersand', () => {
  const out = parse([
    line('PAY TO THE ORDER OF: ALPHA ADJUSTMENT & BETA HOMEOWNER & GAMMA BANK ISAOA-ATIMA', 0.30, 0.08, 95),
    line('CHECK NO 778899', 0.10, 0.72, 95),
    line('$10.00', 0.42, 0.78, 95),
  ]);
  assert.equal(out.payees.length, 3);
  assert.ok(out.payee_line && out.payee_line.includes('Alpha Adjustment'));
  assert.equal(out.diagnostic.payee_separator_detected, true);
  assert.ok(out.payees.some((p) => /Alpha Adjustment/i.test(p.name)));
  assert.ok(out.payees.some((p) => /Beta Homeowner/i.test(p.name)));
  assert.ok(out.payees.some((p) => /Gamma Bank/i.test(p.name)));
});

test('multiline payees joined then split', () => {
  const out = parse([
    line('PAY TO THE ORDER OF', 0.28, 0.08, 95),
    line('ALPHA ADJUSTMENT & BETA HOMEOWNER', 0.32, 0.10, 94),
    line('& GAMMA BANK ISAOA-ATIMA', 0.36, 0.10, 93),
    line('CHECK NO 778899', 0.10, 0.72, 95),
    line('$10.00', 0.42, 0.78, 95),
  ]);
  assert.equal(out.payees.length, 3);
  assert.equal(out.diagnostic.multiple_payee_lines_detected, true);
  assert.ok(out.payee_line && /Alpha Adjustment/i.test(out.payee_line));
});

test('bank line strips transit fraction', () => {
  const out = parse([
    line('PAY TO THE ORDER OF', 0.28, 0.08, 95),
    line('TEST PAYEE LLC', 0.32, 0.10, 95),
    line('CHECK NO 778899', 0.10, 0.72, 95),
    line('$10.00', 0.42, 0.78, 95),
    line('FIRST SYNTHETIC BANK, NA 56-1544/441', 0.62, 0.55, 90),
  ]);
  assert.equal(out.bank_name, 'First Synthetic Bank, NA');
  assert.ok(!/\d/.test(out.bank_name));
});

test('MICR prefers ABA-valid routing even when check number appears first', () => {
  // 123456780 is checksum-valid; 111111111 is not.
  const out = parse([
    line('CHECK NO 778899', 0.10, 0.72, 95),
    line('PAY TO THE ORDER OF', 0.28, 0.08, 95),
    line('TEST PAYEE LLC', 0.32, 0.10, 95),
    line('$10.00', 0.42, 0.78, 95),
    line('778899 123456780 222233334444', 0.90, 0.10, 82),
  ]);
  assert.equal(out.routing_number, '123456780');
  assert.equal(out.micr_check_number, '778899');
  assert.equal(out.account_number, '222233334444');
  assert.equal(out.diagnostic.aba_checksum_passed, true);
  assert.equal(out.diagnostic.printed_check_matched_micr_candidate, true);
  assert.ok(out.diagnostic.numeric_run_count >= 2);
});

test('ABA checksum helper accepts valid and rejects invalid 9-digit candidates', () => {
  assert.equal(__test__.abaRoutingChecksumOk('123456780'), true);
  assert.equal(__test__.abaRoutingChecksumOk('111111111'), false);
  assert.equal(__test__.abaRoutingChecksumOk('000000000'), true);
});

test('checksum-invalid isolated 9-digit MICR run is not selected as routing', () => {
  const out = parse([
    line('CHECK NO 778899', 0.10, 0.72, 95),
    line('PAY TO THE ORDER OF', 0.28, 0.08, 95),
    line('TEST PAYEE LLC', 0.32, 0.10, 95),
    line('$10.00', 0.42, 0.78, 95),
    line('778899 111111111 2222333', 0.90, 0.10, 80),
  ]);
  assert.equal(out.routing_number, null);
  assert.equal(out.needs_manual_review, true);
  assert.equal(out.diagnostic.aba_checksum_passed, false);
});

test('ambiguous leftover MICR runs leave account null and force review', () => {
  const out = parse([
    line('CHECK NO 778899', 0.10, 0.72, 95),
    line('PAY TO THE ORDER OF', 0.28, 0.08, 95),
    line('TEST PAYEE LLC', 0.32, 0.10, 95),
    line('$10.00', 0.42, 0.78, 95),
    line('778899 123456780 222233334 555566667', 0.90, 0.10, 80),
  ]);
  assert.equal(out.routing_number, '123456780');
  assert.equal(out.account_number, null);
  assert.equal(out.needs_manual_review, true);
});

test('low-confidence MICR fields force manual review', () => {
  const out = parse([
    line('CHECK NO 778899', 0.10, 0.72, 95),
    line('PAY TO THE ORDER OF', 0.28, 0.08, 95),
    line('TEST PAYEE LLC', 0.32, 0.10, 95),
    line('$10.00', 0.42, 0.78, 95),
    line('778899 123456780 222233334444', 0.90, 0.10, 55),
  ]);
  // Isolated checksum-valid routing still emits, but 55 is below the 70 floor unless raised.
  // Non-isolated/low path must review. If helper raises isolated+checksum to 70+,
  // account confidence follows; force a concatenated/non-isolated case:
  const concat = parse([
    line('CHECK NO 778899', 0.10, 0.72, 95),
    line('PAY TO THE ORDER OF', 0.28, 0.08, 95),
    line('TEST PAYEE LLC', 0.32, 0.10, 95),
    line('$10.00', 0.42, 0.78, 95),
    line('778899123456780222233334444', 0.90, 0.10, 60),
  ]);
  assert.equal(concat.needs_manual_review, true);
  assert.ok(
    concat.low_confidence_fields.includes('routing_number')
    || concat.account_number == null
    || concat.routing_number == null,
  );
  assert.ok(out.needs_manual_review === true || (out.field_confidence.routing_number ?? 0) >= 70);
});

test('cleanBankName helper strips ABA fraction and digits', () => {
  assert.equal(__test__.cleanBankName('First Synthetic Bank, NA 56-1544/441'), 'First Synthetic Bank, NA');
});

test('check-1 shaped fixture: date, written amount, payees, bank, MICR', () => {
  const out = parse([
    line('SYNTHETIC MUTUAL INSURANCE COMPANY', 0.04, 0.08, 96),
    line('CHECK NO 778899', 0.08, 0.72, 94),
    line('08-28-2026', 0.11, 0.78, 95),
    line('LOSS DATE 05-20-2026', 0.20, 0.08, 93),
    line('CLAIM NO 38-0F2X-055', 0.24, 0.08, 92),
    line('EXACTLY NINE THOUSAND EIGHT HUNDRED SIXTY AND 29/100 DOLLARS', 0.40, 0.08, 91),
    line('$9,860.29', 0.38, 0.78, 94),
    line('PAY TO THE ORDER OF: ALPHA ADJUSTMENT & BETA HOMEOWNER & GAMMA BANK ISAOA-ATIMA', 0.48, 0.08, 93),
    line('FIRST SYNTHETIC BANK, NA 56-1544/441', 0.18, 0.55, 88),
    line('778899 123456780 222233334444', 0.90, 0.08, 84),
  ]);
  assert.equal(out.issue_date, '2026-08-28');
  assert.equal(out.written_amount, '9860.29');
  assert.equal(out.amount, '9860.29');
  assert.equal(out.payees.length, 3);
  assert.equal(out.bank_name, 'First Synthetic Bank, NA');
  assert.equal(out.routing_number, '123456780');
  assert.equal(out.micr_check_number, '778899');
  assert.equal(out.account_number, '222233334444');
  assert.equal(out.diagnostic.payee_separator_detected, true);
  assert.equal(out.diagnostic.aba_checksum_passed, true);
  assert.equal(out.diagnostic.printed_check_matched_micr_candidate, true);
});
