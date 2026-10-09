/**
 * Exact-ID Collection V2 synthetic UAT cleanup contract.
 * Staging fixture identity only. Does not apply SQL.
 */
import { createHash } from 'node:crypto';

export const SQL40_FILENAME = 'aws/rls/sql/40_collection_v2_synthetic_uat_cleanup.sql';
export const SQL40_MIGRATION_ID = '40_collection_v2_synthetic_uat_cleanup';
export const SQL40_SOURCE_SHA256 = '9f691e72da8e3490489854f685f470884441e61e2475b91e92fec55fd80b5de8';

export const AUTHORIZED_SYNTHETIC_FIXTURE = Object.freeze({
  harness_id: '9ff1a038-2ea8-4d67-8082-74ffd2e79a7c',
  tmp_id: 'b0e70b5b-bbcb-4c74-a2a7-1b31aba8a9c1',
  provider_transfer_id: 'ebcacb2b-c2c4-4763-bb34-63f72973290f',
  tenant_id: 'db13cc17-547b-4ca8-806a-f3cf79eafe59',
  marker: 'SYNTHETIC_UAT_COLLECTION_V2',
  event_ids: Object.freeze([
    '60120c8f-5d83-4343-85f9-16bec592741e',
    '1f832093-4d1b-43bd-829b-8fe34ccdbdb0',
  ]),
  amount_cents: 1,
  provider_environment: 'sandbox',
  expected_status: 'returned',
});

export const FORBIDDEN_FREEDOM = Object.freeze({
  tenant_id: '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a',
  tmp_id: '72b622f9-b68f-4032-a971-a854dbcfbf57',
  provider_transfer_id: 'b31c7752-031f-4b8b-9b6e-82dd0aaed2cb',
});

export const EXPECTED_DELETE_COUNTS = Object.freeze({
  payment_event_log: 2,
  tenant_maintenance_payments: 1,
  payment_transfers: 0,
});

export function canonicalizeFixtureSnapshot(snapshot = {}) {
  const events = [...(snapshot.events || [])]
    .map((row) => ({
      id: String(row.id || ''),
      tenant_id: String(row.tenant_id || ''),
      provider_transfer_id: String(row.provider_transfer_id || ''),
      synthetic_uat_marker: String(row.synthetic_uat_marker || ''),
      harness_id: String(row.harness_id || ''),
      checksops_payment_id: String(row.checksops_payment_id || ''),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    tmp: snapshot.tmp
      ? {
        id: String(snapshot.tmp.id || ''),
        tenant_id: String(snapshot.tmp.tenant_id || ''),
        provider_transfer_id: String(snapshot.tmp.provider_transfer_id || ''),
        amount_cents: Number(snapshot.tmp.amount_cents),
        provider_environment: String(snapshot.tmp.provider_environment || ''),
        status: String(snapshot.tmp.status || ''),
        marker_present: snapshot.tmp.marker_present === true,
        harness_present: snapshot.tmp.harness_present === true,
      }
      : null,
    events,
    payment_transfers: Number(snapshot.payment_transfers || 0),
  };
}

export function hashFixtureSnapshot(snapshot = {}) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalizeFixtureSnapshot(snapshot)), 'utf8')
    .digest('hex');
}

export const EMPTY_FIXTURE_SNAPSHOT = Object.freeze({
  tmp: null,
  events: Object.freeze([]),
  payment_transfers: 0,
});

export const EMPTY_FIXTURE_SHA256 = hashFixtureSnapshot(EMPTY_FIXTURE_SNAPSHOT);

export function authorizedPresentSnapshot() {
  const fixture = AUTHORIZED_SYNTHETIC_FIXTURE;
  return {
    tmp: {
      id: fixture.tmp_id,
      tenant_id: fixture.tenant_id,
      provider_transfer_id: fixture.provider_transfer_id,
      amount_cents: fixture.amount_cents,
      provider_environment: fixture.provider_environment,
      status: fixture.expected_status,
      marker_present: true,
      harness_present: true,
    },
    events: fixture.event_ids.map((id) => ({
      id,
      tenant_id: fixture.tenant_id,
      provider_transfer_id: fixture.provider_transfer_id,
      synthetic_uat_marker: fixture.marker,
      harness_id: fixture.harness_id,
      checksops_payment_id: fixture.tmp_id,
    })),
    payment_transfers: 0,
  };
}

