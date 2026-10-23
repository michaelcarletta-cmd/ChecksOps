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
import { Gift, Copy, CheckCircle2, Users } from "lucide-react";
import { format } from "date-fns";
import { SettingsHero } from "./SettingsHero";
import { SectionCard } from "./SectionCard";

// Refer & Earn (SQL 111): the referrer earns $5.00 off monthly maintenance for every company
// that redeems its code, up to $25.00 a month, for as long as the referral stays active. The
// company redeeming the code earns nothing by redeeming it; it earns by referring others.
type ReferralResponse = {
  success: boolean;
  message?: string;
  error?: string;
  referrer_name?: string;
};

type ReferralSummary = {
  tenant_id: string;
  referral_code: string | null;
  per_referral_cents: number;
  monthly_cap_cents: number;
  active_referrals: number;
  earned_credit_cents: number;
  manual_discount_cents: number;
  applied_discount_cents: number;
  monthly_rate_cents: number;
  referred_by: { tenant_id: string; name: string | null; code: string | null; applied_at: string | null } | null;
  referrals: Array<{ name: string | null; applied_at: string | null; status: string | null }>;
};

type RpcError = { message?: string; code?: string } | null;
type RpcCall = (name: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: RpcError }>;
// The SQL 111 functions are AWS-only, so they are not in the generated Supabase function types.
const rpc = (name: string, args?: Record<string, unknown>) => (supabase.rpc as unknown as RpcCall).call(supabase, name, args);

const dollars = (cents: number | null | undefined) => ((Number(cents) || 0) / 100).toFixed(2);

