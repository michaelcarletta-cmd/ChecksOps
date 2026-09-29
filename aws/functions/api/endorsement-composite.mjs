/**
 * Lovable-parity endorsement compositor for AWS.
 *
 * Reproduces the working CheckAlt JPEG path from
 * src/lib/endorsementDepositRender.ts (browser EndorsementAdjuster),
 * not the legacy SVG edge compositor.
 *
 * Does not submit to CheckAlt, lift production holds, or rewrite
 * already-deposited checks.
 */
import { createHash, randomBytes } from 'node:crypto';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { downloadClaimFileBytes } from './providers/production/checkalt-images.mjs';
import {
  CHECKALT_CANVAS_HEIGHT,
  CHECKALT_CANVAS_WIDTH,
  isCheckAltArtifactPath,
  normalizeToCheckAltCanvas,
  sha256,
} from './providers/production/checkalt-image-compliance.mjs';
import {
  loadCheckEndorsements,
  loadCheckPayees,
  stampCheckAltRearFingerprint,
} from './providers/production/checkalt-eligibility.mjs';
import { synchronizePayeesFromEndorsements } from './endorsement-payee-sync.mjs';
import { loadDepositsForCheck, pickBlockingDeposit } from './providers/production/checkalt-idempotency.mjs';
import { normalizePath, s3KeyFor } from './storage-paths.mjs';

export const ZONE_TOP_PCT = 0.15;
export const ZONE_BOTTOM_PCT = 0.92;
export const ENDORSEMENT_WIDTH_PCT = 0.22;
export const MAX_LONG_EDGE = 2400;
export const ENDORSEMENT_RENDERER_VERSION = 'aws-canvas-v2';

export const DEFAULT_OVERRIDE = Object.freeze({
  xPct: 0.38,
  yPct: 0.5,
  scale: 1,
  rotationDeg: 0,
  showPayToOrder: false,
});

const PRESETS = [
  { fontSize: 28, lineGap: 18, rowGap: 24, signatureHeight: 110, columns: 1, compactText: false, scale: 1 },
  { fontSize: 24, lineGap: 14, rowGap: 18, signatureHeight: 92, columns: 1, compactText: true, scale: 0.92 },
  { fontSize: 22, lineGap: 12, rowGap: 14, signatureHeight: 78, columns: 2, compactText: true, scale: 0.86 },
  { fontSize: 20, lineGap: 10, rowGap: 10, signatureHeight: 64, columns: 2, compactText: true, scale: 0.8 },
];

const EXCEPTION_METHODS = new Set(['internal', 'manual', 'physical_check']);
const DEPOSITED_STATUSES = new Set(['submitted', 'pending_approval', 'cleared', 'rejected']);
export const HISTORICAL_CHECK_STATUSES = new Set([
  'deposited',
  'voided',
  'returned',
  'cancelled',
  'funds_released',
  'disbursed_externally',
]);

export const isDrawnSignature = (value) =>
  typeof value === 'string' && value.startsWith('data:image/');

export const isTypedSignature = (value) =>
  typeof value === 'string' && value.startsWith('typed:');

export const requireDrawnSignature = (signatureData) => {
  if (!isDrawnSignature(signatureData)) {
    return {
      ok: false,
      statusCode: 400,
      error: 'signatureData (data:image/*) required',
      message: 'A drawn signature image is required to complete this endorsement.',
    };
  }
  return { ok: true };
};

export const isEndorsedArtifactPath = (path) => {
  const rel = String(path || '').split('?')[0];
  return /endorsed_deposit_[^/]+\.[^.]+$/i.test(rel)
    || /_endorsed(?:_\d+)?\.(?:svg|jpe?g|png)$/i.test(rel)
    || isCheckAltArtifactPath(rel);
};

const measurePreset = (signerCount, preset) => {
  const headerLines = preset.compactText ? 2 : 3;
  const headerHeight = headerLines * (preset.fontSize + preset.lineGap);
  const rows = preset.columns === 2 ? Math.ceil(signerCount / 2) : signerCount;
  const perRow = preset.fontSize + 8 + preset.signatureHeight + preset.rowGap;
  const footerHeight = preset.fontSize + preset.lineGap + preset.signatureHeight + 20;
  return {
    ...preset,
    estimatedHeight: Math.ceil(headerHeight + rows * perRow + footerHeight),
  };
};

