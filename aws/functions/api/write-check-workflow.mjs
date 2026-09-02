import { ident } from './data.mjs';
import { WRITE_ALLOWLIST } from './write-allowlist.mjs';

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
  if (!Object.keys(coerced.values).length) {
    return { error: 'missing_required_field', field: 'values', table: 'check_intake_items', op: 'update' };
  }
  const built = buildSet(coerced.values, {
    expiration_days: 'int',
    is_multi_payee: 'boolean',
    issue_date: 'date',
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

const executeMessages = async ({ client, values, filters }) => {
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

export const executeCheckWorkflowWrite = async ({ client, mapping, table, op, values, filters }) => {
  const spec = WRITE_ALLOWLIST[table];
  const badFilters = rejectNonEqFilters(filters, spec);
  if (badFilters) return badFilters;

  if (table === 'check_intake_items') return executeIntakeUpdate({ client, values, filters });
  if (table === 'check_payees') return executePayees({ client, op, values, filters });
  if (table === 'check_endorsements') return executeEndorsements({ client, op, values, filters });
  if (table === 'check_endorsement_events') return executeEndorsementEvents({ client, op, filters });
  if (table === 'check_audit_log') return executeAuditLog({ client, mapping, values });
  if (table === 'check_messages') return executeMessages({ client, values, filters });
  return { error: 'table_not_allowlisted', table };
};
