import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  AZURE_OCR_HARD_MAX_BYTES,
  AZURE_OCR_MAX_DIMENSION,
  AZURE_OCR_MAX_PIXELS,
  AZURE_OCR_MIN_LONG_EDGE,
  AZURE_OCR_TARGET_MAX_BYTES,
  AZURE_OCR_UNUSABLE,
  prepareAzureOcrImage,
  readJpegDimensions,
} from '../functions/api/ocr-azure-image.mjs';
import { createRequire } from 'node:module';
import {
  inspectOriented,
  isJpegMagic,
  syntheticCheckRaster,
  syntheticJpegWithExifOrientation,
} from '../functions/api/providers/parity/checkalt-image.mjs';

const requireFromApi = createRequire(new URL('../functions/api/package.json', import.meta.url));
const { PNG } = requireFromApi('pngjs');
import { extractCheck } from '../functions/api/check-ocr-provider.mjs';
import { redactOcrIntakeResponse } from '../functions/api/ocr.mjs';
import { redactOcrLog } from '../functions/api/azure-check-ocr.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PREP_SRC = path.join(here, '../functions/api/ocr-azure-image.mjs');
const PROVIDER_SRC = path.join(here, '../functions/api/check-ocr-provider.mjs');

const ROUTING_OK = '111000025';
const ACCOUNT = '000111222333';
const CHECK = '778899';
const PAYEE = 'Azure Only Payee LLC';
const ENDPOINT = 'https://di-test.example.test';
const KEY = 'test-azure-key-not-real';
const RESULT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const jpegWithSof = ({ width, height, extraBytes = 0 }) => {
  const head = Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0,
    0x00, 0x0b,
    0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x01, 0x01, 0x11, 0x00,
  ]);
  if (!extraBytes) return head;
  return Buffer.concat([head, Buffer.alloc(extraBytes, 0x00)]);
};

const field = (value, confidence = 0.2) => ({
  valueString: value,
  content: value,
  confidence,
});

const azureSuccessFetch = (capture = {}) => {
  const op = `${ENDPOINT}/documentintelligence/documentModels/prebuilt-check.us/analyzeResults/${RESULT}`;
  return async (url, init) => {
    if (init.method === 'POST') {
      capture.posts = (capture.posts || 0) + 1;
      capture.postBody = init.body;
      const parsed = JSON.parse(init.body);
      capture.azureBytes = Buffer.from(parsed.base64Source, 'base64');
      return {
        status: 202,
        headers: { get: (n) => (String(n).toLowerCase() === 'operation-location' ? op : null) },
        text: async () => '',
      };
    }
    if (init.method === 'DELETE') {
      capture.deletes = (capture.deletes || 0) + 1;
      return { status: 204, headers: { get: () => null }, text: async () => '' };
    }
    return {
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({
        status: 'succeeded',
        analyzeResult: {
          documents: [{
            fields: {
              MICR: {
                valueObject: {
                  RoutingNumber: field(ROUTING_OK, 0),
                  AccountNumber: field(ACCOUNT, 0.008),
                  CheckNumber: field(CHECK, 0.168),
                },
              },
              PayTo: field(PAYEE),
            },
          }],
        },
      }),
    };
  };
};

const textractBlocks = () => ({
  Blocks: [
    {
      BlockType: 'LINE',
      Text: 'TEXTRACT CARRIER MUTUAL',
      Confidence: 96,
      Geometry: { BoundingBox: { Left: 0.1, Top: 0.05, Width: 0.4, Height: 0.03 } },
    },
    {
      BlockType: 'LINE',
      Text: `CHECK NO: ${CHECK}`,
      Confidence: 93,
      Geometry: { BoundingBox: { Left: 0.72, Top: 0.12, Width: 0.2, Height: 0.03 } },
    },
  ],
});

test('policy constants leave 3.5MB headroom under the 4MB Azure ceiling', () => {
  assert.equal(AZURE_OCR_TARGET_MAX_BYTES, Math.floor(3.5 * 1024 * 1024));
  assert.equal(AZURE_OCR_HARD_MAX_BYTES, 4 * 1024 * 1024);
  assert.ok(AZURE_OCR_TARGET_MAX_BYTES < AZURE_OCR_HARD_MAX_BYTES);
  assert.equal(AZURE_OCR_MIN_LONG_EDGE, 1600);
  assert.equal(AZURE_OCR_MAX_PIXELS, 25_000_000);
  assert.equal(AZURE_OCR_MAX_DIMENSION, 10_000);
});

