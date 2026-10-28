/**
 * Mortgage Desk e-sign, reads and timeline (SQL 124).
 *
 * Owner (2026-10-28): the agent assigned to a Desk request must be able to
 * send a check's files for signature "the exact same way a tenant can from
 * Files" (Third Party Authorization, anything the mortgage company needs or
 * the contractor uploaded). Signers: the insured (policyholder) and/or the
 * tenant (contractor). Email sender name: ChecksOps. The tenant sees the
 * Desk's requests in its own signature list (same tables, the check's claim).
 * v1: no resend, void or delete; timeline notes are not mirrored to the
 * tenant thread.
 *
 * POST /functions/v1/mortgage-desk-esign { action, request_id, ... }
 *
 *   action messages               -> aws_mortgage_desk_messages            (b)
 *   action check_files            -> aws_mortgage_desk_check_files         (c)
 *   action signature_requests     -> aws_mortgage_desk_signature_requests  (d)
 *   action workspace              -> (b), (c) and (d) in one read
 *   action send_signature_request -> (f), the signing emails, then (g)
 *   action post_timeline          -> aws_mortgage_desk_post_timeline       (h)
 *
 * Every call runs as the signed-in user (withIdentity: request.app_user_id ->
 * auth.uid()). The caller is checked here first (loadMortgageDeskWorkingRequest,
 * the SQL 122 rule: the assigned mortgage_agent or the platform owner) and
 * again inside every SQL 124 function. The check, its claim and its tenant
 * always come from the request row, never from the client.
 *
 * Send: the signer tokens are minted here exactly as the tenant flow mints
 * them (esign.mjs generateRawToken, randomBytes(32) hex); SQL 124 stores each
 * with its sha256 (esign.mjs hashToken). The create commits in its own
 * transaction, the emails go out (sign link `${signBaseUrl()}/sign?token=`,
 * the tenant flow's email body), and the per-signer results are recorded in a
 * second transaction (g), which moves the request to pending (or failed). The
 * raw tokens never leave the Lambda except inside the signers' own emails.
 *
 *   action sign_url               -> aws_mortgage_desk_can_read_path      (e), then a
 *                                    short-lived S3 read URL (claim-files only)
 *
 * Storage reads of Desk paths are signed here, not in storage.mjs: the agent
 * cannot read the check's rows, so storage.mjs's table rules refuse it, and
 * storage.mjs is a planned production member with its own pending release
 * bytes. Desk uploads keep the SQL 122 path (storage-write-auth.mjs +
 * mortgage_desk_attach_file).
 */
import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { parseBody, withIdentity, withIdentityWrite } from './data.mjs';
import {
  emailHtml,
  emailText,
  generateRawToken,
  hashToken,
  replaceMergeFields,
  signBaseUrl,
} from './esign.mjs';
import { formatFromHeader, platformBranding } from './email-branding.mjs';
import { sendViaSesOrSink } from './email.mjs';
import { loadMortgageDeskWorkingRequest } from './mortgage-desk-return.mjs';
import { normalizePath, pathCandidates, s3KeyFor } from './storage-paths.mjs';

export const MORTGAGE_DESK_ESIGN_FUNCTION = 'mortgage-desk-esign';

/** The sender name the owner chose for every Desk signing email. */
export const MORTGAGE_DESK_ESIGN_SENDER_NAME = 'ChecksOps';

/** esign.mjs TOKEN_EXPIRY_HOURS; SQL 124 refuses a link that lives longer. */
export const MORTGAGE_DESK_ESIGN_EXPIRY_HOURS = 72;

export const MORTGAGE_DESK_ESIGN_MAX_SIGNERS = 4;
export const MORTGAGE_DESK_ESIGN_SIGNER_TYPES = Object.freeze(['policyholder', 'contractor']);
export const MORTGAGE_DESK_ESIGN_DOCUMENT_TYPES = Object.freeze([
  'contract',
  'check_endorsement',
  'payment_authorization',
  'work_authorization',
  'proof_of_loss',
  'lien_waiver',
]);
export const MORTGAGE_DESK_TIMELINE_KINDS = Object.freeze(['mortgage_followup', 'mortgage_update']);
export const MORTGAGE_DESK_TIMELINE_MAX_NOTE = 2000;