export const AUTHORIZED_PRESENT_FIXTURE_SHA256 = hashFixtureSnapshot(authorizedPresentSnapshot());

export function matchingAuthorizedTmp(tmp) {
  const fixture = AUTHORIZED_SYNTHETIC_FIXTURE;
  return Boolean(
    tmp
    && tmp.id === fixture.tmp_id
    && tmp.tenant_id === fixture.tenant_id
    && tmp.provider_transfer_id === fixture.provider_transfer_id
    && Number(tmp.amount_cents) === fixture.amount_cents
    && tmp.provider_environment === fixture.provider_environment
    && tmp.status === fixture.expected_status
    && tmp.marker_present === true
    && tmp.harness_present === true,
  );
}

export function selectedRowReferencesForbidden(row = {}) {
  const forbidden = [
    FORBIDDEN_FREEDOM.tenant_id,
    FORBIDDEN_FREEDOM.tmp_id,
    FORBIDDEN_FREEDOM.provider_transfer_id,
  ];
  const values = [
    row.id,
    row.tenant_id,
    row.provider_transfer_id,
    row.checksops_payment_id,
    row.harness_id,
    row.notes,
  ].map((value) => String(value || ''));
  return forbidden.some((id) => values.some((value) => value.includes(id)));
}

export function evaluateFixtureGuards(snapshot = {}) {
  const canon = canonicalizeFixtureSnapshot(snapshot);
  const errors = [];
  if (canon.tmp && selectedRowReferencesForbidden({
    ...canon.tmp,
    notes: snapshot.tmp?.notes,
  })) {
    errors.push('SQL40_FORBIDDEN_TMP_REFERENCE');
  }
  for (const event of canon.events) {
    if (selectedRowReferencesForbidden(event)) {
      errors.push('SQL40_FORBIDDEN_EVENT_REFERENCE');
    }
  }
  if (!matchingAuthorizedTmp(canon.tmp)) errors.push('SQL40_TMP_MISMATCH');
  const eventIds = canon.events.map((row) => row.id).sort();
  const expectedIds = [...AUTHORIZED_SYNTHETIC_FIXTURE.event_ids].sort();
  if (eventIds.length !== 2 || eventIds.join(',') !== expectedIds.join(',')) {
    errors.push('SQL40_EVENT_COUNT');
  }
  if (canon.events.some((row) => (
    row.tenant_id !== AUTHORIZED_SYNTHETIC_FIXTURE.tenant_id
    || row.provider_transfer_id !== AUTHORIZED_SYNTHETIC_FIXTURE.provider_transfer_id
    || row.synthetic_uat_marker !== AUTHORIZED_SYNTHETIC_FIXTURE.marker
    || row.harness_id !== AUTHORIZED_SYNTHETIC_FIXTURE.harness_id
    || row.checksops_payment_id !== AUTHORIZED_SYNTHETIC_FIXTURE.tmp_id
  ))) {
    errors.push('SQL40_EVENT_COUNT');
  }
  if (canon.payment_transfers !== 0) errors.push('SQL40_PAYMENT_TRANSFER_PRESENT');
  return {
    ok: errors.length === 0,
    errors,
    hash: hashFixtureSnapshot(canon),
    expected_deletes: EXPECTED_DELETE_COUNTS,
  };
}

export function sql40FailClosedNames() {
  return Object.freeze([
    'SQL40_FORBIDDEN_ID_COLLISION',
    'SQL40_FORBIDDEN_TMP_REFERENCE',
    'SQL40_FORBIDDEN_EVENT_REFERENCE',
    'SQL40_TMP_MISSING',
    'SQL40_TMP_MISMATCH',
    'SQL40_TMP_COUNT',
    'SQL40_EVENT_COUNT',
    'SQL40_EVENT_IDS_MISSING',
    'SQL40_PAYMENT_TRANSFER_PRESENT',
    'SQL40_EVENT_DELETE_COUNT',
    'SQL40_TMP_DELETE_COUNT',
    'SQL40_TMP_STILL_PRESENT',
    'SQL40_EVENTS_STILL_PRESENT',
    'SQL40_PAYMENT_TRANSFER_PRESENT_AFTER',
  ]);
}
