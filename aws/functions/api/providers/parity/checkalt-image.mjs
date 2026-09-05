/**
 * CheckAlt image preparation.
 *
 * Known-good Lovable path (CheckCommandCenter / DepositOperationsConsole):
 *   prepareCheckAltDeposit → browser-image-compression + canvas ensureLandscape
 *   then checkalt-submit-deposit downloads those bytes and Base64-encodes them
 *   with NO second re-encode.
 *
 * The ImageScript edge function (checkalt-prepare-image) is only a fallback
 * when browser prep cannot run. AWS previously ported that fallback and used
 * it as the primary path. That is not the production happy path.
 *
 * Default AWS prep (`prepareLikeLovableBrowser` / `normalizeToBudget`) follows
 * the browser control flow: EXIF-aware dimensions, already-good pass-through,
 * 90° CW landscape fix, 1600px cap, quality 0.80→0.62→0.50→0.38, never shrink
 * below the 1300px DPI floor.
 *
 * `normalizeToBudgetImageScript` is retained only so we can A/B the old AWS
 * port against the known-good path. Do not use it for submit/prepare.
 */
import { createHash } from 'node:crypto';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import sharp from 'sharp';

export const TARGET_MAX_DIM = 1600;
export const TARGET_JPEG_QUALITY = 78;
export const MIN_DIM = 1300;
export const MIN_ACCEPTABLE_DIM = 1300;
export const MIN_QUALITY = 35;
export const PER_IMAGE_BYTES_BUDGET = 450_000;
export const LANDSCAPE_JPEG_QUALITY = 92;
export const BROWSER_QUALITY_LADDER = [80, 62, 50, 38];

export const isRasterPath = (path) =>
  !!path && /\.(jpe?g|png|webp)(\?|$)/i.test(String(path));

export const toDepositPath = (path) => {
  const raw = String(path || '');
  if (/\.(jpe?g|png|webp|svg)$/i.test(raw)) {
    return raw.replace(/\.(jpe?g|png|webp|svg)$/i, '.deposit2.jpg');
  }
  return `${raw}.deposit2.jpg`;
};

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const asBuffer = (bytes) => (Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));

export const isJpegMagic = (bytes) => {
  const buf = asBuffer(bytes);
  return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8;
};

