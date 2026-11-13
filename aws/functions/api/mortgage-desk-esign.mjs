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
 *   action shared_library_documents -> aws_mortgage_desk_shared_library_documents (SQL 156): the auto-shared
 *                                    library documents of every tenant on the request's check (its own tenant and
 *                                    every unrevoked partner share). SQL 156 enforces its own rule (the platform
 *                                    owner, or a mortgage agent while the request is open or assigned to them), so
 *                                    this action does not take the in-progress working-request gate.
 *
 * Tenant Management desk view (SQL 158). Owner 2026-11-12: Tenant Management (the platform owner) sees every
 * tenant's Desk work with its age, assigns a queued request to an agent ("If no agent then tenant management can
 * assign"; assigning starts it, as the agent's accept does), and messages the assigned agent ("Message agent": an
 * email AND a private note; "Tenant management and the agent assigned can see the notes", never the check thread).
 * SQL 158 enforces every rule itself (platform owner only, except that the assigned agent reads its notes):
 *
 *   action desk_overview  -> aws_mortgage_desk_overview(tenant, status, limit, offset)   (SQL 158 a)
 *   action desk_agents    -> aws_mortgage_desk_assignable_agents()                       (SQL 158 b)
 *   action assign_agent   -> aws_mortgage_desk_assign_agent(request, agent)              (SQL 158 c) and, in the
 *                            same transaction, the accept's Mortgage Ops accrual (accrueDeskAssignment), then a
 *                            best-effort notice email to the agent (not recorded; the assignment stands)
 *   action message_agent  -> aws_mortgage_desk_add_agent_note(request, body)             (SQL 158 d) commits,
 *                            the email to the assigned agent goes out, then
 *                            aws_mortgage_desk_record_agent_note_email(note, status)     (SQL 158 e)
 *   action agent_notes    -> aws_mortgage_desk_agent_notes(request)                      (SQL 158 f)
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
 * SQL 163 (owner 2026-11-12: the agent sees no check, no logged contact, and the homeowner link fails with
 * missing_cognito_token; 2026-11-13 "Start the desk fixes"), behind SQL 124's readable gate:
 *
 *   action check                  -> aws_mortgage_desk_request_check: the request's check (display fields only) with
 *                                    short-lived read URLs for its front and back images
 *   action homeowner_timeline     -> aws_mortgage_desk_homeowner_timeline: the claim's homeowner timeline written by
 *                                    the request's tenant, newest first (the note only)
 *   action workspace              -> also carries check and homeowner_timeline
 *   action send_tracking_link     -> aws_mortgage_desk_homeowner_link (the homeowner on file, never a client address),
 *                                    then the homeowner-ledger-invite email from ChecksOps
 *
 * Until SQL 163 is applied the functions are absent (42883): the workspace returns check null and an empty timeline
 * with sql163_unavailable, and send_tracking_link answers 503 desk_link_unavailable; nothing else changes.
 *
 * Storage reads of Desk paths are signed here, not in storage.mjs: the agent
 * cannot read the check's rows, so storage.mjs's table rules refuse it, and
 * storage.mjs is a planned production member with its own pending release
 * bytes. Desk uploads keep the SQL 122 path (storage-write-auth.mjs +
 * mortgage_desk_attach_file).
 */
import { randomBytes } from 'node:crypto';
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
import { formatFromHeader, platformBranding, resolveEmailBranding } from './email-branding.mjs';
import { sendViaSesOrSink } from './email.mjs';
import { renderChecksOpsEmail } from './email-layout.mjs';
import { renderTransactionalTemplate } from './email-templates.mjs';
import { appOrigin } from './homeowner.mjs';
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