export const MORTGAGE_DESK_READ_ACTIONS = Object.freeze(['messages', 'check_files', 'signature_requests', 'workspace', 'sign_url']);
export const MORTGAGE_DESK_ESIGN_ACTIONS = Object.freeze([
  ...MORTGAGE_DESK_READ_ACTIONS,
  'send_signature_request',
  'post_timeline',
]);

export const DESK_MESSAGES_SQL = 'SELECT * FROM public.aws_mortgage_desk_messages($1::uuid)';
export const DESK_CHECK_FILES_SQL = 'SELECT * FROM public.aws_mortgage_desk_check_files($1::uuid)';
export const DESK_SIGNATURE_REQUESTS_SQL = 'SELECT public.aws_mortgage_desk_signature_requests($1::uuid) AS requests';
// The link expiry is the database clock's now() + 72 hours: exactly the bound SQL 124 checks.
export const DESK_CREATE_SIGNATURE_SQL = `SELECT public.aws_mortgage_desk_create_signature_request(
  $1::uuid, $2::text, $3::text, $4::text, $5::jsonb, $6::jsonb,
  now() + interval '${MORTGAGE_DESK_ESIGN_EXPIRY_HOURS} hours') AS result`;
export const DESK_RECORD_DELIVERY_SQL = 'SELECT public.aws_mortgage_desk_record_signature_delivery($1::uuid, $2::uuid, $3::jsonb) AS result';
export const DESK_CAN_READ_PATH_SQL = 'SELECT public.aws_mortgage_desk_can_read_path($1::text[], $2::text) AS ok';
/** Signed read URLs live at most this long, as storage.mjs's authenticated reads. */
export const MORTGAGE_DESK_SIGN_EXPIRES = 300;
export const DESK_POST_TIMELINE_SQL = 'SELECT public.aws_mortgage_desk_post_timeline($1::uuid, $2::text, $3::text) AS id';
/** Merge-field context of the signing email, read under RLS from the request the caller works. */
export const DESK_EMAIL_CONTEXT_SQL = `SELECT claim_number, homeowner_name, policy_number, mortgage_company
FROM public.mortgage_handling_requests
WHERE id = $1::uuid`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isUuid = (value) => UUID_RE.test(String(value || ''));
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

const arg = (body, ...keys) => {
  for (const key of keys) {
    if (body?.[key] !== undefined && body?.[key] !== null) return body[key];
  }
  return null;
};

/**
 * SQL 124 / SQL 122 error codes -> a clear 4xx. `n` is the 1-based signer or
 * field position some codes carry ("invalid_signer: 2").
 */
const SQL_ERRORS = {
  not_authorized: [403, () => 'You are not authorized for this Mortgage Desk request.'],
  not_assigned_to_you: [403, () => 'This Mortgage Desk request is not assigned to you.'],
  request_not_in_status: [409, () => 'This Mortgage Desk request is not open for this action (it must be in progress).'],
  request_has_no_check: [409, () => 'This Mortgage Desk request has no linked check.'],
  request_has_no_claim: [409, () => 'This Mortgage Desk request has no claim, so there is no homeowner timeline to post to.'],
  document_not_on_check: [400, () => "Choose a PDF or DOCX file that is on this request's check."],
  invalid_document_name: [400, () => 'The document name must be 1 to 255 characters.'],
  invalid_document_type: [400, () => 'That document type is not supported.'],
  invalid_signers: [400, () => `Add 1 to ${MORTGAGE_DESK_ESIGN_MAX_SIGNERS} signers.`],
  invalid_signer: [400, (n) => `Signer ${n || ''}: enter a name, a valid email and a type (insured or contractor).`.replace('  ', ' ')],
  invalid_field_data: [400, (n) => (n ? `Field ${n} is not valid; remove it and place it again.` : 'The placed fields are not valid.')],
  missing_signature_field: [400, (n) => `Signer ${n || ''} needs at least one signature field.`.replace('  ', ' ')],
  invalid_expires_at: [400, () => 'The signing link expiry is not valid.'],
  claim_mismatch: [409, () => "This request's claim does not match the check's claim, so it cannot be sent for signature. Ask the tenant to fix the claim link."],
  duplicate_signature_request: [409, () => 'This document was already sent for signature in the last 10 minutes.'],
  signature_request_limit: [429, () => 'At most 10 signature requests can be sent for one Mortgage Desk request in 24 hours.'],
  signature_request_not_on_check: [403, () => "That signature request is not on this request's check."],
  not_a_desk_signature_request: [403, () => 'That signature request was not created by the Mortgage Desk.'],
  not_your_signature_request: [403, () => 'That signature request was created by another agent.'],
  signature_request_not_draft: [409, () => 'That signature request was already sent.'],
  invalid_results: [400, () => 'The email results did not match the signers.'],
  invalid_kind: [400, () => 'Choose a call to the mortgage company or a general update.'],
  invalid_note: [400, () => `The note must be 1 to ${MORTGAGE_DESK_TIMELINE_MAX_NOTE} characters.`],
};

