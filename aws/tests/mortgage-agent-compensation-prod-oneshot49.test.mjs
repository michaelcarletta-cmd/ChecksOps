import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  FUNCTION_NAME,
  FORBIDDEN_FUNCTIONS,
  PINNED_SQL47_SHA256,
  PINNED_SQL48_SHA256,
  PINNED_SQL49_SHA256,
  EXPECTED_SQL39_HASH,
  EXPECTED_SQL47_CATALOG,
  EXPECTED_SQL48_RETURN_HASH,
} from '../isolated/mortgage-agent-compensation/oneshot49-prod/constants.mjs';
import {
  readEmbeddedSql,
  refuseEvent,
  sha256,
} from '../isolated/mortgage-agent-compensation/oneshot49-prod/index.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SQL47 = path.join(ROOT, 'isolated/mortgage-agent-compensation/sql/47_mortgage_agent_compensation.sql');
const SQL48 = path.join(ROOT, 'isolated/mortgage-agent-compensation/sql/48_return_mortgage_request_to_queue.sql');
const SQL49 = path.join(ROOT, 'isolated/mortgage-agent-compensation/sql/49_adjust_mortgage_agent_compensation.sql');
const PACK = fs.readFileSync(
  path.join(ROOT, 'isolated/mortgage-agent-compensation/oneshot49-prod/pack-and-create.mjs'),
  'utf8',
);
const INDEX = fs.readFileSync(
  path.join(ROOT, 'isolated/mortgage-agent-compensation/oneshot49-prod/index.mjs'),
  'utf8',
);

test('production SQL 49 oneshot is pinned and refuses unrelated targets', () => {
  assert.equal(FUNCTION_NAME, 'checksops-prod-macomp49-oneshot-ad99');
  assert.equal(PINNED_SQL49_SHA256, '3bda6740d08b159ee21e3861443d9b9ae74f2e2efc01ae147467da00bcf3a550');
  assert.equal(PINNED_SQL48_SHA256, 'be6c712587ded69ee209524be08edcdc640a438bd0196d0be978cbe9ae48ef9f');
  assert.equal(PINNED_SQL47_SHA256, 'bdbdccbc44ca70ae86c7212f16fb1a2d2786071b61acb6b62c98e7863b2cc99c');
  assert.equal(EXPECTED_SQL39_HASH, '0d959621d34c99879dc9092cb925bfdb169273a21bea76c6a44242c2d64cd126');
  assert.equal(EXPECTED_SQL47_CATALOG, '3ef6b9b6ff9506e7c33d097cb5e01604cd7454f943114a6d3e85f0f5364ec7c0');
  assert.equal(EXPECTED_SQL48_RETURN_HASH, '4a8edeb99404042b141b06a2566d3f7ccfd3a74a1a423ebfdb4df99a0b87ac76');
  assert.equal(sha256(fs.readFileSync(SQL49, 'utf8')), PINNED_SQL49_SHA256);
  assert.equal(sha256(fs.readFileSync(SQL48, 'utf8')), PINNED_SQL48_SHA256);
  assert.equal(sha256(fs.readFileSync(SQL47, 'utf8')), PINNED_SQL47_SHA256);
  assert.equal(readEmbeddedSql(SQL49).ok, true);
  assert.equal(readEmbeddedSql(SQL48).ok, false);
  assert.equal(readEmbeddedSql(SQL47).ok, false);
  assert.equal(FORBIDDEN_FUNCTIONS.includes('checksops-prod-macomp48-oneshot-ad99'), true);
  assert.equal(FORBIDDEN_FUNCTIONS.includes('checksops-prod-macomp47-oneshot-ad99'), true);
  assert.equal(FORBIDDEN_FUNCTIONS.includes('checksops-staging-guarded-sql-executor'), true);
  assert.equal(FORBIDDEN_FUNCTIONS.includes('checksops-production-prep-api'), true);
  assert.equal(refuseEvent({ sql_text: 'DROP TABLE x' }).ok, false);
  assert.equal(refuseEvent({ action: 'demo' }).ok, false);
  assert.equal(refuseEvent({ action: 'inspect', target_environment: 'staging' }).ok, false);
  assert.equal(refuseEvent({ function_name: 'checksops-prod-macomp48-oneshot-ad99' }).ok, false);
  assert.equal(refuseEvent({ filename: '47_mortgage_agent_compensation.sql' }).ok, false);
  assert.equal(refuseEvent({ filename: '48_return_mortgage_request_to_queue.sql' }).ok, false);
  assert.equal(refuseEvent({ apply_sql48: true }).ok, false);
  assert.equal(refuseEvent({ reapply_sql47: true }).ok, false);
  assert.equal(refuseEvent({ call_adjust: true }).ok, false);
  assert.equal(refuseEvent({ p_parent_entry_id: '00000000-0000-4000-8000-000000000001' }).ok, false);
  assert.equal(refuseEvent({
    action: 'inspect',
    function_name: FUNCTION_NAME,
    target_environment: 'production',
    filename: '49_adjust_mortgage_agent_compensation.sql',
  }, { RDS_HOST: 'checksops-production.cyr0q4kcop3c.us-east-1.rds.amazonaws.com' }), null);
  assert.equal(PACK.includes('update-function-code'), false);
  assert.match(PACK, /refusing to embed/);
  assert.match(PACK, /create-function/);
  assert.match(PACK, /49_adjust_mortgage_agent_compensation\.sql/);
  assert.match(INDEX, /adjust_called: false/);
  assert.equal(INDEX.includes('adjust_mortgage_agent_compensation($'), false);
});
