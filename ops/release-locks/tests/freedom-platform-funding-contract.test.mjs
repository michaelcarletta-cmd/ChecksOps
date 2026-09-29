/**
 * Adversarial regression tests for the Freedom → ChecksOps funding contract.
 * Fixtures only. Does not create a live transfer.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  computeOwnershipHashes,
  loadJson,
  matchProtectedPath,
} from '../../../scripts/lib/release-locks.mjs';
import {
  candidateTouchesFundingPath,
  evaluateFundingOperation,
  fundingDeployGuardErrors,
  knownGoodFundingOperation,
  loadFundingContract,
} from '../../../scripts/lib/freedom-platform-funding-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function contract() {
  return loadFundingContract(ROOT);
}

function good() {
  return knownGoodFundingOperation(contract());
}

test('known-good Freedom → ChecksOps operation satisfies the contract', () => {
  const evaluated = evaluateFundingOperation(good(), contract());
  assert.deepEqual(evaluated.errors, []);
  assert.equal(evaluated.ok, true);
});

test('swapping source and destination fails closed', () => {
  const op = good();
  const source = op.source;
  op.source = op.destination;
  op.destination = source;
  op.direction = 'checksops_to_freedom';
  const evaluated = evaluateFundingOperation(op, contract());
  assert.equal(evaluated.ok, false);
  assert.ok(evaluated.errors.some((row) => /ChecksOps platform account used as source|direction/.test(row)));
});

test('using ChecksOps as source fails closed', () => {
  const op = good();
  op.source.accountId = contract().identities.checksops_platform_account_id;
  const evaluated = evaluateFundingOperation(op, contract());
  assert.equal(evaluated.ok, false);
  assert.ok(evaluated.errors.some((row) => /ChecksOps platform account used as source/.test(row)));
});

test('using Freedom as destination fails closed', () => {
  const op = good();
  op.destination.accountId = contract().identities.freedom_moov_account_id;
  const evaluated = evaluateFundingOperation(op, contract());
  assert.equal(evaluated.ok, false);
  assert.ok(evaluated.errors.some((row) => /Freedom account used as destination/.test(row)));
});

test('first-wallet destination fallback fails closed', () => {
  const op = good();
  op.destination.selection = 'first_wallet';
  const evaluated = evaluateFundingOperation(op, contract());
  assert.equal(evaluated.ok, false);
  assert.ok(evaluated.errors.some((row) => /first_wallet/.test(row)));
});

test('first-bank source fallback fails closed', () => {
  const op = good();
  op.source.selection = 'first_bank';
  const evaluated = evaluateFundingOperation(op, contract());
  assert.equal(evaluated.ok, false);
  assert.ok(evaluated.errors.some((row) => /first_bank/.test(row)));
});

test('sandbox resources in production fail closed', () => {
  const op = good();
  op.moovEnvironment = 'sandbox';
  const evaluated = evaluateFundingOperation(op, contract());
  assert.equal(evaluated.ok, false);
  assert.ok(evaluated.errors.some((row) => /sandbox/.test(row)));
});

test('cross-tenant use of Freedom bank fails closed', () => {
  const op = good();
  op.tenantId = '4f172140-f57a-4744-8050-95f4f07b13b4';
  const evaluated = evaluateFundingOperation(op, contract());
  assert.equal(evaluated.ok, false);
  assert.ok(evaluated.errors.some((row) => /another tenant/.test(row)));
});

test('missing idempotency key fails closed', () => {
  const op = good();
  delete op.idempotencyKey;
  const evaluated = evaluateFundingOperation(op, contract());
  assert.equal(evaluated.ok, false);
  assert.ok(evaluated.errors.some((row) => /idempotency key is missing/.test(row)));
});

test('retry of an already-created operation fails closed', () => {
  const op = good();
  op.retry = true;
  op.existingProviderTransferId = contract().known_good_transfer.provider_transfer_id;
  const evaluated = evaluateFundingOperation(op, contract());
  assert.equal(evaluated.ok, false);
  assert.ok(evaluated.errors.some((row) => /already-created/.test(row)));
});

test('changing the destination platform account fails closed', () => {
  const op = good();
  op.destination.accountId = '00000000-0000-0000-0000-000000000001';
  const evaluated = evaluateFundingOperation(op, contract());
  assert.equal(evaluated.ok, false);
  assert.ok(evaluated.errors.some((row) => /destination account/.test(row)));
});

test('changing the destination platform wallet fails closed', () => {
  const op = good();
  op.destination.walletId = '00000000-0000-0000-0000-000000000002';
  const evaluated = evaluateFundingOperation(op, contract());
  assert.equal(evaluated.ok, false);
  assert.ok(evaluated.errors.some((row) => /destination wallet/.test(row)));
});

test('POST while required financial gates are disabled fails closed', () => {
  const op = good();
  op.post = true;
  op.kind = 'billing_verification';
  op.gates.AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED = 'false';
  const evaluated = evaluateFundingOperation(op, contract());
  assert.equal(evaluated.ok, false);
  assert.ok(evaluated.errors.some((row) => /VERIFICATION_POST_ENABLED/.test(row)));
});

test('silent fallback after account lookup failure fails closed', () => {
  const op = good();
  op.lookup.account = 'missing';
  op.lookup.fallbackAfterFailure = true;
  const evaluated = evaluateFundingOperation(op, contract());
  assert.equal(evaluated.ok, false);
  assert.ok(evaluated.errors.some((row) => /account lookup is missing/.test(row)));
  assert.ok(evaluated.errors.some((row) => /silent fallback/.test(row)));
});

test('mismatched provider and local amounts fail closed', () => {
  const op = good();
  op.provider.amountCents = 100;
  op.local.amountCents = 200;
  const evaluated = evaluateFundingOperation(op, contract());
  assert.equal(evaluated.ok, false);
  assert.ok(evaluated.errors.some((row) => /amounts disagree/.test(row)));
});

test('ownership group covers contract, helper, tests, and proof only', () => {
  const protectedPaths = loadJson(path.join(ROOT, 'ops/release-locks/protected-paths.json'));
  const group = protectedPaths.ownership_groups['freedom-platform-funding'];
  assert.ok(group, 'freedom-platform-funding ownership group is required');
  const expected = [
    'ops/release-locks/contracts/freedom-platform-funding-contract.json',
    'ops/release-locks/tests/freedom-platform-funding-contract.test.mjs',
    'ops/release-locks/proof/freedom-platform-funding-freeze.md',
    'scripts/lib/freedom-platform-funding-contract.mjs',
  ].sort();
  assert.deepEqual([...group.paths].sort(), expected);
  const hashes = computeOwnershipHashes(ROOT, protectedPaths);
  assert.equal(hashes.groups['freedom-platform-funding'].missing.length, 0);
  for (const rel of expected) {
    const matches = matchProtectedPath(rel, protectedPaths);
    assert.ok(matches.some((row) => row.groupId === 'freedom-platform-funding'), `${rel} must belong to freedom-platform-funding`);
  }
  const sharedMoney = matchProtectedPath('aws/functions/api/providers/parity/moov-money.mjs', protectedPaths);
  assert.ok(
    !sharedMoney.some((row) => row.groupId === 'freedom-platform-funding'),
    'must not lock whole shared moov-money.mjs',
  );
});

test('manifest component is source-locked and not production-active', () => {
  const manifest = loadJson(path.join(ROOT, 'ops/release-locks/locked-components.json'));
  const component = manifest.components['freedom-platform-funding'];
  assert.ok(component);
  assert.equal(component.classification, 'SOURCE_LOCKED_NOT_ACTIVE');
  assert.equal(component.production_active, false);
  assert.ok(String(component.notes || '').includes('does not pin'));
});

test('deploy guard fails closed when funding paths change without revalidation', () => {
  const errors = fundingDeployGuardErrors({
    changed_paths: ['aws/functions/api/tenant-billing-destination.mjs'],
  }, ROOT);
  assert.ok(errors.some((row) => /explicitly revalidated/.test(row)));
});

test('deploy guard fails closed on reversed funding operation in a candidate', () => {
  const op = good();
  op.direction = 'checksops_to_freedom';
  const errors = fundingDeployGuardErrors({
    changed_paths: ['aws/functions/api/tenant-billing-engine.mjs'],
    funding_contract: {
      validated: true,
      tests_passed: true,
      contract_id: 'freedom-platform-funding',
    },
    funding_operation: op,
  }, ROOT);
  assert.ok(errors.some((row) => /direction/.test(row)));
});

test('old Lambda restore over live production fails closed', () => {
  const errors = fundingDeployGuardErrors({
    funding_paths_changed: true,
    restore_from_older_artifact: true,
    deploy_lambda_code_sha: 'aU5OCyV4qm6057bFWDF2T9KEkZPVvmav4qoiFczpaCM=',
    live_lambda_code_sha: 'nJup1+WVcsX99QzhmLvEpG+CRurINFAXLn+3osQBeQc=',
    funding_contract: { validated: true, tests_passed: true, contract_id: 'freedom-platform-funding' },
  }, ROOT);
  assert.ok(errors.some((row) => /old repository ZIP|restore/.test(row)));
});

test('unrelated candidate paths do not require funding revalidation', () => {
  const errors = fundingDeployGuardErrors({
    changed_paths: ['src/pages/PublicInvoicePage.tsx'],
  }, ROOT);
  assert.deepEqual(errors, []);
  assert.equal(candidateTouchesFundingPath({ changed_paths: ['src/pages/PublicInvoicePage.tsx'] }, [], contract()), false);
});

test('monthly billing POST cannot activate from a funding-path candidate', () => {
  const errors = fundingDeployGuardErrors({
    flags: { AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST: 'true' },
    changed_paths: ['aws/functions/api/financial-flags.mjs'],
  }, ROOT);
  assert.ok(errors.some((row) => /PRODUCTION_POST cannot flip true/.test(row)));
});

test('known-good clone remains isolated from adversarial mutations', () => {
  const a = good();
  const b = clone(a);
  b.source.selection = 'first_bank';
  assert.equal(evaluateFundingOperation(a, contract()).ok, true);
  assert.equal(evaluateFundingOperation(b, contract()).ok, false);
});
