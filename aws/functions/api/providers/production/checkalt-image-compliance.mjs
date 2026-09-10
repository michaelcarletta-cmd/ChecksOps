/**
 * Authoritative CheckAlt FinCapture RDC API image-compliance contract.
 * JPEG API path only. Do not convert to TIFF / CCITT / ICL here.
 *
 * 1920x1080 is the official API JPEG *canvas*, not a command to stretch or
 * upscale the check. Contain+pad keeps the entire check at source aspect.
 * allowUpscale=false: a 1200-wide source is accepted but is NOT enlarged.
 */
import { createHash } from 'node:crypto';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { isJpegMagic, readJpegExifOrientation } from '../parity/checkalt-image.mjs';

export const CHECKALT_IMAGE_ERROR = 'CHECKALT_IMAGE_COMPLIANCE_FAILED';

export const CHECKALT_CANVAS_WIDTH = 1920;
export const CHECKALT_CANVAS_HEIGHT = 1080;
export const CHECKALT_MIN_BYTES = 25 * 1024;
export const CHECKALT_MAX_COMPLIANT_BYTES = 300 * 1024;
export const CHECKALT_ABSOLUTE_MAX_BYTES = 1024 * 1024;
export const CHECKALT_MIN_SOURCE_LONG_EDGE = 1200;
export const CHECKALT_ARTIFACT_SUFFIX = '.checkalt.jpg';
export const CHECKALT_MIN_JPEG_QUALITY = 50;

/** Padding / canvas strategy. Change here if CheckAlt rejects contain+pad. */
export const CHECKALT_PAD = Object.freeze({
  strategy: 'contain',
  fillRgb: Object.freeze([255, 255, 255]),
  canvasWidth: CHECKALT_CANVAS_WIDTH,
  canvasHeight: CHECKALT_CANVAS_HEIGHT,
  allowUpscale: false,
});

/**
 * Output metadata policy. Camera EXIF is never fabricated.
 * JFIF/DPI write stays off until CheckAlt confirms they require it.
 */
export const CHECKALT_OUTPUT_METADATA = Object.freeze({
  writeJfifDpi: false,
  dpi: 200,
  preserveCameraExif: false,
});

/**
 * Vendor-pending switches. Conservative defaults stay in force until CheckAlt
 * answers. Do not weaken these from call sites.
 */
export const CHECKALT_VENDOR_PENDING = Object.freeze({
  canvasInterpretation: 'exact_api_jpeg_canvas',
  padStrategy: CHECKALT_PAD.strategy,
  allowUpscale: CHECKALT_PAD.allowUpscale,
  maxBytesIsHardLimit: true,
  writeJfifDpi: CHECKALT_OUTPUT_METADATA.writeJfifDpi,
  iclConversionInApiPath: false,
  objectiveReadabilityMetric: null,
});

export const CHECKALT_JPEG_QUALITY_LADDER = Object.freeze([82, 74, 66, 58, CHECKALT_MIN_JPEG_QUALITY]);

const asBuffer = (bytes) => (Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []));

export const sha256 = (bytes) => createHash('sha256').update(asBuffer(bytes)).digest('hex');

export const normalizeClaimRel = (path) =>
  String(path || '').split('?')[0].replace(/^\/+/, '').trim();

export const isCheckAltArtifactPath = (path) =>
  /\.checkalt\.jpe?g$/i.test(normalizeClaimRel(path));

export const toCheckAltPath = (path) => {
  const raw = normalizeClaimRel(path);
  if (!raw) return null;
  if (isCheckAltArtifactPath(raw)) return raw;
  if (/\.(jpe?g|png|webp|svg)$/i.test(raw)) {
    return raw.replace(/\.(jpe?g|png|webp|svg)$/i, CHECKALT_ARTIFACT_SUFFIX);
  }
  return `${raw}${CHECKALT_ARTIFACT_SUFFIX}`;
};

export const checkImageColumnPaths = (check = {}) =>
  [check.front_image_path, check.back_image_path, check.back_image_deposit_path]
    .map(normalizeClaimRel)
    .filter(Boolean);

export const allowedCheckAltArtifactPaths = (check = {}) => {
  const allowed = new Set();
  for (const rel of checkImageColumnPaths(check)) {
    allowed.add(rel);
    const artifact = toCheckAltPath(rel);
    if (artifact) allowed.add(artifact);
  }
  return allowed;
};