export function ReferralSettings() {
  const { user } = useAuth();
  const { tenant } = useTenant();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [referralCodeInput, setReferralCodeInput] = useState("");

  const { data: summary, isLoading } = useQuery({
    queryKey: ["tenant-referral-summary", tenant?.id],
    enabled: !!tenant?.id,
    queryFn: async () => {
      const { data, error } = await rpc("aws_tenant_referral_summary", { _tenant_id: tenant!.id });
      if (error) throw new Error(error.message || "Could not load referral summary");
      return (data ?? null) as ReferralSummary | null;
    },
  });

  const applyReferralCode = useMutation({
    mutationFn: async () => {
      if (!referralCodeInput.trim()) throw new Error("Enter a referral code");
      const { data, error } = await rpc("apply_referral_code", {
        p_referring_code: referralCodeInput.trim().toUpperCase(),
        p_new_tenant_id: tenant!.id,
        p_new_user_id: user!.id,
      });
      if (error) throw new Error(error.message || "Failed to apply code");
      const result = (data ?? null) as ReferralResponse | null;
      if (!result?.success) throw new Error(result?.message ?? result?.error ?? "Failed to apply code");
      return result;
    },
    onSuccess: (data) => {
      toast({ title: "Code applied", description: data.message || "Referral code applied." });
      setReferralCodeInput("");
      qc.invalidateQueries({ queryKey: ["tenant-referral-summary"] });
    },
    onError: (error: Error) => {
      toast({ title: "Could not apply code", description: error.message, variant: "destructive" });
    },
  });

  const copyToClipboard = () => {
    if (summary?.referral_code) {
      navigator.clipboard.writeText(summary.referral_code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast({ title: "Copied!", description: "Your referral code is ready to share." });
    }
  };

  const perReferral = dollars(summary?.per_referral_cents ?? 500);
  const monthlyCap = dollars(summary?.monthly_cap_cents ?? 2500);
  const earned = dollars(summary?.earned_credit_cents);
  const applied = dollars(summary?.applied_discount_cents);
  const manual = Number(summary?.manual_discount_cents) || 0;
  const capCents = Number(summary?.monthly_cap_cents) || 2500;
  const progressPercent = Math.min(((Number(summary?.earned_credit_cents) || 0) / capCents) * 100, 100);
  const referrals = summary?.referrals ?? [];
  const activeReferralsCount = Number(summary?.active_referrals) || 0;

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <SettingsHero
        title="Refer & Earn"
        description="Share the ChecksOps experience with other firms and earn monthly maintenance discounts."
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
              Invite other adjusting firms to ChecksOps. For every firm that joins with your code you get{" "}
              <span className="font-bold text-foreground">${perReferral} off your monthly maintenance</span>, every month,
              up to <span className="font-bold text-foreground">${monthlyCap} a month</span>.
            </p>
            <div className="space-y-2">
              <Label className="text-xs tracking-wider text-muted-foreground font-bold">Your Referral Code</Label>
              <div className="flex gap-2">
                <Input
                  value={summary?.referral_code || (isLoading ? "Loading..." : "Not assigned yet")}
                  readOnly
                  className="bg-muted/50 font-mono text-lg tracking-wider text-center h-12"
                />
                <Button onClick={copyToClipboard} variant={copied ? "outline" : "default"} className="h-12 px-6" disabled={!summary?.referral_code}>
                  {copied ? <CheckCircle2 className="h-5 w-5" /> : <Copy className="h-5 w-5" />}
                </Button>
              </div>
            </div>
            <div className="bg-primary/5 rounded-lg p-4 space-y-3">
              <div className="flex justify-between items-end">
                <div className="space-y-1">
                  <span className="text-xs font-medium text-muted-foreground">Referral credit</span>
                  <div className="text-2xl font-bold text-primary">${earned} / mo</div>
                </div>
                <div className="text-right text-xs text-muted-foreground">
                  <div>{activeReferralsCount} active {activeReferralsCount === 1 ? "referral" : "referrals"}</div>
                  <div>cap ${monthlyCap} / mo</div>
                </div>
              </div>
              <div className="h-2 w-full bg-primary/10 rounded-full overflow-hidden">
                <div className="h-full bg-primary transition-all duration-500 ease-out" style={{ width: `${progressPercent}%` }} />
              </div>
              <div className="text-xs text-muted-foreground">
                Applied to your maintenance invoice: <span className="font-semibold text-foreground">${applied} / mo</span>
                {manual > 0 ? <> (includes a ${dollars(manual)} discount set by ChecksOps)</> : null}
                . The discount never takes maintenance below $0 and never reduces check fees.
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
            {summary?.referred_by ? (
              <div className="bg-green-50 border border-green-100 rounded-lg p-6 text-center space-y-3">
                <h4 className="font-bold text-green-800">Referral Applied!</h4>
                <p className="text-sm text-green-700">
                  You joined with {summary.referred_by.name || "another company"}&apos;s code
                  {summary.referred_by.code ? <> (<span className="font-mono">{summary.referred_by.code}</span>)</> : null}.
                </p>
                <Badge variant="outline" className="bg-white border-green-200 text-green-600">Code Redeemed</Badge>
              </div>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  Were you referred by another firm? Enter their code so they get{" "}
                  <span className="font-bold text-foreground">${perReferral} off their monthly maintenance</span>. A code can be
                  redeemed once per company.
                </p>
                <div className="space-y-3 pt-2">
                  <Input placeholder="ENTER-CODE-HERE" value={referralCodeInput} onChange={(e) => setReferralCodeInput(e.target.value)} className="font-mono h-11" />
                  <Button className="w-full h-11 font-bold" onClick={() => applyReferralCode.mutate()} disabled={applyReferralCode.isPending || !referralCodeInput.trim()}>
                    {applyReferralCode.isPending ? "Applying..." : "Apply Code"}
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
        description={`${activeReferralsCount} active ${activeReferralsCount === 1 ? "referral" : "referrals"}.`}
      >
        <CardContent className="p-0">
          {referrals.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">No referrals yet.</div>
          ) : (
            <div className="divide-y">
              {referrals.map((event, index) => {
                const status = String(event.status || "active");
                return (
                  <div key={`${event.name || "referral"}-${event.applied_at || index}`} className="p-4 flex items-center justify-between">
                    <div>
                      <div className="text-sm font-bold">{event.name || "New Adjuster"}</div>
                      <div className="text-[10px] text-muted-foreground">
                        {event.applied_at ? `Joined ${format(new Date(event.applied_at), "MMM d, yyyy")}` : "Joined before referral codes"}
                      </div>
                    </div>
                    <Badge className={status === "active" ? "bg-green-100 text-green-700 hover:bg-green-100" : "bg-muted"}>
                      {status.charAt(0).toUpperCase() + status.slice(1)}
                    </Badge>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </SectionCard>
    </div>
  );
}
