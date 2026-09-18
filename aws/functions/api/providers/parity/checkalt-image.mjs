/**
 * CheckAlt image preparation.
 *
 * Production architecture (A) — source of truth:
 *   Browser prepareCheckAltDeposit (canvas EXIF/orientation, 1600px, 450KB,
 *   quality 0.80→0.62→0.50→0.38) uploads prepared JPEGs (or returns an
 *   already-good original / 1200px endorsed rear after browser re-encode).
 *   AWS checkalt-submit-deposit downloads those stored bytes and Base64s them
 *   with NO second re-encode. Client-supplied frontImage/rearImage is ignored.
 *
 * Architecture B (server-side encoder clone) is not the production path and
 * must not run on submit. `prepareLikeLovableBrowser` documents browser
 * semantics for offline fixtures/tests only.
 *
 * The ImageScript edge function is a dead fallback for Command Center when a
 * raster front exists (browser failure throws). Do not use it on AWS submit.
 */
import { createHash } from 'node:crypto';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

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

export const normalizeClaimRel = (path) =>
  String(path || '').split('?')[0].replace(/^\/+/, '').trim();

export const checkImageColumnPaths = (check = {}) =>
  [
    check.front_image_path,
    check.back_image_path,
    check.back_image_deposit_path,
  ]
    .map(normalizeClaimRel)
    .filter(Boolean);

export const allowedPreparedPaths = (check = {}) => {
  const allowed = new Set();
  for (const rel of checkImageColumnPaths(check)) {
    allowed.add(rel);
    allowed.add(toDepositPath(rel));
  }
  return allowed;
};

export const isAllowedPreparedPath = (check, path) => {
  const rel = normalizeClaimRel(path);
  if (!rel) return false;
  return allowedPreparedPaths(check).has(rel);
};

/**
 * Browser prepareCheckAltDeposit path decision for a stored original.
 * `cachedDeposit2Bytes` is the sibling `.deposit2.jpg` when present.
 * Does not re-encode — returns which stored bytes Lovable would submit.
 */
export async function lovableBrowserPathDecision({
  sourcePath,
  sourceBytes,
  cachedDeposit2Bytes = null,
} = {}) {
  const rel = normalizeClaimRel(sourcePath);
  const preparedPath = rel ? toDepositPath(rel) : null;
  if (cachedDeposit2Bytes && cachedDeposit2Bytes.length) {
    const cachedInfo = await inspectOriented(cachedDeposit2Bytes);
    if (isReusablePreparedCache(cachedInfo)) {
      return {
        decision: 'reuse_cache',
        path: preparedPath,
        bytes: cachedDeposit2Bytes,
        reencoded: false,
        info: cachedInfo,
      };
    }
  }
  if (!sourceBytes || !sourceBytes.length) {
    return { decision: 'missing_source', path: null, bytes: null, reencoded: false, info: null };
  }
  const sourceInfo = await inspectOriented(sourceBytes);
  const jpegPath = /\.jpe?g(\?|$)/i.test(rel);
  if (jpegPath && isAlreadyDepositReady(sourceInfo)) {
    return {
      decision: 'passthrough_original',
      path: rel,
      bytes: sourceBytes,
      reencoded: false,
      info: sourceInfo,
    };
  }
  return {
    decision: 'browser_reencode',
    path: preparedPath,
    bytes: cachedDeposit2Bytes && cachedDeposit2Bytes.length ? cachedDeposit2Bytes : null,
    reencoded: true,
    info: sourceInfo,
    storedPreparedPresent: Boolean(cachedDeposit2Bytes && cachedDeposit2Bytes.length),
  };
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export const asBuffer = (bytes) => (Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));

export const isJpegMagic = (bytes) => {
  const buf = asBuffer(bytes);
  return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8;
};

