import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle2, Clock, AlertTriangle, ListChecks, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";

type TrackedCheck = {
  id: string;
  check_number: string | null;
  payee_line: string | null;
  amount: number | null;
  carrier_name: string | null;
  endorsement_status: string | null;
  deposit_status: string | null;
  deposit_confirmation_number: string | null;
  deposit_confirmed_amount: number | null;
  deposit_confirmed_at: string | null;
  deposit_confirmed_by: string | null;
  created_at: string;
  updated_at: string;
};

const fmtMoney = (n: number | null | undefined) =>
  typeof n === "number"
    ? n.toLocaleString("en-US", { style: "currency", currency: "USD" })
    : "—";

export function AdminCheckTracker() {
  const [checks, setChecks] = useState<TrackedCheck[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("in_transit");
  const [confirmTarget, setConfirmTarget] = useState<TrackedCheck | null>(null);
  const [confirmNumber, setConfirmNumber] = useState("");
  const [confirmAmount, setConfirmAmount] = useState("");
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("claim_checks")
      .select(
        "id, check_number, payee_line, amount, carrier_name, endorsement_status, deposit_status, deposit_confirmation_number, deposit_confirmed_amount, deposit_confirmed_at, deposit_confirmed_by, created_at, updated_at"
      )
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) {
      toast.error("Failed to load checks: " + error.message);
      setLoading(false);
      return;
    }
    setChecks((data ?? []) as TrackedCheck[]);
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  const buckets = useMemo(() => {
    const inTransit: TrackedCheck[] = [];
    const confirmed: TrackedCheck[] = [];
    const stalled: TrackedCheck[] = [];
    const now = Date.now();
    for (const c of checks) {
      if (c.deposit_confirmed_at) {
        confirmed.push(c);
        continue;
      }
      const isReady =
        c.status === "approved_for_deposit" ||
        c.status === "deposited" ||
        c.deposit_status === "ready" ||
        c.deposit_status === "submitted" ||
        c.deposit_status === "in_transit";
      if (isReady) {
        const ageDays = (now - new Date(c.updated_at).getTime()) / (1000 * 60 * 60 * 24);
        if (ageDays > 7) stalled.push(c);
        else inTransit.push(c);
      }
    }
    return { inTransit, confirmed, stalled };
  }, [checks]);

  const openConfirm = (c: TrackedCheck) => {
    setConfirmTarget(c);
    setConfirmNumber("");
    setConfirmAmount(c.amount != null ? String(c.amount) : "");
  };

  const submitConfirm = async () => {
    if (!confirmTarget) return;
    if (!confirmNumber.trim()) {
      toast.error("Confirmation number is required");
      return;
    }
    setSaving(true);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const { error } = await supabase
      .from("claim_checks")
      .update({
        deposit_confirmation_number: confirmNumber.trim(),
        deposit_confirmed_amount: confirmAmount ? Number(confirmAmount) : null,
        deposit_confirmed_at: new Date().toISOString(),
        deposit_confirmed_by: user?.id ?? null,
        deposit_status: "confirmed",
      })
      .eq("id", confirmTarget.id);
    setSaving(false);
    if (error) {
      toast.error("Failed to confirm deposit: " + error.message);
      return;
    }
    toast.success("Deposit confirmed");
    setConfirmTarget(null);
    load();
  };

  const renderRow = (c: TrackedCheck, allowConfirm: boolean) => (
    <div
      key={c.id}
      className="flex items-center justify-between gap-3 border-b border-border/50 py-2.5 px-3 text-sm last:border-0"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium">#{c.check_number || "—"}</span>
          <span className="text-muted-foreground truncate">{c.payee_line || "Unknown payee"}</span>
          {c.carrier_name && (
            <Badge variant="outline" className="text-[10px]">
              {c.carrier_name}
            </Badge>
          )}
        </div>
        <div className="text-[11px] text-muted-foreground mt-0.5 flex items-center gap-2 flex-wrap">
          <span>{fmtMoney(c.amount)}</span>
          <span>•</span>
          <span>updated {formatDistanceToNow(new Date(c.updated_at), { addSuffix: true })}</span>
          {c.deposit_confirmation_number && (
            <>
              <span>•</span>
              <span className="text-emerald-400">conf #{c.deposit_confirmation_number}</span>
            </>
          )}
        </div>
      </div>
      {allowConfirm ? (
        <Button size="sm" variant="outline" onClick={() => openConfirm(c)}>
          <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
          Confirm Deposit
        </Button>
      ) : c.deposit_confirmed_at ? (
        <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30">
          Confirmed
        </Badge>
      ) : null}
    </div>
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <ListChecks className="h-4 w-4" />
          Check Tracker
          <Badge variant="outline" className="ml-auto text-[10px]">
            {checks.length} tracked
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="mx-3 mt-2">
            <TabsTrigger value="in_transit" className="text-xs gap-1">
              <Clock className="h-3 w-3" />
              In Transit ({buckets.inTransit.length})
            </TabsTrigger>
            <TabsTrigger value="stalled" className="text-xs gap-1">
              <AlertTriangle className="h-3 w-3" />
              Stalled ({buckets.stalled.length})
            </TabsTrigger>
            <TabsTrigger value="confirmed" className="text-xs gap-1">
              <CheckCircle2 className="h-3 w-3" />
              Confirmed ({buckets.confirmed.length})
            </TabsTrigger>
          </TabsList>

          <TabsContent value="in_transit" className="mt-2">
            {buckets.inTransit.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                No checks currently in transit.
              </div>
            ) : (
              buckets.inTransit.map((c) => renderRow(c, true))
            )}
          </TabsContent>

          <TabsContent value="stalled" className="mt-2">
            {buckets.stalled.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                Nothing stalled. Nothing falling through the cracks.
              </div>
            ) : (
              buckets.stalled.map((c) => renderRow(c, true))
            )}
          </TabsContent>

          <TabsContent value="confirmed" className="mt-2">
            {buckets.confirmed.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                No confirmed deposits yet.
              </div>
            ) : (
              buckets.confirmed.slice(0, 100).map((c) => renderRow(c, false))
            )}
          </TabsContent>
        </Tabs>
      </CardContent>

      <Dialog open={!!confirmTarget} onOpenChange={(o) => !o && setConfirmTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm Deposit</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="text-sm text-muted-foreground">
              Check #{confirmTarget?.check_number} — {confirmTarget?.payee_line} —{" "}
              {fmtMoney(confirmTarget?.amount ?? null)}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="conf-num">Confirmation Number *</Label>
              <Input
                id="conf-num"
                value={confirmNumber}
                onChange={(e) => setConfirmNumber(e.target.value)}
                placeholder="e.g. DEP-2026-0427-001"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="conf-amt">Confirmed Amount</Label>
              <Input
                id="conf-amt"
                type="number"
                step="0.01"
                value={confirmAmount}
                onChange={(e) => setConfirmAmount(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmTarget(null)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={submitConfirm} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
