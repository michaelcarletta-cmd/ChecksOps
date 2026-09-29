import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SectionCard } from "@/components/settings/SectionCard";
import { Loader2, Banknote, ShieldCheck } from "lucide-react";
import { toast as sonnerToast } from "sonner";
import {
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
  const [rate, setRate] = useState("0.00");
  const [discount, setDiscount] = useState("0.00");
  const [day, setDay] = useState(1);
  const [enabled, setEnabled] = useState(false);
  const [selectedMethod, setSelectedMethod] = useState("");
  const [fundingMethods, setFundingMethods] = useState<Method[]>(methods);

  const load = async () => {
    setLoading(true);
    const result = await invokeTenantBillingAdmin({ action: "get", tenant_id: tenantId });
    if (!result.ok) {
      sonnerToast.error(result.error);
      setLoading(false);
      return;
    }
    setData(result.data);
    setRate(((result.data.monthly_rate_cents || 0) / 100).toFixed(2));
    setDiscount(((result.data.referral_discount_cents || 0) / 100).toFixed(2));
    setDay(result.data.billing_day_of_month || 1);
    setEnabled(result.data.billing_enabled === true);
    setSelectedMethod(result.data.authorization?.provider_payment_method_id || "");
    setFundingMethods(Array.isArray(result.data.methods) ? result.data.methods : methods);
    setLoading(false);
  };

  useEffect(() => { load(); }, [tenantId]);

  const save = async () => {
    setSaving(true);
    const result = await invokeTenantBillingAdmin({
      action: "update",
      tenant_id: tenantId,
      monthly_rate_cents: Math.round(parseFloat(rate || "0") * 100),
      referral_discount_cents: Math.round(parseFloat(discount || "0") * 100),
      billing_enabled: enabled,
      billing_day_of_month: day,
    });
    setSaving(false);
    if (!result.ok) return sonnerToast.error(result.error);
    setData(result.data);
    onRateSaved?.(result.data.monthly_rate_cents, result.data.referral_discount_cents);
    sonnerToast.success("Monthly subscription billing saved");
  };

  const pullNow = async () => {
    setPulling(true);
    const result = await invokeTenantBillingAdmin({ action: "pull", tenant_id: tenantId });
    setPulling(false);
    if (!result.ok) return sonnerToast.error(result.error);
    setData(result.data);
    const status = (result.data.pull as any)?.occurrence?.status || (result.data.pull as any)?.reason;
    sonnerToast.success(`Monthly pull ${status || "submitted"} — ${money(result.data.net_fee_cents)}`);
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
    sonnerToast.success("ACH authorization recorded for monthly subscription billing");
    load();
  };

  const history = data?.history || [];
  const settled = history.filter((row) => row.status === "settled");
  const failed = history.filter((row) => row.status === "failed");
  const returned = history.filter((row) => row.status === "returned");

  return (
    <SectionCard
      title="Monthly subscription billing"
      icon={<Banknote className="h-4 w-4 text-sky-500" />}
      accent="bg-gradient-to-r from-sky-500 to-sky-500/30"
      description={`ChecksOps platform subscription for ${tenantName}. Separate from insurance check processing and disbursement.`}
    >
      {loading || !data ? (
        <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
      ) : (
        <div className="space-y-5">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="rounded-lg border p-3">
              <div className="text-[10px] uppercase text-muted-foreground">Monthly fee</div>
              <div className="text-lg font-semibold">{money(data.monthly_rate_cents)}</div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-[10px] uppercase text-muted-foreground">Discount / net</div>
              <div className="text-lg font-semibold">{money(data.referral_discount_cents)} / {money(data.net_fee_cents)}</div>
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

          <div className="grid md:grid-cols-2 gap-4">
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Monthly rate</Label>
                  <Input type="number" step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Referral discount</Label>
                  <Input type="number" step="0.01" value={discount} onChange={(e) => setDiscount(e.target.value)} />
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
                Save subscription billing
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
                <Button size="sm" onClick={pullNow} disabled={pulling || !data.readiness.ready}>
                  {pulling ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
                  Pull now
                </Button>
              </div>
              <div className="text-[11px] text-muted-foreground">
                Destination: {data.destination?.label || "ChecksOps merchant"} · {data.destination?.accountId || data.destination?.reason || "unresolved"}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
            <div>Last charge: {data.last_charge ? `${money(data.last_charge.amount_cents)} · ${billingStatusLabel(data.last_charge.status)}` : "—"}</div>
            <div>Current / pending: {data.pending_charge ? `${money(data.pending_charge.amount_cents)} · ${billingStatusLabel(data.pending_charge.status)}` : "None"}</div>
            <div>Settled: {settled.length}</div>
            <div>Failed / returned: {failed.length} / {returned.length}</div>
          </div>

          <div>
            <h4 className="text-sm font-semibold mb-2">Subscription billing history</h4>
            {history.length === 0 ? (
              <div className="text-xs text-muted-foreground italic">No monthly subscription charges yet.</div>
            ) : (
              <div className="border rounded-md divide-y max-h-56 overflow-y-auto">
                {history.map((row) => (
                  <div key={row.id} className="flex items-center justify-between px-3 py-2 text-xs">
                    <div>
                      <div className="font-medium">{row.billing_period || "period"} · {money(row.amount_cents)}</div>
                      <div className="text-muted-foreground">
                        rate {money(row.monthly_rate_cents)} · discount {money(row.discount_cents)}
                        {data.authorization?.account_number_last4
                          ? ` · source ••••${data.authorization.account_number_last4}`
                          : ""}
                        {row.destination_account_id
                          ? ` · dest ${String(row.destination_account_id).slice(0, 8)}`
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
