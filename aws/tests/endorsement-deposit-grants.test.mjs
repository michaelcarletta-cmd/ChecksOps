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
  assert.match(sql, /GRANT UPDATE \(/);
  assert.match(sql, /back_image_deposit_path/);
  assert.match(sql, /endorsement_render_status/);
  assert.match(sql, /endorsement_render_meta/);
  assert.match(sql, /endorsement_override/);
  assert.match(sql, /TO checksops, authenticated/);
  for (const denied of [
    'amount',
    'status',
    'check_stage',
    'deposited_at',
    'checkalt_deposits',
    'routing_number',
    'account_number',
  ]) {
    assert.equal(sql.includes(denied), false, `must not grant ${denied}`);
  }
});