export const fitEndorsementLayout = ({ signerCount, zoneHeightPx, requestedScale }) => {
  const userScale = requestedScale || 1;
  let basePreset = null;
  for (const preset of PRESETS) {
    if (measurePreset(signerCount, preset).estimatedHeight <= zoneHeightPx * 0.65) {
      basePreset = preset;
      break;
    }
  }
  if (!basePreset) {
    for (const preset of PRESETS) {
      if (measurePreset(signerCount, preset).estimatedHeight <= zoneHeightPx) {
        basePreset = preset;
        break;
      }
    }
  }
  if (!basePreset) basePreset = PRESETS[PRESETS.length - 1];
  return measurePreset(signerCount, {
    ...basePreset,
    fontSize: Math.round(basePreset.fontSize * userScale),
    lineGap: Math.round(basePreset.lineGap * userScale),
    rowGap: Math.round(basePreset.rowGap * userScale),
    signatureHeight: Math.round(basePreset.signatureHeight * userScale),
    scale: userScale,
  });
};

export const clampEndorsementOverride = (next = {}) => ({
  xPct: Math.min(0.95, Math.max(0.05, Number(next.xPct ?? DEFAULT_OVERRIDE.xPct))),
  yPct: Math.min(0.95, Math.max(0.03, Number(next.yPct ?? DEFAULT_OVERRIDE.yPct))),
  scale: Math.min(4, Math.max(0.4, Number(next.scale ?? DEFAULT_OVERRIDE.scale) || 1)),
  rotationDeg: ((Number(next.rotationDeg || 0) % 360) + 360) % 360,
  showPayToOrder: Boolean(next.showPayToOrder),
});

export const endorsementCompleted = (row) => {
  const status = String(row?.status || '').toLowerCase();
  if (status === 'signed' || status === 'waived') return true;
  if (status === 'manual_required' && String(row?.payee_type || '') === 'mortgage_company') return true;
  return false;
};

export const hasUsableDrawnInk = (row) =>
  isDrawnSignature(row?.signature_image_url || row?.endorsement_image_path);

export const isExceptionCompletion = (row) => {
  const status = String(row?.status || '').toLowerCase();
  const method = String(row?.signature_method || '').toLowerCase();
  if (status === 'waived') return true;
  if (status === 'manual_required' && String(row?.payee_type || '') === 'mortgage_company') return true;
  return status === 'signed' && EXCEPTION_METHODS.has(method);
};

export const isGenuineDrawnCompletion = (row) => {
  const status = String(row?.status || '').toLowerCase();
  return status === 'signed' && hasUsableDrawnInk(row) && !isExceptionCompletion(row);
};

const asBuffer = (bytes) => (Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []));

const isJpeg = (buf) => buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
const isPng = (buf) => buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50;

export const decodeRgba = (bytes) => {
  const buf = asBuffer(bytes);
  if (isJpeg(buf)) {
    const decoded = jpeg.decode(buf, { maxMemoryUsageInMB: 512 });
    return { width: decoded.width, height: decoded.height, data: Buffer.from(decoded.data) };
  }
  if (isPng(buf)) {
    const png = PNG.sync.read(buf);
    return { width: png.width, height: png.height, data: Buffer.from(png.data) };
  }
  throw Object.assign(new Error('unsupported_image'), { code: 'unsupported_image' });
};

export const encodeJpegBuffer = (img, quality = 92) =>
  Buffer.from(jpeg.encode({ data: img.data, width: img.width, height: img.height }, quality).data);

export const decodeDataUrl = (value) => {
  if (!isDrawnSignature(value)) return null;
  const comma = value.indexOf(',');
  if (comma < 0) return null;
  const header = value.slice(0, comma);
  const payload = value.slice(comma + 1);
  const bytes = Buffer.from(payload, 'base64');
  if (!bytes.length) return null;
  return { mime: /data:([^;]+)/.exec(header)?.[1] || 'image/png', bytes };
};

const fitLongEdge = (w, h, target = MAX_LONG_EDGE) => {
  const longest = Math.max(w, h);
  if (longest <= target) return { width: w, height: h };
  const r = target / longest;
  return { width: Math.round(w * r), height: Math.round(h * r) };
};

