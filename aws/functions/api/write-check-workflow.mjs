import { ident } from './data.mjs';
import { WRITE_ALLOWLIST } from './write-allowlist.mjs';
import { isCheckScopedPathFor, normalizePath } from './storage-paths.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EVENT_TYPE_RE = /^[a-z][a-z0-9_]{0,79}$/i;

const isUuid = (value) => UUID_RE.test(String(value || ''));

const requireUuid = (name, value) => {
  if (!isUuid(value)) return { error: 'invalid_uuid', field: name };
  return null;
};

const eqFilter = (filters, column) => {
  const match = (filters || []).find((filter) => filter?.column === column && (filter.op || 'eq') === 'eq');
  return match?.value ?? null;
};

const rejectNonEqFilters = (filters, spec) => {
  for (const filter of filters || []) {
    const column = String(filter?.column || '');
    const op = filter?.op || 'eq';
    if (op === 'or' || op === 'not' || op === 'in') {
      return { error: 'filter_not_allowlisted', columns: [column || op] };
    }
    if (op !== 'eq') {
      return { error: 'filter_not_allowlisted', columns: [column] };
    }
    if (!spec.filterColumns.has(column) && column !== spec.identityColumn) {
      return { error: 'column_not_allowlisted', columns: [column] };
    }
  }
  return null;
};

const clip = (value, max) => {
  if (value === undefined || value === null) return null;
  const text = String(value);
  if (text.length > max) return { error: 'invalid_field', field: 'length', message: `value exceeds ${max} characters` };
  const trimmed = text.trim();
  return trimmed.length ? trimmed : null;
};

const asText = (value, max) => {
  const result = clip(value, max);
  if (result && result.error) return result;
  return { value: result };
};

const asBool = (value) => {
  if (value === undefined || value === null) return null;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return { error: 'invalid_field', field: 'boolean' };
};

const lookupCheck = async (client, checkId) => {
  const invalid = requireUuid('check_id', checkId);
  if (invalid) return invalid;
  const rows = (await client.query(
    'SELECT id, tenant_id FROM public.check_intake_items WHERE id = $1::uuid',
    [checkId],
  )).rows;
  if (!rows.length) return { error: 'rls_denied', message: 'check not found or not writable' };
  return { check: rows[0] };
};

const lookupPayee = async (client, payeeId) => {
  const invalid = requireUuid('id', payeeId);
  if (invalid) return invalid;
  const rows = (await client.query(
    `SELECT p.id, p.check_id, p.tenant_id AS payee_tenant_id, c.tenant_id
     FROM public.check_payees p
     JOIN public.check_intake_items c ON c.id = p.check_id
     WHERE p.id = $1::uuid`,
    [payeeId],
  )).rows;
  if (!rows.length) return { error: 'rls_denied', message: 'payee not found or not writable' };
  return { payee: rows[0] };
};

const IMAGE_PATH_COLUMNS = new Set(['front_image_path', 'back_image_path', 'back_image_original_path']);

const asImagePath = (checkId, value) => {
  if (value === undefined) return { skip: true };
  if (value === null || value === '') return { value: null };
  const rel = normalizePath(value, 'claim-files');
  if (!rel) return { error: 'invalid_field', field: 'file_path', message: 'invalid storage path' };
  if (!isCheckScopedPathFor(rel, checkId)) {
    return { error: 'rls_denied', message: 'image path is not scoped to this check' };
  }
  if (rel.length > 512) return { error: 'invalid_field', field: 'file_path' };
  return { value: rel };
};

const lookupEndorsement = async (client, endorsementId) => {
  const invalid = requireUuid('id', endorsementId);
  if (invalid) return invalid;
  const rows = (await client.query(
    `SELECT e.id, e.check_id, e.tenant_id AS endorsement_tenant_id, c.tenant_id
     FROM public.check_endorsements e
     JOIN public.check_intake_items c ON c.id = e.check_id
     WHERE e.id = $1::uuid`,
    [endorsementId],
  )).rows;
  if (!rows.length) return { error: 'rls_denied', message: 'endorsement not found or not writable' };
  return { endorsement: rows[0] };
};

const intakeCoerce = (values) => {
  const out = {};
  if ('carrier_name' in values) {
    const text = asText(values.carrier_name, 200);
    if (text.error) return text;
    out.carrier_name = text.value;
  }
  if ('check_number' in values) {
    const text = asText(values.check_number, 80);
    if (text.error) return text;
    out.check_number = text.value;
  }
  if ('payee_line' in values) {
    const text = asText(values.payee_line, 2000);
    if (text.error) return text;
    out.payee_line = text.value;
  }
  if ('property_address' in values) {
    const text = asText(values.property_address, 2000);
    if (text.error) return text;
    out.property_address = text.value;
  }
  if ('review_notes' in values) {
    const text = asText(values.review_notes, 2000);
    if (text.error) return text;
    out.review_notes = text.value;
  }
  if ('payee_address' in values) {
    const text = asText(values.payee_address, 2000);
    if (text.error) return text;
    out.payee_address = text.value;
  }
  if ('funds_type' in values) {
    const text = asText(values.funds_type, 80);
    if (text.error) return text;
    out.funds_type = text.value;
  }
  if ('issue_date' in values) {
    if (values.issue_date === null || values.issue_date === '') out.issue_date = null;
    else if (!DATE_RE.test(String(values.issue_date))) return { error: 'invalid_field', field: 'issue_date' };
    else out.issue_date = String(values.issue_date);
  }
  if ('expiration_days' in values) {
    if (values.expiration_days === null || values.expiration_days === '') out.expiration_days = null;
    else {
      const n = Number(values.expiration_days);
      if (!Number.isInteger(n) || n < 1 || n > 3650) return { error: 'invalid_field', field: 'expiration_days' };
      out.expiration_days = n;
    }
  }
  if ('is_multi_payee' in values) {
    const flag = asBool(values.is_multi_payee);
    if (flag && flag.error) return flag;
    out.is_multi_payee = flag;
  }
  for (const column of IMAGE_PATH_COLUMNS) {
    if (column in values) out[column] = values[column];
  }
  if ('mortgage_monitoring_type' in values) {
    const text = asText(values.mortgage_monitoring_type, 40);
    if (text.error) return text;
    const next = (text.value || 'not_set').toLowerCase();
    if (!['not_set', 'not_monitored', 'monitored'].includes(next)) {
      return { error: 'invalid_field', field: 'mortgage_monitoring_type' };
    }
    out.mortgage_monitoring_type = next;
  }
  for (const column of ['mortgage_sent_at', 'mortgage_received_at']) {
    if (column in values) {
      if (values[column] === null || values[column] === '') out[column] = null;
      else {
        const ts = Date.parse(String(values[column]));
        if (Number.isNaN(ts)) return { error: 'invalid_field', field: column };
        out[column] = new Date(ts).toISOString();
      }
    }
  }
  if ('mortgage_tracking_number' in values) {
    const text = asText(values.mortgage_tracking_number, 80);
    if (text.error) return text;
    out.mortgage_tracking_number = text.value;
  }
  return { values: out };
};

