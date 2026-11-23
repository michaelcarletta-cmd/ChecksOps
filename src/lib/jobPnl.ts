/**
 * Per-job P&L (owner 2026-11-23: "Proceed with the per job build. Make sure it is for insurance
 * jobs and cash jobs"). One calculation for both places it shows:
 * - Payments & Financials > Revenue & Profit > "By Job" (every job of the organization), and
 * - the Job P&L card on a check's Funds tab (its claim) and on a cash job.
 *
 * A job is an insurance job (a claims row, or a check_cases row for a check with a case but no
 * claim) or a cash job (cash_jobs). Money is tied to a job like this:
 * - Checks (check_intake_items): by claim_id, else case_id, else cash_job_id. Revenue counts a check
 *   whose status is deposited or funds_released, the same rule as the Totals view. Any other check
 *   that is not returned, rejected, void or deleted is "pending": listed, never counted.
 * - Paid invoices (moov_invoices, paidInvoiceRevenue rules): by the invoice's claim_id.
 * - Cash-job payments (cash_job_payments): by cash_job_id. A payment the database recorded for a
 *   deposited check (reference_number = that check's id, SQL 121) is the same money as the check,
 *   so it is skipped whenever that check is one of the checks given here.
 * - Settled payouts (disbursement_splits): split -> disbursement_batches.check_intake_item_id -> check.
 * - Paid sends (payment_transfers send legs, sentPayments rules): by the sent check, else the check's claim.
 * - ChecksOps fees (platform_fee_line_items, not void): by check_id, else claim_id; summed per job.
 * - `expenses`: job expenses entered by hand (step 3). Empty for now: the input exists so a later
 *   source only has to pass its rows here.
 * Anything that reaches no job goes to the Unassigned row, so the rows add up to the totals.
 * Payroll and payroll speed fees are company-wide and are never allocated to a job.
 *
 * Amounts are summed in whole cents. Pure: no data access, no "@/" imports (aws/tests load it with
 * --experimental-strip-types).
 */
import { sentPayments, type SendLeg } from "./payments/transferFinanceRows.ts";
import { splitMethodLabel } from "./payments/revenueExpenseRows.ts";

export type JobKind = "claim" | "case" | "cash_job";
export type JobRef = { kind: JobKind; id: string };
/** "claim" covers claims and check cases (both are insurance jobs). */
export type JobType = "claim" | "cash_job" | "unassigned";

export const UNASSIGNED_JOB_KEY = "unassigned";
export const jobKey = (ref: JobRef | null | undefined): string => (ref ? `${ref.kind}:${ref.id}` : UNASSIGNED_JOB_KEY);

/** Statuses that make a check revenue (RevenueSummary's check query). */
export const COUNTED_CHECK_STATUSES = ["deposited", "funds_released"] as const;
/** A check in one of these (status or stage) is neither revenue nor pending. */
export const NOT_PENDING_CHECK_STATES = [
  "returned", "rejected", "void", "voided", "cancelled", "canceled", "deleted", "archived", "disbursed_externally",
] as const;

export interface JobPnlCheck {
  id: string;
  amount?: number | string | null;
  status?: string | null;
  check_stage?: string | null;
  deposited_at?: string | null;
  created_at?: string | null;
  check_number?: string | null;
  carrier_name?: string | null;
  claim_id?: string | null;
  case_id?: string | null;
  cash_job_id?: string | null;
  /** The insured's name as the app resolves it (depositCustomerName), when the caller has it. */
  customer_name?: string | null;
}

export interface JobPnlInvoice {
  id: string;
  at: string | null;
  invoiceNumber?: string | null;
  customerName?: string | null;
  amountCents: number;
  claimId?: string | null;
}

export interface JobPnlCashPayment {
  id: string;
  cash_job_id: string;
  amount?: number | string | null;
  payment_date?: string | null;
  payment_method?: string | null;
  reference_number?: string | null;
  payee_name?: string | null;
  notes?: string | null;
}

type CheckLinkEmbed = {
  check_number?: string | null;
  claim_id?: string | null;
  case_id?: string | null;
  cash_job_id?: string | null;
};

