import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  checkAltCardHeading,
  describeCheckAltSide,
  inspectCheckAltSide,
  isStorageObjectMissing,
  loadCheckAltCardState,
  plainComplianceReason,
  toCheckAltComplianceStatus,
} from '../../src/lib/checkaltComplianceDisplay.ts';
import {
  describeCheckAltPrepFailure,
  resetDepositInFlightForTests,
  runCheckAltDepositClick,
} from '../../src/lib/checkaltDepositOrchestrator.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHECK = 'a3a4a153-46e1-4c28-a273-79a9bd04f3a6';
const FRONT = 'claims/c1/checks/front_1.jpg';
const BACK = 'claims/c1/checks/endorsed_deposit_abc.checkalt.jpg';
const LEGACY_BACK = 'claims/c1/checks/back_1.png';

const good = { present: true, jpeg: true, width: 1920, height: 1080, bytes: 120 * 1024 };
const blob = () => new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0x00])]);

// /storage/sign answers 404 object_not_in_s3 for a missing key (aws/functions/api/storage.mjs).
const notInS3 = { message: 'Authorized object is not present in staging S3', name: 'StorageApiError', statusCode: 404 };

const deps = (objects, measured = {}) => {
  const downloads = [];
  return {
    downloads,
    download: async (p) => {
      downloads.push(p);
      const o = objects[p];
      if (o === undefined) return { data: null, error: notInS3 };
      if (o instanceof Error) throw o;
      if (o && o.error) return { data: null, error: o.error };
      return { data: blob(), error: null };
    },
    measure: async () => ({ ...good, ...(measured || {}) }),
  };
};

const allText = (d) => `${d.label} ${d.hint ?? ''}`;

test('front: source exists, prepared copy not created yet -> Ready to prepare (neutral)', async () => {
  const d = deps({});
  const s = await inspectCheckAltSide(FRONT, 'front', d);
  assert.deepEqual(d.downloads, ['claims/c1/checks/front_1.checkalt.jpg']);
  assert.equal(s.kind, 'ready_to_prepare');
  const view = describeCheckAltSide(s);
  assert.equal(view.label, 'Front: Ready to prepare');
  assert.equal(view.hint, 'The bank-ready image is created when you press Deposit.');
  assert.equal(view.tone, 'neutral');
  assert.equal(view.code, 'front_not_prepared');
});

test('back: legacy raster endorsed image not prepared yet -> Ready to prepare with endorsement hint', async () => {
  const s = await inspectCheckAltSide(LEGACY_BACK, 'rear', deps({}));
  const view = describeCheckAltSide(s);
  assert.equal(view.label, 'Back: Ready to prepare');
  assert.equal(view.hint, 'The bank-ready image is created from the endorsed back when you press Deposit.');
  assert.equal(view.tone, 'neutral');
});

test('prepared copy passes -> Ready for bank (green)', async () => {
  const front = await inspectCheckAltSide(FRONT, 'front', deps({ 'claims/c1/checks/front_1.checkalt.jpg': true }));
  const back = await inspectCheckAltSide(BACK, 'rear', deps({ [BACK]: true }));
  assert.equal(describeCheckAltSide(front).label, 'Front: Ready for bank ✓');
  assert.equal(describeCheckAltSide(front).tone, 'good');
  assert.equal(describeCheckAltSide(back).label, 'Back: Ready for bank ✓');
  assert.equal(describeCheckAltSide(back).tone, 'good');
});

test('prepared copy fails validation -> Needs a new photo with a plain reason, never the raw code', async () => {
  const cases = [
    [{ bytes: 10 * 1024 }, 'front_too_small', 'Image is too small (under 25 KB)'],
    [{ bytes: 400 * 1024 }, 'front_too_large', 'Image is too large (over 300 KB)'],
    [{ width: 1080, height: 1920 }, 'front_dimensions', 'Image is the wrong size or shape'],
    [{ jpeg: false, width: 0, height: 0 }, 'front_invalid_jpeg', 'Image file is damaged or not a JPEG'],
  ];
  for (const [measured, code, reason] of cases) {
    const s = await inspectCheckAltSide(FRONT, 'front', deps({ 'claims/c1/checks/front_1.checkalt.jpg': true }, measured));
    assert.equal(s.kind, 'needs_new_photo');
    const view = describeCheckAltSide(s);
    assert.equal(view.label, 'Front: Needs a new photo');
    assert.equal(view.tone, 'bad');
    assert.equal(view.code, code);
    assert.ok(view.hint.startsWith(reason), `${code}: ${view.hint}`);
    assert.doesNotMatch(allText(view), /front_|rear_|_too_|_missing|_dimensions|_invalid/);
  }
  const back = await inspectCheckAltSide(BACK, 'rear', deps({ [BACK]: true }, { bytes: 400 * 1024 }));
  const bv = describeCheckAltSide(back);
  assert.equal(bv.label, 'Back: Needs a new photo');
  assert.equal(bv.code, 'rear_too_large');
  assert.match(bv.hint, /^Image is too large \(over 300 KB\)/);
  assert.doesNotMatch(allText(bv), /rear_/);
});