const payeeCoerce = (values, { inserting }) => {
  const out = {};
  if (inserting) {
    const name = asText(values.payee_name, 200);
    if (name.error) return name;
    if (!name.value) return { error: 'missing_required_field', field: 'payee_name' };
    out.payee_name = name.value;
  } else if ('payee_name' in values) {
    const name = asText(values.payee_name, 200);
    if (name.error) return name;
    if (!name.value) return { error: 'invalid_field', field: 'payee_name' };
    out.payee_name = name.value;
  }
  if ('payee_type' in values) {
    const text = asText(values.payee_type, 40);
    if (text.error) return text;
    out.payee_type = text.value || 'unknown';
  } else if (inserting) {
    out.payee_type = 'unknown';
  }
  if ('contact_email' in values) {
    const text = asText(values.contact_email, 200);
    if (text.error) return text;
    out.contact_email = text.value;
  }
  if ('contact_phone' in values) {
    const text = asText(values.contact_phone, 40);
    if (text.error) return text;
    out.contact_phone = text.value;
  }
  return { values: out };
};

const endorsementCoerce = (values) => {
  const out = {};
  if ('payee_name' in values) {
    const text = asText(values.payee_name, 200);
    if (text.error) return text;
    if (!text.value) return { error: 'invalid_field', field: 'payee_name' };
    out.payee_name = text.value;
  }
  if ('payee_type' in values) {
    const text = asText(values.payee_type, 40);
    if (text.error) return text;
    out.payee_type = text.value;
  }
  if ('contact_email' in values) {
    const text = asText(values.contact_email, 200);
    if (text.error) return text;
    out.contact_email = text.value;
  }
  if ('contact_phone' in values) {
    const text = asText(values.contact_phone, 40);
    if (text.error) return text;
    out.contact_phone = text.value;
  }
  if ('notes' in values) {
    const text = asText(values.notes, 2000);
    if (text.error) return text;
    out.notes = text.value;
  }
  return { values: out };
};

const buildSet = (values, typeMap) => {
  const sets = [];
  const params = [];
  let i = 1;
  for (const [column, value] of Object.entries(values)) {
    const cast = typeMap[column] || 'text';
    sets.push(`${ident(column, 'column')} = $${i}::${cast}`);
    params.push(value);
    i += 1;
  }
  sets.push('updated_at = now()');
  return { sets, params, next: i };
};

const executeIntakeUpdate = async ({ client, values, filters }) => {
  const checkId = eqFilter(filters, 'id');
  const invalid = requireUuid('id', checkId);
  if (invalid) return invalid;
  const looked = await lookupCheck(client, checkId);
  if (looked.error) return looked;
  const coerced = intakeCoerce(values);
  if (coerced.error) return coerced;
  const nextValues = { ...coerced.values };
  for (const column of IMAGE_PATH_COLUMNS) {
    if (column in nextValues) {
      const path = asImagePath(checkId, nextValues[column]);
      if (path.error) return path;
      if (path.skip) delete nextValues[column];
      else nextValues[column] = path.value;
    }
  }
  if (!Object.keys(nextValues).length) {
    return { error: 'missing_required_field', field: 'values', table: 'check_intake_items', op: 'update' };
  }
  const built = buildSet(nextValues, {
    expiration_days: 'int',
    is_multi_payee: 'boolean',
    issue_date: 'date',
    mortgage_sent_at: 'timestamptz',
    mortgage_received_at: 'timestamptz',
  });
  built.params.push(checkId);
  const rows = (await client.query(
    `UPDATE public.check_intake_items
     SET ${built.sets.join(', ')}
     WHERE id = $${built.next}::uuid
     RETURNING *`,
    built.params,
  )).rows;
  if (!rows.length) return { error: 'rls_denied', message: 'check not writable' };
  return { rows };
};

const executePayees = async ({ client, op, values, filters }) => {
  if (op === 'insert') {
    const checkId = values.check_id;
    const looked = await lookupCheck(client, checkId);
    if (looked.error) return looked;
    const coerced = payeeCoerce(values, { inserting: true });
    if (coerced.error) return coerced;
    const token = crypto.randomUUID();
    const rows = (await client.query(
      `INSERT INTO public.check_payees (
         check_id, tenant_id, payee_name, payee_type, contact_email, contact_phone,
         endorsement_token, endorsement_token_expires_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::text,
         $7::uuid, now() + interval '30 days'
       ) RETURNING *`,
      [
        looked.check.id,
        looked.check.tenant_id,
        coerced.values.payee_name,
        coerced.values.payee_type || 'unknown',
        coerced.values.contact_email || null,
        coerced.values.contact_phone || null,
        token,
      ],
    )).rows;
    return { rows };
  }

  const payeeId = eqFilter(filters, 'id');
  const looked = await lookupPayee(client, payeeId);
  if (looked.error) return looked;

  if (op === 'delete') {
    const rows = (await client.query(
      'DELETE FROM public.check_payees WHERE id = $1::uuid RETURNING *',
      [looked.payee.id],
    )).rows;
    if (!rows.length) return { error: 'rls_denied', message: 'payee not writable' };
    return { rows };
  }

  const coerced = payeeCoerce(values, { inserting: false });
  if (coerced.error) return coerced;
  if (!Object.keys(coerced.values).length) {
    return { error: 'missing_required_field', field: 'values', table: 'check_payees', op: 'update' };
  }
  const built = buildSet(coerced.values, {});
  built.params.push(looked.payee.id);
  const rows = (await client.query(
    `UPDATE public.check_payees
     SET ${built.sets.join(', ')}
     WHERE id = $${built.next}::uuid
     RETURNING *`,
    built.params,
  )).rows;
  if (!rows.length) return { error: 'rls_denied', message: 'payee not writable' };
  return { rows };
};