export interface JobPnlSplit {
  id?: string | null;
  amount?: number | string | null;
  status?: string | null;
  settled_at?: string | null;
  created_at?: string | null;
  method?: string | null;
  recipient_name?: string | null;
  recipient_type?: string | null;
  external_check_number?: string | null;
  stakeholder_accounts?: { nickname?: string | null; custname?: string | null } | null;
  disbursement_batches?: {
    id?: string | null;
    check_intake_item_id?: string | null;
    check_intake_items?: CheckLinkEmbed | null;
  } | null;
}

export interface JobPnlFee {
  id: string;
  amount_cents?: number | string | null;
  status?: string | null;
  fee_code?: string | null;
  description?: string | null;
  occurred_at?: string | null;
  check_id?: string | null;
  claim_id?: string | null;
}

/** Step 3 extension point: a cost entered against a job (none exist yet). */
export interface JobPnlExpense {
  id: string;
  job: JobRef | null;
  amount: number | string;
  at?: string | null;
  payee?: string | null;
  category?: string | null;
  note?: string | null;
}

/** Revenue that never belongs to one of this organization's jobs (partner payments into the wallet). */
export interface JobPnlOtherRevenue {
  key: string;
  at: string | null;
  title: string;
  subtitle?: string | null;
  reference?: string | null;
  amount: number;
}

export interface JobPnlClaim { id: string; claim_number?: string | null; policyholder_name?: string | null }
export interface JobPnlCase { id: string; claim_number?: string | null; insured_name?: string | null }
export interface JobPnlCashJob { id: string; job_name?: string | null; customer_name?: string | null }

export interface JobPnlInput {
  /** Checks of any status: the counted ones become revenue, the others may be pending. */
  checks?: JobPnlCheck[] | null;
  invoices?: JobPnlInvoice[] | null;
  cashPayments?: JobPnlCashPayment[] | null;
  /** Settled splits (other statuses are skipped). */
  splits?: JobPnlSplit[] | null;
  sends?: SendLeg[] | null;
  fees?: JobPnlFee[] | null;
  expenses?: JobPnlExpense[] | null;
  otherRevenue?: JobPnlOtherRevenue[] | null;
  claims?: JobPnlClaim[] | null;
  cases?: JobPnlCase[] | null;
  cashJobs?: JobPnlCashJob[] | null;
}

export type JobPnlSource =
  | "check" | "invoice" | "cash_payment" | "partner_payment"
  | "payout" | "send" | "fees" | "expense";

export interface JobPnlLine {
  key: string;
  source: JobPnlSource;
  /** Who or what: "Check #123", the payee, "ChecksOps fees". */
  title: string;
  /** Where it came from, without the date: carrier, payee type and method, fee count. */
  detail: string | null;
  /** What the date means: "Deposited", "Funds released", "Invoice paid", "Paid", "Settled", "Sent". */
  dateLabel: string | null;
  at: string | null;
  /** Dollars, positive. */
  amount: number;
}

export interface JobPnlSummary {
  key: string;
  ref: JobRef | null;
  type: JobType;
  name: string;
  subtitle: string | null;
  revenue: number;
  costs: number;
  profit: number;
  /** Percent of revenue; null when there is no revenue. */
  margin: number | null;
  pendingCount: number;
  pendingAmount: number;
  moneyIn: JobPnlLine[];
  moneyOut: JobPnlLine[];
  pendingChecks: JobPnlLine[];
}

export interface JobPnlTotals {
  /** Jobs listed, not counting the Unassigned row. */
  jobCount: number;
  revenue: number;
  costs: number;
  profit: number;
  margin: number | null;
  pendingCount: number;
  pendingAmount: number;
}

export interface JobPnlResult {
  /** Jobs, most revenue first; the Unassigned row (when it has anything) last. */
  jobs: JobPnlSummary[];
  totals: JobPnlTotals;
  /** What differs from the Totals view's revenue and costs (besides payroll, which is never allocated). */
  reconciliation: {
    /** Cash-job payments not matched to a check given here (the Totals view counts only checks). */
    cashPaymentsRevenue: number;
    /** ChecksOps fees (the Totals view does not count them). */
    fees: number;
    /** Job expenses entered by hand (step 3). */
    expenses: number;
  };
}

