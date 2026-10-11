/**
 * Platform-owner Mortgage Agent compensation administration.
 * Bookkeeping only. No Moov / ACH / Stripe / wallet movement.
 *
 * Actions: roster | monthly | entries | in_progress | approve | mark_paid |
 *          set_status | reconciliation | return_to_queue | adjust
 */
import { parseBody, withIdentity, withIdentityWrite } from './data.mjs';

export const MORTGAGE_AGENT_COMPENSATION_FUNCTION = 'mortgage-agent-compensation';
export const WRITE_ACTIONS = Object.freeze([
  'approve', 'mark_paid', 'set_status', 'return_to_queue', 'adjust',
]);

const PLATFORM_OWNER_SQL =
  `SELECT public.is_master_owner() AS is_master, public.is_platform_owner() AS is_platform`;

export const isCompensationAdmin = (owner = {}, roles = []) => (
  owner?.is_master === true
  || owner?.is_platform === true
  || roles.includes('admin')
);

const asUuidArray = (value) => {
  const list = Array.isArray(value) ? value : (value ? [value] : []);
  return list.map((id) => String(id || '').trim()).filter((id) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id),
  );
};

const asUuid = (value) => {
  const raw = String(value || '').trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw) ? raw : null;
};

const periodOrCurrent = (value) => {
  const raw = String(value || '').trim();
  if (/^\d{4}-\d{2}$/.test(raw)) return raw;
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
};

const rpcStatus = (error) => {
  const code = String(error?.code || '');
  const message = String(error?.message || 'rpc_failed');
  if (code === '42501' || /not_authorized|request_excluded/i.test(message)) {
    return { ok: false, statusCode: 403, error: message };
  }
  if (code === '22023' || /invalid_reason|invalid_adjustment|invalid_pay_period|invalid_counterparty|parent_must_be_root/i.test(message)) {
    return { ok: false, statusCode: 400, error: message };
  }
  if (code === 'P0002' || /not_found/i.test(message)) {
    return { ok: false, statusCode: 404, error: message };
  }
  if (code === 'P0001' || /request_not_returnable|compensation_already_exists|parent_not_adjustable/i.test(message)) {
    return { ok: false, statusCode: 409, error: message };
  }
  return { ok: false, statusCode: 500, error: message };
};

export async function resolveCompensationAdmin(client, mapping) {
  const owner = (await client.query(PLATFORM_OWNER_SQL)).rows[0] || {};
  const roles = (await client.query(
    `SELECT role FROM public.user_roles WHERE user_id = $1::uuid`,
    [mapping.application_user_id],
  )).rows.map((row) => row.role);
  return {
    owner,
    roles,
    allowed: isCompensationAdmin(owner, roles),
  };
}

const deny = (spoof) => ({
  ok: false,
  statusCode: 403,
  error: 'not_authorized',
  message: 'Mortgage Agent compensation administration is restricted to the platform owner.',
  spoofFieldsIgnored: spoof,
});

async function handleRoster(client) {
  const { rows } = await client.query(
    `SELECT
        ur.user_id::text AS application_user_id,
        p.full_name,
        p.email,
        p.created_at,
        COALESCE(a.status, 'active') AS account_status,
        a.hired_at,
        a.deactivated_at,
        (SELECT max(r2.updated_at) FROM public.mortgage_handling_requests r2 WHERE r2.assigned_employee_id = ur.user_id) AS last_activity_at,
        count(r.id) FILTER (WHERE r.status = 'requested')::int AS queued_count,
        count(r.id) FILTER (WHERE r.status = 'in_progress')::int AS in_progress_count,
        count(r.id) FILTER (WHERE r.status = 'completed')::int AS completed_count
     FROM public.user_roles ur
     LEFT JOIN public.profiles p ON p.id = ur.user_id
     LEFT JOIN public.mortgage_agent_accounts a ON a.application_user_id = ur.user_id
     LEFT JOIN public.mortgage_handling_requests r ON r.assigned_employee_id = ur.user_id
     WHERE ur.role = 'mortgage_agent'
     GROUP BY ur.user_id, p.full_name, p.email, p.created_at, a.status, a.hired_at, a.deactivated_at
     ORDER BY p.full_name NULLS LAST, p.email NULLS LAST`,
  );
  return { ok: true, statusCode: 200, agents: rows };
}

