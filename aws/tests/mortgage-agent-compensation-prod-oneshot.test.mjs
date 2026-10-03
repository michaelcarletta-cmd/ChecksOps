import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  FUNCTION_NAME,
  FORBIDDEN_FUNCTIONS,
  PINNED_SQL47_SHA256,
  EXPECTED_SQL39_HASH,
  readEmbeddedSql,
  refuseEvent,
  sha256,
} from '../isolated/mortgage-agent-compensation/oneshot-prod/index.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SQL47 = path.join(ROOT, 'isolated/mortgage-agent-compensation/sql/47_mortgage_agent_compensation.sql');
const PACK = fs.readFileSync(
  path.join(ROOT, 'isolated/mortgage-agent-compensation/oneshot-prod/pack-and-create.mjs'),
  'utf8',
);

test('production SQL 47 oneshot is pinned and refuses unrelated targets', () => {
  assert.equal(FUNCTION_NAME, 'checksops-prod-macomp47-oneshot-ad99');
  assert.equal(PINNED_SQL47_SHA256, 'bdbdccbc44ca70ae86c7212f16fb1a2d2786071b61acb6b62c98e7863b2cc99c');
  assert.equal(EXPECTED_SQL39_HASH, '0d959621d34c99879dc9092cb925bfdb169273a21bea76c6a44242c2d64cd126');
  assert.equal(sha256(fs.readFileSync(SQL47, 'utf8')), PINNED_SQL47_SHA256);
  assert.equal(readEmbeddedSql(SQL47).ok, true);
  assert.equal(FORBIDDEN_FUNCTIONS.includes('checksops-staging-guarded-sql-executor'), true);
  assert.equal(FORBIDDEN_FUNCTIONS.includes('checksops-prod-sql47-apply-2d41'), true);
  assert.equal(FORBIDDEN_FUNCTIONS.includes('checksops-production-prep-api'), true);
  assert.equal(refuseEvent({ sql_text: 'DROP TABLE x' }).ok, false);
  assert.equal(refuseEvent({ action: 'demo' }).ok, false);
  assert.equal(refuseEvent({ action: 'inspect', target_environment: 'staging' }).ok, false);
  assert.equal(refuseEvent({ action: 'inspect' }, { RDS_HOST: 'checksops-staging.cyr0q4kcop3c.us-east-1.rds.amazonaws.com' }).ok, false);
  assert.equal(refuseEvent({ function_name: 'checksops-staging-guarded-sql-executor' }).ok, false);
  assert.equal(refuseEvent({
    action: 'inspect',
    function_name: FUNCTION_NAME,
    target_environment: 'production',
  }, { RDS_HOST: 'checksops-production.cyr0q4kcop3c.us-east-1.rds.amazonaws.com' }), null);
  assert.equal(PACK.includes('update-function-code'), false);
  assert.match(PACK, /create-function/);
  assert.match(PACK, /checksops-production/);
});
