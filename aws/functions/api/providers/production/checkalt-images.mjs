import { isJpegMagic } from '../parity/checkalt-image.mjs';
import {
  CHECKALT_IMAGE_ERROR,
  bytesToBase64,
  evaluateCheckAltImageCompliance,
  failCheckAltImageCompliance,
  isAllowedCheckAltArtifactPath,
  isCheckAltArtifactPath,
  resolveCheckAltArtifactPaths,
  sha256,
} from './checkalt-image-compliance.mjs';

export const MAX_TOTAL_B64_CHARS = 1_600_000;

const isSvgBytes = (bytes) => {
  if (!bytes || !bytes.length) return false;
  const head = Buffer.from(bytes).subarray(0, 64).toString('utf8').trim().toLowerCase();
  return head.startsWith('<svg') || head.includes('<svg');
};

export const imageFail = (error, extra = {}) => ({
  ok: false,
  statusCode: extra.statusCode || 400,
  error,
  liveProviderCalled: false,
  productionExecution: false,
  message: extra.message || 'Deposit-ready JPEG required on both sides before CheckAlt HTTP.',
  ...extra,
});

export async function downloadClaimFileBytes(path, deps = {}) {
  if (!path) return null;
  if (typeof deps.downloadClaimFile === 'function') return deps.downloadClaimFile(path);
  const { GetObjectCommand, S3Client } = await import('@aws-sdk/client-s3');
  const { s3KeyFor } = await import('../../storage-paths.mjs');
  const bucket = process.env.FILES_BUCKET;
  if (!bucket) throw Object.assign(new Error('FILES_BUCKET is not configured'), { statusCode: 503 });
  const key = s3KeyFor('claim-files', path);
  if (!key) throw Object.assign(new Error(`invalid claim-files path: ${path}`), { statusCode: 400 });
  const s3 = deps.s3 || new S3Client({ region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1' });
  const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const chunks = [];
  for await (const chunk of out.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const assertCompliantJpeg = async (bytes, side) => {
  if (!bytes || !bytes.length) {
    return failCheckAltImageCompliance(side, `${side}_missing`);
  }
  if (isSvgBytes(bytes) || !isJpegMagic(bytes)) {
    return failCheckAltImageCompliance(side, `${side}_invalid_jpeg`);
  }
  const report = evaluateCheckAltImageCompliance(bytes, side);
  if (!report.pass) {
    return failCheckAltImageCompliance(side, report.reason, {
      width: report.width,
      height: report.height,
      bytes: report.bytes,
    });
  }
  return { ok: true, bytes, report };
};

export async function loadProductionDepositImages(check, body = {}, deps = {}) {
  if (body.frontImage || body.rearImage || body.front_image || body.rear_image) {
    return imageFail('untrusted_image_bytes', {
      statusCode: 400,
      message: 'Browser-supplied image bytes are ignored. Server loads deposit JPEGs from S3.',
    });
  }

  const resolved = resolveCheckAltArtifactPaths(check, body);
  if (!resolved.front || !isCheckAltArtifactPath(resolved.front)) {
    return failCheckAltImageCompliance('front', 'front_missing');
  }
  if (!resolved.rear || !isCheckAltArtifactPath(resolved.rear)) {
    return failCheckAltImageCompliance('rear', 'rear_missing');
  }
  if (!isAllowedCheckAltArtifactPath(check, resolved.front)) {
    return imageFail('prepared_path_denied', { statusCode: 403, side: 'front' });
  }
  if (!isAllowedCheckAltArtifactPath(check, resolved.rear)) {
    return imageFail('prepared_path_denied', { statusCode: 403, side: 'back' });
  }

  const frontBytes = await downloadClaimFileBytes(resolved.front, deps);
  const front = await assertCompliantJpeg(frontBytes, 'front');
  if (!front.ok) return front;

  const rearBytes = await downloadClaimFileBytes(resolved.rear, deps);
  const rear = await assertCompliantJpeg(rearBytes, 'rear');
  if (!rear.ok) return rear;

  const frontImage = bytesToBase64(front.bytes);
  const rearImage = bytesToBase64(rear.bytes);
  if (frontImage.length + rearImage.length > MAX_TOTAL_B64_CHARS) {
    return imageFail('images_too_large', {
      error: CHECKALT_IMAGE_ERROR,
      message: 'Combined check images exceed CheckAlt payload limit.',
    });
  }

  return {
    ok: true,
    frontImage,
    rearImage,
    frontPath: resolved.front,
    rearPath: resolved.rear,
    frontSha256: sha256(front.bytes),
    rearSha256: sha256(rear.bytes),
    imagePipeline: 'checkalt_official_canvas_base64',
    compliance: {
      error: null,
      front: front.report,
      rear: rear.report,
      overall: 'PASS',
    },
  };
}
