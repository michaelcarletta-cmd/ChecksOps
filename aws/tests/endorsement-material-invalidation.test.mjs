import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  invalidateEndorsementsForMaterialPayeeChange,
  isMaterialPayeeChange,
} from '../functions/api/endorsement-material-invalidation.mjs';

test('payee name and type are material; contact fields are not', () => {
  assert.equal(isMaterialPayeeChange({ payee_name: 'Jane' }, { payee_name: 'Jane LLC' }), true);
  assert.equal(isMaterialPayeeChange({ payee_type: 'insured' }, { payee_type: 'mortgage_company' }), true);
  assert.equal(isMaterialPayeeChange({ payee_name: 'Jane' }, { payee_name: 'jane' }), false);
  assert.equal(isMaterialPayeeChange({ payee_name: 'Jane' }, { contact_email: 'x@example.com' }), false);
});

test('material payee change resets signed endorsements and official rear fingerprint', async () => {
  const queries = [];
  const client = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/UPDATE public.check_endorsements/.test(sql)) {
        return { rowCount: 2, rows: [{ id: 'endo-1' }, { id: 'endo-2' }] };
      }
      return { rowCount: 1, rows: [] };
    },
  };
  const result = await invalidateEndorsementsForMaterialPayeeChange(client, {
    checkId: '11111111-1111-4111-8111-111111111111',
    payeeId: '22222222-2222-4222-8222-222222222222',
    previousName: 'Original Payee',
    newName: 'CHANGED PAYEE LLC',
    actorId: '33333333-3333-4333-8333-333333333333',
  });
  assert.equal(result.ok, true);
  assert.equal(result.resetCount, 2);
  assert.ok(queries.some((row) => /status = 'pending'/.test(row.sql) && /signed_at = NULL/.test(row.sql)));
  assert.ok(queries.some((row) => /DELETE FROM public.check_endorsements/.test(row.sql)));
  assert.ok(queries.some((row) => /endorsement_status = 'pending'/.test(row.sql)));
  assert.ok(queries.some((row) => /checkalt_rear_fingerprint/.test(row.sql) && /material_payee_change/.test(row.sql)));
  assert.ok(queries.some((row) => /endorsement_invalidated_material_edit/.test(row.sql)));
});
