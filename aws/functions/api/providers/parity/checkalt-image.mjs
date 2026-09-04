/**
 * Node port of supabase/functions/checkalt-prepare-image ImageScript pipeline.
 * Constants and loop match production: landscape first, 1600px, JPEG 78→35,
 * then shrink ×0.8 down to MIN_DIM 1300, 450KB per-image budget.
 */
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

export const TARGET_MAX_DIM = 1600;
export const TARGET_JPEG_QUALITY = 78;
export const MIN_DIM = 1300;
export const MIN_QUALITY = 35;
export const PER_IMAGE_BYTES_BUDGET = 450_000;

export const toDepositPath = (path) => {
  const raw = String(path || '');
  if (/\.(jpe?g|png|webp|svg)$/i.test(raw)) {
    return raw.replace(/\.(jpe?g|png|webp|svg)$/i, '.deposit2.jpg');
  }
  return `${raw}.deposit2.jpg`;
};

const decodeRaster = (bytes) => {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8) {
    const decoded = jpeg.decode(buf, { maxMemoryUsageInMB: 128 });
    return { width: decoded.width, height: decoded.height, data: Buffer.from(decoded.data) };
  }
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50) {
    const png = PNG.sync.read(buf);
    return { width: png.width, height: png.height, data: Buffer.from(png.data) };
  }
  throw new Error('Unsupported image format. Reupload that side as a clear JPEG/PNG image.');
};

const rotate90Cw = (img) => {
  const { width, height, data } = img;
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const src = (y * width + x) * 4;
      const nx = height - 1 - y;
      const ny = x;
      const dst = (ny * height + nx) * 4;
      data.copy(out, dst, src, src + 4);
    }
  }
  return { width: height, height: width, data: out };
};

const resize = (img, newW, newH) => {
  const out = Buffer.alloc(newW * newH * 4);
  for (let y = 0; y < newH; y += 1) {
    const srcY = Math.min(img.height - 1, Math.round((y + 0.5) * img.height / newH - 0.5));
    for (let x = 0; x < newW; x += 1) {
      const srcX = Math.min(img.width - 1, Math.round((x + 0.5) * img.width / newW - 0.5));
      const src = (srcY * img.width + srcX) * 4;
      const dst = (y * newW + x) * 4;
      img.data.copy(out, dst, src, src + 4);
    }
  }
  return { width: newW, height: newH, data: out };
};

const encodeJpeg = (img, quality) => jpeg.encode({
  data: img.data,
  width: img.width,
  height: img.height,
}, quality).data;

export const inspectImage = (bytes) => {
  const img = decodeRaster(bytes);
  return {
    width: img.width,
    height: img.height,
    bytes: Buffer.byteLength(bytes),
    landscape: img.width >= img.height,
  };
};

/**
 * Production normalizeToBudget. Returns JPEG bytes under PER_IMAGE_BYTES_BUDGET.
 */
export const normalizeToBudget = (bytes, label = 'image') => {
  let img = decodeRaster(bytes);
  const wasPortrait = img.height > img.width;
  if (wasPortrait) img = rotate90Cw(img);

  const sourceLen = Buffer.byteLength(bytes);
  const withinBudget = sourceLen <= PER_IMAGE_BYTES_BUDGET;
  const bigEnough = Math.max(img.width, img.height) >= MIN_DIM;
  // Production ImageScript returns the original bytes when already landscape,
  // under budget, and large enough. Do not require JPEG for that fast path.
  if (!wasPortrait && withinBudget && bigEnough) {
    return Buffer.from(bytes);
  }

  let quality = TARGET_JPEG_QUALITY;
  const longest = Math.max(img.width, img.height);
  if (longest > TARGET_MAX_DIM) {
    const scale = TARGET_MAX_DIM / longest;
    img = resize(img, Math.round(img.width * scale), Math.round(img.height * scale));
  }
  let out = encodeJpeg(img, quality);
  while (out.length > PER_IMAGE_BYTES_BUDGET) {
    if (quality > MIN_QUALITY) {
      quality = Math.max(MIN_QUALITY, quality - 10);
    } else {
      const newLongest = Math.max(img.width, img.height);
      if (newLongest <= MIN_DIM) break;
      const nextDim = Math.max(MIN_DIM, Math.round(newLongest * 0.8));
      const scale = nextDim / newLongest;
      img = resize(img, Math.round(img.width * scale), Math.round(img.height * scale));
    }
    out = encodeJpeg(img, quality);
  }
  if (out.length > PER_IMAGE_BYTES_BUDGET) {
    throw new Error(
      `${label} could not be compressed below ${Math.round(PER_IMAGE_BYTES_BUDGET / 1024)}KB.`,
    );
  }
  return Buffer.from(out);
};

/** Synthetic non-negotiable raster for tests. Not a customer check. */
export const syntheticCheckRaster = ({ width, height, seed = 40, flat = false } = {}) => {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      if (flat) {
        data[i] = 240;
        data[i + 1] = 240;
        data[i + 2] = 245;
        data[i + 3] = 255;
      } else {
        data[i] = (x + seed) % 256;
        data[i + 1] = (y + seed) % 256;
        data[i + 2] = 180;
        data[i + 3] = 255;
      }
    }
  }
  return encodeJpeg({ width, height, data }, flat ? 78 : 95);
};

