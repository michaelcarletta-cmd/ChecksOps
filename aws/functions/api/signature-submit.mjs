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
  const originalPath = request.document_path;
  if (!originalPath) throw new Error('missing_document_path');
  if (!request.claim_id && !request.check_intake_item_id) {
    throw new Error('signature request is not linked to a claim or check');
  }
  const destRel = signedDocumentPath(request);
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

  await safeQuery(
    client,
    `UPDATE public.signature_requests
     SET final_pdf_path = $2, completion_status = 'completed'
     WHERE id = $1::uuid`,
    [request.id, destRel],
  );

  const signedName = `SIGNED - ${request.document_name}`;
  if (request.claim_id) {
    const existingClaim = (await safeQuery(
      client,
      `SELECT id FROM public.claim_files
       WHERE claim_id = $1::uuid AND file_path = $2
       LIMIT 1`,
      [request.claim_id, destRel],
    )).rows[0];
    if (!existingClaim) {
      await safeQuery(
        client,
        `INSERT INTO public.claim_files (claim_id, file_name, file_path, file_type)
         VALUES ($1::uuid, $2, $3, 'application/pdf')`,
        [request.claim_id, signedName, destRel],
      );
    }
  }

  let checkId = request.check_intake_item_id || null;
  if (!checkId && originalPath) {
    checkId = (await safeQuery(
      client,
      `SELECT check_intake_item_id FROM public.check_files WHERE file_path = $1 LIMIT 1`,
      [originalPath],
    )).rows[0]?.check_intake_item_id || null;
  }
  if (checkId) {
    const existingCheck = (await safeQuery(
      client,
      `SELECT id FROM public.check_files
       WHERE signature_request_id = $1::uuid AND category = 'signed_dtp'
       LIMIT 1`,
      [request.id],
    )).rows[0];
    if (!existingCheck) {
      await safeQuery(
        client,
        `INSERT INTO public.check_files (
           check_intake_item_id, file_name, file_path, file_type, category, source, signature_request_id
         ) VALUES ($1::uuid, $2, $3, 'application/pdf', 'signed_dtp', 'system', $4::uuid)`,
        [checkId, `${signedName}.pdf`, destRel, request.id],
      );
    }
  }

  await safeQuery(
    client,
    `UPDATE public.loss_draft_documents
     SET is_submitted = true,
         submitted_at = COALESCE(submitted_at, now()),
         signature_status = 'signed',
         signed_at = COALESCE(signed_at, now())
     WHERE signature_request_id = $1::uuid`,
    [request.id],
  );
  return { final_pdf_path: destRel, original_path: originalPath };
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
    const signer = (await safeQuery(
      client,
      `SELECT s.*, r.id AS request_id, r.document_name, r.document_path, r.field_data, r.claim_id,
              r.check_intake_item_id, r.status AS request_status
       FROM public.signature_signers s
       JOIN public.signature_requests r ON r.id = s.signature_request_id
       WHERE s.token_hash = $1
       LIMIT 1`,
      [tokenHash],
    )).rows[0];
    if (!signer) {
      await client.query('ROLLBACK');
      return { ok: false, statusCode: 404, stage: 'fetch_signer', error: 'Invalid or expired signing token', spoofFieldsIgnored: spoof };
    }
    if (signer.expires_at && new Date(signer.expires_at) < new Date()) {
      await client.query('ROLLBACK');
      return { ok: false, statusCode: 403, stage: 'token_expired', error: 'This signing link has expired. Please request a new one.', spoofFieldsIgnored: spoof };
    }
    if (signer.status === 'signed') {
      await client.query('ROLLBACK');
      return { ok: false, statusCode: 400, stage: 'already_signed', error: 'Document already signed', alreadySigned: true, spoofFieldsIgnored: spoof };
    }
    if ((signer.signing_order || 1) > 1) {
      const prior = (await safeQuery(
        client,
        `SELECT id FROM public.signature_signers
         WHERE signature_request_id = $1::uuid
           AND signing_order < $2
           AND status IS DISTINCT FROM 'signed'`,
        [signer.signature_request_id || signer.request_id, signer.signing_order],
      )).rows;
      if (prior.length) {
        await client.query('ROLLBACK');
        return { ok: false, statusCode: 403, stage: 'signer_order_blocked', error: 'A prior signer must complete before you can sign.', spoofFieldsIgnored: spoof };
      }
    }
    const request = {
      id: signer.signature_request_id || signer.request_id,
      document_name: signer.document_name,
      document_path: signer.document_path,
      field_data: signer.field_data,
      claim_id: signer.claim_id,
      check_intake_item_id: signer.check_intake_item_id,
    };
    const signerFields = await loadSignerFields(client, request, signer);
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
    const normalizedValues = normalizeFieldValues(signerFields, body.fieldValues || {});
    const ip = clientIpFromEvent(event);
    const ua = userAgentFromEvent(event);
    const updated = (await client.query(
      `UPDATE public.signature_signers
       SET status = 'signed',
           signed_at = now(),
           field_values = $2::jsonb,
           ip_address = $3,
           user_agent = $4
       WHERE id = $1::uuid AND status IS DISTINCT FROM 'signed'
       RETURNING id`,
      [signer.id, JSON.stringify(normalizedValues), ip, ua],
    )).rows[0];
    if (!updated) {
      await client.query('ROLLBACK');
      return { ok: false, statusCode: 400, stage: 'already_signed', error: 'Document already signed', alreadySigned: true, spoofFieldsIgnored: spoof };
    }
    for (const field of signerFields) {
      await safeQuery(
        client,
        `INSERT INTO public.signature_field_values (field_id, signer_id, value, checked)
         VALUES ($1::uuid, $2::uuid, $3, $4)`,
        [
          field.id,
          signer.id,
          body.fieldValues?.[field.id] != null ? String(body.fieldValues[field.id]) : null,
          field.type === 'checkbox' ? Boolean(body.fieldValues?.[field.id]) : false,
        ],
      );
    }
    await safeQuery(
      client,
      `INSERT INTO public.esign_event_logs (
         request_id, signer_id, claim_id, stage, status, message, payload
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'signer_signed', 'ok', $4, $5::jsonb)`,
      [
        request.id,
        signer.id,
        request.claim_id || null,
        `${signer.signer_name || 'Signer'} signed the document`,
        JSON.stringify({
          e_sign_consent_accepted: true,
          consent_text: typeof body.consentText === 'string' ? body.consentText : DEFAULT_SIGN_CONSENT,
        }),
      ],
    );
    const allSigners = (await safeQuery(
      client,
      `SELECT id, status FROM public.signature_signers WHERE signature_request_id = $1::uuid`,
      [request.id],
    )).rows;
    const allSigned = allSigners.length > 0 && allSigners.every((row) => row.status === 'signed');
    if (allSigned) {
      await safeQuery(
        client,
        `UPDATE public.signature_requests
         SET status = 'completed', completed_at = now(), last_error = NULL, completion_status = 'pending'
         WHERE id = $1::uuid`,
        [request.id],
      );
      if (typeof deps.flattenPdf === 'function') {
        try { await deps.flattenPdf({ request, signer }); } catch { /* best-effort */ }
      } else {
        try {
          await attachCompletedSignatureDocument(client, request, deps);
        } catch (attachErr) {
          await safeQuery(
            client,
            `UPDATE public.signature_requests
             SET completion_status = 'failed', last_error = $2
             WHERE id = $1::uuid`,
            [request.id, `PDF attach failed: ${String(attachErr?.message || attachErr).slice(0, 180)}`],
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
