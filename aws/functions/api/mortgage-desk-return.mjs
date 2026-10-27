/**
 * Mortgage Desk returns its work to the tenant (SQL 122).
 *
 * Owner (2026-10-27): "Need to make sure when the mortgage desk is done with
 * their work, it gets sent back to the tenant, with all the proper notes and
 * documentation."
 *
 * A Mortgage Agent is not a member of the requesting tenant, so on AWS its
 * check_messages / check_files inserts and its shipping updates on
 * mortgage_handling_requests were refused. These RPCs (POST /data/rpc, routed
 * by workflow-rpc.mjs) let the agent assigned to an in-progress request, or the
 * platform owner, write them through SQL 122's SECURITY DEFINER functions:
 *
 *   mortgage_desk_post_message     -> aws_mortgage_desk_post_message
 *   mortgage_desk_attach_file      -> aws_mortgage_desk_attach_file
 *   mortgage_desk_update_shipping  -> aws_mortgage_desk_update_shipping
 *
 * The caller is checked here first (clear refusals, no database write for a
 * refused caller) and again inside every function (auth.uid() against
 * mortgage_handling_requests.assigned_employee_id). The check and its tenant
 * always come from the request row, never from the client.
 *
 * Mid-work notes: the Desk appends them through
 * update_mortgage_handling_request_status (status in_progress). They are also
 * posted on the check thread as "📝 ChecksOps Mortgage Desk note: ..." so the
 * tenant reads them where it already reads every other check message (and
 * the homeowner ledger mirror picks them up as for any message); work_notes
 * stays the Desk's own record.
 *
 * Completion: SQL 99 still posts the completed-work note and the return
 * marker. After the completion commits, the tenant is emailed once
 * (aws_mortgage_desk_return_email_claim) with the Desk's note, the documents it
 * returned and a link to the company's Checks page. The email never names a
 * payment or deposit provider.
 */
import { renderChecksOpsEmail } from './email-layout.mjs';
import { emailAssetOrigin, platformBranding } from './email-branding.mjs';
import { normalizeEmail } from './email-policy.mjs';
import { USER_ROLES_SQL } from './identity.mjs';
import { withIdentityWrite } from './data.mjs';

