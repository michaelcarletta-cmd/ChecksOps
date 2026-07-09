import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenant } from "@/contexts/TenantContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertTriangle, Download, FileText, CheckCircle2, Info, Search } from "lucide-react";
import { startOfYear, endOfYear, getYear } from "date-fns";
import { toast } from "@/hooks/use-toast";
import f1099necAsset from "@/assets/f1099nec.pdf.asset.json";


const THRESHOLD = 600;
const CURRENT_YEAR = getYear(new Date());
const YEARS = [CURRENT_YEAR, CURRENT_YEAR - 1, CURRENT_YEAR - 2];

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const ACCOUNT_TYPE_LABELS: Record<string, string> = {
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

// Businesses/individuals that may require a 1099-NEC at year end
const REQUIRES_1099_TYPES = ["subcontractor", "vendor", "contractor", "supplier", "sales_rep", "appraisal", "adjuster", "other"];

type RecipientRow = {
  id: string;
  nickname: string;
  custname: string;
  account_type: string;
  chk_acct: string;
  total: number;
  payment_count: number;
  requires_1099: boolean;
  needs_1099: boolean;
  monthly: number[]; // length 12
};

export function TaxSummary() {
  const { tenant } = useTenant();
  const [year, setYear] = useState(CURRENT_YEAR);
  const [monthFilter, setMonthFilter] = useState<string>("all"); // "all" or "0".."11"
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");

  const { data: tenantDetails } = useQuery({
    queryKey: ["tax-summary-tenant-details", tenant?.id],
    enabled: !!tenant?.id,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("tenants")
        .select("legal_business_name, ein, business_address, business_phone")
        .eq("id", tenant!.id)
        .maybeSingle();
      if (error) throw error;
      return data as { legal_business_name: string | null; ein: string | null; business_address: string | null; business_phone: string | null } | null;
    },
  });

  const { data: payments = [], isLoading } = useQuery({
    queryKey: ["tax-summary", tenant?.id, year],
    enabled: !!tenant?.id,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("disbursement_splits")
        .select(`
          id, amount, status, created_at, settled_at,
          recipient_name, recipient_type,
          stakeholder_accounts (
            id, nickname, custname, account_type, chk_acct
          )
        `)
        .eq("tenant_id", tenant!.id)
        .eq("status", "settled")
        .gte("created_at", startOfYear(new Date(year, 0, 1)).toISOString())
        .lte("created_at", endOfYear(new Date(year, 0, 1)).toISOString());

      if (error) throw error;
      return data ?? [];
    },
  });

  const { data: cashPayments = [] } = useQuery({
    queryKey: ["tax-summary-cash", tenant?.id, year],
    enabled: !!tenant?.id,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("cash_job_payments")
        .select(`id, amount, payment_date, stakeholder_account_id, payee_name,
          stakeholder_accounts:stakeholder_account_id (id, nickname, custname, account_type, chk_acct)`)
        .eq("tenant_id", tenant!.id)
        .gte("payment_date", `${year}-01-01`)
        .lte("payment_date", `${year}-12-31`);
      if (error) throw error;
      return data ?? [];
    },
  });

  const { data: depositedChecks = [] } = useQuery({
    queryKey: ["tax-summary-income", tenant?.id, year],
    enabled: !!tenant?.id,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("check_intake_items")
        .select("id, amount, deposited_at, status")
        .eq("tenant_id", tenant!.id)
        .eq("status", "deposited")
        .gte("deposited_at", startOfYear(new Date(year, 0, 1)).toISOString())
        .lte("deposited_at", endOfYear(new Date(year, 0, 1)).toISOString());
      if (error) throw error;
      return data ?? [];
    },
  });

  const recipients: RecipientRow[] = useMemo(() => {
    const map: Record<string, RecipientRow> = {};

    const upsert = (key: string, base: Partial<RecipientRow>, amount: number, monthIdx: number) => {
      if (!map[key]) {
        map[key] = {
          id: key,
          nickname: base.nickname ?? "—",
          custname: base.custname ?? "",
          account_type: base.account_type ?? "other",
          chk_acct: base.chk_acct ?? "",
          total: 0,
          payment_count: 0,
          requires_1099: REQUIRES_1099_TYPES.includes(base.account_type ?? "other"),
          needs_1099: false,
          monthly: Array(12).fill(0),
        };
      }
      map[key].total += amount;
      map[key].payment_count += 1;
      map[key].monthly[monthIdx] += amount;
    };

    for (const p of payments as any[]) {
      const acct = p.stakeholder_accounts;
      const dateStr = p.settled_at ?? p.created_at;
      if (!dateStr) continue;
      const d = new Date(dateStr);
      if (d.getFullYear() !== year) continue;
      const m = d.getMonth();
      const amount = Number(p.amount ?? 0);
      if (acct?.id) {
        upsert(`acct:${acct.id}`, {
          nickname: acct.nickname,
          custname: acct.custname,
          account_type: acct.account_type,
          chk_acct: acct.chk_acct,
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

    for (const p of cashPayments as any[]) {
      const acct = p.stakeholder_accounts;
      if (!p.payment_date) continue;
      const d = new Date(p.payment_date);
      if (d.getFullYear() !== year) continue;
      const m = d.getMonth();
      const amount = Number(p.amount ?? 0);
      if (acct?.id) {
        upsert(`acct:${acct.id}`, {
          nickname: acct.nickname,
          custname: acct.custname,
          account_type: acct.account_type,
          chk_acct: acct.chk_acct,
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
      r.needs_1099 = r.requires_1099 && r.total >= THRESHOLD;
    }

    return Object.values(map).sort((a, b) => b.total - a.total);
  }, [payments, cashPayments, year]);

  const visibleRecipients = useMemo(() => {
    return recipients.filter((r) => {
      const matchSearch = !search ||
        r.nickname.toLowerCase().includes(search.toLowerCase()) ||
        r.custname.toLowerCase().includes(search.toLowerCase());
      const matchType = typeFilter === "all" || r.account_type === typeFilter;
      if (monthFilter !== "all") {
        const m = Number(monthFilter);
        if ((r.monthly[m] ?? 0) <= 0) return false;
      }
      return matchSearch && matchType;
    });
  }, [recipients, search, typeFilter, monthFilter]);

  const displayedTotal = (r: RecipientRow) =>
    monthFilter === "all" ? r.total : r.monthly[Number(monthFilter)] ?? 0;

  const flag1099Count = recipients.filter(r => r.needs_1099).length;
  const totalPaid = recipients.reduce((s, r) => s + r.total, 0);
  const totalSubsPaid = recipients.filter(r => r.account_type === "subcontractor").reduce((s, r) => s + r.total, 0);
  const totalIncome = (depositedChecks as any[]).reduce((s, c) => s + Number(c.amount ?? 0), 0);
  const depositedCount = (depositedChecks as any[]).length;
  const netRetained = totalIncome - totalPaid;
  const payoutRatio = totalIncome > 0 ? (totalPaid / totalIncome) * 100 : 0;

  // Monthly totals across all recipients (for the strip)
  const monthlyTotals = useMemo(() => {
    const t = Array(12).fill(0);
    for (const r of recipients) for (let i = 0; i < 12; i++) t[i] += r.monthly[i];
    return t;
  }, [recipients]);

  const exportCSV = () => {
    const headers = [
      "Recipient",
      "Account Holder Name",
      "Type",
      "Account (last 4)",
      ...MONTH_LABELS.map(m => `${m} ${year}`),
      `Total ${year}`,
      "Payment Count",
      "May Require 1099",
    ];
    const rows = visibleRecipients.map(r => [
      r.nickname,
      r.custname,
      ACCOUNT_TYPE_LABELS[r.account_type] ?? r.account_type,
      r.chk_acct ? `••••${r.chk_acct.slice(-4)}` : "",
      ...r.monthly.map(v => v.toFixed(2)),
      r.total.toFixed(2),
      r.payment_count,
      r.needs_1099 ? "YES" : "No",
    ]);

    const totalsRow = [
      "TOTAL", "", "", "",
      ...monthlyTotals.map(v => v.toFixed(2)),
      totalPaid.toFixed(2), "", "",
    ];

    const csv = [headers, ...rows, totalsRow].map(row => row.map(v => `"${v}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `1099_summary_${year}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const generate1099 = async (rows: RecipientRow[]) => {
    if (rows.length === 0) return;
    try {
      const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
      const srcBytes = await fetch(f1099necAsset.url).then((r) => {
        if (!r.ok) throw new Error(`Couldn't load 1099-NEC form (${r.status})`);
        return r.arrayBuffer();
      });

      const out = await PDFDocument.create();
      const font = await out.embedFont(StandardFonts.Helvetica);
      const fontBold = await out.embedFont(StandardFonts.HelveticaBold);
      const black = rgb(0, 0, 0);

      // Tenant / payer info
      const payerName = tenantDetails?.legal_business_name || tenant?.name || "";
      const payerAddress = tenantDetails?.business_address || "";
      const payerPhone = tenantDetails?.business_phone || "";
      const payerEin = tenantDetails?.ein || "";

      // Split "123 Main St, City, ST 12345" into street / city / state / zip best-effort.
      const parseAddr = (full: string) => {
        const parts = full.split(",").map((s) => s.trim()).filter(Boolean);
        const street = parts[0] || "";
        const city = parts[1] || "";
        let state = "";
        let zip = "";
        if (parts[2]) {
          const m = parts[2].match(/^([A-Za-z .]+)\s+([\d-]+)$/);
          if (m) { state = m[1].trim(); zip = m[2].trim(); }
          else { state = parts[2]; }
        }
        return { street, city, state, zip };
      };
      const payer = parseAddr(payerAddress);

      // Coordinates (PDF points, origin bottom-left, page 612x792). One form per page (Copy A/B/C).
      const draw = (page: any, text: string, x: number, y: number, opts: { bold?: boolean; size?: number; maxWidth?: number } = {}) => {
        if (!text) return;
        const size = opts.size ?? 9;
        const f = opts.bold ? fontBold : font;
        let t = String(text);
        if (opts.maxWidth) {
          while (t.length > 3 && f.widthOfTextAtSize(t, size) > opts.maxWidth) t = t.slice(0, -1);
        }
        page.drawText(t, { x, y, size, font: f, color: black });
      };

      for (const r of rows) {
        const src = await PDFDocument.load(srcBytes);
        const pageCount = src.getPageCount();
        const recipientName = r.custname && r.custname !== "External check" && r.custname !== "Cash job payee"
          ? r.custname
          : r.nickname;
        const amount = r.total.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

        for (let pi = 0; pi < pageCount; pi++) {
          const page = src.getPage(pi);

          // ---- PAYER block (left column, top) ----
          draw(page, payerName, 58, 730, { bold: true, maxWidth: 235 });
          draw(page, payer.street, 58, 694, { maxWidth: 150 });
          draw(page, payer.city, 58, 670, { maxWidth: 150 });
          draw(page, payerPhone, 215, 670, { maxWidth: 90 });
          draw(page, payer.state, 58, 646, { maxWidth: 115 });
          draw(page, payer.zip, 215, 646, { maxWidth: 90 });

          // ---- Calendar year ----
          draw(page, String(year), 435, 700, { bold: true, size: 10 });

          // ---- TINs ----
          draw(page, payerEin, 58, 620, { maxWidth: 115 });
          // Recipient TIN — not captured yet, leave blank

          // ---- RECIPIENT block ----
          draw(page, recipientName, 58, 580, { bold: true, maxWidth: 235 });
          // recipient street / city / state / zip left blank (not captured)

          // ---- Box 1a: Nonemployee compensation ----
          draw(page, amount, 310, 635, { bold: true, size: 10 });

          // ---- Account number (recipient nickname as reference) ----
          draw(page, r.nickname.slice(0, 20), 58, 442, { size: 8, maxWidth: 190 });
        }

        const copied = await out.copyPages(src, src.getPageIndices());
        copied.forEach((p) => out.addPage(p));
      }

      const pdfBytes = await out.save();
      const blob = new Blob([pdfBytes as BlobPart], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = rows.length === 1
        ? `1099-NEC_${(rows[0].custname || rows[0].nickname || "recipient").replace(/[^a-z0-9]+/gi, "_")}_${year}.pdf`
        : `1099-NEC_${year}_${rows.length}_recipients.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast({
        title: `1099-NEC PDF ready`,
        description: `Filled ${rows.length} recipient${rows.length !== 1 ? "s" : ""}. Verify recipient TIN & address before filing.`,
      });
    } catch (e: any) {
      toast({ title: "Couldn't generate 1099-NEC", description: e.message, variant: "destructive" });
    }
  };





  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h3 className="text-sm font-medium">Tax & 1099 Summary</h3>
          <p className="text-xs text-muted-foreground">Recipients paid ${THRESHOLD}+ may require a 1099-NEC filing</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">Includes insurance disbursements, external checks, and cash job payments</p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
            <SelectTrigger className="h-8 text-sm w-24"><SelectValue /></SelectTrigger>
            <SelectContent>
              {YEARS.map(y => (<SelectItem key={y} value={String(y)} className="text-xs">{y}</SelectItem>))}
            </SelectContent>
          </Select>
          <Button size="sm" variant="outline" className="h-8 text-xs" onClick={exportCSV}>
            <Download className="h-3.5 w-3.5 mr-1" />Export for accountant
          </Button>
          <Button
            size="sm"
            className="h-8 text-xs"
            onClick={() => generate1099(recipients.filter(r => r.needs_1099))}
            disabled={flag1099Count === 0}
          >
            <FileText className="h-3.5 w-3.5 mr-1" />Generate {flag1099Count > 0 ? `${flag1099Count} ` : ""}1099{flag1099Count !== 1 ? "s" : ""}
          </Button>
        </div>
      </div>

      {flag1099Count > 0 && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-500 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-amber-700 dark:text-amber-300">
              {flag1099Count} recipient{flag1099Count !== 1 ? "s" : ""} may require a 1099-NEC for {year}
            </p>
            <p className="text-xs text-amber-600 dark:text-amber-400 mt-0.5">
              Any subcontractor, vendor, sales rep, appraiser, adjuster, or other unincorporated payee paid $600 or more during the tax year must receive a 1099-NEC by January 31. Share the export below with your accountant.
            </p>
          </div>
        </div>
      )}

      <Card className="border-emerald-500/30 bg-emerald-500/5">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Income vs. Disbursements — {year}</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div>
            <p className="text-[11px] text-muted-foreground">Total income (deposited checks)</p>
            <p className="text-lg font-semibold text-emerald-600">${totalIncome.toLocaleString("en-US", { minimumFractionDigits: 2 })}</p>
            <p className="text-[10px] text-muted-foreground">{depositedCount} check{depositedCount !== 1 ? "s" : ""} deposited</p>
          </div>
          <div>
            <p className="text-[11px] text-muted-foreground">Total disbursed</p>
            <p className="text-lg font-semibold">${totalPaid.toLocaleString("en-US", { minimumFractionDigits: 2 })}</p>
            <p className="text-[10px] text-muted-foreground">to subs, vendors & reps</p>
          </div>
          <div>
            <p className="text-[11px] text-muted-foreground">Net retained</p>
            <p className={`text-lg font-semibold ${netRetained >= 0 ? "text-foreground" : "text-destructive"}`}>
              ${netRetained.toLocaleString("en-US", { minimumFractionDigits: 2 })}
            </p>
            <p className="text-[10px] text-muted-foreground">income − disbursements</p>
          </div>
          <div>
            <p className="text-[11px] text-muted-foreground">Payout ratio</p>
            <p className="text-lg font-semibold">{payoutRatio.toFixed(1)}%</p>
            <p className="text-[10px] text-muted-foreground">disbursed of income</p>
          </div>
        </CardContent>
      </Card>

      {/* Monthly strip — click to filter */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Monthly disbursements — {year}</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="grid grid-cols-4 sm:grid-cols-6 lg:grid-cols-13 gap-1.5">
            {MONTH_LABELS.map((m, i) => {
              const active = monthFilter === String(i);
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMonthFilter(active ? "all" : String(i))}
                  className={`text-left rounded-md border p-2 transition-colors hover:bg-muted/40 ${active ? "border-primary bg-primary/5" : ""}`}
                >
                  <p className="text-[10px] text-muted-foreground">{m}</p>
                  <p className="text-xs font-semibold">${monthlyTotals[i].toLocaleString("en-US", { maximumFractionDigits: 0 })}</p>
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => setMonthFilter("all")}
              className={`text-left rounded-md border p-2 transition-colors hover:bg-muted/40 ${monthFilter === "all" ? "border-primary bg-primary/5" : ""}`}
            >
              <p className="text-[10px] text-muted-foreground">Year</p>
              <p className="text-xs font-semibold">${totalPaid.toLocaleString("en-US", { maximumFractionDigits: 0 })}</p>
            </button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-3 pb-3">
          <div className="flex flex-wrap gap-2 items-center">
            <div className="relative flex-1 min-w-48">
              <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
              <Input className="h-8 text-sm pl-8" placeholder="Search recipient..." value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger className="h-8 text-sm w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all" className="text-xs">All types</SelectItem>
                {Object.entries(ACCOUNT_TYPE_LABELS).map(([v, l]) => (
                  <SelectItem key={v} value={v} className="text-xs">{l}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={monthFilter} onValueChange={setMonthFilter}>
              <SelectTrigger className="h-8 text-sm w-36"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all" className="text-xs">Full year</SelectItem>
                {MONTH_LABELS.map((m, i) => (
                  <SelectItem key={m} value={String(i)} className="text-xs">{m} {year}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <div className="rounded-md border bg-muted/30 p-2.5 flex items-start gap-2">
        <Info className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0 mt-0.5" />
        <p className="text-xs text-muted-foreground">
          This summary is for reference only and is not tax advice. 1099 requirements vary based on business structure, payment method, and other factors. Consult your accountant or tax advisor before filing.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <FileText className="h-4 w-4" />
            Recipient Breakdown — {monthFilter === "all" ? year : `${MONTH_LABELS[Number(monthFilter)]} ${year}`}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 text-center text-sm text-muted-foreground">Loading...</div>
          ) : visibleRecipients.length === 0 ? (
            <div className="p-4 text-center text-sm text-muted-foreground">No settled payments found.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground">
                    <th className="text-left p-2 font-medium sticky left-0 bg-background">Recipient</th>
                    <th className="text-left p-2 font-medium hidden lg:table-cell">Type</th>
                    {monthFilter === "all" ? (
                      MONTH_LABELS.map((m) => (
                        <th key={m} className="text-right p-2 font-medium whitespace-nowrap">{m}</th>
                      ))
                    ) : (
                      <th className="text-right p-2 font-medium">{MONTH_LABELS[Number(monthFilter)]}</th>
                    )}
                    <th className="text-right p-2 font-medium">Total</th>
                    <th className="text-center p-2 font-medium">1099</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRecipients.map((r) => (
                    <tr key={r.id} className={`border-b last:border-0 hover:bg-muted/30 transition-colors ${r.needs_1099 ? "bg-amber-500/5" : ""}`}>
                      <td className="p-2 sticky left-0 bg-background">
                        <p className="font-medium text-xs">{r.nickname}</p>
                        <p className="text-[10px] text-muted-foreground">
                          {r.custname}
                          {r.chk_acct ? ` · ••••${r.chk_acct.slice(-4)}` : ""}
                        </p>
                      </td>
                      <td className="p-2 hidden lg:table-cell">
                        <Badge variant="outline" className="text-[10px]">{ACCOUNT_TYPE_LABELS[r.account_type] ?? r.account_type}</Badge>
                      </td>
                      {monthFilter === "all" ? (
                        r.monthly.map((v, i) => (
                          <td key={i} className={`p-2 text-right text-xs whitespace-nowrap ${v > 0 ? "" : "text-muted-foreground/50"}`}>
                            {v > 0 ? `$${v.toLocaleString("en-US", { minimumFractionDigits: 2 })}` : "—"}
                          </td>
                        ))
                      ) : (
                        <td className="p-2 text-right text-xs whitespace-nowrap">
                          ${(r.monthly[Number(monthFilter)] ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2 })}
                        </td>
                      )}
                      <td className="p-2 text-right">
                        <p className={`font-semibold text-sm ${r.needs_1099 ? "text-amber-600" : ""}`}>
                          ${displayedTotal(r).toLocaleString("en-US", { minimumFractionDigits: 2 })}
                        </p>
                        {r.total >= THRESHOLD * 0.8 && !r.needs_1099 && r.requires_1099 && (
                          <p className="text-[10px] text-muted-foreground">${(THRESHOLD - r.total).toFixed(2)} to threshold</p>
                        )}
                      </td>
                      <td className="p-2 text-center">
                        {r.needs_1099 ? (
                          <div className="flex flex-col items-center gap-1">
                            <div className="flex items-center justify-center gap-1">
                              <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                              <span className="text-xs text-amber-600 font-medium">Required</span>
                            </div>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-6 text-[10px] px-2"
                              onClick={() => generate1099([r])}
                            >
                              <FileText className="h-3 w-3 mr-1" />Generate
                            </Button>
                          </div>
                        ) : r.requires_1099 ? (
                          <span className="text-[10px] text-muted-foreground">Under $600</span>
                        ) : (
                          <CheckCircle2 className="h-3.5 w-3.5 text-muted-foreground mx-auto" />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t bg-muted/20 font-medium">
                    <td className="p-2 text-xs text-muted-foreground sticky left-0 bg-muted/20">
                      {visibleRecipients.length} recipient{visibleRecipients.length !== 1 ? "s" : ""}
                    </td>
                    <td className="p-2 hidden lg:table-cell" />
                    {monthFilter === "all" ? (
                      monthlyTotals.map((v, i) => (
                        <td key={i} className="p-2 text-right text-xs whitespace-nowrap">
                          ${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}
                        </td>
                      ))
                    ) : (
                      <td className="p-2 text-right text-xs whitespace-nowrap">
                        ${monthlyTotals[Number(monthFilter)].toLocaleString("en-US", { minimumFractionDigits: 2 })}
                      </td>
                    )}
                    <td className="p-2 text-right font-semibold text-sm">
                      ${(monthFilter === "all" ? totalPaid : monthlyTotals[Number(monthFilter)]).toLocaleString("en-US", { minimumFractionDigits: 2 })}
                    </td>
                    <td className="p-2" />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