export const isAllowedCheckAltArtifactPath = (check, path) => {
  const rel = normalizeClaimRel(path);
  if (!rel || !isCheckAltArtifactPath(rel)) return false;
  return allowedCheckAltArtifactPaths(check).has(rel);
};

const decodeRaster = (bytes) => {
  const buf = asBuffer(bytes);
  if (isJpegMagic(buf)) {
    const decoded = jpeg.decode(buf, { maxMemoryUsageInMB: 512 });
    return { width: decoded.width, height: decoded.height, data: Buffer.from(decoded.data) };
  }
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50) {
    const png = PNG.sync.read(buf);
    return { width: png.width, height: png.height, data: Buffer.from(png.data) };
  }
  throw Object.assign(new Error('invalid_jpeg'), { code: 'invalid_jpeg' });
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
    img.data.copy(out, (img.height - 1 - y) * img.width * 4, y * img.width * 4, (y + 1) * img.width * 4);
  }
  return { width: img.width, height: img.height, data: out };
};

const applyExifOrientation = (img, orientation) => {
  switch (Number(orientation || 1)) {
    case 2: return flipH(img);
    case 3: return rotate90Cw(rotate90Cw(img));
    case 4: return flipV(img);
    case 5: return rotate90Cw(flipH(img));
    case 6: return rotate90Cw(img);
    case 7: return rotate90Cw(rotate90Cw(rotate90Cw(flipH(img))));
    case 8: return rotate90Cw(rotate90Cw(rotate90Cw(img)));
    default: return img;
  }
};

const resizeBilinear = (img, newW, newH) => {
  const out = Buffer.alloc(newW * newH * 4);
  if (newW <= 1 || newH <= 1 || img.width <= 1 || img.height <= 1) {
    for (let y = 0; y < newH; y += 1) {
      const srcY = Math.min(img.height - 1, Math.round((y + 0.5) * img.height / newH - 0.5));
      for (let x = 0; x < newW; x += 1) {
        const srcX = Math.min(img.width - 1, Math.round((x + 0.5) * img.width / newW - 0.5));
        img.data.copy(out, (y * newW + x) * 4, (srcY * img.width + srcX) * 4, (srcY * img.width + srcX) * 4 + 4);
      }
    }
    return { width: newW, height: newH, data: out };
  }
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

/** Geometry-only plan. Does not enlarge pixels when allowUpscale is false. */
export function planCheckAltContain({ width, height }, pad = CHECKALT_PAD) {
  let scale = Math.min(pad.canvasWidth / width, pad.canvasHeight / height);
  if (!pad.allowUpscale) scale = Math.min(1, scale);
  const renderedWidth = Math.max(1, Math.round(width * scale));
  const renderedHeight = Math.max(1, Math.round(height * scale));
  const padLeft = Math.floor((pad.canvasWidth - renderedWidth) / 2);
  const padTop = Math.floor((pad.canvasHeight - renderedHeight) / 2);
  return {
    scale,
    renderedWidth,
    renderedHeight,
    canvasWidth: pad.canvasWidth,
    canvasHeight: pad.canvasHeight,
    sourcePixelsEnlarged: scale > 1 + 1e-9,
    padLeft,
    padRight: pad.canvasWidth - padLeft - renderedWidth,
    padTop,
    padBottom: pad.canvasHeight - padTop - renderedHeight,
    sourceAspect: width / height,
    renderedAspect: renderedWidth / renderedHeight,
  };
}

const padContain = (img, pad = CHECKALT_PAD) => {
  const canvasW = pad.canvasWidth;
  const canvasH = pad.canvasHeight;
  const plan = planCheckAltContain(img, pad);
  const { scale, renderedWidth: drawW, renderedHeight: drawH } = plan;
  const fitted = (drawW === img.width && drawH === img.height)
    ? img
    : resizeBilinear(img, drawW, drawH);
  const data = Buffer.alloc(canvasW * canvasH * 4, 255);
  const [r, g, b] = pad.fillRgb;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  }
  const x = Math.floor((canvasW - drawW) / 2);
  const y = Math.floor((canvasH - drawH) / 2);
  for (let row = 0; row < drawH; row += 1) {
    const src = row * drawW * 4;
    const dst = ((y + row) * canvasW + x) * 4;
    fitted.data.copy(data, dst, src, src + drawW * 4);
  }
  return {
    image: { width: canvasW, height: canvasH, data },
    contentRect: { x, y, width: drawW, height: drawH },
    scale,
    sourceAspect: img.width / img.height,
    outputAspect: drawW / drawH,
  };
};