const resizeNearest = (img, newW, newH) => {
  const out = Buffer.alloc(newW * newH * 4);
  for (let y = 0; y < newH; y += 1) {
    const srcY = Math.min(img.height - 1, Math.round((y + 0.5) * img.height / newH - 0.5));
    for (let x = 0; x < newW; x += 1) {
      const srcX = Math.min(img.width - 1, Math.round((x + 0.5) * img.width / newW - 0.5));
      img.data.copy(out, (y * newW + x) * 4, (srcY * img.width + srcX) * 4, (srcY * img.width + srcX) * 4 + 4);
    }
  }
  return { width: newW, height: newH, data: out };
};

const inkify = (img) => {
  const out = Buffer.from(img.data);
  for (let i = 0; i < out.length; i += 4) {
    const a = out[i + 3];
    if (a < 24) {
      out[i + 3] = 0;
      continue;
    }
    const lum = 0.299 * out[i] + 0.587 * out[i + 1] + 0.114 * out[i + 2];
    if (lum > 225) {
      out[i + 3] = 0;
      continue;
    }
    out[i] = 0;
    out[i + 1] = 0;
    out[i + 2] = 0;
    out[i + 3] = 255;
  }
  return { width: img.width, height: img.height, data: out };
};

const blit = (dest, src, dx, dy) => {
  for (let y = 0; y < src.height; y += 1) {
    const ty = dy + y;
    if (ty < 0 || ty >= dest.height) continue;
    for (let x = 0; x < src.width; x += 1) {
      const tx = dx + x;
      if (tx < 0 || tx >= dest.width) continue;
      const si = (y * src.width + x) * 4;
      const a = src.data[si + 3];
      if (a < 24) continue;
      const di = (ty * dest.width + tx) * 4;
      dest.data[di] = src.data[si];
      dest.data[di + 1] = src.data[si + 1];
      dest.data[di + 2] = src.data[si + 2];
      dest.data[di + 3] = 255;
    }
  }
};

// Compact 5x7 glyphs for endorsement labels. Matches Lovable name+ink layout,
// not a new design. Unknown glyphs become a short dash.
const GLYPH_5X7 = {
  ' ': '00000000000000000000000000000000000',
  '-': '00000000000000011111000000000000000',
  '.': '00000000000000000000000000011000110',
  "'": '01100011000000000000000000000000000',
  '#': '01010111110101011111010100000000000',
  '&': '01100100100110010101011010000000000',
  '0': '01110100011001110101100010111000000',
  '1': '00100011000010000100001000111000000',
  '2': '01110100010000100010001001111100000',
  '3': '01110100010001100001000010111000000',
  '4': '00010001100101011111000100001000000',
  '5': '11111100001111000001000010111000000',
  '6': '01110100001111010001100010111000000',
  '7': '11111000010001000100010000100000000',
  '8': '01110100010111010001100010111000000',
  '9': '01110100011000101111000010111000000',
  A: '01110100011111110001100011000100000',
  B: '11110100011111010001100011111000000',
  C: '01110100011000010000100010111000000',
  D: '11100100101000110001100101110000000',
  E: '11111100001110010000100001111100000',
  F: '11111100001110010000100001000000000',
  G: '01110100011000010111100010111000000',
  H: '10001100011111110001100011000100000',
  I: '11110001000010000100001000111100000',
  J: '00111000100001000010100010111000000',
  K: '10001100101100011000100101000100000',
  L: '10000100001000010000100001111100000',
  M: '10001110111010110001100011000100000',
  N: '10001110011010110011100011000100000',
  O: '01110100011000110001100010111000000',
  P: '11110100011111010000100001000000000',
  Q: '01110100011000110001100100110100001',
  R: '11110100011111010010100011000100000',
  S: '01111100000111000001000011111000000',
  T: '11111001000010000100001000010000000',
  U: '10001100011000110001100010111000000',
  V: '10001100011000101010010100010000000',
  W: '10001100011000110101110111000100000',
  X: '10001010100010000100010101000100000',
  Y: '10001010100010000100001000010000000',
  Z: '11111000010001000100010001111100000',
};

