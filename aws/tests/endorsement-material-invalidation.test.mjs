import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  invalidateEndorsementsForMaterialPayeeChange,
  isMaterialPayeeChange,
  materialPayeeFieldsChanged,
  INVALIDATION_EVENT,
  INVALIDATION_REASON,
  MATERIAL_CHANGE_CATEGORY,
} from '../functions/api/endorsement-material-invalidation.mjs';

test('payee name and type are material; contact fields are not', () => {
  assert.equal(isMaterialPayeeChange({ payee_name: 'Jane' }, { payee_name: 'Jane LLC' }), true);
  assert.equal(isMaterialPayeeChange({ payee_type: 'insured' }, { payee_type: 'mortgage_company' }), true);
  assert.equal(isMaterialPayeeChange({ payee_name: 'Jane' }, { payee_name: 'jane' }), false);
  assert.equal(isMaterialPayeeChange({ payee_name: 'Jane' }, { contact_email: 'x@example.com' }), false);
  assert.deepEqual(
    materialPayeeFieldsChanged({ payee_name: 'Jane', payee_type: 'insured' }, { payee_name: 'Jane LLC' }),
    ['payee_name'],
  );
});

test('material payee change snapshots prior signed state, collapses duplicates, and clears official rear fingerprint', async () => {
  const queries = [];
  const client = {
    query: async (sql, params) => {
      queries.push({ sql, params });
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
      return { rowCount: 1, rows: [] };
    },
  };
  const result = await invalidateEndorsementsForMaterialPayeeChange(client, {
    checkId: '11111111-1111-4111-8111-111111111111',
    payeeId: '22222222-2222-4222-8222-222222222222',
    previousName: 'Original Payee',
    newName: 'CHANGED PAYEE LLC',
    previousType: 'insured',
    newType: 'insured',
    materialFields: ['payee_name'],
    actorId: '33333333-3333-4333-8333-333333333333',
  });
  assert.equal(result.ok, true);
  assert.equal(result.resetCount, 2);
  assert.equal(result.currentEndorsementId, 'endo-pending');
  assert.deepEqual(result.priorSignatureState.signed_or_waived_ids, ['endo-signed']);

  const selectIdx = queries.findIndex((row) => /SELECT id, payee_id, payee_name/.test(row.sql));
  const auditIdx = queries.findIndex((row) => new RegExp(INVALIDATION_EVENT).test(row.sql) && /check_audit_log/.test(row.sql));
  const deleteIdx = queries.findIndex((row) => /DELETE FROM public.check_endorsements/.test(row.sql));
  const resetIdx = queries.findIndex((row) => /UPDATE public.check_endorsements/.test(row.sql) && /status = 'pending'/.test(row.sql));
  assert.ok(selectIdx >= 0 && selectIdx < auditIdx);
  assert.ok(auditIdx >= 0 && auditIdx < deleteIdx);
  assert.ok(deleteIdx >= 0 && deleteIdx < resetIdx);

  const audit = queries[auditIdx];
  const payload = JSON.parse(audit.params[2]);
  assert.equal(payload.reason, INVALIDATION_REASON);
  assert.equal(payload.material_change_category, MATERIAL_CHANGE_CATEGORY);
  assert.deepEqual(payload.material_fields, ['payee_name']);
  assert.equal(payload.payee_id, '22222222-2222-4222-8222-222222222222');
  assert.equal(payload.previous_payee_name, 'Original Payee');
  assert.equal(payload.new_payee_name, 'CHANGED PAYEE LLC');
  assert.equal(payload.current_endorsement_status, 'pending');
  assert.equal(payload.prior_endorsement_state[0].status, 'signed');
  assert.equal(payload.prior_endorsement_state[0].signature_image_url, 'checks/111/old-sign.png');
  assert.equal(payload.prior_signature_state.signed_or_waived_ids[0], 'endo-signed');
  assert.equal(audit.params[1], '33333333-3333-4333-8333-333333333333');

  assert.ok(queries.some((row) => /endorsement_audit_log/.test(row.sql)));
  assert.ok(queries.some((row) => /check_endorsement_events/.test(row.sql)));
  assert.ok(queries.some((row) => /endorsement_status = 'pending'/.test(row.sql)));
  assert.ok(queries.some((row) => /checkalt_rear_fingerprint/.test(row.sql) && /material_payee_change/.test(row.sql)));
  assert.ok(queries[resetIdx].sql.includes('signed_at = NULL'));
  assert.equal(queries[deleteIdx].params[1], 'endo-pending');
});
