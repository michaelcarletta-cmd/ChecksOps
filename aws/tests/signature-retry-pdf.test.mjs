import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { PDFDocument, rgb } from 'pdf-lib';
import {
  handleRetryPdfGeneration,
  reconstructRetrySignersWithValues,
  runRetryPdfGeneration,
} from '../functions/api/documents.mjs';
import { stampSignaturePdf } from '../functions/api/signature-submit.mjs';

const DOC_SRC = readFileSync(new URL('../functions/api/documents.mjs', import.meta.url), 'utf8');
const PLACEMENT_A = { page: 1, x: 12, y: 78, width: 32, height: 9 };
const PLACEMENT_B = { page: 1, x: 58, y: 22, width: 28, height: 8 };
const MAGENTA = { r: 220, g: 20, b: 160 };
const CYAN = { r: 20, g: 180, b: 210 };
const EDITOR_ID_A = `signature-${1_759_180_000_000}`;
const EDITOR_ID_B = `signature-${1_759_180_000_111}`;
const PERSISTED_ID_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const PERSISTED_ID_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const REQUEST_ID = '6a3ea0f2-51cf-4b68-a3c8-4b194372eb2a';
const CLAIM_ID = '1de2f734-de37-404a-aa3e-d23905f7a6ea';

const makeSignaturePng = (color = MAGENTA, width = 400, height = 90) => {
  const png = new PNG({ width, height });
  const set = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const idx = (width * y + x) << 2;
    png.data[idx] = color.r;
    png.data[idx + 1] = color.g;
    png.data[idx + 2] = color.b;
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
  stroke(20, height - 30, 70, 30);
  stroke(70, 30, Math.min(width - 80, 180), 25);
  stroke(40, Math.round(height / 2), width - 40, Math.round(height / 2) + 4, 2);
  return PNG.sync.write(png);
};

const signatureDataUri = (color = MAGENTA, width = 400, height = 90) => (
  `data:image/png;base64,${makeSignaturePng(color, width, height).toString('base64')}`
);

const makeSourcePdf = async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  page.drawRectangle({ x: 0, y: 0, width: 612, height: 792, color: rgb(1, 1, 1) });
  page.drawText('RETRY SOURCE', { x: 72, y: 720, size: 18 });
  return Buffer.from(await doc.save());
};

const fieldBoxPdf = (pageWidth, pageHeight, field) => {
  const x = (Number(field.x) / 100) * pageWidth;
  const h = ((Number(field.height) || 5) / 100) * pageHeight;
  const y = pageHeight - ((Number(field.y) / 100) * pageHeight) - h;
  const w = (Number(field.width) / 100) * pageWidth;
  return { x, y, w, h };
};

const countColorPixels = (pngBytes, box, color) => {
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
      const isColor = a > 80
        && Math.abs(r - color.r) < 50
        && Math.abs(g - color.g) < 50
        && Math.abs(b - color.b) < 50;
      if (!isColor) continue;
      const inside = x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
      if (inside) inBox += 1;
      else outBox += 1;
    }
  }
  return { inBox, outBox };
};

const rasterize = (pdfBytes, prefix) => {
  const dir = mkdtempSync(join(tmpdir(), 'sig-retry-'));
  const pdfPath = join(dir, 'doc.pdf');
  writeFileSync(pdfPath, pdfBytes);
  const result = spawnSync('pdftoppm', ['-png', '-r', '144', pdfPath, join(dir, prefix)], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`pdftoppm failed: ${result.stderr || result.stdout || result.status}`);
  }
  return readFileSync(join(dir, `${prefix}-1.png`));
};

const rasterBox = (page, field, scale = 144 / 72) => {
  const box = fieldBoxPdf(page.getWidth(), page.getHeight(), field);
  return {
    left: (box.x * scale) - 6,
    right: ((box.x + box.w) * scale) + 6,
    top: ((page.getHeight() - box.y - box.h) * scale) - 6,
    bottom: ((page.getHeight() - box.y) * scale) + 6,
  };
};

