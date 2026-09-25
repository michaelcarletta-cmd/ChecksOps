/**
 * Durable S2 Material Endorsement Invalidation safeguard.
 * Runs in the existing AWS API regression suite (`npm run test:aws-api`).
 * Failure messages always identify S2 Material Endorsement Invalidation.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { executeCheckWorkflowWrite } from '../functions/api/write-check-workflow.mjs';
import * as helper from '../functions/api/endorsement-material-invalidation.mjs';
import {
  S2_LABEL,
  S2_WRITER,
  assertExecutePayeesCallsHelper,
  assertInvalidationEffects,
  assertMaterialClassifier,
  assertWriterCoupling,
  expectS2Failure,
  importMutatedHelper,
  importMutatedWriter,
  mutateDropAuditEvent,
  mutateDropDuplicateCollapse,
  mutateDropFingerprintClear,
  mutateEverythingMaterial,
  mutateNameNeverMaterial,
  mutateTypeNeverMaterial,
  mutateUnplugExecutePayees,
  readRepo,
} from './lib/s2-material-endorsement-invalidation-safeguard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test(`${S2_LABEL}: executePayees remains coupled to material invalidation`, async () => {
  assertExecutePayeesCallsHelper(readRepo(ROOT, S2_WRITER));
  assertMaterialClassifier(helper);
  await assertWriterCoupling(executeCheckWorkflowWrite);
});

test(`${S2_LABEL}: mutation unplugging executePayees is rejected`, async () => {
  const mutatedSource = mutateUnplugExecutePayees(readRepo(ROOT, S2_WRITER));
  await expectS2Failure('helper call removed from executePayees', () => {
    assertExecutePayeesCallsHelper(mutatedSource);
  });
  const mutated = await importMutatedWriter(ROOT, mutateUnplugExecutePayees);
  await expectS2Failure('unplugged executePayees no longer invalidates', () => (
    assertWriterCoupling(mutated.executeCheckWorkflowWrite)
  ));
});

test(`${S2_LABEL}: mutation stopping payee_name invalidation is rejected`, async () => {
  const mutated = await importMutatedHelper(ROOT, mutateNameNeverMaterial);
  await expectS2Failure('material payee_name change stopped invalidating', () => (
    assertMaterialClassifier(mutated)
  ));
});

test(`${S2_LABEL}: mutation stopping payee_type invalidation is rejected`, async () => {
  const mutated = await importMutatedHelper(ROOT, mutateTypeNeverMaterial);
  await expectS2Failure('material payee_type change stopped invalidating', () => (
    assertMaterialClassifier(mutated)
  ));
});

test(`${S2_LABEL}: mutation invalidating non-material edits is rejected`, async () => {
  const mutated = await importMutatedHelper(ROOT, mutateEverythingMaterial);
  await expectS2Failure('non-material edits begin invalidating', () => (
    assertMaterialClassifier(mutated)
  ));
});

test(`${S2_LABEL}: mutation dropping audit, collapse, or fingerprint is rejected`, async () => {
  const audit = await importMutatedHelper(ROOT, mutateDropAuditEvent);
  const collapse = await importMutatedHelper(ROOT, mutateDropDuplicateCollapse);
  const fingerprint = await importMutatedHelper(ROOT, mutateDropFingerprintClear);
  const { invalidateEndorsementsForMaterialPayeeChange } = helper;
  const run = async (fn) => {
    const queries = [];
    const client = {
      query: async (sql, params = []) => {
        queries.push({ sql: String(sql), params });
        if (/SELECT id, payee_id, payee_name/.test(sql)) {
          return {
            rowCount: 2,
            rows: [
              {
                id: 'endo-signed',
                payee_id: '22222222-2222-4222-8222-222222222222',
                payee_name: 'Original Payee',
                payee_type: 'insured',
                status: 'signed',
                signed_at: '2026-09-25T00:00:00.000Z',
                signature_image_url: 'checks/111/old-sign.png',
                signature_method: 'portal',
                notes: null,
                created_at: '2026-09-25T00:00:00.000Z',
                updated_at: '2026-09-25T00:01:00.000Z',
              },
              {
                id: 'endo-pending',
                payee_id: '22222222-2222-4222-8222-222222222222',
                payee_name: 'CHANGED PAYEE LLC',
                payee_type: 'insured',
                status: 'pending',
                signed_at: null,
                signature_image_url: null,
                signature_method: 'portal',
                notes: null,
                created_at: '2026-09-25T00:02:00.000Z',
                updated_at: '2026-09-25T00:02:00.000Z',
              },
            ],
          };
        }
        return { rows: [], rowCount: 0 };
      },
    };
    await fn(client, {
      checkId: '11111111-1111-4111-8111-111111111111',
      payeeId: '22222222-2222-4222-8222-222222222222',
      previousName: 'Original Payee',
      newName: 'CHANGED PAYEE LLC',
      previousType: 'insured',
      newType: 'insured',
      materialFields: ['payee_name'],
      actorId: '33333333-3333-4333-8333-333333333333',
    });
    return queries;
  };

  const good = await run(invalidateEndorsementsForMaterialPayeeChange);
  assertInvalidationEffects({ queries: good }, { materialField: 'payee_name' });

  await expectS2Failure('audit event endorsement_invalidated_material_edit is lost', async () => {
    const queries = await run(audit.invalidateEndorsementsForMaterialPayeeChange);
    assertInvalidationEffects({ queries }, { materialField: 'payee_name' });
  });
  await expectS2Failure('duplicate-collapse/signature invalidation behavior is lost', async () => {
    const queries = await run(collapse.invalidateEndorsementsForMaterialPayeeChange);
    assertInvalidationEffects({ queries }, { materialField: 'payee_name' });
  });
  await expectS2Failure('official rear fingerprint clearing is lost', async () => {
    const queries = await run(fingerprint.invalidateEndorsementsForMaterialPayeeChange);
    assertInvalidationEffects({ queries }, { materialField: 'payee_name' });
  });
});
