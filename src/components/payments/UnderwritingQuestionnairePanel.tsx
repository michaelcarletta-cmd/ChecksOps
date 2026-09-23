import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ClipboardList, Loader2, Save } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/aws/client";

interface Answers {
  averageTransactionSize: string;
  maxTransactionSize: string;
  averageMonthlyTransactionVolume: string;
  businessToBusinessPercentage: string;
  consumerToBusinessPercentage: string;
  hasPhysicalGoods: boolean;
  isShippingProduct: boolean;
  shipmentDurationDays: string;
  returnPolicy: string;
}

const EMPTY: Answers = {
  averageTransactionSize: "",
  maxTransactionSize: "",
  averageMonthlyTransactionVolume: "",
  businessToBusinessPercentage: "50",
  consumerToBusinessPercentage: "50",
  hasPhysicalGoods: false,
  isShippingProduct: false,
  shipmentDurationDays: "0",
  returnPolicy: "none",
};

const RETURN_POLICIES = [
  { value: "none", label: "No returns" },
  { value: "exchangeOnly", label: "Exchange only" },
  { value: "withinThirtyDays", label: "Within 30 days" },
  { value: "other", label: "Other" },
];

async function invoke(fn: string, body: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke(fn, { body });
  if (error) {
    let message = error.message ?? "Request failed";
    try {
      const parsed = await (error as any).context?.json?.();
      if (parsed?.error) message = parsed.error;
    } catch { /* keep original */ }
    throw new Error(message);
  }
  if ((data as any)?.error) throw new Error((data as any).error);
  return data as any;
}

const fromCents = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) ? String(Math.round(v / 100)) : "";

/**
 * Expected-activity questions the payment provider asks before an
 * organization can move money. Answers are written straight to the provider,
 * so the tenant never has to complete them outside ChecksOps.
 */
export function UnderwritingQuestionnairePanel({ tenantId }: { tenantId?: string | null }) {
  const { toast } = useToast();
  const [answers, setAnswers] = useState<Answers>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [onFile, setOnFile] = useState(false);

  const set = (patch: Partial<Answers>) => setAnswers((a) => ({ ...a, ...patch }));

  const load = useCallback(async () => {
    if (!tenantId) return;
    setLoading(true);
    try {
      const res = await invoke("moov-underwriting", { tenant_id: tenantId, action: "get" });
      const u = res?.underwriting;
      if (u) {
        setOnFile(true);
        const vol = u.volumeByCustomerType ?? u.volumeShareByCustomerType ?? {};
        setAnswers({
          averageTransactionSize: fromCents(u.averageTransactionSize),
          maxTransactionSize: fromCents(u.maxTransactionSize),
          averageMonthlyTransactionVolume: fromCents(u.averageMonthlyTransactionVolume),
          businessToBusinessPercentage: String(vol.businessToBusinessPercentage ?? 50),
          consumerToBusinessPercentage: String(vol.consumerToBusinessPercentage ?? 50),
          hasPhysicalGoods: !!u.fulfillment?.hasPhysicalGoods,
          isShippingProduct: !!u.fulfillment?.isShippingProduct,
          shipmentDurationDays: String(u.fulfillment?.shipmentDurationDays ?? 0),
          returnPolicy: u.fulfillment?.returnPolicy ?? "none",
        });
      }
    } catch {
      /* Nothing on file yet — the blank form is the correct state. */
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => { void load(); }, [load]);

  async function handleSave() {
    if (!tenantId) return;
    setSaving(true);
    try {
      await invoke("moov-underwriting", { tenant_id: tenantId, action: "save", answers });
      setOnFile(true);
      toast({ title: "Answers submitted", description: "Your expected activity was sent to the payment provider." });
    } catch (e: any) {
      toast({ title: "Couldn't submit answers", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  if (!tenantId) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="text-sm flex items-center gap-2">
              <ClipboardList className="h-4 w-4 text-primary" />
              Expected Payment Activity
            </CardTitle>
            <CardDescription className="text-xs mt-1">
              A few questions about how you'll use payments. Answers go straight to our payment
              provider — you don't need to fill anything out anywhere else.
            </CardDescription>
          </div>
          {onFile && (
            <Badge variant="outline" className="text-[10px] border-emerald-500/40 text-emerald-500 shrink-0">
              On file
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="text-xs text-muted-foreground flex items-center gap-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading your answers…
          </div>
        ) : null}

        <div className="grid sm:grid-cols-3 gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Average payment ($)</Label>
            <Input
              inputMode="numeric"
              value={answers.averageTransactionSize}
              onChange={(e) => set({ averageTransactionSize: e.target.value.replace(/\D/g, "") })}
              placeholder="5000"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Largest payment ($)</Label>
            <Input
              inputMode="numeric"
              value={answers.maxTransactionSize}
              onChange={(e) => set({ maxTransactionSize: e.target.value.replace(/\D/g, "") })}
              placeholder="50000"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Monthly volume ($)</Label>
            <Input
              inputMode="numeric"
              value={answers.averageMonthlyTransactionVolume}
              onChange={(e) => set({ averageMonthlyTransactionVolume: e.target.value.replace(/\D/g, "") })}
              placeholder="250000"
            />
          </div>
        </div>

        <div className="grid sm:grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Volume with business customers (%)</Label>
            <Input
              inputMode="numeric"
              value={answers.businessToBusinessPercentage}
              onChange={(e) => {
                const v = e.target.value.replace(/\D/g, "").slice(0, 3);
                const n = Math.min(100, Number(v || 0));
                set({
                  businessToBusinessPercentage: v === "" ? "" : String(n),
                  consumerToBusinessPercentage: String(100 - n),
                });
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Volume with consumers (%)</Label>
            <Input value={answers.consumerToBusinessPercentage} readOnly className="bg-muted/40" />
          </div>
        </div>

        <div className="space-y-2 rounded-md border border-border p-3">
          <div className="flex items-center justify-between">
            <Label className="text-xs">We sell or deliver physical goods</Label>
            <Switch
              checked={answers.hasPhysicalGoods}
              onCheckedChange={(v) => set({ hasPhysicalGoods: v, isShippingProduct: v ? answers.isShippingProduct : false })}
            />
          </div>
          {answers.hasPhysicalGoods && (
            <>
              <div className="flex items-center justify-between">
                <Label className="text-xs">We ship products to customers</Label>
                <Switch
                  checked={answers.isShippingProduct}
                  onCheckedChange={(v) => set({ isShippingProduct: v })}
                />
              </div>
              <div className="grid sm:grid-cols-2 gap-3 pt-1">
                <div className="space-y-1.5">
                  <Label className="text-xs">Typical delivery time (days)</Label>
                  <Input
                    inputMode="numeric"
                    value={answers.shipmentDurationDays}
                    onChange={(e) => set({ shipmentDurationDays: e.target.value.replace(/\D/g, "") })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Return policy</Label>
                  <Select value={answers.returnPolicy} onValueChange={(v) => set({ returnPolicy: v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {RETURN_POLICIES.map((r) => (
                        <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </>
          )}
        </div>

        <Button size="sm" className="h-8 text-xs" onClick={handleSave} disabled={saving}>
          {saving
            ? <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Submitting…</>
            : <><Save className="h-3.5 w-3.5 mr-1.5" /> {onFile ? "Update answers" : "Submit answers"}</>}
        </Button>
      </CardContent>
    </Card>
  );
}