const completedRequest = {
  id: REQUEST_ID,
  status: 'completed',
  document_name: 'Third-Party-Auth-Form.pdf',
  document_path: 'docs/source.pdf',
  field_data: [
    { id: EDITOR_ID_A, type: 'signature', signerIndex: 0, ...PLACEMENT_A },
  ],
  claim_id: CLAIM_ID,
  check_intake_item_id: null,
  final_pdf_path: null,
  completion_status: 'failed',
  last_error: 'PDF attach failed: no_signature_image_to_stamp',
};

const retryClient = ({
  request = completedRequest,
  signers = [{
    id: 's1',
    signer_name: 'Ada',
    signing_order: 1,
    token_hash: 'abc',
    status: 'signed',
    field_values: { [EDITOR_ID_A]: signatureDataUri() },
  }],
  fields = [{
    id: PERSISTED_ID_A,
    signer_index: 0,
    field_type: 'signature',
    label: 'Sign',
    ...PLACEMENT_A,
  }],
  valueRows = [],
  onUpdate,
} = {}) => {
  const sqls = [];
  return {
    sqls,
    query: async (sql, params = []) => {
      sqls.push({ sql, params });
      if (String(sql).includes('FROM public.signature_requests')) {
        return { rows: request ? [request] : [] };
      }
      if (String(sql).includes('FROM public.signature_signers')) {
        return { rows: signers };
      }
      if (String(sql).includes('FROM public.signature_fields')) {
        return { rows: fields };
      }
      if (String(sql).includes('signature_field_values')) {
        return { rows: valueRows };
      }
      if (String(sql).includes('aws_public_signature_attach_signed')) {
        return { rows: [{ doc: { ok: true, final_pdf_path: params[1] } }] };
      }
      if (String(sql).includes('UPDATE public.signature_requests')) {
        if (typeof onUpdate === 'function') return onUpdate(sql, params);
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected sql: ${sql}`);
    },
  };
};

test('retry source no longer writes certificate_pdf_path or a dummy certificate', () => {
  assert.equal(DOC_SRC.includes('certificate_pdf_path'), false);
  assert.equal(DOC_SRC.includes('Signature certificate (staging retry)'), false);
  assert.match(DOC_SRC, /reconstructRetrySignersWithValues/);
  assert.match(DOC_SRC, /attachCompletedSignatureDocument/);
  assert.match(DOC_SRC, /final_pdf_path/);
  assert.match(DOC_SRC, /completion_status = 'completed'/);
  assert.doesNotMatch(DOC_SRC, /\.catch\(\(\) => \{\}\)/);
});

test('successful completed-request regeneration uses persisted association and commits final_pdf_path', async () => {
  process.env.FILES_BUCKET = 'test-files-bucket';
  const pngUri = signatureDataUri(MAGENTA, 400, 90);
  const original = await makeSourcePdf();
  let putBody = null;
  const client = retryClient({
    signers: [{
      id: 's1',
      signer_name: 'Ada',
      signing_order: 1,
      token_hash: 'abc',
      status: 'signed',
      field_values: { [EDITOR_ID_A]: pngUri },
    }],
  });
  const s3 = {
    send: async (cmd) => {
      if (cmd.constructor?.name === 'GetObjectCommand') {
        return { Body: { transformToByteArray: async () => original } };
      }
      if (cmd.constructor?.name === 'PutObjectCommand') {
        putBody = cmd.input.Body;
        return {};
      }
      return {};
    },
  };

  const result = await runRetryPdfGeneration({
    client,
    body: { requestId: REQUEST_ID },
    spoof: [],
  }, { s3 });

  assert.equal(result.ok, true);
  assert.equal(result.final_pdf_path, `signed/${CLAIM_ID}/${REQUEST_ID}-final.pdf`);
  const update = client.sqls.find((row) => String(row.sql).includes('UPDATE public.signature_requests'));
  assert.ok(update, 'must update final_pdf_path');
  assert.equal(update.params[0], REQUEST_ID);
  assert.equal(update.params[1], result.final_pdf_path);
  assert.equal(String(update.sql).includes('certificate_pdf_path'), false);
  assert.match(String(update.sql), /completion_status = 'completed'/);
  assert.match(String(update.sql), /last_error = NULL/);
  assert.ok(putBody, 'must put the stamped PDF');
  const stamped = Buffer.from(putBody);
  assert.match(stamped.toString('latin1'), /\/Width 400/);
  const srcDoc = await PDFDocument.load(original);
  const raster = rasterize(stamped, 'retry-ok');
  const pixels = countColorPixels(raster, rasterBox(srcDoc.getPages()[0], PLACEMENT_A), MAGENTA);
  assert.ok(pixels.inBox > 80, `expected signature in persisted box, got ${pixels.inBox}`);
});

test('correct field placement and multiple-field isolation', () => {
  const magenta = signatureDataUri(MAGENTA, 400, 90);
  const cyan = signatureDataUri(CYAN, 220, 70);
  const reconstructed = reconstructRetrySignersWithValues({
    signers: [
      { id: 's1', signing_order: 1, field_values: { [EDITOR_ID_A]: magenta } },
      { id: 's2', signing_order: 2, field_values: { [EDITOR_ID_B]: cyan } },
    ],
    fields: [
      { id: PERSISTED_ID_A, field_type: 'signature', signer_index: 0, ...PLACEMENT_A },
      { id: PERSISTED_ID_B, field_type: 'signature', signer_index: 1, ...PLACEMENT_B },
    ],
    valueRows: [],
    fieldData: [
      { id: EDITOR_ID_A, type: 'signature', signerIndex: 0, ...PLACEMENT_A },
      { id: EDITOR_ID_B, type: 'signature', signerIndex: 1, ...PLACEMENT_B },
    ],
  });
  assert.equal(reconstructed[0].field_values[PERSISTED_ID_A].value, magenta);
  assert.equal(reconstructed[0].field_values[PERSISTED_ID_A].x, PLACEMENT_A.x);
  assert.equal(reconstructed[0].field_values[PERSISTED_ID_A].y, PLACEMENT_A.y);
  assert.equal(reconstructed[1].field_values[PERSISTED_ID_B].value, cyan);
  assert.equal(reconstructed[1].field_values[PERSISTED_ID_B].x, PLACEMENT_B.x);
  assert.equal(reconstructed[0].field_values[PERSISTED_ID_B], undefined);
  assert.equal(reconstructed[1].field_values[PERSISTED_ID_A], undefined);

  assert.throws(
    () => reconstructRetrySignersWithValues({
      signers: [{ id: 's1', signing_order: 1, field_values: { 'signature-unrelated': magenta } }],
      fields: [
        { id: PERSISTED_ID_A, field_type: 'signature', signer_index: 0, ...PLACEMENT_A },
        { id: PERSISTED_ID_B, field_type: 'signature', signer_index: 0, ...PLACEMENT_B },
      ],
      fieldData: [
        { id: EDITOR_ID_A, type: 'signature', signerIndex: 0, ...PLACEMENT_A },
        { id: EDITOR_ID_B, type: 'signature', signerIndex: 0, ...PLACEMENT_B },
      ],
    }),
    /missing_signature_image|cannot_associate_signature_image/,
  );
});

test('stamped retry keeps each signature in its own persisted box', async () => {
  const magenta = signatureDataUri(MAGENTA, 400, 90);
  const cyan = signatureDataUri(CYAN, 220, 70);
  const signers = reconstructRetrySignersWithValues({
    signers: [{
      id: 's1',
      signing_order: 1,
      field_values: { [EDITOR_ID_A]: magenta, [EDITOR_ID_B]: cyan },
    }],
    fields: [
      { id: PERSISTED_ID_A, field_type: 'signature', signer_index: 0, ...PLACEMENT_A },
      { id: PERSISTED_ID_B, field_type: 'signature', signer_index: 0, ...PLACEMENT_B },
    ],
    fieldData: [
      { id: EDITOR_ID_A, type: 'signature', signerIndex: 0, ...PLACEMENT_A },
      { id: EDITOR_ID_B, type: 'signature', signerIndex: 0, ...PLACEMENT_B },
    ],
  });
  const original = await makeSourcePdf();
  const stamped = Buffer.from(await stampSignaturePdf(original, signers));
  const srcDoc = await PDFDocument.load(original);
  const page = srcDoc.getPages()[0];
  const raster = rasterize(stamped, 'retry-iso');
  const aMagenta = countColorPixels(raster, rasterBox(page, PLACEMENT_A), MAGENTA);
  const bCyan = countColorPixels(raster, rasterBox(page, PLACEMENT_B), CYAN);
  const aCyan = countColorPixels(raster, rasterBox(page, PLACEMENT_A), CYAN);
  const bMagenta = countColorPixels(raster, rasterBox(page, PLACEMENT_B), MAGENTA);
  assert.ok(aMagenta.inBox > 80);
  assert.ok(bCyan.inBox > 80);
  assert.ok(aCyan.inBox < 20);
  assert.ok(bMagenta.inBox < 20);
});

test('missing signature value fails closed', async () => {
  const result = await runRetryPdfGeneration({
    client: retryClient({
      signers: [{ id: 's1', signing_order: 1, token_hash: 'abc', field_values: {} }],
    }),
    body: { requestId: REQUEST_ID },
    spoof: [],
  });
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 400);
  assert.match(result.error, /missing_signature_image|cannot_associate_signature_image|insufficient_signature_data/);
});

test('nonexistent request returns 404', async () => {
  const result = await runRetryPdfGeneration({
    client: retryClient({ request: null }),
    body: { requestId: REQUEST_ID },
    spoof: [],
  });
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 404);
  assert.equal(result.error, 'request_not_found');
});

test('SQL update failure is not swallowed', async () => {
  process.env.FILES_BUCKET = 'test-files-bucket';
  const original = await makeSourcePdf();
  const client = retryClient({
    onUpdate: () => {
      const error = new Error('column does not exist');
      error.code = '42703';
      throw error;
    },
  });
  await assert.rejects(
    () => runRetryPdfGeneration({
      client,
      body: { requestId: REQUEST_ID },
      spoof: [],
    }, {
      s3: {
        send: async (cmd) => {
          if (cmd.constructor?.name === 'GetObjectCommand') {
            return { Body: { transformToByteArray: async () => original } };
          }
          return {};
        },
      },
    }),
    /column does not exist/,
  );
});

test('handleRetryPdfGeneration only reports success after commit', async () => {
  let committed = false;
  const result = await handleRetryPdfGeneration(
    { body: JSON.stringify({ requestId: REQUEST_ID }) },
    {
      withIdentity: async (_event, fn, opts) => {
        assert.equal(opts.write, true);
        assert.equal(opts.commit, true);
        const inner = await fn({
          client: retryClient(),
          body: { requestId: REQUEST_ID },
          spoof: [],
        });
        if (inner?.ok !== false && Number(inner?.statusCode || 200) < 400) {
          committed = true;
        }
        return inner;
      },
      attachCompletedSignatureDocument: async () => ({
        final_pdf_path: `signed/${CLAIM_ID}/${REQUEST_ID}-final.pdf`,
      }),
    },
  );
  assert.equal(result.ok, true);
  assert.equal(committed, true);
});

test('handleRetryPdfGeneration does not commit when the inner handler fails', async () => {
  let committed = false;
  const result = await handleRetryPdfGeneration(
    { body: JSON.stringify({ requestId: REQUEST_ID }) },
    {
      withIdentity: async (_event, fn, opts) => {
        const inner = await fn({
          client: retryClient({ request: null }),
          body: { requestId: REQUEST_ID },
          spoof: [],
        });
        if (opts.commit && inner?.ok !== false && Number(inner?.statusCode || 200) < 400) {
          committed = true;
        }
        return inner;
      },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(committed, false);
});
