import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const doc = fs.readFileSync(
  path.join(ROOT, 'aws/cutover/MONEY_MOVEMENT_PHASE25_PR175_REVIEW.md'),
  'utf8',
);
const sql65 = fs.existsSync(path.join(ROOT, 'aws/financial/sql/65_checkalt_production_writer.sql'))
  ? fs.readFileSync(path.join(ROOT, 'aws/financial/sql/65_checkalt_production_writer.sql'), 'utf8')
  : '';

test('phase 2.5 review is hold-safe, sanitized, and does not authorize merge', () => {
  assert.match(doc, /STOP/);
  assert.match(doc, /NOT SAFE TO MERGE #175 YET/);
  assert.match(doc, /SQL 64.*NOT_APPLIED/s);
  assert.match(doc, /SQL 65.*NOT_APPLIED/s);
  assert.match(doc, /PROVIDER_SECRETS_ARN.*unset/s);
  assert.match(doc, /AWS_CHECKALT_ENABLED.*\*\*false\*\*/);
  assert.match(doc, /AWS_MOOV_ENABLED.*\*\*false\*\*/);
  assert.match(doc, /AWS_PROVIDER_EXECUTION_ENABLED.*\*\*false\*\*/);
  assert.match(doc, /AWS_FINANCIAL_PERMISSIONS_ACTIVATED.*\*\*false\*\*/);
  assert.match(doc, /COALESCE/);
  assert.match(doc, /historical/i);
  assert.match(doc, /VENDOR BLOCKER/);
  assert.match(doc, /\$5\.00/);
  assert.doesNotMatch(doc, /SAFE TO MERGE #175 AS DARK CODE/);
  assert.doesNotMatch(doc, /HeaderValue\s*[:=]\s*["'][^"']{4,}/);
  assert.doesNotMatch(doc, /SecretString/);
  assert.doesNotMatch(doc, /eyJ[A-Za-z0-9_-]{10,}\./);
  assert.doesNotMatch(doc, /DisableExecuteApiEndpoint=true/);
});

test('review records the SQL 65 unset-GUC fail-open without applying SQL on main', () => {
  assert.match(doc, /aws_checkalt_production_config/);
  assert.match(doc, /IF NOT NULL/);
  if (sql65) {
    assert.match(sql65, /DO NOT APPLY THIS FILE/);
    assert.match(sql65, /NOT_APPLIED/);
  }
});
