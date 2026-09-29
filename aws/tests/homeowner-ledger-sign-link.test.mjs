import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { assembleHomeownerLedgerView } from '../functions/api/homeowner.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const sourceOf = (rel) => readFileSync(join(ROOT, rel), 'utf8');

test('Sign Now contract no longer writes updated_at and returns /sign?token=', () => {
  const src = sourceOf('aws/functions/api/homeowner.mjs');
  assert.equal(src.includes('updated_at = now()'), false);
  assert.equal(src.includes('/sign/${raw}'), false);
  assert.match(src, /sign_url: `\$\{origin\}\/sign\?token=\$\{raw\}`/);
  assert.match(src, /aws_public_homeowner_ledger_remint_signer/);
  assert.match(src, /already_signed/);
  assert.match(src, /not_your_signature/);
  assert.match(src, /mismatch/);
});

test('ledger SQL helper returns SPA claim-mode fields without changing public write helpers', () => {
  const sql = sourceOf('aws/workflows/sql/69_homeowner_ledger_pending_and_sign_link.sql');
  assert.match(sql, /pending_signatures/);
  assert.match(sql, /'mode'/);
  assert.match(sql, /'homeowner'/);
  assert.match(sql, /'totals'/);
  assert.match(sql, /aws_public_homeowner_ledger_remint_signer/);
  assert.match(sql, /already_signed/);
  assert.match(sql, /not_your_signature/);
  assert.equal(sql.includes('aws_public_signature_mark_viewed'), false);
  assert.equal(sql.includes('aws_public_signature_submit'), false);
  const writeHelpers = sourceOf('aws/storage/sql/02_public_signature_write_helpers.sql');
  assert.match(writeHelpers, /aws_public_signature_mark_viewed/);
});

test('ledger view maps helper token metadata into SPA mode/homeowner/totals/pending', () => {
  const assembled = assembleHomeownerLedgerView({
    ok: true,
    token: {
      claim_id: 'ea7d428b-1f8f-493c-9a10-fca3e75da40d',
      homeowner_email: 'cursor-delete-check-test@freedomadj.com',
      homeowner_name: 'Synthetic',
    },
    claim: { id: 'ea7d428b-1f8f-493c-9a10-fca3e75da40d' },
    events: [],
  }, { ignored: true });
  assert.equal(assembled.mode, 'claim');
  assert.equal(assembled.homeowner.email, 'cursor-delete-check-test@freedomadj.com');
  assert.deepEqual(assembled.totals, { received: 0, deposited: 0, released: 0, remaining: 0 });
  assert.deepEqual(assembled.pending_signatures, []);
  assert.equal(assembled.allow_deductible_payment, false);
});
