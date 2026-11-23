/**
 * Reads for the per-job P&L (jobPnl.ts), website only. Every table and column here is one the data
 * API already serves to members of the organization (aws/functions/api/allowed-tables.json; none is
 * a SECRET_COLUMNS entry) and that another screen already reads: check_intake_items (Checks, Revenue
 * & Profit), disbursement_batches / disbursement_splits (Payment History), payment_transfers send
 * legs (useSentPaymentLegs), platform_fee_line_items (feeSchedules.ts), cash_job_payments and
 * cash_jobs (Cash Jobs), moov_invoices (useMoovInvoices reads every column), claims (Claim Ledger),
 * check_cases (useCaseInsuredNames). Nothing is written.
 *
 * Lists are read page by page (the data API returns at most 500 rows a read) and id lists in chunks.
 *
 * No "@/" imports: aws/tests load this file with --experimental-strip-types.
 */
import { fetchQueueList, type QueuePage } from "./mortgageOpsQueuePaging.ts";
import { REVENUE_EXPENSE_SPLIT_COLUMNS } from "./payments/revenueExpenseRows.ts";
import { ACCEPTED_SEND_STATUSES, SEND_LEG_COLUMNS, SEND_LEG_ROLES, type SendLeg } from "./payments/transferFinanceRows.ts";
import {
  COUNTED_CHECK_STATUSES,
  type JobPnlCase,
  type JobPnlCashJob,
  type JobPnlCashPayment,
  type JobPnlCheck,
  type JobPnlClaim,
  type JobPnlFee,
  type JobPnlInput,
  type JobPnlSplit,
  type JobRef,
} from "./jobPnl.ts";

export const JOB_PNL_QUERY_KEY = "job-pnl";
export const JOB_PNL_CHECK_COLUMNS =
  "id, amount, status, check_stage, deposited_at, created_at, check_number, carrier_name, claim_id, case_id, cash_job_id";
export const JOB_PNL_FEE_COLUMNS = "id, amount_cents, status, fee_code, description, occurred_at, check_id, claim_id";
export const JOB_PNL_CASH_PAYMENT_COLUMNS =
  "id, cash_job_id, amount, payment_date, payment_method, reference_number, payee_name, notes";
/** Ids per `in` read. */
export const JOB_PNL_ID_CHUNK = 100;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the Supabase query builder
export type JobPnlClient = { from: (table: string) => any };

export interface InvoiceClaimLink { id: string; claim_id: string | null }

const chunksOf = <T,>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};
const distinct = (values: Array<string | null | undefined>) =>
  [...new Set(values.map((v) => String(v ?? "").trim()).filter(Boolean))];

async function readInChunks<T>(ids: string[], read: (chunk: string[]) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const rows: T[] = [];
  for (const chunk of chunksOf(ids, JOB_PNL_ID_CHUNK)) {
    const result = await read(chunk);
    if (result.error) throw result.error;
    rows.push(...(result.data ?? []));
  }
  return rows;
}

async function readAll<T extends { id: string }>(build: (from: number, to: number) => PromiseLike<QueuePage<T>>): Promise<{ rows: T[]; incomplete: boolean }> {
  const list = await fetchQueueList<T>((from, to) => build(from, to));
  if (list.error) throw list.error;
  return { rows: list.rows, incomplete: list.incomplete };
}

const countedList = `(${COUNTED_CHECK_STATUSES.join(",")})`;

// ---------------------------------------------------------------- By Job (whole organization)

export interface JobPnlTenantRows {
  /** Checks not yet counted as revenue (status not deposited / funds_released), any job or none. */
  pendingChecks: JobPnlCheck[];
  cashPayments: JobPnlCashPayment[];
  fees: JobPnlFee[];
  invoiceClaims: InvoiceClaimLink[];
  /** True when a list was longer than what was loaded. */
  incomplete: boolean;
  /** Lists that could not be read (left out of the figures): "fees", "invoice links". */
  unavailable: string[];
}

/**
 * The rows By Job reads on top of the Totals view's own (deposited checks, settled splits, paid
 * invoices, sends, partner payments): checks still in process, cash-job payments, ChecksOps fees and
 * which claim each invoice is for. Fees and invoice links are best effort.
 */
