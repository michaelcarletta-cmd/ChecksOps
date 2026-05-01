import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Settings2, Save, RotateCcw } from "lucide-react";
import { useState, useEffect } from "react";
import { toast } from "sonner";

interface BillingConfig {
  id: string;
  price_per_check_cents: number;
  currency: string;
  stripe_meter_event_name: string;
  active: boolean;
}

export function BillingConfigPanel() {
  const qc = useQueryClient();
  const [priceDollars, setPriceDollars] = useState("");
  const [meterName, setMeterName] = useState("");

  const { data: config, isLoading } = useQuery({
    queryKey: ["check-billing-config"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("check_billing_config")
        .select("*")
        .eq("active", true)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data as BillingConfig | null;
    },
  });

  useEffect(() => {
    if (config) {
      setPriceDollars((config.price_per_check_cents / 100).toFixed(2));
      setMeterName(config.stripe_meter_event_name);
    }
  }, [config]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!config) throw new Error("Config not loaded");
      const cents = Math.round(parseFloat(priceDollars) * 100);
      if (!Number.isFinite(cents) || cents < 0) throw new Error("Invalid price");
      const { error } = await supabase
        .from("check_billing_config")
        .update({
          price_per_check_cents: cents,
          stripe_meter_event_name: meterName.trim() || "checks_processed",
        })
        .eq("id", config.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Billing config saved");
      qc.invalidateQueries({ queryKey: ["check-billing-config"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Save failed"),
  });

  const backfillMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("backfill_check_billing_events");
      if (error) throw error;
      return data as { inserted: number };
    },
    onSuccess: (r) => toast.success(`Backfilled ${r.inserted} historical events`),
    onError: (e: any) => toast.error(e?.message ?? "Backfill failed"),
  });

  const reportMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("report-check-usage-to-stripe");
      if (error) throw error;
      return data;
    },
    onSuccess: (r: any) => toast.success(`Reported ${r?.succeeded ?? 0}, failed ${r?.failed ?? 0}`),
    onError: (e: any) => toast.error(e?.message ?? "Report failed"),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Settings2 className="h-4 w-4" />
          Per-Check Billing
        </CardTitle>
        <CardDescription>
          Flat fee charged to every tenant for each check that reaches deposited status. Reported to Stripe as metered usage.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="price">Price per check (USD)</Label>
            <Input
              id="price"
              type="number"
              step="0.01"
              min="0"
              value={priceDollars}
              onChange={(e) => setPriceDollars(e.target.value)}
              disabled={isLoading}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="meter">Stripe meter event name</Label>
            <Input
              id="meter"
              value={meterName}
              onChange={(e) => setMeterName(e.target.value)}
              placeholder="checks_processed"
              disabled={isLoading}
            />
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending} size="sm">
            <Save className="h-3.5 w-3.5 mr-1.5" />
            Save
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => backfillMutation.mutate()}
            disabled={backfillMutation.isPending}
          >
            <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
            Backfill historical
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => reportMutation.mutate()}
            disabled={reportMutation.isPending}
          >
            Report now to Stripe
          </Button>
        </div>

        <div className="rounded-md bg-muted/40 p-3 text-xs space-y-1 text-muted-foreground">
          <p><strong className="text-foreground">Stripe setup required:</strong></p>
          <ol className="list-decimal list-inside space-y-0.5">
            <li>In Stripe → Billing → Meters, create a meter named <code className="text-foreground">{meterName || "checks_processed"}</code>, customer mapping: <code className="text-foreground">stripe_customer_id</code>, value: <code className="text-foreground">value</code> (sum).</li>
            <li>Create a metered Price tied to that meter (e.g. ${priceDollars || "3.00"} / unit).</li>
            <li>Subscribe each tenant to that price (link via their <code className="text-foreground">stripe_customer_id</code>).</li>
            <li>Stripe automatically invoices each tenant at their billing cycle end.</li>
          </ol>
        </div>
      </CardContent>
    </Card>
  );
}
