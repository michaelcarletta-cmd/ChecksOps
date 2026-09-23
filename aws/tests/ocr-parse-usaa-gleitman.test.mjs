import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCheckFields, __test__ } from '../functions/api/ocr-parse.mjs';
import { mergeCheckExtraction } from '../functions/api/check-ocr-provider.mjs';
import { normalizeAzureMicr } from '../functions/api/ocr-normalize-azure.mjs';

const box = (Left, Top, Width = 0.35, Height = 0.03) => ({ Left, Top, Width, Height });
const line = (Text, Top, Left, Confidence = 94) => ({
  Id: `l-${Math.random().toString(16).slice(2)}`,
  BlockType: 'LINE',
  Text,
  Confidence,
  Geometry: { BoundingBox: box(Left, Top) },
});

const WATERMARK = 'FACE OF DOCUMENT HAS A COLORED BACKGROUND THE BACK CONTAINS AN ARTIFICIAL WATERMARK HOLD AT ANGLE TO VIEW';

test('USAA watermark is not selected as carrier when USAA is present', () => {
  const out = parseCheckFields([
    line(WATERMARK, 0.04, 0.08, 88),
    line('USAA', 0.07, 0.10, 96),
    line('CHECK NO 41822', 0.10, 0.72, 95),
    line('08/24/2026', 0.12, 0.78, 95),
    line('PAY TO THE ORDER OF', 0.30, 0.08, 95),
    line('FREEDOM ADJUSTMENT AND IRWIN L GLEITMAN AND SONDRA GLEITMAN', 0.34, 0.10, 94),
    line('$1,234.56', 0.42, 0.78, 95),
  ]);
  assert.equal(out.carrier_name, 'USAA');
  assert.equal(out.check_number, '41822');
  assert.equal(out.issue_date, '2026-08-24');
  assert.equal(out.amount, '1234.56');
  assert.equal(out.diagnostic.carrier_rejected_disclaimer, true);
});

test('watermark-only face leaves carrier empty instead of persisting disclaimer', () => {
  const out = parseCheckFields([
    line(WATERMARK, 0.05, 0.08, 90),
    line('CHECK NO 41822', 0.10, 0.72, 95),
    line('08/24/2026', 0.12, 0.78, 95),
    line('PAY TO THE ORDER OF', 0.30, 0.08, 95),
    line('FREEDOM ADJUSTMENT LLC', 0.34, 0.10, 94),
    line('$10.00', 0.42, 0.78, 95),
  ]);
  assert.equal(out.carrier_name, null);
  assert.equal(out.diagnostic.carrier_rejected_disclaimer, true);
});

test('trailing The Order is stripped from Sandra Gleitman payee line', () => {
  const out = parseCheckFields([
    line('USAA CASUALTY INSURANCE COMPANY', 0.06, 0.08, 96),
    line('CHECK NO 41822', 0.10, 0.72, 95),
    line('PAY TO THE ORDER OF', 0.28, 0.08, 95),
    line('FREEDOM ADJUSTMENT AND IRWIN L GLEITMAN AND SONDRA GLEITMAN THE ORDER', 0.32, 0.10, 93),
    line('$10.00', 0.42, 0.78, 95),
  ]);
  assert.match(out.payee_line, /Sondra Gleitman$/);
  assert.doesNotMatch(out.payee_line, /The Order/i);
  assert.equal(out.payees.length, 3);
  assert.ok(out.payees.some((p) => p.name === 'Sondra Gleitman'));
  assert.ok(!out.payees.some((p) => /order/i.test(p.name)));
});

test('wrapped leftover THE ORDER line is not joined onto payees', () => {
  const out = parseCheckFields([
    line('USAA', 0.06, 0.08, 96),
    line('CHECK NO 41822', 0.10, 0.72, 95),
    line('PAY TO THE ORDER OF', 0.28, 0.08, 95),
    line('FREEDOM ADJUSTMENT AND IRWIN L GLEITMAN AND SONDRA GLEITMAN', 0.32, 0.10, 94),
    line('THE ORDER', 0.36, 0.10, 90),
    line('$10.00', 0.42, 0.78, 95),
  ]);
  assert.equal(out.payees.length, 3);
  assert.ok(out.payees.some((p) => p.name === 'Sondra Gleitman'));
  assert.doesNotMatch(out.payee_line, /The Order/i);
});

test('cleanPayeeLine helpers reject order fragments', () => {
  assert.equal(__test__.cleanPayeeLine('THE ORDER'), null);
  assert.equal(
    __test__.cleanPayeeLine('FREEDOM ADJUSTMENT AND SONDRA GLEITMAN THE ORDER'),
    'FREEDOM ADJUSTMENT AND SONDRA GLEITMAN',
  );
  assert.equal(__test__.sanitizeCarrierName(WATERMARK), null);
  assert.equal(__test__.matchKnownCarrier('United Services Automobile Association'), 'USAA');
  assert.equal(__test__.looksLikeSecurityDisclaimer(WATERMARK), true);
});

