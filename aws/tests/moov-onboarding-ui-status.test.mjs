// The Compliance & Docs page names the fields Moov rejected (rejected_fields from
// moov-onboarding-save, added in #1077) instead of a bare "moov_rejected".
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  describeRejectedFields,
  describeSyncStatus,
  moovFieldLabel,
} from '../../src/lib/payments/moovOnboarding.ts';

test('Moov field paths get plain-language labels; unknown paths pass through', () => {
  assert.equal(moovFieldLabel('profile.business.website'), 'Website');
  assert.equal(moovFieldLabel('profile.business.phone.number'), 'Business phone');
  assert.equal(moovFieldLabel('profile.business.taxID.ein.number'), 'EIN');
  assert.equal(moovFieldLabel('representatives.0.governmentID.ssn.full'), 'Representative SSN');
  assert.equal(moovFieldLabel('birthDate.year'), 'Representative date of birth');
  assert.equal(moovFieldLabel('capabilities.0'), 'capabilities.0');
});

test('describeRejectedFields names each field once and asks for a correction', () => {
  assert.equal(describeRejectedFields(null), null);
  assert.equal(describeRejectedFields([]), null);
  assert.equal(describeRejectedFields(['profile.business.website']), 'Moov rejected: Website. Correct it and save again.');
  assert.equal(
    describeRejectedFields(['profile.business.phone.number', 'profile.business.phone.countryCode', 'profile.business.website']),
    'Moov rejected: Business phone, Website. Correct them and save again.',
  );
});

test('the status line shows the rejected fields as an error, and other sync errors as before', () => {
  const rejected = describeSyncStatus({
    saving: false,
    lastSave: { saved: true, moov_synced: false, pending: true, error_code: 'moov_rejected', rejected_fields: ['profile.business.website'] },
  });
  assert.deepEqual(rejected, { tone: 'error', label: 'Saved, but Moov rejected: Website. Correct it and save again.' });

  const rejectedUnnamed = describeSyncStatus({
    saving: false,
    lastSave: { saved: true, moov_synced: false, pending: true, error_code: 'moov_rejected' },
  });
  assert.deepEqual(rejectedUnnamed, { tone: 'warn', label: 'Saved, Moov retry pending (moov_rejected)' });

  const down = describeSyncStatus({
    saving: false,
    lastSave: { saved: true, moov_synced: false, pending: true, error_code: 'moov_unavailable', rejected_fields: [] },
  });
  assert.deepEqual(down, { tone: 'warn', label: 'Saved, Moov retry pending (moov_unavailable)' });

  const synced = describeSyncStatus({ saving: false, lastSave: { saved: true, moov_synced: true, pending: false, error_code: null } });
  assert.deepEqual(synced, { tone: 'ok', label: 'Synced' });
});