async function handleMonthly(client, period) {
  const { rows } = await client.query(
    `SELECT
        e.agent_user_id::text AS agent_user_id,
        p.full_name,
        p.email,
        count(*) FILTER (WHERE e.parent_entry_id IS NULL AND e.classification = 'initial')::int AS initial_count,
        count(*) FILTER (WHERE e.parent_entry_id IS NULL AND e.classification = 'additional')::int AS additional_count,
        count(*) FILTER (WHERE e.parent_entry_id IS NULL)::int AS files_worked,
        coalesce(sum(e.amount_cents), 0)::int AS gross_owed_cents,
        coalesce(sum(e.amount_cents) FILTER (WHERE e.status = 'paid'), 0)::int AS paid_cents,
        coalesce(sum(e.amount_cents) FILTER (WHERE e.status IN ('earned', 'approved')), 0)::int AS balance_cents
     FROM public.mortgage_agent_compensation_entries e
     LEFT JOIN public.profiles p ON p.id = e.agent_user_id
     WHERE e.pay_period = $1
       AND e.status NOT IN ('voided', 'excluded')
     GROUP BY 1, 2, 3
     ORDER BY 2 NULLS LAST, 3 NULLS LAST`,
    [period],
  );
  const totals = rows.reduce((acc, row) => ({
    initial_count: acc.initial_count + Number(row.initial_count || 0),
    additional_count: acc.additional_count + Number(row.additional_count || 0),
    files_worked: acc.files_worked + Number(row.files_worked || 0),
    gross_owed_cents: acc.gross_owed_cents + Number(row.gross_owed_cents || 0),
    paid_cents: acc.paid_cents + Number(row.paid_cents || 0),
    balance_cents: acc.balance_cents + Number(row.balance_cents || 0),
  }), {
    initial_count: 0,
    additional_count: 0,
    files_worked: 0,
    gross_owed_cents: 0,
    paid_cents: 0,
    balance_cents: 0,
  });
  return { ok: true, statusCode: 200, period, rows, totals };
}

async function handleEntries(client, body) {
  const period = body.period ? periodOrCurrent(body.period) : null;
  const agentId = String(body.agent_user_id || body.agentUserId || '').trim() || null;
  const status = String(body.status || '').trim() || null;
  const unpaidOnly = body.unpaid === true || body.unpaid === 'true';
  const { rows } = await client.query(
    `SELECT
        e.id::text,
        e.agent_user_id::text AS agent_user_id,
        p.full_name,
        p.email,
        e.mortgage_request_id::text AS mortgage_request_id,
        e.check_intake_item_id::text AS check_intake_item_id,
        e.claim_id::text AS claim_id,
        e.tenant_id::text AS tenant_id,
        t.name AS tenant_name,
        r.homeowner_name,
        r.claim_number,
        r.mortgage_company,
        r.loan_number,
        e.classification,
        e.amount_cents,
        e.tenant_billing_event_id::text AS tenant_billing_event_id,
        e.tenant_billing_event_type,
        e.tenant_billing_amount_cents,
        e.accepted_at,
        e.completed_at,
        e.earned_at,
        e.pay_period,
        e.status,
        e.payment_date,
        e.payment_reference,
        e.payment_note,
        e.approved_by::text AS approved_by,
        e.approved_at,
        e.paid_by::text AS paid_by,
        e.paid_at,
        e.parent_entry_id::text AS parent_entry_id,
        COALESCE((
          SELECT json_agg(json_build_object(
            'id', c.id::text,
            'agent_user_id', c.agent_user_id::text,
            'amount_cents', c.amount_cents,
            'adjustment_reason', c.adjustment_reason,
            'status', c.status,
            'pay_period', c.pay_period,
            'earned_at', c.earned_at,
            'created_at', c.created_at,
            'kind', 'adjustment',
            'actor_id', (
              SELECT a.actor_id::text
              FROM public.mortgage_agent_compensation_audit a
              WHERE a.entry_id = c.id AND a.action = 'adjust'
              ORDER BY a.created_at
              LIMIT 1
            )
          ) ORDER BY c.created_at, c.id)
          FROM public.mortgage_agent_compensation_entries c
          WHERE c.parent_entry_id = e.id
            AND c.status NOT IN ('voided', 'excluded')
        ), '[]'::json) AS adjustments
     FROM public.mortgage_agent_compensation_entries e
     LEFT JOIN public.profiles p ON p.id = e.agent_user_id
     LEFT JOIN public.tenants t ON t.id = e.tenant_id
     LEFT JOIN public.mortgage_handling_requests r ON r.id = e.mortgage_request_id
     WHERE e.parent_entry_id IS NULL
       AND e.status NOT IN ('voided', 'excluded')
       AND ($1::text IS NULL OR e.pay_period = $1)
       AND ($2::uuid IS NULL OR e.agent_user_id = $2::uuid)
       AND ($3::text IS NULL OR e.status = $3)
       AND ($4::boolean IS NOT TRUE OR e.status IN ('earned', 'approved'))
     ORDER BY e.earned_at DESC, e.created_at DESC`,
    [period, agentId, status && status !== 'unpaid' ? status : null, unpaidOnly || status === 'unpaid'],
  );
  return { ok: true, statusCode: 200, period, entries: rows };
}