const glyphBits = (ch) => GLYPH_5X7[ch] || GLYPH_5X7[ch.toUpperCase()] || GLYPH_5X7['-'];

export const drawBitmapText = (dest, text, centerX, topY, pixelSize) => {
  const size = Math.max(1, Math.round(pixelSize / 7));
  const chars = String(text || '').split('');
  const glyphW = 6 * size;
  const width = chars.length * glyphW;
  let x = Math.round(centerX - width / 2);
  const y = Math.round(topY);
  for (const ch of chars) {
    const bits = glyphBits(ch);
    for (let row = 0; row < 7; row += 1) {
      for (let col = 0; col < 5; col += 1) {
        if (bits[row * 5 + col] !== '1') continue;
        for (let dy = 0; dy < size; dy += 1) {
          for (let dx = 0; dx < size; dx += 1) {
            const tx = x + col * size + dx;
            const ty = y + row * size + dy;
            if (tx < 0 || ty < 0 || tx >= dest.width || ty >= dest.height) continue;
            const i = (ty * dest.width + tx) * 4;
            dest.data[i] = 0;
            dest.data[i + 1] = 0;
            dest.data[i + 2] = 0;
            dest.data[i + 3] = 255;
          }
        }
      }
    }
    x += glyphW;
  }
  return 7 * size;
};

const estimateBlockHeight = (input, fontSize, lineGap, rowGap, sigHeight, columns, showPayToOrder) => {
  let h = 0;
  if (showPayToOrder) {
    h += fontSize + lineGap;
    h += Math.round(fontSize * 1.2) + lineGap;
    h += fontSize + rowGap;
  }
  const rows = Math.ceil(input.clientSignatures.length / columns) || 0;
  h += rows * (fontSize + lineGap * 0.5 + sigHeight + rowGap);
  if (input.companySignature) {
    h += Math.round(fontSize * 1.2) + lineGap + sigHeight;
  }
  return h;
};

const drawSignatureAsset = (dest, asset, centerX, topY, boxW, boxH) => {
  const url = asset?.signature_image_url || '';
  if (isDrawnSignature(url)) {
    const decoded = decodeDataUrl(url);
    if (decoded) {
      try {
        const ink = inkify(decodeRgba(decoded.bytes));
        const aspect = ink.width / ink.height || 3;
        const drawW = Math.max(1, Math.round(Math.min(boxW, boxH * aspect)));
        const drawH = Math.max(1, Math.round(drawW / aspect));
        const scaled = resizeNearest(ink, drawW, drawH);
        blit(dest, scaled, Math.round(centerX - drawW / 2), Math.round(topY + Math.max(0, (boxH - drawH) / 2)));
        return boxH;
      } catch {
        /* typed fallback */
      }
    }
  }
  const typed = isTypedSignature(url) ? url.slice(6) : (asset?.payee_name || '');
  drawBitmapText(dest, typed, centerX, topY + boxH / 3, Math.max(10, boxH / 2));
  return boxH;
};

