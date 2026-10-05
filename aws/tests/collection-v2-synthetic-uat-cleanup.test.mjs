import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  AUTHORIZED_PRESENT_FIXTURE_SHA256,
  AUTHORIZED_SYNTHETIC_FIXTURE,
  EMPTY_FIXTURE_SHA256,
  EMPTY_FIXTURE_SNAPSHOT,
  EXPECTED_DELETE_COUNTS,
  FORBIDDEN_FREEDOM,
  SQL40_FILENAME,
  SQL40_SOURCE_SHA256,
  authorizedPresentSnapshot,
  evaluateFixtureGuards,
  hashFixtureSnapshot,
  sql40FailClosedNames,
} from '../../scripts/deployment-guard/lib/collection-v2-synthetic-uat-cleanup.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const APPLY = fs.readFileSync(path.join(ROOT, SQL40_FILENAME), 'utf8');

const statementsOf = (sql) => sql
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');

test('SQL 40 source SHA matches the reviewed exact-ID cleanup file', () => {
  const sha = createHash('sha256').update(fs.readFileSync(path.join(ROOT, SQL40_FILENAME))).digest('hex');
  assert.equal(sha, SQL40_SOURCE_SHA256);
  assert.equal(sha, '9f691e72da8e3490489854f685f470884441e61e2475b91e92fec55fd80b5de8');
});

test('SQL 40 is source/test only and does not grant DELETE or change RLS/SQL 39', () => {
  const body = statementsOf(APPLY);
  assert.match(APPLY, /SOURCE \/ TEST ONLY/);
  assert.match(APPLY, /Not a Supabase migration/);
  assert.match(APPLY, /Exact IDs only/);
  assert.doesNotMatch(body, /\bGRANT\b/);
  assert.doesNotMatch(body, /\bREVOKE\b/);
  assert.doesNotMatch(body, /DISABLE ROW LEVEL SECURITY/);
  assert.doesNotMatch(body, /ENABLE ROW LEVEL SECURITY/);
  assert.doesNotMatch(body, /FORCE ROW LEVEL SECURITY/);
  assert.doesNotMatch(body, /DROP POLICY/);
  assert.doesNotMatch(body, /CREATE POLICY/);
  assert.doesNotMatch(body, /aws_write_tenant_maintenance_payments/);
  assert.doesNotMatch(body, /aws_can_write_tenant/);
  assert.doesNotMatch(body, /service_role/);
  assert.doesNotMatch(APPLY, /from\(['"]tenant_maintenance_payments['"]\)/);
});

test('SQL 40 binds the accepted synthetic fixture and refuses Freedom IDs', () => {
  assert.match(APPLY, new RegExp(AUTHORIZED_SYNTHETIC_FIXTURE.tmp_id));
  assert.match(APPLY, new RegExp(AUTHORIZED_SYNTHETIC_FIXTURE.tenant_id));
  assert.match(APPLY, new RegExp(AUTHORIZED_SYNTHETIC_FIXTURE.provider_transfer_id));
  assert.match(APPLY, new RegExp(AUTHORIZED_SYNTHETIC_FIXTURE.harness_id));
  assert.match(APPLY, /SYNTHETIC_UAT_COLLECTION_V2/);
  assert.match(APPLY, /60120c8f-5d83-4343-85f9-16bec592741e/);
  assert.match(APPLY, /1f832093-4d1b-43bd-829b-8fe34ccdbdb0/);
  assert.match(APPLY, /amount_cents = 1/);
  assert.match(APPLY, /provider_environment = 'sandbox'/);
  assert.match(APPLY, /status = 'returned'/);
  assert.match(APPLY, new RegExp(FORBIDDEN_FREEDOM.tenant_id));
  assert.match(APPLY, new RegExp(FORBIDDEN_FREEDOM.tmp_id));
  assert.match(APPLY, new RegExp(FORBIDDEN_FREEDOM.provider_transfer_id));
  assert.match(APPLY, /SQL40_FORBIDDEN_TMP_REFERENCE/);
  assert.match(APPLY, /SQL40_FORBIDDEN_EVENT_REFERENCE/);
});

test('SQL 40 deletes only the exact two events and exact TMP after count guards', () => {
  const body = statementsOf(APPLY);
  assert.match(body, /GET DIAGNOSTICS deleted_events = ROW_COUNT/);
  assert.match(body, /GET DIAGNOSTICS deleted_tmp = ROW_COUNT/);
  assert.match(body, /SQL40_EVENT_DELETE_COUNT/);
  assert.match(body, /SQL40_TMP_DELETE_COUNT/);
  assert.match(body, /SQL40_TMP_STILL_PRESENT/);
  assert.match(body, /SQL40_EVENTS_STILL_PRESENT/);
  assert.match(body, /COMMIT/);
  const eventDeletes = body.match(/DELETE FROM public\.payment_event_log/g) || [];
  const tmpDeletes = body.match(/DELETE FROM public\.tenant_maintenance_payments/g) || [];
  const transferDeletes = body.match(/DELETE FROM public\.payment_transfers/g) || [];
  assert.equal(eventDeletes.length, 1);
  assert.equal(tmpDeletes.length, 1);
  assert.equal(transferDeletes.length, 0);
  assert.match(body, /WHERE id IN \(event_a, event_b\)/);
  assert.match(body, /WHERE id = auth_tmp/);
  const eventDelete = body.match(/DELETE FROM public\.payment_event_log[\s\S]*?GET DIAGNOSTICS deleted_events/)?.[0] || '';
  const tmpDelete = body.match(/DELETE FROM public\.tenant_maintenance_payments[\s\S]*?GET DIAGNOSTICS deleted_tmp/)?.[0] || '';
  assert.match(eventDelete, /WHERE id IN \(event_a, event_b\)/);
  assert.match(eventDelete, /provider_metadata->>'synthetic_uat_marker' = auth_marker/);
  assert.match(tmpDelete, /WHERE id = auth_tmp/);
  assert.match(tmpDelete, /amount_cents = 1/);
});

test('SQL 40 fail-closed names cover every required invariant', () => {
  for (const name of sql40FailClosedNames()) {
    assert.match(APPLY, new RegExp(name));
  }
  assert.equal(EXPECTED_DELETE_COUNTS.payment_event_log, 2);
  assert.equal(EXPECTED_DELETE_COUNTS.tenant_maintenance_payments, 1);
  assert.equal(EXPECTED_DELETE_COUNTS.payment_transfers, 0);
});

test('canonical fixture hashes distinguish present vs empty and refuse Freedom', () => {
  assert.equal(hashFixtureSnapshot(authorizedPresentSnapshot()), AUTHORIZED_PRESENT_FIXTURE_SHA256);
  assert.equal(hashFixtureSnapshot(EMPTY_FIXTURE_SNAPSHOT), EMPTY_FIXTURE_SHA256);
  assert.notEqual(AUTHORIZED_PRESENT_FIXTURE_SHA256, EMPTY_FIXTURE_SHA256);
  assert.equal(evaluateFixtureGuards(authorizedPresentSnapshot()).ok, true);
  assert.equal(evaluateFixtureGuards(EMPTY_FIXTURE_SNAPSHOT).ok, false);
  const forbidden = authorizedPresentSnapshot();
  forbidden.tmp.tenant_id = FORBIDDEN_FREEDOM.tenant_id;
  const result = evaluateFixtureGuards(forbidden);
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('SQL40_FORBIDDEN_TMP_REFERENCE'));
});
