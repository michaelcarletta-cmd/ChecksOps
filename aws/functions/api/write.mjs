import { ident, ignoredSpoof, parseBody, withIdentity, withIdentityWrite } from './data.mjs';
import {
  CLIENT_IDENTITY_KEYS,
  T5_INTAKE_COLUMNS,
  WRITE_ALLOWLIST,
  applicationWorkflowWritesEnabled,
  checkWorkflowWritesEnabled,
  denyTableReason,
  pickAllowlistedValues,
  writesEnabled,
} from './write-allowlist.mjs';
import { executeCheckWorkflowWrite } from './write-check-workflow.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isUuid = (value) => UUID_RE.test(String(value || ''));

const firstRow = (payload) => {
  if (Array.isArray(payload)) {
    if (payload.length > 1) {
      return { error: 'batch_writes_disabled', message: 'AWS writes accept a single row per request' };
    }
    return { row: payload[0] || {} };
  }
  if (payload && typeof payload === 'object') return { row: payload };
  return { row: {} };
};

const requireUuid = (name, value) => {
  if (!isUuid(value)) {
    return { error: 'invalid_uuid', field: name };
  }
  return null;
};

const coerceBoolean = (value, fallback) => {
  if (value === undefined || value === null) return fallback;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return fallback;
};

const filterCheckId = (filters = []) => {
  const match = (filters || []).find((filter) => filter?.column === 'check_id' && (filter.op || 'eq') === 'eq');
  return match?.value || null;
};

const okResult = ({ mapping, claims, spoof, data, count = null }) => ({
  ok: true,
  statusCode: 200,
  data,
  count,
  applicationUserId: mapping.application_user_id,
  authUid: mapping.application_user_id,
  cognitoSub: claims.sub,
  spoofFieldsIgnored: spoof,
  authorizationSource: 'rls',
  writesEnabled: true,
});

const denied = (spoof, extra) => ({
  ok: false,
  statusCode: extra.statusCode || 403,
  spoofFieldsIgnored: spoof,
  ...extra,
});

const executeCheckMessageReads = async ({ client, mapping, op, values, filters }) => {
  const uid = mapping.application_user_id;
  const checkId = values.check_id || filterCheckId(filters);
  if (op === 'delete') {
    const params = [uid];
    let sql = 'DELETE FROM public.check_message_reads WHERE user_id = $1::uuid';
    if (checkId) {
      const invalid = requireUuid('check_id', checkId);
      if (invalid) return invalid;
      params.push(checkId);
      sql += ` AND check_id = $2::uuid`;
    }
    sql += ' RETURNING *';
    const rows = (await client.query(sql, params)).rows;
    return { rows };
  }

  const invalid = requireUuid('check_id', checkId);
  if (invalid) return invalid;
  const lastReadAt = values.last_read_at || new Date().toISOString();

  if (op === 'update') {
    const rows = (await client.query(
      `UPDATE public.check_message_reads
       SET last_read_at = $3::timestamptz
       WHERE user_id = $1::uuid AND check_id = $2::uuid
       RETURNING *`,
      [uid, checkId, lastReadAt],
    )).rows;
    return { rows };
  }

  const rows = (await client.query(
    `INSERT INTO public.check_message_reads (user_id, check_id, last_read_at)
     VALUES ($1::uuid, $2::uuid, $3::timestamptz)
     ON CONFLICT (user_id, check_id)
     DO UPDATE SET last_read_at = EXCLUDED.last_read_at
     RETURNING *`,
    [uid, checkId, lastReadAt],
  )).rows;
  return { rows };
};

const executeNotificationPreferences = async ({ client, mapping, op, values, filters }) => {
  const uid = mapping.application_user_id;
  if (op === 'get_or_create') {
    const existing = (await client.query(
      'SELECT * FROM public.notification_preferences WHERE user_id = $1::uuid',
      [uid],
    )).rows;
    if (existing.length) return { rows: existing };
    const rows = (await client.query(
      `INSERT INTO public.notification_preferences (user_id, in_app_enabled, email_enabled, sms_enabled)
       VALUES ($1::uuid, true, true, false)
       RETURNING *`,
      [uid],
    )).rows;
    return { rows };
  }

  if (op === 'delete') {
    const rows = (await client.query(
      'DELETE FROM public.notification_preferences WHERE user_id = $1::uuid RETURNING *',
      [uid],
    )).rows;
    return { rows };
  }

  const inApp = coerceBoolean(values.in_app_enabled, true);
  const email = coerceBoolean(values.email_enabled, true);
  const sms = coerceBoolean(values.sms_enabled, false);

  if (op === 'insert') {
    const rows = (await client.query(
      `INSERT INTO public.notification_preferences (user_id, in_app_enabled, email_enabled, sms_enabled)
       VALUES ($1::uuid, $2::boolean, $3::boolean, $4::boolean)
       RETURNING *`,
      [uid, inApp, email, sms],
    )).rows;
    return { rows };
  }

  const rows = (await client.query(
    `UPDATE public.notification_preferences
     SET in_app_enabled = $2::boolean,
         email_enabled = $3::boolean,
         sms_enabled = $4::boolean
     WHERE user_id = $1::uuid
     RETURNING *`,
    [uid, inApp, email, sms],
  )).rows;
  return { rows };
};

