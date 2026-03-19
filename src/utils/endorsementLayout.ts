// ============================================================
// STANDARD ENDORSEMENT OVERLAY SCALING
// Drop-in helper for the back-of-check render/compositor
// All sizes scale from image height so the endorsement stays
// proportional regardless of image resolution.
// ============================================================

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
};

export function getStandardEndorsementLayout(
  imageWidth: number,
  imageHeight: number,
): EndorsementLayout {
  // Endorsement zone – centered in the endorsement area
  const x = imageWidth * 0.38;
  const y = imageHeight * 0.10;
  const width = imageWidth * 0.22;
  const height = imageHeight * 0.22;

  // UNIFIED baseFont scaling — everything derives from one value
  const baseFont = imageHeight * 0.013;
  const payToFont = baseFont * 0.9;
  const companyFont = baseFont * 1.2;
  const mobileOnlyFont = baseFont * 0.95;
  const byLineFont = baseFont * 1.0;
  const signatureFont = baseFont * 1.0;
  const signatureHeight = baseFont * 2.2;
  const lineGap = baseFont * 0.4;
  const sectionGap = baseFont * 0.8;

  return {
    x,
    y,
    width,
    height,
    payToFont,
    companyFont,
    mobileOnlyFont,
    byLineFont,
    signatureFont,
    signatureHeight,
    lineGap,
    sectionGap,
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
  const L = getStandardEndorsementLayout(imgW, imgH);

  ctx.save();

  // hard clip so nothing spills off the check
  ctx.beginPath();
  ctx.rect(0, 0, imgW, imgH);
  ctx.clip();

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

  // Company + owner grouped together
  ctx.font = `700 ${L.companyFont}px Arial, sans-serif`;
  ctx.fillText(sig.companyName, L.x, cy);
  cy += L.companyFont + L.lineGap * 0.6;

  ctx.font = `600 ${L.byLineFont}px Arial, sans-serif`;
  ctx.fillText(`By: ${sig.ownerName}`, L.x, cy);
  cy += L.byLineFont + L.sectionGap;

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
