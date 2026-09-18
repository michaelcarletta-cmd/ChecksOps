/**
 * In-memory Azure OCR image preparation.
 * Reuses CheckAlt raster primitives. Never writes S3 or temp files.
 * Original caller Buffer is never mutated on the passthrough path.
 */
import { redactOcrLog } from './azure-check-ocr.mjs';
import {
  applyExifOrientation,
  decodeRaster,
  encodeJpeg,
  isJpegMagic,
  readJpegExifOrientation,
  resizeBilinear,
  rotate90Cw,
} from './providers/parity/checkalt-image.mjs';

export const AZURE_OCR_TARGET_MAX_BYTES = Math.floor(3.5 * 1024 * 1024);
export const AZURE_OCR_HARD_MAX_BYTES = 4 * 1024 * 1024;
export const AZURE_OCR_MAX_PIXELS = 25_000_000;
export const AZURE_OCR_MAX_DIMENSION = 10_000;
export const AZURE_OCR_MIN_LONG_EDGE = 1600;
export const AZURE_OCR_FIRST_LONG_EDGE = 4000;
export const AZURE_OCR_QUALITY_LADDER = Object.freeze([85, 80, 75, 70]);
export const AZURE_OCR_MIN_QUALITY = 50;
export const AZURE_OCR_PREPARE_TIMEOUT_MS = 8_000;
export const AZURE_OCR_SCALE_STEP = 0.85;
export const AZURE_OCR_UNUSABLE = 'azure_image_unusable';

const isPngMagic = (bytes) => (
  bytes
  && bytes.length >= 8
  && bytes[0] === 0x89
  && bytes[1] === 0x50
  && bytes[2] === 0x4e
  && bytes[3] === 0x47
);

export const readJpegDimensions = (bytes) => {
  if (!isJpegMagic(bytes) || bytes.length < 10) return null;
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    const size = bytes.readUInt16BE(offset + 2);
    if (size < 2 || offset + 2 + size > bytes.length) return null;
    const isSof = (marker >= 0xc0 && marker <= 0xc3)
      || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb)
      || (marker >= 0xcd && marker <= 0xcf);
    if (isSof) {
      const height = bytes.readUInt16BE(offset + 5);
      const width = bytes.readUInt16BE(offset + 7);
      if (width < 1 || height < 1) return null;
      return { width, height };
    }
    if (marker === 0xda) break;
    offset += 2 + size;
  }
  return null;
};

export const readPngDimensions = (bytes) => {
  if (!isPngMagic(bytes) || bytes.length < 24) return null;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1) return null;
  return { width, height };
};

const emitPrepareLog = (log, entry) => {
  if (typeof log !== 'function') return;
  log(redactOcrLog({
    event: 'azure_image_prepare',
    ok: entry.ok ?? null,
    code: entry.code || null,
    transformed: Boolean(entry.transformed),
    input_bytes: Number.isFinite(entry.input_bytes) ? entry.input_bytes : null,
    output_bytes: Number.isFinite(entry.output_bytes) ? entry.output_bytes : null,
    width: Number.isFinite(entry.width) ? entry.width : null,
    height: Number.isFinite(entry.height) ? entry.height : null,
    ms: Number.isFinite(entry.ms) ? entry.ms : null,
  }));
};

const fail = ({
  log,
  started,
  now,
  inputBytes,
  width = null,
  height = null,
  code = AZURE_OCR_UNUSABLE,
}) => {
  const result = {
    ok: false,
    code,
    bytes: null,
    transformed: false,
    input_bytes: inputBytes,
    output_bytes: null,
    width,
    height,
    ms: now() - started,
  };
  emitPrepareLog(log, result);
  return result;
};

const succeed = ({
  log,
  started,
  now,
  bytes,
  transformed,
  inputBytes,
  width,
  height,
  code,
}) => {
  const result = {
    ok: true,
    code,
    bytes,
    transformed,
    input_bytes: inputBytes,
    output_bytes: bytes.length,
    width,
    height,
    ms: now() - started,
  };
  emitPrepareLog(log, result);
  return result;
};

const withinBudget = (bytes, target, hard) => (
  bytes
  && bytes.length > 0
  && bytes.length <= target
  && bytes.length <= hard
);

