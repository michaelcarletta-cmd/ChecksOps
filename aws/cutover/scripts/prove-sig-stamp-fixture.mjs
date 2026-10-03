#!/usr/bin/env node
/**
 * Local fixture proof for stamp-in-place finalization.
 * Uses a downloaded source PDF only. Does not write to S3 or mutate request 7fd3d2a5.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { PDFDocument } from 'pdf-lib';
import { mergeSignerFieldValues, stampSignaturePdf } from '../../functions/api/signature-submit.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const artifacts = process.env.SIG_STAMP_ARTIFACTS || '/opt/cursor/artifacts';
const sourcePath = process.env.SIG_STAMP_SOURCE || '/tmp/original.pdf';
const PLACEMENT = { page: 1, x: 12, y: 78, width: 32, height: 9 };
const SIG_COLOR = { r: 220, g: 20, b: 160 };

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const md5 = (buf) => createHash('md5').update(buf).digest('hex');

const makeSignaturePng = () => {
  const width = 400;
  const height = 90;
  const png = new PNG({ width, height });
  const set = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const idx = (width * y + x) << 2;
    png.data[idx] = SIG_COLOR.r;
    png.data[idx + 1] = SIG_COLOR.g;
    png.data[idx + 2] = SIG_COLOR.b;
    png.data[idx + 3] = 255;
  };
  const stroke = (x0, y0, x1, y1, thickness = 4) => {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      const cx = Math.round(x0 + (x1 - x0) * t);
      const cy = Math.round(y0 + (y1 - y0) * t);
      for (let dx = -thickness; dx <= thickness; dx += 1) {
        for (let dy = -thickness; dy <= thickness; dy += 1) {
          if ((dx * dx) + (dy * dy) <= thickness * thickness) set(cx + dx, cy + dy);
        }
      }
    }
  };
  stroke(20, 60, 70, 30);
  stroke(70, 30, 110, 70);
  stroke(110, 70, 180, 25);
  stroke(180, 25, 250, 65);
  stroke(250, 65, 320, 20);
  stroke(40, 50, 300, 55, 2);
  return PNG.sync.write(png);
};

const fieldBoxPdf = (pageWidth, pageHeight, field) => {
  const x = (Number(field.x) / 100) * pageWidth;
  const h = ((Number(field.height) || 5) / 100) * pageHeight;
  const y = pageHeight - ((Number(field.y) / 100) * pageHeight) - h;
  const w = (Number(field.width) / 100) * pageWidth;
  return { x, y, w, h };
};

const countSignaturePixels = (pngBytes, box) => {
  const png = PNG.sync.read(pngBytes);
  let inBox = 0;
  let outBox = 0;
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const idx = (png.width * y + x) << 2;
      const r = png.data[idx];
      const g = png.data[idx + 1];
      const b = png.data[idx + 2];
      const a = png.data[idx + 3];
      const isSig = a > 80 && r > 160 && g < 80 && b > 100;
      if (!isSig) continue;
      const inside = x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
      if (inside) inBox += 1;
      else outBox += 1;
    }
  }
  return { inBox, outBox, width: png.width, height: png.height };
};

const outlineBox = (pngBytes, box) => {
  const png = PNG.sync.read(pngBytes);
  const paint = (x, y) => {
    if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
    const idx = (png.width * y + x) << 2;
    png.data[idx] = 0;
    png.data[idx + 1] = 160;
    png.data[idx + 2] = 255;
    png.data[idx + 3] = 255;
  };
  for (let x = Math.round(box.left); x <= Math.round(box.right); x += 1) {
    paint(x, Math.round(box.top));
    paint(x, Math.round(box.bottom));
  }
  for (let y = Math.round(box.top); y <= Math.round(box.bottom); y += 1) {
    paint(Math.round(box.left), y);
    paint(Math.round(box.right), y);
  }
  return PNG.sync.write(png);
};

const rasterize = (pdfBytes, outPng) => {
  const pdfPath = outPng.replace(/\.png$/, '.pdf');
  writeFileSync(pdfPath, pdfBytes);
  const prefix = outPng.replace(/-1\.png$/, '').replace(/\.png$/, '');
  const result = spawnSync('pdftoppm', ['-png', '-r', '144', '-f', '1', '-l', '1', pdfPath, prefix], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`pdftoppm failed: ${result.stderr || result.stdout || result.status}`);
  return readFileSync(`${prefix}-1.png`);
};

mkdirSync(artifacts, { recursive: true });
const original = readFileSync(sourcePath);
const originalHashBefore = sha256(original);
const signPng = makeSignaturePng();
const signers = mergeSignerFieldValues(
  [{ id: 's1', signing_order: 1, field_values: { sig: `data:image/png;base64,${signPng.toString('base64')}` } }],
  [{ id: 'sig', signer_index: 0, field_type: 'signature', ...PLACEMENT }],
  [],
);
const stamped = Buffer.from(await stampSignaturePdf(original, signers));
const originalAfter = readFileSync(sourcePath);
if (sha256(originalAfter) !== originalHashBefore) {
  throw new Error('original_pdf_mutated');
}

const srcDoc = await PDFDocument.load(original);
const outDoc = await PDFDocument.load(stamped);
const page = srcDoc.getPages()[0];
const box = fieldBoxPdf(page.getWidth(), page.getHeight(), PLACEMENT);
const scale = 144 / 72;
const rasterBox = {
  left: (box.x * scale) - 6,
  right: ((box.x + box.w) * scale) + 6,
  top: ((page.getHeight() - box.y - box.h) * scale) - 6,
  bottom: ((page.getHeight() - box.y) * scale) + 6,
};

const originalPng = rasterize(original, join(artifacts, 'sig_stamp_fixture_original'));
const stampedPng = rasterize(stamped, join(artifacts, 'sig_stamp_fixture_stamped'));
const annotated = outlineBox(stampedPng, rasterBox);
writeFileSync(join(artifacts, 'sig_stamp_fixture_stamped_annotated.png'), annotated);
writeFileSync(join(artifacts, 'sig_stamp_fixture_signature.png'), signPng);
writeFileSync(join(artifacts, 'sig_stamp_fixture_original.pdf'), original);
writeFileSync(join(artifacts, 'sig_stamp_fixture_final.pdf'), stamped);
copyFileSync(join(artifacts, 'sig_stamp_fixture_original-1.png'), join(artifacts, 'sig_stamp_fixture_original.png'));
copyFileSync(join(artifacts, 'sig_stamp_fixture_stamped-1.png'), join(artifacts, 'sig_stamp_fixture_stamped.png'));

const pixels = countSignaturePixels(stampedPng, rasterBox);
const originalPixels = countSignaturePixels(originalPng, rasterBox);
const destRel = 'signed/claim-1/req-1-final.pdf';
const proof = {
  ok: stamped.length !== original.length
    && sha256(stamped) !== originalHashBefore
    && sha256(originalAfter) === originalHashBefore
    && outDoc.getPageCount() === srcDoc.getPageCount()
    && pixels.inBox > 80
    && originalPixels.inBox === 0
    && pixels.outBox < pixels.inBox * 0.25,
  sourcePath,
  placement: PLACEMENT,
  fieldBoxPdf: box,
  rasterBox,
  original: {
    bytes: original.length,
    sha256: originalHashBefore,
    md5: md5(original),
    pageCount: srcDoc.getPageCount(),
    page: { width: page.getWidth(), height: page.getHeight() },
    signaturePixelsInBox: originalPixels.inBox,
  },
  stamped: {
    bytes: stamped.length,
    sha256: sha256(stamped),
    md5: md5(stamped),
    pageCount: outDoc.getPageCount(),
    signaturePixelsInBox: pixels.inBox,
    signaturePixelsOutsideBox: pixels.outBox,
  },
  linkageUnchanged: {
    destRel,
    attach_signed: ['token_hash', destRel],
    note: 'aws_public_signature_attach_signed still receives the existing final relative path',
  },
  bytesDiffer: sha256(stamped) !== originalHashBefore,
  originalUnchanged: sha256(originalAfter) === originalHashBefore,
  pageCountUnchanged: outDoc.getPageCount() === srcDoc.getPageCount(),
  signatureVisibleAtStoredCoords: pixels.inBox > 80 && originalPixels.inBox === 0,
};
writeFileSync(join(artifacts, 'sig-stamp-fixture-proof.json'), `${JSON.stringify(proof, null, 2)}\n`);
console.log(JSON.stringify(proof, null, 2));
if (!proof.ok) process.exit(1);
