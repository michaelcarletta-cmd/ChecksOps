import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { resolveMessageThreadTitle } from '../../src/lib/messageThreadTitle.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PANEL = fs.readFileSync(
  path.join(ROOT, 'src/components/check-messages/CheckMessagesPanel.tsx'),
  'utf8',
);

const FULL_PAYEE_LINE =
  'John Smith & Jane Smith & Freedom Adjustment & Wells Fargo Bank, N.A.';

test('uses insured check payees and formats a shared last name', () => {
  const title = resolveMessageThreadTitle({
    payees: [
      { payee_name: 'John Smith', payee_type: 'insured' },
      { payee_name: 'Jane Smith', payee_type: 'insured' },
      { payee_name: 'Freedom Adjustment', payee_type: 'public_adjuster' },
      { payee_name: 'Wells Fargo Bank, N.A.', payee_type: 'mortgage_company' },
    ],
    caseInsuredName: 'Should not win',
    policyholderName: 'Should not win',
  });
  assert.equal(title, 'John & Jane Smith');
});

test('treats homeowner and policyholder payee types as insured', () => {
  const title = resolveMessageThreadTitle({
    payees: [
      { payee_name: 'John Smith', payee_type: 'homeowner' },
      { payee_name: 'Jane Smith', payee_type: 'policyholder' },
    ],
  });
  assert.equal(title, 'John & Jane Smith');
});

test('uses the linked case insured name before the claim policyholder', () => {
  const title = resolveMessageThreadTitle({
    payees: [
      { payee_name: FULL_PAYEE_LINE, payee_type: 'unknown' },
    ],
    caseInsuredName: 'Maria Garcia',
    policyholderName: 'Someone Else',
  });
  assert.equal(title, 'Maria Garcia');
});

test('falls back to claim named insured when no insured payee or case name exists', () => {
  const title = resolveMessageThreadTitle({
    payees: [
      { payee_name: 'Freedom Adjustment', payee_type: 'public_adjuster' },
      { payee_name: 'Wells Fargo Bank, N.A.', payee_type: 'mortgage_company' },
    ],
    caseInsuredName: '  ',
    policyholderName: 'John Smith & Jane Smith',
  });
  assert.equal(title, 'John & Jane Smith');
});

test('uses person-shaped untyped OCR payees, skipping companies, banks and adjusters', () => {
  const title = resolveMessageThreadTitle({
    payees: [
      { payee_name: 'JOHN SMITH', payee_type: 'unknown' },
      { payee_name: 'JANE SMITH', payee_type: 'unknown' },
      { payee_name: 'Freedom Adjustment', payee_type: 'unknown' },
      { payee_name: 'Wells Fargo Bank, N.A.', payee_type: 'unknown' },
      { payee_name: 'ABC Roofing LLC', payee_type: 'unknown' },
      { payee_name: 'Rocket Mortgage', payee_type: 'unknown' },
    ],
  });
  assert.equal(title, 'JOHN & JANE SMITH');
});

test('never returns the raw payee line as the subject', () => {
  assert.equal(
    resolveMessageThreadTitle({
      payees: [
        { payee_name: 'Freedom Adjustment', payee_type: 'public_adjuster' },
        { payee_name: 'Wells Fargo Bank, N.A.', payee_type: 'mortgage_company' },
        { payee_name: FULL_PAYEE_LINE, payee_type: 'unknown' },
      ],
      policyholderName: null,
    }),
    null,
  );
  // A typed mortgage company is never treated as untyped.
  assert.equal(
    resolveMessageThreadTitle({
      payees: [{ payee_name: 'Wells Fargo', payee_type: 'mortgage_company' }],
    }),
    null,
  );
});

test('never returns Unknown', () => {
  assert.equal(
    resolveMessageThreadTitle({
      payees: [],
      caseInsuredName: 'Unknown',
      policyholderName: 'Unknown.',
    }),
    null,
  );
  assert.equal(
    resolveMessageThreadTitle({
      payees: [{ payee_name: 'Unknown', payee_type: 'insured' }],
    }),
    null,
  );
});

test('keeps distinct last names joined without inventing a shared surname', () => {
  const title = resolveMessageThreadTitle({
    payees: [
      { payee_name: 'John Smith', payee_type: 'insured' },
      { payee_name: 'Maria Garcia', payee_type: 'insured' },
    ],
  });
  assert.equal(title, 'John Smith & Maria Garcia');
});

test('ignores blank insured names and prefers remaining structured insured', () => {
  const title = resolveMessageThreadTitle({
    payees: [
      { payee_name: '  ', payee_type: 'insured' },
      { payee_name: 'Jane Smith', payee_type: 'insured' },
    ],
  });
  assert.equal(title, 'Jane Smith');
});

test('Messages panel derives the subject from the linked check, not the payee line', () => {
  assert.doesNotMatch(PANEL, /fallbackTitle/);
  assert.doesNotMatch(PANEL, /fallbackTitle:\s*check\.payee_line/);
  assert.match(PANEL, /case_id, claims\(claim_number, policyholder_name\), check_payees\(payee_name, payee_type\)/);
  assert.match(PANEL, /\.from\("check_cases"\)\s*\.select\("id, insured_name"\)/);
  assert.match(PANEL, /caseInsuredName: check\.case_id \? caseNames\.get\(check\.case_id\) : null/);
});
