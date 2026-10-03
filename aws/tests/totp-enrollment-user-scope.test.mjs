import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sql = fs.readFileSync(
  path.join(ROOT, 'aws/migrations/proposed/NOT_APPLIED_20260911_financial_totp_enrollment.sql'),
  'utf8',
);
const handlers = fs.readFileSync(path.join(ROOT, 'aws/functions/api/auth-financial-totp.mjs'), 'utf8');
const identity = fs.readFileSync(path.join(ROOT, 'aws/functions/api/identity.mjs'), 'utf8');
const mappings = fs.readFileSync(path.join(ROOT, 'aws/identity/expected-mappings.mjs'), 'utf8');

test('financial_totp_enrollments primary key is application_user_id', () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.financial_totp_enrollments \([\s\S]*application_user_id uuid PRIMARY KEY/);
  assert.doesNotMatch(sql, /PRIMARY KEY \(tenant_id/);
  assert.doesNotMatch(sql, /UNIQUE \(email/);
  assert.doesNotMatch(sql, /UNIQUE \(tenant_id/);
});

test('enroll-start UPSERT is user-scoped and refuses verified overwrite', () => {
  assert.match(sql, /ON CONFLICT \(application_user_id\) DO UPDATE SET/);
  assert.match(sql, /WHERE public\.financial_totp_enrollments\.verified_at IS NULL/);
  assert.match(handlers, /financial_totp_upsert_enrollment\(\$1::uuid, \$2::bytea, \$3::bytea, \$4\)/);
  assert.match(handlers, /\[mapping\.application_user_id, wrapped\.ciphertext, wrapped\.nonce, wrapped\.keyId\]/);
  assert.match(handlers, /error: 'enrollment_reset_required'/);
  assert.doesNotMatch(handlers, /upsert_enrollment\(\$1::uuid,[\s\S]{0,80}tenant/);
  assert.doesNotMatch(sql, /ON CONFLICT \(email\)/);
  assert.doesNotMatch(sql, /ON CONFLICT \(tenant_id/);
});

test('identity mapping is cognito_sub → application_user_id, not email or tenant', () => {
  assert.match(identity, /FROM public\.identity_accounts\nWHERE cognito_sub = \$1/);
  assert.doesNotMatch(identity, /WHERE email = \$1/);
  assert.match(handlers, /const email = mapping\.email \|\| claims\.email \|\| body\.email \|\| null;/);
  assert.match(handlers, /otpauthUri\(secret, email\)/);
});

test('Freedom Michael and Condition One payments emails are distinct application users', () => {
  assert.match(mappings, /C1C_ADMIN_ID = 'fd857564-9534-4b0f-95ac-624ed1273725'/);
  assert.match(mappings, /email: 'mcarletta@freedomadj.com',\s*applicationUserId: '7dbb3009-f059-4767-b5dc-1c5c72379330'/);
  assert.match(mappings, /email: 'payments@condition1commercial.com',\s*applicationUserId: C1C_ADMIN_ID/);
  assert.notEqual('7dbb3009-f059-4767-b5dc-1c5c72379330', 'fd857564-9534-4b0f-95ac-624ed1273725');
});

test('verify and status load enrollment by mapping.application_user_id only', () => {
  assert.match(handlers, /financial_totp_status\(\$1::uuid\)/);
  assert.match(handlers, /financial_totp_get_enrollment\(\$1::uuid\)/);
  assert.match(handlers, /financial_totp_mark_verified\(\$1::uuid, \$2::bigint\)/);
  assert.match(handlers, /statusRow\(client, mapping\.application_user_id\)/);
  assert.match(handlers, /loadEnrollment\(client, mapping\.application_user_id\)/);
  assert.match(handlers, /\[mapping\.application_user_id, consumeTimestep \? verified\.timestep : null\]/);
});