const executeEndorsements = async ({ client, op, values, filters }) => {
  const id = eqFilter(filters, 'id');
  const payeeId = eqFilter(filters, 'payee_id');
  const checkId = eqFilter(filters, 'check_id');

  if (op === 'delete') {
    if (id) {
      const looked = await lookupEndorsement(client, id);
      if (looked.error) return looked;
      const rows = (await client.query(
        'DELETE FROM public.check_endorsements WHERE id = $1::uuid RETURNING *',
        [looked.endorsement.id],
      )).rows;
      return { rows };
    }
    if (payeeId) {
      const invalid = requireUuid('payee_id', payeeId);
      if (invalid) return invalid;
      const parent = await lookupPayee(client, payeeId);
      if (parent.error) return parent;
      const rows = (await client.query(
        'DELETE FROM public.check_endorsements WHERE payee_id = $1::uuid RETURNING *',
        [payeeId],
      )).rows;
      return { rows };
    }
    return { error: 'missing_required_field', field: 'id', table: 'check_endorsements', op: 'delete' };
  }

  if (!id) return { error: 'missing_required_field', field: 'id', table: 'check_endorsements', op: 'update' };
  const looked = await lookupEndorsement(client, id);
  if (looked.error) return looked;
  if (checkId) {
    const invalid = requireUuid('check_id', checkId);
    if (invalid) return invalid;
    if (String(looked.endorsement.check_id) !== String(checkId)) {
      return { error: 'rls_denied', message: 'endorsement does not belong to check' };
    }
  }
  const coerced = endorsementCoerce(values);
  if (coerced.error) return coerced;
  if (!Object.keys(coerced.values).length) {
    return { error: 'missing_required_field', field: 'values', table: 'check_endorsements', op: 'update' };
  }
  const built = buildSet(coerced.values, {});
  built.params.push(looked.endorsement.id);
  const rows = (await client.query(
    `UPDATE public.check_endorsements
     SET ${built.sets.join(', ')}
     WHERE id = $${built.next}::uuid
     RETURNING *`,
    built.params,
  )).rows;
  if (!rows.length) return { error: 'rls_denied', message: 'endorsement not writable' };
  return { rows };
};

const executeEndorsementEvents = async ({ client, op, filters }) => {
  if (op !== 'delete') return { error: 'operation_not_allowlisted', table: 'check_endorsement_events', op };
  const id = eqFilter(filters, 'id');
  const payeeId = eqFilter(filters, 'payee_id');
  const checkId = eqFilter(filters, 'check_id');
  if (id) {
    const invalid = requireUuid('id', id);
    if (invalid) return invalid;
    const rows = (await client.query(
      `DELETE FROM public.check_endorsement_events e
       USING public.check_intake_items c
       WHERE e.id = $1::uuid AND e.check_id = c.id
       RETURNING e.*`,
      [id],
    )).rows;
    return { rows };
  }
  if (payeeId) {
    const parent = await lookupPayee(client, payeeId);
    if (parent.error) return parent;
    const rows = (await client.query(
      'DELETE FROM public.check_endorsement_events WHERE payee_id = $1::uuid RETURNING *',
      [payeeId],
    )).rows;
    return { rows };
  }
  if (checkId) {
    const looked = await lookupCheck(client, checkId);
    if (looked.error) return looked;
    const rows = (await client.query(
      'DELETE FROM public.check_endorsement_events WHERE check_id = $1::uuid RETURNING *',
      [checkId],
    )).rows;
    return { rows };
  }
  return { error: 'missing_required_field', field: 'id', table: 'check_endorsement_events', op: 'delete' };
};

const executeAuditLog = async ({ client, mapping, values }) => {
  const looked = await lookupCheck(client, values.check_id);
  if (looked.error) return looked;
  const eventType = asText(values.event_type, 80);
  if (eventType.error) return eventType;
  if (!eventType.value || !EVENT_TYPE_RE.test(eventType.value)) {
    return { error: 'invalid_field', field: 'event_type' };
  }
  const description = asText(values.event_description, 2000);
  if (description.error) return description;
  let eventData = values.event_data;
  if (eventData === undefined) eventData = null;
  if (eventData !== null && typeof eventData !== 'object') {
    return { error: 'invalid_field', field: 'event_data' };
  }
  const encoded = eventData === null ? null : JSON.stringify(eventData);
  if (encoded && encoded.length > 8000) return { error: 'invalid_field', field: 'event_data' };
  const rows = (await client.query(
    `INSERT INTO public.check_audit_log (
       check_id, tenant_id, actor_id, event_type, event_description, event_data
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::jsonb
     ) RETURNING *`,
    [
      looked.check.id,
      looked.check.tenant_id,
      mapping.application_user_id,
      eventType.value,
      description.value,
      encoded,
    ],
  )).rows;
  return { rows };
};

const executeMessages = async ({ client, mapping, op, values, filters }) => {
  if (op === 'insert') {
    const looked = await lookupCheck(client, values.check_id);
    if (looked.error) return looked;
    const bodyText = asText(values.body, 5000);
    if (bodyText.error) return bodyText;
    if (!bodyText.value) return { error: 'missing_required_field', field: 'body', table: 'check_messages', op: 'insert' };
    const rows = (await client.query(
      `INSERT INTO public.check_messages (check_id, sender_id, body, is_deleted)
       VALUES ($1::uuid, $2::uuid, $3::text, false)
       RETURNING *`,
      [looked.check.id, mapping.application_user_id, bodyText.value],
    )).rows;
    return { rows };
  }

  const id = eqFilter(filters, 'id');
  const invalid = requireUuid('id', id);
  if (invalid) return invalid;
  if (!('is_deleted' in values)) {
    return { error: 'missing_required_field', field: 'is_deleted', table: 'check_messages', op: 'update' };
  }
  const flag = asBool(values.is_deleted);
  if (flag && flag.error) return flag;
  const checkId = eqFilter(filters, 'check_id');
  const rows = (await client.query(
    `UPDATE public.check_messages m
     SET is_deleted = $2::boolean, updated_at = now()
     FROM public.check_intake_items c
     WHERE m.id = $1::uuid
       AND m.check_id = c.id
       AND ($3::uuid IS NULL OR m.check_id = $3::uuid)
     RETURNING m.*`,
    [id, flag, checkId && isUuid(checkId) ? checkId : null],
  )).rows;
  if (!rows.length) return { error: 'rls_denied', message: 'message not writable' };
  return { rows };
};

