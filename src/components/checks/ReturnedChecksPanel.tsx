import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useTenantFilter } from "@/hooks/useTenantFilter";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { returnCodeLabel, resolveReturnCode } from "@/lib/checkReturnCodes";

type ReturnedCheck = {
  id: string;
  check_number: string | null;
  carrier_name: string | null;
  payee_line: string | null;
  amount: number | null;
  deposited_at: string | null;
  returned_at: string | null;
  return_code: string | null;
  return_reason: string | null;
  return_notes: string | null;
  return_source: string | null;
  pre_return_stage: string | null;
  return_resolved_at: string | null;
  return_resolution: string | null;
};

const money = (v: number | null) =>
  `$${Number(v ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;

const daysBetween = (a?: string | null, b?: string | null) => {
  if (!a || !b) return null;
  return Math.round((new Date(a).getTime() - new Date(b).getTime()) / 86_400_000);
};

/**
 * Returned checks queue — items the bank sent back, including late returns
 * that landed after the deposit already cleared. Shows the CheckAlt/X9 return
 * code, how long after deposit it came back, and whether money had already
 * gone out (clawback exposure).
 */
export function ReturnedChecksPanel({ searchQuery = "" }: { searchQuery?: string }) {
  const { tenantId } = useTenantFilter();
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [resolutionText, setResolutionText] = useState("");

  const { data: checks = [], refetch } = useQuery({
    queryKey: ["returned-checks", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("check_intake_items")
        .select(
          "id, check_number, carrier_name, payee_line, amount, deposited_at, returned_at, return_code, return_reason, return_notes, return_source, pre_return_stage, return_resolved_at, return_resolution",
        )
        .eq("tenant_id", tenantId!)
        .not("returned_at", "is", null)
        .order("returned_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as unknown as ReturnedCheck[];
    },
  });

  const { data: alerts = [] } = useQuery({
    queryKey: ["returned-check-alerts", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("check_reconciliation_alerts")
        .select("check_intake_item_id, details, resolved, severity")
        .eq("alert_type", "check_returned")
        .limit(500);
      if (error) throw error;
      return data ?? [];
    },
  });

  const exposureFor = (checkId: string) => {
    const row: any = alerts.find((a: any) => a.check_intake_item_id === checkId);
    return Number(row?.details?.disbursed_amount ?? 0);
  };

  const q = searchQuery.trim().toLowerCase();
  const rows = q
    ? checks.filter((c) =>
        [c.check_number, c.carrier_name, c.payee_line, c.return_code, c.return_reason]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(q)),
      )
    : checks;

  const open = rows.filter((c) => !c.return_resolved_at);
  const resolved = rows.filter((c) => c.return_resolved_at);
  const totalExposure = open.reduce((sum, c) => sum + exposureFor(c.id), 0);

  const resolve = async (check: ReturnedCheck, restoreStage: boolean) => {
    try {
      const { error } = await supabase.rpc("resolve_check_return" as any, {
        p_check_id: check.id,
        p_resolution: resolutionText.trim() || (restoreStage ? "Redeposited" : "Closed — carrier reissuing"),
        p_actor_id: user?.id ?? null,
        p_restore_stage: restoreStage,
      });
      if (error) throw error;
      toast({ title: "Return resolved" });
      setResolvingId(null);
      setResolutionText("");
      await refetch();
      queryClient.invalidateQueries({ queryKey: ["checks"] });
    } catch (e: any) {
      toast({ title: "Could not resolve return", description: e.message, variant: "destructive" });
    }
  };

  const renderRow = (c: ReturnedCheck) => {
    const exposure = exposureFor(c.id);
    const aging = daysBetween(c.returned_at, c.deposited_at);
    const info = resolveReturnCode(c.return_code);
    return (
      <div key={c.id} className="rounded-lg border border-border/60 bg-muted/20 p-3 space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-medium">
              {c.check_number ? `Check #${c.check_number}` : "Check"} · {money(c.amount)}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {[c.carrier_name, c.payee_line].filter(Boolean).join(" · ") || "—"}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge className="bg-orange-500/20 text-orange-300 text-[10px]">
              {returnCodeLabel(c.return_code, c.return_reason)}
            </Badge>
            {c.return_source === "checkalt" && (
              <Badge variant="outline" className="text-[10px]">Reported by CheckAlt</Badge>
            )}
            {exposure > 0 && (
              <Badge className="bg-destructive/20 text-destructive text-[10px] gap-1">
                <AlertTriangle className="h-3 w-3" />
                Clawback {money(exposure)}
              </Badge>
            )}
          </div>
        </div>

        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
          <span>Deposited {c.deposited_at ? new Date(c.deposited_at).toLocaleDateString() : "—"}</span>
          <span>Returned {c.returned_at ? new Date(c.returned_at).toLocaleDateString() : "—"}</span>
          {aging !== null && <span>{aging} day{aging === 1 ? "" : "s"} after deposit</span>}
          {info && <span>{info.redepositable ? "Can be re-presented" : "Must be reissued by carrier"}</span>}
        </div>

        {c.return_notes && <p className="text-[11px] text-muted-foreground">{c.return_notes}</p>}

        {c.return_resolved_at ? (
          <div className="text-[11px] text-emerald-300">
            Resolved {new Date(c.return_resolved_at).toLocaleDateString()} — {c.return_resolution}
          </div>
        ) : resolvingId === c.id ? (
          <div className="space-y-2">
            <Input
              value={resolutionText}
              onChange={(e) => setResolutionText(e.target.value)}
              placeholder="How was this resolved?"
              className="h-8 text-xs"
            />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" className="h-7 text-xs" onClick={() => resolve(c, true)}>
                Resolve &amp; send back to deposit
              </Button>
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => resolve(c, false)}>
                Resolve &amp; keep returned
              </Button>
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setResolvingId(null)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => { setResolvingId(c.id); setResolutionText(""); }}
          >
            Resolve return
          </Button>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <Card>
          <CardContent className="p-3">
            <p className="text-[11px] text-muted-foreground">Open returns</p>
            <p className="text-lg font-bold tabular-nums">{open.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <p className="text-[11px] text-muted-foreground">Returned value</p>
            <p className="text-lg font-bold tabular-nums">
              {money(open.reduce((s, c) => s + Number(c.amount ?? 0), 0))}
            </p>
          </CardContent>
        </Card>
        <Card className={totalExposure > 0 ? "border-destructive/40" : ""}>
          <CardContent className="p-3">
            <p className="text-[11px] text-muted-foreground">Clawback exposure</p>
            <p className={`text-lg font-bold tabular-nums ${totalExposure > 0 ? "text-destructive" : ""}`}>
              {money(totalExposure)}
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <RotateCcw className="h-4 w-4 text-orange-400" />
            Returned checks
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {open.length === 0 && resolved.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              No returned checks. CheckAlt returns are watched for 60 days after a deposit clears.
            </p>
          ) : (
            <>
              {open.map(renderRow)}
              {resolved.length > 0 && (
                <>
                  <p className="pt-2 text-[11px] font-medium text-muted-foreground">Resolved</p>
                  {resolved.map(renderRow)}
                </>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