export const syntheticCheckPng = ({ width, height } = {}) => {
  const png = new PNG({ width, height });
  png.data.fill(200);
  return PNG.sync.write(png);
};

/** 5×7 bitmap glyphs for synthetic UAT check labels (A–Z, 0–9, space, punctuation). */
const GLYPHS = {
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  '/': ['00001', '00010', '00100', '01000', '10000', '00000', '00000'],
  $: ['01110', '10101', '10100', '01110', '00101', '10101', '01110'],
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11100', '10010', '10001', '10001', '10001', '10010', '11100'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01110'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10001', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10001', '10101', '11011', '10001'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
};

const fillRect = (img, x0, y0, w, h, rgb) => {
  const [r, g, b] = rgb;
  const x1 = Math.min(img.width, Math.max(0, Math.round(x0)));
  const y1 = Math.min(img.height, Math.max(0, Math.round(y0)));
  const x2 = Math.min(img.width, Math.max(0, Math.round(x0 + w)));
  const y2 = Math.min(img.height, Math.max(0, Math.round(y0 + h)));
  for (let y = y1; y < y2; y += 1) {
    for (let x = x1; x < x2; x += 1) {
      const i = (y * img.width + x) * 4;
      img.data[i] = r;
      img.data[i + 1] = g;
      img.data[i + 2] = b;
      img.data[i + 3] = 255;
    }
  }
};

const drawGlyph = (img, ch, ox, oy, scale, rgb) => {
  const rows = GLYPHS[ch] || GLYPHS[' '];
  for (let gy = 0; gy < 7; gy += 1) {
    for (let gx = 0; gx < 5; gx += 1) {
      if (rows[gy][gx] !== '1') continue;
      fillRect(img, ox + gx * scale, oy + gy * scale, scale, scale, rgb);
    }
  }
};

const drawText = (img, text, x, y, scale, rgb) => {
  const upper = String(text || '').toUpperCase();
  let cursor = x;
  for (const ch of upper) {
    drawGlyph(img, ch, cursor, y, scale, rgb);
    cursor += 6 * scale;
  }
};

/**
 * Source raster for UAT-only synthetic checks — check aspect (~6×2.75),
 * landscape, longest edge above TARGET_MAX_DIM so normalizeToBudget exercises
 * the same downscale path as production prepare-image.
 * Clearly labeled VOID / UAT-ONLY / NON-NEGOTIABLE. Not a customer instrument.
 */
export const buildSyntheticUatCheckSource = ({ side = 'front' } = {}) => {
  // ~6" × 2.75" at >1600 long-edge so prepare path resizes to TARGET_MAX_DIM.
  const width = 1920;
  const height = 880;
  const data = Buffer.alloc(width * height * 4);
  const img = { width, height, data };
  // Paper background with slight grain (avoids flat-field IQA rejects).
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const grain = ((x * 17 + y * 31) % 7) - 3;
      data[i] = Math.max(0, Math.min(255, 236 + grain));
      data[i + 1] = Math.max(0, Math.min(255, 240 + grain));
      data[i + 2] = Math.max(0, Math.min(255, 245 + grain));
      data[i + 3] = 255;
    }
  }
  // Outer border + corner blocks (Mitek corner detection).
  fillRect(img, 8, 8, width - 16, 6, [20, 20, 20]);
  fillRect(img, 8, height - 14, width - 16, 6, [20, 20, 20]);
  fillRect(img, 8, 8, 6, height - 16, [20, 20, 20]);
  fillRect(img, width - 14, 8, 6, height - 16, [20, 20, 20]);
  fillRect(img, 20, 20, 48, 48, [30, 30, 30]);
  fillRect(img, width - 68, 20, 48, 48, [30, 30, 30]);
  fillRect(img, 20, height - 68, 48, 48, [30, 30, 30]);
  fillRect(img, width - 68, height - 68, 48, 48, [30, 30, 30]);

  if (side === 'rear') {
    fillRect(img, 60, 80, width - 120, 8, [40, 40, 40]);
    drawText(img, 'ENDORSE HERE', 80, 110, 4, [40, 40, 40]);
    drawText(img, 'FOR DEPOSIT ONLY', 80, 180, 5, [20, 20, 20]);
    drawText(img, 'UAT ONLY - NON-NEGOTIABLE', 80, 260, 4, [120, 20, 20]);
    drawText(img, 'VOID', 700, 360, 14, [160, 40, 40]);
    fillRect(img, 60, height - 140, width - 120, 60, [230, 230, 235]);
    drawText(img, 'AWS UAT SYNTHETIC BACK', 80, height - 120, 3, [60, 60, 60]);
  } else {
    drawText(img, 'CHECKSOPS UAT BANK', 80, 50, 5, [25, 45, 90]);
    drawText(img, 'UAT ONLY - NON-NEGOTIABLE', 80, 110, 3, [120, 20, 20]);
    drawText(img, 'PAY TO THE ORDER OF', 80, 220, 3, [40, 40, 40]);
    fillRect(img, 80, 260, 900, 4, [30, 30, 30]);
    drawText(img, 'FREEDOM ADJUSTMENT UAT', 80, 280, 4, [30, 30, 30]);
    // Amount box — cents match sandbox userAmount=1 ($0.01).
    fillRect(img, width - 420, 200, 320, 100, [255, 255, 255]);
    fillRect(img, width - 420, 200, 320, 4, [20, 20, 20]);
    fillRect(img, width - 420, 296, 320, 4, [20, 20, 20]);
    fillRect(img, width - 420, 200, 4, 100, [20, 20, 20]);
    fillRect(img, width - 104, 200, 4, 100, [20, 20, 20]);
    drawText(img, '$ 0.01', width - 380, 230, 6, [10, 10, 10]);
    drawText(img, 'VOID', 620, 380, 16, [170, 40, 40]);
    // MICR-like clear band + synthetic routing/account digits (non-live).
    fillRect(img, 40, height - 120, width - 80, 70, [250, 250, 250]);
    drawText(img, 'A000000000A 0000000000C 0001', 60, height - 100, 4, [15, 15, 15]);
  }
  return encodeJpeg(img, 92);
};