export const decodeRaster = (bytes) => {
  const buf = asBuffer(bytes);
  if (isJpegMagic(buf)) {
    const decoded = jpeg.decode(buf, { maxMemoryUsageInMB: 512 });
    return { width: decoded.width, height: decoded.height, data: Buffer.from(decoded.data) };
  }
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50) {
    const png = PNG.sync.read(buf);
    return { width: png.width, height: png.height, data: Buffer.from(png.data) };
  }
  throw new Error('Unsupported image format. Reupload that side as a clear JPEG/PNG image.');
};

export const rotate90Cw = (img) => {
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

export const encodeJpeg = (img, quality) => jpeg.encode({
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

const rotate90Ccw = (img) => rotate90Cw(rotate90Cw(rotate90Cw(img)));

const flipH = (img) => {
  const out = Buffer.alloc(img.width * img.height * 4);
  for (let y = 0; y < img.height; y += 1) {
    for (let x = 0; x < img.width; x += 1) {
      const src = (y * img.width + x) * 4;
      const dst = (y * img.width + (img.width - 1 - x)) * 4;
      img.data.copy(out, dst, src, src + 4);
    }
  }
  return { width: img.width, height: img.height, data: out };
};

const flipV = (img) => {
  const out = Buffer.alloc(img.width * img.height * 4);
  for (let y = 0; y < img.height; y += 1) {
    const src = y * img.width * 4;
    const dst = (img.height - 1 - y) * img.width * 4;
    img.data.copy(out, dst, src, src + img.width * 4);
  }
  return { width: img.width, height: img.height, data: out };
};

export const applyExifOrientation = (img, orientation) => {
  switch (Number(orientation || 1)) {
    case 2: return flipH(img);
    case 3: return rotate90Cw(rotate90Cw(img));
    case 4: return flipV(img);
    case 5: return rotate90Cw(flipH(img));
    case 6: return rotate90Cw(img);
    case 7: return rotate90Ccw(flipH(img));
    case 8: return rotate90Ccw(img);
    default: return img;
  }
};

export const resizeBilinear = (img, newW, newH) => {
  const out = Buffer.alloc(newW * newH * 4);
  if (newW <= 1 || newH <= 1) return resizeNearest(img, newW, newH);
  const xRatio = (img.width - 1) / (newW - 1);
  const yRatio = (img.height - 1) / (newH - 1);
  for (let y = 0; y < newH; y += 1) {
    const fy = y * yRatio;
    const y0 = Math.floor(fy);
    const y1 = Math.min(img.height - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < newW; x += 1) {
      const fx = x * xRatio;
      const x0 = Math.floor(fx);
      const x1 = Math.min(img.width - 1, x0 + 1);
      const wx = fx - x0;
      const dst = (y * newW + x) * 4;
      for (let c = 0; c < 4; c += 1) {
        const p00 = img.data[(y0 * img.width + x0) * 4 + c];
        const p10 = img.data[(y0 * img.width + x1) * 4 + c];
        const p01 = img.data[(y1 * img.width + x0) * 4 + c];
        const p11 = img.data[(y1 * img.width + x1) * 4 + c];
        out[dst + c] = Math.round(
          p00 * (1 - wx) * (1 - wy) + p10 * wx * (1 - wy) + p01 * (1 - wx) * wy + p11 * wx * wy,
        );
      }
    }
  }
  return { width: newW, height: newH, data: out };
};

export function readJpegExifOrientation(bytes) {
  const buf = asBuffer(bytes);
  if (!isJpegMagic(buf)) return 1;
  let offset = 2;
  while (offset + 4 < buf.length) {
    if (buf[offset] !== 0xff) break;
    const marker = buf[offset + 1];
    if (marker === 0xda) break;
    const size = buf.readUInt16BE(offset + 2);
    if (size < 2 || offset + 2 + size > buf.length) break;
    if (marker === 0xe1 && size >= 16) {
      const start = offset + 4;
      if (buf.toString('ascii', start, start + 4) === 'Exif') {
        const tiff = start + 6;
        const le = buf.toString('ascii', tiff, tiff + 2) === 'II';
        const read16 = (p) => (le ? buf.readUInt16LE(p) : buf.readUInt16BE(p));
        const read32 = (p) => (le ? buf.readUInt32LE(p) : buf.readUInt32BE(p));
        const ifd0 = tiff + read32(tiff + 4);
        if (ifd0 + 2 < buf.length) {
          const count = read16(ifd0);
          for (let i = 0; i < count; i += 1) {
            const entry = ifd0 + 2 + i * 12;
            if (entry + 12 > buf.length) break;
            if (read16(entry) === 0x0112) {
              const value = read16(entry + 8);
              if (value >= 1 && value <= 8) return value;
            }
          }
        }
      }
    }
    offset += 2 + size;
  }
  return 1;
}

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
  const stored = decodeRaster(buf);
  const orientation = isJpegMagic(buf) ? readJpegExifOrientation(buf) : 1;
  const dims = orientedDims(stored.width, stored.height, orientation);
  return {
    width: dims.width,
    height: dims.height,
    storedWidth: stored.width,
    storedHeight: stored.height,
    orientation,
    format: isJpegMagic(buf) ? 'jpeg' : 'png',
    bytes: buf.length,
    landscape: dims.width >= dims.height,
    jpeg: isJpegMagic(buf),
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

  let img = decodeRaster(source);
  if (info.orientation && info.orientation !== 1) {
    img = applyExifOrientation(img, info.orientation);
  }
  if (img.height > img.width) img = rotate90Cw(img);

  const longest = Math.max(img.width, img.height);
  if (longest > TARGET_MAX_DIM) {
    const scale = TARGET_MAX_DIM / longest;
    img = resizeBilinear(
      img,
      Math.round(img.width * scale),
      Math.round(img.height * scale),
    );
  }

  let last = null;
  for (const quality of BROWSER_QUALITY_LADDER) {
    last = encodeJpeg(img, quality);
    if (last.length <= PER_IMAGE_BYTES_BUDGET) return Buffer.from(last);
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

export async function comparePrepPipelines(bytes, label = 'image', { skipImageScript = false } = {}) {
  const source = asBuffer(bytes);
  const browser = await prepareLikeLovableBrowser(source, label);
  const oriented = await inspectOriented(source);
  let imageScript = null;
  let imageScriptError = null;
  if (!skipImageScript) {
    try {
      imageScript = normalizeToBudgetImageScript(source, label);
    } catch (error) {
      imageScriptError = String(error?.message || error).slice(0, 180);
    }
  }
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
    browserOriented: await inspectOriented(browser).then((info) => ({
      width: info.width, height: info.height, landscape: info.landscape,
    })),
    imageScriptBytes: imageScript ? imageScript.length : null,
    imageScriptSha256: imageScript ? sha256(imageScript) : null,
    imageScriptError,
    browserVsSourceIdentical: Buffer.compare(browser, source) === 0,
    browserVsImageScriptIdentical: imageScript ? Buffer.compare(browser, imageScript) === 0 : false,
    imageScriptVsSourceIdentical: imageScript ? Buffer.compare(imageScript, source) === 0 : false,
    browserB64Chars: browser.toString('base64').length,
    imageScriptB64Chars: imageScript ? imageScript.toString('base64').length : null,
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
  const app1 = Buffer.alloc(36);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1.writeUInt16BE(34, 2);
  app1.write('Exif\0\0', 4, 6, 'ascii');
  app1.write('MM', 10, 2, 'ascii');
  app1.writeUInt16BE(0x002a, 12);
  app1.writeUInt32BE(8, 14);
  app1.writeUInt16BE(1, 18);
  app1.writeUInt16BE(0x0112, 20);
  app1.writeUInt16BE(3, 22);
  app1.writeUInt32BE(1, 24);
  app1.writeUInt16BE(orientation, 28);
  app1.writeUInt16BE(0, 30);
  app1.writeUInt32BE(0, 32);
  return Buffer.concat([raw.subarray(0, 2), app1, raw.subarray(2)]);
}