/** { statusCode, error, message, position } for a known SQL 124 / 122 refusal, else null. */
export const mapMortgageDeskSqlError = (error) => {
  const text = String(error?.message || '').trim();
  const match = text.match(/^([a-z_]+)(?::\s*(\d+))?$/);
  if (!match || !SQL_ERRORS[match[1]]) return null;
  const [statusCode, describe] = SQL_ERRORS[match[1]];
  const position = match[2] ? Number(match[2]) : null;
  return { ok: false, statusCode, error: match[1], message: describe(position), ...(position ? { position } : {}) };
};

/** Runs one SQL 124 call; a known refusal becomes a 4xx result, anything else is rethrown. */
const callDefiner = async (client, sql, params) => {
  try {
    return { rows: (await client.query(sql, params)).rows };
  } catch (error) {
    const mapped = mapMortgageDeskSqlError(error);
    if (mapped) return { refused: mapped };
    throw error;
  }
};

/** The API-side gate's refusals (loadMortgageDeskWorkingRequest) as a 4xx. */
const gateRefusal = (gate, { reading = false } = {}) => {
  if (gate.error === 'invalid_uuid') {
    return { ok: false, statusCode: 400, error: 'invalid_uuid', field: 'request_id', message: 'request_id must be a uuid' };
  }
  if (gate.error === 'request_not_in_progress') {
    return {
      ok: false,
      statusCode: 409,
      error: 'request_not_in_status',
      message: reading
        ? 'This Mortgage Desk request must be in progress or completed.'
        : 'This Mortgage Desk request is not in progress.',
    };
  }
  if (gate.error === 'request_has_no_check' || gate.error === 'not_assigned_to_you') return sqlRefusal(gate.error);
  if (gate.message === 'Mortgage Desk agents only') {
    return { ok: false, statusCode: 403, error: 'not_authorized', message: 'Mortgage Desk agents only.' };
  }
  return sqlRefusal('not_authorized');
};

/** The 4xx of one SQL_ERRORS code, raised here instead of by the database. */
function sqlRefusal(code, position = null) {
  const [statusCode, describe] = SQL_ERRORS[code];
  return { ok: false, statusCode, error: code, message: describe(position), ...(position ? { position } : {}) };
}

const requestIdOf = (body) => arg(body, 'request_id', 'requestId', '_request_id');

// ---- Reads -----------------------------------------------------------------

const readOne = async (client, requestId, action) => {
  if (action === 'messages') {
    const out = await callDefiner(client, DESK_MESSAGES_SQL, [requestId]);
    return out.refused ? out : { data: out.rows };
  }
  if (action === 'check_files') {
    const out = await callDefiner(client, DESK_CHECK_FILES_SQL, [requestId]);
    return out.refused ? out : { data: out.rows };
  }
  const out = await callDefiner(client, DESK_SIGNATURE_REQUESTS_SQL, [requestId]);
  if (out.refused) return out;
  const requests = out.rows[0]?.requests;
  return { data: Array.isArray(requests) ? requests : [] };
};

// ---- Storage read (e) --------------------------------------------------------

const DESK_BUCKET = 'claim-files';

