import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SectionCard } from "@/components/settings/SectionCard";
import { Loader2, Banknote, ShieldCheck } from "lucide-react";
import { toast as sonnerToast } from "sonner";
import { ConsolidatedInvoicePreview } from "@/components/billing/ConsolidatedInvoicePreview";
import {
  billingPeriodLabel,
  billingStatusLabel,
  invokeTenantBillingAdmin,
  invokeTenantBillingAuthorize,
  money,
  type TenantBillingSnapshot,
} from "@/lib/billing/tenantBilling";

type Method = {
  provider_payment_method_id: string;
  holder_name: string | null;
  last_four: string | null;
  nickname?: string | null;
  connection_status: string;
  can_send: boolean;
};

const dollarsToCents = (value: string) => Math.round(parseFloat(value || "0") * 100);

export function MonthlyTenantBillingPanel({
  tenantId,
  tenantName,
  methods = [],
  onRateSaved,
}: {
  tenantId: string;
  tenantName: string;
  methods?: Method[];
  onRateSaved?: (monthlyRateCents: number, referralDiscountCents: number) => void;
}) {
  const [data, setData] = useState<TenantBillingSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [rate, setRate] = useState("0.00");
  const [discount, setDiscount] = useState("0.00");
  const [checkRate, setCheckRate] = useState("4.00");
  const [nextDayRate, setNextDayRate] = useState("0.75");
  const [sameDayRate, setSameDayRate] = useState("1.00");
  const [mortgageInitialRate, setMortgageInitialRate] = useState("10.00");
  const [mortgageAdditionalRate, setMortgageAdditionalRate] = useState("5.00");
  const [day, setDay] = useState(1);
  const [enabled, setEnabled] = useState(false);
  const [selectedMethod, setSelectedMethod] = useState("");
  const [fundingMethods, setFundingMethods] = useState<Method[]>(methods);

  const applySnapshot = (snapshot: TenantBillingSnapshot) => {
    setData(snapshot);
    setRate(((snapshot.monthly_rate_cents || 0) / 100).toFixed(2));
    setDiscount(((snapshot.referral_discount_cents || 0) / 100).toFixed(2));
    setCheckRate(((snapshot.per_check_rate_cents || 400) / 100).toFixed(2));
    setNextDayRate(((snapshot.next_day_rate_cents ?? 75) / 100).toFixed(2));
    setSameDayRate(((snapshot.same_day_rate_cents ?? 100) / 100).toFixed(2));
    setMortgageInitialRate(((snapshot.mortgage_ops_initial_rate_cents ?? 1000) / 100).toFixed(2));
    setMortgageAdditionalRate(((snapshot.mortgage_ops_additional_rate_cents ?? 500) / 100).toFixed(2));
    setDay(snapshot.billing_day_of_month || 1);
    setEnabled(snapshot.billing_enabled === true);
    setSelectedMethod(snapshot.authorization?.provider_payment_method_id || "");
    setFundingMethods(Array.isArray(snapshot.methods) ? snapshot.methods : methods);
  };

  const load = async () => {
    setLoading(true);
    const result = await invokeTenantBillingAdmin({ action: "get", tenant_id: tenantId });
    if (!result.ok) {
      sonnerToast.error(result.error);
      setLoading(false);
      return;
    }
    applySnapshot(result.data);
    setLoading(false);
  };

  useEffect(() => { load(); }, [tenantId]);

  const save = async () => {
    setSaving(true);
    const result = await invokeTenantBillingAdmin({
      action: "update",
      tenant_id: tenantId,
      monthly_rate_cents: dollarsToCents(rate),
      referral_discount_cents: dollarsToCents(discount),
      per_check_rate_cents: dollarsToCents(checkRate),
      next_day_rate_cents: dollarsToCents(nextDayRate),
      same_day_rate_cents: dollarsToCents(sameDayRate),
      mortgage_ops_initial_rate_cents: dollarsToCents(mortgageInitialRate),
      mortgage_ops_additional_rate_cents: dollarsToCents(mortgageAdditionalRate),
      billing_enabled: enabled,
      billing_day_of_month: day,
    });
    setSaving(false);
    if (!result.ok) return sonnerToast.error(result.error);
    applySnapshot(result.data);
    onRateSaved?.(result.data.monthly_rate_cents, result.data.referral_discount_cents);
    sonnerToast.success("Monthly tenant billing saved");
  };

  const pullNow = async () => {
    setPulling(true);
    const result = await invokeTenantBillingAdmin({
      action: "pull",
      tenant_id: tenantId,
      confirm: true,
    });
    setPulling(false);
    setConfirmOpen(false);
    if (!result.ok) return sonnerToast.error(result.error);
    applySnapshot(result.data);
    const posted = (result.data as any).amount_cents_posted
      ?? (result.data.pull as any)?.occurrence?.amount_cents
      ?? result.data.pull_preview?.amount_cents;
    const status = (result.data.pull as any)?.occurrence?.status || (result.data.pull as any)?.reason;
    sonnerToast.success(`Consolidated pull ${status || "submitted"} — ${money(posted)}`);
    load();
  };

  const authorize = async () => {
    if (!selectedMethod) return sonnerToast.warning("Select an authorized tenant bank first.");
    const result = await invokeTenantBillingAuthorize({
      tenant_id: tenantId,
      provider_payment_method_id: selectedMethod,
      authorized: true,
      auto_debit_enabled: true,
    });
    if (!result.ok) return sonnerToast.error(result.error);
    sonnerToast.success("ACH authorization recorded for monthly tenant billing");
    load();
  };

  const history = data?.history || [];
  const settled = data?.settled_charges || history.filter((row) => row.status === "settled");
  const failed = data?.failed_charges || history.filter((row) => row.status === "failed");
  const returned = data?.returned_charges || history.filter((row) => row.status === "returned");
  const invoice = data?.invoice;
  const pullPreview = data?.pull_preview || invoice;

  return (
    <SectionCard
      title="Monthly tenant billing"
      icon={<Banknote className="h-4 w-4 text-sky-500" />}
      accent="bg-gradient-to-r from-sky-500 to-sky-500/30"
      description={`Consolidated ChecksOps invoice for ${tenantName}: maintenance, check processing, Next Day, Same Day, and Mortgage Ops. Instant is not offered.`}
    >
      {loading || !data ? (
        <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
      ) : (
        <div className="space-y-5">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="rounded-lg border p-3">
              <div className="text-[10px] uppercase text-muted-foreground">Current period</div>
              <div className="text-lg font-semibold">{billingPeriodLabel(data.current_period)}</div>
              <div className="text-[10px] text-muted-foreground">Collection closes {billingPeriodLabel(data.collection_period)}</div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-[10px] uppercase text-muted-foreground">Current amount due</div>
              <div className="text-lg font-semibold">{money(data.current_amount_due_cents ?? invoice?.amount_cents)}</div>
              <div className="text-[10px] text-muted-foreground">Server invoice, not a browser total</div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-[10px] uppercase text-muted-foreground">Billing</div>
              <div className="text-lg font-semibold">{data.billing_enabled ? "Enabled" : "Paused"}</div>
              <div className="text-[10px] text-muted-foreground">Day {data.billing_day_of_month} · next {data.next_billing_date || "—"}</div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-[10px] uppercase text-muted-foreground">Readiness</div>
              <div className="text-lg font-semibold">{data.readiness.ready ? "Ready" : "Not ready"}</div>
              {!data.readiness.ready && (
                <div className="text-[10px] text-destructive">{(data.readiness.reasons || []).join(", ")}</div>
              )}
            </div>
          </div>

          {invoice && (
            <ConsolidatedInvoicePreview
              invoice={invoice}
              fundingLast4={data.funding_source_last4 || data.authorization?.account_number_last4}
              destinationLabel={data.destination?.label || "ChecksOps merchant"}
            />
          )}

          <div className="grid md:grid-cols-2 gap-4">
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Monthly maintenance</Label>
                  <Input type="number" step="0.01" min="0" value={rate} onChange={(e) => setRate(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Referral discount</Label>
                  <Input type="number" step="0.01" min="0" value={discount} onChange={(e) => setDiscount(e.target.value)} />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Per-check rate</Label>
                  <Input type="number" step="0.01" min="0" value={checkRate} onChange={(e) => setCheckRate(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Next Day rate</Label>
                  <Input type="number" step="0.01" min="0" value={nextDayRate} onChange={(e) => setNextDayRate(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Same Day rate</Label>
                  <Input type="number" step="0.01" min="0" value={sameDayRate} onChange={(e) => setSameDayRate(e.target.value)} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Mortgage Ops — First Check</Label>
                  <Input type="number" step="0.01" min="0" value={mortgageInitialRate} onChange={(e) => setMortgageInitialRate(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Mortgage Ops — Additional Check</Label>
                  <Input type="number" step="0.01" min="0" value={mortgageAdditionalRate} onChange={(e) => setMortgageAdditionalRate(e.target.value)} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3 items-end">
                <div className="space-y-1">
                  <Label className="text-xs">Billing day</Label>
                  <Input type="number" min={1} max={28} value={day} onChange={(e) => setDay(Math.min(28, Math.max(1, Number(e.target.value) || 1)))} />
                </div>
                <div className="flex items-center justify-between border rounded-md px-3 py-2">
                  <Label className="text-xs">Billing enabled</Label>
                  <Switch checked={enabled} onCheckedChange={setEnabled} />
                </div>
              </div>
              <Button onClick={save} disabled={saving}>
                {saving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                Save billing rates
              </Button>
            </div>

            <div className="space-y-3">
              <div className="text-xs font-medium">Authorized tenant funding source</div>
              <select
                className="w-full h-9 rounded-md border bg-background px-3 text-sm"
                value={selectedMethod}
                onChange={(e) => setSelectedMethod(e.target.value)}
              >
                <option value="">Select connected Moov bank…</option>
                {fundingMethods.map((method) => (
                  <option key={method.provider_payment_method_id} value={method.provider_payment_method_id}>
                    {(method.nickname || method.holder_name || "Bank")} · ••••{method.last_four || "????"} · {method.connection_status}
                  </option>
                ))}
              </select>
              <div className="text-xs text-muted-foreground">
                {data.authorization?.ach_authorized_at
                  ? `ACH authorized ${new Date(data.authorization.ach_authorized_at).toLocaleString()} · auto-debit ${data.authorization.auto_debit_enabled ? "on" : "off"}`
                  : "A connected bank alone is not enough. ACH authorization is required."}
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={authorize} disabled={!selectedMethod}>
                  <ShieldCheck className="w-4 h-4 mr-1" /> Authorize ACH
                </Button>
                <Button size="sm" onClick={() => setConfirmOpen(true)} disabled={pulling || !data.readiness.ready}>
                  {pulling ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
                  Pull now
                </Button>
              </div>
              <div className="text-[11px] text-muted-foreground">
                Destination: {data.destination?.label || "ChecksOps merchant"} · {data.destination?.accountId || data.destination?.reason || "unresolved"}
              </div>
            </div>
          </div>

          {confirmOpen && pullPreview && (
            <div className="rounded-lg border border-sky-500/40 p-4 space-y-3 bg-sky-500/5">
              <div className="text-sm font-semibold">Confirm Pull Now</div>
              <ConsolidatedInvoicePreview
                invoice={pullPreview}
                title={`Pull ${billingPeriodLabel(pullPreview.billing_period)} invoice`}
                fundingLast4={data.funding_source_last4 || data.authorization?.account_number_last4}
                destinationLabel={data.destination?.label || "ChecksOps merchant"}
              />
              <div className="flex gap-2">
                <Button onClick={pullNow} disabled={pulling}>
                  {pulling && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                  Collect {money(pullPreview.amount_cents)}
                </Button>
                <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={pulling}>Cancel</Button>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
            <div>Last collection: {data.last_charge ? `${money(data.last_charge.amount_cents)} · ${billingStatusLabel(data.last_charge.status)}` : "—"}</div>
            <div>Pending collection: {data.pending_charge ? `${money(data.pending_charge.amount_cents)} · ${billingStatusLabel(data.pending_charge.status)}` : "None"}</div>
            <div>Settled: {settled.length}</div>
            <div>Failed / returned: {failed.length} / {returned.length}</div>
          </div>

          {invoice?.allocations && invoice.allocations.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold mb-2">Invoice allocations</h4>
              <div className="border rounded-md divide-y max-h-40 overflow-y-auto">
                {invoice.allocations.map((row, index) => (
                  <div key={`${row.source_id}-${index}`} className="flex items-center justify-between px-3 py-2 text-xs">
                    <div>
                      <div className="font-medium">{row.fee_type.replace(/_/g, " ")}</div>
                      <div className="text-muted-foreground font-mono">{String(row.source_id).slice(0, 8)}</div>
                    </div>
                    <div>{money(row.amount_cents)}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div>
            <h4 className="text-sm font-semibold mb-2">Collection history</h4>
            {history.length === 0 ? (
              <div className="text-xs text-muted-foreground italic">No monthly collections yet.</div>
            ) : (
              <div className="border rounded-md divide-y max-h-56 overflow-y-auto">
                {history.map((row) => (
                  <div key={row.id} className="flex items-center justify-between px-3 py-2 text-xs">
                    <div>
                      <div className="font-medium">{row.billing_period || "legacy / no period"} · {money(row.amount_cents)}</div>
                      <div className="text-muted-foreground">
                        maintenance {money(row.monthly_rate_cents)} · discount {money(row.discount_cents)}
                        {row.check_usage_cents != null ? ` · checks ${money(row.check_usage_cents)}` : ""}
                        {row.next_day_usage_cents != null ? ` · next day ${money(row.next_day_usage_cents)}` : ""}
                        {row.same_day_usage_cents != null ? ` · same day ${money(row.same_day_usage_cents)}` : ""}
                        {row.mortgage_ops_initial_amount_cents != null || row.mortgage_ops_additional_amount_cents != null
                          ? ` · mortgage ${money((row.mortgage_ops_initial_amount_cents || 0) + (row.mortgage_ops_additional_amount_cents || 0))}`
                          : ""}
                        {data.authorization?.account_number_last4
                          ? ` · source ••••${data.authorization.account_number_last4}`
                          : ""}
                        {row.provider_transfer_id
                          ? ` · ${String(row.provider_transfer_id).startsWith("sim:") ? "simulated" : "moov"} ${row.provider_transfer_id}`
                          : ""}
                      </div>
                    </div>
                    <Badge variant="outline">{billingStatusLabel(row.status)}</Badge>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </SectionCard>
  );
}
