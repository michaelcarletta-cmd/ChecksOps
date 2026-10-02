/**
 * Permanent Claim Ledger production-restore contract.
 *
 * Linked claim-number Save stays an in-place UPDATE of the existing claim UUID.
 * claims remains update-only for claim_number. Review peel and
 * claim_ledger_link_or_create stay available. When the composition already
 * contains the settlement writer, save_claim_settlement_breakdown stays available.
 *
 * Set CLAIM_LEDGER_CANDIDATE_DIR to test a local overlay unpack instead of
 * workspace source. This file never deploys.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_API = path.join(HERE, '../functions/api');
const ROOT = process.env.CLAIM_LEDGER_CANDIDATE_DIR
  ? path.resolve(process.env.CLAIM_LEDGER_CANDIDATE_DIR)
  : WORKSPACE_API;

const CLAIM_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const APP_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';

const load = async (name) => import(pathToFileURL(path.join(ROOT, name)).href);

const settlementPresent = existsSync(path.join(ROOT, 'write-claim-settlement.mjs'));
const CONTRACT_PIN = path.join(HERE, '../../ops/deployment-guard/claim-ledger-production-restore-contract.json');

test('permanent Claim Ledger production-restore contract pin remains registered', () => {
  const pin = JSON.parse(readFileSync(CONTRACT_PIN, 'utf8'));
  assert.equal(pin.id, 'claim-ledger-production-restore');
  assert.equal(pin.accepted, true);
  assert.equal(pin.enabled, true);
  assert.equal(pin.test, 'aws/tests/claim-ledger-production-restore-contract.test.mjs');
  for (const invariant of [
    'linked claim-number save uses UPDATE on the existing claim UUID',
    'claims remains update-only for claim_number',
    'no claim INSERT occurs from claim-number editing',
    'claim_ledger_link_or_create remains available',
    'Review claim-number peel remains available',
    'existing settlement RPC remains available when the settlement writer is already present',
  ]) {
    assert.ok(pin.invariants.includes(invariant), invariant);
  }
});

test('claims remains update-only for claim_number and never allowlists insert', async () => {
  const { WRITE_ALLOWLIST, INTAKE_PROHIBITED_COLUMNS, pickAllowlistedValues } = await load('write-allowlist.mjs');
  assert.equal(WRITE_ALLOWLIST.claims.ops.has('update'), true);
  assert.equal(WRITE_ALLOWLIST.claims.ops.has('insert'), false);
  assert.equal(WRITE_ALLOWLIST.claims.ops.has('delete'), false);
  assert.deepEqual([...WRITE_ALLOWLIST.claims.columns], ['claim_number']);
  assert.equal(WRITE_ALLOWLIST.claims.filterColumns.has('id'), true);
  assert.equal(INTAKE_PROHIBITED_COLUMNS.has('detected_claim_number'), true);
  assert.equal(INTAKE_PROHIBITED_COLUMNS.has('claim_id'), true);
  const insertDenied = WRITE_ALLOWLIST.claims.ops.has('insert');
  assert.equal(insertDenied, false);
  const genericClaimId = pickAllowlistedValues('check_intake_items', { claim_id: CLAIM_ID });
  assert.equal(genericClaimId.error, 'column_not_allowlisted');
});

test('linked claim-number save updates the existing claim UUID and never inserts', async () => {
  const { executeAppMetadataWrite } = await load('write-app-metadata.mjs');
  const queries = [];
  const client = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/FROM public.claims WHERE id/.test(sql)) {
        return {
          rows: [{
            id: CLAIM_ID,
            org_id: TENANT,
            claim_number: 'CLM-OLD',
            status: 'tracking',
            policyholder_name: 'Jane Doe',
          }],
        };
      }
      if (/FROM public.tenant_users/.test(sql)) return { rows: [{ ok: 1 }] };
      if (/UPDATE public.claims/.test(sql)) {
        assert.match(sql, /SET claim_number = \$2::text/);
        assert.match(sql, /WHERE id = \$1::uuid AND org_id = \$3::uuid/);
        assert.equal(params[0], CLAIM_ID);
        assert.equal(params[2], TENANT);
        assert.equal(/INSERT INTO public\.claims/.test(sql), false);
        return { rows: [{ id: CLAIM_ID, org_id: TENANT, claim_number: params[1] }] };
      }
      return { rows: [] };
    },
  };
  const updated = await executeAppMetadataWrite({
    client,
    mapping: { application_user_id: APP_ID },
    table: 'claims',
    op: 'update',
    values: { claim_number: 'CLM-NEW' },
    filters: [{ column: 'id', op: 'eq', value: CLAIM_ID }],
  });
  assert.equal(updated.rows[0].id, CLAIM_ID);
  assert.equal(updated.rows[0].claim_number, 'CLM-NEW');
  assert.equal(queries.some((row) => /INSERT INTO public\.claims/.test(row.sql)), false);
  assert.equal(queries.filter((row) => /UPDATE public\.claims/.test(row.sql)).length, 1);

  const insert = await executeAppMetadataWrite({
    client: { query: async () => ({ rows: [] }) },
    mapping: { application_user_id: APP_ID },
    table: 'claims',
    op: 'insert',
    values: { claim_number: 'CLM-NEW' },
    filters: [],
  });
  assert.equal(insert.error, 'operation_not_allowlisted');
});

test('Review claim-number peel remains available', async () => {
  const writeSrc = await (await import('node:fs/promises')).readFile(path.join(ROOT, 'write.mjs'), 'utf8');
  assert.match(writeSrc, /const peelReviewClaimNumber/);
  assert.match(writeSrc, /const executeReviewClaimSave/);
  assert.match(writeSrc, /review_save_detected_claim_number/);
  assert.match(writeSrc, /const peeled = peelReviewClaimNumber\(table, op, raw\.row\)/);
});

test('claim_ledger_link_or_create remains available', async () => {
  const { SAFE_WRITE_RPCS, CLAIM_LEDGER_LINK_OR_CREATE_SQL } = await load('workflow-rpc.mjs');
  assert.equal(SAFE_WRITE_RPCS.has('claim_ledger_link_or_create'), true);
  assert.match(CLAIM_LEDGER_LINK_OR_CREATE_SQL, /public\.claim_ledger_link_or_create/);
  const src = await (await import('node:fs/promises')).readFile(path.join(ROOT, 'workflow-rpc.mjs'), 'utf8');
  assert.match(src, /executeClaimLedgerLinkOrCreate/);
  assert.match(src, /case 'claim_ledger_link_or_create'/);
});

test('existing settlement RPC remains available when the writer is in the composition', async () => {
  if (!settlementPresent) {
    assert.equal(existsSync(path.join(WORKSPACE_API, 'write-claim-settlement.mjs')), false);
    return;
  }
  const { SAFE_WRITE_RPCS } = await load('workflow-rpc.mjs');
  const { SAVE_CLAIM_SETTLEMENT_BREAKDOWN } = await load('write-claim-settlement.mjs');
  assert.equal(SAVE_CLAIM_SETTLEMENT_BREAKDOWN, 'save_claim_settlement_breakdown');
  assert.equal(SAFE_WRITE_RPCS.has('save_claim_settlement_breakdown'), true);
  const src = await (await import('node:fs/promises')).readFile(path.join(ROOT, 'workflow-rpc.mjs'), 'utf8');
  assert.match(src, /executeClaimSettlementBreakdownWrite/);
});

test('production-only signatures and tenant-create stay present when already in the composition', async () => {
  const srcAllow = await (await import('node:fs/promises')).readFile(path.join(ROOT, 'write-allowlist.mjs'), 'utf8');
  const srcMeta = await (await import('node:fs/promises')).readFile(path.join(ROOT, 'write-app-metadata.mjs'), 'utf8');
  if (srcAllow.includes('signature_requests:')) {
    assert.match(srcAllow, /signature_requests:/);
    assert.match(srcAllow, /signature_signers:/);
  }
  if (srcMeta.includes('executeTenantsCreate')) {
    assert.match(srcMeta, /export const executeTenantsCreate/);
  }
});