/**
 * A short-lived read URL for one claim-files object the caller may read as a
 * Desk agent (SQL 124 e: a file, signature document or signed PDF of a check
 * it works, or checks/<check>/mortgage-ops/<name>). The object must exist.
 */
export const runMortgageDeskSignUrl = async ({ client, mapping, body, spoof }, deps = {}) => {
  const requested = arg(body, 'path', 'file_path');
  const relRaw = normalizePath(requested, DESK_BUCKET);
  const rel = relRaw ? relRaw.split('?')[0] : '';
  const key = rel ? s3KeyFor(DESK_BUCKET, rel) : null;
  if (!rel || rel.length > 1024 || !key) {
    return { ok: false, statusCode: 400, error: 'invalid_path', message: 'path must be a claim-files object path', spoofFieldsIgnored: spoof };
  }
  const allowed = (await client.query(DESK_CAN_READ_PATH_SQL, [pathCandidates(DESK_BUCKET, requested), rel])).rows[0]?.ok === true;
  if (!allowed) {
    return {
      ok: false,
      statusCode: 403,
      error: 'storage_forbidden',
      message: 'Not authorized for this file',
      applicationUserId: mapping.application_user_id,
      spoofFieldsIgnored: spoof,
    };
  }
  const bucket = deps.filesBucket || process.env.FILES_BUCKET || '';
  const s3 = deps.s3 || new S3Client({ region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1' });
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  } catch (error) {
    const status = error?.$metadata?.httpStatusCode || error?.statusCode;
    if (status === 404 || error?.name === 'NotFound' || error?.Code === 'NotFound') {
      return { ok: false, statusCode: 404, error: 'object_not_in_s3', message: 'The file is not in storage', spoofFieldsIgnored: spoof };
    }
    throw error;
  }
  const download = body?.download === true ? rel.split('/').pop() : (typeof body?.download === 'string' ? body.download : null);
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ResponseContentDisposition: download ? `attachment; filename="${String(download).replace(/["\r\n]/g, '')}"` : undefined,
  });
  const signedUrl = await (deps.getSignedUrl || getSignedUrl)(s3, command, { expiresIn: MORTGAGE_DESK_SIGN_EXPIRES });
  return {
    ok: true,
    statusCode: 200,
    bucket: DESK_BUCKET,
    path: rel,
    signedUrl,
    signedUrlExpiresAt: new Date(Date.now() + MORTGAGE_DESK_SIGN_EXPIRES * 1000).toISOString(),
    spoofFieldsIgnored: spoof,
  };
};

export const runMortgageDeskRead = async ({ client, mapping, body, spoof, action }) => {
  const gate = await loadMortgageDeskWorkingRequest(client, mapping.application_user_id, requestIdOf(body), {
    statuses: ['in_progress', 'completed'],
  });
  if (gate.error) return { ...gateRefusal(gate, { reading: true }), spoofFieldsIgnored: spoof };
  const requestId = gate.request.id;
  if (action === 'workspace') {
    const data = {};
    for (const part of ['messages', 'check_files', 'signature_requests']) {
      const out = await readOne(client, requestId, part);
      if (out.refused) return { ...out.refused, spoofFieldsIgnored: spoof };
      data[part] = out.data;
    }
    return { ok: true, statusCode: 200, action, requestId, data, spoofFieldsIgnored: spoof };
  }
  const out = await readOne(client, requestId, action);
  if (out.refused) return { ...out.refused, spoofFieldsIgnored: spoof };
  return { ok: true, statusCode: 200, action, requestId, data: out.data, spoofFieldsIgnored: spoof };
};

// ---- Timeline (h) ----------------------------------------------------------