const encodeJpeg = (img, quality) => jpeg.encode({
  data: img.data,
  width: img.width,
  height: img.height,
}, quality).data;

/**
 * Compress before storage/base64. There is no OCR/MICR readability metric.
 * Stop at CHECKALT_MIN_JPEG_QUALITY rather than degrading indefinitely.
 */
export function encodeCheckAltJpeg(image) {
  if (Math.min(...CHECKALT_JPEG_QUALITY_LADDER) < CHECKALT_MIN_JPEG_QUALITY) {
    return { ok: false, error: 'quality_floor_violated' };
  }
  let last = null;
  let lastQuality = null;
  for (const quality of CHECKALT_JPEG_QUALITY_LADDER) {
    last = Buffer.from(encodeJpeg(image, quality));
    lastQuality = quality;
    if (last.length < CHECKALT_MIN_BYTES) {
      return {
        ok: false,
        error: 'too_small',
        quality,
        bytes: last.length,
        message: 'JPEG is under 25KB at the current quality. Fail compliance rather than fabricating detail.',
      };
    }
    if (last.length <= CHECKALT_MAX_COMPLIANT_BYTES) {
      return { ok: true, bytes: last, quality, bytesLength: last.length };
    }
  }
  return {
    ok: false,
    error: 'too_large',
    quality: lastQuality,
    bytes: last?.length || 0,
    message: 'Minimum approved JPEG quality still exceeds 300KB. Fail compliance rather than degrading further.',
  };
}

const findMarker = (buf, marker) => {
  let offset = 2;
  while (offset + 4 < buf.length && buf[offset] === 0xff) {
    const code = buf[offset + 1];
    if (code === 0xda) break;
    const size = buf.readUInt16BE(offset + 2);
    if (code === marker) return true;
    if (size < 2) break;
    offset += 2 + size;
  }
  return false;
};

export const auditJpegMetadata = (bytes) => {
  const buf = asBuffer(bytes);
  if (!isJpegMagic(buf)) {
    return { jpeg: false, hasJfif: false, hasExif: false, hasXmp: false, hasIcc: false };
  }
  const head = buf.subarray(0, Math.min(buf.length, 64)).toString('latin1');
  return {
    jpeg: true,
    hasJfif: head.includes('JFIF'),
    hasExif: head.includes('Exif') || findMarker(buf, 0xe1),
    hasXmp: buf.includes(Buffer.from('http://ns.adobe.com/xap/1.0/')),
    hasIcc: findMarker(buf, 0xe2),
    cameraExifFabricated: false,
  };
};

