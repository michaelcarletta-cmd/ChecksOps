import { useQuery, useMutation, useQueryClient, useQueries } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, Crosshair, XCircle, CheckCircle2, AlertCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface Props {
  tenantId: string;
  tenantName: string;
  isOpen: boolean;
  onClose: () => void;
}

type Row = {
  id: string;
  display_name: string;
  tier: string;
  user_id: string;
};

type Status = {
  found: boolean;
  current_tier?: "guest" | "verified" | "pro";
  eligible_verified?: boolean;
  eligible_pro?: boolean;
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

export function TenantProBadgeManagement({ tenantId, tenantName, isOpen, onClose }: Props) {
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["tenant-contractor-profiles", tenantId],
    enabled: isOpen && !!tenantId,
    queryFn: async (): Promise<Row[]> => {
      const { data: members, error: memErr } = await supabase
        .from("tenant_users")
        .select("user_id")
        .eq("tenant_id", tenantId);
      if (memErr) throw memErr;
      const userIds = Array.from(new Set((members ?? []).map((m) => m.user_id).filter(Boolean)));
      if (!userIds.length) return [];
      const { data: profiles, error: profErr } = await supabase
        .from("contractor_profiles")
        .select("id, display_name, tier, user_id")
        .in("user_id", userIds);
      if (profErr) throw profErr;
      return (profiles ?? []) as Row[];
    },
  });

  const statuses = useQueries({
    queries: (data ?? []).map((r) => ({
      queryKey: ["contractor-verification-status", r.id],
      enabled: isOpen,
      queryFn: async (): Promise<Status | null> => {
        const { data, error } = await supabase.rpc("contractor_verification_status", {
          p_contractor_id: r.id,
        });
        if (error) throw error;
        return data as unknown as Status;
      },
    })),
  });

  const setPro = useMutation({
    mutationFn: async ({ contractorId, approve }: { contractorId: string; approve: boolean }) => {
      const { error } = await supabase.rpc("admin_set_contractor_pro", {
        p_contractor_id: contractorId,
        p_approve: approve,
      });
      if (error) throw error;
    },
    onSuccess: (_d, vars) => {
      toast({ title: vars.approve ? "OPS badge approved" : "OPS badge revoked" });
      qc.invalidateQueries({ queryKey: ["tenant-contractor-profiles", tenantId] });
      qc.invalidateQueries({ queryKey: ["contractor-verification-status", vars.contractorId] });
      qc.invalidateQueries({ queryKey: ["contractor-directory"] });
    },
    onError: (e: any) => toast({ title: "Action failed", description: e.message, variant: "destructive" }),
  });

  const unmetLabels = (s?: Status | null): string[] => {
    if (!s?.checks) return ["Verification status unavailable"];
    const c = s.checks;
    const out: string[] = [];
    if (!c.w9_on_file) out.push("W-9 not on file");
    if (!c.coi_current) out.push("COI missing/expired");
    if (!c.license_on_file) out.push("License number missing");
    if (!c.admin_payment_attested) out.push("$25k+ disbursed not attested");
    if (!(c.review_count_ok && c.avg_rating_ok))
      out.push(`Needs 5+ reviews ≥4.5★ (has ${c.review_count} @ ${Number(c.avg_rating).toFixed(2)}★)`);
    if (!c.days_on_platform_ok) out.push(`Needs 90+ days (has ${c.days_on_platform})`);
    if (!c.no_open_disputes) out.push("Open disputes / chargebacks");
    return out;
  };

  return (
    <Dialog open={isOpen} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>OPS Badge — {tenantName}</DialogTitle>
          <DialogDescription>
            Contractors must pass every vetting requirement (docs, payments, reviews, tenure, disputes) before the OPS
            badge can be approved. Revoke is available at any time.
          </DialogDescription>

        </DialogHeader>
        {isLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : !data?.length ? (
          <div className="text-sm text-muted-foreground py-6 text-center">
            No contractor profiles found for this tenant.
          </div>
        ) : (
          <div className="space-y-2">
            {data.map((r, i) => {
              const status = statuses[i]?.data as Status | null | undefined;
              const statusLoading = statuses[i]?.isLoading;
              const isPro = r.tier === "pro";
              const eligible = !!status?.eligible_pro;
              const unmet = unmetLabels(status);
              const pending = setPro.isPending && setPro.variables?.contractorId === r.id;
              return (
                <div key={r.id} className="p-3 border border-border rounded-lg space-y-2">
                  <div className="flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-sm truncate">{r.display_name}</div>
                      <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                        {isPro ? (
                          <Badge className="gap-1 text-xs"><Crosshair className="h-3 w-3" strokeWidth={2.5} /> OPS</Badge>
                        ) : r.tier === "verified" ? (
                          <Badge variant="secondary" className="gap-1 text-xs"><Crosshair className="h-3 w-3" strokeWidth={2.5} /> Verified</Badge>
                        ) : (
                          <Badge variant="outline" className="text-xs">Guest</Badge>
                        )}
                        {!isPro && !statusLoading && (
                          eligible ? (
                            <Badge variant="outline" className="gap-1 text-xs text-emerald-500 border-emerald-500/40">
                              <CheckCircle2 className="h-3 w-3" /> Vetted — ready for OPS
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="gap-1 text-xs text-amber-500 border-amber-500/40">
                              <AlertCircle className="h-3 w-3" /> Not yet vetted
                            </Badge>
                          )
                        )}

                      </div>
                    </div>
                    {isPro ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-destructive hover:bg-destructive/10"
                        disabled={pending}
                        onClick={() => setPro.mutate({ contractorId: r.id, approve: false })}
                      >
                        {pending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <XCircle className="h-3 w-3 mr-1" />}
                        Revoke OPS
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        disabled={pending || statusLoading || !eligible}
                        onClick={() => setPro.mutate({ contractorId: r.id, approve: true })}
                        title={!eligible ? "Contractor has not met all vetting requirements" : undefined}
                      >
                        {pending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Crosshair className="h-3 w-3 mr-1" strokeWidth={2.5} />}
                        Approve OPS

                      </Button>
                    )}
                  </div>
                  {!isPro && !statusLoading && !eligible && unmet.length > 0 && (
                    <ul className="text-[11px] text-muted-foreground list-disc list-inside space-y-0.5 pl-1">
                      {unmet.map((u) => <li key={u}>{u}</li>)}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