test('under target returns the same Buffer reference without decode', async () => {
  const src = syntheticCheckRaster({ width: 400, height: 260, flat: true });
  assert.ok(src.length <= AZURE_OCR_TARGET_MAX_BYTES);
  const before = sha256(src);
  const out = await prepareAzureOcrImage(src);
  assert.equal(out.ok, true);
  assert.equal(out.transformed, false);
  assert.equal(out.code, 'passthrough');
  assert.equal(out.bytes, src);
  assert.equal(sha256(src), before);
});

test('oversized JPEG becomes an in-memory derivative at or under the target', async () => {
  const src = syntheticCheckRaster({ width: 1800, height: 1100, seed: 17 });
  const target = Math.max(32_000, src.length - 1);
  assert.ok(src.length > target);
  const before = sha256(src);
  const tmpBefore = new Set(readdirSync('/tmp'));
  const out = await prepareAzureOcrImage(src, { targetMaxBytes: target });
  const tmpAfter = readdirSync('/tmp');
  assert.equal(out.ok, true);
  assert.equal(out.transformed, true);
  assert.notEqual(out.bytes, src);
  assert.ok(out.bytes.length <= target);
  assert.ok(out.bytes.length <= AZURE_OCR_HARD_MAX_BYTES);
  assert.ok(isJpegMagic(out.bytes));
  assert.equal(sha256(src), before);
  assert.equal(src.length, out.input_bytes);
  // Node's test runner may execute other PostgreSQL-backed OCR SQL tests in
  // parallel, which legitimately create /tmp/pg-ocr-claim-* clusters. This
  // assertion is specifically about prepareAzureOcrImage being in-memory.
  const created = tmpAfter.filter((name) =>
    !tmpBefore.has(name)
    && /ocr|azure|check/i.test(name)
    && !/^pg-ocr-claim-/i.test(name)
  );
  assert.deepEqual(created, []);
});

test('oversized derivative preserves aspect ratio and does not crop or pad', async () => {
  const src = syntheticCheckRaster({ width: 2200, height: 1400, seed: 5 });
  const srcRatio = 2200 / 1400;
  const out = await prepareAzureOcrImage(src, {
    targetMaxBytes: Math.min(120_000, src.length - 1),
    minLongEdge: 800,
  });
  assert.equal(out.ok, true);
  assert.equal(out.transformed, true);
  const info = await inspectOriented(out.bytes);
  assert.ok(info.width > 0 && info.height > 0);
  const outRatio = info.width / info.height;
  assert.ok(Math.abs(outRatio - srcRatio) < 0.02);
  assert.equal(info.width === 1920 && info.height === 1080, false);
  assert.equal(out.width, info.width);
  assert.equal(out.height, info.height);
});

test('EXIF orientation 6 is applied before landscape and ratio checks', async () => {
  const src = await syntheticJpegWithExifOrientation({
    width: 900,
    height: 1400,
    orientation: 6,
  });
  const oriented = await inspectOriented(src);
  assert.equal(oriented.width, 1400);
  assert.equal(oriented.height, 900);
  const target = Math.max(8_000, src.length - 1);
  const out = await prepareAzureOcrImage(src, { targetMaxBytes: target, minLongEdge: 700 });
  assert.equal(out.ok, true);
  assert.equal(out.transformed, true);
  assert.ok(out.width >= out.height);
  assert.ok(Math.abs((out.width / out.height) - (1400 / 900)) < 0.03);
});

test('pathological pixel count fails closed before decode', async () => {
  const src = jpegWithSof({
    width: 9000,
    height: 4000,
    extraBytes: 64,
  });
  assert.equal(readJpegDimensions(src).width, 9000);
  assert.ok(9000 * 4000 > AZURE_OCR_MAX_PIXELS);
  const target = src.length - 1;
  const out = await prepareAzureOcrImage(src, { targetMaxBytes: Math.max(1, target) });
  assert.equal(out.ok, false);
  assert.equal(out.code, AZURE_OCR_UNUSABLE);
  assert.equal(out.bytes, null);
});

