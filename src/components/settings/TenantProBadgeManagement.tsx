import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, Crown, ShieldCheck, XCircle } from "lucide-react";
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
  email?: string | null;
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

  const setPro = useMutation({
    mutationFn: async ({ contractorId, approve }: { contractorId: string; approve: boolean }) => {
      const { error } = await supabase.rpc("admin_set_contractor_pro", {
        p_contractor_id: contractorId,
        p_approve: approve,
      });
      if (error) throw error;
    },
    onSuccess: (_d, vars) => {
      toast({ title: vars.approve ? "Pro badge approved" : "Pro badge revoked" });
      qc.invalidateQueries({ queryKey: ["tenant-contractor-profiles", tenantId] });
      qc.invalidateQueries({ queryKey: ["contractor-directory"] });
    },
    onError: (e: any) => toast({ title: "Action failed", description: e.message, variant: "destructive" }),
  });

  return (
    <Dialog open={isOpen} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Pro Badge — {tenantName}</DialogTitle>
          <DialogDescription>
            Approve or revoke the Pro verification badge for each contractor profile in this tenant.
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
            {data.map((r) => {
              const isPro = r.tier === "pro";
              const pending = setPro.isPending && setPro.variables?.contractorId === r.id;
              return (
                <div key={r.id} className="flex items-center gap-3 p-3 border border-border rounded-lg">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm truncate">{r.display_name}</div>
                    <div className="mt-1">
                      {isPro ? (
                        <Badge className="gap-1 text-xs"><Crown className="h-3 w-3" /> Pro</Badge>
                      ) : r.tier === "verified" ? (
                        <Badge variant="secondary" className="gap-1 text-xs"><ShieldCheck className="h-3 w-3" /> Verified</Badge>
                      ) : (
                        <Badge variant="outline" className="text-xs">Guest</Badge>
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
                      Revoke Pro
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      disabled={pending}
                      onClick={() => setPro.mutate({ contractorId: r.id, approve: true })}
                    >
                      {pending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Crown className="h-3 w-3 mr-1" />}
                      Approve Pro
                    </Button>
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