export const renderEndorsementRaster = (backImg, input) => {
  const override = clampEndorsementOverride(input.override);
  const natW = backImg.width;
  const natH = backImg.height;
  const { width: outW, height: outH } = fitLongEdge(natW, natH);
  const dest = outW === natW && outH === natH
    ? { width: natW, height: natH, data: Buffer.from(backImg.data) }
    : resizeNearest(backImg, outW, outH);

  const signerCount = Math.max(1, input.clientSignatures.length);
  const naturalSafeZoneHeightPx = (ZONE_BOTTOM_PCT - ZONE_TOP_PCT) * natH;
  const naturalPreset = fitEndorsementLayout({
    signerCount,
    zoneHeightPx: naturalSafeZoneHeightPx,
    requestedScale: override.scale || 1,
  });
  const renderScale = outH / natH;
  const preset = {
    ...naturalPreset,
    fontSize: naturalPreset.fontSize * renderScale,
    lineGap: naturalPreset.lineGap * renderScale,
    rowGap: naturalPreset.rowGap * renderScale,
    signatureHeight: naturalPreset.signatureHeight * renderScale,
  };
  const blockWidth = outW * ENDORSEMENT_WIDTH_PCT * (override.scale || 1);
  const unscaledBlockWidth = outW * ENDORSEMENT_WIDTH_PCT;
  const unscaledColumnWidth = preset.columns === 2 ? unscaledBlockWidth / 2 : unscaledBlockWidth;
  const signatureScale = override.scale || 1;
  const signatureBoxWidths = {
    client: Math.min(Math.max(0, unscaledColumnWidth - 20 * renderScale), outH * 0.1) * signatureScale,
    company: Math.min(Math.max(0, unscaledBlockWidth - 20 * renderScale), outH * 0.1) * signatureScale,
  };
  const blockHeight = estimateBlockHeight(
    input,
    preset.fontSize,
    preset.lineGap,
    preset.rowGap,
    preset.signatureHeight,
    preset.columns,
    override.showPayToOrder,
  );
  const safeZoneTopPx = ZONE_TOP_PCT * outH;
  const safeZoneBottomPx = ZONE_BOTTOM_PCT * outH;
  const safeZoneHeightPx = safeZoneBottomPx - safeZoneTopPx;
  const centerX = override.xPct * outW;
  let centerY = safeZoneTopPx + override.yPct * safeZoneHeightPx;
  const halfH = blockHeight / 2;
  centerY = Math.max(safeZoneTopPx + halfH, Math.min(safeZoneBottomPx - halfH, centerY));
  const originX = centerX - blockWidth / 2;
  const originY = centerY - blockHeight / 2;
  let cy = originY;
  const mid = originX + blockWidth / 2;

  if (override.showPayToOrder) {
    drawBitmapText(dest, 'PAY TO THE ORDER OF', mid, cy, preset.fontSize);
    cy += preset.fontSize + preset.lineGap;
    drawBitmapText(dest, String(input.companyName || '').toUpperCase(), mid, cy, Math.round(preset.fontSize * 1.2));
    cy += Math.round(preset.fontSize * 1.2) + preset.lineGap;
    drawBitmapText(dest, 'FOR MOBILE DEPOSIT ONLY', mid, cy, preset.fontSize);
    cy += preset.fontSize + preset.rowGap;
  }

  const clientSigs = input.clientSignatures || [];
  const colWidth = preset.columns === 2 ? blockWidth / 2 : blockWidth;
  for (let i = 0; i < clientSigs.length; i += preset.columns) {
    const rowStart = cy;
    let rowMax = cy;
    for (let c = 0; c < preset.columns && i + c < clientSigs.length; c += 1) {
      const sig = clientSigs[i + c];
      const colCenterX = preset.columns === 2 ? originX + colWidth / 2 + c * colWidth : mid;
      let subCy = rowStart;
      drawBitmapText(dest, String(sig.payee_name || '').toUpperCase(), colCenterX, subCy, preset.fontSize);
      subCy += preset.fontSize + preset.lineGap * 0.5;
      subCy += drawSignatureAsset(dest, sig, colCenterX, subCy, signatureBoxWidths.client, preset.signatureHeight);
      subCy += preset.rowGap;
      if (subCy > rowMax) rowMax = subCy;
    }
    cy = rowMax;
  }

  if (input.companySignature) {
    drawBitmapText(dest, String(input.companyName || '').toUpperCase(), mid, cy, Math.round(preset.fontSize * 1.2));
    cy += Math.round(preset.fontSize * 1.2) + preset.lineGap;
    drawSignatureAsset(dest, input.companySignature, mid, cy, signatureBoxWidths.company, preset.signatureHeight);
  }

  return dest;
};

export const renderDepositJpeg = (backBytes, input) => {
  const raster = renderEndorsementRaster(decodeRgba(backBytes), input);
  const working = encodeJpegBuffer(raster, 92);
  const official = normalizeToCheckAltCanvas(working);
  if (!official.ok) {
    return {
      ok: false,
      error: official.error || 'checkalt_normalize_failed',
      message: official.message || 'Could not build a CheckAlt-compliant endorsed rear JPEG',
    };
  }
  return {
    ok: true,
    bytes: official.bytes,
    width: official.width || CHECKALT_CANVAS_WIDTH,
    height: official.height || CHECKALT_CANVAS_HEIGHT,
    workingWidth: raster.width,
    workingHeight: raster.height,
    rendererVersion: ENDORSEMENT_RENDERER_VERSION,
    sha256: sha256(official.bytes),
  };
};