// ---------------------------------------------------------------- helpers

const lower = (value: unknown) => String(value ?? "").trim().toLowerCase();
const text = (value: unknown): string | null => {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  return s || null;
};
const toCents = (value: unknown): number => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
const intCents = (value: unknown): number => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.round(n) : 0;
};
const time = (at: string | null | undefined): number => {
  if (!at) return 0;
  const t = new Date(at).getTime();
  return Number.isFinite(t) ? t : 0;
};
const titleCase = (value: string) => value.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export const isCountedCheck = (check: Pick<JobPnlCheck, "status"> | null | undefined): boolean =>
  !!check && (COUNTED_CHECK_STATUSES as readonly string[]).includes(lower(check.status));

export const isPendingCheck = (check: Pick<JobPnlCheck, "status" | "check_stage"> | null | undefined): boolean => {
  if (!check || isCountedCheck(check)) return false;
  const states = NOT_PENDING_CHECK_STATES as readonly string[];
  return !states.includes(lower(check.status)) && !states.includes(lower(check.check_stage));
};

/** The job a check belongs to: its claim, else its case, else its cash job; null when none. */
export function jobRefForCheck(check: Pick<JobPnlCheck, "claim_id" | "case_id" | "cash_job_id"> | null | undefined): JobRef | null {
  if (!check) return null;
  if (text(check.claim_id)) return { kind: "claim", id: String(check.claim_id).trim() };
  if (text(check.case_id)) return { kind: "case", id: String(check.case_id).trim() };
  if (text(check.cash_job_id)) return { kind: "cash_job", id: String(check.cash_job_id).trim() };
  return null;
}

/** Percent of revenue, or null when there is no revenue (never a division by zero). */
export const jobMargin = (revenue: number, profit: number): number | null =>
  revenue > 0 ? (profit / revenue) * 100 : null;

