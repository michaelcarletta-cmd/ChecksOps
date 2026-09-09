import {
  inspectOriented,
  isAllowedPreparedPath,
  isAlreadyDepositReady,
  isJpegMagic,
  isRasterPath,
} from '../parity/checkalt-image.mjs';

const isSvgPath = (path) => /\.svg(\?|$)/i.test(String(path || ''));
const isSvgBytes = (bytes) => {
  if (!bytes || !bytes.length) return false;
  const head = Buffer.from(bytes).subarray(0, 64).toString('utf8').trim().toLowerCase();
  return head.startsWith('<svg') || head.includes('<svg');
};

export const MAX_TOTAL_B64_CHARS = 1_600_000;

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

const assertDepositJpeg = async (bytes, side) => {
  if (!bytes || !bytes.length) {
    return imageFail(`${side}_image_missing`, {
      side,
      message: `${side} deposit JPEG is missing. Fail closed before CheckAlt HTTP.`,
    });
  }
  if (isSvgBytes(bytes)) {
    return imageFail(`${side}_image_svg`, {
      side,
      message: `${side} image is SVG. CheckAlt requires a deposit-ready JPEG.`,
    });
  }
  if (!isJpegMagic(bytes)) {
    return imageFail(`${side}_image_not_jpeg`, {
      side,
      message: `${side} prepared image is not a JPEG.`,
    });
  }
  const info = await inspectOriented(bytes);
  if (!isAlreadyDepositReady(info)) {
    return imageFail('browser_prepare_required', {
      side,
      message: `${side} check image must be a deposit-ready JPEG before submission.`,
    });
  }
  return { ok: true, bytes, info };
};

export async function loadProductionDepositImages(check, body = {}, deps = {}) {
  if (body.frontImage || body.rearImage || body.front_image || body.rear_image) {
    return imageFail('untrusted_image_bytes', {
      statusCode: 400,
      message: 'Browser-supplied image bytes are ignored. Server loads deposit JPEGs from S3.',
    });
  }
  const depositFrontPath = body.deposit_front_path || null;
  const depositBackPath = body.deposit_back_path || null;
  if (depositFrontPath && !isAllowedPreparedPath(check, depositFrontPath)) {
    return imageFail('prepared_path_denied', { statusCode: 403, side: 'front' });
  }
  if (depositBackPath && !isAllowedPreparedPath(check, depositBackPath)) {
    return imageFail('prepared_path_denied', { statusCode: 403, side: 'back' });
  }

  const frontPath = depositFrontPath || check.front_image_path;
  if (!frontPath || isSvgPath(frontPath)) {
    return imageFail('front_image_missing', { side: 'front' });
  }
  const frontBytes = await downloadClaimFileBytes(frontPath, deps);
  const front = await assertDepositJpeg(frontBytes, 'front');
  if (!front.ok) return front;

  const rearPath = depositBackPath || check.back_image_deposit_path || null;
  if (!rearPath || isSvgPath(rearPath) || (!isRasterPath(rearPath) && !/\.jpe?g(\?|$)/i.test(rearPath))) {
    return imageFail('rear_image_missing', {
      side: 'back',
      message: 'Rear deposit JPEG is missing, SVG-only, or not deposit-ready. Fail closed before CheckAlt HTTP.',
    });
  }
  const rearBytes = await downloadClaimFileBytes(rearPath, deps);
  const rear = await assertDepositJpeg(rearBytes, 'rear');
  if (!rear.ok) return rear;

  const frontImage = Buffer.from(front.bytes).toString('base64');
  const rearImage = Buffer.from(rear.bytes).toString('base64');
  if (frontImage.length + rearImage.length > MAX_TOTAL_B64_CHARS) {
    return imageFail('images_too_large', {
      message: 'Combined check images exceed CheckAlt payload limit.',
    });
  }
  return {
    ok: true,
    frontImage,
    rearImage,
    frontPath,
    rearPath,
    imagePipeline: 'browser_prepare_aws_base64',
  };
}
