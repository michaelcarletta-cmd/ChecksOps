// ============================================================
// STANDARD ENDORSEMENT OVERLAY SCALING
// Drop-in helper for the back-of-check render/compositor
// All sizes scale from image height so the endorsement stays
// proportional regardless of image resolution.
//
// NOW DELEGATES to src/lib/endorsementLayout.ts for unified logic.
// ============================================================

import {
  getEndorsementLayout,
  type EndorsementLayout as NewLayout,
  type EndorsementOverride,
} from "@/lib/endorsementLayout";

export type EndorsementLayout = {
  x: number;
  y: number;
  width: number;
  height: number;
  payToFont: number;
  companyFont: number;
  mobileOnlyFont: number;
  byLineFont: number;
  signatureFont: number;
  signatureHeight: number;
  lineGap: number;
  sectionGap: number;
  rotationDeg: number;
};

export function getStandardEndorsementLayout(
  imageWidth: number,
  imageHeight: number,
  override?: Partial<EndorsementOverride> | null,
): EndorsementLayout {
  const L = getEndorsementLayout(imageWidth, imageHeight, override);
  return {
    x: L.x,
    y: L.y,
    width: L.width,
    height: imageHeight * 0.22 * (override?.scale ?? 1),
    payToFont: L.payToFont,
    companyFont: L.companyFont,
    mobileOnlyFont: L.mobileOnlyFont,
    byLineFont: L.byLineFont,
    signatureFont: L.payeeFont,
    signatureHeight: L.signatureHeight,
    lineGap: L.lineGap,
    sectionGap: L.sectionGap,
    rotationDeg: L.rotationDeg,
  };
}

// ============================================================
// CANVAS RENDERER VERSION
// Use this for compositing onto canvas for print/export
// ============================================================

export type SignatureInput = {
  clientName: string;
  clientSignature?: HTMLImageElement | null;
  ownerName: string;
  ownerSignature?: HTMLImageElement | null;
  companyName: string;
};

export function renderBackCheckEndorsementToCanvas(
  ctx: CanvasRenderingContext2D,
  backImage: HTMLImageElement,
  sig: SignatureInput,
  override?: Partial<EndorsementOverride> | null,
) {
  const canvas = ctx.canvas;
  canvas.width = backImage.naturalWidth || backImage.width;
  canvas.height = backImage.naturalHeight || backImage.height;

  const imgW = canvas.width;
  const imgH = canvas.height;

  // 1) draw full back image first
  ctx.clearRect(0, 0, imgW, imgH);
  ctx.drawImage(backImage, 0, 0, imgW, imgH);

  // 2) overlay endorsement at proportional size
  const L = getStandardEndorsementLayout(imgW, imgH, override);

  ctx.save();

  // hard clip so nothing spills off the check
  ctx.beginPath();
  ctx.rect(0, 0, imgW, imgH);
  ctx.clip();

  // Apply rotation + scale around the center of the endorsement block
  const centerX = L.x + L.width / 2;
  const centerY = L.y + L.height / 2;
  ctx.translate(centerX, centerY);
  ctx.rotate((L.rotationDeg * Math.PI) / 180);
  const scaleVal = override?.scale ?? 1;
  ctx.scale(scaleVal, scaleVal);
  ctx.translate(-centerX, -centerY);

  ctx.fillStyle = "#111111";
  ctx.strokeStyle = "#111111";
  ctx.textBaseline = "top";
  ctx.textAlign = "left";

  let cy = L.y;

  // Pay to the order of
  ctx.font = `600 ${L.payToFont}px Arial, sans-serif`;
  ctx.fillText("Pay to the order of", L.x, cy);
  cy += L.payToFont + L.lineGap;

  // Company name
  ctx.font = `700 ${L.companyFont}px Arial, sans-serif`;
  ctx.fillText(sig.companyName, L.x, cy);
  cy += L.companyFont + L.lineGap;

  // For Mobile Deposit Only
  ctx.font = `700 ${L.mobileOnlyFont}px Arial, sans-serif`;
  ctx.fillText("For Mobile Deposit Only", L.x, cy);
  cy += L.mobileOnlyFont + L.sectionGap;

  // Client signature/name
  if (sig.clientSignature) {
    const sigAspect =
      sig.clientSignature.naturalWidth / sig.clientSignature.naturalHeight || 3;
    const sigWidth = L.signatureHeight * sigAspect;
    ctx.drawImage(sig.clientSignature, L.x, cy, sigWidth, L.signatureHeight);
    cy += L.signatureHeight + L.lineGap * 0.5;
  } else {
    ctx.font = `italic 500 ${L.signatureFont}px "Brush Script MT", cursive`;
    ctx.fillText(sig.clientName, L.x, cy);
    cy += L.signatureFont + L.lineGap * 0.5;
  }

  // Company + owner grouped together
  ctx.font = `700 ${L.companyFont}px Arial, sans-serif`;
  ctx.fillText(sig.companyName, L.x, cy);
  cy += L.companyFont + L.sectionGap;

  // Owner signature/name
  if (sig.ownerSignature) {
    const sigAspect =
      sig.ownerSignature.naturalWidth / sig.ownerSignature.naturalHeight || 3;
    const sigWidth = L.signatureHeight * sigAspect;
    ctx.drawImage(sig.ownerSignature, L.x, cy, sigWidth, L.signatureHeight);
    cy += L.signatureHeight;
  } else {
    ctx.font = `italic 500 ${L.signatureFont}px "Brush Script MT", cursive`;
    ctx.fillText(sig.ownerName, L.x, cy);
    cy += L.signatureFont;
  }

  ctx.restore();
}
