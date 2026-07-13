import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Link2, Loader2, CheckCircle2, Pencil } from "lucide-react";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";

type Props = {
  leadId: string;
  leadClaimNumber?: string | null;
};

type CheckRow = {
  id: string;
  amount: number | null;
  check_number: string | null;
  carrier_name: string | null;
  detected_claim_number: string | null;
  freedom_claim_number: string | null;
  check_stage: string | null;
  created_at: string | null;
  lead_id: string | null;
};

export function LinkCheckToLeadButton({ leadId, leadClaimNumber }: Props) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [saving, setSaving] = useState<string | null>(null);

  const { data: linkedChecks } = useQuery({
    queryKey: ["intake-checks-linked-to-lead", leadId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("check_intake_items")
        .select(
          "id, amount, check_number, carrier_name, detected_claim_number, freedom_claim_number, check_stage, created_at, lead_id",
        )
        .eq("lead_id", leadId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as CheckRow[];
    },
  });

  const linkedCheck = (linkedChecks ?? [])[0] ?? null;
  const linkedClaimNumber =
    linkedCheck?.freedom_claim_number ||
    linkedCheck?.detected_claim_number ||
    leadClaimNumber ||
    null;

  const { data: checks, isLoading } = useQuery({
    queryKey: ["intake-checks-for-lead-picker"],
    enabled: open,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("check_intake_items")
        .select(
          "id, amount, check_number, carrier_name, detected_claim_number, freedom_claim_number, check_stage, created_at, lead_id",
        )
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data ?? []) as CheckRow[];
    },
  });

  const filtered = (checks ?? []).filter((c) => {
    if (c.lead_id && c.lead_id !== leadId) return false; // already linked elsewhere
    if (!q.trim()) return true;
    const needle = q.toLowerCase();
    return (
      c.check_number?.toLowerCase().includes(needle) ||
      c.carrier_name?.toLowerCase().includes(needle) ||
      c.detected_claim_number?.toLowerCase().includes(needle) ||
      c.freedom_claim_number?.toLowerCase().includes(needle)
    );
  });

  const link = async (checkId: string, unlink = false) => {
    setSaving(checkId);
    try {
      const { error } = await supabase
        .from("check_intake_items")
        .update({ lead_id: unlink ? null : leadId })
        .eq("id", checkId);
      if (error) throw error;
      toast.success(unlink ? "Check unlinked" : "Check linked to lead");
      qc.invalidateQueries({ queryKey: ["intake-checks-for-lead-picker"] });
      qc.invalidateQueries({ queryKey: ["intake-checks-linked-to-lead", leadId] });
      if (unlink) setOpen(false);
    } catch (e: any) {
      toast.error(e.message ?? "Could not update");
    } finally {
      setSaving(null);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {linkedCheck ? (
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1 border-emerald-500/40 text-emerald-300 hover:text-emerald-200"
          >
            <CheckCircle2 className="h-3 w-3" />
            Check linked to Claim{linkedClaimNumber ? ` #${linkedClaimNumber}` : ""}
            <Pencil className="h-3 w-3 ml-1 opacity-70" />
          </Button>
        ) : (
          <Button size="sm" variant="outline" className="h-7 text-xs">
            <Link2 className="h-3 w-3 mr-1" /> Link check
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[360px] p-3 space-y-2">
        <div className="text-xs text-muted-foreground">
          Ties a check in your pipeline to this homeowner so they see live status in their portal.
          {leadClaimNumber ? (
            <> Auto-matched by claim <code>{leadClaimNumber}</code> already; use this for edge cases.</>
          ) : null}
        </div>
        <Input
          placeholder="Search by check #, carrier, or claim #"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="h-8 text-xs"
        />
        <div className="max-h-72 overflow-y-auto space-y-1.5">
          {isLoading ? (
            <div className="flex justify-center py-6">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          ) : filtered.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-4">
              No matching checks in your pipeline.
            </p>
          ) : (
            filtered.map((c) => {
              const alreadyLinked = c.lead_id === leadId;
              return (
                <div
                  key={c.id}
                  className="flex items-center justify-between gap-2 border border-border rounded-md p-2"
                >
                  <div className="min-w-0 text-xs">
                    <div className="font-medium truncate">
                      {c.carrier_name ?? "Check"}
                      {c.check_number ? ` • #${c.check_number}` : ""}
                    </div>
                    <div className="text-[10px] text-muted-foreground truncate">
                      {c.amount != null
                        ? `$${Number(c.amount).toLocaleString(undefined, { minimumFractionDigits: 2 })}`
                        : ""}
                      {c.detected_claim_number || c.freedom_claim_number
                        ? ` • claim ${c.detected_claim_number ?? c.freedom_claim_number}`
                        : ""}
                      {c.created_at
                        ? ` • ${formatDistanceToNow(new Date(c.created_at), { addSuffix: true })}`
                        : ""}
                    </div>
                    {c.check_stage && (
                      <Badge variant="outline" className="text-[9px] mt-1 capitalize">
                        {c.check_stage.replace(/_/g, " ")}
                      </Badge>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant={alreadyLinked ? "secondary" : "outline"}
                    className="h-7 text-xs whitespace-nowrap"
                    disabled={saving === c.id}
                    onClick={() => link(c.id, alreadyLinked)}
                  >
                    {saving === c.id ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : alreadyLinked ? (
                      <>
                        <CheckCircle2 className="h-3 w-3 mr-1" /> Unlink
                      </>
                    ) : (
                      "Link"
                    )}
                  </Button>
                </div>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
