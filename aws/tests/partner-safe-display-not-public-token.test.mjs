import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runPublicEndorsement } from '../functions/api/check-endorsement.mjs';
import { runPublicSignatureSubmit } from '../functions/api/signature-submit.mjs';

const partnerVisible = [
  'e1000000-0000-4000-8000-000000000001',
  'Shared Payee',
  'pending',
  'portal',
  'insured@example.test',
];

const eventOf = (body) => ({
  headers: {},
  body: JSON.stringify(body),
});

const emptyClient = {
  query: async (sql) => {
    if (/BEGIN|SET TRANSACTION|ROLLBACK|COMMIT/.test(sql)) return { rows: [] };
    return { rows: [] };
  },
  end: async () => {},
};

test('partner-safe display fields cannot be submitted to public endorsement or signature endpoints', async () => {
  for (const value of partnerVisible) {
    const endorsement = await runPublicEndorsement(eventOf({
      action: 'get_endorsement_data',
      token: value,
    }), { client: emptyClient });
    assert.equal(endorsement.ok, false);
    assert.equal(endorsement.statusCode, 404);

    const submit = await runPublicEndorsement(eventOf({
      action: 'submit_endorsement',
      token: value,
      eSignConsentAccepted: true,
    }), { client: emptyClient });
    assert.equal(submit.ok, false);
    assert.notEqual(submit.statusCode, 200);

    const sign = await runPublicSignatureSubmit(eventOf({
      token: value,
      eSignConsentAccepted: true,
      fieldValues: {},
    }), { client: emptyClient });
    assert.equal(sign.ok, false);
    assert.notEqual(sign.statusCode, 200);
  }
});
