import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isEffectivelyAllCaps,
  normalizeClaimNumber,
  normalizeDescriptiveText,
} from '../functions/api/ocr-descriptive-text.mjs';

test('ALL-CAPS person name becomes human-readable', () => {
  assert.equal(normalizeDescriptiveText('MICHAEL GLEITMAN'), 'Michael Gleitman');
});

test('ALL-CAPS company becomes human-readable', () => {
  assert.equal(normalizeDescriptiveText('FREEDOM ADJUSTMENT INC'), 'Freedom Adjustment Inc');
});

test('already mixed-case name remains unchanged', () => {
  assert.equal(normalizeDescriptiveText('Freedom Adjustment Inc'), 'Freedom Adjustment Inc');
  assert.equal(isEffectivelyAllCaps('Freedom Adjustment Inc'), false);
});

test('hyphenated and apostrophe names keep punctuation', () => {
  assert.equal(normalizeDescriptiveText("O'CONNOR"), "O'Connor");
  assert.equal(normalizeDescriptiveText('SMITH-JONES'), 'Smith-Jones');
  assert.equal(normalizeDescriptiveText('A.B.C. COMPANY'), 'A.B.C. Company');
});

test('recognized acronyms and business suffixes stay uppercase', () => {
  assert.equal(normalizeDescriptiveText('JOHN SMITH LLC'), 'John Smith LLC');
  assert.equal(normalizeDescriptiveText('SMITH LLP'), 'Smith LLP');
  assert.equal(normalizeDescriptiveText('ACME LP'), 'Acme LP');
  assert.equal(normalizeDescriptiveText('JONES PC'), 'Jones PC');
  assert.equal(normalizeDescriptiveText('LEE PA'), 'Lee PA');
  assert.equal(normalizeDescriptiveText('WESTSIDE PLLC'), 'Westside PLLC');
  assert.equal(normalizeDescriptiveText('NJM'), 'NJM');
  assert.equal(normalizeDescriptiveText('USAA'), 'USAA');
  assert.equal(normalizeDescriptiveText('USA INSURANCE'), 'USA Insurance');
});

test('claim-number formatter preserves leading zeros and punctuation', () => {
  assert.equal(normalizeClaimNumber('  00412-AB/9  '), '00412-AB/9');
  assert.equal(normalizeClaimNumber('38-99V2-97X'), '38-99V2-97X');
});

test('emails and URLs are not title-cased', () => {
  assert.equal(normalizeDescriptiveText('OPS@EXAMPLE.COM'), 'OPS@EXAMPLE.COM');
  assert.equal(normalizeDescriptiveText('HTTPS://EXAMPLE.COM/X'), 'HTTPS://EXAMPLE.COM/X');
});