export const makeInkSignatureDataUrl = ({ width = 240, height = 70, mark = 'SIG' } = {}) => {
  const data = Buffer.alloc(width * height * 4, 255);
  for (let y = 18; y < height - 18; y += 1) {
    for (let x = 20; x < width - 20; x += 1) {
      const wave = Math.round(8 * Math.sin((x + (mark.length * 13)) / 9) + height / 2);
      if (Math.abs(y - wave) < 3 || ((x + y + mark.charCodeAt(0)) % 17 === 0 && y > 22 && y < height - 22)) {
        const i = (y * width + x) * 4;
        data[i] = 0;
        data[i + 1] = 0;
        data[i + 2] = 0;
        data[i + 3] = 255;
      }
    }
  }
  const png = new PNG({ width, height });
  data.copy(png.data);
  const bytes = PNG.sync.write(png);
  return `data:image/png;base64,${bytes.toString('base64')}`;
};

const recoverOriginalPath = (check) => {
  const original = check.back_image_original_path;
  if (original && !isEndorsedArtifactPath(original)) return original;
  const current = check.back_image_path;
  if (current && !isEndorsedArtifactPath(current)) return current;
  return original || current || null;
};

export const isHistoricalCheckLocked = (check = {}, deposits = []) => {
  if (HISTORICAL_CHECK_STATUSES.has(String(check.status || ''))) return true;
  if (check.deposited_at) return true;
  const blocking = pickBlockingDeposit(deposits || []);
  return Boolean(blocking && (blocking.checkalt_reference || DEPOSITED_STATUSES.has(String(blocking.status || ''))));
};

export const loadHistoricalLock = async (client, checkId, deps = {}) => {
  if (!checkId) return { locked: false, check: null, deposits: [] };
  const check = (await client.query(
    `SELECT id, tenant_id, status, deposited_at, back_image_path, back_image_original_path,
            back_image_deposit_path, endorsement_override, endorsement_render_meta, check_stage
       FROM public.check_intake_items WHERE id = $1::uuid LIMIT 1`,
    [checkId],
  )).rows[0] || null;
  if (!check) return { locked: false, check: null, deposits: [] };
  const deposits = await (deps.loadDeposits
    ? deps.loadDeposits(check)
    : loadDepositsForCheck(client, { tenantId: check.tenant_id, checkId: check.id }));
  return { locked: isHistoricalCheckLocked(check, deposits), check, deposits };
};

export const invalidateOfficialRearImage = async (client, checkId, deps = {}) => {
  if (!checkId) return { ok: false, error: 'missing_check_id' };
  const lock = await loadHistoricalLock(client, checkId, deps);
  if (lock.locked) {
    return { ok: false, error: 'historical_deposit_locked', historicalDepositUntouched: true };
  }
  const row = lock.check || (await client.query(
    `SELECT id, back_image_path, back_image_original_path, back_image_deposit_path
     FROM public.check_intake_items WHERE id = $1::uuid LIMIT 1`,
    [checkId],
  )).rows[0];
  if (!row) return { ok: false, error: 'check_not_found' };
  const restore = recoverOriginalPath(row);
  await client.query(
    `UPDATE public.check_intake_items
        SET back_image_deposit_path = NULL,
            endorsement_render_status = 'idle',
            endorsement_render_meta = COALESCE(endorsement_render_meta, '{}'::jsonb)
              - 'checkalt_rear_fingerprint'
              || jsonb_build_object(
                   'invalidated_at', $2::text,
                   'reason', 'endorsement_state_changed'
                 ),
            back_image_path = COALESCE($3, back_image_path),
            back_image_original_path = COALESCE(back_image_original_path, $3),
            endorsement_render_version = COALESCE(endorsement_render_version, 0) + 1,
            updated_at = now()
      WHERE id = $1::uuid`,
    [checkId, new Date().toISOString(), restore],
  );
  return { ok: true, restoredOriginalPath: restore };
};

const isCompanyName = (name, companyName) => {
  const lc = String(name || '').toLowerCase();
  const company = String(companyName || '').toLowerCase();
  return lc.includes('freedom') || lc.includes('carletta') || (company && lc.includes(company));
};

