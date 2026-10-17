/**
 * Static checks for the recorded signature SQL sources. Nothing here applies SQL.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const HELPERS = 'aws/storage/sql/02_public_signature_write_helpers.sql';
const SQL92 = 'aws/workflows/sql/92_signature_request_check_files_link_grant.sql';

test('02 public signature write helpers: recorded from Cursor 63cae7475, marked unverified', () => {
  const text = read(HELPERS);
  const lines = text.split('\n');
  const headerEnd = lines.findIndex((line) => !line.startsWith('--'));
  const header = lines.slice(0, 9).join('\n');
  assert.match(header, /RECORDED FROM CURSOR 63cae7475/);
  assert.match(header, /PRODUCTION PRESENCE NOT YET VERIFIED/);
  assert.match(header, /DO NOT APPLY WITHOUT A READ-ONLY INSPECT/);
  assert.ok(headerEnd > 9);
  const body = lines.slice(9).join('\n');
  assert.equal(
    createHash('sha256').update(body).digest('hex'),
    'cf0b3a5402e5b0605c50d0f9633333983224a4d794949041ac496d3583ceaa7a',
    'body is byte-identical to Cursor 63cae7475',
  );
  for (const fn of [
    'aws_public_signature_submit',
    'aws_public_signature_attach_signed',
    'aws_public_signature_mark_viewed',
    'aws_public_signature_set_completion_error',
  ]) {
    assert.match(text, new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\(`));
    assert.match(text, new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([^)]*\\) FROM PUBLIC;`));
    assert.match(text, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([^)]*\\) TO checksops;`));
  }
});

test('SQL 92 grants only UPDATE (signature_request_id) on check_files, idempotently', () => {
  const text = read(SQL92);
  const code = text.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
  const grants = [...code.matchAll(/GRANT[^;']*/g)].map((m) => m[0].trim());
  assert.deepEqual(grants, [
    'GRANT UPDATE (signature_request_id) ON TABLE public.check_files TO checksops',
    'GRANT UPDATE (signature_request_id) ON TABLE public.check_files TO authenticated',
  ]);
  assert.doesNotMatch(code, /\bREVOKE\b|\bPOLICY\b|ROW LEVEL SECURITY|\bTO\s+PUBLIC\b|\banon\b/i);
  assert.match(code, /to_regclass\('public\.check_files'\) IS NULL/);
  assert.match(code, /column_name = 'signature_request_id'/);
  assert.match(text, /NOT APPLIED/);
});
