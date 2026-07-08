import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useTenant } from "@/contexts/TenantContext";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Gift, Copy, CheckCircle2, Users, DollarSign,
  TrendingUp, AlertTriangle, Star
} from "lucide-react";
import { format } from "date-fns";

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

  // Load tenant referral data
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

  // Load referral history from the tenants table (source of truth = referred_by_tenant_id).
  // referral_events is a separate audit log and may be missing rows if an insert failed
  // while the tenant record was still updated — mirroring the admin dashboard fix.
  const { data: referralEvents = [], refetch: refetchEvents } = useQuery({
    queryKey: ["referral-events", tenant?.id],
    enabled: !!tenant?.id,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    refetchInterval: 60_000,
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
      toast({
        title: "Success!",
        description: data.message || "Referral code applied successfully.",
      });
      setReferralCodeInput("");
      qc.invalidateQueries({ queryKey: ["tenant-referral"] });
      qc.invalidateQueries({ queryKey: ["referral-events"] });
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const copyToClipboard = () => {
    if (tenantData?.referral_code) {
      navigator.clipboard.writeText(tenantData.referral_code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast({
        title: "Copied!",
        description: "Your referral code is ready to share.",
      });
    }
  };

  const discountAmount = (tenantData?.referral_discount_cents || 0) / 100;
  const maxDiscount = 25;
  const progressPercent = Math.min((discountAmount / maxDiscount) * 100, 100);
  const activeReferralsCount = referralEvents.filter((e: any) => e.status === "active").length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold flex items-center gap-2 text-primary">
            <Gift className="h-6 w-6" />
            Refer & Earn
          </h2>
          <p className="text-muted-foreground">Give $5/mo off, Get $5/mo off</p>
        </div>
        {tenantData?.is_founding_partner && (
          <Badge className="bg-yellow-500 hover:bg-yellow-600 text-white border-none px-3 py-1 gap-1">
            <Star className="h-3.5 w-3.5 fill-current" />
            Founding Partner
          </Badge>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Share Section */}
        <Card className="border-primary/20 shadow-sm overflow-hidden">
          <div className="h-2 bg-primary/10" />
          <CardHeader>
            <CardTitle className="text-lg">Share your code</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Invite other adjusting firms to ChecksOps. When they join using your code, both of you get <span className="font-bold text-foreground">$5 off your monthly subscription</span>.
            </p>
            
            <div className="space-y-2">
              <Label className="text-xs uppercase tracking-wider text-muted-foreground font-bold">Your Referral Code</Label>
              <div className="flex gap-2">
                <div className="relative flex-1 group">
                  <Input 
                    value={tenantData?.referral_code || "Generating..."} 
                    readOnly 
                    className="bg-muted/50 font-mono text-lg tracking-wider text-center h-12 border-2 border-primary/10 group-hover:border-primary/30 transition-colors"
                  />
                  <Badge className="absolute -top-2 -right-2 bg-primary text-white text-[10px]">
                    $5 OFF EACH
                  </Badge>
                </div>
                <Button 
                  onClick={copyToClipboard}
                  variant={copied ? "outline" : "default"}
                  className="h-12 px-6"
                >
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
                <div className="text-xs text-muted-foreground text-right">
                  <span className="font-bold text-foreground">{activeReferralsCount}</span> active referrals
                </div>
              </div>
              
              <div className="space-y-1.5">
                <div className="h-2 w-full bg-primary/10 rounded-full overflow-hidden">
                  <div 
                    className="h-full bg-primary transition-all duration-500 ease-out" 
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
                <div className="flex justify-between text-[10px] text-muted-foreground font-medium uppercase">
                  <span>Current: ${discountAmount}</span>
                  <span>Max: ${maxDiscount}/mo</span>
                </div>
              </div>

              {discountAmount >= maxDiscount && (
                <div className="flex items-center gap-2 text-xs text-green-600 bg-green-50 p-2 rounded border border-green-100 font-medium">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  You've reached the maximum monthly referral discount!
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Redeem Section */}
        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg">Redeem a code</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {tenantData?.referred_by_tenant_id ? (
              <div className="bg-green-50 border border-green-100 rounded-lg p-6 flex flex-col items-center text-center space-y-3">
                <div className="bg-green-100 p-3 rounded-full">
                  <Gift className="h-8 w-8 text-green-600" />
                </div>
                <div className="space-y-1">
                  <h4 className="font-bold text-green-800">Referral Applied!</h4>
                  <p className="text-sm text-green-700">
                    You're receiving a $5/mo discount because you were referred by another firm.
                  </p>
                </div>
                <Badge variant="outline" className="bg-white border-green-200 text-green-600">
                  CODE REDEEMED
                </Badge>
              </div>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  Were you referred by another firm? Enter their code here to instantly apply a <span className="font-bold text-foreground">$5/mo discount</span> to your subscription.
                </p>
                <div className="space-y-3 pt-2">
                  <div className="space-y-2">
                    <Label htmlFor="referral-input">Friend's Referral Code</Label>
                    <Input 
                      id="referral-input"
                      placeholder="ENTER-CODE-HERE" 
                      value={referralCodeInput}
                      onChange={(e) => setReferralCodeInput(e.target.value)}
                      className="font-mono uppercase h-11"
                    />
                  </div>
                  <Button 
                    className="w-full h-11 font-bold"
                    onClick={() => applyReferralCode.mutate()}
                    disabled={applyReferralCode.isPending || !referralCodeInput.trim()}
                  >
                    {applyReferralCode.isPending ? "Applying..." : "Apply Discount"}
                  </Button>
                  <p className="text-[10px] text-center text-muted-foreground italic">
                    * Codes can only be applied once per firm
                  </p>
                </div>
              </>
            )}
            
            <div className="mt-4 pt-4 border-t border-dashed">
              <h4 className="text-xs font-bold text-muted-foreground uppercase flex items-center gap-1.5 mb-2">
                <TrendingUp className="h-3.5 w-3.5" />
                How it works
              </h4>
              <ul className="space-y-2">
                <li className="text-[11px] flex items-start gap-2">
                  <div className="h-1.5 w-1.5 rounded-full bg-primary mt-1 flex-shrink-0" />
                  Each active referral gives you $5 off your monthly bill.
                </li>
                <li className="text-[11px] flex items-start gap-2">
                  <div className="h-1.5 w-1.5 rounded-full bg-primary mt-1 flex-shrink-0" />
                  The discount is applied as long as the referred firm stays active.
                </li>
                <li className="text-[11px] flex items-start gap-2">
                  <div className="h-1.5 w-1.5 rounded-full bg-primary mt-1 flex-shrink-0" />
                  Founding Partners enjoy additional perks and higher referral caps.
                </li>
              </ul>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Referral History */}
      <Card className="shadow-sm">
        <CardHeader className="pb-3 border-b">
          <div className="flex justify-between items-center">
            <CardTitle className="text-lg flex items-center gap-2">
              <Users className="h-5 w-5 text-muted-foreground" />
              Referral History
            </CardTitle>
            <Badge variant="outline" className="font-mono">
              {activeReferralsCount} ACTIVE
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {referralEvents.length === 0 ? (
            <div className="py-12 text-center space-y-2">
              <Users className="h-10 w-10 text-muted-foreground/30 mx-auto" />
              <p className="text-sm text-muted-foreground">No referrals yet. Start sharing your code!</p>
            </div>
          ) : (
            <div className="divide-y">
              {referralEvents.map((event: any) => (
                <div key={event.id} className="p-4 flex items-center justify-between hover:bg-muted/30 transition-colors">
                  <div className="flex items-center gap-3">
                    <div className="bg-primary/10 p-2 rounded-full">
                      <Users className="h-4 w-4 text-primary" />
                    </div>
                    <div>
                      <div className="text-sm font-bold">{event.referred_tenants?.name || "New Adjuster"}</div>
                      <div className="text-[10px] text-muted-foreground uppercase tracking-wider">
                        Joined {format(new Date(event.created_at), "MMM d, yyyy")}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="text-right">
                      <div className="text-sm font-bold text-green-600">+${(event.discount_applied_cents || 0) / 100}</div>
                      <div className="text-[10px] text-muted-foreground uppercase">Monthly Credit</div>
                    </div>
                    <Badge className={event.status === "active" ? "bg-green-100 text-green-700 hover:bg-green-100 border-green-200" : "bg-muted text-muted-foreground"}>
                      {event.status.toUpperCase()}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
