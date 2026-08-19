import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useTenant } from "@/contexts/TenantContext";
import { useToast } from "@/hooks/use-toast";
import { CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Gift, Copy, CheckCircle2, Users,
  TrendingUp, Star
} from "lucide-react";
import { format } from "date-fns";
import { SettingsHero } from "./SettingsHero";
import { SectionCard } from "./SectionCard";

type ReferralResponse = {
  success: boolean;
  message?: string;
  error?: string;
};

export function ReferralSettings() {
  const { user } = useAuth();
  const { tenant } = useTenant();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [referralCodeInput, setReferralCodeInput] = useState("");

  const { data: tenantData } = useQuery({
    queryKey: ["tenant-referral", tenant?.id],
    enabled: !!tenant?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenants")
        .select("id, name, referral_code, referral_discount_cents, referred_by_tenant_id, is_founding_partner, monthly_rate_cents")
        .eq("id", tenant!.id)
        .single();
      if (error) throw error;
      return data;
    },
  });

  const { data: referralEvents = [] } = useQuery({
    queryKey: ["referral-events", tenant?.id],
    enabled: !!tenant?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenants")
        .select("id, name, created_at, referral_discount_cents")
        .eq("referred_by_tenant_id", tenant!.id)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []).map((t: any) => ({
        id: t.id,
        status: "active",
        created_at: t.created_at,
        discount_applied_cents: t.referral_discount_cents || 500,
        referred_tenants: { name: t.name },
      }));
    },
  });

  const applyReferralCode = useMutation({
    mutationFn: async () => {
      if (!referralCodeInput.trim()) throw new Error("Enter a referral code");
      const { data, error } = await supabase.rpc("apply_referral_code", {
        p_referring_code: referralCodeInput.trim().toUpperCase(),
        p_new_tenant_id: tenant!.id,
        p_new_user_id: user!.id,
      }) as { data: ReferralResponse | null, error: any };
      if (error) throw error;
      if (!data?.success) throw new Error(data?.error ?? "Failed to apply code");
      return data;
    },
    onSuccess: (data) => {
      toast({ title: "Success!", description: data.message || "Referral code applied successfully." });
      setReferralCodeInput("");
      qc.invalidateQueries({ queryKey: ["tenant-referral"] });
      qc.invalidateQueries({ queryKey: ["referral-events"] });
    },
    onError: (error: any) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const copyToClipboard = () => {
    if (tenantData?.referral_code) {
      navigator.clipboard.writeText(tenantData.referral_code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast({ title: "Copied!", description: "Your referral code is ready to share." });
    }
  };

  const discountAmount = (tenantData?.referral_discount_cents || 0) / 100;
  const maxDiscount = 25;
  const progressPercent = Math.min((discountAmount / maxDiscount) * 100, 100);
  const activeReferralsCount = referralEvents.filter((e: any) => e.status === "active").length;

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <SettingsHero
        title="Refer & Earn"
        description="Share the ChecksOps experience with other firms and earn monthly subscription discounts."
        badge="Rewards"
        icon={<Gift className="h-4 w-4 text-primary" />}
      />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <SectionCard
          title="Share your code"
          accent="bg-gradient-to-r from-primary/60 to-primary/10"
          icon={<Gift className="h-4 w-4 text-primary" />}
        >
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Invite other adjusting firms to ChecksOps. Both get <span className="font-bold text-foreground">$5 off monthly subscription</span>.
            </p>
            <div className="space-y-2">
              <Label className="text-xs uppercase tracking-wider text-muted-foreground font-bold">Your Referral Code</Label>
              <div className="flex gap-2">
                <Input value={tenantData?.referral_code || "Generating..."} readOnly className="bg-muted/50 font-mono text-lg tracking-wider text-center h-12" />
                <Button onClick={copyToClipboard} variant={copied ? "outline" : "default"} className="h-12 px-6">
                  {copied ? <CheckCircle2 className="h-5 w-5" /> : <Copy className="h-5 w-5" />}
                </Button>
              </div>
            </div>
            <div className="bg-primary/5 rounded-lg p-4 space-y-3">
              <div className="flex justify-between items-end">
                <div className="space-y-1">
                  <span className="text-xs font-medium text-muted-foreground uppercase">Monthly Savings</span>
                  <div className="text-2xl font-bold text-primary">${discountAmount.toFixed(2)} / mo</div>
                </div>
              </div>
              <div className="h-2 w-full bg-primary/10 rounded-full overflow-hidden">
                <div className="h-full bg-primary transition-all duration-500 ease-out" style={{ width: `${progressPercent}%` }} />
              </div>
            </div>
          </CardContent>
        </SectionCard>

        <SectionCard
          title="Redeem a code"
          accent="bg-gradient-to-r from-emerald-500/60 to-emerald-500/10"
          icon={<Gift className="h-4 w-4 text-emerald-500" />}
        >
          <CardContent className="space-y-4">
            {tenantData?.referred_by_tenant_id ? (
              <div className="bg-green-50 border border-green-100 rounded-lg p-6 text-center space-y-3">
                <h4 className="font-bold text-green-800">Referral Applied!</h4>
                <Badge variant="outline" className="bg-white border-green-200 text-green-600">CODE REDEEMED</Badge>
              </div>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">Enter code for <span className="font-bold text-foreground">$5/mo discount</span>.</p>
                <div className="space-y-3 pt-2">
                  <Input placeholder="ENTER-CODE-HERE" value={referralCodeInput} onChange={(e) => setReferralCodeInput(e.target.value)} className="font-mono uppercase h-11" />
                  <Button className="w-full h-11 font-bold" onClick={() => applyReferralCode.mutate()} disabled={applyReferralCode.isPending || !referralCodeInput.trim()}>
                    {applyReferralCode.isPending ? "Applying..." : "Apply Discount"}
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </SectionCard>
      </div>

      <SectionCard
        title="Referral History"
        accent="bg-gradient-to-r from-sky-500/60 to-sky-500/10"
        icon={<Users className="h-4 w-4 text-sky-500" />}
        description={`${activeReferralsCount} active referrals.`}
      >
        <CardContent className="p-0">
          {referralEvents.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">No referrals yet.</div>
          ) : (
            <div className="divide-y">
              {referralEvents.map((event: any) => (
                <div key={event.id} className="p-4 flex items-center justify-between">
                  <div>
                    <div className="text-sm font-bold">{event.referred_tenants?.name || "New Adjuster"}</div>
                    <div className="text-[10px] text-muted-foreground uppercase">Joined {format(new Date(event.created_at), "MMM d, yyyy")}</div>
                  </div>
                  <Badge className={event.status === "active" ? "bg-green-100 text-green-700 hover:bg-green-100" : "bg-muted"}>
                    {event.status.toUpperCase()}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </SectionCard>
    </div>
  );
}