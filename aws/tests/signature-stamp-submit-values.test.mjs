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
  buildSubmitSignersWithValues,
  mapSubmittedFieldValues,
  mergeSignerFieldValues,
  runPublicSignatureSubmit,
  shouldStampSignatureImage,
  stampSignaturePdf,
} from '../functions/api/signature-submit.mjs';

const PLACEMENT_A = { page: 1, x: 12, y: 78, width: 32, height: 9 };
const PLACEMENT_B = { page: 1, x: 58, y: 22, width: 28, height: 8 };
const MAGENTA = { r: 220, g: 20, b: 160 };
const CYAN = { r: 20, g: 180, b: 210 };

const EDITOR_ID_A = `signature-${1_759_180_000_000}`;
const EDITOR_ID_B = `signature-${1_759_180_000_111}`;
const PERSISTED_ID_A = '6a3ea0f2-51cf-4b68-a3c8-4b194372eb2a';
const PERSISTED_ID_B = '9c1e2d3a-44b0-4f11-9a77-0f0e1d2c3b4a';

export const makeSignaturePng = (color = MAGENTA, width = 400, height = 90) => {
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
  stroke(70, 30, 110, height - 20);
  stroke(110, height - 20, Math.min(width - 80, 180), 25);
  stroke(Math.min(width - 80, 180), 25, Math.min(width - 40, 250), height - 25);
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
  return { inBox, outBox, width: png.width, height: png.height };
};

