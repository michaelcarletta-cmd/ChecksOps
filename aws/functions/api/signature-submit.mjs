/**
 * Public /public/signature-submit (Lovable submit-signature).
 * Token-hash lookup, consent, signer order, field validation.
 * Completes the request when every signer is signed. Does not call deposit RPCs.
 *
 * Live production baseline (2026-09-29T20:50:31, CodeSha256
 * X0xat8ZosDmRLjp7uXn+C3DxT+RD3I5APSVpI/GOGaU=) plus submitted-value
 * stamping. Completion uses lookup.fields + the just-submitted fieldValues
 * instead of depending exclusively on a database re-read.
 */
import pg from 'pg';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { parseBody, ignoredSpoof } from './data.mjs';
import { loadDatabaseCredentials } from './secrets.mjs';
import { buildWriteClientConfig, sanitizePublicError } from './db-health.mjs';
import { hashToken } from './esign.mjs';
import { clientIpFromEvent, userAgentFromEvent } from './check-endorsement.mjs';
import { normalizePath, s3KeyFor } from './storage-paths.mjs';

const { Client } = pg;

export const DEFAULT_SIGN_CONSENT = 'Electronic records and signature consent accepted before signing.';

const filesBucket = () => process.env.FILES_BUCKET || '';
const s3 = () => new S3Client({ region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1' });

export const signedDocumentPath = (request) => (
  request.claim_id
    ? `signed/${request.claim_id}/${request.id}-final.pdf`
    : `check-intake/${request.check_intake_item_id}/files/${request.id}-final.pdf`
);

const parseJson = (raw, fallback) => {
  if (raw == null) return fallback;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
};

const asDataUri = (value) => {
  if (typeof value !== 'string') return null;
  return value.startsWith('data:') ? value : null;
};

const SUPPORTED_DATA_IMAGE = /^data:image\/(?:png|jpe?g)(?:;|,)/i;

export const isSupportedSignatureImage = (value) => (
  typeof value === 'string' && SUPPORTED_DATA_IMAGE.test(value)
);

const asFiniteNumber = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

export const sameFieldPlacement = (left, right) => {
  if (!left || !right) return false;
  const typeL = String(left.field_type || left.type || '').toLowerCase();
  const typeR = String(right.field_type || right.type || '').toLowerCase();
  if (typeL && typeR && typeL !== typeR) return false;
  if (asFiniteNumber(left.page, 1) !== asFiniteNumber(right.page, 1)) return false;
  if (asFiniteNumber(left.x) !== asFiniteNumber(right.x)) return false;
  if (asFiniteNumber(left.y) !== asFiniteNumber(right.y)) return false;
  if (asFiniteNumber(left.width) !== asFiniteNumber(right.width)) return false;
  if (asFiniteNumber(left.height) !== asFiniteNumber(right.height)) return false;
  const signerL = left.signer_index ?? left.signerIndex;
  const signerR = right.signer_index ?? right.signerIndex;
  if (
    signerL != null && signerL !== ''
    && signerR != null && signerR !== ''
    && Number(signerL) !== Number(signerR)
  ) {
    return false;
  }
  return true;
};

const uniqueCorrespondent = (field, candidates, allFields) => {
  const matches = (candidates || []).filter((candidate) => sameFieldPlacement(field, candidate));
  if (matches.length !== 1) return null;
  const match = matches[0];
  const reverse = (allFields || []).filter((other) => sameFieldPlacement(other, match));
  if (reverse.length !== 1) return null;
  return match;
};

const isSignatureField = (field) => (
  field != null && (field.field_type === 'signature' || field.type === 'signature')
);

export const shouldStampSignatureImage = (field) => {
  if (!field) return false;
  const associated = isSignatureField(field) || field.signatureFieldAssociated === true;
  if (!associated) return false;
  if (isSignatureField(field) && asDataUri(field.value)) return true;
  return field.signatureFieldAssociated === true && isSupportedSignatureImage(field.value);
};

const hasOwnSubmitted = (submitted, key) => (
  submitted != null
  && typeof submitted === 'object'
  && !Array.isArray(submitted)
  && Object.prototype.hasOwnProperty.call(submitted, key)
);

const placementFromField = (field) => ({
  page: field.page ?? 1,
  x: field.x ?? 0,
  y: field.y ?? 0,
  width: field.width ?? 33,
  height: field.height ?? 6,
});

/**
 * Map submitted values onto persisted/lookup fields.
 * Exact persisted id wins. Otherwise a unique editor-id / placement
 * correspondence may be used. Never assigns the first signature value
 * to an unrelated field.
 */
export const mapSubmittedFieldValues = (fields = [], fieldValues = {}, fieldData = []) => {
  const submitted = (fieldValues && typeof fieldValues === 'object' && !Array.isArray(fieldValues))
    ? fieldValues
    : {};
  const editorFields = Array.isArray(fieldData) ? fieldData : [];
  const claimed = new Set();
  const mapped = {};

  for (const field of fields) {
    if (!field || field.id == null) continue;
    const fieldId = String(field.id);
    const editor = uniqueCorrespondent(field, editorFields, fields);
    let raw;
    if (hasOwnSubmitted(submitted, fieldId) && !claimed.has(fieldId)) {
      raw = submitted[fieldId];
      claimed.add(fieldId);
    } else {
      const editorId = editor?.id == null ? null : String(editor.id);
      if (editorId && hasOwnSubmitted(submitted, editorId) && !claimed.has(editorId)) {
        raw = submitted[editorId];
        claimed.add(editorId);
      }
    }
    const associated = isSignatureField(field) || isSignatureField(editor);
    mapped[fieldId] = {
      field_type: field.field_type || field.type || null,
      field_label: field.label || field.field_label || null,
      value: raw === undefined ? null : fieldEntryValue(raw),
      ...placementFromField(field),
      signatureFieldAssociated: associated,
    };
  }
  return mapped;
};

export const buildSubmitSignersWithValues = ({
  signer = {},
  fields = [],
  fieldValues = {},
  fieldData = [],
} = {}) => {
  const parsedFieldData = Array.isArray(fieldData)
    ? fieldData
    : (typeof fieldData === 'string' ? parseJson(fieldData, []) : []);
  const sourceFields = (fields && fields.length)
    ? fields
    : parsedFieldData.map((field) => ({
      id: field.id,
      field_type: field.field_type || field.type,
      type: field.field_type || field.type,
      label: field.label,
      signer_index: field.signer_index ?? field.signerIndex,
      page: field.page,
      x: field.x,
      y: field.y,
      width: field.width,
      height: field.height,
    }));
  return [{
    id: signer.id,
    signer_name: signer.signer_name,
    signing_order: signer.signing_order,
    field_values: mapSubmittedFieldValues(sourceFields, fieldValues, parsedFieldData),
  }];
};

const fieldEntryValue = (entry) => {
  if (entry == null) return null;
  if (typeof entry === 'string' || typeof entry === 'boolean' || typeof entry === 'number') return entry;
  if (typeof entry === 'object') return entry.value ?? entry.checked ?? null;
  return null;
};

export const mergeSignerFieldValues = (signers = [], fields = [], valueRows = []) => {
  const fieldsById = new Map(fields.map((field) => [String(field.id), field]));
  const valuesBySignerField = new Map();
  for (const row of valueRows) {
    valuesBySignerField.set(`${row.signer_id}:${row.field_id}`, row);
  }
  return signers.map((signer) => {
    const raw = parseJson(signer.field_values, {}) || {};
    const signerIndex = (signer.signing_order || 1) - 1;
    const merged = {};
    const considerIds = new Set([
      ...Object.keys(raw),
      ...fields.filter((field) => Number(field.signer_index) === signerIndex).map((field) => String(field.id)),
      ...valueRows.filter((row) => row.signer_id === signer.id).map((row) => String(row.field_id)),
    ]);
    for (const id of considerIds) {
      const field = fieldsById.get(String(id));
      const stored = raw[id];
      const valueRow = valuesBySignerField.get(`${signer.id}:${id}`);
      const normalizedStored = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : null;
      const value = fieldEntryValue(stored)
        ?? (valueRow?.value != null ? valueRow.value : null)
        ?? (valueRow && field?.field_type === 'checkbox' ? valueRow.checked : null);
      merged[id] = {
        field_type: normalizedStored?.field_type || normalizedStored?.type || field?.field_type || field?.type || (asDataUri(value) ? 'signature' : null),
        field_label: normalizedStored?.field_label || normalizedStored?.label || field?.label || null,
        value,
        page: normalizedStored?.page ?? field?.page ?? 1,
        x: normalizedStored?.x ?? field?.x ?? 0,
        y: normalizedStored?.y ?? field?.y ?? 0,
        width: normalizedStored?.width ?? field?.width ?? 33,
        height: normalizedStored?.height ?? field?.height ?? 6,
      };
    }
    return { ...signer, field_values: merged };
  });
};

export const loadMergedSignerFieldValues = async (client, requestId, deps = {}) => {
  const query = deps.query || ((sql, params) => client.query(sql, params));
  const safe = async (sql, params) => {
    try {
      return await query(sql, params);
    } catch {
      return { rows: [] };
    }
  };
  const signers = (await safe(
    `SELECT id, signer_name, signing_order, field_values
     FROM public.signature_signers
     WHERE signature_request_id = $1::uuid
     ORDER BY signing_order, created_at`,
    [requestId],
  )).rows;
  const fields = (await safe(
    `SELECT id, signer_index, field_type, label, page, x, y, width, height
     FROM public.signature_fields
     WHERE signature_request_id = $1::uuid
     ORDER BY created_at`,
    [requestId],
  )).rows;
  const valueRows = (await safe(
    `SELECT v.field_id, v.signer_id, v.value, v.checked
     FROM public.signature_field_values v
     JOIN public.signature_fields f ON f.id = v.field_id
     WHERE f.signature_request_id = $1::uuid`,
    [requestId],
  )).rows;
  return mergeSignerFieldValues(signers, fields, valueRows);
};

const decodeDataImage = (value) => {
  const raw = String(value || '');
  const comma = raw.indexOf(',');
  if (!raw.startsWith('data:') || comma < 0) return null;
  const meta = raw.slice(5, comma);
  const payload = raw.slice(comma + 1);
  const bytes = meta.includes('base64')
    ? Buffer.from(payload, 'base64')
    : Buffer.from(decodeURIComponent(payload), 'utf8');
  return { mime: meta.split(';')[0] || 'image/png', bytes };
};

/**
 * Stamp stored field values onto source PDF bytes.
 * Placement math matches Lovable generateFlattenedPdf (percent 0-100).
 */
export const stampSignaturePdf = async (pdfBytes, signersWithValues = []) => {
  const input = pdfBytes instanceof Uint8Array ? pdfBytes : new Uint8Array(pdfBytes);
  const header = String.fromCharCode(...input.slice(0, 5));
  if (header !== '%PDF-') throw new Error('source_document_is_not_pdf');

  const pdfDoc = await PDFDocument.load(input);
  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const pageCount = pdfDoc.getPageCount();
  let stampedImages = 0;

  for (const signer of signersWithValues) {
    const fieldValues = signer.field_values || {};
    for (const field of Object.values(fieldValues)) {
      if (!field) continue;
      const pageIndex = (field.page || 1) - 1;
      const pages = pdfDoc.getPages();
      if (pageIndex < 0 || pageIndex >= pages.length) continue;
      const page = pages[pageIndex];
      const pageHeight = page.getHeight();
      const pageWidth = page.getWidth();
      const x = (Number(field.x) / 100) * pageWidth;
      const y = pageHeight - ((Number(field.y) / 100) * pageHeight) - ((Number(field.height) || 5) / 100) * pageHeight;
      const w = (Number(field.width) / 100) * pageWidth;
      const h = ((Number(field.height) || 5) / 100) * pageHeight;

      if (shouldStampSignatureImage(field)) {
        try {
          const decoded = decodeDataImage(field.value);
          if (!decoded?.bytes?.length) continue;
          let embeddedImage;
          if (String(field.value).includes('image/png') || String(decoded.mime).includes('png')) {
            embeddedImage = await pdfDoc.embedPng(decoded.bytes);
          } else {
            try {
              embeddedImage = await pdfDoc.embedPng(decoded.bytes);
            } catch {
              embeddedImage = await pdfDoc.embedJpg(decoded.bytes);
            }
          }
          const aspectRatio = embeddedImage.width / embeddedImage.height;
          const drawH = Math.min(h, w / aspectRatio);
          const drawW = drawH * aspectRatio;
          page.drawImage(embeddedImage, {
            x,
            y: y + (h - drawH),
            width: drawW,
            height: drawH,
          });
          stampedImages += 1;
        } catch {
          page.drawText('[Signature on file]', {
            x,
            y: y + h / 2 - 5,
            size: 10,
            font: helvetica,
            color: rgb(0.3, 0.3, 0.3),
          });
        }
      } else if (field.field_type === 'date' && field.value) {
        page.drawText(String(field.value), {
          x,
          y: y + h / 2 - 5,
          size: 11,
          font: helvetica,
          color: rgb(0, 0, 0),
        });
      } else if (field.field_type === 'text' && field.value) {
        page.drawText(String(field.value), {
          x,
          y: y + h / 2 - 5,
          size: 11,
          font: helvetica,
          color: rgb(0, 0, 0),
        });
      } else if (field.field_type === 'checkbox') {
        const boxSize = Math.min(h * 0.7, w * 0.7, 14);
        const boxX = x + 2;
        const boxY = y + (h - boxSize) / 2;
        page.drawRectangle({
          x: boxX,
          y: boxY,
          width: boxSize,
          height: boxSize,
          borderColor: rgb(0.2, 0.2, 0.2),
          borderWidth: 1.2,
          color: rgb(1, 1, 1),
        });
        if (field.value) {
          const margin = boxSize * 0.2;
          const lx = boxX + margin;
          const ly = boxY + margin;
          const rx = boxX + boxSize - margin;
          const ry = boxY + boxSize - margin;
          const midX = boxX + boxSize * 0.38;
          const midY = boxY + margin;
          page.drawLine({
            start: { x: lx, y: ly + (ry - ly) * 0.5 },
            end: { x: midX, y: midY },
            thickness: 1.8,
            color: rgb(0.1, 0.4, 0.1),
          });
          page.drawLine({
            start: { x: midX, y: midY },
            end: { x: rx, y: ry },
            thickness: 1.8,
            color: rgb(0.1, 0.4, 0.1),
          });
        }
      }
    }
  }

  if (stampedImages < 1) throw new Error('no_signature_image_to_stamp');
  if (pdfDoc.getPageCount() !== pageCount) throw new Error('page_count_changed');
  return await pdfDoc.save();
};

export const attachCompletedSignatureDocument = async (client, request, deps = {}) => {
  const tokenHash = deps.tokenHash || request.token_hash;
  if (!tokenHash) throw new Error('missing_token_hash');
  const originalPath = request.document_path;
  if (!originalPath) throw new Error('missing_document_path');
  if (!request.claim_id && !request.check_intake_item_id) {
    throw new Error('signature request is not linked to a claim or check');
  }
  const destRel = request.final_rel || signedDocumentPath(request);
  const srcKey = s3KeyFor('claim-files', normalizePath(originalPath, 'claim-files'));
  const destKey = s3KeyFor('claim-files', normalizePath(destRel, 'claim-files'));
  const bucket = filesBucket();
  if (!bucket || !srcKey || !destKey) throw new Error('s3_not_configured');

  const stampAndPut = deps.stampAndPut || (async () => {
    const s3c = deps.s3 || s3();
    await s3c.send(new HeadObjectCommand({ Bucket: bucket, Key: srcKey }));
    const obj = await s3c.send(new GetObjectCommand({ Bucket: bucket, Key: srcKey }));
    const originalBytes = Buffer.from(await obj.Body.transformToByteArray());
    const signers = deps.signersWithValues || await loadMergedSignerFieldValues(client, request.id, deps);
    const stamped = await (deps.stampSignaturePdf || stampSignaturePdf)(originalBytes, signers);
    await s3c.send(new PutObjectCommand({
      Bucket: bucket,
      Key: destKey,
      Body: Buffer.from(stamped),
      ContentType: 'application/pdf',
    }));
    return { destRel, destKey, originalBytes, stamped };
  });
  await stampAndPut({ srcKey, destKey, destRel });

  const attached = (await client.query(
    'SELECT public.aws_public_signature_attach_signed($1, $2) AS doc',
    [tokenHash, destRel],
  )).rows[0]?.doc;
  if (!attached?.ok) {
    throw new Error(attached?.error || 'attach_denied');
  }
  return {
    final_pdf_path: attached.final_pdf_path || destRel,
    original_path: attached.original_path || originalPath,
    already_attached: attached.already_attached === true,
  };
};

const publicDb = async (deps = {}) => {
  if (deps.client) return { client: deps.client, owned: false };
  const loadCredentials = deps.loadDatabaseCredentials || loadDatabaseCredentials;
  const createClient = deps.createClient || ((config) => new Client(config));
  const credentials = await loadCredentials();
  const client = createClient(buildWriteClientConfig(credentials, { queryTimeoutMillis: 12000 }));
  await client.connect();
  return { client, owned: true };
};

const safeQuery = async (client, sql, params = []) => {
  try {
    return await client.query(sql, params);
  } catch {
    return { rows: [], rowCount: 0 };
  }
};

export const validateRequiredFields = (signerFields, fieldValues = {}) => {
  const validationErrors = [];
  for (const field of signerFields) {
    const value = fieldValues?.[field.id];
    const isRequired = field.required !== false;
    if (!isRequired) continue;
    if (field.type === 'signature') {
      if (!value || typeof value !== 'string' || !value.startsWith('data:')) {
        validationErrors.push(`Signature field "${field.label || 'Signature'}" is required`);
      }
    } else if (field.type === 'checkbox') {
      if (!value) validationErrors.push(`Checkbox "${field.label || 'Checkbox'}" must be checked`);
    } else if (field.type === 'date' || field.type === 'text') {
      if (!value || (typeof value === 'string' && value.trim() === '')) {
        validationErrors.push(`"${field.label || field.type}" is required`);
      }
    }
  }
  return validationErrors;
};

export const normalizeFieldValues = (signerFields, fieldValues = {}) => {
  const normalized = {};
  for (const field of signerFields) {
    normalized[field.id] = {
      field_type: field.type,
      field_label: field.label,
      value: fieldValues?.[field.id] ?? null,
      page: field.page,
      x: field.x,
      y: field.y,
      width: field.width,
      height: field.height,
    };
  }
  return normalized;
};

const loadSignerFields = async (client, request, signer) => {
  const normalized = (await safeQuery(
    client,
    `SELECT id, field_type, label, required, page, x, y, width, height
     FROM public.signature_fields
     WHERE signature_request_id = $1::uuid AND signer_index = $2
     ORDER BY created_at`,
    [request.id, (signer.signing_order || 1) - 1],
  )).rows;
  if (normalized.length) {
    return normalized.map((field) => ({
      id: field.id,
      type: field.field_type,
      label: field.label,
      required: field.required,
      page: field.page,
      x: field.x,
      y: field.y,
      width: field.width,
      height: field.height,
    }));
  }
  const raw = request.field_data;
  const parsed = Array.isArray(raw) ? raw : (typeof raw === 'string' ? JSON.parse(raw || '[]') : []);
  return parsed
    .filter((field) => field.signerIndex === (signer.signing_order || 1) - 1)
    .map((field) => ({
      id: field.id,
      type: field.type || field.field_type,
      label: field.label,
      required: field.required,
      page: field.page,
      x: field.x,
      y: field.y,
      width: field.width,
      height: field.height,
    }));
};

export const runPublicSignatureSubmit = async (event, deps = {}) => {
  const body = parseBody(event);
  const spoof = ignoredSpoof(event, body);
  const token = String(body.token || '').trim();
  if (!token) {
    return { ok: false, statusCode: 400, stage: 'validate_token', error: 'Missing token', spoofFieldsIgnored: spoof };
  }
  if (body.eSignConsentAccepted !== true) {
    return { ok: false, statusCode: 400, stage: 'esign_consent', error: 'Electronic signature consent is required', spoofFieldsIgnored: spoof };
  }

  let opened;
  try {
    opened = await publicDb(deps);
    const { client } = opened;
    await client.query('BEGIN');
    await client.query('SET TRANSACTION READ WRITE');
    const tokenHash = hashToken(token);
    const lookup = (await client.query(
      'SELECT public.aws_public_signature_by_token_hash($1) AS doc',
      [tokenHash],
    )).rows[0]?.doc;
    if (!lookup?.signer?.id || !lookup?.request?.id) {
      await client.query('ROLLBACK');
      return { ok: false, statusCode: 404, stage: 'fetch_signer', error: 'Invalid or expired signing token', spoofFieldsIgnored: spoof };
    }
    if (lookup.signer?.expires_at && new Date(lookup.signer.expires_at) < new Date()) {
      await client.query('ROLLBACK');
      return { ok: false, statusCode: 403, stage: 'token_expired', error: 'This signing link has expired. Please request a new one.', spoofFieldsIgnored: spoof };
    }
    const waitingFor = lookup.waiting_for || [];
    if (waitingFor.length) {
      await client.query('ROLLBACK');
      return { ok: false, statusCode: 403, stage: 'signer_order_blocked', error: 'A prior signer must complete before you can sign.', spoofFieldsIgnored: spoof };
    }
    const request = {
      id: lookup.request.id,
      document_name: lookup.request.document_name,
      document_path: lookup.request.document_path,
      field_data: lookup.request.field_data,
      claim_id: lookup.request.claim_id,
      check_intake_item_id: lookup.request.check_intake_item_id,
      token_hash: tokenHash,
    };
    const signer = lookup.signer;
    if (signer.status !== 'signed') {
      const signerFields = lookup.fields?.length
        ? lookup.fields.map((field) => ({
          id: field.id,
          type: field.field_type || field.type,
          label: field.label,
          required: field.required,
          page: field.page,
          x: field.x,
          y: field.y,
          width: field.width,
          height: field.height,
        }))
        : await loadSignerFields(client, request, signer);
      const validationErrors = validateRequiredFields(signerFields, body.fieldValues || {});
      if (validationErrors.length) {
        await client.query('ROLLBACK');
        return {
          ok: false,
          statusCode: 400,
          stage: 'field_validation',
          error: validationErrors.join('; '),
          validationErrors,
          spoofFieldsIgnored: spoof,
        };
      }
    }
    const ip = clientIpFromEvent(event);
    const ua = userAgentFromEvent(event);
    const submitted = (await client.query(
      'SELECT public.aws_public_signature_submit($1, $2::jsonb, $3, $4, $5) AS doc',
      [
        tokenHash,
        JSON.stringify(body.fieldValues || {}),
        ip,
        ua,
        typeof body.consentText === 'string' ? body.consentText : DEFAULT_SIGN_CONSENT,
      ],
    )).rows[0]?.doc;
    if (!submitted?.ok) {
      await client.query('ROLLBACK');
      if (submitted?.error === 'invalid_token') {
        return { ok: false, statusCode: 404, stage: 'fetch_signer', error: 'Invalid or expired signing token', spoofFieldsIgnored: spoof };
      }
      if (submitted?.error === 'expired') {
        return { ok: false, statusCode: 403, stage: 'token_expired', error: 'This signing link has expired. Please request a new one.', spoofFieldsIgnored: spoof };
      }
      if (submitted?.error === 'signer_order_blocked') {
        return { ok: false, statusCode: 403, stage: 'signer_order_blocked', error: 'A prior signer must complete before you can sign.', spoofFieldsIgnored: spoof };
      }
      if (submitted?.error === 'request_not_eligible') {
        return { ok: false, statusCode: 403, stage: 'request_not_eligible', error: 'This signing request is no longer available.', spoofFieldsIgnored: spoof };
      }
      return { ok: false, statusCode: 400, stage: 'signature_submit_denied', error: submitted?.error || 'signature_submit_denied', spoofFieldsIgnored: spoof };
    }
    request.id = submitted.request_id || request.id;
    request.claim_id = submitted.claim_id ?? request.claim_id;
    request.check_intake_item_id = submitted.check_intake_item_id ?? request.check_intake_item_id;
    request.document_path = submitted.document_path || request.document_path;
    request.document_name = submitted.document_name || request.document_name;
    request.final_rel = submitted.final_rel || signedDocumentPath(request);
    const allSigned = submitted.all_signed === true || submitted.request_completed === true;
    if (submitted.already_signed === true && !allSigned) {
      await client.query('ROLLBACK');
      return { ok: false, statusCode: 400, stage: 'already_signed', error: 'Document already signed', alreadySigned: true, spoofFieldsIgnored: spoof };
    }
    if (allSigned) {
      if (typeof deps.flattenPdf === 'function') {
        try { await deps.flattenPdf({ request, signer }); } catch { /* best-effort */ }
      } else {
        try {
          const signersWithValues = Object.prototype.hasOwnProperty.call(deps, 'signersWithValues')
            ? deps.signersWithValues
            : buildSubmitSignersWithValues({
              signer,
              fields: lookup.fields || [],
              fieldValues: body.fieldValues || {},
              fieldData: lookup.request?.field_data ?? request.field_data,
            });
          await attachCompletedSignatureDocument(client, request, { ...deps, tokenHash, signersWithValues });
        } catch (attachErr) {
          await client.query(
            'SELECT public.aws_public_signature_set_completion_error($1, $2) AS doc',
            [tokenHash, `PDF attach failed: ${String(attachErr?.message || attachErr).slice(0, 180)}`],
          );
        }
      }
    }
    await client.query('COMMIT');
    return {
      ok: true,
      statusCode: 200,
      success: true,
      allSigned,
      requestCompleted: allSigned,
      alreadySigned: submitted.already_signed === true,
      depositAdvanceDenied: true,
      spoofFieldsIgnored: spoof,
    };
  } catch (error) {
    if (opened?.client) {
      try { await opened.client.query('ROLLBACK'); } catch { /* ignore */ }
    }
    return {
      ok: false,
      statusCode: 503,
      stage: 'signature_submit_failed',
      error: 'signature_submit_failed',
      message: sanitizePublicError(error),
      spoofFieldsIgnored: spoof,
    };
  } finally {
    if (opened?.owned) {
      try { await opened.client.end(); } catch { /* ignore */ }
    }
  }
};

export const handlePublicSignatureSubmit = (event, deps = {}) => runPublicSignatureSubmit(event, deps);
