import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateParitySql } from '../write-path/scripts/validate-parity-schema.mjs';

test('parity SQL ports rename-update trigger and returned_* columns only', () => {
  const result = validateParitySql();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.forbidden, []);
});
