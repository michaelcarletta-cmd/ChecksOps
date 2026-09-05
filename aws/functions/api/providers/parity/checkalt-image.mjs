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
  ',': ['00000', '00000', '00000', '00000', '01100', '00100', '01000'],
  '/': ['00001', '00010', '00100', '01000', '10000', '00000', '00000'],
  ':': ['00000', '01100', '01100', '00000', '01100', '01100', '00000'],
  $: ['01110', '10101', '10100', '01110', '00101', '10101', '01110'],
  '&': ['01100', '10010', '10100', '01000', '10101', '10010', '01101'],
  "'": ['01100', '01100', '00100', '00000', '00000', '00000', '00000'],
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
  J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10001', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
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
  return cursor;
};

/** Soft horizontal stroke for simulated ink (signature / endorsement). */
const drawInkStroke = (img, points, thickness, rgb) => {
  for (let i = 0; i < points.length - 1; i += 1) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    const steps = Math.max(8, Math.hypot(x1 - x0, y1 - y0));
    for (let s = 0; s <= steps; s += 1) {
      const t = s / steps;
      const x = x0 + (x1 - x0) * t;
      const y = y0 + (y1 - y0) * t;
      fillRect(img, x - thickness / 2, y - thickness / 2, thickness, thickness, rgb);
    }
  }
};

/**
 * MICR-style digit glyphs (taller 7×9). Not claimed as mandatory E-13B —
 * only larger/clearer numerals for a readable bottom band on synthetic UAT.
 */
