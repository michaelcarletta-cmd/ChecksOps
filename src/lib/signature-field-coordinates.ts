/**
 * Signature composer coordinates stay in the existing normalized
 * document model (0-100 of the rendered page overlay).
 * Display width may change; persisted x/y/width/height must not.
 */

export const DESKTOP_COMPOSER_PAGE_WIDTH = 600;
export const DESKTOP_COMPOSER_DOCX_WIDTH = 650;

export const FIELD_DEFAULT_PIXELS = {
  signature: { width: 150, height: 50 },
  date: { width: 100, height: 25 },
  text: { width: 120, height: 25 },
  checkbox: { width: 20, height: 20 },
} as const;

export type SignatureFieldType = keyof typeof FIELD_DEFAULT_PIXELS;

export type RectLike = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type PercentBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export const roundCoord = (value: number): number => parseFloat(Number(value).toFixed(4));

export const displayPageWidth = (
  availableWidth: number,
  desktopWidth = DESKTOP_COMPOSER_PAGE_WIDTH,
): number => {
  if (!Number.isFinite(availableWidth) || availableWidth <= 0) return desktopWidth;
  return Math.min(desktopWidth, Math.floor(availableWidth));
};

export const clientPointToPercent = (
  clientX: number,
  clientY: number,
  rect: RectLike,
): { x: number; y: number } => {
  const width = rect.width || 1;
  const height = rect.height || 1;
  return {
    x: roundCoord(((clientX - rect.left) / width) * 100),
    y: roundCoord(((clientY - rect.top) / height) * 100),
  };
};

export const defaultFieldSizePercent = (
  type: SignatureFieldType,
  overlayWidth: number,
  overlayHeight: number,
  referenceWidth = DESKTOP_COMPOSER_PAGE_WIDTH,
): { width: number; height: number } => {
  const px = FIELD_DEFAULT_PIXELS[type];
  const safeOverlayWidth = overlayWidth > 0 ? overlayWidth : referenceWidth;
  const safeOverlayHeight = overlayHeight > 0 ? overlayHeight : 800;
  const referenceHeight = referenceWidth * (safeOverlayHeight / safeOverlayWidth);
  return {
    width: roundCoord((px.width / referenceWidth) * 100),
    height: roundCoord((px.height / referenceHeight) * 100),
  };
};

export const pixelsToPercent = (
  field: PercentBox,
  overlayWidth: number,
  overlayHeight: number,
): PercentBox => {
  const ow = overlayWidth || DESKTOP_COMPOSER_PAGE_WIDTH;
  const oh = overlayHeight || 800;
  return {
    x: roundCoord((field.x / ow) * 100),
    y: roundCoord((field.y / oh) * 100),
    width: roundCoord((field.width / ow) * 100),
    height: roundCoord((field.height / oh) * 100),
  };
};

export const looksLikePercentField = (field: Partial<PercentBox> | null | undefined): boolean => {
  if (!field) return false;
  const x = Number(field.x);
  const y = Number(field.y);
  const width = Number(field.width ?? 0);
  const height = Number(field.height ?? 0);
  return x <= 100 && y <= 100 && width <= 100 && height <= 100;
};

export const toPersistedPercentField = <T extends PercentBox>(
  field: T,
  overlayWidth?: number,
  overlayHeight?: number,
): T => {
  const box = looksLikePercentField(field)
    ? {
        x: roundCoord(field.x),
        y: roundCoord(field.y),
        width: roundCoord(field.width),
        height: roundCoord(field.height),
      }
    : pixelsToPercent(field, overlayWidth || DESKTOP_COMPOSER_PAGE_WIDTH, overlayHeight || 800);
  return { ...field, ...box };
};

export const clampPercentField = <T extends PercentBox>(field: T): T => {
  const width = Math.min(Math.max(field.width, 0.5), 100);
  const height = Math.min(Math.max(field.height, 0.5), 100);
  return {
    ...field,
    width,
    height,
    x: Math.min(Math.max(field.x, 0), 100 - width),
    y: Math.min(Math.max(field.y, 0), 100 - height),
  };
};

/** Same formula the signing/PDF completion path uses. Do not change that engine. */
export const pdfPointFromPercent = (percent: number, pdfPageSize: number): number =>
  (percent / 100) * pdfPageSize;