// Loaded at send time: email.mjs imports the SES client, which a module that only routes the Desk
// RPCs (workflow-rpc.mjs, and the tests that load it) must not need at import time.
const sendViaSesOrSink = async (...args) => {
  const { sendViaSesOrSink: send } = await import('./email.mjs');
  return send(...args);
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isUuid = (value) => UUID_RE.test(String(value || ''));

export const MORTGAGE_DESK_POST_MESSAGE = 'mortgage_desk_post_message';
export const MORTGAGE_DESK_ATTACH_FILE = 'mortgage_desk_attach_file';
export const MORTGAGE_DESK_UPDATE_SHIPPING = 'mortgage_desk_update_shipping';

export const MORTGAGE_DESK_RPCS = Object.freeze(new Set([
  MORTGAGE_DESK_POST_MESSAGE,
  MORTGAGE_DESK_ATTACH_FILE,
  MORTGAGE_DESK_UPDATE_SHIPPING,
]));

export const MORTGAGE_DESK_FILE_CATEGORIES = Object.freeze([
  'mortgage_ops',
  'mortgage_ops_signature',
  'mortgage_ops_shipping_label',
]);

/** Field -> max length, as aws_mortgage_desk_update_shipping enforces. */
export const MORTGAGE_DESK_SHIPPING_FIELDS = Object.freeze({
  mail_to_name: 200,
  mail_to_address: 1000,
  shipping_label_carrier: 100,
  shipping_label_tracking: 200,
  shipping_label_name: 255,
  shipping_label_path: 512,
  check_sent_date: 64,
  check_received_back_date: 64,
});

export const MORTGAGE_DESK_MAX_MESSAGE = 5000;
export const MORTGAGE_DESK_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MORTGAGE_DESK_NOTE_PREFIX = '📝 ChecksOps Mortgage Desk note: ';
export const MORTGAGE_DESK_RETURN_EMAIL_TEMPLATE = 'mortgage-desk-return';
export const MORTGAGE_DESK_RETURN_EMAIL_FLAG = 'AWS_MORTGAGE_DESK_RETURN_EMAIL_ENABLED';

// SELECT * FROM f(): a composite function in the select list, (f()).*, would run once per column.
export const POST_MESSAGE_SQL = 'SELECT * FROM public.aws_mortgage_desk_post_message($1::uuid, $2::text)';
export const ATTACH_FILE_SQL = `SELECT * FROM public.aws_mortgage_desk_attach_file(
  $1::uuid, $2::text, $3::text, $4::text, $5::bigint, $6::text, $7::text)`;
export const UPDATE_SHIPPING_SQL = 'SELECT * FROM public.aws_mortgage_desk_update_shipping($1::uuid, $2::jsonb)';
export const COMPLETION_TIMELINE_SQL = 'SELECT public.aws_mortgage_desk_completion_timeline($1::uuid) AS id';
export const RETURN_EMAIL_CLAIM_SQL = 'SELECT public.aws_mortgage_desk_return_email_claim($1::uuid) AS claim';

export const MORTGAGE_DESK_REQUEST_SQL = `SELECT id, tenant_id, check_intake_item_id, status, assigned_employee_id
FROM public.mortgage_handling_requests
WHERE id = $1::uuid`;

const arg = (args, ...keys) => {
  for (const key of keys) {
    if (args?.[key] !== undefined && args?.[key] !== null) return args[key];
  }
  return null;
};

/** The note posted on the check thread for a mid-work Desk note. */
export const buildMortgageDeskNoteMessage = (note) => {
  const text = String(note ?? '').trim();
  if (!text) return null;
  return `${MORTGAGE_DESK_NOTE_PREFIX}${text}`.slice(0, MORTGAGE_DESK_MAX_MESSAGE);
};

export const mortgageDeskReturnEmailEnabled = (env = process.env) => (
  String(env[MORTGAGE_DESK_RETURN_EMAIL_FLAG] || '').trim().toLowerCase() !== 'false'
);

export const PLATFORM_OWNER_SQL = 'SELECT COALESCE(public.is_platform_owner(), false) AS is_owner';

const isPlatformOwner = async (client) => (
  (await client.query(PLATFORM_OWNER_SQL)).rows[0]?.is_owner === true
);

/**
 * The request the caller may write for, or a refusal. Allowed: the platform
 * owner, or a mortgage_agent who is the request's assigned_employee_id. The
 * request must be in one of `statuses` and have a check. Nothing the client
 * sends besides the request id is used.
 */
export const loadMortgageDeskWorkingRequest = async (client, userId, requestId, { statuses = ['in_progress'] } = {}) => {
  if (!isUuid(requestId)) return { error: 'invalid_uuid', field: '_request_id' };
  if (!isUuid(userId)) return { error: 'not_authorized', message: 'not_authorized' };
  // RLS: agents see open and own requests, tenants their own tenant's; a
  // request the caller cannot see is refused like one it may not work.
  const request = (await client.query(MORTGAGE_DESK_REQUEST_SQL, [requestId])).rows[0];
  if (!request) return { error: 'not_authorized', message: 'not_authorized' };
  const owner = await isPlatformOwner(client);
  if (!owner) {
    const roles = (await client.query(USER_ROLES_SQL, [userId])).rows
      .map((row) => String(row.role || '').toLowerCase());
    if (!roles.includes('mortgage_agent')) {
      return { error: 'not_authorized', message: 'Mortgage Desk agents only' };
    }
    if (String(request.assigned_employee_id || '').toLowerCase() !== String(userId).toLowerCase()) {
      return { error: 'not_assigned_to_you', message: 'not_assigned_to_you' };
    }
  }
  if (!statuses.includes(String(request.status || ''))) {
    return { error: 'request_not_in_progress', message: `Request is ${request.status || 'unknown'}` };
  }
  if (!isUuid(request.check_intake_item_id)) {
    return { error: 'request_has_no_check', message: 'This request has no linked check' };
  }
  return { request, platformOwner: owner };
};

export const MORTGAGE_DESK_UPLOAD_SQL = `SELECT 1
FROM public.mortgage_handling_requests
WHERE check_intake_item_id = $1::uuid
  AND assigned_employee_id = $2::uuid
  AND status = 'in_progress'
LIMIT 1`;

/**
 * Storage upload grant for the Desk (storage-write-auth.mjs): a mortgage_agent
 * with an in-progress request on this check assigned to it may place a new
 * object under checks/<checkId>/mortgage-ops/. Nothing else.
 */
export const mortgageDeskCanUploadForCheck = async (client, userId, checkId) => {
  if (!isUuid(userId) || !isUuid(checkId)) return false;
  const roles = (await client.query(USER_ROLES_SQL, [userId])).rows
    .map((row) => String(row.role || '').toLowerCase());
  if (!roles.includes('mortgage_agent')) return false;
  return (await client.query(MORTGAGE_DESK_UPLOAD_SQL, [checkId, userId])).rows.length > 0;
};

/** checks/<checkId>/mortgage-ops/<one file name>, the prefix SQL 122 accepts. */
export const isMortgageDeskFilePath = (path, checkId) => {
  const text = String(path || '');
  const prefix = `checks/${String(checkId || '').toLowerCase()}/mortgage-ops/`;
  if (!isUuid(checkId) || text.length > 512 || !text.startsWith(prefix)) return false;
  const name = text.slice(prefix.length);
  return name.length > 0 && !name.includes('/') && !text.includes('..');
};

const executePostMessage = async ({ client, mapping, args }) => {
  const requestId = arg(args, '_request_id', 'request_id');
  const body = String(arg(args, '_body', 'body') ?? '').trim();
  if (!body || body.length > MORTGAGE_DESK_MAX_MESSAGE) return { error: 'invalid_field', field: '_body' };
  const gate = await loadMortgageDeskWorkingRequest(client, mapping.application_user_id, requestId);
  if (gate.error) return gate;
  const row = (await client.query(POST_MESSAGE_SQL, [gate.request.id, body])).rows[0];
  return { data: row || null };
};

const executeAttachFile = async ({ client, mapping, args }) => {
  const requestId = arg(args, '_request_id', 'request_id');
  const filePath = String(arg(args, '_file_path', 'file_path') ?? '').trim();
  const fileName = String(arg(args, '_file_name', 'file_name') ?? '').trim();
  const category = String(arg(args, '_category', 'category') ?? 'mortgage_ops').trim() || 'mortgage_ops';
  const sizeRaw = arg(args, '_file_size', 'file_size');
  const size = sizeRaw == null ? null : Number(sizeRaw);
  if (!fileName || fileName.length > 255) return { error: 'invalid_field', field: '_file_name' };
  if (!MORTGAGE_DESK_FILE_CATEGORIES.includes(category)) return { error: 'invalid_field', field: '_category' };
  if (size != null && (!Number.isInteger(size) || size < 0 || size > MORTGAGE_DESK_MAX_UPLOAD_BYTES)) {
    return { error: 'invalid_field', field: '_file_size' };
  }
  const gate = await loadMortgageDeskWorkingRequest(client, mapping.application_user_id, requestId);
  if (gate.error) return gate;
  if (!isMortgageDeskFilePath(filePath, gate.request.check_intake_item_id)) {
    return { error: 'invalid_field', field: '_file_path', message: 'Desk files live under checks/<check>/mortgage-ops/' };
  }
  const fileType = arg(args, '_file_type', 'file_type');
  const description = arg(args, '_description', 'description');
  const row = (await client.query(ATTACH_FILE_SQL, [
    gate.request.id,
    fileName,
    filePath,
    fileType == null ? null : String(fileType).slice(0, 120),
    size,
    category,
    description == null ? null : String(description).slice(0, 1000),
  ])).rows[0];
  return { data: row || null };
};

const executeUpdateShipping = async ({ client, mapping, args }) => {
  const requestId = arg(args, '_request_id', 'request_id');
  const fields = arg(args, '_fields', 'fields');
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    return { error: 'invalid_field', field: '_fields' };
  }
  const keys = Object.keys(fields);
  if (!keys.length) return { error: 'invalid_field', field: '_fields' };
  for (const key of keys) {
    const max = MORTGAGE_DESK_SHIPPING_FIELDS[key];
    if (!max) return { error: 'column_not_allowlisted', field: key };
    const value = fields[key];
    if (value !== null && typeof value !== 'string') return { error: 'invalid_field', field: key };
    if (typeof value === 'string' && value.length > max) return { error: 'invalid_field', field: key };
    if ((key === 'check_sent_date' || key === 'check_received_back_date')
      && typeof value === 'string' && value.trim() && Number.isNaN(Date.parse(value))) {
      return { error: 'invalid_field', field: key };
    }
  }
  const gate = await loadMortgageDeskWorkingRequest(client, mapping.application_user_id, requestId);
  if (gate.error) return gate;
  if (typeof fields.shipping_label_path === 'string' && fields.shipping_label_path.trim()
    && !isMortgageDeskFilePath(fields.shipping_label_path.trim(), gate.request.check_intake_item_id)) {
    return { error: 'invalid_field', field: 'shipping_label_path' };
  }
  const row = (await client.query(UPDATE_SHIPPING_SQL, [gate.request.id, JSON.stringify(fields)])).rows[0];
  return { data: row || null };
};

