import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { usePermissions } from "@/hooks/usePermissions";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, ShieldCheck, Crosshair, Star, CheckCircle2, XCircle, Crown } from "lucide-react";

type Status = {
  found: boolean;
  current_tier?: "guest" | "verified" | "pro";
  eligible_verified?: boolean;
  eligible_pro?: boolean;
  verified_at?: string | null;
  pro_approved_at?: string | null;
  checks?: {
    w9_on_file: boolean;
    coi_current: boolean;
    license_on_file: boolean;
    admin_payment_attested: boolean;
    no_open_disputes: boolean;
    review_count: number;
    review_count_ok: boolean;
    avg_rating: number;
    avg_rating_ok: boolean;
    days_on_platform: number;
    days_on_platform_ok: boolean;
  };
};

function CheckRow({ ok, label, hint }: { ok: boolean; label: string; hint?: string }) {
  return (
    <div className="flex items-start gap-2 text-xs">
      {ok ? (
        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 flex-shrink-0 mt-0.5" />
      ) : (
        <XCircle className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0 mt-0.5" />
      )}
      <div className="flex-1">
        <div className={ok ? "text-foreground" : "text-muted-foreground"}>{label}</div>
        {hint && <div className="text-[10px] text-muted-foreground">{hint}</div>}
      </div>
    </div>
  );
}

export function ContractorVerificationStatusCard({ contractorId }: { contractorId: string }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { isAdmin } = usePermissions();

  const { data, isLoading } = useQuery({
    queryKey: ["contractor-verification-status", contractorId],
    enabled: !!contractorId,
    queryFn: async (): Promise<Status | null> => {
      const { data, error } = await supabase.rpc("contractor_verification_status", {
        p_contractor_id: contractorId,
      });
      if (error) throw error;
      return data as unknown as Status;
    },
  });

  const setPro = useMutation({
    mutationFn: async (approve: boolean) => {
      const { error } = await supabase.rpc("admin_set_contractor_pro", {
        p_contractor_id: contractorId,
        p_approve: approve,
      });
      if (error) throw error;
    },
    onSuccess: (_d, approve) => {
      toast({ title: approve ? "Pro badge approved" : "Pro badge revoked" });
      qc.invalidateQueries({ queryKey: ["contractor-verification-status", contractorId] });
      qc.invalidateQueries({ queryKey: ["my-contractor-profile"] });
      qc.invalidateQueries({ queryKey: ["contractor-directory"] });
    },
    onError: (e: any) => toast({ title: "Action failed", description: e.message, variant: "destructive" }),
  });

  if (isLoading || !data?.found || !data.checks) return null;

  const tier = data.current_tier ?? "guest";
  const c = data.checks;

  const tierBadge =
    tier === "pro" ? (
      <Badge className="gap-1"><Crown className="h-3 w-3" /> Pro</Badge>
    ) : tier === "verified" ? (
      <Badge variant="secondary" className="gap-1"><Crosshair className="h-3 w-3" strokeWidth={2.5} /> Verified</Badge>
    ) : (
      <Badge variant="outline">Guest (unlisted)</Badge>
    );

  return (
    <Card className="border-border">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-primary" /> Verification status
          <span className="ml-auto">{tierBadge}</span>
        </CardTitle>
        <CardDescription className="text-xs">
          Verified is granted automatically once documents are on file. Pro requires ChecksOps admin approval on top of
          verified + payment & review thresholds. Badges are removed automatically if standards slip.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1.5 font-semibold">
            Verified requirements
          </div>
          <div className="space-y-1.5">
            <CheckRow ok={c.w9_on_file} label="W-9 uploaded" />
            <CheckRow ok={c.coi_current} label="Certificate of insurance on file & unexpired" />
            <CheckRow ok={c.license_on_file} label="License number entered on profile" />
          </div>
          {!data.eligible_verified && (
            <div className="text-[11px] text-muted-foreground mt-2">
              Upload missing docs in Compliance & Docs to earn the Verified badge automatically.
            </div>
          )}
        </div>

        <div className="border-t border-border pt-3">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1.5 font-semibold flex items-center gap-1">
            <Star className="h-3 w-3" /> Pro requirements (needs all Verified + below)
          </div>
          <div className="space-y-1.5">
            <CheckRow
              ok={c.admin_payment_attested}
              label="$25k+ disbursed through ChecksOps"
              hint="Admin-attested until an automated payment aggregator is in place."
            />
            <CheckRow
              ok={c.review_count_ok && c.avg_rating_ok}
              label={`5+ homeowner reviews averaging ≥ 4.5★`}
              hint={`Current: ${c.review_count} reviews, avg ${Number(c.avg_rating).toFixed(2)}★`}
            />
            <CheckRow
              ok={c.days_on_platform_ok}
              label="90+ days on ChecksOps"
              hint={`Current: ${c.days_on_platform} days`}
            />
            <CheckRow ok={c.no_open_disputes} label="Zero unresolved disputes / chargebacks" />
          </div>
        </div>

        {isAdmin && (
          <div className="border-t border-border pt-3 flex items-center gap-2">
            <div className="text-[11px] text-muted-foreground flex-1">
              {data.eligible_pro
                ? "This contractor meets every Pro requirement."
                : "Not yet Pro-eligible — one or more Pro requirements are unmet."}
            </div>
            {tier === "pro" ? (
              <div className="text-[11px] text-muted-foreground">
                Pro badge active. Contact ChecksOps to revoke.
              </div>
            ) : (
              <Button
                size="sm"
                onClick={() => setPro.mutate(true)}
                disabled={setPro.isPending || !data.eligible_pro}
              >
                {setPro.isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Crown className="h-3 w-3 mr-1" />}
                Approve Pro
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
