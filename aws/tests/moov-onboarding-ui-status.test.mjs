// The Compliance & Docs page names the fields Moov rejected (rejected_fields from
// moov-onboarding-save, added in #1077) instead of a bare "moov_rejected".
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildSavePayload,
  businessFormFrom,
  createOnboardingApi,
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
  assert.equal(describeRejectedFields(['profile.business.website']), 'Not accepted: Website. Correct it and save again.');
  assert.equal(
    describeRejectedFields(['profile.business.phone.number', 'profile.business.phone.countryCode', 'profile.business.website']),
    'Not accepted: Business phone, Website. Correct them and save again.',
  );
});

test('the status line shows the rejected fields as an error, and other sync errors as before', () => {
  const rejected = describeSyncStatus({
    saving: false,
    lastSave: { saved: true, moov_synced: false, pending: true, error_code: 'moov_rejected', rejected_fields: ['profile.business.website'] },
  });
  assert.deepEqual(rejected, { tone: 'error', label: 'Saved. Not accepted: Website. Correct it and save again.' });

  const rejectedUnnamed = describeSyncStatus({
    saving: false,
    lastSave: { saved: true, moov_synced: false, pending: true, error_code: 'moov_rejected' },
  });
  assert.deepEqual(rejectedUnnamed, { tone: 'warn', label: 'Saved, submission retry pending (rejected)' });

  const down = describeSyncStatus({
    saving: false,
    lastSave: { saved: true, moov_synced: false, pending: true, error_code: 'moov_unavailable', rejected_fields: [] },
  });
  assert.deepEqual(down, { tone: 'warn', label: 'Saved, submission retry pending (unavailable)' });

  const synced = describeSyncStatus({ saving: false, lastSave: { saved: true, moov_synced: true, pending: false, error_code: null } });
  assert.deepEqual(synced, { tone: 'ok', label: 'Synced' });
});

test('the business industry round-trips through the form; blank clears it; the list comes from moov-onboarding-get', async () => {
  const form = businessFormFrom({ legal_name: 'Freedom', industry: 'insurance-services' });
  assert.equal(form.industry, 'insurance-services');
  assert.equal(buildSavePayload('t1', form, []).business.industry, 'insurance-services');
  assert.equal(buildSavePayload('t1', { ...form, industry: '' }, []).business.industry, null);
  assert.equal(businessFormFrom(null).industry, '');
  assert.equal(moovFieldLabel('profile.business.industry'), 'Industry');
  const calls = [];
  const api = createOnboardingApi(async (name, body) => {
    calls.push([name, body]);
    return { industries: [{ industry: 'insurance-services', displayName: 'Insurance services', category: 'f', categoryDisplayName: 'F' }, { displayName: 'x' }] };
  });
  assert.deepEqual(await api.listIndustries('t1'), [{ industry: 'insurance-services', displayName: 'Insurance services', category: 'f', categoryDisplayName: 'F' }]);
  assert.deepEqual(calls, [['moov-onboarding-get', { tenant_id: 't1', action: 'industries' }]]);
});
