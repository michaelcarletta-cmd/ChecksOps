import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  CHECK_SCOPED_DIRECT,
  CHECK_SCOPED_GENERATE,
  CREATE_NEW,
  CREATE_OLD,
  DIRECT_NEW,
  DIRECT_OLD,
  EXPECTED_FILES_SHA256,
  FILES_TAB_UPLOAD,
  GENERATE_NEW,
  GENERATE_OLD,
  RETURN_NEW,
  RETURN_OLD,
  WIZARD_FN,
  filesInvariants,
  patchDyofNvxkFiles,
} from './sig-dyof-nvxk-files-patch.mjs';

const require = createRequire(import.meta.url);
const acorn = require('acorn');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, '../../tests/fixtures/current-live-CheckFilesSection-nvXkZh5q.js');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

test('live nvXk fixture still matches the current DyoF Files SHA', () => {
  assert.equal(existsSync(FIXTURE), true, 'need the live nvXkZh5q fixture');
  assert.equal(sha256(readFileSync(FIXTURE)), EXPECTED_FILES_SHA256);
});

test('nvXk Signature uploads retarget to check-intake/{checkId}/files and Class A create', () => {
  const source = readFileSync(FIXTURE, 'utf8');
  assert.equal(source.includes(WIZARD_FN), true);
  assert.equal(source.includes(GENERATE_OLD), true);
  assert.equal(source.includes(DIRECT_OLD), true);
  assert.equal(source.includes(CREATE_OLD), true);
  assert.equal(source.includes(RETURN_OLD), true);
  assert.equal(source.includes(FILES_TAB_UPLOAD), true);
  assert.equal(source.includes('signatures/${r}/'), true);
  assert.equal(source.includes('.from("signature_requests").insert'), true);
  assert.equal(source.includes('.from("signature_signers").insert'), true);

  const patched = patchDyofNvxkFiles(source);
  acorn.parse(patched, { ecmaVersion: 'latest', sourceType: 'module' });

  const invariants = filesInvariants(patched);
  for (const [key, ok] of Object.entries(invariants)) {
    assert.equal(ok, true, key);
  }
  assert.equal(patched.includes(GENERATE_NEW), true);
  assert.equal(patched.includes(DIRECT_NEW), true);
  assert.equal(patched.includes(CREATE_NEW), true);
  assert.equal(patched.includes(RETURN_NEW), true);
  assert.equal(patched.includes(CHECK_SCOPED_GENERATE), true);
  assert.equal(patched.includes(CHECK_SCOPED_DIRECT), true);
  assert.equal(patched.includes(FILES_TAB_UPLOAD), true);
  assert.equal(patched.includes('signatures/${r}/'), false);
  assert.equal(patched.includes('signatures/${'), false);
  assert.equal(patched.includes('.from("signature_requests").insert'), false);
  assert.equal(patched.includes('.from("signature_signers").insert'), false);
  assert.equal(patched.includes('functions.invoke("send-signature-request",{body:{claim_id:r,check_intake_item_id:w||null'), true);
  assert.equal((patched.match(/Signature upload requires a check-scoped path/g) || []).length, 2);
  assert.equal(patched.includes('from"./index-DyoF7zdg.js"'), true);
  assert.equal(patched.includes('from"./CheckCommandCenter-Cq_8X3gy.js"'), true);
  assert.equal(patched.includes('index-C9QrEEkl.js'), false);
  assert.equal(patched.includes('CheckFilesSection-BJZPqPpX.js'), false);
  assert.equal((patched.match(/functions\.invoke\("send-signature-request"/g) || []).length >= 2, true);
});

test('patch refuses a drifted Files chunk that lost the nvXk wizard sites', () => {
  assert.throws(
    () => patchDyofNvxkFiles('function other(){return 1}'),
    /lost inlined Signature wizard/,
  );
});

test('patch refuses restoring accepted C9Qr/BJZ bytes as the live baseline', () => {
  const bjz = path.resolve(HERE, '../../tests/fixtures/current-live-CheckFilesSection-BJZPqPpX.js');
  if (!existsSync(bjz)) return;
  assert.throws(
    () => patchDyofNvxkFiles(readFileSync(bjz, 'utf8')),
    /does not import current DyoF entry/,
  );
});
