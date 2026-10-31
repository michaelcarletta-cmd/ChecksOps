/**
 * Production Settlement Sync composition contracts.
 * No AWS writes, no payments, no $139 reconciliation.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { evaluateMembership } from '../../scripts/deployment-guard/lib/lambda-overlay.mjs';

const ACCEPTED_SETTLEMENT_SHA = '075d96d0826beb55a36261a799b80aa4898486b6322949b705017769151d7b40';
const PROD_WEBHOOKS_BEFORE = 'dfeb5e49dd6e2f6cd6372e3179fe4e5b189cd37de3ae01f4280b2ca9ae27b9a6';
const FORBIDDEN_MEMBERS = [
  'tenant-collection-v2-uat.mjs',
  'tenant-maintenance-payments-catalog-inspect.mjs',
];

const sha256 = (rel) => createHash('sha256').update(readFileSync(new URL(rel, import.meta.url))).digest('hex');

test('accepted settlement module is the production add member', () => {
  // The add put these bytes live (production rebuilds since keep them). Main then moved on to the
  // exact notes-token match (Moov webhook body confirmation, 2026-10-31), REPLACEd in production
  // (run 41223513762) and recorded in the applied manifest. Main has since moved on again: the
  // money-write flag (finding 14 step 1, 2026-10-31) sets request.money_write before each
  // settlement write. The row now accepts main's bytes, still expects the applied bytes live and
  // names the money-write planning manifest, which chains back to the applied record and from there
  // to the planning manifest that records these bytes as the pre-apply live state.
  const plan = JSON.parse(readFileSync(new URL('../../ops/deployment-guard/production-api-overlay-plan.json', import.meta.url), 'utf8'));
  const row = plan.members['tenant-collection-v2-settlement.mjs'];
  assert.equal(row.operation, 'replace');
  assert.equal(row.accepted_sha256, sha256('../functions/api/tenant-collection-v2-settlement.mjs'));
  assert.notEqual(row.accepted_sha256, ACCEPTED_SETTLEMENT_SHA);
  assert.equal(row.manifest, 'aws/tests/fixtures/production-money-write-flag-manifest-2026-10-31.json');
  const pending = JSON.parse(readFileSync(new URL(`../../${row.manifest}`, import.meta.url), 'utf8')).members['tenant-collection-v2-settlement.mjs'];
  assert.equal(pending.accepted_sha256, row.accepted_sha256);
  assert.equal(pending.live_sha256, row.expected_live_sha256);
  assert.equal(pending.previous_manifest, 'aws/tests/fixtures/production-moov-webhook-body-auth-applied-manifest-2026-10-31.json');
  const applied = JSON.parse(readFileSync(new URL(`../../${pending.previous_manifest}`, import.meta.url), 'utf8')).members['tenant-collection-v2-settlement.mjs'];
  const planned = JSON.parse(readFileSync(new URL(`../../${applied.previous_manifest}`, import.meta.url), 'utf8')).members['tenant-collection-v2-settlement.mjs'];
  assert.equal(applied.live_sha256, row.expected_live_sha256);
  assert.equal(planned.live_sha256, ACCEPTED_SETTLEMENT_SHA);
});

test('production webhook dispatcher activates settlement with dry-run skip', () => {
  const webhooks = readFileSync(new URL('../functions/api/providers/webhooks.mjs', import.meta.url), 'utf8');
  assert.match(webhooks, /applyCollectionV2ProviderCompletion/);
  assert.match(webhooks, /!dryRun/);
  assert.match(webhooks, /skipped: 'dry_run'/);
  assert.equal(webhooks.includes('tenant-collection-v2-uat'), false);
  assert.equal(webhooks.includes('catalog-inspect'), false);
  assert.equal(webhooks.includes('/uat/collection-v2'), false);
  assert.equal(webhooks.includes('/inspect/tmp-rls-catalog'), false);
  const candidateHash = createHash('sha256').update(webhooks).digest('hex');
  assert.notEqual(candidateHash, PROD_WEBHOOKS_BEFORE);
});

test('surgical overlay changes only settlement add + webhook replace', () => {
  const liveMembers = {
    'providers/webhooks.mjs': PROD_WEBHOOKS_BEFORE,
    'index.mjs': '24f13aa5ff4f3d72e7f5ff4dc45dd194796aa4e75958de5bc39c8c1dce3eb4da',
    'tenant-collection-v2.mjs': '8a66f54d3c2785162a1643218e18b4d3c251230cf2a7f98a1ecb4ede8939fb66',
    'tenant-billing-engine.mjs': '65b75735825f9a06955d5daba603f74835d106cabf52eb449153c856a59dae2f',
    'providers/webhook-apply.mjs': 'e26a617a576aea568ffd9d112a58fff3efc516ab54e9e2eabc1f22d0b8fc52bf',
  };
  const candidateMembers = {
    ...liveMembers,
    'providers/webhooks.mjs': sha256('../functions/api/providers/webhooks.mjs'),
    'tenant-collection-v2-settlement.mjs': ACCEPTED_SETTLEMENT_SHA,
  };
  const membership = evaluateMembership({
    liveMembers,
    candidateMembers,
    ownedMembers: ['providers/webhooks.mjs', 'tenant-collection-v2-settlement.mjs'],
    addMembers: ['tenant-collection-v2-settlement.mjs'],
  });
  assert.equal(membership.ok, true);
  assert.deepEqual(membership.details.added, ['tenant-collection-v2-settlement.mjs']);
  assert.deepEqual(membership.details.changed, ['providers/webhooks.mjs']);
  assert.deepEqual(membership.details.deleted, []);
  assert.deepEqual(membership.details.unexpected_added, []);
  assert.deepEqual(membership.details.unexpected_changed, []);
  for (const forbidden of FORBIDDEN_MEMBERS) {
    assert.equal(Object.hasOwn(candidateMembers, forbidden), false);
  }
});
