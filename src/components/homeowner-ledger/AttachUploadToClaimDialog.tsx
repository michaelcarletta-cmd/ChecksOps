import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Loader2, Search, CheckCircle2, Upload } from "lucide-react";
import { toast } from "sonner";

type Claim = {
  id: string;
  claim_number: string | null;
  policyholder_name: string | null;
  policyholder_address: string | null;
};

export function AttachUploadToClaimDialog({
  open,
  onOpenChange,
  uploadId,
  tenantId,
  defaultAmount,
  claimIdFromUpload,
  onAttached,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  uploadId: string | null;
  tenantId?: string;
  defaultAmount?: number | null;
  claimIdFromUpload?: string | null;
  onAttached: (checkId?: string) => void;
}) {
  const [q, setQ] = useState("");
  const [claims, setClaims] = useState<Claim[]>([]);
  const [loading, setLoading] = useState(false);
  const [pickedId, setPickedId] = useState<string | null>(claimIdFromUpload ?? null);
  const [amount, setAmount] = useState<string>(defaultAmount != null ? String(defaultAmount) : "");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      setQ("");
      setClaims([]);
      setPickedId(claimIdFromUpload ?? null);
      setAmount(defaultAmount != null ? String(defaultAmount) : "");
    }
  }, [open, defaultAmount]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      let query: any = supabase
        .from("claims")
        .select("id, claim_number, policyholder_name, policyholder_address")
        .order("created_at", { ascending: false })
        .limit(20);
      if (tenantId) query = query.eq("tenant_id", tenantId);
      if (q.trim()) {
        const term = `%${q.trim()}%`;
        query = query.or(`claim_number.ilike.${term},policyholder_name.ilike.${term},policyholder_address.ilike.${term}`);
      }
      const { data } = await query;
      if (!cancelled) {
        setClaims((data ?? []) as Claim[]);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [q, open, tenantId]);

  const submit = async () => {
    if (!uploadId) return;
    setSubmitting(true);
    try {
      const parsedAmount = amount.trim() ? Number(amount) : null;
      const { data, error } = await supabase.functions.invoke("homeowner-ledger-attach-upload", {
        body: { upload_id: uploadId, claim_id: pickedId ?? null, amount: parsedAmount },
      });
      if (error) throw new Error(error.message);
      if ((data as any)?.error) throw new Error((data as any).error);
      toast.success("Check attached to claim");
      onAttached((data as any)?.check_id);
      onOpenChange(false);
    } catch (e: any) {
      toast.error(e.message ?? "Attach failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{claimIdFromUpload ? "Confirm & Process" : "Attach to claim"}</DialogTitle>
          <DialogDescription>
            {claimIdFromUpload 
              ? "This check is already linked to a claim. Confirm the amount and process it for OCR and review." 
              : "Link this homeowner-submitted check to a claim. Future uploads from this link will auto-track to this claim."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Amount (optional)</Label>
            <Input
              type="number"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
            />
          </div>

          {!claimIdFromUpload && (
            <div className="space-y-1.5">
              <Label>Find claim</Label>
              <div className="relative">
                <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Claim number, homeowner name, or address"
                  className="pl-8"
                />
              </div>
            </div>
          )}

          {!claimIdFromUpload && (
            <div className="border border-border rounded-md max-h-64 overflow-auto">
              {loading ? (
                <div className="flex justify-center py-6">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              ) : claims.length === 0 ? (
                <div className="text-sm text-muted-foreground text-center py-6">No claims match.</div>
              ) : (
                <ul>
                  {claims.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        className={`w-full text-left px-3 py-2 text-sm hover:bg-muted flex items-center justify-between ${pickedId === c.id ? "bg-muted" : ""}`}
                        onClick={() => setPickedId(c.id)}
                      >
                        <div>
                          <div className="font-medium">{c.claim_number || "(no #)"}</div>
                          <div className="text-xs text-muted-foreground truncate">
                            {c.policyholder_name || "—"}{c.policyholder_address ? ` • ${c.policyholder_address}` : ""}
                          </div>
                        </div>
                        {pickedId === c.id && <CheckCircle2 className="h-4 w-4 text-primary" />}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button onClick={submit} disabled={submitting}>
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Uploading...
                </>
              ) : (
                <>
                  <Upload className="h-4 w-4 mr-2" />
                  {claimIdFromUpload ? "Process Check" : "Upload"}
                </>
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