/**
 * Browser compressForDeposit / compressCheckImage equivalent:
 * landscape + longest edge ≤ TARGET_MAX_DIM (1600) + JPEG ~q80.
 * Production always runs this before prepare-image / submit.
 */
export const browserCapToDepositTarget = (bytes) => {
  let img = decodeRaster(bytes);
  if (img.height > img.width) img = rotate90Cw(img);
  const longest = Math.max(img.width, img.height);
  if (longest > TARGET_MAX_DIM) {
    const scale = TARGET_MAX_DIM / longest;
    img = resize(img, Math.round(img.width * scale), Math.round(img.height * scale));
  }
  return Buffer.from(encodeJpeg(img, 80));
};

/**
 * Production prepare path for UAT sandbox deposits:
 * synthetic source → browserCapToDepositTarget (1600) → normalizeToBudget
 * (landscape, JPEG 78→35, MIN_DIM 1300, 450KB) → raw base64 (no data-URI).
 */
export const prepareSyntheticUatDepositImages = () => {
  const frontSource = buildSyntheticUatCheckSource({ side: 'front' });
  const rearSource = buildSyntheticUatCheckSource({ side: 'rear' });
  const frontCapped = browserCapToDepositTarget(frontSource);
  const rearCapped = browserCapToDepositTarget(rearSource);
  const frontBytes = normalizeToBudget(frontCapped, 'front');
  const rearBytes = normalizeToBudget(rearCapped, 'rear');
  const frontInfo = inspectImage(frontBytes);
  const rearInfo = inspectImage(rearBytes);
  if (!frontInfo.landscape || !rearInfo.landscape) {
    throw new Error('Synthetic UAT check images must be landscape after prepare');
  }
  if (Math.max(frontInfo.width, frontInfo.height) < MIN_DIM
    || Math.max(rearInfo.width, rearInfo.height) < MIN_DIM) {
    throw new Error(`Synthetic UAT check images must be >= ${MIN_DIM}px after prepare`);
  }
  if (Math.max(frontInfo.width, frontInfo.height) > TARGET_MAX_DIM
    || Math.max(rearInfo.width, rearInfo.height) > TARGET_MAX_DIM) {
    throw new Error(`Synthetic UAT check images must be <= ${TARGET_MAX_DIM}px after prepare`);
  }
  if (frontBytes.length > PER_IMAGE_BYTES_BUDGET || rearBytes.length > PER_IMAGE_BYTES_BUDGET) {
    throw new Error('Synthetic UAT check images exceed 450KB budget after prepare');
  }
  const frontImage = frontBytes.toString('base64');
  const rearImage = rearBytes.toString('base64');
  if (frontImage.startsWith('data:') || rearImage.startsWith('data:')) {
    throw new Error('CheckAlt images must be raw base64 without data-URI prefix');
  }
  const totalB64 = frontImage.length + rearImage.length;
  if (totalB64 > 1_600_000) {
    throw new Error('Combined synthetic UAT images exceed CheckAlt base64 payload limit');
  }
  return {
    frontImage,
    rearImage,
    frontInfo: { ...frontInfo, preparedBytes: frontBytes.length },
    rearInfo: { ...rearInfo, preparedBytes: rearBytes.length },
    imageKind: 'synthetic_uat_via_prepare_pipeline',
    pipeline: {
      source: 'buildSyntheticUatCheckSource',
      browserCap: 'browserCapToDepositTarget',
      prepare: 'normalizeToBudget',
      targetMaxDim: TARGET_MAX_DIM,
      minDim: MIN_DIM,
      targetJpegQuality: TARGET_JPEG_QUALITY,
      perImageBytesBudget: PER_IMAGE_BYTES_BUDGET,
      maxTotalB64Chars: 1_600_000,
    },
  };
};
