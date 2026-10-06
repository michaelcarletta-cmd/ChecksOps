/**
 * Surgical removal of temporary Collection V2 UAT + TMP catalog inspector.
 * Candidate is derived from the current live Lambda, not a historical ZIP.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { evaluateLambdaOverlay, evaluateMembership } from '../../scripts/deployment-guard/lib/lambda-overlay.mjs';
import { validateOwnedMemberOps } from '../../scripts/deployment-guard/lib/lambda-owned-members.mjs';

const LIVE = JSON.parse(readFileSync(new URL('../../ops/deployment-guard/collection-v2-uat-infra-cleanup-apply-live.json', import.meta.url), 'utf8'));

const sha256File = (rel) => createHash('sha256')
  .update(readFileSync(new URL(`../${rel}`, import.meta.url)))
  .digest('hex');

const indexSource = () => readFileSync(new URL('../functions/api/index.mjs', import.meta.url), 'utf8');

const FORBIDDEN_INDEX = [
  'tenant-collection-v2-uat',
  'tenant-maintenance-payments-catalog-inspect',
  'handleCollectionV2UatRequest',
  'handleTmpRlsCatalogInspectRequest',
  '/uat/collection-v2',
  '/inspect/tmp-rls-catalog',
  'TEMPORARY staging-only',
];

test('candidate is derived from current live index, not the old GnVu6M3 baseline', () => {
  assert.notEqual(LIVE.code_sha256, 'GnVu6M3syf8AcnQCXpQ8ONBvGH6k5Q07rkd4yVW1i7A=');
  assert.notEqual(LIVE.revision_id, 'c19a91f4-8935-4e51-8b43-a39b321f0ec3');
  assert.equal(LIVE.code_sha256, 'YEYAGPRlupCVeMQZ2hLZ5V2VknnKDo+22g4TaGvWTQI=');
  assert.equal(LIVE.revision_id, 'aadb9f6f-979b-49a6-a6b7-d14c41bdd0c9');
  assert.equal(sha256File('functions/api/index.mjs'), LIVE.candidate_index_sha256);
  const source = indexSource();
  for (const needle of FORBIDDEN_INDEX) {
    assert.equal(source.includes(needle), false, needle);
  }
  assert.equal(existsSync(new URL('../functions/api/tenant-collection-v2-uat.mjs', import.meta.url)), false);
  assert.equal(existsSync(new URL('../functions/api/tenant-maintenance-payments-catalog-inspect.mjs', import.meta.url)), false);
});

test('protected Collection V2 members stay byte-identical to current live', () => {
  const sourceFiles = {
    'tenant-collection-v2-settlement.mjs': 'functions/api/tenant-collection-v2-settlement.mjs',
    'tenant-collection-v2.mjs': 'functions/api/tenant-collection-v2.mjs',
    'tenant-billing-engine.mjs': 'functions/api/tenant-billing-engine.mjs',
  };
  for (const [member, rel] of Object.entries(sourceFiles)) {
    assert.equal(sha256File(rel), LIVE.protected_collection_v2[member], member);
  }
  assert.equal(
    sha256File('tests/fixtures/live-webhook-apply.mjs'),
    LIVE.protected_collection_v2['providers/webhook-apply.mjs'],
  );
});

test('Invoice Recovery live hashes are pinned and not owned by this overlay', () => {
  const owned = [
    'index.mjs',
    'tenant-collection-v2-uat.mjs',
    'tenant-maintenance-payments-catalog-inspect.mjs',
  ];
  for (const member of Object.keys(LIVE.invoice_recovery)) {
    assert.equal(owned.includes(member), false, member);
    assert.match(LIVE.invoice_recovery[member], /^[0-9a-f]{64}$/);
  }
  assert.equal(sha256File('functions/api/invoice-actions.mjs'), LIVE.invoice_recovery['invoice-actions.mjs']);
  assert.equal(sha256File('functions/api/public-invoice.mjs'), LIVE.invoice_recovery['public-invoice.mjs']);
});

test('official overlay membership deletes only the two temporary members', () => {
  const liveMembers = {
    'index.mjs': LIVE.live_index_sha256,
    ...LIVE.live_temporary_members,
    ...LIVE.protected_collection_v2,
    ...LIVE.invoice_recovery,
    'unrelated.mjs': 'aa'.repeat(32),
  };
  const candidateMembers = {
    'index.mjs': LIVE.candidate_index_sha256,
    ...LIVE.protected_collection_v2,
    ...LIVE.invoice_recovery,
    'unrelated.mjs': 'aa'.repeat(32),
  };
  const owned = [
    'index.mjs',
    'tenant-collection-v2-uat.mjs',
    'tenant-maintenance-payments-catalog-inspect.mjs',
  ];
  const membership = evaluateMembership({
    liveMembers,
    candidateMembers,
    ownedMembers: owned,
    addMembers: [],
  });
  assert.equal(membership.ok, true, JSON.stringify(membership, null, 2));
  assert.deepEqual(membership.details.deleted, [
    'tenant-collection-v2-uat.mjs',
    'tenant-maintenance-payments-catalog-inspect.mjs',
  ]);
  assert.deepEqual(membership.details.changed, ['index.mjs']);
  assert.deepEqual(membership.details.added, []);
  const ops = validateOwnedMemberOps({
    replace: ['index.mjs'],
    add: [],
    remove: [
      'tenant-collection-v2-uat.mjs',
      'tenant-maintenance-payments-catalog-inspect.mjs',
    ],
  }, owned);
  assert.equal(ops.ok, true, JSON.stringify(ops, null, 2));
});

test('evaluate-only overlay plan is allowed and apply stays false', () => {
  const fingerprint = {
    codeSha256: LIVE.code_sha256,
    revisionId: LIVE.revision_id,
  };
  const result = evaluateLambdaOverlay({
    workstream_id: 'collection-v2-uat-infra-cleanup-apply-93da',
    branch: 'cursor/collection-v2-uat-infra-cleanup-apply-93da',
    commit: 'cccccccccccccccccccccccccccccccccccccccc',
    operator: 'cursor-cloud-agent',
    target_environment: 'staging',
    deployment_type: 'lambda-overlay',
    owned_members: [
      'index.mjs',
      'tenant-collection-v2-uat.mjs',
      'tenant-maintenance-payments-catalog-inspect.mjs',
    ],
    add_members: [],
    preflight: fingerprint,
    immediately_before: fingerprint,
    live_members: {
      'index.mjs': LIVE.live_index_sha256,
      ...LIVE.live_temporary_members,
      ...LIVE.protected_collection_v2,
      ...LIVE.invoice_recovery,
    },
    candidate_members: {
      'index.mjs': LIVE.candidate_index_sha256,
      ...LIVE.protected_collection_v2,
      ...LIVE.invoice_recovery,
    },
    package: {
      origin: 'fresh-live-download',
      downloaded_at: '2026-10-06T19:03:00.000Z',
      preflight_at: '2026-10-06T19:03:00.000Z',
      now: '2026-10-06T19:03:00.000Z',
    },
    build_timestamp: '2026-10-06T19:03:00.000Z',
  });
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.equal(result.details.overlay_allowed, true);
  assert.match(indexSource(), /handlePublicInvoice/);
});