const FILE_CATEGORIES = new Set(['other', 'supporting', 'manual', 'check_image']);
const FILE_SOURCES = new Set(['manual', 'reupload']);

const executeCheckFiles = async ({ client, mapping, op, values, filters }) => {
  if (op === 'insert') {
    const checkId = values.check_intake_item_id;
    const looked = await lookupCheck(client, checkId);
    if (looked.error) return looked;
    const name = asText(values.file_name, 240);
    if (name.error) return name;
    if (!name.value) return { error: 'missing_required_field', field: 'file_name' };
    const path = asImagePath(checkId, values.file_path);
    if (path.error) return path;
    if (!path.value) return { error: 'missing_required_field', field: 'file_path' };
    const fileType = asText(values.file_type, 120);
    if (fileType.error) return fileType;
    const description = asText(values.description, 2000);
    if (description.error) return description;
    let fileSize = null;
    if (values.file_size != null && values.file_size !== '') {
      const n = Number(values.file_size);
      if (!Number.isFinite(n) || n < 0 || n > 50 * 1024 * 1024) {
        return { error: 'invalid_field', field: 'file_size' };
      }
      fileSize = Math.floor(n);
    }
    const categoryRaw = asText(values.category, 40);
    if (categoryRaw.error) return categoryRaw;
    const category = (categoryRaw.value || 'other').toLowerCase();
    if (!FILE_CATEGORIES.has(category)) {
      return { error: 'column_not_allowlisted', columns: ['category'] };
    }
    const sourceRaw = asText(values.source, 40);
    if (sourceRaw.error) return sourceRaw;
    const source = (sourceRaw.value || 'manual').toLowerCase();
    if (!FILE_SOURCES.has(source)) {
      return { error: 'column_not_allowlisted', columns: ['source'] };
    }
    const rows = (await client.query(
      `INSERT INTO public.check_files (
         check_intake_item_id, file_name, file_path, file_type, file_size,
         category, source, description, uploaded_by
       ) VALUES (
         $1::uuid, $2::text, $3::text, $4::text, $5::bigint,
         $6::text, $7::text, $8::text, $9::uuid
       ) RETURNING *`,
      [
        looked.check.id,
        name.value,
        path.value,
        fileType.value,
        fileSize,
        category,
        source,
        description.value,
        mapping.application_user_id,
      ],
    )).rows;
    return { rows };
  }

  const id = eqFilter(filters, 'id');
  const invalid = requireUuid('id', id);
  if (invalid) return invalid;
  const existing = (await client.query(
    `SELECT f.id, f.check_intake_item_id, c.tenant_id
     FROM public.check_files f
     JOIN public.check_intake_items c ON c.id = f.check_intake_item_id
     WHERE f.id = $1::uuid`,
    [id],
  )).rows;
  if (!existing.length) return { error: 'rls_denied', message: 'file not found or not writable' };

  if (op === 'delete') {
    const rows = (await client.query(
      'DELETE FROM public.check_files WHERE id = $1::uuid RETURNING *',
      [id],
    )).rows;
    if (!rows.length) return { error: 'rls_denied', message: 'file not writable' };
    return { rows };
  }

  const out = {};
  if ('description' in values) {
    const description = asText(values.description, 2000);
    if (description.error) return description;
    out.description = description.value;
  }
  if ('category' in values) {
    const categoryRaw = asText(values.category, 40);
    if (categoryRaw.error) return categoryRaw;
    const category = (categoryRaw.value || '').toLowerCase();
    if (!FILE_CATEGORIES.has(category)) {
      return { error: 'column_not_allowlisted', columns: ['category'] };
    }
    out.category = category;
  }
  if (!Object.keys(out).length) {
    return { error: 'missing_required_field', field: 'values', table: 'check_files', op: 'update' };
  }
  const built = buildSet(out, {});
  // check_files has no updated_at; strip the extra set from buildSet
  built.sets = built.sets.filter((part) => !part.startsWith('updated_at'));
  built.params.push(id);
  const rows = (await client.query(
    `UPDATE public.check_files
     SET ${built.sets.join(', ')}
     WHERE id = $${built.params.length}::uuid
     RETURNING *`,
    built.params,
  )).rows;
  if (!rows.length) return { error: 'rls_denied', message: 'file not writable' };
  return { rows };
};

const executeClaimChecks = async ({ client, values, filters }) => {
  const id = eqFilter(filters, 'id');
  const intakeId = eqFilter(filters, 'check_intake_item_id');
  let checkId = intakeId;
  if (id) {
    const invalid = requireUuid('id', id);
    if (invalid) return invalid;
    const rows = (await client.query(
      `SELECT cc.id, cc.check_intake_item_id, c.tenant_id
       FROM public.claim_checks cc
       JOIN public.check_intake_items c ON c.id = cc.check_intake_item_id
       WHERE cc.id = $1::uuid`,
      [id],
    )).rows;
    if (!rows.length) return { error: 'rls_denied', message: 'claim_checks row not found or not writable' };
    checkId = rows[0].check_intake_item_id;
  }
  if (!checkId) return { error: 'missing_required_field', field: 'id', table: 'claim_checks', op: 'update' };
  const looked = await lookupCheck(client, checkId);
  if (looked.error) return looked;

  const out = {};
  for (const column of ['carrier_name', 'check_number', 'payee_line', 'notes']) {
    if (column in values) {
      const text = asText(values[column], column === 'notes' || column === 'payee_line' ? 2000 : 200);
      if (text.error) return text;
      out[column] = text.value;
    }
  }
  if ('check_date' in values) {
    if (values.check_date === null || values.check_date === '') out.check_date = null;
    else if (!DATE_RE.test(String(values.check_date))) return { error: 'invalid_field', field: 'check_date' };
    else out.check_date = String(values.check_date);
  }
  if ('received_date' in values) {
    if (values.received_date === null || values.received_date === '') out.received_date = null;
    else if (!DATE_RE.test(String(values.received_date))) return { error: 'invalid_field', field: 'received_date' };
    else out.received_date = String(values.received_date);
  }
  if ('ocr_needs_verification' in values) {
    const flag = asBool(values.ocr_needs_verification);
    if (flag && flag.error) return flag;
    out.ocr_needs_verification = flag;
  }
  if (!Object.keys(out).length) {
    return { error: 'missing_required_field', field: 'values', table: 'claim_checks', op: 'update' };
  }
  const built = buildSet(out, {
    ocr_needs_verification: 'boolean',
    check_date: 'date',
    received_date: 'date',
  });
  const params = [...built.params];
  let sql = `UPDATE public.claim_checks SET ${built.sets.join(', ')} WHERE `;
  if (id) {
    params.push(id);
    sql += `id = $${params.length}::uuid`;
  } else {
    params.push(looked.check.id);
    sql += `check_intake_item_id = $${params.length}::uuid`;
  }
  sql += ' RETURNING *';
  const rows = (await client.query(sql, params)).rows;
  if (!rows.length) return { error: 'rls_denied', message: 'claim_checks row not writable' };
  return { rows };
};