export const MORTGAGE_DESK_READ_ACTIONS = Object.freeze(['messages', 'check_files', 'signature_requests', 'workspace', 'sign_url', 'check', 'homeowner_timeline']);
export const MORTGAGE_DESK_ESIGN_ACTIONS = Object.freeze([
  ...MORTGAGE_DESK_READ_ACTIONS,
  'send_signature_request',
  'post_timeline',
  'shared_library_documents',
  'desk_overview',
  'desk_agents',
  'assign_agent',
  'message_agent',
  'agent_notes',
  'send_tracking_link',
]);

/** SQL 158: the Tenant Management desk view (platform owner) and the assigned agent's notes. */
export const DESK_OVERVIEW_SQL = 'SELECT * FROM public.aws_mortgage_desk_overview($1::uuid, $2::text, $3::integer, $4::integer)';
export const DESK_ASSIGNABLE_AGENTS_SQL = 'SELECT * FROM public.aws_mortgage_desk_assignable_agents()';
export const DESK_ASSIGN_AGENT_SQL = 'SELECT * FROM public.aws_mortgage_desk_assign_agent($1::uuid, $2::uuid)';
export const DESK_ADD_AGENT_NOTE_SQL = 'SELECT * FROM public.aws_mortgage_desk_add_agent_note($1::uuid, $2::text)';
export const DESK_RECORD_AGENT_NOTE_EMAIL_SQL = 'SELECT public.aws_mortgage_desk_record_agent_note_email($1::uuid, $2::text) AS recorded';
export const DESK_AGENT_NOTES_SQL = 'SELECT * FROM public.aws_mortgage_desk_agent_notes($1::uuid)';
/** The assigned request's row, read in the assign's own transaction for the Mortgage Ops accrual. */
export const DESK_ASSIGNED_REQUEST_SQL = 'SELECT * FROM public.mortgage_handling_requests WHERE id = $1::uuid';
export const MORTGAGE_DESK_OVERVIEW_STATUSES = Object.freeze(['requested', 'in_progress', 'completed']);
/** SQL 158 caps a page at 500 rows and defaults to 200. */
export const MORTGAGE_DESK_OVERVIEW_MAX_LIMIT = 500;
export const MORTGAGE_DESK_OVERVIEW_DEFAULT_LIMIT = 200;
/** SQL 158 d: a note is 1 to 2000 characters; at most 10 per request per hour. */
export const MORTGAGE_DESK_AGENT_NOTE_MAX = 2000;

export const DESK_MESSAGES_SQL = 'SELECT * FROM public.aws_mortgage_desk_messages($1::uuid)';
/** SQL 163: the request's check, its homeowner timeline and the homeowner tracking link (owner 2026-11-12). */
export const DESK_REQUEST_CHECK_SQL = 'SELECT * FROM public.aws_mortgage_desk_request_check($1::uuid)';
export const DESK_HOMEOWNER_TIMELINE_SQL = 'SELECT * FROM public.aws_mortgage_desk_homeowner_timeline($1::uuid)';
export const DESK_HOMEOWNER_LINK_SQL = 'SELECT * FROM public.aws_mortgage_desk_homeowner_link($1::uuid, $2::text)';
/** Check images are claim-files objects; read URLs live as long as sign_url's. */
const DESK_CHECK_IMAGE_BUCKET = 'claim-files';
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
/** SQL 156: every check tenant's auto-shared library documents (owner 2026-11-11: "everybody shared on that check"). */
export const DESK_SHARED_LIBRARY_DOCUMENTS_SQL = 'SELECT * FROM public.aws_mortgage_desk_shared_library_documents($1::uuid)';
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
  invalid_signer: [400, (n) => `Signer ${n || ''}: enter a name and a valid email address.`.replace('  ', ' ')],
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
  // SQL 158
  invalid_status: [400, () => 'Choose queued (requested), in progress or completed.'],
  agent_not_assignable: [400, () => 'That person is not an active Mortgage Desk agent.'],
  not_found: [404, () => 'That Mortgage Desk request was not found.'],
  already_taken: [409, () => 'This request is no longer queued: an agent already has it.'],
  invalid_body: [400, () => `The message must be 1 to ${MORTGAGE_DESK_AGENT_NOTE_MAX} characters.`],
  no_assigned_agent: [409, () => 'This request has no assigned agent yet. Assign one first.'],
  rate_limited: [429, () => 'At most 10 messages can be sent to the agent on one request per hour.'],
  // SQL 163
  claim_not_in_tenant: [403, () => "This request's claim does not belong to its tenant, so no homeowner link can be sent."],
  no_homeowner_email: [409, () => 'There is no homeowner email on this request or its claim. Ask the tenant to add one.'],
  invalid_token: [500, () => 'The homeowner link could not be created. Try again.'],
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