export const runMortgageDeskPostTimeline = async ({ client, mapping, body, spoof }) => {
  const kind = String(arg(body, 'kind', '_kind') ?? '').trim();
  const note = String(arg(body, 'note', '_note') ?? '').trim();
  if (!MORTGAGE_DESK_TIMELINE_KINDS.includes(kind)) {
    return { ...sqlRefusal('invalid_kind'), spoofFieldsIgnored: spoof };
  }
  if (!note || note.length > MORTGAGE_DESK_TIMELINE_MAX_NOTE) {
    return { ...sqlRefusal('invalid_note'), spoofFieldsIgnored: spoof };
  }
  const gate = await loadMortgageDeskWorkingRequest(client, mapping.application_user_id, requestIdOf(body));
  if (gate.error) return { ...gateRefusal(gate), spoofFieldsIgnored: spoof };
  const out = await callDefiner(client, DESK_POST_TIMELINE_SQL, [gate.request.id, kind, note]);
  if (out.refused) return { ...out.refused, spoofFieldsIgnored: spoof };
  return { ok: true, statusCode: 200, id: out.rows[0]?.id || null, spoofFieldsIgnored: spoof };
};

// ---- Create and send (f), emails, (g) --------------------------------------

/** A stored check file path as SQL 124 compares it: trimmed, query string dropped. */
export const deskDocumentPath = (value) => String(value ?? '').trim().split('?')[0];

const isSignableDocumentPath = (path) => /\.(pdf|docx)$/i.test(path);

/**
 * Validates the client's send input before anything is written: the same
 * rules SQL 124 (f) enforces, so the agent gets a clear message without a
 * database round trip. SQL 124 checks every one of them again.
 */
export const validateDeskSignatureInput = (body) => {
  const documentPath = deskDocumentPath(arg(body, 'document_path', 'documentPath'));
  const documentName = String(arg(body, 'document_name', 'documentName') ?? '').trim();
  const rawType = arg(body, 'document_type', 'documentType');
  const documentType = rawType == null || String(rawType).trim() === '' ? null : String(rawType).trim();
  const fieldData = arg(body, 'field_data', 'fieldData') ?? [];
  const rawSigners = arg(body, 'signers');

  const refuse = sqlRefusal;

  if (!documentPath || documentPath.length > 512 || !isSignableDocumentPath(documentPath)
    || documentPath.split('/').some((seg) => seg === '.' || seg === '..')) {
    return refuse('document_not_on_check');
  }
  if (!documentName || documentName.length > 255 || CONTROL_RE.test(documentName)) return refuse('invalid_document_name');
  if (documentType !== null && !MORTGAGE_DESK_ESIGN_DOCUMENT_TYPES.includes(documentType)) return refuse('invalid_document_type');
  if (!Array.isArray(rawSigners) || rawSigners.length < 1 || rawSigners.length > MORTGAGE_DESK_ESIGN_MAX_SIGNERS) {
    return refuse('invalid_signers');
  }
  const signers = [];
  for (let i = 0; i < rawSigners.length; i += 1) {
    const row = rawSigners[i];
    if (!row || typeof row !== 'object' || Array.isArray(row)) return refuse('invalid_signer', i + 1);
    const name = String(row.signer_name ?? row.name ?? '').trim();
    const email = String(row.signer_email ?? row.email ?? '').trim();
    const type = String(row.signer_type ?? row.type ?? 'policyholder').trim() || 'policyholder';
    const order = row.signing_order ?? row.order;
    if (!name || name.length > 200 || CONTROL_RE.test(name)) return refuse('invalid_signer', i + 1);
    if (email.length > 254 || !EMAIL_RE.test(email)) return refuse('invalid_signer', i + 1);
    if (!MORTGAGE_DESK_ESIGN_SIGNER_TYPES.includes(type)) return refuse('invalid_signer', i + 1);
    if (order !== undefined && order !== null && Number(order) !== i + 1) return refuse('invalid_signer', i + 1);
    // Signers sign in array order: signing_order is their position (SQL 124).
    signers.push({ signer_name: name, signer_email: email, signer_type: type, signing_order: i + 1 });
  }
  if (!Array.isArray(fieldData) || fieldData.length > 200) return refuse('invalid_field_data');
  const withSignature = new Set();
  for (let i = 0; i < fieldData.length; i += 1) {
    const field = fieldData[i];
    if (!field || typeof field !== 'object' || Array.isArray(field)) return refuse('invalid_field_data', i + 1);
    const index = field.signerIndex ?? 0;
    if (!Number.isInteger(index) || index < 0 || index >= signers.length) return refuse('invalid_field_data', i + 1);
    if (field.type === 'signature') withSignature.add(index);
  }
  for (let i = 0; i < signers.length; i += 1) {
    if (!withSignature.has(i)) return refuse('missing_signature_field', i + 1);
  }
  return { ok: true, documentPath, documentName, documentType, fieldData, signers };
};