const LOSS_DRAFT_ESCROW = new Set([
  'pending_send',
  'pending',
  'in_progress',
  'waiting',
  'documentation',
  'requested',
  'received',
  'endorsing',
  'follow_up',
]);

const MORTGAGE_REQUEST_STATUS = new Set(['requested', 'in_progress', 'cancelled', 'completed']);

const lookupLossDraft = async (client, id) => {
  const invalid = requireUuid('id', id);
  if (invalid) return invalid;
  const rows = (await client.query(
    `SELECT d.id, d.check_intake_item_id, c.tenant_id
     FROM public.loss_draft_tracking d
     JOIN public.check_intake_items c ON c.id = d.check_intake_item_id
     WHERE d.id = $1::uuid`,
    [id],
  )).rows;
  if (!rows.length) return { error: 'rls_denied', message: 'loss draft not found or not writable' };
  return { draft: rows[0] };
};

const executeLossDraft = async ({ client, mapping, op, values, filters }) => {
  if (op === 'insert') {
    const looked = await lookupCheck(client, values.check_intake_item_id);
    if (looked.error) return looked;
    const servicer = asText(values.mortgage_servicer, 200);
    if (servicer.error) return servicer;
    if (!servicer.value) return { error: 'missing_required_field', field: 'mortgage_servicer' };
    const notes = asText(values.notes, 2000);
    if (notes.error) return notes;
    const loan = asText(values.loan_number, 80);
    if (loan.error) return loan;
    const rows = (await client.query(
      `INSERT INTO public.loss_draft_tracking (
         check_intake_item_id, mortgage_servicer, loan_number, notes,
         escrow_status, created_by, total_escrowed, holdback_amount
       ) VALUES (
         $1::uuid, $2::text, $3::text, $4::text,
         'pending_send', $5::uuid, 0, 0
       ) RETURNING *`,
      [looked.check.id, servicer.value, loan.value, notes.value, mapping.application_user_id],
    )).rows;
    return { rows };
  }

  const id = eqFilter(filters, 'id');
  const looked = await lookupLossDraft(client, id);
  if (looked.error) return looked;
  const out = {};
  for (const [column, max] of [
    ['mortgage_servicer', 200],
    ['loan_number', 80],
    ['lender_website_url', 500],
    ['loss_draft_contact', 200],
    ['loss_draft_email', 200],
    ['loss_draft_phone', 40],
    ['loss_draft_fax', 40],
    ['notes', 2000],
    ['monitoring_type', 40],
    ['tracking_number_sent', 80],
    ['tracking_number_return', 80],
    ['shipping_method_sent', 40],
    ['shipping_method_return', 40],
  ]) {
    if (column in values) {
      const text = asText(values[column], max);
      if (text.error) return text;
      out[column] = text.value;
    }
  }
  if ('mortgage_company_id' in values) {
    if (values.mortgage_company_id === null || values.mortgage_company_id === '') out.mortgage_company_id = null;
    else {
      const invalid = requireUuid('mortgage_company_id', values.mortgage_company_id);
      if (invalid) return invalid;
      out.mortgage_company_id = values.mortgage_company_id;
    }
  }
  if ('escrow_status' in values) {
    const text = asText(values.escrow_status, 40);
    if (text.error) return text;
    const status = (text.value || '').toLowerCase();
    if (!LOSS_DRAFT_ESCROW.has(status)) {
      return { error: 'column_not_allowlisted', columns: ['escrow_status'] };
    }
    out.escrow_status = status;
  }
  for (const column of ['check_sent_date', 'check_received_date', 'check_received_back_date', 'follow_up_date']) {
    if (column in values) {
      if (values[column] === null || values[column] === '') out[column] = null;
      else if (!DATE_RE.test(String(values[column]))) return { error: 'invalid_field', field: column };
      else out[column] = String(values[column]);
    }
  }
  if ('last_contact_at' in values) {
    if (values.last_contact_at === null || values.last_contact_at === '') out.last_contact_at = null;
    else {
      const ts = Date.parse(String(values.last_contact_at));
      if (Number.isNaN(ts)) return { error: 'invalid_field', field: 'last_contact_at' };
      out.last_contact_at = new Date(ts).toISOString();
    }
  }
  if (!Object.keys(out).length) {
    return { error: 'missing_required_field', field: 'values', table: 'loss_draft_tracking', op: 'update' };
  }
  const built = buildSet(out, {
    check_sent_date: 'date',
    check_received_date: 'date',
    check_received_back_date: 'date',
    follow_up_date: 'date',
    last_contact_at: 'timestamptz',
  });
  built.params.push(looked.draft.id);
  const rows = (await client.query(
    `UPDATE public.loss_draft_tracking
     SET ${built.sets.join(', ')}
     WHERE id = $${built.next}::uuid
     RETURNING *`,
    built.params,
  )).rows;
  if (!rows.length) return { error: 'rls_denied', message: 'loss draft not writable' };
  return { rows };
};

