/**
 * Platform-wide announcements (owner only).
 *
 * POST /functions/v1/platform-announcements
 *   { action: 'list' | 'create' | 'update' | 'delete', ... }
 *
 * Only the platform owner (public.is_platform_owner()) may call any action.
 * Global user_roles admin and tenant owners/admins are refused: the
 * announcement table has no global-admin policy.
 *
 * Writes run inside withIdentityWrite, so the caller's identity GUCs are set
 * and RLS (aws_write_platform_announcements) still applies. Every write adds
 * one audit_logs row in the same transaction; if the audit insert fails the
 * write is rolled back.
 */
import { IS_PLATFORM_OWNER_SQL, parseBody, withIdentity, withIdentityWrite } from './data.mjs';

export const PLATFORM_ANNOUNCEMENTS_FUNCTION = 'platform-announcements';

export const ANNOUNCEMENT_LIMITS = Object.freeze({
  title: 120,
  message: 2000,
  refresh_instructions: 500,
});
export const ANNOUNCEMENT_SEVERITIES = Object.freeze(['info', 'maintenance', 'critical']);
const TIMESTAMP_FIELDS = Object.freeze(['starts_at', 'ends_at', 'scheduled_start', 'scheduled_end']);
const WRITE_ACTIONS = new Set(['create', 'update', 'delete']);
const ACTIONS = new Set(['list', ...WRITE_ACTIONS]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Full ISO 8601 date-time with an explicit offset. Date-only or offset-less values are refused
// so a browser's local time is never guessed.
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/;

const COLUMNS = `id, title, message, severity, scheduled_start, scheduled_end,
  refresh_instructions, is_active, starts_at, ends_at, created_by, created_at, updated_at`;

const fail = (statusCode, error, extra = {}) => ({ ok: false, statusCode, error, ...extra });

export const isIsoTimestamp = (value) => (
  typeof value === 'string' && ISO_TS_RE.test(value) && Number.isFinite(Date.parse(value))
);

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

const textField = (body, key, { required }) => {
  if (!has(body, key) || body[key] === null) {
    return required ? { error: 'missing_required_field' } : { value: null };
  }
  if (typeof body[key] !== 'string') return { error: 'invalid_field' };
  const value = body[key].trim();
  if (!value) return required ? { error: 'missing_required_field' } : { value: null };
  if (value.length > ANNOUNCEMENT_LIMITS[key]) return { error: 'field_too_long' };
  return { value };
};

/**
 * Validates announcement fields. `partial` (update) only checks the fields
 * present; create requires title and message. Returns { ok, values } or a
 * 400 refusal naming the field.
 */
export const validateAnnouncementFields = (body = {}, { partial = false } = {}) => {
  const values = {};
  for (const key of ['title', 'message']) {
    if (partial && !has(body, key)) continue;
    const result = textField(body, key, { required: true });
    if (result.error) return fail(400, result.error, { field: key });
    values[key] = result.value;
  }
  if (!partial || has(body, 'refresh_instructions')) {
    const result = textField(body, 'refresh_instructions', { required: false });
    if (result.error) return fail(400, result.error, { field: 'refresh_instructions' });
    values.refresh_instructions = result.value;
  }
  if (!partial || has(body, 'severity')) {
    const severity = has(body, 'severity') ? body.severity : 'info';
    if (!ANNOUNCEMENT_SEVERITIES.includes(severity)) return fail(400, 'invalid_field', { field: 'severity' });
    values.severity = severity;
  }
  if (has(body, 'is_active')) {
    if (typeof body.is_active !== 'boolean') return fail(400, 'invalid_field', { field: 'is_active' });
    values.is_active = body.is_active;
  } else if (!partial) {
    values.is_active = true;
  }
  for (const key of TIMESTAMP_FIELDS) {
    if (!has(body, key)) continue;
    const raw = body[key];
    if (raw === null || raw === '') {
      if (key === 'starts_at') return fail(400, 'invalid_field', { field: key });
      values[key] = null;
      continue;
    }
    if (!isIsoTimestamp(raw)) return fail(400, 'invalid_timestamp', { field: key });
    values[key] = new Date(raw).toISOString();
  }
  return { ok: true, values };
};

/** ends_at must be after starts_at; scheduled_end after scheduled_start. */
export const validateWindow = (row) => {
  const startsAt = row.starts_at ? Date.parse(row.starts_at) : Date.now();
  if (row.ends_at && !(Date.parse(row.ends_at) > startsAt)) {
    return fail(400, 'ends_at_before_starts_at', { field: 'ends_at' });
  }
  if (row.scheduled_start && row.scheduled_end
    && !(Date.parse(row.scheduled_end) > Date.parse(row.scheduled_start))) {
    return fail(400, 'scheduled_end_before_scheduled_start', { field: 'scheduled_end' });
  }
  return { ok: true };
};

const toIso = (v) => (v instanceof Date ? v.toISOString() : v ?? null);

const isPlatformOwner = async (client) => {
  const row = (await client.query(IS_PLATFORM_OWNER_SQL)).rows[0] || {};
  return row.is_owner === true;
};

const writeAudit = async (client, mapping, { action, recordId, oldValues, newValues }) => {
  const result = await client.query(
    `INSERT INTO public.audit_logs (
       user_id, action, record_type, record_id, old_values, new_values, metadata
     ) VALUES (
       $1::uuid, $2::text, $3::text, $4::text, $5::jsonb, $6::jsonb, $7::jsonb
     ) RETURNING id`,
    [
      mapping.application_user_id,
      action,
      'platform_announcement',
      recordId,
      oldValues ? JSON.stringify(oldValues) : null,
      newValues ? JSON.stringify(newValues) : null,
      JSON.stringify({ actor_user_id: mapping.application_user_id, source: PLATFORM_ANNOUNCEMENTS_FUNCTION }),
    ],
  );
  if (!result || (!(result.rows || []).length && !(result.rowCount > 0))) {
    const err = new Error('audit_failed');
    err.code = 'audit_failed';
    throw err;
  }
};

const auditSnapshot = (row) => row && ({
  title: row.title,
  severity: row.severity,
  is_active: row.is_active,
  starts_at: toIso(row.starts_at),
  ends_at: toIso(row.ends_at),
  scheduled_start: toIso(row.scheduled_start),
  scheduled_end: toIso(row.scheduled_end),
});

const handleList = async (client) => {
  const { rows } = await client.query(
    `SELECT ${COLUMNS} FROM public.platform_announcements ORDER BY created_at DESC LIMIT 200`,
  );
  return { ok: true, statusCode: 200, announcements: rows };
};

const handleCreate = async (client, mapping, body) => {
  const parsed = validateAnnouncementFields(body, { partial: false });
  if (!parsed.ok) return parsed;
  const v = parsed.values;
  const window = validateWindow(v);
  if (!window.ok) return window;
  const { rows } = await client.query(
    `INSERT INTO public.platform_announcements
       (title, message, severity, scheduled_start, scheduled_end, refresh_instructions,
        is_active, starts_at, ends_at, created_by)
     VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6, $7,
             COALESCE($8::timestamptz, now()), $9::timestamptz, $10::uuid)
     RETURNING ${COLUMNS}`,
    [
      v.title, v.message, v.severity, v.scheduled_start ?? null, v.scheduled_end ?? null,
      v.refresh_instructions, v.is_active, v.starts_at ?? null, v.ends_at ?? null,
      mapping.application_user_id,
    ],
  );
  const row = rows[0];
  if (!row) return fail(403, 'rls_denied');
  await writeAudit(client, mapping, {
    action: 'platform_announcement.create',
    recordId: row.id,
    newValues: auditSnapshot(row),
  });
  return { ok: true, statusCode: 200, announcement: row };
};

const requireId = (body) => (
  typeof body.id === 'string' && UUID_RE.test(body.id) ? null : fail(400, 'invalid_field', { field: 'id' })
);

const handleUpdate = async (client, mapping, body) => {
  const badId = requireId(body);
  if (badId) return badId;
  const parsed = validateAnnouncementFields(body, { partial: true });
  if (!parsed.ok) return parsed;
  const patch = parsed.values;
  const keys = Object.keys(patch);
  if (!keys.length) return fail(400, 'no_fields_to_update');

  const existing = (await client.query(
    `SELECT ${COLUMNS} FROM public.platform_announcements WHERE id = $1::uuid FOR UPDATE`,
    [body.id],
  )).rows[0];
  if (!existing) return fail(404, 'not_found');

  const merged = {
    starts_at: toIso(existing.starts_at),
    ends_at: toIso(existing.ends_at),
    scheduled_start: toIso(existing.scheduled_start),
    scheduled_end: toIso(existing.scheduled_end),
    ...patch,
  };
  const window = validateWindow(merged);
  if (!window.ok) return window;

  // Column names come from the fixed validator output, never from the request.
  const sets = keys.map((key, i) => {
    const cast = TIMESTAMP_FIELDS.includes(key) ? '::timestamptz' : (key === 'is_active' ? '::boolean' : '');
    return `${key} = $${i + 2}${cast}`;
  });
  const { rows } = await client.query(
    `UPDATE public.platform_announcements SET ${sets.join(', ')}, updated_at = now()
      WHERE id = $1::uuid RETURNING ${COLUMNS}`,
    [body.id, ...keys.map((key) => patch[key])],
  );
  const row = rows[0];
  if (!row) return fail(403, 'rls_denied');
  await writeAudit(client, mapping, {
    action: 'platform_announcement.update',
    recordId: row.id,
    oldValues: auditSnapshot(existing),
    newValues: auditSnapshot(row),
  });
  return { ok: true, statusCode: 200, announcement: row };
};

const handleDelete = async (client, mapping, body) => {
  const badId = requireId(body);
  if (badId) return badId;
  const { rows } = await client.query(
    `DELETE FROM public.platform_announcements WHERE id = $1::uuid RETURNING ${COLUMNS}`,
    [body.id],
  );
  const row = rows[0];
  if (!row) return fail(404, 'not_found');
  await writeAudit(client, mapping, {
    action: 'platform_announcement.delete',
    recordId: row.id,
    oldValues: auditSnapshot(row),
  });
  return { ok: true, statusCode: 200, deleted: row.id };
};

const dispatch = async ({ client, mapping, body, spoof }) => {
  const action = body.action;
  if (!(await isPlatformOwner(client))) {
    return fail(403, 'forbidden', { code: 'platform_owner_required', spoofFieldsIgnored: spoof });
  }
  let result;
  if (action === 'list') result = await handleList(client);
  else if (action === 'create') result = await handleCreate(client, mapping, body);
  else if (action === 'update') result = await handleUpdate(client, mapping, body);
  else result = await handleDelete(client, mapping, body);
  return { ...result, spoofFieldsIgnored: spoof };
};

export const handlePlatformAnnouncements = async (event, deps = {}) => {
  const body = parseBody(event) || {};
  if (!ACTIONS.has(body.action)) return fail(400, 'unknown_action');
  const wrap = WRITE_ACTIONS.has(body.action) ? withIdentityWrite : withIdentity;
  try {
    return await wrap(event, dispatch, deps);
  } catch (err) {
    if (err?.statusCode === 401) return fail(401, 'unauthorized');
    return fail(err?.code === 'audit_failed' ? 503 : (err?.statusCode || 500),
      err?.code === 'audit_failed' ? 'audit_failed' : 'platform_announcements_failed');
  }
};