export const executeMortgageDeskRpc = async ({ client, mapping, name, args = {} }) => {
  switch (name) {
    case MORTGAGE_DESK_POST_MESSAGE:
      return executePostMessage({ client, mapping, args });
    case MORTGAGE_DESK_ATTACH_FILE:
      return executeAttachFile({ client, mapping, args });
    case MORTGAGE_DESK_UPDATE_SHIPPING:
      return executeUpdateShipping({ client, mapping, args });
    default:
      return { error: 'rpc_disabled', name };
  }
};

/**
 * Runs `fn` inside a savepoint so a failure (SQL 122 not applied yet, a
 * refusal) never aborts the caller's transaction. Returns { ok, value } or
 * { ok: false, error }.
 */
const inSavepoint = async (client, name, fn) => {
  await client.query(`SAVEPOINT ${name}`);
  try {
    const value = await fn();
    await client.query(`RELEASE SAVEPOINT ${name}`);
    return { ok: true, value };
  } catch (error) {
    try { await client.query(`ROLLBACK TO SAVEPOINT ${name}`); } catch { /* ignore */ }
    return { ok: false, error: String(error?.message || error).slice(0, 240) };
  }
};

/**
 * Called by update_mortgage_handling_request_status after its UPDATE, in the
 * same transaction. in_progress + a note: the note is posted on the check
 * thread. completed: the homeowner timeline row. Never fails the status
 * change; the outcome is reported to the Desk.
 */