const executeMortgageRequests = async ({ client, mapping, op, values, filters }) => {
  if (op === 'insert') {
    const looked = await lookupCheck(client, values.check_intake_item_id);
    if (looked.error) return looked;
    const company = asText(values.mortgage_company || values.mortgage_servicer, 200);
    if (company.error) return company;
    const loan = asText(values.loan_number, 80);
    if (loan.error) return loan;
    const note = asText(values.note, 2000);
    if (note.error) return note;
    const rows = (await client.query(
      `INSERT INTO public.mortgage_handling_requests (
         tenant_id, check_intake_item_id, mortgage_company, loan_number, note,
         requested_by, status
       ) VALUES (
         $1::uuid, $2::uuid, $3::text, $4::text, $5::text,
         $6::uuid, 'requested'
       ) RETURNING *`,
      [
        looked.check.tenant_id,
        looked.check.id,
        company.value,
        loan.value,
        note.value,
        mapping.application_user_id,
      ],
    )).rows;
    return { rows };
  }

  const id = eqFilter(filters, 'id');
  const invalid = requireUuid('id', id);
  if (invalid) return invalid;
  const existing = (await client.query(
    `SELECT r.id, r.check_intake_item_id, c.tenant_id
     FROM public.mortgage_handling_requests r
     JOIN public.check_intake_items c ON c.id = r.check_intake_item_id
     WHERE r.id = $1::uuid`,
    [id],
  )).rows;
  if (!existing.length) return { error: 'rls_denied', message: 'mortgage request not found or not writable' };
  const out = {};
  for (const [column, max] of [
    ['mortgage_company', 200],
    ['mortgage_servicer', 200],
    ['loan_number', 80],
    ['note', 2000],
    ['work_notes', 2000],
    ['property_address', 2000],
    ['claim_number', 80],
    ['insurance_company', 200],
    ['homeowner_name', 200],
    ['homeowner_email', 200],
    ['homeowner_phone', 40],
  ]) {
    if (column in values) {
      const text = asText(values[column], max);
      if (text.error) return text;
      out[column] = text.value;
    }
  }
  if ('status' in values) {
    const text = asText(values.status, 40);
    if (text.error) return text;
    const status = (text.value || '').toLowerCase();
    if (!MORTGAGE_REQUEST_STATUS.has(status)) {
      return { error: 'column_not_allowlisted', columns: ['status'] };
    }
    out.status = status;
  }
  if (!Object.keys(out).length) {
    return { error: 'missing_required_field', field: 'values', table: 'mortgage_handling_requests', op: 'update' };
  }
  const built = buildSet(out, {});
  built.params.push(id);
  const rows = (await client.query(
    `UPDATE public.mortgage_handling_requests
     SET ${built.sets.join(', ')}
     WHERE id = $${built.next}::uuid
     RETURNING *`,
    built.params,
  )).rows;
  if (!rows.length) return { error: 'rls_denied', message: 'mortgage request not writable' };
  return { rows };
};

const executeLossDraftAudit = async ({ client, mapping, values }) => {
  const draftId = values.loss_draft_id;
  const looked = await lookupLossDraft(client, draftId);
  if (looked.error) return looked;
  const action = asText(values.action, 80);
  if (action.error) return action;
  if (!action.value) return { error: 'missing_required_field', field: 'action' };
  const notes = asText(values.notes, 2000);
  if (notes.error) return notes;
  const rows = (await client.query(
    `INSERT INTO public.loss_draft_audit_log (loss_draft_id, action, notes, actor_id)
     VALUES ($1::uuid, $2::text, $3::text, $4::uuid)
     RETURNING *`,
    [looked.draft.id, action.value, notes.value, mapping.application_user_id],
  )).rows;
  return { rows };
};

const INTRO_STATUSES = new Set(['new', 'contacted', 'accepted', 'declined', 'closed', 'spam']);

const executeHomeownerIntro = async ({ client, mapping, op, values, filters }) => {
  if (op === 'insert') {
    const profileId = values.contractor_profile_id;
    const invalid = requireUuid('contractor_profile_id', profileId);
    if (invalid) return invalid;
    const contractor = (await client.query(
      `SELECT id, user_id FROM public.contractor_profiles
       WHERE id = $1::uuid AND is_directory_listed = true AND directory_opt_in = true`,
      [profileId],
    )).rows[0];
    if (!contractor?.user_id) {
      return { error: 'contractor_not_accepting_leads', message: 'contractor not accepting leads' };
    }
    const name = asText(values.homeowner_name, 120);
    if (name.error || !name.value) return name.error || { error: 'missing_required_field', field: 'homeowner_name' };
    const email = asText(values.homeowner_email, 255);
    if (email.error || !email.value) return email.error || { error: 'missing_required_field', field: 'homeowner_email' };
    const phone = asText(values.homeowner_phone, 30);
    if (phone.error) return phone;
    const zip = asText(values.property_zip, 10);
    if (zip.error) return zip;
    const lossType = asText(values.loss_type, 80);
    if (lossType.error) return lossType;
    const message = asText(values.message, 1000);
    if (message.error) return message;
    const rows = (await client.query(
      `INSERT INTO public.homeowner_intro_requests (
         contractor_profile_id, contractor_user_id,
         homeowner_name, homeowner_email, homeowner_phone,
         property_zip, loss_type, message
       ) VALUES (
         $1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::text, $7::text, $8::text
       ) RETURNING *`,
      [
        profileId,
        contractor.user_id,
        name.value,
        email.value.toLowerCase(),
        phone.value,
        zip.value,
        lossType.value,
        message.value,
      ],
    )).rows;
    return { rows };
  }

  const id = eqFilter(filters, 'id');
  const invalid = requireUuid('id', id);
  if (invalid) return invalid;
  const existing = (await client.query(
    `SELECT id, contractor_user_id FROM public.homeowner_intro_requests WHERE id = $1::uuid`,
    [id],
  )).rows[0];
  if (!existing) return { error: 'rls_denied', message: 'intro request not found' };
  if (existing.contractor_user_id !== mapping.application_user_id) {
    const roles = (await client.query(
      `SELECT role FROM public.user_roles WHERE user_id = $1::uuid`,
      [mapping.application_user_id],
    )).rows.map((row) => String(row.role || '').toLowerCase());
    if (!roles.includes('admin') && !roles.includes('staff')) {
      return { error: 'not_authorized', message: 'Only the assigned contractor can update this lead' };
    }
  }
  const out = {};
  if ('status' in values) {
    const text = asText(values.status, 40);
    if (text.error) return text;
    const status = (text.value || '').toLowerCase();
    if (!INTRO_STATUSES.has(status)) return { error: 'column_not_allowlisted', columns: ['status'] };
    out.status = status;
  }
  for (const column of ['contacted_at', 'accepted_at', 'updated_at']) {
    if (column in values) {
      if (values[column] === null || values[column] === '') out[column] = null;
      else {
        const ts = Date.parse(String(values[column]));
        if (Number.isNaN(ts)) return { error: 'invalid_field', field: column };
        out[column] = new Date(ts).toISOString();
      }
    }
  }
  if (!Object.keys(out).length) {
    return { error: 'missing_required_field', field: 'values', table: 'homeowner_intro_requests', op: 'update' };
  }
  const built = buildSet(out, {});
  built.params.push(id);
  const rows = (await client.query(
    `UPDATE public.homeowner_intro_requests
     SET ${built.sets.join(', ')}
     WHERE id = $${built.next}::uuid
     RETURNING *`,
    built.params,
  )).rows;
  if (!rows.length) return { error: 'rls_denied', message: 'intro request not writable' };
  return { rows };
};