async function handleInProgress(client) {
  const { rows } = await client.query(
    `SELECT
        r.id::text,
        r.status,
        r.assigned_employee_id::text AS assigned_employee_id,
        p.full_name AS agent_name,
        p.email AS agent_email,
        r.accepted_at,
        r.homeowner_name,
        r.claim_number,
        r.claim_id::text AS claim_id,
        r.check_intake_item_id::text AS check_intake_item_id,
        r.tenant_id::text AS tenant_id,
        t.name AS tenant_name,
        r.mortgage_company,
        r.loan_number,
        e.id::text AS tenant_billing_event_id,
        e.event_type AS tenant_billing_event_type,
        e.unit_price_cents AS tenant_billing_amount_cents
     FROM public.mortgage_handling_requests r
     LEFT JOIN public.profiles p ON p.id = r.assigned_employee_id
     LEFT JOIN public.tenants t ON t.id = r.tenant_id
     LEFT JOIN LATERAL (
       SELECT be.id, be.event_type, be.unit_price_cents
       FROM public.check_billing_events be
       WHERE be.check_intake_item_id IS NOT DISTINCT FROM r.check_intake_item_id
         AND be.event_type IN ('mortgage_ops_initial', 'mortgage_ops_additional_check')
       ORDER BY be.created_at
       LIMIT 1
     ) e ON true
     WHERE r.status = 'in_progress'
       AND r.completed_at IS NULL
       AND r.assigned_employee_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.mortgage_agent_compensation_exclusions x
         WHERE x.mortgage_request_id = r.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.mortgage_agent_compensation_entries c
         WHERE c.mortgage_request_id = r.id
           AND c.parent_entry_id IS NULL
           AND c.status NOT IN ('voided', 'excluded')
       )
     ORDER BY r.accepted_at DESC NULLS LAST, r.updated_at DESC`,
  );
  return { ok: true, statusCode: 200, requests: rows };
}

async function handleReconciliation(client, period) {
  const { rows } = await client.query(
    `SELECT anomaly_type, mortgage_request_id::text, compensation_entry_id::text,
            tenant_billing_event_id::text, detail
     FROM public.mortgage_agent_compensation_reconciliation($1)`,
    [period],
  );
  return { ok: true, statusCode: 200, period, anomalies: rows };
}

