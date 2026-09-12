import { useState, useMemo, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenant } from "@/contexts/TenantContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertTriangle, Download, FileText, CheckCircle2, Info, Search, Pencil } from "lucide-react";
import { startOfYear, endOfYear, getYear } from "date-fns";
import { toast } from "@/hooks/use-toast";
import {
  ACCOUNT_TYPE_LABELS,
  LEGACY_INFORMATIONAL_THRESHOLD,
  MONTH_LABELS,
  aggregateRecipientRows,
  buildPaymentReportingCsv,
  type RecipientRow,
} from "@/lib/taxYtdSummary";
import {
  taxProfileMutationVariables,
  type TaxProfileMutationVariables,
} from "@/lib/taxProfileMutation";

type TaxProfile = {
  recipient_key: string;
  recipient_name: string | null;
  tin_on_file: boolean;
  tin_last_4: string | null;
  tin_type: string | null;
  address_street: string | null;
  address_city: string | null;
  address_state: string | null;
  address_zip: string | null;
  account_number: string | null;
  notes: string | null;
};

type ProfileForm = TaxProfileMutationVariables;

const EMPTY_FORM: ProfileForm = {
  recipient_key: "",
  recipient_name: "",
  address_street: "",
  address_city: "",
  address_state: "",
  address_zip: "",
  account_number: "",
  notes: "",
};

const CURRENT_YEAR = getYear(new Date());
const YEARS = [CURRENT_YEAR, CURRENT_YEAR - 1, CURRENT_YEAR - 2];

function invokeErrorMessage(error: { message?: string } | null, data: unknown): string {
  const payload = data && typeof data === "object" ? data as { error?: string; message?: string } : null;
  return String(payload?.error || payload?.message || error?.message || "request_failed");
}

