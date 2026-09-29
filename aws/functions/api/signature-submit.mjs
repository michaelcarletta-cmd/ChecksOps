/**
 * Public /public/signature-submit (Lovable submit-signature).
 * Token-hash lookup, consent, signer order, field validation.
 * Completes the request when every signer is signed. Does not call deposit RPCs.
 */
import pg from 'pg';
import { CopyObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
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
  const copyObject = deps.copyObject || (async () => {
    const s3c = deps.s3 || s3();
    await s3c.send(new HeadObjectCommand({ Bucket: bucket, Key: srcKey }));
    try {
      await s3c.send(new CopyObjectCommand({
        Bucket: bucket,
        Key: destKey,
        CopySource: `${bucket}/${srcKey}`,
        ContentType: 'application/pdf',
        MetadataDirective: 'REPLACE',
      }));
    } catch {
      const obj = await s3c.send(new GetObjectCommand({ Bucket: bucket, Key: srcKey }));
      const bytes = Buffer.from(await obj.Body.transformToByteArray());
      await s3c.send(new PutObjectCommand({
        Bucket: bucket,
        Key: destKey,
        Body: bytes,
        ContentType: 'application/pdf',
      }));
    }
  });
  await copyObject({ srcKey, destKey, destRel });

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
          await attachCompletedSignatureDocument(client, request, { ...deps, tokenHash });
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
