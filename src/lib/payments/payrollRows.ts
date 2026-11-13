/**
 * Payroll in the finance views (Payment History, Revenue & Profit, By Recipient, Tax & 1099).
 *
 * A payroll send records one `payroll_runs` row per payee (amount in dollars, status
 * pending -> submitted / failed / partial / unknown) and its payment_transfers legs. It writes
 * no disbursement_splits, so the finance views read payroll_runs next to their split rows.
 * These helpers turn payroll_runs rows into each view's row shape. The payee views (Payment
 * History, By Recipient, Tax & 1099) use the amount only. The speed fee is neither charged nor
 * stored on the run; Revenue & Profit derives it from `speed` as a separate expense line.
 */

import { payrollSpeedFee } from "./payrollSpeedFees.ts";

export const PAYROLL_SOURCE_LABEL = "Payroll";

/** Query-key prefix for every finance-view payroll read; invalidate it after a payroll send. */
export const PAYROLL_FINANCE_QUERY_KEY = "payroll-finance";

// vendor_tenant_id: SQL 165 (a payroll payment to a vendor payee has it and no stakeholder).
export const PAYROLL_RUN_COLUMNS = `
  id, amount, speed, status, memo, created_at, stakeholder_account_id, vendor_tenant_id,
  stakeholder_accounts (id, nickname, custname, account_type, chk_acct)
`;

/** The type a vendor payroll payment shows under (By Recipient, Payment History). */
export const PAYROLL_VENDOR_TYPE = "vendor";
export const PAYROLL_VENDOR_FALLBACK_NAME = "Vendor";

export type PayrollAccount = {
  id?: string | null;
  nickname?: string | null;
  custname?: string | null;
  account_type?: string | null;
  chk_acct?: string | null;
};

export type PayrollRun = {
  id: string;
  amount?: number | string | null;
  speed?: string | null;
  status?: string | null;
  memo?: string | null;
  created_at?: string | null;
  stakeholder_account_id?: string | null;
  stakeholder_accounts?: PayrollAccount | null;
  /** SQL 165: set on a payment to a vendor payee (wallet only); stakeholder_account_id is then null. */
  vendor_tenant_id?: string | null;
  /** The vendor's name, filled in by fetchPayrollRuns from tenants_public. */
  vendor_name?: string | null;
};

/** A payroll payment to a vendor payee rather than a stakeholder. */
export const isVendorPayrollRun = (
  run: Pick<PayrollRun, "vendor_tenant_id" | "stakeholder_account_id" | "stakeholder_accounts">,
): boolean => !!run.vendor_tenant_id && !run.stakeholder_account_id && !run.stakeholder_accounts?.id;

/**
 * paid:      the transfer was submitted (or completed) — counts like a settled payment.
 * in_flight: partial or unknown outcome — shown, never counted in paid totals.
 * pending:   recorded, not yet submitted — hidden where the view hides pending splits.
 * excluded:  failed — no money moved, never shown.
 */
export type PayrollStatusBucket = "paid" | "in_flight" | "pending" | "excluded";

export function payrollStatusBucket(status: string | null | undefined): PayrollStatusBucket {
  switch (String(status ?? "").toLowerCase()) {
    case "submitted":
    case "completed":
      return "paid";
    case "pending":
      return "pending";
    case "failed":
      return "excluded";
    default:
      // partial, unknown, or a status this view does not know yet: visible, not counted.
      return "in_flight";
  }
}

export const isPayrollPaid = (run: Pick<PayrollRun, "status">): boolean =>
  payrollStatusBucket(run.status) === "paid";