export function TaxSummary() {
  const { tenant } = useTenant();
  const [year, setYear] = useState(CURRENT_YEAR);
  const [monthFilter, setMonthFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [editing, setEditing] = useState<{ key: string; name: string } | null>(null);
  const [form, setForm] = useState<ProfileForm>(EMPTY_FORM);
  const tinInputRef = useRef<HTMLInputElement>(null);
  const pendingTinRef = useRef("");
  const queryClient = useQueryClient();

  const { data: taxProfiles = [] } = useQuery({
    queryKey: ["recipient-tax-profiles", tenant?.id],
    enabled: !!tenant?.id,
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke("tenant-tax-profiles", {
        body: { action: "list", tenant_id: tenant!.id },
      });
      if (error || data?.ok === false) {
        throw new Error(invokeErrorMessage(error, data));
      }
      return (data?.profiles ?? []) as TaxProfile[];
    },
  });

  const profileByKey = useMemo(() => {
    const m: Record<string, TaxProfile> = {};
    for (const p of taxProfiles) m[p.recipient_key] = p;
    return m;
  }, [taxProfiles]);

  const clearTinInput = () => {
    pendingTinRef.current = "";
    if (tinInputRef.current) tinInputRef.current.value = "";
  };

  const saveProfile = useMutation({
    mutationFn: async (p: TaxProfileMutationVariables) => {
      const tin = pendingTinRef.current;
      pendingTinRef.current = "";
      const body: Record<string, unknown> = {
        action: "upsert",
        tenant_id: tenant!.id,
        ...taxProfileMutationVariables(p),
      };
      if (tin) body.tin = tin;
      try {
        const { data, error } = await supabase.functions.invoke("tenant-tax-profiles", { body });
        if (error || data?.ok === false) {
          throw new Error(invokeErrorMessage(error, data));
        }
        return data?.profile as TaxProfile;
      } finally {
        clearTinInput();
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["recipient-tax-profiles", tenant?.id] });
      toast({ title: "Recipient tax info saved" });
      clearTinInput();
      setEditing(null);
    },
    onError: (e: Error) => {
      clearTinInput();
      toast({ title: "Save failed", description: e.message, variant: "destructive" });
    },
  });

  const closeEditor = () => {
    clearTinInput();
    setEditing(null);
  };

  const submitProfile = () => {
    pendingTinRef.current = tinInputRef.current?.value?.trim() ?? "";
    if (tinInputRef.current) tinInputRef.current.value = "";
    saveProfile.mutate(taxProfileMutationVariables(form));
  };

  const openEdit = (key: string, defaultName: string) => {
    const existing = profileByKey[key];
    clearTinInput();
    setEditing({ key, name: defaultName });
    setForm({
      recipient_key: key,
      recipient_name: existing?.recipient_name ?? defaultName,
      address_street: existing?.address_street ?? "",
      address_city: existing?.address_city ?? "",
      address_state: existing?.address_state ?? "",
      address_zip: existing?.address_zip ?? "",
      account_number: existing?.account_number ?? "",
      notes: existing?.notes ?? "",
    });
  };

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

  const recipients: RecipientRow[] = useMemo(
    () => aggregateRecipientRows({ payments: payments as any[], cashPayments: cashPayments as any[], year }),
    [payments, cashPayments, year],
  );

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
  const totalIncome = (depositedChecks as any[]).reduce((s, c) => s + Number(c.amount ?? 0), 0);
  const depositedCount = (depositedChecks as any[]).length;
  const netRetained = totalIncome - totalPaid;
  const payoutRatio = totalIncome > 0 ? (totalPaid / totalIncome) * 100 : 0;

  const monthlyTotals = useMemo(() => {
    const t = Array(12).fill(0);
    for (const r of recipients) for (let i = 0; i < 12; i++) t[i] += r.monthly[i];
    return t;
  }, [recipients]);

  const exportCSV = () => {
    const csv = buildPaymentReportingCsv({
      year,
      recipients: visibleRecipients,
      monthlyTotals,
      totalPaid,
    });
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `payment_reporting_summary_${year}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const tinStatusLabel = (r: RecipientRow) => {
    const profile = profileByKey[r.id];
    if (profile?.tin_on_file && profile.tin_last_4) return `On file ••••${profile.tin_last_4}`;
    if (profile?.tin_on_file) return "On file";
    return "No TIN on file";
  };

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-border bg-muted/20 p-3 space-y-2">
        <p className="text-sm font-medium">ChecksOps does not file tax forms with the IRS.</p>
        <ul className="text-xs text-muted-foreground space-y-1 list-disc pl-4">
          <li>
            <span className="font-medium text-foreground">Payment reporting summary</span>
            {" "}— year-to-date amounts paid to recipients. Informational only.
          </li>
          <li>
            <span className="font-medium text-foreground">Recipient tax-profile collection</span>
            {" "}— authorized finance users can store recipient contact details and a TIN. The TIN is never shown in full after save.
          </li>
          <li>
            <span className="font-medium text-foreground">1099-NEC responsibility</span>
            {" "}— the tenant and their accountant determine whether a 1099-NEC is required and file it. ChecksOps does not submit 1099-NEC forms.
          </li>
          <li>
            <span className="font-medium text-foreground">1099-K / payment-processor responsibility</span>
            {" "}— card or wallet processors (including Moov, when used) are responsible for any 1099-K they are required to file. ChecksOps does not file 1099-K.
          </li>
        </ul>
      </div>

      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h3 className="text-sm font-medium">Payment reporting summary</h3>
          <p className="text-xs text-muted-foreground">
            Recipients at or above the legacy ${LEGACY_INFORMATIONAL_THRESHOLD} informational flag are highlighted.
            This is not a filing determination.
          </p>
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
            <Download className="h-3.5 w-3.5 mr-1" />Export payment summary
          </Button>
          <Button
            size="sm"
            className="h-8 text-xs"
            disabled
            title="Secure tax-form generation coming soon"
          >
            <FileText className="h-3.5 w-3.5 mr-1" />Secure tax-form generation coming soon
          </Button>
        </div>
      </div>

      {flag1099Count > 0 && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-500 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-amber-700 dark:text-amber-300">
              {flag1099Count} recipient{flag1099Count !== 1 ? "s" : ""} meet the legacy ${LEGACY_INFORMATIONAL_THRESHOLD} informational flag for {year}
            </p>
            <p className="text-xs text-amber-600 dark:text-amber-400 mt-0.5">
              This flag is retained from the previous summary view. It is not a filing determination and does not mean ChecksOps will generate or submit a 1099. Share the payment summary with your accountant if they need it.
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
          This summary is for reference only and is not tax advice. Filing obligations depend on facts your accountant must evaluate. ChecksOps does not generate IRS-ready 1099 PDFs in the browser.
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
                    <th className="text-center p-2 font-medium">Profile</th>
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
                        {r.total >= LEGACY_INFORMATIONAL_THRESHOLD * 0.8 && !r.needs_1099 && r.requires_1099 && (
                          <p className="text-[10px] text-muted-foreground">${(LEGACY_INFORMATIONAL_THRESHOLD - r.total).toFixed(2)} to legacy flag</p>
                        )}
                      </td>
                      <td className="p-2 text-center">
                        {r.requires_1099 ? (
                          <div className="flex flex-col items-center gap-1">
                            <span className="text-[10px] text-muted-foreground">{tinStatusLabel(r)}</span>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-6 text-[10px] px-2"
                              onClick={() => openEdit(r.id, r.custname && r.custname !== "External check" && r.custname !== "Cash job payee" ? r.custname : r.nickname)}
                            >
                              <Pencil className="h-3 w-3 mr-1" />Tax info
                            </Button>
                            <span className="text-[10px] text-muted-foreground">Secure tax-form generation coming soon</span>
                          </div>
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

      <Dialog open={!!editing} onOpenChange={(o) => !o && closeEditor()}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Recipient tax profile</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3">
            <div>
              <Label className="text-xs">Recipient name</Label>
              <Input value={form.recipient_name} onChange={(e) => setForm({ ...form, recipient_name: e.target.value })} />
            </div>
            <div>
              <Label className="text-xs">TIN / EIN (replace only)</Label>
              <p className="text-[11px] text-muted-foreground mb-1">
                {profileByKey[editing?.key ?? ""]?.tin_on_file
                  ? `On file ••••${profileByKey[editing?.key ?? ""]?.tin_last_4 ?? "••••"}. Leave blank to keep the stored value.`
                  : "No TIN on file. Enter a value only if you intend to store one."}
              </p>
              <Input
                ref={tinInputRef}
                type="password"
                autoComplete="off"
                name="tax-tin-replace"
                defaultValue=""
                placeholder="Leave blank to keep existing"
              />
            </div>
            <div>
              <Label className="text-xs">Street address</Label>
              <Input value={form.address_street} onChange={(e) => setForm({ ...form, address_street: e.target.value })} />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <div className="col-span-1">
                <Label className="text-xs">City</Label>
                <Input value={form.address_city} onChange={(e) => setForm({ ...form, address_city: e.target.value })} />
              </div>
              <div>
                <Label className="text-xs">State</Label>
                <Input value={form.address_state} maxLength={2} onChange={(e) => setForm({ ...form, address_state: e.target.value.toUpperCase() })} />
              </div>
              <div>
                <Label className="text-xs">ZIP</Label>
                <Input value={form.address_zip} onChange={(e) => setForm({ ...form, address_zip: e.target.value })} />
              </div>
            </div>
            <div>
              <Label className="text-xs">Account number (optional)</Label>
              <Input value={form.account_number} onChange={(e) => setForm({ ...form, account_number: e.target.value })} />
            </div>
            <div>
              <Label className="text-xs">Notes (optional)</Label>
              <Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeEditor}>Cancel</Button>
            <Button onClick={submitProfile} disabled={saveProfile.isPending}>
              {saveProfile.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
