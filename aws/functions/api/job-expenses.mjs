/**
 * Job costs paid outside ChecksOps, per insurance job or cash job (route job-expenses).
 *
 * Owner 2026-11-23: "Proceed with the per job build. Make sure it is for insurance jobs and cash jobs".
 * SQL 173 (aws/workflows/sql/173_job_expenses.sql) keeps the expenses in public.job_expenses, one row per
 * cost recorded against a claim (insurance job) or a cash job; the website's per-job P&L reads them here.
 *
 * One route, three actions (body.action):
 * - list   { tenant_id, claim_id? | cash_job_id? }: the job's live (not deleted) expenses, or every live
 *          expense of the tenant when no job is named (the By Job view). A member of the tenant only
 *          (resolveTenantAccess canView). A plain SELECT as the verified sign-in, filtered by tenant and
 *          job, under the table's SELECT policy (aws_select_job_expenses: members and the platform owner).
 *          Read-only transaction, never committed.
 * - add    { tenant_id, claim_id | cash_job_id, category, amount_cents, expense_date, paid_to?, paid_by?,
 *          notes?, idempotency_key }: checked here first (the same rules as SQL 173), then one call to
 *          public.aws_job_expense_add(..., p_user_id) with p_user_id the verified sign-in's application
 *          user id, which the function requires to equal auth.uid() (request.app_user_id, set by
 *          withIdentity from the Cognito identity mapping, never from the body). Idempotent on the key:
 *          a repeat returns the recorded expense with duplicate true.
 * - delete { tenant_id, expense_id }: one call to public.aws_job_expense_delete (a soft delete); false is
 *          404.
 * add and delete need a member (canConfigure) and commit. SQL 173's refusals map to 403 / 400 / 404 / 409;
 * a missing function or table (SQL 173 not applied here) is 503 job_expenses_not_ready and nothing is
 * written. Receipts are not accepted yet: a non-empty receipt_path is refused (400) because no existing
 * rule ties an uploaded file to a job expense. No money moves and no provider is called.
 */
import { ignoredSpoof, parseBody, resolveClaims, withIdentity } from './data.mjs';
import { resolveTenantAccess } from './tenant-email-domain.mjs';

export const JOB_EXPENSE_ADD_SQL =
  'SELECT public.aws_job_expense_add($1::uuid, $2::uuid, $3::uuid, $4::text, $5::bigint, $6::date, $7::text, $8::text, $9::text, $10::text, $11::text, $12::uuid) AS result';
export const JOB_EXPENSE_DELETE_SQL = 'SELECT public.aws_job_expense_delete($1::uuid, $2::uuid, $3::uuid) AS removed';