/**
 * Transaction 1: the gate, then (f) with tokens minted here. Returns the
 * created request and, kept in memory only, each signer's raw token.
 */
const createDeskSignatureRequest = async ({ client, mapping, spoof, requestId, input }) => {
  const gate = await loadMortgageDeskWorkingRequest(client, mapping.application_user_id, requestId);
  if (gate.error) return { ...gateRefusal(gate), spoofFieldsIgnored: spoof };
  // Minted exactly as the tenant flow mints them (esign.mjs generateRawToken).
  const tokens = input.signers.map(() => generateRawToken());
  const signers = input.signers.map((signer, index) => ({ ...signer, access_token: tokens[index] }));
  const out = await callDefiner(client, DESK_CREATE_SIGNATURE_SQL, [
    gate.request.id,
    input.documentName,
    input.documentPath,
    input.documentType,
    JSON.stringify(input.fieldData),
    JSON.stringify(signers),
  ]);
  if (out.refused) return { ...out.refused, spoofFieldsIgnored: spoof };
  const result = out.rows[0]?.result || {};
  const created = Array.isArray(result.signers) ? result.signers : [];
  if (!isUuid(result.signature_request_id) || created.length !== signers.length) {
    return { ok: false, statusCode: 500, error: 'signature_request_not_created', spoofFieldsIgnored: spoof };
  }
  const context = (await client.query(DESK_EMAIL_CONTEXT_SQL, [gate.request.id])).rows[0] || {};
  return {
    ok: true,
    statusCode: 200,
    deskRequestId: gate.request.id,
    tenantId: gate.request.tenant_id || null,
    signatureRequestId: result.signature_request_id,
    // (f) returns the signers in signing order, which is their position.
    signers: created.map((row, index) => ({
      id: row.id,
      signer_name: row.signer_name,
      signer_email: row.signer_email,
      rawToken: tokens[index],
      tokenHash: hashToken(tokens[index]),
    })),
    context,
    spoofFieldsIgnored: spoof,
  };
};

/** The Desk's sender: the platform address under the owner's name, "ChecksOps". */
export const mortgageDeskEsignBranding = (platform = platformBranding()) => ({
  ...platform,
  from: formatFromHeader(MORTGAGE_DESK_ESIGN_SENDER_NAME, platform.fromAddress),
  fromName: MORTGAGE_DESK_ESIGN_SENDER_NAME,
  company_name: MORTGAGE_DESK_ESIGN_SENDER_NAME,
  companyName: MORTGAGE_DESK_ESIGN_SENDER_NAME,
  companySubtitle: null,
  company_email: platform.replyTo,
  esign_email_header_color: platform.primaryColor,
  esign_email_button_color: platform.primaryColor,
});

/**
 * One signing email per signer, through the tenant flow's email body
 * (esign.mjs emailHtml / emailText / replaceMergeFields) and the same mailer.
 * Returns the (g) results, one per signer.
 */
export const sendDeskSigningEmails = async ({ created, documentName, send = sendViaSesOrSink, branding = mortgageDeskEsignBranding() }) => {
  const request = {
    document_name: documentName,
    claims: {
      claim_number: created.context?.claim_number || null,
      policyholder_name: created.context?.homeowner_name || null,
      policy_number: created.context?.policy_number || null,
    },
  };
  const appUrl = signBaseUrl();
  const results = [];
  for (const signer of created.signers) {
    const signUrl = `${appUrl}/sign?token=${signer.rawToken}`;
    const subject = replaceMergeFields('Action Required: Sign {document.name}', signer, request, signUrl, branding);
    try {
      const sent = await send({
        to: signer.signer_email,
        subject,
        html: emailHtml(signer, request, signUrl, branding),
        text: emailText(signer, request, signUrl, branding),
        from: branding.from,
        replyTo: branding.replyTo,
        tenantId: created.tenantId,
        messageCategory: 'mortgage-desk-esign',
      });
      const entry = sent?.results?.[0] || {};
      if (entry.status === 'failed') {
        results.push({ signer_id: signer.id, success: false, message_id: null, error: String(entry.error || 'Email delivery failed').slice(0, 300) });
      } else {
        results.push({ signer_id: signer.id, success: true, message_id: entry.messageId || null, error: null });
      }
    } catch (error) {
      results.push({ signer_id: signer.id, success: false, message_id: null, error: String(error?.message || error).slice(0, 300) });
    }
  }
  return results;
};

