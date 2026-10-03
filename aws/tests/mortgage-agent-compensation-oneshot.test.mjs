import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  FUNCTION_NAME,
  FORBIDDEN_FUNCTIONS,
  PINNED_SQL47_SHA256,
  readEmbeddedSql,
  refuseEvent,
  sha256,
} from '../isolated/mortgage-agent-compensation/oneshot/index.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SQL47 = path.join(ROOT, 'isolated/mortgage-agent-compensation/sql/47_mortgage_agent_compensation.sql');
const PACK = fs.readFileSync(
  path.join(ROOT, 'isolated/mortgage-agent-compensation/oneshot/pack-and-create.mjs'),
  'utf8',
);

test('dedicated SQL 47 oneshot refuses shared targets and production', () => {
  assert.equal(FUNCTION_NAME, 'checksops-staging-macomp47-oneshot');
  assert.equal(FORBIDDEN_FUNCTIONS.includes('checksops-staging-guarded-sql-executor'), true);
  assert.equal(FORBIDDEN_FUNCTIONS.includes('checksops-prod-sql47-apply-2d41'), true);
  assert.equal(sha256(fs.readFileSync(SQL47, 'utf8')), PINNED_SQL47_SHA256);
  assert.equal(readEmbeddedSql(SQL47).ok, true);
  assert.equal(refuseEvent({ sql_text: 'DROP TABLE x' }).ok, false);
  assert.equal(refuseEvent({ action: 'inspect' }, { RDS_HOST: 'checksops-production.example' }).ok, false);
  assert.equal(refuseEvent({ function_name: 'checksops-staging-guarded-sql-executor' }).ok, false);
  assert.equal(refuseEvent({ action: 'inspect', function_name: FUNCTION_NAME }, { RDS_HOST: 'checksops-staging.cyr0q4kcop3c.us-east-1.rds.amazonaws.com' }), null);
  assert.equal(PACK.includes('update-function-code'), false);
  assert.equal(PACK.includes('checksops-staging-guarded-sql-executor'), true);
  assert.match(PACK, /create-function/);
});