/** Read SOF width/height without decoding the raster. Used for fail-closed submit checks. */
export const readJpegSofDimensions = (bytes) => {
  const buf = asBuffer(bytes);
  if (!isJpegMagic(buf)) return null;
  let offset = 2;
  while (offset + 4 < buf.length) {
    if (buf[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const code = buf[offset + 1];
    if (code === 0xda || code === 0xd9) break;
    if (code === 0xd8 || code === 0x01 || (code >= 0xd0 && code <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (offset + 3 >= buf.length) break;
    const size = buf.readUInt16BE(offset + 2);
    const isSof = (code >= 0xc0 && code <= 0xc3)
      || (code >= 0xc5 && code <= 0xc7)
      || (code >= 0xc9 && code <= 0xcb)
      || (code >= 0xcd && code <= 0xcf);
    if (isSof && size >= 8 && offset + 8 < buf.length) {
      return {
        height: buf.readUInt16BE(offset + 5),
        width: buf.readUInt16BE(offset + 7),
      };
    }
    if (size < 2) break;
    offset += 2 + size;
  }
  return null;
};

export const inspectCheckAltImage = (bytes) => {
  const buf = asBuffer(bytes);
  if (!buf.length) return { present: false, jpeg: false, width: 0, height: 0, bytes: 0 };
  if (!isJpegMagic(buf)) return { present: true, jpeg: false, width: 0, height: 0, bytes: buf.length };
  const sof = readJpegSofDimensions(buf);
  if (!sof?.width || !sof?.height) {
    return { present: true, jpeg: false, width: 0, height: 0, bytes: buf.length };
  }
  return {
    present: true,
    jpeg: true,
    width: sof.width,
    height: sof.height,
    bytes: buf.length,
    metadata: auditJpegMetadata(buf),
  };
};

export const complianceReasonFor = (side, info) => {
  if (!info?.present) return `${side}_missing`;
  if (!info.jpeg) return `${side}_invalid_jpeg`;
  if (info.width !== CHECKALT_CANVAS_WIDTH || info.height !== CHECKALT_CANVAS_HEIGHT) {
    return `${side}_dimensions`;
  }
  if (info.bytes < CHECKALT_MIN_BYTES) return `${side}_too_small`;
  if (info.bytes > CHECKALT_ABSOLUTE_MAX_BYTES || info.bytes > CHECKALT_MAX_COMPLIANT_BYTES) {
    return `${side}_too_large`;
  }
  return null;
};

export const evaluateCheckAltImageCompliance = (bytes, side) => {
  const info = inspectCheckAltImage(bytes);
  const reason = complianceReasonFor(side, info);
  return {
    pass: !reason,
    side,
    reason,
    width: info.width || null,
    height: info.height || null,
    bytes: info.bytes || 0,
    jpeg: Boolean(info.jpeg),
  };
};

export const failCheckAltImageCompliance = (side, reason, extra = {}) => ({
  ok: false,
  statusCode: 400,
  error: CHECKALT_IMAGE_ERROR,
  reason,
  side,
  liveProviderCalled: false,
  productionExecution: false,
  message: `CHECKALT IMAGE COMPLIANCE: FAIL (${side}: ${reason})`,
  ...extra,
});

export function orientSourceImage(bytes) {
  const buf = asBuffer(bytes);
  if (!isJpegMagic(buf) && !(buf[0] === 0x89 && buf[1] === 0x50)) {
    throw Object.assign(new Error('invalid_jpeg'), { code: 'invalid_jpeg' });
  }
  let img = decodeRaster(buf);
  const orientation = isJpegMagic(buf) ? readJpegExifOrientation(buf) : 1;
  if (orientation && orientation !== 1) img = applyExifOrientation(img, orientation);
  if (img.height > img.width) img = rotate90Cw(img);
  return img;
}

export function normalizeToCheckAltCanvas(bytes, { pad = CHECKALT_PAD } = {}) {
  const img = orientSourceImage(bytes);
  const longest = Math.max(img.width, img.height);
  if (longest < CHECKALT_MIN_SOURCE_LONG_EDGE) {
    return {
      ok: false,
      error: 'source_too_small',
      message: 'Source check is too small to build a readable 1920x1080 image. Reupload a clearer photo.',
      sourceWidth: img.width,
      sourceHeight: img.height,
    };
  }
  const fitted = padContain(img, pad);
  const aspectDelta = Math.abs(fitted.sourceAspect - fitted.outputAspect);
  if (aspectDelta > 0.02) {
    return { ok: false, error: 'aspect_distorted', message: 'Contain+pad would distort the check. Fail closed.' };
  }
  const encoded = encodeCheckAltJpeg(fitted.image);
  if (!encoded.ok) {
    return {
      ok: false,
      error: encoded.error,
      message: encoded.message,
      scale: fitted.scale,
      contentRect: fitted.contentRect,
      sourcePixelsEnlarged: fitted.scale > 1 + 1e-9,
    };
  }
  return {
    ok: true,
    bytes: encoded.bytes,
    width: CHECKALT_CANVAS_WIDTH,
    height: CHECKALT_CANVAS_HEIGHT,
    contentRect: fitted.contentRect,
    scale: fitted.scale,
    quality: encoded.quality,
    sourcePixelsEnlarged: fitted.scale > 1 + 1e-9,
    metadata: auditJpegMetadata(encoded.bytes),
  };
}

export const bytesToBase64 = (bytes) => asBuffer(bytes).toString('base64');

export const base64ToBytes = (value) => Buffer.from(String(value || ''), 'base64');

export function resolveCheckAltArtifactPaths(check = {}, body = {}) {
  const frontClaimed = normalizeClaimRel(body.deposit_front_path || '');
  const rearClaimed = normalizeClaimRel(body.deposit_back_path || '');
  const front = frontClaimed || toCheckAltPath(check.front_image_path);
  const rear = rearClaimed || toCheckAltPath(check.back_image_deposit_path);
  return { front, rear };
}

export function syntheticFlatCheckAltJpeg(quality = 8) {
  const width = CHECKALT_CANVAS_WIDTH;
  const height = CHECKALT_CANVAS_HEIGHT;
  const data = Buffer.alloc(width * height * 4, 255);
  return Buffer.from(jpeg.encode({ data, width, height }, quality).data);
}

/** Valid JPEG magic + SOF 1920x1080 under 25KB. Used to prove front_too_small. */
export function syntheticUndersizedCheckAltJpeg() {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10,
    0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    0x04, 0x38,
    0x07, 0x80,
    0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xff, 0xd9,
  ]);
}

export function syntheticCompliantCheckAltJpeg({ seed = 40, quality = 78 } = {}) {
  const width = CHECKALT_CANVAS_WIDTH;
  const height = CHECKALT_CANVAS_HEIGHT;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const band = Math.floor(x / 80) % 2 === Math.floor(y / 40) % 2;
      data[i] = band ? 40 + (seed % 40) : 220;
      data[i + 1] = band ? 80 : 230;
      data[i + 2] = band ? 120 : 240;
      data[i + 3] = 255;
    }
  }
  return Buffer.from(encodeJpeg({ width, height, data }, quality));
}

