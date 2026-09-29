import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveSignatureRequestIds } from '../functions/api/write-signature.mjs';

const CHECK = '8eb2eb71-42e2-4615-a069-aee1a4a67151';
const CLAIM = 'ea7d428b-1f8f-493c-9a10-fca3e75da40d';
const OTHER_CLAIM = '11111111-1111-4111-8111-111111111111';

const clientWith = (rows) => ({
  query: async () => ({ rows }),
});

test('resolves claim_id from the authorized check without selecting claims', async () => {
  const client = clientWith([{ id: CHECK, claim_id: CLAIM }]);
  const out = await resolveSignatureRequestIds({
    client,
    values: { check_intake_item_id: CHECK },
  });
  assert.equal(out.claimId, CLAIM);
  assert.equal(out.checkId, CHECK);
});

test('accepts a caller claim_id that matches the check', async () => {
  const client = clientWith([{ id: CHECK, claim_id: CLAIM }]);
  const out = await resolveSignatureRequestIds({
    client,
    values: { claim_id: CLAIM, check_intake_item_id: CHECK },
  });
  assert.equal(out.claimId, CLAIM);
  assert.equal(out.checkId, CHECK);
});

test('rejects a caller claim_id that does not belong to the writable check', async () => {
  const client = clientWith([{ id: CHECK, claim_id: CLAIM }]);
  const out = await resolveSignatureRequestIds({
    client,
    values: { claim_id: OTHER_CLAIM, check_intake_item_id: CHECK },
  });
  assert.equal(out.error, 'claim_mismatch');
});

test('does not let a caller attach a foreign claim to a check with no claim_id', async () => {
  const client = clientWith([{ id: CHECK, claim_id: null }]);
  const out = await resolveSignatureRequestIds({
    client,
    values: { claim_id: OTHER_CLAIM, check_intake_item_id: CHECK },
  });
  assert.equal(out.error, 'claim_mismatch');
});