export const prepareAzureOcrImage = async (imageBytes, opts = {}) => {
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const started = now();
  const target = Number.isFinite(opts.targetMaxBytes) ? opts.targetMaxBytes : AZURE_OCR_TARGET_MAX_BYTES;
  const hard = Number.isFinite(opts.hardMaxBytes) ? opts.hardMaxBytes : AZURE_OCR_HARD_MAX_BYTES;
  const timeoutMs = Number.isFinite(opts.prepareTimeoutMs)
    ? opts.prepareTimeoutMs
    : AZURE_OCR_PREPARE_TIMEOUT_MS;
  const maxPixels = Number.isFinite(opts.maxPixels) ? opts.maxPixels : AZURE_OCR_MAX_PIXELS;
  const maxDim = Number.isFinite(opts.maxDimension) ? opts.maxDimension : AZURE_OCR_MAX_DIMENSION;
  const minLong = Number.isFinite(opts.minLongEdge) ? opts.minLongEdge : AZURE_OCR_MIN_LONG_EDGE;
  const firstLong = Number.isFinite(opts.firstLongEdge) ? opts.firstLongEdge : AZURE_OCR_FIRST_LONG_EDGE;
  const qualities = Array.isArray(opts.qualityLadder) && opts.qualityLadder.length
    ? opts.qualityLadder
    : AZURE_OCR_QUALITY_LADDER;
  const minQuality = Number.isFinite(opts.minQuality) ? opts.minQuality : AZURE_OCR_MIN_QUALITY;
  const scaleStep = Number.isFinite(opts.scaleStep) ? opts.scaleStep : AZURE_OCR_SCALE_STEP;
  const log = opts.log;

  const timedOut = () => (now() - started) > timeoutMs;

  if (Buffer.isBuffer(imageBytes) && imageBytes.length <= target) {
    return succeed({
      log,
      started,
      now,
      bytes: imageBytes,
      transformed: false,
      inputBytes: imageBytes.length,
      width: null,
      height: null,
      code: 'passthrough',
    });
  }

  const source = Buffer.isBuffer(imageBytes)
    ? imageBytes
    : Buffer.from(imageBytes || []);
  const inputBytes = source.length;
  if (!inputBytes) {
    return fail({ log, started, now, inputBytes });
  }
  if (inputBytes <= target) {
    return succeed({
      log,
      started,
      now,
      bytes: source,
      transformed: false,
      inputBytes,
      width: null,
      height: null,
      code: 'passthrough',
    });
  }

  const jpeg = isJpegMagic(source);
  const png = isPngMagic(source);
  if (!jpeg && !png) {
    return fail({ log, started, now, inputBytes });
  }

  const header = jpeg ? readJpegDimensions(source) : readPngDimensions(source);
  if (!header) {
    return fail({ log, started, now, inputBytes });
  }
  const pixels = header.width * header.height;
  if (
    pixels > maxPixels
    || header.width > maxDim
    || header.height > maxDim
  ) {
    return fail({
      log,
      started,
      now,
      inputBytes,
      width: header.width,
      height: header.height,
    });
  }

  if (timedOut()) {
    return fail({
      log,
      started,
      now,
      inputBytes,
      width: header.width,
      height: header.height,
    });
  }

  let img;
  try {
    img = decodeRaster(source);
  } catch {
    return fail({
      log,
      started,
      now,
      inputBytes,
      width: header.width,
      height: header.height,
    });
  }

  if (timedOut()) {
    return fail({
      log,
      started,
      now,
      inputBytes,
      width: img.width,
      height: img.height,
    });
  }

  const orientation = jpeg ? readJpegExifOrientation(source) : 1;
  if (orientation && orientation !== 1) {
    img = applyExifOrientation(img, orientation);
  }
  if (img.height > img.width) {
    img = rotate90Cw(img);
  }

  for (const quality of qualities) {
    if (timedOut()) {
      return fail({
        log,
        started,
        now,
        inputBytes,
        width: img.width,
        height: img.height,
      });
    }
    const encoded = encodeJpeg(img, quality);
    if (withinBudget(encoded, target, hard)) {
      return succeed({
        log,
        started,
        now,
        bytes: Buffer.from(encoded),
        transformed: true,
        inputBytes,
        width: img.width,
        height: img.height,
        code: 'ok',
      });
    }
  }

  let long = Math.max(img.width, img.height);
  if (long > firstLong) {
    const scale = firstLong / long;
    img = resizeBilinear(
      img,
      Math.max(1, Math.round(img.width * scale)),
      Math.max(1, Math.round(img.height * scale)),
    );
    long = Math.max(img.width, img.height);
  }

  while (true) {
    if (timedOut()) {
      return fail({
        log,
        started,
        now,
        inputBytes,
        width: img.width,
        height: img.height,
      });
    }
    for (const quality of qualities) {
      const encoded = encodeJpeg(img, quality);
      if (withinBudget(encoded, target, hard)) {
        return succeed({
          log,
          started,
          now,
          bytes: Buffer.from(encoded),
          transformed: true,
          inputBytes,
          width: img.width,
          height: img.height,
          code: 'ok',
        });
      }
    }
    const current = Math.max(img.width, img.height);
    if (current <= minLong) break;
    const next = Math.max(minLong, Math.round(current * scaleStep));
    if (next >= current) break;
    const scale = next / current;
    img = resizeBilinear(
      img,
      Math.max(1, Math.round(img.width * scale)),
      Math.max(1, Math.round(img.height * scale)),
    );
  }

  if (!timedOut()) {
    const encoded = encodeJpeg(img, minQuality);
    if (withinBudget(encoded, target, hard)) {
      return succeed({
        log,
        started,
        now,
        bytes: Buffer.from(encoded),
        transformed: true,
        inputBytes,
        width: img.width,
        height: img.height,
        code: 'ok',
      });
    }
  }

  return fail({
    log,
    started,
    now,
    inputBytes,
    width: img.width,
    height: img.height,
  });
};