/**
 * One SQL 163 call under a savepoint: before SQL 163 is applied the function is absent (42883), which must not abort
 * the rest of the workspace read. Returns { rows }, { refused } or { unavailable: true }.
 */
const callSql163 = async (client, sql, params) => {
  await client.query('SAVEPOINT desk_sql163');
  try {
    const out = await callDefiner(client, sql, params);
    await client.query('RELEASE SAVEPOINT desk_sql163');
    return out;
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT desk_sql163');
    if (error?.code === '42883') return { unavailable: true };
    throw error;
  }
};

/** A short-lived read URL for one check image path, or null (no path, no bucket, or signing failed). */
const signCheckImage = async (rawPath, deps = {}) => {
  if (!rawPath) return null;
  const rel = normalizePath(rawPath, DESK_CHECK_IMAGE_BUCKET);
  const key = rel ? s3KeyFor(DESK_CHECK_IMAGE_BUCKET, rel.split('?')[0]) : null;
  const bucket = deps.filesBucket || process.env.FILES_BUCKET || '';
  if (!key || !bucket) return null;
  try {
    const s3 = deps.s3 || new S3Client({ region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1' });
    return await (deps.getSignedUrl || getSignedUrl)(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: MORTGAGE_DESK_SIGN_EXPIRES });
  } catch {
    return null;
  }
};

const readOne = async (client, requestId, action, deps = {}) => {
  if (action === 'check') {
    const out = await callSql163(client, DESK_REQUEST_CHECK_SQL, [requestId]);
    if (out.refused) return out;
    if (out.unavailable) return { data: null, unavailable: true };
    const row = out.rows[0];
    if (!row) return { data: null };
    const [frontUrl, backUrl] = await Promise.all([signCheckImage(row.front_image_path, deps), signCheckImage(row.back_image_path, deps)]);
    return { data: { ...row, front_url: frontUrl, back_url: backUrl } };
  }
  if (action === 'homeowner_timeline') {
    const out = await callSql163(client, DESK_HOMEOWNER_TIMELINE_SQL, [requestId]);
    if (out.refused) return out;
    if (out.unavailable) return { data: [], unavailable: true };
    return { data: out.rows };
  }
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

export const runMortgageDeskRead = async ({ client, mapping, body, spoof, action }, deps = {}) => {
  const gate = await loadMortgageDeskWorkingRequest(client, mapping.application_user_id, requestIdOf(body), {
    statuses: ['in_progress', 'completed'],
  });
  if (gate.error) return { ...gateRefusal(gate, { reading: true }), spoofFieldsIgnored: spoof };
  const requestId = gate.request.id;
  if (action === 'workspace') {
    const data = {};
    let sql163Unavailable = false;
    for (const part of ['messages', 'check_files', 'signature_requests', 'check', 'homeowner_timeline']) {
      const out = await readOne(client, requestId, part, deps);
      if (out.refused) return { ...out.refused, spoofFieldsIgnored: spoof };
      if (out.unavailable) sql163Unavailable = true;
      data[part] = out.data;
    }
    return {
      ok: true, statusCode: 200, action, requestId, data, ...(sql163Unavailable ? { sql163_unavailable: true } : {}), spoofFieldsIgnored: spoof,
    };
  }
  const out = await readOne(client, requestId, action, deps);
  if (out.refused) return { ...out.refused, spoofFieldsIgnored: spoof };
  return {
    ok: true, statusCode: 200, action, requestId, data: out.data, ...(out.unavailable ? { sql163_unavailable: true } : {}), spoofFieldsIgnored: spoof,
  };
};

// ---- Homeowner tracking link (SQL 163) --------------------------------------

/**
 * The homeowner tracking link from the Desk (owner 2026-11-12: "When sending homeowner link from mortgage desk, error
 * missing_cognito_token. Fix it."). The Desk session has no tenant membership, so homeowner-ledger-send refuses it;
 * here SQL 163 checks the caller against the request (SQL 124's gate), takes the homeowner on file (the request's
 * email, else the claim's; never an address from the client) and reuses or creates that recipient's token. The
 * invite email is the tenant flow's homeowner-ledger-invite from ChecksOps. The token row commits with the call; the
 * email is sent after the database work succeeds.
 */
export const runMortgageDeskSendTrackingLink = async ({ client, mapping, body, spoof }, deps = {}) => {
  const gate = await loadMortgageDeskWorkingRequest(client, mapping.application_user_id, requestIdOf(body), {
    statuses: ['in_progress', 'completed'],
  });
  if (gate.error) return { ...gateRefusal(gate, { reading: true }), spoofFieldsIgnored: spoof };
  const requestId = gate.request.id;
  const newToken = (deps.randomBytes || randomBytes)(24).toString('hex');
  const out = await callSql163(client, DESK_HOMEOWNER_LINK_SQL, [requestId, newToken]);
  if (out.refused) return { ...out.refused, spoofFieldsIgnored: spoof };
  if (out.unavailable) {
    return {
      ok: false,
      statusCode: 503,
      error: 'desk_link_unavailable',
      message: 'Sending the homeowner link from the Mortgage Desk is not available yet.',
      spoofFieldsIgnored: spoof,
    };
  }
  const row = out.rows[0];
  if (!row?.token) return { ok: false, statusCode: 500, error: 'link_not_created', message: 'The homeowner link could not be created.', spoofFieldsIgnored: spoof };
  const url = `${appOrigin(body?.origin)}/h/ledger/${row.token}`;
  const branding = await (deps.resolveEmailBranding || resolveEmailBranding)(client, { tenantId: row.tenant_id, senderOverride: 'checksops' });
  const rendered = renderTransactionalTemplate('homeowner-ledger-invite', {
    homeownerName: row.homeowner_name,
    ledgerUrl: url,
    is_pre_claim: false,
    branding,
  });
  await (deps.sendViaSesOrSink || sendViaSesOrSink)({
    to: row.homeowner_email,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    from: branding.from,
    replyTo: branding.replyTo,
  });
  return {
    ok: true,
    statusCode: 200,
    requestId,
    url,
    reused: row.reused === true,
    sentTo: row.homeowner_email,
    spoofFieldsIgnored: spoof,
  };
};

// ---- Shared-check library documents (SQL 156) -------------------------------

/**
 * Lists the auto-shared library documents of every tenant on the request's check. The request id must be a uuid;
 * who may read is SQL 156's rule (42501 not_authorized otherwise), which also covers a queued (requested) request,
 * where the library documents are already visible to agents today.
 */
export const runMortgageDeskSharedLibraryDocuments = async ({ client, body, spoof }) => {
  const requestId = requestIdOf(body);
  if (!isUuid(requestId)) return { ...sqlRefusal('not_authorized'), spoofFieldsIgnored: spoof };
  const out = await callDefiner(client, DESK_SHARED_LIBRARY_DOCUMENTS_SQL, [requestId]);
  if (out.refused) return { ...out.refused, spoofFieldsIgnored: spoof };
  return { ok: true, statusCode: 200, action: 'shared_library_documents', requestId, data: out.rows, spoofFieldsIgnored: spoof };
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

// ---- Tenant Management desk view (SQL 158) ----------------------------------

const intArg = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isInteger(n) ? n : NaN;
};

/** desk_overview input: an optional tenant uuid, status, page size (1..500) and offset (>= 0). */
export const validateDeskOverviewInput = (body) => {
  const tenantRaw = arg(body, 'tenant_id', 'tenantId', '_tenant_id');
  const tenantId = tenantRaw === null || tenantRaw === '' ? null : String(tenantRaw);
  if (tenantId !== null && !isUuid(tenantId)) {
    return { ok: false, statusCode: 400, error: 'invalid_uuid', field: 'tenant_id', message: 'tenant_id must be a uuid' };
  }
  const statusRaw = arg(body, 'status', '_status');
  const status = statusRaw === null || statusRaw === '' ? null : String(statusRaw).trim();
  if (status !== null && !MORTGAGE_DESK_OVERVIEW_STATUSES.includes(status)) return sqlRefusal('invalid_status');
  const limit = intArg(arg(body, 'limit', '_limit'), MORTGAGE_DESK_OVERVIEW_DEFAULT_LIMIT);
  if (!Number.isInteger(limit) || limit < 1 || limit > MORTGAGE_DESK_OVERVIEW_MAX_LIMIT) {
    return { ok: false, statusCode: 400, error: 'invalid_limit', message: `limit must be 1 to ${MORTGAGE_DESK_OVERVIEW_MAX_LIMIT}` };
  }
  const offset = intArg(arg(body, 'offset', '_offset'), 0);
  if (!Number.isInteger(offset) || offset < 0) {
    return { ok: false, statusCode: 400, error: 'invalid_offset', message: 'offset must be 0 or more' };
  }
  return { ok: true, tenantId, status, limit, offset };
};

export const runMortgageDeskOverview = async ({ client, body, spoof }) => {
  const input = validateDeskOverviewInput(body);
  if (!input.ok) return { ...input, spoofFieldsIgnored: spoof };
  const out = await callDefiner(client, DESK_OVERVIEW_SQL, [input.tenantId, input.status, input.limit, input.offset]);
  if (out.refused) return { ...out.refused, spoofFieldsIgnored: spoof };
  const total = out.rows.length ? Number(out.rows[0].total_count) : 0;
  return {
    ok: true,
    statusCode: 200,
    action: 'desk_overview',
    data: out.rows.map(({ total_count, ...row }) => row),
    total,
    limit: input.limit,
    offset: input.offset,
    spoofFieldsIgnored: spoof,
  };
};

export const runMortgageDeskAgents = async ({ client, spoof }) => {
  const out = await callDefiner(client, DESK_ASSIGNABLE_AGENTS_SQL, []);
  if (out.refused) return { ...out.refused, spoofFieldsIgnored: spoof };
  return { ok: true, statusCode: 200, action: 'desk_agents', data: out.rows, spoofFieldsIgnored: spoof };
};

export const runMortgageDeskAgentNotes = async ({ client, body, spoof }) => {
  const requestId = requestIdOf(body);
  if (!isUuid(requestId)) return { ...sqlRefusal('not_authorized'), spoofFieldsIgnored: spoof };
  const out = await callDefiner(client, DESK_AGENT_NOTES_SQL, [requestId]);
  if (out.refused) return { ...out.refused, spoofFieldsIgnored: spoof };
  return { ok: true, statusCode: 200, action: 'agent_notes', requestId, data: out.rows, spoofFieldsIgnored: spoof };
};

/** Where an agent works the Desk; the request opens from the queue. */
export const mortgageDeskQueueUrl = () => `${signBaseUrl()}/mortgage-ops/queue`;

const requestLabel = (row) => [row.tenant_name, row.mortgage_company, row.loan_number ? `loan ${row.loan_number}` : null]
  .filter((part) => part && String(part).trim()).join(' / ') || 'a Mortgage Desk request';

/** The notice to an agent that Tenant Management assigned them a request. No note text, no homeowner data. */
export const deskAssignmentEmail = (row, url = mortgageDeskQueueUrl()) => {
  const label = requestLabel(row);
  const paragraphs = [
    `Tenant Management assigned you a Mortgage Desk request: ${label}.`,
    'It is in progress and assigned to you. Open the Mortgage Desk queue to work it.',
  ];
  const layout = renderChecksOpsEmail({
    title: 'New Mortgage Desk assignment',
    preview: `Assigned to you: ${label}`,
    greeting: row.agent_name ? `Hi ${row.agent_name},` : 'Hello,',
    paragraphs,
    ctaLabel: 'Open the Mortgage Desk',
    ctaUrl: url,
    fallbackUrl: url,
  });
  return {
    subject: `Mortgage Desk: assigned to you (${label})`.slice(0, 200),
    html: layout.html,
    text: [...paragraphs, url].join('\n\n'),
  };
};

/** "Message agent": the note itself, to the agent it is written to (who can also read it on the Desk). */
export const deskAgentNoteEmail = (row, body, url = mortgageDeskQueueUrl()) => {
  const label = requestLabel(row);
  const paragraphs = [
    `Tenant Management sent you a message about ${label}:`,
    body,
    'This message is private to you and Tenant Management. It is also saved on the request in the Mortgage Desk.',
  ];
  const layout = renderChecksOpsEmail({
    title: 'Message from Tenant Management',
    preview: `About ${label}`,
    greeting: row.agent_name ? `Hi ${row.agent_name},` : 'Hello,',
    paragraphs,
    ctaLabel: 'Open the Mortgage Desk',
    ctaUrl: url,
    fallbackUrl: url,
  });
  return {
    subject: `Mortgage Desk: message from Tenant Management (${label})`.slice(0, 200),
    html: layout.html,
    text: [...paragraphs, url].join('\n\n'),
  };
};

/** One email through the shared mailer; 'sent', 'failed' or 'skipped' (no address), with the error text if any. */
export const sendDeskAgentEmail = async ({ to, message, category, send = sendViaSesOrSink, branding = mortgageDeskEsignBranding() }) => {
  if (!to || !EMAIL_RE.test(String(to))) return { status: 'skipped', error: 'no_agent_email' };
  try {
    const sent = await send({
      to: String(to),
      subject: message.subject,
      html: message.html,
      text: message.text,
      from: branding.from,
      replyTo: branding.replyTo,
      tenantId: null,
      messageCategory: category,
    });
    const entry = sent?.results?.[0] || {};
    if (entry.status === 'failed') return { status: 'failed', error: String(entry.error || 'Email delivery failed').slice(0, 300) };
    return { status: 'sent', error: null };
  } catch (error) {
    return { status: 'failed', error: String(error?.message || error).slice(0, 300) };
  }
};

/**
 * The Mortgage Ops accrual an agent's accept runs (workflow-rpc.mjs executeAcceptMortgage): the check's $10 / $5
 * charge and SQL 153's $5 for a 2nd mortgage company, from the accepted request row, in the same transaction and
 * inside the same SAVEPOINT, so a refused accrual never undoes the assignment (owner 2026-11-12: "go with the accrual
 * fix"). Returns { status: 'accrued' | 'skipped' | 'failed', reason } and never throws.
 */
export const accrueDeskAssignment = async (client, requestId, accrue) => {
  try {
    await client.query('SAVEPOINT mortgage_ops_accrue');
  } catch (error) {
    return { status: 'failed', reason: String(error?.code || 'savepoint_failed') };
  }
  try {
    const request = (await client.query(DESK_ASSIGNED_REQUEST_SQL, [requestId])).rows[0];
    if (!request) {
      await client.query('ROLLBACK TO SAVEPOINT mortgage_ops_accrue');
      return { status: 'skipped', reason: 'request_not_readable' };
    }
    const accrueFn = accrue || (await import('./mortgage-ops-usage.mjs')).accrueMortgageOpsAcceptedRequest;
    const out = await accrueFn(client, { request, persist: true });
    await client.query('RELEASE SAVEPOINT mortgage_ops_accrue');
    if (out?.skipped) return { status: 'skipped', reason: String(out.skipped) };
    if (out?.ok === false) return { status: 'failed', reason: String(out.error || 'accrual_refused') };
    return { status: 'accrued', reason: out?.duplicate ? 'already_recorded' : null };
  } catch (error) {
    try { await client.query('ROLLBACK TO SAVEPOINT mortgage_ops_accrue'); } catch { /* the outer transaction reports it */ }
    return { status: 'failed', reason: String(error?.code || 'accrual_error') };
  }
};

/** assign_agent: SQL 158 c and the accept's Mortgage Ops accrual commit together, then a best-effort notice email. */
export const runMortgageDeskAssignAgent = async (event, deps = {}) => {
  const body = parseBody(event);
  const requestId = requestIdOf(body);
  const agentId = arg(body, 'agent_id', 'agentId', '_agent_id');
  if (!isUuid(requestId) || !isUuid(agentId)) {
    return withIdentity(event, async ({ spoof }) => ({
      ok: false, statusCode: 400, error: 'invalid_uuid', message: 'request_id and agent_id must be uuids', spoofFieldsIgnored: spoof,
    }), deps);
  }
  const assigned = await withIdentityWrite(event, async ({ client, spoof }) => {
    const out = await callDefiner(client, DESK_ASSIGN_AGENT_SQL, [requestId, agentId]);
    if (out.refused) return { ...out.refused, spoofFieldsIgnored: spoof };
    const row = out.rows[0];
    if (!row) return { ok: false, statusCode: 500, error: 'assignment_not_returned', spoofFieldsIgnored: spoof };
    const accrual = await accrueDeskAssignment(client, row.request_id, deps.accrueMortgageOpsAcceptedRequest);
    return { ok: true, statusCode: 200, row, accrual, spoofFieldsIgnored: spoof };
  }, deps);
  if (!assigned?.ok) return assigned;
  const { row, accrual } = assigned;
  const notice = await sendDeskAgentEmail({
    to: row.agent_email,
    message: deskAssignmentEmail(row),
    category: 'mortgage-desk-assignment',
    send: deps.sendViaSesOrSink || sendViaSesOrSink,
  });
  return {
    ok: true,
    statusCode: 200,
    action: 'assign_agent',
    requestId: row.request_id,
    agentId: row.agent_id,
    agentName: row.agent_name || null,
    acceptedAt: row.accepted_at || null,
    status: 'in_progress',
    accrual,
    notice: { status: notice.status, error: notice.error },
    spoofFieldsIgnored: assigned.spoofFieldsIgnored,
  };
};

/** message_agent: SQL 158 d commits the note, the email goes out, SQL 158 e records its outcome once. */
export const runMortgageDeskMessageAgent = async (event, deps = {}) => {
  const body = parseBody(event);
  const requestId = requestIdOf(body);
  const text = String(arg(body, 'body', 'message', '_body') ?? '').trim();
  if (!isUuid(requestId)) {
    return withIdentity(event, async ({ spoof }) => ({ ...sqlRefusal('not_authorized'), spoofFieldsIgnored: spoof }), deps);
  }
  if (!text || text.length > MORTGAGE_DESK_AGENT_NOTE_MAX) {
    return withIdentity(event, async ({ spoof }) => ({ ...sqlRefusal('invalid_body'), spoofFieldsIgnored: spoof }), deps);
  }
  const created = await withIdentityWrite(event, async ({ client, spoof }) => {
    const out = await callDefiner(client, DESK_ADD_AGENT_NOTE_SQL, [requestId, text]);
    if (out.refused) return { ...out.refused, spoofFieldsIgnored: spoof };
    const row = out.rows[0];
    if (!row || !isUuid(row.note_id)) return { ok: false, statusCode: 500, error: 'note_not_created', spoofFieldsIgnored: spoof };
    return { ok: true, statusCode: 200, row, spoofFieldsIgnored: spoof };
  }, deps);
  if (!created?.ok) return created;
  const { row } = created;
  const email = await sendDeskAgentEmail({
    to: row.agent_email,
    message: deskAgentNoteEmail(row, text),
    category: 'mortgage-desk-agent-note',
    send: deps.sendViaSesOrSink || sendViaSesOrSink,
  });
  const recorded = await withIdentityWrite(event, async ({ client, spoof }) => {
    const out = await callDefiner(client, DESK_RECORD_AGENT_NOTE_EMAIL_SQL, [row.note_id, email.status]);
    if (out.refused) return { ...out.refused, spoofFieldsIgnored: spoof };
    return { ok: true, statusCode: 200, recorded: out.rows[0]?.recorded === true, spoofFieldsIgnored: spoof };
  }, deps);
  const base = {
    action: 'message_agent',
    requestId: row.request_id,
    noteId: row.note_id,
    agentId: row.agent_id,
    agentName: row.agent_name || null,
    createdAt: row.created_at || null,
    email: { status: email.status, error: email.error },
    spoofFieldsIgnored: created.spoofFieldsIgnored,
  };
  if (!recorded?.ok) {
    // The note is saved and the email went out (or failed); only its status is missing. Never resend from here.
    return {
      ...base,
      ok: false,
      statusCode: 502,
      error: 'email_status_not_recorded',
      message: 'The note was saved, but the email status could not be recorded. Do not resend; contact support.',
    };
  }
  return { ...base, ok: true, statusCode: 200, emailRecorded: recorded.recorded };
};

// ---- Router ----------------------------------------------------------------

export const handleMortgageDeskEsign = async (event, deps = {}) => {
  const body = parseBody(event);
  const action = String(body?.action || '').trim();
  if (action === 'sign_url') {
    return withIdentity(event, (ctx) => runMortgageDeskSignUrl(ctx, deps), deps);
  }
  if (MORTGAGE_DESK_READ_ACTIONS.includes(action)) {
    return withIdentity(event, (ctx) => runMortgageDeskRead({ ...ctx, action }, deps), deps);
  }
  if (action === 'shared_library_documents') {
    return withIdentity(event, (ctx) => runMortgageDeskSharedLibraryDocuments(ctx), deps);
  }
  if (action === 'desk_overview') {
    return withIdentity(event, (ctx) => runMortgageDeskOverview(ctx), deps);
  }
  if (action === 'desk_agents') {
    return withIdentity(event, (ctx) => runMortgageDeskAgents(ctx), deps);
  }
  if (action === 'agent_notes') {
    return withIdentity(event, (ctx) => runMortgageDeskAgentNotes(ctx), deps);
  }
  if (action === 'assign_agent') {
    return runMortgageDeskAssignAgent(event, deps);
  }
  if (action === 'message_agent') {
    return runMortgageDeskMessageAgent(event, deps);
  }
  if (action === 'post_timeline') {
    return withIdentityWrite(event, (ctx) => runMortgageDeskPostTimeline(ctx), deps);
  }
  if (action === 'send_signature_request') {
    return runSendDeskSignatureRequest(event, deps);
  }
  if (action === 'send_tracking_link') {
    return withIdentityWrite(event, (ctx) => runMortgageDeskSendTrackingLink(ctx, deps), deps);
  }
  return withIdentity(event, async ({ spoof }) => ({
    ok: false,
    statusCode: 400,
    error: 'unknown_action',
    message: `action must be one of ${MORTGAGE_DESK_ESIGN_ACTIONS.join(', ')}`,
    spoofFieldsIgnored: spoof,
  }), deps);
};