/** "subcontractor" -> "Subcontractor", "sales_rep" -> "Sales rep", missing -> "Payee". */
export const payoutTypeLabel = (type: string | null | undefined): string => {
  const t = lower(type);
  if (!t) return "Payee";
  const words = t.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const CASH_METHOD_LABELS: Record<string, string> = {
  cash: "Cash", check: "Check", zelle: "Zelle", venmo: "Venmo", cashapp: "Cash App",
  credit_card: "Credit card", bank_transfer: "Bank transfer", other: "Other",
};

// ---------------------------------------------------------------- build

type JobNameLookups = {
  claims: Map<string, JobPnlClaim>;
  cases: Map<string, JobPnlCase>;
  cashJobs: Map<string, JobPnlCashJob>;
};

const jobNameLookups = (input: Pick<JobPnlInput, "claims" | "cases" | "cashJobs">): JobNameLookups => ({
  claims: new Map((input.claims ?? []).filter((c) => c?.id).map((c) => [String(c.id), c])),
  cases: new Map((input.cases ?? []).filter((c) => c?.id).map((c) => [String(c.id), c])),
  cashJobs: new Map((input.cashJobs ?? []).filter((c) => c?.id).map((c) => [String(c.id), c])),
});

/**
 * How a job is named, as the app labels it: a claim by the insured (policyholder, case insured, or the
 * name on its checks) with the claim number underneath; a cash job by its job name.
 */
function jobLabel(ref: JobRef | null, names: JobNameLookups, fallbackName: string | null): { type: JobType; name: string; subtitle: string | null } {
  if (!ref) return { type: "unassigned", name: "Unassigned", subtitle: "Not linked to a claim or cash job" };
  if (ref.kind === "cash_job") {
    const job = names.cashJobs.get(ref.id);
    const jobName = text(job?.job_name);
    const customer = text(job?.customer_name);
    return { type: "cash_job", name: jobName || customer || fallbackName || "Cash job", subtitle: jobName && customer ? customer : null };
  }
  const row = ref.kind === "claim" ? names.claims.get(ref.id) : null;
  const caseRow = ref.kind === "case" ? names.cases.get(ref.id) : null;
  const insured = text(row?.policyholder_name) || text(caseRow?.insured_name) || fallbackName;
  const claimNumber = text(row?.claim_number) || text(caseRow?.claim_number);
  if (insured) return { type: "claim", name: insured, subtitle: claimNumber ? `Claim #${claimNumber}` : null };
  return { type: "claim", name: claimNumber ? `Claim #${claimNumber}` : "Claim", subtitle: null };
}


type Bucket = {
  key: string;
  ref: JobRef | null;
  inCents: number;
  outCents: number;
  pendingCents: number;
  moneyIn: Array<JobPnlLine & { cents: number }>;
  moneyOut: Array<JobPnlLine & { cents: number }>;
  pending: Array<JobPnlLine & { cents: number }>;
  fees: { cents: number; count: number; at: string | null };
};

const sortLines = <T extends JobPnlLine>(lines: T[]) => lines.sort((a, b) => time(b.at) - time(a.at));
const stripCents = ({ cents: _cents, ...line }: JobPnlLine & { cents: number }): JobPnlLine => line;

export function buildJobPnl(input: JobPnlInput): JobPnlResult {
  const buckets = new Map<string, Bucket>();
  const bucket = (ref: JobRef | null): Bucket => {
    const key = jobKey(ref);
    let b = buckets.get(key);
    if (!b) {
      b = { key, ref, inCents: 0, outCents: 0, pendingCents: 0, moneyIn: [], moneyOut: [], pending: [], fees: { cents: 0, count: 0, at: null } };
      buckets.set(key, b);
    }
    return b;
  };
  const addIn = (ref: JobRef | null, line: Omit<JobPnlLine, "amount">, cents: number) => {
    const b = bucket(ref);
    b.inCents += cents;
    b.moneyIn.push({ ...line, amount: cents / 100, cents });
  };
  const addOut = (ref: JobRef | null, line: Omit<JobPnlLine, "amount">, cents: number) => {
    const b = bucket(ref);
    b.outCents += cents;
    b.moneyOut.push({ ...line, amount: cents / 100, cents });
  };

  // Checks: one row per id (a counted copy wins over a pending one).
  const checksById = new Map<string, JobPnlCheck>();
  for (const check of input.checks ?? []) {
    if (!check?.id) continue;
    const prior = checksById.get(check.id);
    if (!prior || (!isCountedCheck(prior) && isCountedCheck(check))) checksById.set(check.id, check);
  }
  // The insured's name on a job's checks: the fallback when its claim or case row has none.
  const customerNameByKey = new Map<string, string>();
  const checkRef = (checkId: string | null | undefined): JobRef | null | undefined => {
    if (!checkId) return undefined;
    const check = checksById.get(String(checkId));
    return check ? jobRefForCheck(check) : undefined;
  };

  for (const check of checksById.values()) {
    const ref = jobRefForCheck(check);
    const name = text(check.customer_name);
    if (name && !customerNameByKey.has(jobKey(ref))) customerNameByKey.set(jobKey(ref), name);
    const cents = toCents(check.amount);
    const carrier = text(check.carrier_name);
    const title = text(check.check_number) ? `Check #${text(check.check_number)}` : "Check";
    if (isCountedCheck(check)) {
      addIn(ref, {
        key: `check-${check.id}`,
        source: "check",
        title,
        detail: carrier,
        dateLabel: lower(check.status) === "funds_released" ? "Funds released" : "Deposited",
        at: check.deposited_at ?? null,
      }, cents);
    } else if (isPendingCheck(check)) {
      const b = bucket(ref);
      b.pendingCents += cents;
      b.pending.push({
        key: `pending-${check.id}`,
        source: "check",
        title,
        detail: carrier,
        dateLabel: "Received",
        at: check.created_at ?? null,
        amount: cents / 100,
        cents,
      });
    }
  }

  for (const invoice of input.invoices ?? []) {
    if (!invoice?.id) continue;
    const claimId = text(invoice.claimId);
    addIn(claimId ? { kind: "claim", id: claimId } : null, {
      key: `invoice-${invoice.id}`,
      source: "invoice",
      title: text(invoice.invoiceNumber) ? `Invoice #${text(invoice.invoiceNumber)}` : "Invoice",
      detail: text(invoice.customerName),
      dateLabel: "Invoice paid",
      at: invoice.at ?? null,
    }, intCents(invoice.amountCents));
  }

  let cashPaymentsCents = 0;
  for (const payment of input.cashPayments ?? []) {
    if (!payment?.id || !text(payment.cash_job_id)) continue;
    // The automatic payment for a check (reference_number = the check id) is that check's money.
    const reference = text(payment.reference_number);
    if (reference && checksById.has(reference)) continue;
    const cents = toCents(payment.amount);
    cashPaymentsCents += cents;
    const method = CASH_METHOD_LABELS[lower(payment.payment_method)] ?? (text(payment.payment_method) ? titleCase(String(payment.payment_method)) : "Payment");
    addIn({ kind: "cash_job", id: String(payment.cash_job_id).trim() }, {
      key: `cash-payment-${payment.id}`,
      source: "cash_payment",
      title: `${method} payment`,
      detail: [text(payment.payee_name), reference ? `Ref ${reference}` : null, text(payment.notes)].filter(Boolean).join(" · ") || null,
      dateLabel: "Paid",
      at: payment.payment_date ?? null,
    }, cents);
  }

  for (const row of input.otherRevenue ?? []) {
    if (!row?.key) continue;
    addIn(null, {
      key: `other-${row.key}`,
      source: "partner_payment",
      title: row.title,
      detail: [text(row.subtitle), text(row.reference) && row.reference !== "—" ? `Check #${row.reference}` : null].filter(Boolean).join(" · ") || null,
      dateLabel: "Received",
      at: row.at ?? null,
    }, toCents(row.amount));
  }

  (input.splits ?? []).forEach((split, index) => {
    if (!split || lower(split.status) !== "settled") return;
    const batch = split.disbursement_batches ?? null;
    const embedded = batch?.check_intake_items ?? null;
    const known = checkRef(batch?.check_intake_item_id);
    const ref = known !== undefined ? known : jobRefForCheck(embedded);
    const acct = split.stakeholder_accounts ?? null;
    const external = lower(split.method) === "external_check";
    const method = external && text(split.external_check_number)
      ? `External check #${text(split.external_check_number)}`
      : splitMethodLabel(split.method);
    const checkNumber = text(embedded?.check_number) ?? text(batch?.check_intake_item_id ? checksById.get(String(batch.check_intake_item_id))?.check_number : null);
    addOut(ref, {
      key: `split-${split.id ?? index}`,
      source: "payout",
      title: text(acct?.nickname) || text(acct?.custname) || text(split.recipient_name) || "Payee",
      detail: [payoutTypeLabel(split.recipient_type), method, checkNumber ? `from check #${checkNumber}` : null].filter(Boolean).join(" · "),
      dateLabel: "Settled",
      at: split.settled_at ?? split.created_at ?? null,
    }, toCents(split.amount));
  });

  for (const payment of sentPayments(input.sends)) {
    const known = checkRef(payment.checkId);
    const claimId = text(payment.check?.claim_id);
    const ref = known !== undefined ? known : claimId ? { kind: "claim" as const, id: claimId } : null;
    const kind = payment.recipientKind === "partner" ? "Partner" : payment.recipientKind === "vendor" ? "Vendor" : "Recipient";
    const checkNumber = text(payment.check?.check_number) ?? text(payment.checkId ? checksById.get(payment.checkId)?.check_number : null);
    addOut(ref, {
      key: payment.key,
      source: "send",
      title: payment.recipientName,
      detail: [kind, "Payment sent", checkNumber ? `from check #${checkNumber}` : null].filter(Boolean).join(" · "),
      dateLabel: payment.completed ? "Settled" : "Sent",
      at: payment.at,
    }, payment.amountCents);
  }

  let feesCents = 0;
  for (const fee of input.fees ?? []) {
    if (!fee?.id || lower(fee.status) === "void") continue;
    const known = checkRef(fee.check_id);
    const claimId = text(fee.claim_id);
    const ref = known ?? (claimId ? { kind: "claim" as const, id: claimId } : null);
    const cents = intCents(fee.amount_cents);
    feesCents += cents;
    const b = bucket(ref);
    b.fees.cents += cents;
    b.fees.count += 1;
    if (time(fee.occurred_at) > time(b.fees.at)) b.fees.at = fee.occurred_at ?? null;
  }
  for (const b of buckets.values()) {
    if (!b.fees.count) continue;
    b.outCents += b.fees.cents;
    b.moneyOut.push({
      key: `fees-${b.key}`,
      source: "fees",
      title: "ChecksOps fees",
      detail: `${b.fees.count} fee${b.fees.count === 1 ? "" : "s"} combined`,
      dateLabel: "Latest",
      at: b.fees.at,
      amount: b.fees.cents / 100,
      cents: b.fees.cents,
    });
  }

  let expensesCents = 0;
  for (const expense of input.expenses ?? []) {
    if (!expense?.id) continue;
    const cents = toCents(expense.amount);
    expensesCents += cents;
    addOut(expense.job ?? null, {
      key: `expense-${expense.id}`,
      source: "expense",
      title: text(expense.payee) || "Job expense",
      detail: [text(expense.category), text(expense.note)].filter(Boolean).join(" · ") || null,
      dateLabel: "Paid",
      at: expense.at ?? null,
    }, cents);
  }

  const names = jobNameLookups(input);
  const label = (b: Bucket) => jobLabel(b.ref, names, customerNameByKey.get(b.key) ?? null);

  const summaries: JobPnlSummary[] = [...buckets.values()].map((b) => {
    const { type, name, subtitle } = label(b);
    const profitCents = b.inCents - b.outCents;
    return {
      key: b.key,
      ref: b.ref,
      type,
      name,
      subtitle,
      revenue: b.inCents / 100,
      costs: b.outCents / 100,
      profit: profitCents / 100,
      margin: jobMargin(b.inCents, profitCents),
      pendingCount: b.pending.length,
      pendingAmount: b.pendingCents / 100,
      moneyIn: sortLines(b.moneyIn).map(stripCents),
      moneyOut: sortLines(b.moneyOut).map(stripCents),
      pendingChecks: sortLines(b.pending).map(stripCents),
    };
  });

  const unassigned = summaries.filter((s) => !s.ref);
  const jobs = summaries
    .filter((s) => !!s.ref)
    .sort((a, b) => b.revenue - a.revenue || b.profit - a.profit || a.name.localeCompare(b.name));
  const all = [...jobs, ...unassigned];

  const sum = (pick: (b: Bucket) => number) => [...buckets.values()].reduce((s, b) => s + pick(b), 0);
  const revenueCents = sum((b) => b.inCents);
  const costCents = sum((b) => b.outCents);
  const pendingCents = sum((b) => b.pendingCents);
  return {
    jobs: all,
    totals: {
      jobCount: jobs.length,
      revenue: revenueCents / 100,
      costs: costCents / 100,
      profit: (revenueCents - costCents) / 100,
      margin: jobMargin(revenueCents, revenueCents - costCents),
      pendingCount: sum((b) => b.pending.length),
      pendingAmount: pendingCents / 100,
    },
    reconciliation: {
      cashPaymentsRevenue: cashPaymentsCents / 100,
      fees: feesCents / 100,
      expenses: expensesCents / 100,
    },
  };
}

/** One job's summary (an empty one, still named, when nothing is linked to it yet). */
export function jobPnlFor(input: JobPnlInput, ref: JobRef): JobPnlSummary {
  const key = jobKey(ref);
  const found = buildJobPnl(input).jobs.find((job) => job.key === key);
  if (found) return found;
  const { type, name, subtitle } = jobLabel(ref, jobNameLookups(input), null);
  return {
    key, ref, type, name, subtitle,
    revenue: 0, costs: 0, profit: 0, margin: null,
    pendingCount: 0, pendingAmount: 0,
    moneyIn: [], moneyOut: [], pendingChecks: [],
  };
}
