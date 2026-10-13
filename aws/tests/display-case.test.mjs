import test from 'node:test';
import assert from 'node:assert/strict';
import { displayCase, displayCaseOrNull } from '../../src/lib/displayCase.ts';

test('all-caps check names render in normal capitalization', () => {
  assert.equal(displayCase('JEFF JASTRZEMBSKI'), 'Jeff Jastrzembski');
  assert.equal(
    displayCase('Perry Freedom Adjustment And JEFF JASTRZEMBSKI And WENDY JASTRZEMBSKI'),
    'Perry Freedom Adjustment and Jeff Jastrzembski and Wendy Jastrzembski',
  );
  assert.equal(displayCase("KATHRYN E O'LEARY-HILL"), "Kathryn E O'Leary-Hill");
  assert.equal(displayCase('Homesite Insurance Company Of The Midwest'), 'Homesite Insurance Company of the Midwest');
  assert.equal(displayCase('STATE FARM FIRE AND CASUALTY COMPANY'), 'State Farm Fire and Casualty Company');
  assert.equal(displayCase('THE HARTFORD'), 'The Hartford');
  assert.equal(displayCase('JOHN MCDONALD JR'), 'John McDonald Jr');
});

test('acronyms, initials, numbers and mixed-case text are preserved', () => {
  assert.equal(displayCase('ACME ROOFING LLC'), 'Acme Roofing LLC');
  assert.equal(displayCase('USAA CASUALTY INSURANCE CO'), 'USAA Casualty Insurance Co');
  assert.equal(displayCase('WELLS FARGO BANK NA ISAOA/ATIMA'), 'Wells Fargo Bank NA ISAOA/ATIMA');
  assert.equal(displayCase('JOHN SMITH III'), 'John Smith III');
  assert.equal(displayCase('J.R. SMITH'), 'J.R. Smith');
  assert.equal(displayCase('CLAIM 01-010-173883'), 'Claim 01-010-173883');
  assert.equal(displayCase('iRoofing McDonald'), 'iRoofing McDonald');
  assert.equal(displayCase('A&B CONTRACTORS'), 'A&B Contractors');
  assert.equal(displayCase('ops@EXAMPLE.COM'), 'ops@EXAMPLE.COM');
});

test('empty values', () => {
  assert.equal(displayCase(null), '');
  assert.equal(displayCase(undefined), '');
  assert.equal(displayCaseOrNull(null), null);
  assert.equal(displayCaseOrNull(''), '');
  assert.equal(displayCaseOrNull('BOB  JONES'), 'Bob  Jones');
});