/**
 * send_signature_request: (f) commits, the emails go out, (g) records them.
 * A Desk request may complete between the two transactions; (g) allows it.
 */
export const runSendDeskSignatureRequest = async (event, deps = {}) => {
  const body = parseBody(event);
  const input = validateDeskSignatureInput(body);
  if (!input.ok) {
    // Still authenticated: an anonymous caller learns nothing about the rules.
    return withIdentity(event, async ({ spoof }) => ({ ...input, spoofFieldsIgnored: spoof }), deps);
  }
  const created = await withIdentityWrite(event, ({ client, mapping, spoof }) => createDeskSignatureRequest({
    client, mapping, spoof, requestId: requestIdOf(body), input,
  }), deps);
  if (!created?.ok) return created;

  const results = await sendDeskSigningEmails({
    created,
    documentName: input.documentName,
    send: deps.sendViaSesOrSink || sendViaSesOrSink,
  });

  const recorded = await withIdentityWrite(event, async ({ client, spoof }) => {
    const out = await callDefiner(client, DESK_RECORD_DELIVERY_SQL, [
      created.deskRequestId,
      created.signatureRequestId,
      JSON.stringify(results),
    ]);
    if (out.refused) return { ...out.refused, spoofFieldsIgnored: spoof };
    return { ok: true, statusCode: 200, delivery: out.rows[0]?.result || null, spoofFieldsIgnored: spoof };
  }, deps);

  const sent = results.filter((row) => row.success).length;
  const failed = results.length - sent;
  const base = {
    signatureRequestId: created.signatureRequestId,
    requestId: created.deskRequestId,
    sent,
    failed,
    total: results.length,
    results: results.map(({ signer_id, success, error }) => ({ signer_id, success, error })),
    senderName: MORTGAGE_DESK_ESIGN_SENDER_NAME,
    spoofFieldsIgnored: created.spoofFieldsIgnored,
  };
  if (!recorded?.ok) {
    // The emails went out (or failed) but the results are not recorded: the
    // request stays a draft. Say so; never retry the sends from here.
    return {
      ...base,
      ok: false,
      statusCode: 502,
      error: 'delivery_not_recorded',
      message: 'The signing emails were sent, but their status could not be saved. Do not resend; contact support.',
      deliveryError: recorded?.error || null,
    };
  }
  if (sent === 0) {
    return {
      ...base,
      ok: false,
      statusCode: 502,
      error: 'email_send_failed',
      message: 'No signing email could be sent.',
      delivery: recorded.delivery,
    };
  }
  return { ...base, ok: true, statusCode: 200, delivery: recorded.delivery };
};

// ---- Router ----------------------------------------------------------------

export const handleMortgageDeskEsign = async (event, deps = {}) => {
  const body = parseBody(event);
  const action = String(body?.action || '').trim();
  if (action === 'sign_url') {
    return withIdentity(event, (ctx) => runMortgageDeskSignUrl(ctx, deps), deps);
  }
  if (MORTGAGE_DESK_READ_ACTIONS.includes(action)) {
    return withIdentity(event, (ctx) => runMortgageDeskRead({ ...ctx, action }), deps);
  }
  if (action === 'post_timeline') {
    return withIdentityWrite(event, (ctx) => runMortgageDeskPostTimeline(ctx), deps);
  }
  if (action === 'send_signature_request') {
    return runSendDeskSignatureRequest(event, deps);
  }
  return withIdentity(event, async ({ spoof }) => ({
    ok: false,
    statusCode: 400,
    error: 'unknown_action',
    message: `action must be one of ${MORTGAGE_DESK_ESIGN_ACTIONS.join(', ')}`,
    spoofFieldsIgnored: spoof,
  }), deps);
};