const fillRect = (data, width, x0, y0, x1, y1, rgb) => {
  const left = Math.max(0, Math.floor(x0));
  const top = Math.max(0, Math.floor(y0));
  const right = Math.min(width - 1, Math.floor(x1));
  const bottom = Math.min((data.length / 4 / width) - 1, Math.floor(y1));
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const i = (y * width + x) * 4;
      data[i] = rgb[0];
      data[i + 1] = rgb[1];
      data[i + 2] = rgb[2];
      data[i + 3] = 255;
    }
  }
};

export function syntheticMarkedCheck({ width = 1600, height = 800 } = {}) {
  const data = Buffer.alloc(width * height * 4, 200);
  const paint = (x, y, rgb) => {
    const i = (y * width + x) * 4;
    data[i] = rgb[0];
    data[i + 1] = rgb[1];
    data[i + 2] = rgb[2];
    data[i + 3] = 255;
  };
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      paint(x, y, [255, 0, 0]);
      paint(width - 1 - x, y, [0, 255, 0]);
      paint(x, height - 1 - y, [0, 0, 255]);
      paint(width - 1 - x, height - 1 - y, [255, 255, 0]);
    }
  }
  return Buffer.from(encodeJpeg({ width, height, data }, 95));
}

/** Personal (~2.18:1) or business (~2.43:1) check with MICR / signature / endorsement marks. */
export function syntheticRegionCheck({
  width,
  height,
  kind = 'front',
} = {}) {
  const data = Buffer.alloc(width * height * 4, 235);
  fillRect(data, width, 0, 0, 7, 7, [255, 0, 0]);
  fillRect(data, width, width - 8, 0, width - 1, 7, [0, 255, 0]);
  fillRect(data, width, 0, height - 8, 7, height - 1, [0, 0, 255]);
  fillRect(data, width, width - 8, height - 8, width - 1, height - 1, [255, 255, 0]);
  fillRect(data, width, 0, height * 0.2, 10, height * 0.8, [180, 20, 20]);
  fillRect(data, width, width - 11, height * 0.2, width - 1, height * 0.8, [20, 180, 20]);
  fillRect(data, width, 0, height * 0.88, width - 1, height - 1, [20, 20, 180]);
  if (kind === 'front') {
    fillRect(data, width, width * 0.68, height * 0.55, width * 0.94, height * 0.82, [20, 20, 20]);
  } else {
    fillRect(data, width, width * 0.06, height * 0.16, width * 0.24, height * 0.84, [30, 0, 80]);
  }
  return {
    bytes: Buffer.from(encodeJpeg({ width, height, data }, 92)),
    regions: {
      leftEdge: { x: 5, y: Math.round(height * 0.5), rgb: [180, 20, 20] },
      rightEdge: { x: width - 6, y: Math.round(height * 0.5), rgb: [20, 180, 20] },
      micr: { x: Math.round(width * 0.5), y: Math.round(height * 0.94), rgb: [20, 20, 180] },
      signature: kind === 'front'
        ? { x: Math.round(width * 0.8), y: Math.round(height * 0.68), rgb: [20, 20, 20] }
        : null,
      endorsement: kind === 'rear'
        ? { x: Math.round(width * 0.15), y: Math.round(height * 0.5), rgb: [30, 0, 80] }
        : null,
    },
  };
}

export function samplePixel(bytes, x, y) {
  const img = jpeg.decode(asBuffer(bytes), { maxMemoryUsageInMB: 512 });
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
}