export const runMortgageAgentCompensation = async ({
  client, mapping, body = {}, spoof,
}) => {
  const access = await resolveCompensationAdmin(client, mapping);
  if (!access.allowed) return deny(spoof);

  const action = String(body.action || 'roster').trim();
  if (action === 'roster') return { ...await handleRoster(client), spoofFieldsIgnored: spoof };
  if (action === 'monthly') {
    return { ...await handleMonthly(client, periodOrCurrent(body.period)), spoofFieldsIgnored: spoof };
  }
  if (action === 'entries') {
    return { ...await handleEntries(client, body), spoofFieldsIgnored: spoof };
  }
  if (action === 'in_progress') {
    return { ...await handleInProgress(client), spoofFieldsIgnored: spoof };
  }
  if (action === 'reconciliation') {
    return {
      ...await handleReconciliation(client, body.period ? periodOrCurrent(body.period) : null),
      spoofFieldsIgnored: spoof,
    };
  }
  if (action === 'set_status') {
    const agentId = String(body.agent_user_id || body.agentUserId || '').trim();
    const status = String(body.status || '').trim();
    const note = body.note == null ? null : String(body.note);
    if (!agentId || !['active', 'inactive'].includes(status)) {
      return { ok: false, statusCode: 400, error: 'invalid_status_request', spoofFieldsIgnored: spoof };
    }
    const row = (await client.query(
      `SELECT * FROM public.set_mortgage_agent_account_status($1::uuid, $2, $3)`,
      [agentId, status, note],
    )).rows[0];
    return { ok: true, statusCode: 200, account: row, spoofFieldsIgnored: spoof };
  }
  if (action === 'approve') {
    const ids = asUuidArray(body.entry_ids || body.entryIds);
    const count = (await client.query(
      `SELECT public.approve_mortgage_agent_compensation($1::uuid[], $2) AS n`,
      [ids, body.note == null ? null : String(body.note)],
    )).rows[0]?.n || 0;
    return { ok: true, statusCode: 200, updated: Number(count), spoofFieldsIgnored: spoof };
  }
  if (action === 'mark_paid') {
    const ids = asUuidArray(body.entry_ids || body.entryIds);
    const count = (await client.query(
      `SELECT public.mark_mortgage_agent_compensation_paid($1::uuid[], $2::date, $3, $4) AS n`,
      [
        ids,
        body.payment_date || body.paymentDate || null,
        body.payment_reference || body.paymentReference || null,
        body.note == null ? null : String(body.note),
      ],
    )).rows[0]?.n || 0;
    return { ok: true, statusCode: 200, updated: Number(count), spoofFieldsIgnored: spoof };
  }
  if (action === 'return_to_queue') {
    const requestId = asUuid(body.request_id || body.requestId);
    const reason = String(body.reason || '').trim();
    if (!requestId || !reason) {
      return { ok: false, statusCode: 400, error: 'invalid_reason', spoofFieldsIgnored: spoof };
    }
    try {
      const row = (await client.query(
        `SELECT * FROM public.return_mortgage_handling_request_to_queue($1::uuid, $2)`,
        [requestId, reason],
      )).rows[0];
      return { ok: true, statusCode: 200, request: row, spoofFieldsIgnored: spoof };
    } catch (error) {
      return { ...rpcStatus(error), spoofFieldsIgnored: spoof };
    }
  }
  if (action === 'adjust') {
    const parentId = asUuid(body.parent_entry_id || body.parentEntryId || body.entry_id || body.entryId);
    const reason = String(body.reason || '').trim();
    const amount = Number(body.amount_cents ?? body.amountCents);
    const counterparty = asUuid(body.counterparty_agent_id || body.counterpartyAgentId);
    const payPeriod = body.pay_period || body.payPeriod || null;
    if (!parentId || !reason || !Number.isInteger(amount) || amount === 0) {
      return { ok: false, statusCode: 400, error: 'invalid_adjustment', spoofFieldsIgnored: spoof };
    }
    try {
      const row = (await client.query(
        `SELECT public.adjust_mortgage_agent_compensation($1::uuid, $2::int, $3, $4::uuid, $5) AS adjustment`,
        [parentId, amount, reason, counterparty, payPeriod],
      )).rows[0];
      return { ok: true, statusCode: 200, adjustment: row?.adjustment || row, spoofFieldsIgnored: spoof };
    } catch (error) {
      return { ...rpcStatus(error), spoofFieldsIgnored: spoof };
    }
  }
  return { ok: false, statusCode: 400, error: 'unknown_action', spoofFieldsIgnored: spoof };
};

export const handleMortgageAgentCompensation = (event, deps = {}) => {
  const body = parseBody(event);
  const write = WRITE_ACTIONS.includes(String(body.action || ''));
  const runner = write ? withIdentityWrite : withIdentity;
  return runner(event, (ctx) => runMortgageAgentCompensation({
    ...ctx,
    body,
  }), { write, commit: write, ...deps });
};