export const payrollAmount = (run: Pick<PayrollRun, "amount">): number => {
  const n = Number(run.amount ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** The payee embed, or a minimal one from stakeholder_account_id when the embed is missing. */
export function payrollAccount(run: PayrollRun): PayrollAccount {
  // A vendor payee has no stakeholder account: its name stands in, and there is no account id.
  if (isVendorPayrollRun(run)) {
    return { id: null, nickname: run.vendor_name || PAYROLL_VENDOR_FALLBACK_NAME, custname: null, account_type: PAYROLL_VENDOR_TYPE, chk_acct: null };
  }
  const embed = run.stakeholder_accounts ?? null;
  const id = embed?.id ?? run.stakeholder_account_id ?? null;
  return { ...(embed ?? {}), id };
}

export const payrollRecipientName = (run: PayrollRun): string => {
  const acct = payrollAccount(run);
  return acct.nickname ?? acct.custname ?? "Payroll payee";
};

/** Payroll History: the payee's name and second line, for a stakeholder or a vendor payee. */
export function payrollPayeeLines(run: PayrollRun): { name: string; detail: string | null } {
  if (isVendorPayrollRun(run)) return { name: run.vendor_name || PAYROLL_VENDOR_FALLBACK_NAME, detail: "Vendor · ChecksOps wallet" };
  const acct = run.stakeholder_accounts ?? null;
  return { name: acct?.nickname ?? "—", detail: acct?.custname ?? null };
}

/** Payment History status for a payroll run, in the split vocabulary the ledger shows. */
export function payrollLedgerStatus(status: string | null | undefined): "settled" | "submitted" | "pending" | null {
  switch (payrollStatusBucket(status)) {
    case "paid": return "settled";
    case "in_flight": return "submitted";
    case "pending": return "pending";
    default: return null;
  }
}

export type PayrollLedgerRow = {
  id: string;
  payroll_run_id: string;
  source: "payroll";
  amount: number;
  status: "settled" | "submitted";
  payroll_status: string;
  created_at: string;
  submitted_at: string | null;
  settled_at: string | null;
  returned_at: null;
  return_code: null;
  return_desc: null;
  method: "payroll";
  memo: string | null;
  recipient_name: string;
  recipient_type: string;
  external_check_number: null;
  stakeholder_accounts: PayrollAccount;
  disbursement_batches: null;
};

/**
 * Payment History rows. Like the split query (`status != pending`), pending runs are left out;
 * failed runs never appear. Rows carry `source: "payroll"` so the view can label them.
 */
export function payrollLedgerRows(runs: PayrollRun[] | null | undefined): PayrollLedgerRow[] {
  const out: PayrollLedgerRow[] = [];
  for (const run of runs ?? []) {
    const status = payrollLedgerStatus(run.status);
    if (status !== "settled" && status !== "submitted") continue;
    if (!run.created_at) continue;
    const acct = payrollAccount(run);
    out.push({
      id: `payroll:${run.id}`,
      payroll_run_id: run.id,
      source: "payroll",
      amount: payrollAmount(run),
      status,
      payroll_status: String(run.status ?? ""),
      created_at: run.created_at,
      submitted_at: run.created_at,
      settled_at: status === "settled" ? run.created_at : null,
      returned_at: null,
      return_code: null,
      return_desc: null,
      method: "payroll",
      memo: run.memo ?? null,
      recipient_name: payrollRecipientName(run),
      recipient_type: acct.account_type ?? "other",
      external_check_number: null,
      stakeholder_accounts: acct,
      disbursement_batches: null,
    });
  }
  return out;
}

export type PayrollRecipientReportRow = {
  id: string;
  date: string;
  name: string;
  type: string;
  acct4: string;
  amount: number;
  status: "settled" | "submitted";
  method: "payroll";
};

/** By Recipient rows: same name/type as the payee's split rows so they group together. */
export function payrollRecipientReportRows(runs: PayrollRun[] | null | undefined): PayrollRecipientReportRow[] {
  return payrollLedgerRows(runs).map((r) => ({
    id: r.id,
    date: r.settled_at ?? r.created_at,
    name: r.recipient_name,
    type: r.recipient_type,
    acct4: r.stakeholder_accounts.chk_acct ? `••••${r.stakeholder_accounts.chk_acct.slice(-4)}` : "—",
    amount: r.amount,
    status: r.status,
    method: "payroll",
  }));
}

/** Revenue & Profit: payroll paid out is an expense. */
export function payrollExpenseTotal(runs: PayrollRun[] | null | undefined): { total: number; count: number } {
  let total = 0;
  let count = 0;
  for (const run of runs ?? []) {
    if (!isPayrollPaid(run)) continue;
    total += payrollAmount(run);
    count += 1;
  }
  return { total, count };
}

/**
 * Revenue & Profit: the speed fee of each paid run (derived from `speed`), a separate expense
 * line. Same status rule as payrollExpenseTotal; `count` is the paid runs that carry a fee.
 */
export function payrollSpeedFeeExpenseTotal(runs: PayrollRun[] | null | undefined): { total: number; count: number } {
  let cents = 0;
  let count = 0;
  for (const run of runs ?? []) {
    if (!isPayrollPaid(run)) continue;
    const fee = payrollSpeedFee(run.speed);
    if (fee <= 0) continue;
    cents += Math.round(fee * 100);
    count += 1;
  }
  return { total: cents / 100, count };
}

/**
 * Tax & 1099: paid runs as split-shaped payments keyed to the payee's stakeholder account, so
 * they merge with that payee's other payments (`acct:<id>`). payroll_runs has no settled_at;
 * the month comes from created_at. A payment to a vendor payee has no stakeholder account: it is
 * counted for the vendor organization through payrollVendorTaxPayments instead.
 */
export type PayrollTaxPayment = {
  created_at: string;
  settled_at: null;
  amount: number;
  stakeholder_accounts: PayrollAccount;
};

export function payrollTaxPayments(runs: PayrollRun[] | null | undefined): PayrollTaxPayment[] {
  const out: PayrollTaxPayment[] = [];
  for (const run of runs ?? []) {
    if (!isPayrollPaid(run) || !run.created_at) continue;
    const acct = payrollAccount(run);
    if (!acct.id) continue;
    out.push({ created_at: run.created_at, settled_at: null, amount: payrollAmount(run), stakeholder_accounts: acct });
  }
  return out;
}

/**
 * Tax & 1099 (owner, 2026-11-13: "Include vendors in the 1099 reports"): paid payroll runs to a
 * vendor payee, keyed to the vendor organization. Same status rule as payrollTaxPayments.
 */
export function payrollVendorTaxPayments(
  runs: PayrollRun[] | null | undefined,
): Array<{ vendor_tenant_id: string; vendor_name: string | null; at: string; amount: number }> {
  const out: Array<{ vendor_tenant_id: string; vendor_name: string | null; at: string; amount: number }> = [];
  for (const run of runs ?? []) {
    if (!isVendorPayrollRun(run) || !isPayrollPaid(run) || !run.created_at) continue;
    out.push({ vendor_tenant_id: run.vendor_tenant_id as string, vendor_name: run.vendor_name ?? null, at: run.created_at, amount: payrollAmount(run) });
  }
  return out;
}

type QueryResult = { data: unknown; error: unknown };
type PayrollQuery = PromiseLike<QueryResult> & {
  eq(column: string, value: string): PayrollQuery;
  in(column: string, values: string[]): PayrollQuery;
  gte(column: string, value: string): PayrollQuery;
  lte(column: string, value: string): PayrollQuery;
  order(column: string, options: { ascending: boolean }): PayrollQuery;
};
type PayrollClient = { from(table: string): { select(columns: string): PayrollQuery } };

/**
 * Reads one tenant's payroll runs, optionally limited to created_at in [from, to].
 * `client` is the app's data client (only from/select/eq/gte/lte/order are used); it is taken
 * as unknown because the generated table types do not describe the stakeholder embed.
 */
export async function fetchPayrollRuns(
  client: unknown,
  tenantId: string,
  range?: { from: string; to: string } | null,
): Promise<PayrollRun[]> {
  let q = (client as PayrollClient)
    .from("payroll_runs")
    .select(PAYROLL_RUN_COLUMNS)
    .eq("tenant_id", tenantId);
  if (range) q = q.gte("created_at", range.from).lte("created_at", range.to);
  const { data, error } = await q.order("created_at", { ascending: false });
  if (error) throw error;
  return withVendorNames(client, (data as PayrollRun[] | null) ?? []);
}

/**
 * Fills vendor_name on vendor payroll runs from tenants_public (names only). A failed lookup
 * leaves the names empty (shown as "Vendor"); it never fails the read.
 */
export async function withVendorNames(client: unknown, runs: PayrollRun[]): Promise<PayrollRun[]> {
  const ids = [...new Set(runs.filter(isVendorPayrollRun).map((r) => r.vendor_tenant_id as string))];
  if (ids.length === 0) return runs;
  const names = new Map<string, string>();
  try {
    const { data, error } = await (client as PayrollClient).from("tenants_public").select("id, name").in("id", ids);
    if (!error) {
      for (const row of (data as Array<{ id?: string; name?: string | null }> | null) ?? []) {
        if (row?.id && row.name) names.set(row.id, row.name);
      }
    }
  } catch {
    /* names stay empty */
  }
  return runs.map((r) =>
    isVendorPayrollRun(r) ? { ...r, vendor_name: names.get(r.vendor_tenant_id as string) ?? r.vendor_name ?? null } : r,
  );
}
