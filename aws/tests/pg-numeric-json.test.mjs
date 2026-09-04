import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { installPgJsonTypeParsers } from '../functions/api/db-health.mjs';

const require = createRequire(path.join(path.dirname(fileURLToPath(import.meta.url)), '../functions/api/package.json'));
const pg = require('pg');

test('numeric OID 1700 parser coerces money strings to Number (no concat)', () => {
  installPgJsonTypeParsers();
  const parse = pg.types.getTypeParser(1700, 'text');
  assert.equal(typeof parse('3802.10'), 'number');
  assert.equal(parse('3802.10'), 3802.1);
  const sum = parse('17357.80') + parse('3802.10');
  assert.ok(Math.abs(sum - 21159.9) < 1e-9);
  // Critical: must NOT string-concatenate
  assert.notEqual(sum, '17357.803802.10');
  assert.equal(typeof sum, 'number');
  assert.equal(parse(null), null);
});

test('installPgJsonTypeParsers is idempotent and exports from db-health', () => {
  assert.equal(typeof installPgJsonTypeParsers, 'function');
  installPgJsonTypeParsers();
  installPgJsonTypeParsers();
  const parse = pg.types.getTypeParser(1700, 'text');
  assert.equal(parse('100.50') + parse('0.50'), 101);
});