const MICR_DIGITS = {
  0: ['01110', '10001', '10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00001', '00010', '00100', '01000', '10000', '11111'],
  3: ['11110', '00001', '00001', '01110', '00001', '00001', '00001', '00001', '11110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010', '00010', '00010'],
  5: ['11111', '10000', '10000', '11110', '00001', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00010', '00100', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '10001', '01111', '00001', '00001', '00010', '01100'],
};

const drawMicrDigit = (img, digit, ox, oy, scale, rgb) => {
  const rows = MICR_DIGITS[digit] || MICR_DIGITS[0];
  for (let gy = 0; gy < 9; gy += 1) {
    for (let gx = 0; gx < 5; gx += 1) {
      if (rows[gy][gx] !== '1') continue;
      fillRect(img, ox + gx * scale, oy + gy * scale, scale, scale, rgb);
    }
  }
};

/** Transit / on-us / amount style markers — geometric stand-ins, not E-13B claims. */
const drawMicrTransit = (img, ox, oy, scale, rgb) => {
  fillRect(img, ox + scale, oy, scale * 3, scale, rgb);
  fillRect(img, ox, oy + scale * 2, scale * 5, scale, rgb);
  fillRect(img, ox + scale, oy + scale * 4, scale * 3, scale, rgb);
  fillRect(img, ox + 2 * scale, oy + scale, scale, scale * 7, rgb);
};

const drawMicrOnUs = (img, ox, oy, scale, rgb) => {
  fillRect(img, ox, oy, scale, scale * 9, rgb);
  fillRect(img, ox + scale * 4, oy, scale, scale * 9, rgb);
  fillRect(img, ox + scale, oy + scale * 4, scale * 3, scale, rgb);
};

const drawMicrAmount = (img, ox, oy, scale, rgb) => {
  fillRect(img, ox, oy, scale * 5, scale, rgb);
  fillRect(img, ox + 2 * scale, oy + scale, scale, scale * 7, rgb);
  fillRect(img, ox, oy + scale * 8, scale * 5, scale, rgb);
};

const formatSyntheticDollars = (amountCents) => {
  const cents = Math.max(0, Math.round(Number(amountCents) || 0));
  const dollars = Math.floor(cents / 100);
  const rem = cents % 100;
  return {
    cents,
    numeric: `$${dollars}.${String(rem).padStart(2, '0')}`,
    written: cents === 0
      ? 'ZERO AND 00/100'
      : (dollars === 0
        ? `ZERO AND ${String(rem).padStart(2, '0')}/100`
        : `${dollars} AND ${String(rem).padStart(2, '0')}/100`),
  };
};

/**
 * Source raster for UAT-only synthetic checks — check aspect (~6×2.75),
 * landscape, longest edge above TARGET_MAX_DIM so normalizeToBudget exercises
 * the same downscale path as production prepare-image.
 * Clearly labeled VOID / UAT-ONLY / NON-NEGOTIABLE. Not a customer instrument.
 * Fake routing/account digits only — not usable live bank numbers.
 */
export const buildSyntheticUatCheckSource = ({
  side = 'front',
  amountCents = 1,
} = {}) => {
  // ~6" × 2.75" at >1600 long-edge so prepare path resizes to TARGET_MAX_DIM.
  const width = 2200;
  const height = 1008;
  const data = Buffer.alloc(width * height * 4);
  const img = { width, height, data };
  const amount = formatSyntheticDollars(amountCents);
  // Paper background with grain + soft vignette (photo-like, still synthetic).
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const grain = ((x * 17 + y * 31) % 9) - 4;
      const nx = (x / width) * 2 - 1;
      const ny = (y / height) * 2 - 1;
      const vignette = Math.round((nx * nx + ny * ny) * 10);
      data[i] = Math.max(0, Math.min(255, 232 + grain - vignette));
      data[i + 1] = Math.max(0, Math.min(255, 236 + grain - vignette));
      data[i + 2] = Math.max(0, Math.min(255, 242 + grain - vignette));
      data[i + 3] = 255;
    }
  }
  // Outer border + corner blocks (edge/corner detection aids).
  fillRect(img, 10, 10, width - 20, 8, [25, 25, 25]);
  fillRect(img, 10, height - 18, width - 20, 8, [25, 25, 25]);
  fillRect(img, 10, 10, 8, height - 20, [25, 25, 25]);
  fillRect(img, width - 18, 10, 8, height - 20, [25, 25, 25]);
  fillRect(img, 24, 24, 42, 42, [30, 30, 30]);
  fillRect(img, width - 66, 24, 42, 42, [30, 30, 30]);
  fillRect(img, 24, height - 66, 42, 42, [30, 30, 30]);
  fillRect(img, width - 66, height - 66, 42, 42, [30, 30, 30]);

  if (side === 'rear') {
    fillRect(img, 70, 90, width - 140, 6, [45, 45, 45]);
    drawText(img, 'ENDORSE HERE', 90, 120, 5, [50, 50, 50]);
    drawText(img, 'FOR DEPOSIT ONLY', 90, 200, 6, [20, 20, 20]);
    drawText(img, 'UAT ONLY - NON-NEGOTIABLE', 90, 290, 4, [130, 25, 25]);
    // Simulated handwritten endorsement (non-customer scribble).
    drawInkStroke(img, [
      [120, 380], [220, 360], [340, 390], [480, 355], [620, 385], [760, 360], [900, 375],
    ], 5, [15, 25, 70]);
    drawInkStroke(img, [
      [140, 430], [280, 450], [420, 420], [560, 445], [700, 425],
    ], 4, [20, 30, 80]);
    drawText(img, 'VOID', 780, 520, 16, [165, 40, 40]);
    fillRect(img, 70, height - 160, width - 140, 70, [228, 228, 234]);
    drawText(img, 'AWS UAT SYNTHETIC BACK - NOT NEGOTIABLE', 90, height - 130, 4, [55, 55, 55]);
  } else {
    drawText(img, 'CHECKSOPS UAT BANK', 90, 55, 6, [25, 45, 90]);
    drawText(img, '100 UAT TEST STREET / ANYTOWN USA 00000', 90, 115, 3, [60, 60, 70]);
    drawText(img, 'UAT ONLY - NON-NEGOTIABLE - VOID', 90, 160, 4, [130, 25, 25]);
    drawText(img, 'DATE', width - 520, 55, 3, [50, 50, 50]);
    fillRect(img, width - 420, 95, 300, 3, [30, 30, 30]);
    drawText(img, '09/04/2026', width - 400, 55, 4, [20, 20, 20]);
    drawText(img, 'PAY TO THE ORDER OF', 90, 240, 3, [40, 40, 40]);
    fillRect(img, 90, 290, 1100, 4, [30, 30, 30]);
    drawText(img, 'FREEDOM ADJUSTMENT UAT', 90, 310, 5, [25, 25, 25]);
    // Numeric amount box — must match userAmount cents.
    fillRect(img, width - 480, 220, 360, 110, [255, 255, 255]);
    fillRect(img, width - 480, 220, 360, 5, [20, 20, 20]);
    fillRect(img, width - 480, 325, 360, 5, [20, 20, 20]);
    fillRect(img, width - 480, 220, 5, 110, [20, 20, 20]);
    fillRect(img, width - 125, 220, 5, 110, [20, 20, 20]);
    drawText(img, amount.numeric, width - 430, 255, 7, [10, 10, 10]);
    // Written / legal amount line consistent with numeric + userAmount.
    drawText(img, amount.written, 90, 400, 4, [20, 20, 20]);
    fillRect(img, 90, 450, 1400, 3, [30, 30, 30]);
    drawText(img, 'DOLLARS', 1520, 410, 3, [50, 50, 50]);
    drawText(img, 'MEMO', 90, 500, 3, [50, 50, 50]);
    fillRect(img, 200, 530, 700, 3, [40, 40, 40]);
    drawText(img, 'AWS UAT SYNTHETIC', 210, 490, 3, [40, 40, 40]);
    drawText(img, 'AUTHORIZED SIGNATURE', width - 620, 500, 3, [50, 50, 50]);
    fillRect(img, width - 620, 560, 480, 3, [40, 40, 40]);
    drawInkStroke(img, [
      [width - 580, 540], [width - 500, 520], [width - 400, 545], [width - 300, 515], [width - 200, 535],
    ], 4, [20, 30, 80]);
    drawText(img, 'VOID', 820, 580, 18, [170, 40, 40]);
    // MICR clear band + synthetic routing/account/check (all zeros / UAT-only).
    fillRect(img, 50, height - 150, width - 100, 95, [252, 252, 252]);
    const micrY = height - 125;
    const micrScale = 5;
    const micrRgb = [12, 12, 12];
    let mx = 80;
    drawMicrTransit(img, mx, micrY, micrScale, micrRgb);
    mx += 7 * micrScale;
    for (const d of '000000000') {
      drawMicrDigit(img, d, mx, micrY, micrScale, micrRgb);
      mx += 6 * micrScale;
    }
    drawMicrTransit(img, mx, micrY, micrScale, micrRgb);
    mx += 8 * micrScale;
    for (const d of '0000000000') {
      drawMicrDigit(img, d, mx, micrY, micrScale, micrRgb);
      mx += 6 * micrScale;
    }
    drawMicrOnUs(img, mx, micrY, micrScale, micrRgb);
    mx += 8 * micrScale;
    for (const d of '0001') {
      drawMicrDigit(img, d, mx, micrY, micrScale, micrRgb);
      mx += 6 * micrScale;
    }
    mx += 4 * micrScale;
    drawMicrAmount(img, mx, micrY, micrScale, micrRgb);
    mx += 7 * micrScale;
    for (const d of String(amount.cents).padStart(4, '0').slice(-4)) {
      drawMicrDigit(img, d, mx, micrY, micrScale, micrRgb);
      mx += 6 * micrScale;
    }
  }
  // High-quality source JPEG; production prepare path still re-encodes.
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
 * amountCents drives numeric + written amounts on the front image so they
 * stay consistent with CheckAlt userAmount (integer cents).
 */
export const prepareSyntheticUatDepositImages = ({ amountCents = 1 } = {}) => {
  const frontSource = buildSyntheticUatCheckSource({ side: 'front', amountCents });
  const rearSource = buildSyntheticUatCheckSource({ side: 'rear', amountCents });
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
    amountCents: Math.max(0, Math.round(Number(amountCents) || 0)),
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