export const afterMortgageDeskStatusUpdate = async (client, { request, status, note }) => {
  if (!request?.id) return {};
  if (status === 'in_progress') {
    const body = buildMortgageDeskNoteMessage(note);
    if (!body || !request.check_intake_item_id) return {};
    const posted = await inSavepoint(client, 'mortgage_desk_note_message', () => (
      client.query(POST_MESSAGE_SQL, [request.id, body])
    ));
    return { tenant_message_posted: posted.ok };
  }
  if (status === 'completed' && request.check_intake_item_id) {
    const timeline = await inSavepoint(client, 'mortgage_desk_completion_timeline', () => (
      client.query(COMPLETION_TIMELINE_SQL, [request.id])
    ));
    return { homeowner_timeline_posted: timeline.ok };
  }
  return {};
};

const plainDate = (value) => {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 10) : null;
};

/** The tenant's Checks page, where the returned check, its notes and documents are. */
export const mortgageDeskReturnLink = (claim, origin = emailAssetOrigin()) => {
  const base = String(origin || '').replace(/\/$/, '');
  const slug = String(claim?.tenant_slug || '').trim();
  if (!base) return null;
  return slug && /^[a-z0-9][a-z0-9-]{0,80}$/i.test(slug) ? `${base}/${slug}/checks` : `${base}/checks`;
};

/**
 * The "work returned" email. Contents: the company and check, the Desk's
 * completion note, the documents it returned and a link to the check list.
 * No account numbers, no amounts, no payment or deposit provider.
 */
export const buildMortgageDeskReturnEmail = (claim, { link = mortgageDeskReturnLink(claim), branding = platformBranding() } = {}) => {
  const company = String(claim?.mortgage_company || '').trim() || 'the mortgage company';
  const checkLabel = claim?.check_number ? `check #${String(claim.check_number).slice(0, 40)}` : 'your check';
  const note = String(claim?.note || '').trim().slice(0, 4000);
  const documents = Array.isArray(claim?.documents) ? claim.documents : [];
  const docNames = documents
    .map((doc) => String(doc?.file_name || '').trim())
    .filter(Boolean)
    .slice(0, 25);
  const completed = plainDate(claim?.completed_at);
  const paragraphs = [
    `The ChecksOps Mortgage Desk finished its work with ${company} on ${checkLabel}${completed ? ` (${completed})` : ''} and returned it to you.`,
    note ? `Desk notes: ${note}` : 'The Desk left no closing note.',
    docNames.length
      ? `Documents returned on the check: ${docNames.join(', ')}.`
      : 'No documents were attached by the Desk.',
    'Open the check in ChecksOps to review the notes and documents, then acknowledge the return and continue processing.',
  ];
  const title = 'Mortgage Desk returned your check';
  const layout = renderChecksOpsEmail({
    title,
    preview: `${company}: ${checkLabel} is back from the Mortgage Desk`,
    paragraphs,
    ctaLabel: link ? 'Review the returned check' : null,
    ctaUrl: link,
    fallbackUrl: link,
    companySubtitle: String(claim?.tenant_name || '').slice(0, 120) || null,
    logoUrl: branding?.logoUrl || null,
  });
  return {
    subject: `Mortgage Desk returned ${checkLabel} (${company})`.slice(0, 200),
    html: layout.html,
    text: [title, ...paragraphs, link ? `Review: ${link}` : null].filter(Boolean).join('\n\n'),
  };
};