const visibleSignatureAsset = (row) => {
  if (String(row.status || '').toLowerCase() === 'waived') return null;
  if (hasUsableDrawnInk(row)) {
    return {
      id: row.id,
      payee_name: row.payee_name,
      payee_type: row.payee_type,
      signature_image_url: row.signature_image_url || row.endorsement_image_path,
      signature_method: row.signature_method,
    };
  }
  if (isExceptionCompletion(row)) {
    return {
      id: row.id,
      payee_name: row.payee_name,
      payee_type: row.payee_type,
      signature_image_url: `typed:${row.payee_name || ''}`,
      signature_method: row.signature_method,
    };
  }
  return null;
};

export const selectVisibleSignatures = (rows = [], companyName = '') => {
  const visible = rows.map(visibleSignatureAsset).filter(Boolean);
  const clientSignatures = visible.filter((row) => !isCompanyName(row.payee_name, companyName));
  const companySignature = visible.find((row) => isCompanyName(row.payee_name, companyName)) || null;
  return { clientSignatures, companySignature };
};

const defaultUpload = async (rel, bytes, contentType = 'image/jpeg') => {
  const { PutObjectCommand, S3Client } = await import('@aws-sdk/client-s3');
  const bucket = process.env.FILES_BUCKET;
  const key = s3KeyFor('claim-files', normalizePath(rel, 'claim-files'));
  if (!bucket || !key) throw Object.assign(new Error('s3_not_configured'), { statusCode: 503 });
  const s3 = new S3Client({ region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1' });
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: bytes,
    ContentType: contentType,
  }));
  return { path: rel, key };
};

