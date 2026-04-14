export interface EndorsementOverride {
  xPct: number;        // 0..1 relative to image width
  yPct: number;        // 0..1 relative to image height
  scale: number;       // global overlay scale multiplier
  rotationDeg: number; // optional small rotation
  showPayToOrder: boolean;
}

export interface EndorsementLayout {
  x: number;
  y: number;
  width: number;
  payToFont: number;
  companyFont: number;
  mobileOnlyFont: number;
  payeeFont: number;
  byLineFont: number;
  signatureHeight: number;
  lineGap: number;
  sectionGap: number;
  rotationDeg: number;
}

export const DEFAULT_ENDORSEMENT_OVERRIDE: EndorsementOverride = {
  xPct: 0.38,
  yPct: 0.5,
  scale: 1,
  rotationDeg: 0,
  showPayToOrder: false,
};

export function getEndorsementLayout(
  imageWidth: number,
  imageHeight: number,
  override?: Partial<EndorsementOverride> | null,
): EndorsementLayout {
  const o = {
    ...DEFAULT_ENDORSEMENT_OVERRIDE,
    ...(override ?? {}),
  };

  const baseFont = imageHeight * 0.013 * o.scale;

  return {
    x: imageWidth * o.xPct,
    y: imageHeight * o.yPct,
    width: imageWidth * 0.20 * o.scale,
    payToFont: baseFont * 0.9,
    companyFont: baseFont * 1.2,
    mobileOnlyFont: baseFont * 0.95,
    payeeFont: baseFont * 1.0,
    byLineFont: baseFont * 1.0,
    signatureHeight: baseFont * 2.2,
    lineGap: baseFont * 0.4,
    sectionGap: baseFont * 0.8,
    rotationDeg: o.rotationDeg,
  };
}

export function normalizeRotation(deg: number): number {
  const n = deg % 360;
  return n < 0 ? n + 360 : n;
}

export function clampEndorsementOverride(
  next: EndorsementOverride,
): EndorsementOverride {
  return {
    xPct: Math.min(0.95, Math.max(0.05, next.xPct)),
    yPct: Math.min(0.95, Math.max(0.03, next.yPct)),
    scale: Math.min(2, Math.max(0.4, next.scale)),
    rotationDeg: normalizeRotation(next.rotationDeg),
    showPayToOrder: Boolean(next.showPayToOrder),
  };
}