const executeCheckCases = async ({ client, mapping, op, values, filters }) => {
  if (op === 'insert') {
    const tenantId = values.tenant_id;
    const invalid = requireUuid('tenant_id', tenantId);
    if (invalid) return invalid;
    const member = (await client.query(
      `SELECT 1 FROM public.tenant_users WHERE user_id = $1::uuid AND tenant_id = $2::uuid
       UNION ALL
       SELECT 1 FROM public.user_roles WHERE user_id = $1::uuid AND role IN ('admin', 'staff')`,
      [mapping.application_user_id, tenantId],
    )).rows[0];
    if (!member) return { error: 'not_authorized', message: 'Not a member of tenant' };
    const out = { tenant_id: tenantId };
    for (const [column, max] of [
      ['external_system', 80],
      ['external_reference', 120],
      ['claim_number', 120],
      ['insured_name', 200],
      ['insured_email', 200],
      ['insured_phone', 40],
      ['property_address', 2000],
      ['carrier_name', 200],
      ['policy_number', 120],
      ['loan_number', 80],
      ['status', 40],
    ]) {
      if (column in values) {
        const text = asText(values[column], max);
        if (text.error) return text;
        out[column] = text.value;
      }
    }
    if ('external_claim_id' in values) {
      if (values.external_claim_id === null || values.external_claim_id === '') out.external_claim_id = null;
      else {
        const bad = requireUuid('external_claim_id', values.external_claim_id);
        if (bad) return bad;
        out.external_claim_id = values.external_claim_id;
      }
    }
    if ('mortgage_company_id' in values) {
      if (values.mortgage_company_id === null || values.mortgage_company_id === '') out.mortgage_company_id = null;
      else {
        const bad = requireUuid('mortgage_company_id', values.mortgage_company_id);
        if (bad) return bad;
        out.mortgage_company_id = values.mortgage_company_id;
      }
    }
    if ('loss_date' in values) {
      if (values.loss_date === null || values.loss_date === '') out.loss_date = null;
      else if (!DATE_RE.test(String(values.loss_date))) return { error: 'invalid_field', field: 'loss_date' };
      else out.loss_date = String(values.loss_date);
    }
    if (!out.external_system) out.external_system = out.external_claim_id ? 'freedom_crm' : 'checksops';
    const cols = Object.keys(out);
    const params = cols.map((column) => out[column]);
    const rows = (await client.query(
      `INSERT INTO public.check_cases (${cols.join(', ')})
       VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
       RETURNING *`,
      params,
    )).rows;
    return { rows };
  }

  const id = eqFilter(filters, 'id');
  const invalid = requireUuid('id', id);
  if (invalid) return invalid;
  const existing = (await client.query(
    'SELECT id, tenant_id FROM public.check_cases WHERE id = $1::uuid',
    [id],
  )).rows[0];
  if (!existing) return { error: 'rls_denied', message: 'check case not found' };
  const out = {};
  for (const [column, max] of [
    ['external_reference', 120],
    ['claim_number', 120],
    ['insured_name', 200],
    ['insured_email', 200],
    ['insured_phone', 40],
    ['property_address', 2000],
    ['carrier_name', 200],
    ['policy_number', 120],
    ['loan_number', 80],
    ['status', 40],
  ]) {
    if (column in values) {
      const text = asText(values[column], max);
      if (text.error) return text;
      out[column] = text.value;
    }
  }
  if ('updated_at' in values) out.updated_at = new Date().toISOString();
  if (!Object.keys(out).length) {
    return { error: 'missing_required_field', field: 'values', table: 'check_cases', op: 'update' };
  }
  const built = buildSet(out, {});
  built.params.push(id);
  const rows = (await client.query(
    `UPDATE public.check_cases SET ${built.sets.join(', ')} WHERE id = $${built.next}::uuid RETURNING *`,
    built.params,
  )).rows;
  if (!rows.length) return { error: 'rls_denied', message: 'check case not writable' };
  return { rows };
};

const executeContractorProfiles = async ({ client, mapping, values, filters }) => {
  const id = eqFilter(filters, 'id') || eqFilter(filters, 'user_id');
  const column = eqFilter(filters, 'id') ? 'id' : 'user_id';
  const invalid = requireUuid(column, id);
  if (invalid) return invalid;
  const existing = (await client.query(
    `SELECT id, user_id FROM public.contractor_profiles WHERE ${column} = $1::uuid`,
    [id],
  )).rows[0];
  if (!existing) return { error: 'rls_denied', message: 'contractor profile not found' };
  if (existing.user_id !== mapping.application_user_id) {
    const roles = (await client.query(
      `SELECT role FROM public.user_roles WHERE user_id = $1::uuid`,
      [mapping.application_user_id],
    )).rows.map((row) => String(row.role || '').toLowerCase());
    if (!roles.includes('admin')) {
      return { error: 'not_authorized', message: 'Only the profile owner or admin can update' };
    }
  }
  const out = {};
  for (const [col, max] of [
    ['display_name', 200],
    ['bio', 4000],
    ['phone', 40],
    ['website', 300],
  ]) {
    if (col in values) {
      const text = asText(values[col], max);
      if (text.error) return text;
      out[col] = text.value;
    }
  }
  if ('service_areas' in values) out.service_areas = values.service_areas;
  for (const col of ['directory_opt_in', 'is_directory_listed']) {
    if (col in values) {
      const flag = asBool(values[col]);
      if (flag && flag.error) return flag;
      out[col] = flag;
    }
  }
  if ('updated_at' in values) out.updated_at = new Date().toISOString();
  if (!Object.keys(out).length) {
    return { error: 'missing_required_field', field: 'values', table: 'contractor_profiles', op: 'update' };
  }
  const built = buildSet(out, {});
  built.params.push(existing.id);
  const rows = (await client.query(
    `UPDATE public.contractor_profiles SET ${built.sets.join(', ')} WHERE id = $${built.next}::uuid RETURNING *`,
    built.params,
  )).rows;
  if (!rows.length) return { error: 'rls_denied', message: 'contractor profile not writable' };
  return { rows };
};

