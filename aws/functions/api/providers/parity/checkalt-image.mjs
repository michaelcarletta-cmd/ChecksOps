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
