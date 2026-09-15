import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const sql = fs.readFileSync(
  path.join(ROOT, 'write-path/sql/39_endorsement_deposit_write_grants.sql'),
  'utf8',
);

test('endorsement deposit grants are limited to official persist columns', () => {
  const grant = sql.split('GRANT UPDATE')[1] || '';
  assert.match(sql, /GRANT UPDATE \(/);
  assert.match(grant, /back_image_deposit_path/);
  assert.match(grant, /endorsement_render_status/);
  assert.match(grant, /endorsement_render_meta/);
  assert.match(grant, /endorsement_override/);
  assert.match(grant, /TO checksops, authenticated/);
  for (const denied of [
    'amount',
    'check_stage',
    'deposited_at',
    'checkalt_deposits',
    'routing_number',
    'account_number',
  ]) {
    assert.equal(grant.includes(denied), false, `must not grant ${denied}`);
  }
  assert.doesNotMatch(grant, /(?<![a-z_])status(?![a-z_])/);
});