const executeAuditLogsTable = async ({ client, mapping, values }) => {
  const action = asText(values.action, 120);
  if (action.error || !action.value) return action.error || { error: 'missing_required_field', field: 'action' };
  const recordType = asText(values.record_type, 120);
  if (recordType.error || !recordType.value) {
    return recordType.error || { error: 'missing_required_field', field: 'record_type' };
  }
  const recordId = asText(values.record_id, 200);
  if (recordId.error) return recordId;
  const rows = (await client.query(
    `INSERT INTO public.audit_logs (
       user_id, action, record_type, record_id, old_values, new_values, metadata
     ) VALUES (
       $1::uuid, $2::text, $3::text, $4::text, $5::jsonb, $6::jsonb, $7::jsonb
     ) RETURNING *`,
    [
      mapping.application_user_id,
      action.value,
      recordType.value,
      recordId.value,
      values.old_values ?? null,
      values.new_values ?? null,
      values.metadata ?? null,
    ],
  )).rows;
  return { rows };
};

const executeUserSessionsTable = async ({ client, mapping, op, values, filters }) => {
  if (op === 'insert') {
    const token = asText(values.session_token, 200);
    if (token.error || !token.value) {
      return token.error || { error: 'missing_required_field', field: 'session_token' };
    }
    const device = asText(values.device_info, 500);
    if (device.error) return device;
    const ip = asText(values.ip_address, 80);
    if (ip.error) return ip;
    const rows = (await client.query(
      `INSERT INTO public.user_sessions (
         user_id, session_token, device_info, ip_address, role_version
       ) VALUES ($1::uuid, $2::text, $3::text, $4::text, COALESCE($5::int, 1))
       RETURNING *`,
      [
        mapping.application_user_id,
        token.value,
        device.value,
        ip.value,
        values.role_version ?? 1,
      ],
    )).rows;
    return { rows };
  }
  const id = eqFilter(filters, 'id');
  const token = eqFilter(filters, 'session_token');
  const out = {};
  for (const col of ['is_active', 'last_activity_at', 'expires_at', 'device_info', 'ip_address']) {
    if (col in values) out[col] = values[col];
  }
  if (!Object.keys(out).length) {
    return { error: 'missing_required_field', field: 'values', table: 'user_sessions', op: 'update' };
  }
  const sets = [];
  const params = [];
  let i = 1;
  for (const [column, value] of Object.entries(out)) {
    const cast = column === 'is_active' ? 'boolean'
      : (column === 'last_activity_at' || column === 'expires_at') ? 'timestamptz'
        : 'text';
    sets.push(`${ident(column, 'column')} = $${i}::${cast}`);
    params.push(value);
    i += 1;
  }
  if (id) {
    const invalid = requireUuid('id', id);
    if (invalid) return invalid;
    params.push(id, mapping.application_user_id);
    const rows = (await client.query(
      `UPDATE public.user_sessions SET ${sets.join(', ')}
       WHERE id = $${i}::uuid AND user_id = $${i + 1}::uuid
       RETURNING *`,
      params,
    )).rows;
    return { rows };
  }
  if (token) {
    params.push(String(token), mapping.application_user_id);
    const rows = (await client.query(
      `UPDATE public.user_sessions SET ${sets.join(', ')}
       WHERE session_token = $${i}::text AND user_id = $${i + 1}::uuid
       RETURNING *`,
      params,
    )).rows;
    return { rows };
  }
  return { error: 'missing_required_field', field: 'id' };
};

export const executeCheckWorkflowWrite = async ({ client, mapping, table, op, values, filters }) => {
  const spec = WRITE_ALLOWLIST[table];
  const badFilters = rejectNonEqFilters(filters, spec);
  if (badFilters) return badFilters;

  if (table === 'check_intake_items') return executeIntakeUpdate({ client, values, filters });
  if (table === 'check_payees') return executePayees({ client, op, values, filters });
  if (table === 'check_endorsements') return executeEndorsements({ client, op, values, filters });
  if (table === 'check_endorsement_events') return executeEndorsementEvents({ client, op, filters });
  if (table === 'check_audit_log') return executeAuditLog({ client, mapping, values });
  if (table === 'check_messages') return executeMessages({ client, mapping, op, values, filters });
  if (table === 'check_files') return executeCheckFiles({ client, mapping, op, values, filters });
  if (table === 'claim_checks') return executeClaimChecks({ client, values, filters });
  if (table === 'loss_draft_tracking') return executeLossDraft({ client, mapping, op, values, filters });
  if (table === 'mortgage_handling_requests') return executeMortgageRequests({ client, mapping, op, values, filters });
  if (table === 'loss_draft_audit_log') return executeLossDraftAudit({ client, mapping, values });
  if (table === 'homeowner_intro_requests') return executeHomeownerIntro({ client, mapping, op, values, filters });
  if (table === 'check_cases') return executeCheckCases({ client, mapping, op, values, filters });
  if (table === 'contractor_profiles') return executeContractorProfiles({ client, mapping, values, filters });
  if (table === 'audit_logs') return executeAuditLogsTable({ client, mapping, values });
  if (table === 'user_sessions') return executeUserSessionsTable({ client, mapping, op, values, filters });
  if ([
    'notifications', 'tenant_documents', 'loss_draft_documents', 'mortgage_companies',
    'shared_check_messages', 'profiles', 'company_branding', 'referral_alerts',
    'tenants', 'privacy_notice_acknowledgments', 'tenant_users',
    'cash_jobs', 'cash_job_line_items', 'cash_job_attachments', 'homeowner_ledger_events',
    'mortgage_request_library_documents', 'tenant_billing_accounts',
  ].includes(table)) {
    const { executeAppMetadataWrite } = await import('./write-app-metadata.mjs');
    return executeAppMetadataWrite({ client, mapping, table, op, values, filters });
  }
  return { error: 'table_not_allowlisted', table };
};