const logReturnEmail = async (client, row) => {
  await inSavepoint(client, 'mortgage_desk_return_email_log', () => client.query(
    `INSERT INTO public.email_send_log (
       template_name, recipient_email, tenant_id, status, provider, provider_message_id,
       idempotency_key, error_message, metadata, created_at
     ) VALUES ($1, $2, $3::uuid, $4, 'aws_staging', $5, $6, $7, $8::jsonb, now())`,
    [
      MORTGAGE_DESK_RETURN_EMAIL_TEMPLATE,
      row.recipient,
      row.tenantId,
      row.status,
      row.messageId || null,
      `${MORTGAGE_DESK_RETURN_EMAIL_TEMPLATE}:${row.requestId}:${row.recipient}`,
      row.error || null,
      JSON.stringify(row.metadata || {}),
    ],
  ));
};

/**
 * Claim and send the "work returned" email of one completed request, inside
 * the caller's transaction (withIdentityWrite). Returns { ok: false } when the
 * send failed so the caller rolls back and return_emailed_at stays unset.
 */
export const runMortgageDeskReturnEmail = async ({ client, mapping, requestId, send = sendViaSesOrSink, env = process.env }) => {
  if (!mortgageDeskReturnEmailEnabled(env)) return { ok: true, status: 'disabled', emailed: false };
  if (!isUuid(requestId)) return { ok: false, statusCode: 400, error: 'invalid_uuid', field: 'request_id' };
  const gate = await loadMortgageDeskWorkingRequest(client, mapping.application_user_id, requestId, { statuses: ['completed'] });
  if (gate.error) {
    return { ok: false, statusCode: gate.error === 'invalid_uuid' ? 400 : 403, ...gate };
  }
  const claim = (await client.query(RETURN_EMAIL_CLAIM_SQL, [gate.request.id])).rows[0]?.claim;
  if (!claim || claim.claimed !== true) {
    return { ok: true, status: claim?.reason || 'not_claimed', emailed: false };
  }
  const recipients = [...new Set((claim.recipients || []).map((email) => normalizeEmail(email)).filter((email) => email && email.includes('@')))];
  if (!recipients.length) return { ok: false, statusCode: 409, error: 'no_recipient', emailed: false };
  const branding = platformBranding();
  const rendered = buildMortgageDeskReturnEmail(claim, { branding });
  const result = await send({
    to: recipients,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    from: branding.from,
    replyTo: branding.replyTo,
    tenantId: claim.tenant_id || null,
    messageCategory: MORTGAGE_DESK_RETURN_EMAIL_TEMPLATE,
  });
  const entries = Array.isArray(result?.results) ? result.results : [];
  const delivered = entries.filter((entry) => entry.status === 'sent' || entry.status === 'sunk');
  for (const entry of entries) {
    await logReturnEmail(client, {
      recipient: entry.to || entry.originalTo,
      tenantId: claim.tenant_id || null,
      status: entry.status === 'failed' ? 'failed' : 'sent',
      messageId: entry.messageId || null,
      requestId: claim.request_id,
      error: entry.error || null,
      metadata: {
        request_id: claim.request_id,
        check_id: claim.check_id,
        recipient_source: claim.recipient_source || null,
        delivery: entry.delivery || null,
        application_user_id: mapping.application_user_id,
      },
    });
  }
  if (!delivered.length) {
    return { ok: false, statusCode: 502, error: 'email_send_failed', emailed: false };
  }
  return {
    ok: true,
    status: 'sent',
    emailed: true,
    recipients: delivered.length,
    recipientSource: claim.recipient_source || null,
    stagingMode: result?.mode || null,
  };
};

/**
 * POST /functions/v1/notify-mortgage-desk-return { request_id }: (re)send the
 * email of a completed request whose email did not go out (at most once per
 * request; the assigned agent or the platform owner).
 */
export const handleNotifyMortgageDeskReturn = async (event, deps = {}) => {
  return withIdentityWrite(event, async ({ client, mapping, body, spoof }) => {
    const out = await runMortgageDeskReturnEmail({
      client,
      mapping,
      requestId: body?.request_id || body?.requestId,
      send: deps.sendViaSesOrSink || sendViaSesOrSink,
    });
    return { statusCode: out.ok ? 200 : (out.statusCode || 400), ...out, spoofFieldsIgnored: spoof };
  }, deps);
};