test('oversized undecodable JPEG fails closed', async () => {
  const src = jpegWithSof({ width: 640, height: 400, extraBytes: 8_000 });
  const out = await prepareAzureOcrImage(src, { targetMaxBytes: 100 });
  assert.equal(out.ok, false);
  assert.equal(out.code, AZURE_OCR_UNUSABLE);
  assert.equal(out.bytes, null);
});

test('prepare timeout fails closed without writing files', async () => {
  const src = syntheticCheckRaster({ width: 800, height: 500, seed: 9 });
  let calls = 0;
  const now = () => {
    calls += 1;
    return calls === 1 ? 0 : 20_000;
  };
  const tmpBefore = new Set(readdirSync('/tmp'));
  const out = await prepareAzureOcrImage(src, {
    targetMaxBytes: 32,
    prepareTimeoutMs: 8_000,
    now,
  });
  const tmpAfter = readdirSync('/tmp');
  assert.equal(out.ok, false);
  assert.equal(out.code, AZURE_OCR_UNUSABLE);
  assert.equal(out.bytes, null);
  const created = tmpAfter.filter((name) => !tmpBefore.has(name) && /ocr|azure|check/i.test(name));
  assert.deepEqual(created, []);
});

test('PNG over the test target is re-encoded as JPEG without padding', async () => {
  const png = new PNG({ width: 800, height: 500 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = (i * 13) % 256;
    png.data[i + 1] = (i * 7) % 256;
    png.data[i + 2] = (i * 3) % 256;
    png.data[i + 3] = 255;
  }
  const src = PNG.sync.write(png, { deflateLevel: 0 });
  const target = 80_000;
  assert.ok(src.length > target);
  const out = await prepareAzureOcrImage(src, {
    targetMaxBytes: target,
    minLongEdge: 400,
  });
  assert.equal(out.ok, true);
  assert.equal(out.transformed, true);
  assert.equal(isJpegMagic(out.bytes), true);
  const info = await inspectOriented(out.bytes);
  assert.ok(Math.abs((info.width / info.height) - (800 / 500)) < 0.02);
});

test('unsupported oversized bytes never become an Azure payload', async () => {
  const src = Buffer.alloc(80_000, 0x41);
  const out = await prepareAzureOcrImage(src, { targetMaxBytes: 1_000 });
  assert.equal(out.ok, false);
  assert.equal(out.code, AZURE_OCR_UNUSABLE);
});

test('prepare logs stay redacted and only include safe diagnostics', async () => {
  const logs = [];
  const src = syntheticCheckRaster({ width: 400, height: 260, flat: true });
  await prepareAzureOcrImage(src, {
    log: (row) => logs.push(row),
  });
  const blob = JSON.stringify(logs);
  assert.ok(!blob.includes(ROUTING_OK));
  assert.ok(!blob.includes(ACCOUNT));
  assert.ok(!blob.includes(ENDPOINT));
  assert.ok(!blob.includes(KEY));
  assert.ok(!blob.includes(RESULT));
  assert.ok(!/base64Source/.test(blob));
  assert.equal(logs[0].event, 'azure_image_prepare');
  assert.equal(typeof logs[0].transformed, 'boolean');
  assert.equal(typeof logs[0].input_bytes, 'number');
  assert.equal(typeof logs[0].ms, 'number');
});

test('Textract receives original bytes and Azure receives the derivative', async () => {
  const original = syntheticCheckRaster({ width: 1600, height: 1000, seed: 21 });
  const before = sha256(original);
  const capture = {};
  let textractBytes = null;
  const logs = [];
  const out = await extractCheck({
    imageBytes: original,
    secretLoader: async () => ({ endpoint: ENDPOINT, api_key: KEY }),
    textractSend: async (cmd) => {
      textractBytes = cmd?.input?.Document?.Bytes ?? cmd?.Document?.Bytes;
      return textractBlocks();
    },
    fetchImpl: azureSuccessFetch(capture),
    sleep: async () => {},
    now: () => 0,
    log: (row) => logs.push(row),
    prepareOpts: { targetMaxBytes: original.length - 1, minLongEdge: 800 },
  });
  assert.equal(sha256(original), before);
  assert.ok(textractBytes);
  assert.equal(sha256(textractBytes), before);
  assert.equal(capture.posts, 1);
  assert.ok(capture.azureBytes.length);
  assert.notEqual(sha256(capture.azureBytes), before);
  assert.ok(capture.azureBytes.length <= original.length - 1);
  assert.equal(out.canonical.micr_routing_state, 'VERIFIED');
  assert.equal(out.azure_delete_confirmed, true);
  const http = redactOcrIntakeResponse({
    parsed: out.canonical,
    azureRan: true,
    azureError: out.azure_error,
    azureDeleteConfirmed: out.azure_delete_confirmed,
  });
  const blob = JSON.stringify({ http, logs });
  assert.ok(!blob.includes(ROUTING_OK));
  assert.ok(!blob.includes(ACCOUNT));
  assert.ok(!blob.includes(KEY));
  assert.ok(!blob.includes(ENDPOINT));
  assert.ok(!blob.includes(RESULT));
  assert.ok(!blob.includes(PAYEE));
});

test('prepare failure skips Azure and forces review', async () => {
  const original = jpegWithSof({ width: 320, height: 200, extraBytes: 4_000 });
  const before = sha256(original);
  let posts = 0;
  let textractBytes = null;
  const out = await extractCheck({
    imageBytes: original,
    secretLoader: async () => ({ endpoint: ENDPOINT, api_key: KEY }),
    textractSend: async (cmd) => {
      textractBytes = cmd?.input?.Document?.Bytes ?? cmd?.Document?.Bytes;
      return textractBlocks();
    },
    fetchImpl: async () => {
      posts += 1;
      return { status: 500, headers: { get: () => null }, text: async () => '' };
    },
    sleep: async () => {},
    now: () => 0,
    prepareOpts: { targetMaxBytes: 100 },
  });
  assert.equal(posts, 0);
  assert.equal(sha256(original), before);
  assert.equal(sha256(textractBytes), before);
  assert.equal(out.azure_error, AZURE_OCR_UNUSABLE);
  assert.equal(out.canonical.micr_engine, 'none');
  assert.equal(out.canonical.micr_routing_state, 'MISSING');
  assert.equal(out.canonical.micr_account_state, 'MISSING');
  assert.equal(out.canonical.needs_manual_review, true);
  assert.equal(out.azure_delete_confirmed, false);
});

test('under-4MB proven path still sends the original Buffer to Azure', async () => {
  const original = Buffer.from('png');
  const capture = {};
  const out = await extractCheck({
    imageBytes: original,
    secretLoader: async () => ({ endpoint: ENDPOINT, api_key: KEY }),
    textractSend: async () => textractBlocks(),
    fetchImpl: azureSuccessFetch(capture),
    sleep: async () => {},
    now: () => 0,
  });
  assert.equal(capture.posts, 1);
  assert.equal(sha256(capture.azureBytes), sha256(original));
  assert.equal(out.canonical.micr_routing_state, 'VERIFIED');
  assert.equal(out.azure_delete_confirmed, true);
});

test('intake redaction still hides banking and Azure identifiers after prepare', () => {
  const out = redactOcrIntakeResponse({
    parsed: {
      routing_number: ROUTING_OK,
      account_number: ACCOUNT,
      micr_check_number: CHECK,
      payee_line: PAYEE,
      micr_engine: 'azure_prebuilt_check_us',
      micr_routing_state: 'VERIFIED',
      micr_account_state: 'VERIFIED',
      micr_check_state: 'VERIFIED',
      needs_manual_review: false,
    },
    azureRan: true,
    azureError: null,
    azureDeleteConfirmed: true,
  });
  const blob = JSON.stringify(out);
  assert.ok(!blob.includes(ROUTING_OK));
  assert.ok(!blob.includes(ACCOUNT));
  assert.ok(!blob.includes(CHECK));
  assert.ok(!blob.includes(PAYEE));
  assert.equal(redactOcrLog({ routing_number: ROUTING_OK }).routing_number, '[redacted]');
});

test('implementation does not persist derivatives to S3 or /tmp', () => {
  const prep = readFileSync(PREP_SRC, 'utf8');
  const provider = readFileSync(PROVIDER_SRC, 'utf8');
  assert.doesNotMatch(prep, /writeFile|createWriteStream|PutObject|from 'node:fs'|from 'fs'/);
  assert.doesNotMatch(provider, /PutObject|writeFile|from 'node:fs'|from 'fs'/);
});