export const JOB_EXPENSE_CATEGORIES = Object.freeze(['materials', 'labor', 'subcontractor', 'permit', 'equipment', 'other']);
export const JOB_EXPENSE_PAID_BY = Object.freeze(['company_card', 'supplier_account', 'cash', 'check', 'ach', 'other']);
export const JOB_EXPENSE_MAX_CENTS = 100000000000;
export const JOB_EXPENSE_LIST_LIMIT = 5000;
export const JOB_EXPENSE_COLUMNS = Object.freeze([
  'id', 'claim_id', 'cash_job_id', 'category', 'amount_cents', 'expense_date', 'paid_to', 'paid_by', 'notes',
  'receipt_path', 'created_at',
]);
export const JOB_EXPENSE_ACTIONS = Object.freeze(['list', 'add', 'delete']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_RE = /^[A-Za-z0-9_:-]{8,100}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NOT_READY_CODES = new Set(['42883', '42P01']);

const isUuid = (value) => typeof value === 'string' && UUID_RE.test(value);
const present = (value) => value !== undefined && value !== null && value !== '';

const refuse = (statusCode, error, message, spoof) => ({ ok: false, statusCode, error, message, spoofFieldsIgnored: spoof });
const notReady = (spoof) => refuse(503, 'job_expenses_not_ready', 'Job expenses are not available yet. Nothing was changed.', spoof);

/** A real calendar date written YYYY-MM-DD (2026-02-30 is refused). */
export const isExpenseDate = (value) => {
  const m = typeof value === 'string' ? value.match(DATE_RE) : null;
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
};

/** Optional text: trimmed, blank is null; not a string, or longer than max, is an error. */
const optionalText = (value, max) => {
  if (value === undefined || value === null) return { value: null };
  if (typeof value !== 'string') return { error: true };
  const text = value.trim();
  if (text.length > max) return { error: true };
  return { value: text || null };
};

/** The job a request names: { claimId, cashJobId }, at most one; `required` makes one mandatory. */
const parseJob = (body, required) => {
  const claim = body.claim_id ?? body.claimId;
  const cash = body.cash_job_id ?? body.cashJobId;
  if (present(claim) && present(cash)) return { error: 'Name one job: a claim or a cash job, not both.' };
  if (present(claim) && !isUuid(claim)) return { error: 'claim_id is invalid' };
  if (present(cash) && !isUuid(cash)) return { error: 'cash_job_id is invalid' };
  if (required && !present(claim) && !present(cash)) return { error: 'Choose the job: a claim or a cash job.' };
  return { claimId: present(claim) ? claim : null, cashJobId: present(cash) ? cash : null };
};

/**
 * The request: { action, tenantId, ... } or { error, message } (400). The same rules as SQL 173's own
 * checks, so a bad request never reaches the database.
 */
export function parseJobExpenseRequest(body = {}) {
  const action = String(body?.action ?? 'list').trim().toLowerCase() || 'list';
  if (!JOB_EXPENSE_ACTIONS.includes(action)) return { error: 'invalid_action', message: 'action must be list, add or delete' };
  const tenantId = body.tenant_id ?? body.tenantId;
  if (!isUuid(tenantId)) return { error: 'missing_tenant', message: 'Missing organization.' };

  if (action === 'list') {
    const job = parseJob(body, false);
    if (job.error) return { error: 'invalid_job_expense', message: job.error };
    return { action, tenantId, claimId: job.claimId, cashJobId: job.cashJobId };
  }

  if (action === 'delete') {
    const expenseId = body.expense_id ?? body.expenseId ?? body.id;
    if (!isUuid(expenseId)) return { error: 'invalid_job_expense', message: 'expense_id is required' };
    return { action, tenantId, expenseId };
  }

  const job = parseJob(body, true);
  if (job.error) return { error: 'invalid_job_expense', message: job.error };
  const key = body.idempotency_key ?? body.idempotencyKey;
  if (typeof key !== 'string' || !KEY_RE.test(key)) {
    return { error: 'invalid_job_expense', message: 'idempotency_key is required (8 to 100 letters, digits, _ : -)' };
  }
  const category = typeof body.category === 'string' ? body.category.trim().toLowerCase() : '';
  if (!JOB_EXPENSE_CATEGORIES.includes(category)) {
    return { error: 'invalid_job_expense', message: `category must be one of ${JOB_EXPENSE_CATEGORIES.join(', ')}` };
  }
  const cents = body.amount_cents ?? body.amountCents;
  if (!Number.isSafeInteger(cents) || cents < 1 || cents > JOB_EXPENSE_MAX_CENTS) {
    return { error: 'invalid_job_expense', message: 'amount_cents must be a whole number of cents from 1 to 100000000000' };
  }
  const date = body.expense_date ?? body.expenseDate;
  if (!isExpenseDate(date)) return { error: 'invalid_job_expense', message: 'expense_date must be a date written YYYY-MM-DD' };
  let paidBy = null;
  const rawPaidBy = body.paid_by ?? body.paidBy;
  if (present(rawPaidBy)) {
    paidBy = typeof rawPaidBy === 'string' ? rawPaidBy.trim().toLowerCase() : '';
    if (!paidBy) paidBy = null;
    else if (!JOB_EXPENSE_PAID_BY.includes(paidBy)) {
      return { error: 'invalid_job_expense', message: `paid_by must be one of ${JOB_EXPENSE_PAID_BY.join(', ')}` };
    }
  }
  const paidTo = optionalText(body.paid_to ?? body.paidTo, 200);
  if (paidTo.error) return { error: 'invalid_job_expense', message: 'paid_to must be text of at most 200 characters' };
  const notes = optionalText(body.notes, 2000);
  if (notes.error) return { error: 'invalid_job_expense', message: 'notes must be text of at most 2000 characters' };
  const receipt = body.receipt_path ?? body.receiptPath;
  if (present(receipt) && !(typeof receipt === 'string' && receipt.trim() === '')) {
    return { error: 'receipt_not_supported', message: 'Receipts cannot be attached to a job expense yet. Save the expense without one.' };
  }
  return {
    action,
    tenantId,
    claimId: job.claimId,
    cashJobId: job.cashJobId,
    category,
    amountCents: cents,
    expenseDate: date,
    paidTo: paidTo.value,
    paidBy,
    notes: notes.value,
    key,
  };
}

/** SQL 173's refusals -> an API answer; anything else is a 500 without database detail. */
export function mapJobExpenseSqlError(error, spoof, action = 'add') {
  const code = error?.code || null;
  const message = String(error?.message || '');
  if (NOT_READY_CODES.has(code)) return notReady(spoof); // SQL 173 is not applied in this environment.
  if (/^job_expense_forbidden/.test(message) || code === '42501') {
    return refuse(403, 'not_authorized', 'Only a member of this organization can change its job expenses.', spoof);
  }
  const invalid = message.match(/^job_expense_invalid: ([a-z_]+)/);
  if (invalid) return refuse(400, 'invalid_job_expense', `Invalid expense: ${invalid[1]}`, spoof);
  if (/^job_expense_job_not_found/.test(message)) return refuse(404, 'job_not_found', 'Job not found for this organization.', spoof);
  if (/^job_expense_key_reused/.test(message)) {
    return refuse(409, 'idempotency_key_reused', 'That request was already used for a different expense.', spoof);
  }
  return refuse(500, 'job_expense_failed', action === 'list' ? 'Job expenses could not be loaded.' : 'The job expense could not be saved.', spoof);
}

const logFailure = (event, action, error) => {
  console.error(JSON.stringify({
    service: 'checksops-api',
    event: 'job_expense_failed',
    action,
    sqlstate: error?.code || null,
    requestId: event?.requestContext?.requestId || null,
  }));
};

/** One expense in the answer's shape (the list columns; amount in cents as a number, date YYYY-MM-DD). */
export const jobExpenseRow = (row) => {
  const out = {};
  for (const column of JOB_EXPENSE_COLUMNS) out[column] = row?.[column] ?? null;
  if (out.amount_cents !== null) out.amount_cents = Number(out.amount_cents);
  return out;
};

const listSql = (request) => {
  const params = [request.tenantId];
  let where = 'e.tenant_id = $1::uuid AND e.deleted_at IS NULL';
  if (request.claimId) {
    params.push(request.claimId);
    where += ' AND e.claim_id = $2::uuid';
  } else if (request.cashJobId) {
    params.push(request.cashJobId);
    where += ' AND e.cash_job_id = $2::uuid';
  }
  return {
    sql: `SELECT e.id, e.claim_id, e.cash_job_id, e.category, e.amount_cents, e.expense_date::text AS expense_date, e.paid_to, e.paid_by, e.notes, e.receipt_path, e.created_at
     FROM public.job_expenses e
     WHERE ${where}
     ORDER BY e.expense_date DESC, e.created_at DESC, e.id
     LIMIT ${JOB_EXPENSE_LIST_LIMIT + 1}`,
    params,
  };
};

/** The action, inside withIdentity's transaction (request.app_user_id already set). */
export async function runJobExpenses({ client, mapping, spoof, request, event }) {
  const access = await resolveTenantAccess(client, mapping, request.tenantId);
  if (!access?.canView) return refuse(403, 'cross_tenant_denied', 'Not authorized', spoof);
  if (request.action !== 'list' && !access?.canConfigure) {
    return refuse(403, 'not_authorized', 'Only a member of this organization can change its job expenses.', spoof);
  }
  try {
    if (request.action === 'list') {
      const { sql, params } = listSql(request);
      const rows = (await client.query(sql, params)).rows || [];
      return {
        ok: true,
        statusCode: 200,
        expenses: rows.slice(0, JOB_EXPENSE_LIST_LIMIT).map(jobExpenseRow),
        truncated: rows.length > JOB_EXPENSE_LIST_LIMIT,
        spoofFieldsIgnored: spoof,
      };
    }
    await client.query("SET LOCAL lock_timeout = '10s'");
    if (request.action === 'delete') {
      const removed = (await client.query(JOB_EXPENSE_DELETE_SQL, [
        request.tenantId, request.expenseId, mapping.application_user_id,
      ])).rows[0]?.removed === true;
      if (!removed) return refuse(404, 'expense_not_found', 'Expense not found for this organization.', spoof);
      return { ok: true, statusCode: 200, removed: true, expense_id: request.expenseId, spoofFieldsIgnored: spoof };
    }
    const result = (await client.query(JOB_EXPENSE_ADD_SQL, [
      request.tenantId, request.claimId, request.cashJobId, request.category, request.amountCents, request.expenseDate,
      request.paidTo, request.paidBy, request.notes, null, request.key, mapping.application_user_id,
    ])).rows[0]?.result;
    if (!result?.expense?.id) {
      logFailure(event, request.action, { code: 'no_row' });
      return refuse(500, 'job_expense_failed', 'The job expense could not be saved.', spoof);
    }
    return {
      ok: true,
      statusCode: 200,
      expense: jobExpenseRow(result.expense),
      duplicate: result.duplicate === true,
      moneyMoved: false,
      spoofFieldsIgnored: spoof,
    };
  } catch (error) {
    logFailure(event, request.action, error);
    return mapJobExpenseSqlError(error, spoof, request.action);
  }
}

export async function handleJobExpenses(event, deps = {}) {
  // A sign-in first (401 without one), then the body, then the database.
  const claims = await (deps.resolveClaims || resolveClaims)(event);
  if (!claims.ok) return claims;
  const body = parseBody(event);
  const request = parseJobExpenseRequest(body);
  if (request.error) return refuse(400, request.error, request.message, ignoredSpoof(event, body));
  const write = request.action !== 'list';
  return (deps.withIdentity || withIdentity)(event, (ctx) => runJobExpenses({ ...ctx, request, event }), {
    write,
    commit: write,
    ...deps,
  });
}
