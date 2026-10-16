import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { PDFDocument, rgb } from 'pdf-lib';
import {
  attachCompletedSignatureDocument,
  mergeSignerFieldValues,
  stampSignaturePdf,
} from '../functions/api/signature-submit.mjs';

const PLACEMENT = { page: 1, x: 12, y: 78, width: 32, height: 9 };
const SIG_COLOR = { r: 220, g: 20, b: 160 };

export const makeSignaturePng = () => {
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

const signatureDataUri = () => `data:image/png;base64,${makeSignaturePng().toString('base64')}`;

const makeSourcePdf = async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  page.drawRectangle({ x: 0, y: 0, width: 612, height: 792, color: rgb(1, 1, 1) });
  page.drawText('FIXTURE SOURCE', { x: 72, y: 720, size: 18 });
  return Buffer.from(await doc.save());
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

const rasterize = (pdfBytes, prefix) => {
  const dir = mkdtempSync(join(tmpdir(), 'sig-stamp-'));
  const pdfPath = join(dir, 'doc.pdf');
  writeFileSync(pdfPath, pdfBytes);
  const result = spawnSync('pdftoppm', ['-png', '-r', '144', pdfPath, join(dir, prefix)], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`pdftoppm failed: ${result.stderr || result.stdout || result.status}`);
  }
  return readFileSync(join(dir, `${prefix}-1.png`));
};

test('mergeSignerFieldValues joins raw values with persisted placement', () => {
  const merged = mergeSignerFieldValues(
    [{ id: 's1', signing_order: 1, field_values: { sig: signatureDataUri() } }],
    [{ id: 'sig', signer_index: 0, field_type: 'signature', ...PLACEMENT }],
    [],
  );
  assert.equal(merged[0].field_values.sig.field_type, 'signature');
  assert.equal(merged[0].field_values.sig.x, PLACEMENT.x);
  assert.equal(merged[0].field_values.sig.y, PLACEMENT.y);
  assert.equal(merged[0].field_values.sig.value.startsWith('data:image/png'), true);
});

test('stampSignaturePdf writes a visible signature at stored coordinates', async () => {
  const original = await makeSourcePdf();
  const originalCopy = Buffer.from(original);
  const signers = mergeSignerFieldValues(
    [{ id: 's1', signing_order: 1, field_values: { sig: signatureDataUri() } }],
    [{ id: 'sig', signer_index: 0, field_type: 'signature', ...PLACEMENT }],
    [],
  );
  const stamped = Buffer.from(await stampSignaturePdf(original, signers));
  assert.notEqual(stamped.equals(original), true);
  assert.equal(original.equals(originalCopy), true);
  const srcDoc = await PDFDocument.load(original);
  const outDoc = await PDFDocument.load(stamped);
  assert.equal(outDoc.getPageCount(), srcDoc.getPageCount());
  assert.equal(outDoc.getPageCount(), 1);
  const srcImages = String(original.toString('latin1')).match(/\/Subtype\s*\/Image/g)?.length || 0;
  const outImages = String(stamped.toString('latin1')).match(/\/Subtype\s*\/Image/g)?.length || 0;
  assert.ok(outImages > srcImages, `stamped images ${outImages} should exceed source ${srcImages}`);
  assert.match(stamped.toString('latin1'), /\/Subtype\s*\/Image[\s\S]{0,160}\/Width 400/);

  const page = srcDoc.getPages()[0];
  const box = fieldBoxPdf(page.getWidth(), page.getHeight(), PLACEMENT);
  const scale = 144 / 72;
  const raster = rasterize(stamped, 'stamped');
  const pixels = countSignaturePixels(raster, {
    left: (box.x * scale) - 6,
    right: ((box.x + box.w) * scale) + 6,
    top: ((page.getHeight() - box.y - box.h) * scale) - 6,
    bottom: ((page.getHeight() - box.y) * scale) + 6,
  });
  assert.ok(pixels.inBox > 80, `expected signature pixels in field box, got ${pixels.inBox}`);
  assert.ok(pixels.outBox < pixels.inBox * 0.25, `signature leaked outside field: in=${pixels.inBox} out=${pixels.outBox}`);
});

test('stampSignaturePdf refuses to emit an unstamped copy', async () => {
  const original = await makeSourcePdf();
  await assert.rejects(
    () => stampSignaturePdf(original, [{ field_values: { name: { field_type: 'text', value: 'Ada', page: 1, x: 10, y: 10, width: 20, height: 5 } } }]),
    /no_signature_image_to_stamp/,
  );
});

test('attachCompletedSignatureDocument puts stamped bytes and keeps attach_signed linkage', async () => {
  process.env.FILES_BUCKET = 'test-files-bucket';
  const original = await makeSourcePdf();
  const originalHash = createHash('sha256').update(original).digest('hex');
  const sent = [];
  const destRel = 'signed/claim-1/req-1-final.pdf';
  const s3 = {
    send: async (cmd) => {
      sent.push(cmd.constructor?.name || cmd.name || 'cmd');
      if (cmd.constructor?.name === 'GetObjectCommand') {
        return { Body: { transformToByteArray: async () => original } };
      }
      if (cmd.constructor?.name === 'PutObjectCommand') {
        sent.put = cmd.input;
        return {};
      }
      return {};
    },
  };
  const sqls = [];
  const client = {
    query: async (sql, params) => {
      sqls.push({ sql, params });
      if (String(sql).includes('signature_signers')) {
        return { rows: [{ id: 's1', signing_order: 1, field_values: { sig: signatureDataUri() } }] };
      }
      if (String(sql).includes('FROM public.signature_fields')) {
        return { rows: [{ id: 'sig', signer_index: 0, field_type: 'signature', ...PLACEMENT }] };
      }
      if (String(sql).includes('signature_field_values')) {
        return { rows: [] };
      }
      if (String(sql).includes('aws_public_signature_attach_signed')) {
        return { rows: [{ doc: { ok: true, final_pdf_path: params[1], original_path: 'docs/source.pdf' } }] };
      }
      return { rows: [] };
    },
  };

  const result = await attachCompletedSignatureDocument(client, {
    id: 'req-1',
    claim_id: 'claim-1',
    document_path: 'docs/source.pdf',
    token_hash: 'abc',
    final_rel: destRel,
  }, { s3 });

  assert.equal(result.final_pdf_path, destRel);
  assert.equal(sent.includes('CopyObjectCommand'), false);
  assert.ok(sent.put, 'PutObject must run');
  assert.equal(sent.put.Key, 'files/claim-files/signed/claim-1/req-1-final.pdf');
  assert.equal(sent.put.ContentType, 'application/pdf');
  const stamped = Buffer.from(sent.put.Body);
  assert.notEqual(createHash('sha256').update(stamped).digest('hex'), originalHash);
  assert.equal(createHash('sha256').update(original).digest('hex'), originalHash);
  const stampedDoc = await PDFDocument.load(stamped);
  assert.equal(stampedDoc.getPageCount(), 1);
  const attachCall = sqls.find((row) => String(row.sql).includes('aws_public_signature_attach_signed'));
  assert.deepEqual(attachCall.params, ['abc', destRel]);
});