test('plain reasons track the real limits in checkaltImageCompliance.ts', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/lib/checkaltImageCompliance.ts'), 'utf8');
  assert.match(src, /CHECKALT_MIN_BYTES = 25 \* 1024/);
  assert.match(src, /CHECKALT_MAX_COMPLIANT_BYTES = 300 \* 1024/);
  assert.equal(plainComplianceReason('rear_too_small'), 'Image is too small (under 25 KB)');
  assert.equal(plainComplianceReason('rear_too_large'), 'Image is too large (over 300 KB)');
});

test('no source photo -> red, with what to do', async () => {
  const d = deps({});
  const front = await inspectCheckAltSide('', 'front', d);
  const back = await inspectCheckAltSide(null, 'rear', d);
  assert.equal(d.downloads.length, 0);
  assert.deepEqual(describeCheckAltSide(front), {
    label: 'Front: No photo uploaded',
    hint: 'Upload the front of the check.',
    tone: 'bad',
    code: 'front_missing',
  });
  assert.equal(describeCheckAltSide(back).label, 'Back: No endorsed image yet');
  assert.equal(describeCheckAltSide(back).hint, 'Complete the endorsement to create the back of the check.');
  assert.equal(describeCheckAltSide(back).tone, 'bad');
});

test('endorsed back that is itself the bank copy but is gone from storage is red, not Ready to prepare', async () => {
  const s = await inspectCheckAltSide(BACK, 'rear', deps({}));
  assert.equal(s.kind, 'source_missing');
  const view = describeCheckAltSide(s);
  assert.equal(view.label, 'Back: Endorsed image is missing');
  assert.equal(view.tone, 'bad');
});

test('unsupported source type is red and is not downloaded', async () => {
  const d = deps({});
  const s = await inspectCheckAltSide('claims/c1/checks/front.pdf', 'front', d);
  assert.equal(d.downloads.length, 0);
  assert.equal(describeCheckAltSide(s).label, 'Front: Needs a new photo');
  assert.equal(describeCheckAltSide(s).tone, 'bad');
});

test('network or other storage errors are neutral "Couldn\'t check", never red or Ready to prepare', async () => {
  const errors = [
    { error: { message: 'storage_forbidden', statusCode: 403 } },
    { error: { message: 'JWT expired', statusCode: 401 } },
    { error: { message: 'Internal', statusCode: 500 } },
    new TypeError('Failed to fetch'),
  ];
  for (const e of errors) {
    const s = await inspectCheckAltSide(FRONT, 'front', deps({ 'claims/c1/checks/front_1.checkalt.jpg': e }));
    assert.equal(s.kind, 'unknown');
    const view = describeCheckAltSide(s);
    assert.equal(view.label, "Front: Couldn't check the image right now");
    assert.equal(view.tone, 'neutral');
  }
});

test('missing-object detection covers the sign 404, signed GET 404 and Supabase "Object not found"', () => {
  assert.equal(isStorageObjectMissing(notInS3), true);
  assert.equal(isStorageObjectMissing({ message: 'download_failed', statusCode: 404 }), true);
  assert.equal(isStorageObjectMissing({ message: 'Object not found', statusCode: '400' }), true);
  assert.equal(isStorageObjectMissing({ message: 'object_not_in_s3' }), true);
  assert.equal(isStorageObjectMissing({ message: 'download_failed', statusCode: 403 }), false);
  assert.equal(isStorageObjectMissing({ message: 'storage_forbidden', statusCode: 403 }), false);
  assert.equal(isStorageObjectMissing(null), false);
});

test('heading: Ready to deposit unless a side is red', async () => {
  const notYet = await loadCheckAltCardState({ frontImagePath: FRONT, backImageDepositPath: LEGACY_BACK }, deps({}));
  assert.deepEqual(checkAltCardHeading(notYet), { text: 'Ready to deposit', tone: 'good' });

  const mixed = await loadCheckAltCardState(
    { frontImagePath: FRONT, backImageDepositPath: BACK },
    deps({ [BACK]: true }),
  );
  assert.equal(describeCheckAltSide(mixed.front).label, 'Front: Ready to prepare');
  assert.equal(describeCheckAltSide(mixed.rear).label, 'Back: Ready for bank ✓');
  assert.equal(checkAltCardHeading(mixed).text, 'Ready to deposit');

  const unknown = await loadCheckAltCardState(
    { frontImagePath: FRONT, backImageDepositPath: BACK },
    deps({ 'claims/c1/checks/front_1.checkalt.jpg': { error: { message: 'x', statusCode: 500 } }, [BACK]: true }),
  );
  assert.equal(checkAltCardHeading(unknown).text, 'Ready to deposit');

  const red = await loadCheckAltCardState({ frontImagePath: '', backImageDepositPath: BACK }, deps({ [BACK]: true }));
  assert.deepEqual(checkAltCardHeading(red), { text: 'Needs attention', tone: 'bad' });

  const badBack = await loadCheckAltCardState(
    { frontImagePath: FRONT, backImageDepositPath: BACK },
    deps({ [BACK]: true }, { width: 100, height: 100 }),
  );
  assert.equal(checkAltCardHeading(badBack).text, 'Needs attention');
});

