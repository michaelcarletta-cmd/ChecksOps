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
  patchC9qrBjzFiles,
} from './sig-c9qr-bjz-files-patch.mjs';

const require = createRequire(import.meta.url);
const acorn = require('acorn');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, '../../tests/fixtures/current-live-CheckFilesSection-BJZPqPpX.js');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

test('live BJZ fixture still matches the approved C9Qr Files SHA', () => {
  assert.equal(existsSync(FIXTURE), true, 'need the live BJZPqPpX fixture');
  assert.equal(sha256(readFileSync(FIXTURE)), EXPECTED_FILES_SHA256);
});

test('BJZ Signature uploads retarget to check-intake/{checkId}/files and Class A create', () => {
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

  const patched = patchC9qrBjzFiles(source);
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
  assert.equal(patched.includes('from"./index-C9QrEEkl.js"'), true);
  assert.equal(patched.includes('from"./CheckCommandCenter-CO3eXFPG.js"'), true);
  assert.equal(patched.includes('CheckFilesSection-0Fmhwbep.js'), false);
  assert.equal(patched.includes('CheckFilesSection-D_MzlCn1.js'), false);
  assert.equal((patched.match(/functions\.invoke\("send-signature-request"/g) || []).length >= 2, true);
});

test('patch refuses a drifted Files chunk that lost the BJZ wizard sites', () => {
  assert.throws(
    () => patchC9qrBjzFiles('function other(){return 1}'),
    /lost inlined Signature wizard/,
  );
});