export async function loadJobPnlTenantRows(client: JobPnlClient, tenantId: string): Promise<JobPnlTenantRows> {
  const [pending, payments, fees, invoiceClaims] = await Promise.all([
    readAll<JobPnlCheck>((from, to) => client
      .from("check_intake_items")
      .select(JOB_PNL_CHECK_COLUMNS, { count: "exact" })
      .eq("tenant_id", tenantId)
      .not("status", "in", countedList)
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, to)),
    readAll<JobPnlCashPayment>((from, to) => client
      .from("cash_job_payments")
      .select(JOB_PNL_CASH_PAYMENT_COLUMNS, { count: "exact" })
      .eq("tenant_id", tenantId)
      .order("payment_date", { ascending: false })
      .order("id", { ascending: true })
      .range(from, to)),
    readAll<JobPnlFee>((from, to) => client
      .from("platform_fee_line_items")
      .select(JOB_PNL_FEE_COLUMNS, { count: "exact" })
      .eq("tenant_id", tenantId)
      .neq("status", "void")
      .order("occurred_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, to)).catch(() => null),
    readAll<InvoiceClaimLink>((from, to) => client
      .from("moov_invoices")
      .select("id, claim_id", { count: "exact" })
      .eq("tenant_id", tenantId)
      .not("claim_id", "is", null)
      .order("id", { ascending: true })
      .range(from, to)).catch(() => null),
  ]);
  const unavailable: string[] = [];
  if (!fees) unavailable.push("fees");
  if (!invoiceClaims) unavailable.push("invoice links");
  return {
    pendingChecks: pending.rows,
    cashPayments: payments.rows,
    fees: fees?.rows ?? [],
    invoiceClaims: invoiceClaims?.rows ?? [],
    incomplete: pending.incomplete || payments.incomplete || !!fees?.incomplete || !!invoiceClaims?.incomplete,
    unavailable,
  };
}

export interface JobPnlNames {
  claims: JobPnlClaim[];
  cases: JobPnlCase[];
  cashJobs: JobPnlCashJob[];
}

/** The names of the given jobs: claims, check cases and cash jobs. */
export async function loadJobPnlNames(client: JobPnlClient, refs: JobRef[]): Promise<JobPnlNames> {
  const ids = (kind: JobRef["kind"]) => distinct(refs.filter((r) => r.kind === kind).map((r) => r.id));
  const [claims, cases, cashJobs] = await Promise.all([
    readInChunks<JobPnlClaim>(ids("claim"), (chunk) => client.from("claims").select("id, claim_number, policyholder_name").in("id", chunk)),
    readInChunks<JobPnlCase>(ids("case"), (chunk) => client.from("check_cases").select("id, claim_number, insured_name").in("id", chunk)),
    readInChunks<JobPnlCashJob>(ids("cash_job"), (chunk) => client.from("cash_jobs").select("id, job_name, customer_name").in("id", chunk)),
  ]);
  return { claims, cases, cashJobs };
}

// ---------------------------------------------------------------- one job

const CHECK_COLUMN_BY_KIND: Record<JobRef["kind"], string> = { claim: "claim_id", case: "case_id", cash_job: "cash_job_id" };

/**
 * Everything linked to one job, for its Job P&L card: its checks (any status), the settled payouts
 * and paid sends from those checks, its ChecksOps fees, its cash-job payments and its name. Paid
 * invoices come from usePaidInvoiceRevenue; `invoiceClaims` says which of them are this claim's.
 */
export async function loadJobPnlForJob(
  client: JobPnlClient,
  tenantId: string,
  ref: JobRef,
): Promise<Omit<JobPnlInput, "invoices" | "otherRevenue"> & { invoiceClaims: InvoiceClaimLink[]; incomplete: boolean }> {
  const checks = await readAll<JobPnlCheck>((from, to) => client
    .from("check_intake_items")
    .select(JOB_PNL_CHECK_COLUMNS, { count: "exact" })
    .eq("tenant_id", tenantId)
    .eq(CHECK_COLUMN_BY_KIND[ref.kind], ref.id)
    .order("created_at", { ascending: false })
    .order("id", { ascending: true })
    .range(from, to));
  const checkIds = distinct(checks.rows.map((c) => c.id));
  const checkById = new Map(checks.rows.map((c) => [c.id, c]));

  const batchesP = readInChunks<{ id: string; check_intake_item_id: string | null }>(checkIds, (chunk) => client
    .from("disbursement_batches")
    .select("id, check_intake_item_id")
    .eq("tenant_id", tenantId)
    .in("check_intake_item_id", chunk));
  const sendsByCheckP = readInChunks<SendLeg>(checkIds, (chunk) => client
    .from("payment_transfers")
    .select(SEND_LEG_COLUMNS)
    .eq("tenant_id", tenantId)
    .in("check_id", chunk)
    .in("leg_role", [...SEND_LEG_ROLES])
    .in("status", [...ACCEPTED_SEND_STATUSES]));
  const sendsByClaimP: Promise<SendLeg[]> = ref.kind === "claim"
    ? readAll<SendLeg>((from, to) => client
      .from("payment_transfers")
      .select(SEND_LEG_COLUMNS, { count: "exact" })
      .eq("tenant_id", tenantId)
      .eq("claim_id", ref.id)
      .in("leg_role", [...SEND_LEG_ROLES])
      .in("status", [...ACCEPTED_SEND_STATUSES])
      .order("id", { ascending: true })
      .range(from, to)).then((r) => r.rows)
    : Promise.resolve([]);
  const feesByCheckP = readInChunks<JobPnlFee>(checkIds, (chunk) => client
    .from("platform_fee_line_items")
    .select(JOB_PNL_FEE_COLUMNS)
    .eq("tenant_id", tenantId)
    .in("check_id", chunk));
  const feesByClaimP: Promise<JobPnlFee[]> = ref.kind === "claim"
    ? readAll<JobPnlFee>((from, to) => client
      .from("platform_fee_line_items")
      .select(JOB_PNL_FEE_COLUMNS, { count: "exact" })
      .eq("tenant_id", tenantId)
      .eq("claim_id", ref.id)
      .order("id", { ascending: true })
      .range(from, to)).then((r) => r.rows)
    : Promise.resolve([]);
  const paymentsP: Promise<JobPnlCashPayment[]> = ref.kind === "cash_job"
    ? readAll<JobPnlCashPayment>((from, to) => client
      .from("cash_job_payments")
      .select(JOB_PNL_CASH_PAYMENT_COLUMNS, { count: "exact" })
      .eq("tenant_id", tenantId)
      .eq("cash_job_id", ref.id)
      .order("id", { ascending: true })
      .range(from, to)).then((r) => r.rows)
    : Promise.resolve([]);
  const invoiceClaimsP: Promise<InvoiceClaimLink[]> = ref.kind === "claim"
    ? readAll<InvoiceClaimLink>((from, to) => client
      .from("moov_invoices")
      .select("id, claim_id", { count: "exact" })
      .eq("tenant_id", tenantId)
      .eq("claim_id", ref.id)
      .order("id", { ascending: true })
      .range(from, to)).then((r) => r.rows)
    : Promise.resolve([]);
  const namesP = loadJobPnlNames(client, [ref]);

  const batches = await batchesP;
  const batchIds = distinct(batches.map((b) => b.id));
  const splitsP = readInChunks<JobPnlSplit>(batchIds, (chunk) => client
    .from("disbursement_splits")
    .select(REVENUE_EXPENSE_SPLIT_COLUMNS)
    .eq("tenant_id", tenantId)
    .eq("status", "settled")
    .in("batch_id", chunk));

  const [splits, sendsByCheck, sendsByClaim, feesByCheck, feesByClaim, cashPayments, invoiceClaims, names] = await Promise.all([
    splitsP, sendsByCheckP, sendsByClaimP, feesByCheckP, feesByClaimP, paymentsP, invoiceClaimsP, namesP,
  ]);

  const sendsById = new Map<string, SendLeg>();
  for (const leg of [...sendsByCheck, ...sendsByClaim]) {
    if (!leg?.id || sendsById.has(leg.id)) continue;
    const check = leg.check_id ? checkById.get(leg.check_id) : null;
    sendsById.set(leg.id, {
      ...leg,
      check: check
        ? { check_number: check.check_number ?? null, carrier_name: check.carrier_name ?? null, claim_id: check.claim_id ?? null }
        : ref.kind === "claim" ? { claim_id: ref.id } : null,
    });
  }
  const feesById = new Map<string, JobPnlFee>();
  for (const fee of [...feesByCheck, ...feesByClaim]) if (fee?.id && !feesById.has(fee.id)) feesById.set(fee.id, fee);

  return {
    checks: checks.rows,
    splits,
    sends: [...sendsById.values()],
    fees: [...feesById.values()],
    cashPayments,
    expenses: [],
    invoiceClaims,
    ...names,
    incomplete: checks.incomplete,
  };
}

/** Paid-invoice rows with the claim each one is for (from the invoice links read here). */
export function withInvoiceClaims<T extends { id: string }>(invoices: T[] | null | undefined, links: InvoiceClaimLink[] | null | undefined): Array<T & { claimId: string | null }> {
  const byId = new Map((links ?? []).map((l) => [String(l.id), l.claim_id ?? null]));
  return (invoices ?? []).map((invoice) => ({ ...invoice, claimId: byId.get(String(invoice.id)) ?? null }));
}