test('compatibility status stays PASS only when both bank copies exist and pass', async () => {
  const notYet = await loadCheckAltCardState({ frontImagePath: FRONT, backImageDepositPath: BACK }, deps({ [BACK]: true }));
  const status = toCheckAltComplianceStatus(notYet);
  assert.equal(status.overall, 'FAIL');
  assert.equal(status.front.pass, false);
  assert.equal(status.rear.pass, true);
  const both = await loadCheckAltCardState(
    { frontImagePath: FRONT, backImageDepositPath: BACK },
    deps({ 'claims/c1/checks/front_1.checkalt.jpg': true, [BACK]: true }),
  );
  assert.equal(toCheckAltComplianceStatus(both).overall, 'PASS');
});

test('card source shows the new labels and never renders raw codes or Pass/Fail', () => {
  const card = fs.readFileSync(path.join(ROOT, 'src/components/checks/CheckAltImageComplianceCard.tsx'), 'utf8');
  assert.match(card, /describeCheckAltSide/);
  assert.match(card, /checkAltCardHeading/);
  assert.match(card, /data-checkalt-code/);
  assert.match(card, /Checking images/);
  assert.doesNotMatch(card, /report\.reason/);
  assert.doesNotMatch(card, /"Pass"|"Fail"|Needs attention/);
  assert.doesNotMatch(card, /prepareCheckAltDeposit/);
});

test('prepare failures surface a plain reason without leaking internals', () => {
  const cases = [
    [new Error('front Source check is too small to build a readable 1920x1080 image. Reupload a clearer photo.'), /front photo is too small to make a bank-ready image/],
    [new Error('rear JPEG is under 25KB at the current quality. Fail compliance rather than fabricating detail.'), /back of the check came out too small/],
    [new Error('front Minimum approved JPEG quality still exceeds 300KB. Fail compliance rather than degrading further.'), /too large \(over 300 KB\)/],
    [new Error('CheckAlt image upload failed: uploads_disabled'), /couldn't be saved/],
    [new Error('Could not download claims/c1/checks/front_1.jpg'), /front photo couldn't be loaded/],
    [new Error('Authorized object is not present in staging S3'), /couldn't be found in storage/],
    [new Error('CHECKALT_IMAGE_COMPLIANCE_FAILED: front_missing'), /front photo of the check is missing/],
    [new Error('CHECKALT_IMAGE_COMPLIANCE_FAILED: rear_missing. Generate the endorsed deposit image before depositing.'), /endorsed back image is missing/],
    [new Error('Check not found for CheckAlt image preparation'), /couldn't find this check/],
    [new Error('JWT expired'), /session has expired/],
    [new Error('The source image could not be decoded.'), /damaged or isn't a supported image/],
    [new Error('canvas_unavailable'), /browser couldn't prepare/],
  ];
  for (const [error, expected] of cases) {
    const message = describeCheckAltPrepFailure(error, null);
    assert.match(message, expected, error.message);
    assert.doesNotMatch(message, /claims\/|\.jpg|S3|CHECKALT_|uploads_disabled|_missing|JWT/, message);
  }
  assert.match(describeCheckAltPrepFailure(new Error('something odd'), 'front'), /retake the front image/);
  assert.match(describeCheckAltPrepFailure(undefined, 'back'), /retake the back image/);
});

test('Deposit click returns the plain prepare reason and never submits', async () => {
  resetDepositInFlightForTests();
  let submits = 0;
  let stepUps = 0;
  const result = await runCheckAltDepositClick(CHECK, {
    authProvider: 'cognito',
    apiBaseUrl: '/prep',
    preflight: async () => ({ ok: false, needFrontPrep: true, needRearPrep: false, attention: 'front', liveProviderCalled: false }),
    prepareCheckAltDeposit: async () => {
      throw new Error('front Source check is too small to build a readable 1920x1080 image. Reupload a clearer photo.');
    },
    requireStepUp: async () => { stepUps += 1; return true; },
    submit: async () => { submits += 1; return { error: null, data: {} }; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.phase, 'failed');
  assert.equal(result.error, 'image_prep_failed');
  assert.equal(result.attention, 'front');
  assert.equal(result.prepared, false);
  assert.match(result.message, /front photo is too small to make a bank-ready image/);
  assert.doesNotMatch(result.message, /1920x1080|Reupload/);
  assert.equal(submits, 0);
  assert.equal(stepUps, 0);

  resetDepositInFlightForTests();
  const upload = await runCheckAltDepositClick(CHECK, {
    authProvider: 'cognito',
    apiBaseUrl: '/prep',
    preflight: async () => ({ ok: false, needFrontPrep: true, needRearPrep: true, liveProviderCalled: false }),
    prepareCheckAltDeposit: async () => { throw new Error('CheckAlt image upload failed: upload_failed'); },
    requireStepUp: async () => true,
    submit: async () => { submits += 1; return { error: null, data: {} }; },
  });
  assert.match(upload.message, /couldn't be saved/);
  assert.doesNotMatch(upload.message, /upload_failed/);
  assert.equal(submits, 0);
});