export const executeAllowlistedWrite = async ({
  client,
  mapping,
  body,
  checkWorkflowEnabled = true,
  applicationWorkflowEnabled = false,
}) => {
  let table;
  try {
    table = ident(body.table, 'table');
  } catch {
    return { error: 'table_not_allowlisted', reason: denyTableReason(String(body.table || '')), table: body.table || null };
  }
  const op = String(body.op || body.operation || '').toLowerCase();
  const spec = WRITE_ALLOWLIST[table];
  if (!spec) {
    return {
      error: 'table_not_allowlisted',
      reason: denyTableReason(table),
      table,
    };
  }
  if (!spec.ops.has(op)) {
    return { error: 'operation_not_allowlisted', table, op };
  }
  if ((spec.tranche === 2 || spec.tranche === 3) && !checkWorkflowEnabled) {
    return {
      error: 'check_workflow_writes_disabled',
      message: 'Check-workflow writes are disabled by AWS_CHECK_WORKFLOW_WRITES_ENABLED',
      table,
    };
  }
  if ((spec.tranche === 5 || spec.tranche === 6) && !applicationWorkflowEnabled) {
    return {
      error: 'application_workflow_writes_disabled',
      message: 'Application-workflow writes are disabled by AWS_APPLICATION_WORKFLOW_WRITES_ENABLED',
      table,
    };
  }

  if (op === 'get_or_create') {
    return executeNotificationPreferences({ client, mapping, op, values: {}, filters: [] });
  }

  const raw = firstRow(body.values || body.payload || body.row);
  if (raw.error) return raw;
  const picked = pickAllowlistedValues(table, raw.row);
  if (picked.error) return picked;

  const required = spec.requiredForWrite[op] || [];
  for (const col of required) {
    if (picked.values[col] == null && !(body.filters || []).some((f) => f.column === col)) {
      return { error: 'missing_required_field', field: col, table, op };
    }
  }

  if (table === 'check_message_reads') {
    return executeCheckMessageReads({
      client,
      mapping,
      op,
      values: picked.values,
      filters: body.filters || [],
    });
  }
  if (table === 'notification_preferences') {
    return executeNotificationPreferences({
      client,
      mapping,
      op,
      values: picked.values,
      filters: body.filters || [],
    });
  }
  const t5ColumnsUsed = Object.keys(picked.values || {}).some((column) => (
    (spec.t5Columns && spec.t5Columns.has(column)) || T5_INTAKE_COLUMNS.has(column)
  ));
  if (t5ColumnsUsed && !applicationWorkflowEnabled) {
    return {
      error: 'application_workflow_writes_disabled',
      message: 'Mortgage/loss-draft columns require AWS_APPLICATION_WORKFLOW_WRITES_ENABLED',
      columns: Object.keys(picked.values).filter((column) => T5_INTAKE_COLUMNS.has(column)),
      table,
    };
  }
  if (spec.tranche === 2 || spec.tranche === 3 || spec.tranche === 5 || spec.tranche === 6
    || table === 'audit_logs' || table === 'user_sessions') {
    return executeCheckWorkflowWrite({
      client,
      mapping,
      table,
      op,
      values: picked.values,
      filters: body.filters || [],
    });
  }
  return { error: 'table_not_allowlisted', table };
};

export const handleWrite = async (event, deps = {}) => {
  const body = parseBody(event);
  const spoof = ignoredSpoof(event, body);
  const enabled = deps.forceEnabled === true || writesEnabled();
  if (!enabled) {
    return withIdentity(event, async () => denied(spoof, {
      error: 'writes_disabled',
      message: 'AWS writes are disabled by server-side kill switch AWS_WRITES_ENABLED',
    }), deps);
  }

  return withIdentityWrite(event, async ({ client, mapping, claims, body, spoof }) => {
    if (body.sql || body.query || body.where || body.rawSql) {
      return denied(spoof, {
        error: 'generic_sql_denied',
        message: 'Arbitrary SQL, table names, and WHERE clauses are not accepted',
      });
    }
    if (Array.isArray(body.filters)) {
      const bad = body.filters
        .map((filter) => String(filter?.column || ''))
        .filter((column) => column && specFilterDenied(body.table, column));
      if (bad.length) {
        return denied(spoof, { error: 'column_not_allowlisted', columns: bad });
      }
    }

    const checkWorkflowEnabled = deps.forceCheckWorkflow === false
      ? false
      : (deps.forceEnabled === true || checkWorkflowWritesEnabled());
    const applicationWorkflowEnabled = deps.forceWorkflow === false
      ? false
      : (deps.forceWorkflow === true || applicationWorkflowWritesEnabled());
    const executed = await executeAllowlistedWrite({
      client,
      mapping,
      body,
      checkWorkflowEnabled,
      applicationWorkflowEnabled,
    });
    if (executed.error) {
      const status = ['invalid_uuid', 'missing_required_field', 'invalid_field'].includes(executed.error)
        ? 400
        : 403;
      return denied(spoof, { statusCode: status, ...executed });
    }

    let data = executed.rows || [];
    if (body.single) {
      if (data.length !== 1) {
        return denied(spoof, { statusCode: 406, error: 'not_single', data: null });
      }
      data = data[0];
    } else if (body.maybeSingle) {
      if (data.length > 1) {
        return denied(spoof, { statusCode: 406, error: 'not_single', data: null });
      }
      data = data[0] || null;
    }
    return okResult({ mapping, claims, spoof, data, count: Array.isArray(executed.rows) ? executed.rows.length : null });
  }, deps);
};

const specFilterDenied = (table, column) => {
  const spec = WRITE_ALLOWLIST[table];
  if (!spec) return true;
  if (CLIENT_IDENTITY_KEYS.has(column) || column === spec.identityColumn) return false;
  if (spec.clientIgnored?.has(column)) return false;
  return !spec.filterColumns.has(column) && !spec.columns.has(column);
};
