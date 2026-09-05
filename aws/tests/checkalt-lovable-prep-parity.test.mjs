import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BROWSER_QUALITY_LADDER,
  comparePrepPipelines,
  inspectOriented,
  isAlreadyDepositReady,
  LANDSCAPE_JPEG_QUALITY,
  MIN_ACCEPTABLE_DIM,
  PER_IMAGE_BYTES_BUDGET,
  prepareLikeLovableBrowser,
  normalizeToBudgetImageScript,
  syntheticCheckPng,
  syntheticCheckRaster,
  syntheticJpegWithExifOrientation,
  TARGET_MAX_DIM,
  toDepositPath,
} from '../functions/api/providers/parity/checkalt-image.mjs';
import {
  buildDepositProcessBody,
  LOVABLE_PROCESS_BODY_KEYS,
} from '../functions/api/providers/parity/checkalt-client.mjs';

test('Lovable browser prep constants match source of truth', () => {
  assert.equal(PER_IMAGE_BYTES_BUDGET, 450_000);
  assert.equal(TARGET_MAX_DIM, 1600);
  assert.equal(MIN_ACCEPTABLE_DIM, 1300);
  assert.equal(LANDSCAPE_JPEG_QUALITY, 92);
  assert.deepEqual(BROWSER_QUALITY_LADDER, [80, 62, 50, 38]);
  assert.equal(toDepositPath('checks/a/front.jpg'), 'checks/a/front.deposit2.jpg');
  assert.equal(toDepositPath('checks/a/back.png'), 'checks/a/back.deposit2.jpg');
});

test('already-good landscape JPEG is passed through without re-encode', async () => {
  const src = syntheticCheckRaster({ width: 1400, height: 1000, flat: true });
  assert.ok(src.length <= PER_IMAGE_BYTES_BUDGET);
  const info = await inspectOriented(src);
  assert.equal(isAlreadyDepositReady(info), true);
  const out = await prepareLikeLovableBrowser(src, 'front');
  assert.equal(Buffer.compare(out, src), 0);
});

test('EXIF orientation 6 is treated as landscape like createImageBitmap', async () => {
  const storedPortrait = await syntheticJpegWithExifOrientation({
    width: 1000,
    height: 1600,
    orientation: 6,
  });
  const oriented = await inspectOriented(storedPortrait);
  assert.equal(oriented.width, 1600);
  assert.equal(oriented.height, 1000);
  assert.equal(oriented.landscape, true);
  assert.equal(isAlreadyDepositReady(oriented), oriented.bytes <= PER_IMAGE_BYTES_BUDGET);

  // ImageScript port looks at stored pixels and would rotate again.
  const script = normalizeToBudgetImageScript(storedPortrait, 'front');
  const browser = await prepareLikeLovableBrowser(storedPortrait, 'front');
  assert.equal(Buffer.compare(browser, script) === 0, false);
});

test('browser path never shrinks an already-landscape image below 1300px', async () => {
  const src = syntheticCheckRaster({ width: 2200, height: 1400, seed: 11 });
  const out = await prepareLikeLovableBrowser(src, 'front');
  const info = await inspectOriented(out);
  assert.equal(info.landscape, true);
  assert.ok(Math.max(info.width, info.height) >= MIN_ACCEPTABLE_DIM);
  assert.ok(Math.max(info.width, info.height) <= TARGET_MAX_DIM);
  assert.ok(out.length <= PER_IMAGE_BYTES_BUDGET);
});

test('ImageScript fallback encoder does not match browser prep bytes on portrait input', async () => {
  const portrait = syntheticCheckRaster({ width: 900, height: 1400, seed: 3 });
  const diff = await comparePrepPipelines(portrait, 'rear');
  assert.equal(diff.alreadyGood, false);
  assert.equal(diff.browserVsImageScriptIdentical, false);
  assert.ok(diff.browserBytes <= PER_IMAGE_BYTES_BUDGET);
  assert.ok(diff.imageScriptBytes <= PER_IMAGE_BYTES_BUDGET);
});

test('PNG is converted to JPEG without a data-URL prefix', async () => {
  const png = syntheticCheckPng({ width: 1600, height: 1000 });
  const out = await prepareLikeLovableBrowser(png, 'front');
  assert.equal(out[0], 0xff);
  assert.equal(out[1], 0xd8);
  const b64 = out.toString('base64');
  assert.equal(b64.startsWith('data:'), false);
});

test('/fincapture/deposit/process body matches Lovable field set', () => {
  const body = buildDepositProcessBody({
    fiKey: 'fi',
    ssoKey: 'sso',
    depositAccountNumber: '90001111',
    captureDateTime: '2026-01-01T00:00:00.000Z',
    userAmount: 12345,
    frontImage: 'Zm9v',
    rearImage: 'YmFy',
  });
  assert.deepEqual(Object.keys(body), LOVABLE_PROCESS_BODY_KEYS);
  assert.equal(body.performRiskAssessment, true);
  assert.equal(body.testDeposit, undefined);
  assert.equal(body.businessUnit, undefined);
  assert.equal(body.checkNumber, undefined);
  const noRear = buildDepositProcessBody({
    fiKey: 'fi',
    ssoKey: 'sso',
    depositAccountNumber: '90001111',
    captureDateTime: '2026-01-01T00:00:00.000Z',
    userAmount: 1,
    frontImage: 'Zm9v',
  });
  assert.equal('rearImage' in noRear, false);
});
