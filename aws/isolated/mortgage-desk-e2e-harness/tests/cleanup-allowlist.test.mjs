import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cleanupPlan,
  refuseBroadCleanup,
  validateExactIdAllowlist,
} from '../src/cleanup.mjs';

test('exact UUID allowlist is accepted and non-UUIDs are refused', () => {
  const ok = validateExactIdAllowlist({
    claims: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
    check_intake_items: ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
  });
  assert.equal(ok.ok, true);
  const bad = validateExactIdAllowlist({
    claims: ['SYNTHETIC-MDE2E-%'],
  });
  assert.equal(bad.ok, false);
});

test('wildcard, prefix, date-range, and tenant-wide cleanup are refused', () => {
  assert.equal(refuseBroadCleanup({ deleteByPrefix: true }).ok, false);
  assert.equal(refuseBroadCleanup({ dateRange: { since: '2026-09-01' } }).ok, false);
  assert.equal(refuseBroadCleanup({ tenantWide: true }).ok, false);
  assert.equal(refuseBroadCleanup({ like: 'SYNTHETIC-%' }).ok, false);
  assert.equal(refuseBroadCleanup({ allowlist: { claims: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'] } }).ok, true);
});

test('cleanup plan is child-first and exact-id only', () => {
  const plan = cleanupPlan({ claims: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'] });
  assert.equal(plan.order[0], 'check_billing_events');
  assert.equal(plan.order.at(-1), 'claims');
  assert.match(plan.predicate, /id = ANY/);
  assert.ok(plan.forbidden.some((item) => /LIKE/.test(item)));
});