const decodeRaster = (bytes) => {
  const buf = asBuffer(bytes);
  if (isJpegMagic(buf)) {
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

const resizeNearest = (img, newW, newH) => {
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

export const inspectStoredRaster = (bytes) => {
  const img = decodeRaster(bytes);
  return {
    width: img.width,
    height: img.height,
    bytes: Buffer.byteLength(bytes),
    landscape: img.width >= img.height,
    jpeg: isJpegMagic(bytes),
  };
};

/** Stored-pixel inspect (no EXIF). Kept for ImageScript A/B. */
export const inspectImage = (bytes) => inspectStoredRaster(bytes);

const orientedDims = (width, height, orientation) => {
  const o = Number(orientation || 1);
  if (o >= 5 && o <= 8) return { width: height, height: width };
  return { width, height };
};

/**
 * EXIF-aware dimensions, matching `createImageBitmap` used by
 * src/lib/checkImageOrient.ts and src/lib/prepareCheckAltDeposit.ts.
 */
export async function inspectOriented(bytes) {
  const buf = asBuffer(bytes);
  const meta = await sharp(buf, { failOn: 'none' }).metadata();
  const dims = orientedDims(meta.width || 0, meta.height || 0, meta.orientation);
  return {
    width: dims.width,
    height: dims.height,
    storedWidth: meta.width || 0,
    storedHeight: meta.height || 0,
    orientation: meta.orientation || 1,
    format: meta.format || null,
    bytes: buf.length,
    landscape: dims.width >= dims.height,
    jpeg: meta.format === 'jpeg' || isJpegMagic(buf),
  };
}

export function isAlreadyDepositReady(info) {
  return Boolean(
    info
    && info.jpeg
    && info.bytes > 0
    && info.bytes <= PER_IMAGE_BYTES_BUDGET
    && info.width >= info.height
    && Math.max(info.width, info.height) >= MIN_ACCEPTABLE_DIM,
  );
}

export function isReusablePreparedCache(info) {
  return Boolean(
    info
    && info.bytes > 0
    && info.bytes <= PER_IMAGE_BYTES_BUDGET
    && info.width >= info.height
    && Math.max(info.width, info.height) >= MIN_ACCEPTABLE_DIM,
  );
}

/**
 * Node equivalent of src/lib/prepareCheckAltDeposit.ts compressForDeposit
 * + ensureLandscape. Not byte-identical to a specific browser encoder, but
 * the same control flow, quality ladder, and pass-through rules.
 */
export async function prepareLikeLovableBrowser(bytes, label = 'image') {
  const source = asBuffer(bytes);
  const info = await inspectOriented(source);
  if (isAlreadyDepositReady(info)) return Buffer.from(source);

  const oriented = await sharp(source, { failOn: 'none' }).rotate().toBuffer({ resolveWithObject: true });
  let working = oriented.data;
  let width = oriented.info.width;
  let height = oriented.info.height;

  if (height > width) {
    const rotated = await sharp(working)
      .rotate(90)
      .jpeg({ quality: LANDSCAPE_JPEG_QUALITY, chromaSubsampling: '4:2:0', mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    working = rotated.data;
    width = rotated.info.width;
    height = rotated.info.height;
  }

  const longest = Math.max(width, height);
  if (longest > TARGET_MAX_DIM) {
    working = await sharp(working)
      .resize({
        width: TARGET_MAX_DIM,
        height: TARGET_MAX_DIM,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .toBuffer();
  }

  let last = working;
  for (const quality of BROWSER_QUALITY_LADDER) {
    last = await sharp(working).jpeg({
      quality,
      chromaSubsampling: '4:2:0',
      mozjpeg: true,
    }).toBuffer();
    if (last.length <= PER_IMAGE_BYTES_BUDGET) return last;
  }

  throw new Error(`${label} image is still too large after browser compression`);
}

/** Default AWS prep = known-good Lovable browser path, not ImageScript. */
export const normalizeToBudget = async (bytes, label = 'image') =>
  prepareLikeLovableBrowser(bytes, label);

/**
 * Faithful port of supabase/functions/checkalt-prepare-image ImageScript loop.
 * Not the known-good production path. Used only for offline A/B evidence.
 */
export const normalizeToBudgetImageScript = (bytes, label = 'image') => {
  let img = decodeRaster(bytes);
  const wasPortrait = img.height > img.width;
  if (wasPortrait) img = rotate90Cw(img);

  const sourceLen = Buffer.byteLength(bytes);
  const withinBudget = sourceLen <= PER_IMAGE_BYTES_BUDGET;
  const bigEnough = Math.max(img.width, img.height) >= MIN_DIM;
  if (!wasPortrait && withinBudget && bigEnough) {
    return Buffer.from(bytes);
  }

  let quality = TARGET_JPEG_QUALITY;
  const longest = Math.max(img.width, img.height);
  if (longest > TARGET_MAX_DIM) {
    const scale = TARGET_MAX_DIM / longest;
    img = resizeNearest(img, Math.round(img.width * scale), Math.round(img.height * scale));
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
      img = resizeNearest(img, Math.round(img.width * scale), Math.round(img.height * scale));
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

export async function comparePrepPipelines(bytes, label = 'image') {
  const source = asBuffer(bytes);
  const browser = await prepareLikeLovableBrowser(source, label);
  const imageScript = normalizeToBudgetImageScript(source, label);
  const oriented = await inspectOriented(source);
  return {
    label,
    sourceBytes: source.length,
    sourceSha256: sha256(source),
    sourceJpeg: oriented.jpeg,
    sourceFormat: oriented.format,
    sourceOriented: { width: oriented.width, height: oriented.height, orientation: oriented.orientation, landscape: oriented.landscape },
    alreadyGood: isAlreadyDepositReady(oriented),
    browserBytes: browser.length,
    browserSha256: sha256(browser),
    imageScriptBytes: imageScript.length,
    imageScriptSha256: sha256(imageScript),
    browserVsSourceIdentical: Buffer.compare(browser, source) === 0,
    browserVsImageScriptIdentical: Buffer.compare(browser, imageScript) === 0,
    imageScriptVsSourceIdentical: Buffer.compare(imageScript, source) === 0,
    browserB64Chars: browser.toString('base64').length,
    imageScriptB64Chars: imageScript.toString('base64').length,
  };
}

export const bytesToBase64 = (bytes) => asBuffer(bytes).toString('base64');

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

export async function syntheticJpegWithExifOrientation({ width, height, orientation = 6 } = {}) {
  const raw = syntheticCheckRaster({ width, height, flat: true });
  return sharp(raw).withMetadata({ orientation }).jpeg({ quality: 78 }).toBuffer();
}
