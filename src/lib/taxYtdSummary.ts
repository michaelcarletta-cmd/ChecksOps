/**
 * Non-sensitive year-to-date payment reporting helpers.
 * Must never include TIN, EIN, SSN, or other tax-identifier values.
 */

export const LEGACY_INFORMATIONAL_THRESHOLD = 600;

export const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

export const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  operating: "Operating",
  vendor: "Vendor",
  subcontractor: "Subcontractor",
  overhead: "Overhead",
  insured: "Insured",
  contractor: "Contractor",
  supplier: "Supplier",
  sales_rep: "Sales Rep",
  appraisal: "Appraisal",
  adjuster: "Adjuster",
  other: "Other",
};

/** Legacy informational categories only — not a filing determination. */
export const LEGACY_INFORMATIONAL_1099_TYPES = [
  "subcontractor",
  "vendor",
  "contractor",
  "supplier",
  "sales_rep",
  "appraisal",
  "adjuster",
  "other",
];

export type RecipientRow = {
  id: string;
  nickname: string;
  custname: string;
  account_type: string;
  chk_acct: string;
  total: number;
  payment_count: number;
  requires_1099: boolean;
  needs_1099: boolean;
  monthly: number[];
};

type SplitPayment = {
  settled_at?: string | null;
  created_at?: string | null;
  amount?: number | string | null;
  recipient_name?: string | null;
  recipient_type?: string | null;
  stakeholder_accounts?: {
    id?: string;
    nickname?: string | null;
    custname?: string | null;
    account_type?: string | null;
    chk_acct?: string | null;
  } | null;
};

type CashPayment = {
  payment_date?: string | null;
  amount?: number | string | null;
  payee_name?: string | null;
  stakeholder_accounts?: SplitPayment["stakeholder_accounts"];
};

export function aggregateRecipientRows({
  payments = [],
  cashPayments = [],
  year,
  threshold = LEGACY_INFORMATIONAL_THRESHOLD,
}: {
  payments?: SplitPayment[];
  cashPayments?: CashPayment[];
  year: number;
  threshold?: number;
}): RecipientRow[] {
  const map: Record<string, RecipientRow> = {};

  const upsert = (key: string, base: Partial<RecipientRow>, amount: number, monthIdx: number) => {
    if (!map[key]) {
      const accountType = base.account_type ?? "other";
      map[key] = {
        id: key,
        nickname: base.nickname ?? "—",
        custname: base.custname ?? "",
        account_type: accountType,
        chk_acct: base.chk_acct ?? "",
        total: 0,
        payment_count: 0,
        requires_1099: LEGACY_INFORMATIONAL_1099_TYPES.includes(accountType),
        needs_1099: false,
        monthly: Array(12).fill(0),
      };
    }
    map[key].total += amount;
    map[key].payment_count += 1;
    map[key].monthly[monthIdx] += amount;
  };

  for (const p of payments) {
    const acct = p.stakeholder_accounts;
    const dateStr = p.settled_at ?? p.created_at;
    if (!dateStr) continue;
    const d = new Date(dateStr);
    if (d.getFullYear() !== year) continue;
    const m = d.getMonth();
    const amount = Number(p.amount ?? 0);
    if (acct?.id) {
      upsert(`acct:${acct.id}`, {
        nickname: acct.nickname ?? undefined,
        custname: acct.custname ?? undefined,
        account_type: acct.account_type ?? undefined,
        chk_acct: acct.chk_acct ?? undefined,
      }, amount, m);
    } else if (p.recipient_name) {
      const t = p.recipient_type ?? "other";
      upsert(`ext:${t}|${p.recipient_name.toLowerCase()}`, {
        nickname: p.recipient_name,
        custname: "External check",
        account_type: t,
        chk_acct: "",
      }, amount, m);
    }
  }

  for (const p of cashPayments) {
    const acct = p.stakeholder_accounts;
    if (!p.payment_date) continue;
    const d = new Date(p.payment_date);
    if (d.getFullYear() !== year) continue;
    const m = d.getMonth();
    const amount = Number(p.amount ?? 0);
    if (acct?.id) {
      upsert(`acct:${acct.id}`, {
        nickname: acct.nickname ?? undefined,
        custname: acct.custname ?? undefined,
        account_type: acct.account_type ?? undefined,
        chk_acct: acct.chk_acct ?? undefined,
      }, amount, m);
    } else if (p.payee_name) {
      upsert(`cash:${p.payee_name.toLowerCase()}`, {
        nickname: p.payee_name,
        custname: "Cash job payee",
        account_type: "other",
        chk_acct: "",
      }, amount, m);
    }
  }

  for (const r of Object.values(map)) {
    r.needs_1099 = r.requires_1099 && r.total >= threshold;
  }

  return Object.values(map).sort((a, b) => b.total - a.total);
}

export function maskAccountLast4(chkAcct: string | null | undefined): string {
  if (!chkAcct) return "";
  return `••••${String(chkAcct).slice(-4)}`;
}

export function buildPaymentReportingCsv({
  year,
  recipients,
  monthlyTotals,
  totalPaid,
}: {
  year: number;
  recipients: RecipientRow[];
  monthlyTotals: number[];
  totalPaid: number;
}): string {
  const headers = [
    "Recipient",
    "Account Holder Name",
    "Type",
    "Account (last 4)",
    ...MONTH_LABELS.map((m) => `${m} ${year}`),
    `Total ${year}`,
    "Payment Count",
    "Legacy informational $600 flag (not a filing determination)",
  ];
  const rows = recipients.map((r) => [
    r.nickname,
    r.custname,
    ACCOUNT_TYPE_LABELS[r.account_type] ?? r.account_type,
    maskAccountLast4(r.chk_acct),
    ...r.monthly.map((v) => v.toFixed(2)),
    r.total.toFixed(2),
    r.payment_count,
    r.needs_1099 ? "YES" : "No",
  ]);
  const totalsRow = [
    "TOTAL", "", "", "",
    ...monthlyTotals.map((v) => v.toFixed(2)),
    totalPaid.toFixed(2), "", "",
  ];
  return [headers, ...rows, totalsRow]
    .map((row) => row.map((v) => `"${v}"`).join(","))
    .join("\n");
}

export function csvContainsTin(csv: string, sampleTin?: string): boolean {
  if (/(?:^|,)"?(?:tin|ein|ssn|tin_encrypted)"?(?:,|$)/im.test(csv)) return true;
  if (sampleTin) {
    const digits = String(sampleTin).replace(/\D/g, "");
    if (digits.length >= 5 && csv.includes(digits)) return true;
    if (csv.includes(String(sampleTin))) return true;
  }
  return false;
}