export const compositeEndorsementSignatures = async ({
  client,
  checkId,
  overrideData,
  deps = {},
} = {}) => {
  if (!checkId) return { ok: false, statusCode: 400, error: 'missing_check_id' };
  const check = (await client.query(
    `SELECT id, tenant_id, back_image_path, back_image_original_path, back_image_deposit_path,
            endorsement_override, endorsement_render_meta, status, check_stage, deposited_at
       FROM public.check_intake_items WHERE id = $1::uuid LIMIT 1`,
    [checkId],
  )).rows[0];
  if (!check) return { ok: false, statusCode: 404, error: 'check_not_found' };

  const deposits = await (deps.loadDeposits
    ? deps.loadDeposits(check)
    : loadDepositsForCheck(client, { tenantId: check.tenant_id, checkId: check.id }));
  if (isHistoricalCheckLocked(check, deposits)) {
    return {
      ok: false,
      statusCode: 409,
      error: 'historical_deposit_locked',
      message: 'Already deposited checks are not re-composited.',
      historicalDepositUntouched: true,
    };
  }

  const originalPath = recoverOriginalPath(check);
  if (!originalPath) return { ok: false, statusCode: 400, error: 'original_back_missing' };

  const endorsementRows = (await client.query(
    `SELECT e.id, e.payee_name, e.payee_type, e.status, e.signed_at, e.signature_image_url,
            e.signature_method, e.payee_id, p.endorsement_image_path, p.endorsement_status
       FROM public.check_endorsements e
       LEFT JOIN public.check_payees p ON p.id = e.payee_id
      WHERE e.check_id = $1::uuid
      ORDER BY e.created_at ASC NULLS LAST, e.id ASC`,
    [checkId],
  )).rows;

  const missingDrawn = endorsementRows.filter((row) => {
    const status = String(row.status || '').toLowerCase();
    if (status !== 'signed') return false;
    if (isExceptionCompletion(row)) return false;
    return !hasUsableDrawnInk(row);
  });
  if (missingDrawn.length) {
    return {
      ok: false,
      statusCode: 409,
      error: 'signature_image_missing',
      message: 'A signed endorsement is missing drawn signature image data.',
      missing: missingDrawn.map((row) => row.payee_name),
    };
  }

  let companyName = 'Freedom Adjustment';
  if (check.tenant_id) {
    const tenant = (await client.query(
      `SELECT name FROM public.tenants WHERE id = $1::uuid LIMIT 1`,
      [check.tenant_id],
    )).rows[0];
    if (tenant?.name) companyName = tenant.name;
  }

  const { clientSignatures, companySignature } = selectVisibleSignatures(endorsementRows, companyName);
  const override = clampEndorsementOverride(overrideData || check.endorsement_override || DEFAULT_OVERRIDE);
  const download = deps.downloadClaimFile || downloadClaimFileBytes;
  const backBytes = await download(originalPath, deps);
  if (!backBytes?.length) return { ok: false, statusCode: 404, error: 'original_back_unavailable' };

  const rendered = (deps.renderDepositJpeg || renderDepositJpeg)(backBytes, {
    override,
    companyName,
    clientSignatures,
    companySignature,
  });
  if (!rendered.ok) {
    return { ok: false, statusCode: 422, error: rendered.error, message: rendered.message };
  }

  const folder = String(originalPath).replace(/\/[^/]+$/, '');
  const version = randomBytes(4).toString('hex');
  const depositPath = `${folder}/endorsed_deposit_${version}.checkalt.jpg`;
  const upload = deps.uploadClaimFile || defaultUpload;
  await upload(depositPath, rendered.bytes, 'image/jpeg');

  const meta = {
    engine: 'aws_lovable_parity_composite',
    renderer_version: ENDORSEMENT_RENDERER_VERSION,
    at: new Date().toISOString(),
    mime_type: 'image/jpeg',
    width: rendered.width,
    height: rendered.height,
    bytes: rendered.bytes.length,
    sha256: rendered.sha256,
    override,
    original_back_image_path: originalPath,
    endorsed_back_image_path: depositPath,
  };

  await client.query(
    `UPDATE public.check_intake_items
        SET back_image_deposit_path = $2,
            back_image_original_path = COALESCE(back_image_original_path, $3),
            back_image_path = CASE
              WHEN back_image_path IS NULL OR back_image_path = '' THEN $3
              ELSE back_image_path
            END,
            endorsement_render_status = 'completed',
            endorsement_render_meta = COALESCE(endorsement_render_meta, '{}'::jsonb) || $4::jsonb,
            endorsement_render_version = COALESCE(endorsement_render_version, 0) + 1,
            updated_at = now()
      WHERE id = $1::uuid`,
    [checkId, depositPath, originalPath, JSON.stringify(meta)],
  );

  if (check.tenant_id && deps.stampFingerprint !== false) {
    await synchronizePayeesFromEndorsements(client, check.id);
    const payees = await loadCheckPayees(client, check.id, check.tenant_id);
    const endorsements = await loadCheckEndorsements(client, check.id, check.tenant_id);
    await stampCheckAltRearFingerprint(client, check.id, check.tenant_id, payees, endorsements);
  }

  return {
    ok: true,
    statusCode: 200,
    success: true,
    composited: true,
    staging: false,
    original_back_image_path: originalPath,
    endorsed_back_image_path: depositPath,
    composited_path: depositPath,
    composited_back_path: depositPath,
    back_image_deposit_path: depositPath,
    output_format: 'rasterized_jpeg',
    db_path_update_committed: true,
    image_dimensions: { width: rendered.width, height: rendered.height },
    sha256: rendered.sha256,
    renderer_version: ENDORSEMENT_RENDERER_VERSION,
  };
};

export const afterGenuineEndorsementSigned = async (client, checkId, deps = {}) => {
  const lock = await loadHistoricalLock(client, checkId, deps);
  if (lock.locked) {
    return {
      invalidated: { ok: false, error: 'historical_deposit_locked', historicalDepositUntouched: true },
      composited: { ok: false, error: 'historical_deposit_locked', historicalDepositUntouched: true },
    };
  }
  const invalidated = await invalidateOfficialRearImage(client, checkId, deps);
  if (deps.skipComposite) return { invalidated, composited: null };
  try {
    const composited = await compositeEndorsementSignatures({ client, checkId, deps });
    return { invalidated, composited };
  } catch (error) {
    return {
      invalidated,
      composited: { ok: false, error: String(error?.message || error).slice(0, 200) },
    };
  }
};

export const endorsementStateHash = (rows = []) => createHash('sha256')
  .update(JSON.stringify(rows.map((row) => ({
    id: row.id,
    status: row.status,
    signed_at: row.signed_at,
    has_ink: hasUsableDrawnInk(row),
  }))))
  .digest('hex');