const rasterize = (pdfBytes, prefix) => {
  const dir = mkdtempSync(join(tmpdir(), 'sig-stamp-submit-'));
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

test('1-5 editor signature-<timestamp> maps to persisted UUID with submitted PNG and lookup coordinates', () => {
  const pngUri = signatureDataUri(MAGENTA, 400, 90);
  const fields = [{
    id: PERSISTED_ID_A,
    field_type: 'signature',
    label: 'Insured signature',
    signer_index: 0,
    ...PLACEMENT_A,
  }];
  const fieldData = [{
    id: EDITOR_ID_A,
    type: 'signature',
    signerIndex: 0,
    label: 'Insured signature',
    ...PLACEMENT_A,
  }];
  const mapped = mapSubmittedFieldValues(fields, { [EDITOR_ID_A]: pngUri }, fieldData);
  assert.equal(Object.keys(mapped).length, 1);
  assert.equal(mapped[PERSISTED_ID_A].value, pngUri);
  assert.equal(mapped[EDITOR_ID_A], undefined);
  assert.equal(mapped[PERSISTED_ID_A].value.startsWith('data:image/png;base64,'), true);
  assert.equal(mapped[PERSISTED_ID_A].page, PLACEMENT_A.page);
  assert.equal(mapped[PERSISTED_ID_A].x, PLACEMENT_A.x);
  assert.equal(mapped[PERSISTED_ID_A].y, PLACEMENT_A.y);
  assert.equal(mapped[PERSISTED_ID_A].width, PLACEMENT_A.width);
  assert.equal(mapped[PERSISTED_ID_A].height, PLACEMENT_A.height);
  assert.equal(mapped[PERSISTED_ID_A].signatureFieldAssociated, true);
  assert.match(EDITOR_ID_A, /^signature-\d+$/);
  assert.notEqual(EDITOR_ID_A, PERSISTED_ID_A);
});

test('submitted object values still resolve to the PNG data URI', () => {
  const pngUri = signatureDataUri();
  const mapped = mapSubmittedFieldValues(
    [{ id: PERSISTED_ID_A, field_type: 'signature', ...PLACEMENT_A }],
    { [EDITOR_ID_A]: { value: pngUri, field_type: 'signature', x: 99, y: 99, width: 1, height: 1 } },
    [{ id: EDITOR_ID_A, type: 'signature', signerIndex: 0, ...PLACEMENT_A }],
  );
  assert.equal(mapped[PERSISTED_ID_A].value, pngUri);
  assert.equal(mapped[PERSISTED_ID_A].x, PLACEMENT_A.x);
  assert.equal(mapped[PERSISTED_ID_A].y, PLACEMENT_A.y);
});

test('exact persisted UUID match still wins when editor id also exists', () => {
  const byUuid = signatureDataUri(MAGENTA, 400, 90);
  const byEditor = signatureDataUri(CYAN, 220, 70);
  const mapped = mapSubmittedFieldValues(
    [{ id: PERSISTED_ID_A, field_type: 'signature', ...PLACEMENT_A }],
    { [PERSISTED_ID_A]: byUuid, [EDITOR_ID_A]: byEditor },
    [{ id: EDITOR_ID_A, type: 'signature', ...PLACEMENT_A }],
  );
  assert.equal(mapped[PERSISTED_ID_A].value, byUuid);
});

test('6 stamp uses the intended submitted PNG at persisted coordinates, even without field_type', async () => {
  const pngUri = signatureDataUri(MAGENTA, 400, 90);
  const signers = buildSubmitSignersWithValues({
    signer: { id: 's1', signing_order: 1 },
    fields: [{ id: PERSISTED_ID_A, field_type: 'signature', signer_index: 0, ...PLACEMENT_A }],
    fieldValues: { [EDITOR_ID_A]: pngUri },
    fieldData: [{ id: EDITOR_ID_A, type: 'signature', signerIndex: 0, ...PLACEMENT_A }],
  });
  delete signers[0].field_values[PERSISTED_ID_A].field_type;
  assert.equal(signers[0].field_values[PERSISTED_ID_A].field_type, undefined);
  assert.equal(signers[0].field_values[PERSISTED_ID_A].signatureFieldAssociated, true);
  assert.equal(shouldStampSignatureImage(signers[0].field_values[PERSISTED_ID_A]), true);

  const original = await makeSourcePdf();
  const stamped = Buffer.from(await stampSignaturePdf(original, signers));
  assert.match(stamped.toString('latin1'), /\/Subtype\s*\/Image[\s\S]{0,160}\/Width 400/);
  const srcDoc = await PDFDocument.load(original);
  const page = srcDoc.getPages()[0];
  const raster = rasterize(stamped, 'intended');
  const pixels = countColorPixels(raster, rasterBox(page, PLACEMENT_A), MAGENTA);
  assert.ok(pixels.inBox > 80, `expected magenta signature in field box, got ${pixels.inBox}`);
  assert.ok(pixels.outBox < pixels.inBox * 0.25, `signature leaked: in=${pixels.inBox} out=${pixels.outBox}`);
});

test('7 missing or invalid signature image fails safely', async () => {
  const original = await makeSourcePdf();
  await assert.rejects(
    () => stampSignaturePdf(original, [{
      field_values: {
        [PERSISTED_ID_A]: {
          field_type: 'signature',
          signatureFieldAssociated: true,
          value: null,
          ...PLACEMENT_A,
        },
      },
    }]),
    /no_signature_image_to_stamp/,
  );
  await assert.rejects(
    () => stampSignaturePdf(original, [{
      field_values: {
        [PERSISTED_ID_A]: {
          signatureFieldAssociated: true,
          value: 'data:text/plain;base64,QQ==',
          ...PLACEMENT_A,
        },
      },
    }]),
    /no_signature_image_to_stamp/,
  );
  await assert.rejects(
    () => stampSignaturePdf(original, [{
      field_values: {
        [PERSISTED_ID_A]: {
          field_type: 'signature',
          value: 'data:image/png;base64,not-a-png',
          ...PLACEMENT_A,
        },
      },
    }]),
    /no_signature_image_to_stamp/,
  );
  assert.equal(shouldStampSignatureImage({
    value: signatureDataUri(),
    page: 1,
    x: 10,
    y: 10,
  }), false);
});

test('8 multiple fields and signers cannot cross-map signatures', () => {
  const magenta = signatureDataUri(MAGENTA, 400, 90);
  const cyan = signatureDataUri(CYAN, 220, 70);
  const fields = [
    { id: PERSISTED_ID_A, field_type: 'signature', signer_index: 0, ...PLACEMENT_A },
    { id: PERSISTED_ID_B, field_type: 'signature', signer_index: 1, ...PLACEMENT_B },
  ];
  const fieldData = [
    { id: EDITOR_ID_A, type: 'signature', signerIndex: 0, ...PLACEMENT_A },
    { id: EDITOR_ID_B, type: 'signature', signerIndex: 1, ...PLACEMENT_B },
  ];
  const mapped = mapSubmittedFieldValues(fields, {
    [EDITOR_ID_A]: magenta,
    [EDITOR_ID_B]: cyan,
  }, fieldData);
  assert.equal(mapped[PERSISTED_ID_A].value, magenta);
  assert.equal(mapped[PERSISTED_ID_B].value, cyan);

  const orphan = mapSubmittedFieldValues(fields, { 'signature-unrelated': magenta }, fieldData);
  assert.equal(orphan[PERSISTED_ID_A].value, null);
  assert.equal(orphan[PERSISTED_ID_B].value, null);

  const ambiguous = mapSubmittedFieldValues(
    [
      { id: PERSISTED_ID_A, field_type: 'signature', ...PLACEMENT_A },
      { id: PERSISTED_ID_B, field_type: 'signature', ...PLACEMENT_A },
    ],
    { [EDITOR_ID_A]: magenta, [EDITOR_ID_B]: cyan },
    [
      { id: EDITOR_ID_A, type: 'signature', ...PLACEMENT_A },
      { id: EDITOR_ID_B, type: 'signature', ...PLACEMENT_A },
    ],
  );
  assert.equal(ambiguous[PERSISTED_ID_A].value, null);
  assert.equal(ambiguous[PERSISTED_ID_B].value, null);
});

test('8 stamp keeps each signature in its own persisted box', async () => {
  const magenta = signatureDataUri(MAGENTA, 400, 90);
  const cyan = signatureDataUri(CYAN, 220, 70);
  const signers = [{
    id: 's1',
    signing_order: 1,
    field_values: mapSubmittedFieldValues(
      [
        { id: PERSISTED_ID_A, field_type: 'signature', signer_index: 0, ...PLACEMENT_A },
        { id: PERSISTED_ID_B, field_type: 'signature', signer_index: 0, ...PLACEMENT_B },
      ],
      { [EDITOR_ID_A]: magenta, [EDITOR_ID_B]: cyan },
      [
        { id: EDITOR_ID_A, type: 'signature', signerIndex: 0, ...PLACEMENT_A },
        { id: EDITOR_ID_B, type: 'signature', signerIndex: 0, ...PLACEMENT_B },
      ],
    ),
  }];
  const original = await makeSourcePdf();
  const stamped = Buffer.from(await stampSignaturePdf(original, signers));
  const latin = stamped.toString('latin1');
  assert.match(latin, /\/Width 400/);
  assert.match(latin, /\/Width 220/);
  const srcDoc = await PDFDocument.load(original);
  const page = srcDoc.getPages()[0];
  const raster = rasterize(stamped, 'cross');
  const aMagenta = countColorPixels(raster, rasterBox(page, PLACEMENT_A), MAGENTA);
  const bCyan = countColorPixels(raster, rasterBox(page, PLACEMENT_B), CYAN);
  const aCyan = countColorPixels(raster, rasterBox(page, PLACEMENT_A), CYAN);
  const bMagenta = countColorPixels(raster, rasterBox(page, PLACEMENT_B), MAGENTA);
  assert.ok(aMagenta.inBox > 80, `magenta missing from A: ${aMagenta.inBox}`);
  assert.ok(bCyan.inBox > 80, `cyan missing from B: ${bCyan.inBox}`);
  assert.ok(aCyan.inBox < 20, `cyan leaked into A: ${aCyan.inBox}`);
  assert.ok(bMagenta.inBox < 20, `magenta leaked into B: ${bMagenta.inBox}`);
});

test('9 attach without signersWithValues still re-reads merged DB values', async () => {
  process.env.FILES_BUCKET = 'test-files-bucket';
  const pngUri = signatureDataUri(MAGENTA, 400, 90);
  const original = await makeSourcePdf();
  const sent = [];
  const s3 = {
    send: async (cmd) => {
      sent.push(cmd.constructor?.name || 'cmd');
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
        return { rows: [{ id: 's1', signing_order: 1, field_values: { [PERSISTED_ID_A]: pngUri } }] };
      }
      if (String(sql).includes('FROM public.signature_fields')) {
        return { rows: [{ id: PERSISTED_ID_A, signer_index: 0, field_type: 'signature', ...PLACEMENT_A }] };
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
    final_rel: 'signed/claim-1/req-1-final.pdf',
  }, { s3 });

  assert.equal(result.final_pdf_path, 'signed/claim-1/req-1-final.pdf');
  assert.equal(sqls.some((row) => String(row.sql).includes('FROM public.signature_signers')), true);
  assert.ok(sent.put, 'PutObject must run');
  const stamped = Buffer.from(sent.put.Body);
  assert.match(stamped.toString('latin1'), /\/Width 400/);
  const merged = mergeSignerFieldValues(
    [{ id: 's1', signing_order: 1, field_values: { [PERSISTED_ID_A]: pngUri } }],
    [{ id: PERSISTED_ID_A, signer_index: 0, field_type: 'signature', ...PLACEMENT_A }],
    [],
  );
  assert.equal(merged[0].field_values[PERSISTED_ID_A].value, pngUri);
});

test('4 completion receives the submitted value instead of a DB miss', async () => {
  process.env.FILES_BUCKET = 'test-files-bucket';
  const pngUri = signatureDataUri(MAGENTA, 400, 90);
  const original = await makeSourcePdf();
  let capturedSigners = null;
  const s3 = {
    send: async (cmd) => {
      if (cmd.constructor?.name === 'GetObjectCommand') {
        return { Body: { transformToByteArray: async () => original } };
      }
      return {};
    },
  };
  const client = {
    query: async (sql, params) => {
      if (String(sql).includes('aws_public_signature_by_token_hash')) {
        return { rows: [{
          doc: {
            signer: { id: 's1', status: 'pending', expires_at: null, signing_order: 1, signer_name: 'Ada' },
            request: {
              id: 'req-1',
              claim_id: 'claim-1',
              document_path: 'docs/source.pdf',
              document_name: 'Release',
              field_data: [{ id: EDITOR_ID_A, type: 'signature', signerIndex: 0, required: true, ...PLACEMENT_A }],
            },
            fields: [{
              id: PERSISTED_ID_A,
              field_type: 'signature',
              required: true,
              label: 'Sign',
              signer_index: 0,
              ...PLACEMENT_A,
            }],
            waiting_for: [],
          },
        }] };
      }
      if (String(sql).includes('aws_public_signature_submit')) {
        return { rows: [{
          doc: {
            ok: true,
            all_signed: true,
            request_completed: true,
            request_id: 'req-1',
            claim_id: 'claim-1',
            document_path: 'docs/source.pdf',
          },
        }] };
      }
      if (String(sql).includes('aws_public_signature_attach_signed')) {
        return { rows: [{ doc: { ok: true, final_pdf_path: params[1] } }] };
      }
      if (/BEGIN|COMMIT|ROLLBACK|SET TRANSACTION/.test(sql)) return { rows: [] };
      throw new Error(`unexpected sql: ${sql}`);
    },
    connect: async () => {},
    end: async () => {},
  };

  const result = await runPublicSignatureSubmit({
    headers: {},
    body: JSON.stringify({
      token: 'tok',
      eSignConsentAccepted: true,
      fieldValues: { [EDITOR_ID_A]: pngUri },
    }),
    requestContext: { http: { method: 'POST', path: '/public/signature-submit' } },
  }, {
    client,
    s3,
    stampSignaturePdf: async (_bytes, signers) => {
      capturedSigners = signers;
      return _bytes;
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.allSigned, true);
  assert.ok(capturedSigners, 'completion must receive signersWithValues');
  assert.equal(capturedSigners[0].field_values[PERSISTED_ID_A].value, pngUri);
  assert.equal(capturedSigners[0].field_values[PERSISTED_ID_A].x, PLACEMENT_A.x);
  assert.equal(capturedSigners[0].field_values[PERSISTED_ID_A].y, PLACEMENT_A.y);
  assert.equal(capturedSigners[0].field_values[EDITOR_ID_A], undefined);
});

test('attach with explicit signersWithValues does not re-read signer field rows', async () => {
  process.env.FILES_BUCKET = 'test-files-bucket';
  const pngUri = signatureDataUri(CYAN, 220, 70);
  const original = await makeSourcePdf();
  const sqls = [];
  const s3 = {
    send: async (cmd) => {
      if (cmd.constructor?.name === 'GetObjectCommand') {
        return { Body: { transformToByteArray: async () => original } };
      }
      if (cmd.constructor?.name === 'PutObjectCommand') {
        return {};
      }
      return {};
    },
  };
  const client = {
    query: async (sql, params) => {
      sqls.push(sql);
      if (String(sql).includes('aws_public_signature_attach_signed')) {
        return { rows: [{ doc: { ok: true, final_pdf_path: params[1] } }] };
      }
      return { rows: [] };
    },
  };
  const signersWithValues = buildSubmitSignersWithValues({
    signer: { id: 's1', signing_order: 1 },
    fields: [{ id: PERSISTED_ID_A, field_type: 'signature', ...PLACEMENT_A }],
    fieldValues: { [EDITOR_ID_A]: pngUri },
    fieldData: [{ id: EDITOR_ID_A, type: 'signature', ...PLACEMENT_A }],
  });
  await attachCompletedSignatureDocument(client, {
    id: 'req-1',
    claim_id: 'claim-1',
    document_path: 'docs/source.pdf',
    token_hash: 'abc',
    final_rel: 'signed/claim-1/req-1-final.pdf',
  }, { s3, signersWithValues });
  assert.equal(sqls.some((sql) => String(sql).includes('FROM public.signature_signers')), false);
  assert.equal(sqls.some((sql) => String(sql).includes('FROM public.signature_fields')), false);
});