test('merge prefers USAA over Azure/Textract watermark payer text', () => {
  const canonical = mergeCheckExtraction({
    textractParsed: {
      carrier_name: WATERMARK,
      payee_line: 'Freedom Adjustment And Irwin L Gleitman And Sondra Gleitman The Order',
      payees: [
        { name: 'Freedom Adjustment', type: 'unknown' },
        { name: 'Irwin L Gleitman', type: 'unknown' },
        { name: 'Sondra Gleitman The Order', type: 'unknown' },
      ],
      amount: '1234.56',
      check_number: '41822',
      diagnostic: { carrier_rejected_disclaimer: true },
    },
    azureMicr: normalizeAzureMicr({
      fields: {
        PayerName: { valueString: WATERMARK, confidence: 0.2 },
        PayTo: { valueString: 'FREEDOM ADJUSTMENT AND IRWIN L GLEITMAN AND SONDRA GLEITMAN THE ORDER', confidence: 0.4 },
        NumberAmount: { valueNumber: 1234.56, confidence: 0.5 },
      },
    }),
    descriptiveEngine: 'aws_textract_analyze',
    azureRan: true,
    azureOk: true,
  });
  assert.equal(canonical.carrier_name, null);
  assert.doesNotMatch(String(canonical.payee_line || ''), /The Order/i);
  assert.ok(canonical.payees.some((p) => p.name === 'Sondra Gleitman'));
  assert.equal(canonical.amount, '1234.56');
});

test('Bank of America is the drawee bank, not the USAA carrier', () => {
  const out = parseCheckFields([
    line(WATERMARK, 0.04, 0.08, 88),
    line('USAA', 0.07, 0.10, 96),
    line('BANK OF AMERICA', 0.08, 0.55, 94),
    line('CHECK NO 41822', 0.10, 0.72, 95),
    line('08/24/2026', 0.12, 0.78, 95),
    line('PAY TO THE ORDER OF', 0.30, 0.08, 95),
    line('FREEDOM ADJUSTMENT AND IRWIN L GLEITMAN AND SONDRA GLEITMAN', 0.34, 0.10, 94),
    line('***$1,234.56', 0.42, 0.78, 95),
    line('ONE THOUSAND TWO HUNDRED THIRTY FOUR AND 56/100', 0.46, 0.10, 92),
  ]);
  assert.equal(out.carrier_name, 'USAA');
  assert.notEqual(out.carrier_name, 'Bank Of America');
  assert.equal(out.amount, '1234.56');
  assert.equal(out.written_amount, '1234.56');
  assert.equal(out.bank_name, 'Bank Of America');
  assert.equal(out.diagnostic.carrier_rejected_bank, true);
});

test('bank-only face does not persist Bank of America as carrier', () => {
  const out = parseCheckFields([
    line('BANK OF AMERICA', 0.08, 0.10, 96),
    line('CHECK NO 41822', 0.10, 0.72, 95),
    line('PAY TO THE ORDER OF', 0.30, 0.08, 95),
    line('FREEDOM ADJUSTMENT LLC', 0.34, 0.10, 94),
    line('$10.00', 0.42, 0.78, 95),
  ]);
  assert.equal(out.carrier_name, null);
  assert.equal(__test__.sanitizeCarrierName('Bank of America'), null);
  assert.equal(__test__.looksLikeBankName('BANK OF AMERICA'), true);
});

test('merge keeps Textract USAA when Azure payer is Bank of America', () => {
  const canonical = mergeCheckExtraction({
    textractParsed: {
      carrier_name: 'USAA',
      bank_name: 'Bank of America',
      payee_line: 'Freedom Adjustment And Irwin L Gleitman And Sondra Gleitman',
      payees: [{ name: 'Freedom Adjustment', type: 'unknown' }],
      amount: '1234.56',
      check_number: '41822',
    },
    azureMicr: normalizeAzureMicr({
      fields: {
        PayerName: { valueString: 'Bank of America', confidence: 0.81 },
        BankName: { valueString: 'Bank of America', confidence: 0.9 },
        PayTo: { valueString: 'FREEDOM ADJUSTMENT AND IRWIN L GLEITMAN AND SONDRA GLEITMAN', confidence: 0.4 },
        NumberAmount: { valueNumber: 1234.56, confidence: 0.88 },
      },
    }),
    descriptiveEngine: 'aws_textract_analyze',
    azureRan: true,
    azureOk: true,
  });
  assert.equal(canonical.carrier_name, 'USAA');
  assert.equal(canonical.descriptive_sources.carrier_name, 'aws_textract_analyze');
  assert.ok(!canonical.filled_from_azure.includes('carrier_name'));
  assert.equal(canonical.amount, '1234.56');
  assert.equal(canonical.bank_name, 'Bank of America');
});

test('merge keeps Textract USAA when Azure payer is a disclaimer', () => {
  const canonical = mergeCheckExtraction({
    textractParsed: {
      carrier_name: 'USAA',
      payee_line: 'Freedom Adjustment And Irwin L Gleitman And Sondra Gleitman',
      payees: [{ name: 'Freedom Adjustment', type: 'unknown' }],
      amount: '99.00',
      check_number: '41822',
    },
    azureMicr: normalizeAzureMicr({
      fields: {
        PayerName: { valueString: WATERMARK, confidence: 0.11 },
        PayTo: { valueString: 'FREEDOM ADJUSTMENT AND IRWIN L GLEITMAN AND SONDRA GLEITMAN', confidence: 0.4 },
        NumberAmount: { valueNumber: 99, confidence: 0.5 },
      },
    }),
    descriptiveEngine: 'aws_textract_analyze',
    azureRan: true,
    azureOk: true,
  });
  assert.equal(canonical.carrier_name, 'USAA');
  assert.equal(canonical.descriptive_sources.carrier_name, 'aws_textract_analyze');
  assert.ok(!canonical.filled_from_azure.includes('carrier_name'));
});
