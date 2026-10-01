import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Loader2,
  CheckCircle2,
  RefreshCw,
  Search,
  AlertTriangle,
  HelpCircle,
  Clock,
  ShieldAlert,
  Pencil,
  ArrowRightCircle,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { format, differenceInDays } from "date-fns";
import { CheckAdminEditDialog } from "./CheckAdminEditDialog";

type CheckRow = {
  id: string;
  claim_id: string | null;
  amount: number | null;
  check_number: string | null;
  carrier_name: string | null;
  payee_line: string | null;
  deposit_status: string | null;
  deposit_confirmation_number: string | null;
  deposit_confirmed_amount: number | null;
  deposit_confirmed_at: string | null;
  created_at: string;
  updated_at?: string | null;
  check_intake_item_id?: string | null;
};

const ROUTE_OPTIONS: Array<{ value: string; label: string; hint: string }> = [
  { value: "needs_review", label: "Review", hint: "Top box: Review" },
  { value: "endorsements_in_progress", label: "Endorsing", hint: "Top box: Endorsing" },
  { value: "loss_draft_required", label: "Loss Draft", hint: "Top box: Loss Draft" },
  { value: "reissue_requested", label: "Reissue", hint: "Top box: Reissue" },
  { value: "voided", label: "Void", hint: "Top box: Void" },
];

type DepositLink = {
  check_id: string | null; // points at check_intake_items.id
  status: string | null;
  bank_confirmed_at: string | null;
  reconciled_at: string | null;
};

type Bucket = "unverified" | "stuck" | "no_status" | "all";

export function AdminCheckTracker({ searchQuery = "" }: { searchQuery?: string }) {
  const qc = useQueryClient();
  const [checks, setChecks] = useState<CheckRow[]>([]);
  const [depositMap, setDepositMap] = useState<Record<string, DepositLink>>({});
  const [loading, setLoading] = useState(true);
  const [localSearch, setLocalSearch] = useState("");
  const search = searchQuery || localSearch;
  const [target, setTarget] = useState<CheckRow | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [amount, setAmount] = useState("");
  const [saving, setSaving] = useState(false);
  const [editingIntakeId, setEditingIntakeId] = useState<string | null>(null);
  const [routing, setRouting] = useState<string | null>(null); // check_intake_item_id currently being routed
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CheckRow | null>(null);
  const [deleteReason, setDeleteReason] = useState("");

  async function load() {
    setLoading(true);
    const { data: checksData, error: checksErr } = await supabase
      .from("claim_checks")
      .select(
        "id, claim_id, amount, check_number, carrier_name, payee_line, deposit_status, deposit_confirmation_number, deposit_confirmed_amount, deposit_confirmed_at, created_at, updated_at, check_intake_item_id",
      )
      .order("created_at", { ascending: false })
      .limit(1000);
    if (checksErr) toast.error(checksErr.message);

    // Cross-reference deposit_items via check_intake_item_id (the canonical link)
    const { data: depositData } = await supabase
      .from("deposit_items")
      .select("check_id, status, bank_confirmed_at, reconciled_at")
      .limit(1000);

    // Map keyed by claim_checks.id (resolved through check_intake_item_id)
    const map: Record<string, DepositLink> = {};
    const intakeToDeposit: Record<string, DepositLink> = {};
    (depositData ?? []).forEach((d: any) => {
      if (d?.check_id) intakeToDeposit[d.check_id] = d;
    });
    ((checksData as any) ?? []).forEach((c: any) => {
      if (c.check_intake_item_id && intakeToDeposit[c.check_intake_item_id]) {
        map[c.id] = intakeToDeposit[c.check_intake_item_id];
      }
    });

    setChecks((checksData as any) ?? []);
    setDepositMap(map);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  const classified = useMemo(() => {
    const unverified: CheckRow[] = []; // marked deposited locally but no bank-side record
    const stuck: CheckRow[] = []; // sitting >14 days with no resolution
    const noStatus: CheckRow[] = []; // null/blank deposit_status entirely
    const all: CheckRow[] = checks;

    for (const c of checks) {
      const link = depositMap[c.id];
      const status = (c.deposit_status ?? "").toLowerCase();
      const ageDays = differenceInDays(new Date(), new Date(c.created_at));
      const settled =
        status === "deposited" ||
        status === "cleared" ||
        link?.status === "succeeded" ||
        link?.status === "reconciled";

      if (!c.deposit_status) noStatus.push(c);

      // Unverified: marked deposited locally but never appeared in deposit_items pipeline
      if ((status === "deposited" || status === "cleared") && !link) {
        unverified.push(c);
      }

      // Stuck: not settled and older than 14 days
      if (!settled && ageDays > 14) {
        stuck.push(c);
      }
    }

    return { unverified, stuck, noStatus, all };
  }, [checks, depositMap]);

  const filterRows = (rows: CheckRow[]) => {
    if (!search.trim()) return rows;
    const q = search.toLowerCase();
    return rows.filter(
      (c) =>
        c.check_number?.toLowerCase().includes(q) ||
        c.carrier_name?.toLowerCase().includes(q) ||
        c.payee_line?.toLowerCase().includes(q) ||
        c.id.toLowerCase().includes(q) ||
        String(c.amount ?? "").includes(q),
    );
  };

  function openDeposit(c: CheckRow) {
    setTarget(c);
    setConfirmation(c.deposit_confirmation_number ?? "");
    setAmount(c.amount ? String(c.amount) : "");
  }

  async function submitDeposit() {
    if (!target) return;
    if (!confirmation.trim()) return toast.error("Confirmation number required");
    const numAmount = Number(amount);
    if (!numAmount || numAmount <= 0) return toast.error("Valid amount required");

    setSaving(true);
    const { data: userData } = await supabase.auth.getUser();
    const { error } = await supabase
      .from("claim_checks")
      .update({
        deposit_status: "deposited",
        deposit_confirmation_number: confirmation.trim(),
        deposit_confirmed_amount: numAmount,
        deposit_confirmed_at: new Date().toISOString(),
        deposit_confirmed_by: userData.user?.id ?? null,
      })
      .eq("id", target.id);
    setSaving(false);
    if (error) return toast.error(error.message);
    toast.success("Check manually reconciled");
    setTarget(null);
    load();
  }

  /** Permanently delete a check through the AWS workflow delete operation. Admin only. */
  async function deleteCheck(c: CheckRow) {
    setDeleting(c.id);
    try {
      const intakeId = c.check_intake_item_id;
      if (!intakeId) throw new Error("This check has no linked intake record and cannot be deleted through the AWS workflow.");
      const { data: ud } = await supabase.auth.getUser();
      if (!ud.user?.id) throw new Error("Your session has expired. Please sign in again.");
      const { error } = await supabase.rpc("admin_delete_check" as any, {
        p_check_id: intakeId,
        p_actor_id: ud.user.id,
        p_reason: deleteReason.trim(),
      });
      if (error) throw error;

      toast.success("Check deleted");
      setDeleteTarget(null);
      setDeleteReason("");
      qc.invalidateQueries({ queryKey: ["check-intake-items"] });
      qc.invalidateQueries({ queryKey: ["check-review-queue"] });
      qc.invalidateQueries({ queryKey: ["loss-draft-checks"] });
      load();
    } catch (e: any) {
      console.error("[AdminCheckTracker] deleteCheck failed", e);
      toast.error(e?.message || "Failed to delete check");
    } finally {
      setDeleting(null);
    }
  }

  /** Reroute a check to a different status. Updates check_intake_items.status if linked,
   *  otherwise falls back to claim_checks.deposit_status mapping. */
  async function routeTo(c: CheckRow, newStatus: string) {
    setRouting(c.id);
    try {
      const intakeId = c.check_intake_item_id;
      console.log("[AdminCheckTracker] routeTo", { checkId: c.id, intakeId, newStatus });
      if (intakeId) {
        // Route through the admin override RPC (SECURITY DEFINER) so stage,
        // status, claim_checks mirror and audit stay in sync.
        const { data: ud } = await supabase.auth.getUser();
        const { error } = await supabase.rpc("admin_override_check_status", {
          p_check_id: intakeId,
          p_new_status: newStatus,
          p_actor_id: ud.user?.id ?? null,
        } as any);
        if (error) throw error;
      } else {
        // No intake item linked — fall back to claim_checks only
        const depositStatus =
          newStatus === "approved_for_deposit" ? "ready"
          : newStatus === "deposited" ? "deposited"
          : newStatus === "voided" ? "voided"
          : "pending";
        const { error, data } = await supabase
          .from("claim_checks")
          .update({ deposit_status: depositStatus })
          .eq("id", c.id)
          .select("id");
        if (error) throw error;
        if (!data || data.length === 0) {
          throw new Error("Update returned no rows — likely blocked by row-level security.");
        }
      }
      toast.success(`Routed to "${newStatus.replace(/_/g, " ")}"`);
      // Invalidate parent caches so the Review/Endorsements/Ready tabs refresh too
      qc.invalidateQueries({ queryKey: ["check-intake-items"] });
      qc.invalidateQueries({ queryKey: ["check-review-queue"] });
      qc.invalidateQueries({ queryKey: ["loss-draft-checks"] });
      load();
    } catch (e: any) {
      console.error("[AdminCheckTracker] routeTo failed", e);
      toast.error(e?.message || "Failed to reroute check");
    } finally {
      setRouting(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-6 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Scanning all checks...
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-amber-500" /> Check Tracker — Admin Fallback
          </h2>
          <p className="text-xs text-muted-foreground max-w-xl">
            Safety-net to find checks that fell out of the normal Deposit Ops flow. Use this when a
            check seems missing, stuck, or bypassed the pipeline. For everyday deposits, use Deposit
            Ops.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={load}>
          <RefreshCw className="h-3 w-3 mr-1" /> Rescan
        </Button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <SummaryCard
          icon={<HelpCircle className="h-4 w-4" />}
          label="Unverified"
          value={classified.unverified.length}
          tone="destructive"
          hint="Marked deposited but missing from Deposit Ops"
        />
        <SummaryCard
          icon={<Clock className="h-4 w-4" />}
          label="Stuck >14d"
          value={classified.stuck.length}
          tone="amber"
          hint="Old checks never resolved"
        />
        <SummaryCard
          icon={<AlertTriangle className="h-4 w-4" />}
          label="No Status"
          value={classified.noStatus.length}
          tone="muted"
          hint="Checks with blank deposit status"
        />
        <SummaryCard
          icon={<CheckCircle2 className="h-4 w-4" />}
          label="Total Checks"
          value={classified.all.length}
          tone="muted"
        />
      </div>

      {!searchQuery && (
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Search by check #, carrier, payee, amount, or check ID..."
            value={localSearch}
            onChange={(e) => setLocalSearch(e.target.value)}
            className="pl-8 h-9 text-sm"
          />
        </div>
      )}

      <Tabs defaultValue="unverified">
        <TabsList className="w-full">
          <TabsTrigger value="unverified" className="flex-1 text-xs">
            Unverified ({classified.unverified.length})
          </TabsTrigger>
          <TabsTrigger value="stuck" className="flex-1 text-xs">
            Stuck ({classified.stuck.length})
          </TabsTrigger>
          <TabsTrigger value="no_status" className="flex-1 text-xs">
            No Status ({classified.noStatus.length})
          </TabsTrigger>
          <TabsTrigger value="all" className="flex-1 text-xs">
            All ({classified.all.length})
          </TabsTrigger>
        </TabsList>

        {(["unverified", "stuck", "no_status", "all"] as Bucket[]).map((bucket) => {
          const rows = filterRows(
            bucket === "unverified"
              ? classified.unverified
              : bucket === "stuck"
                ? classified.stuck
                : bucket === "no_status"
                  ? classified.noStatus
                  : classified.all,
          );
          return (
            <TabsContent key={bucket} value={bucket} className="mt-3">
              <Card>
                <CardContent className="p-0 divide-y max-h-none overflow-x-auto overflow-y-visible lg:max-h-[600px] lg:overflow-auto">
                  {rows.length === 0 ? (
                    <div className="p-6 text-sm text-muted-foreground text-center">
                      {bucket === "unverified" && "No unverified checks. Everything reconciles cleanly with Deposit Ops. ✓"}
                      {bucket === "stuck" && "No stuck checks. ✓"}
                      {bucket === "no_status" && "Every check has a deposit status. ✓"}
                      {bucket === "all" && "No checks found."}
                    </div>
                  ) : (
                    rows.map((c) => (
                      <Row
                        key={c.id}
                        c={c}
                        link={depositMap[c.id]}
                        bucket={bucket}
                        onDeposit={() => openDeposit(c)}
                        onEdit={
                          c.check_intake_item_id
                            ? () => setEditingIntakeId(c.check_intake_item_id!)
                            : undefined
                        }
                        onRoute={(s) => routeTo(c, s)}
                        routing={routing === c.id}
                        onDelete={() => setDeleteTarget(c)}
                        deleting={deleting === c.id}
                      />
                    ))
                  )}
                </CardContent>
              </Card>
            </TabsContent>
          );
        })}
      </Tabs>

      <Dialog open={!!target} onOpenChange={(o) => !o && setTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Manual Deposit Reconciliation</DialogTitle>
            <DialogDescription>
              Use this fallback only when a check was deposited outside the normal Deposit Ops flow.
              Enter the bank confirmation number and the actual amount deposited.
            </DialogDescription>
          </DialogHeader>
          {target && (
            <div className="space-y-3">
              <div className="rounded-md bg-muted p-3 text-sm">
                <div className="font-medium">{target.payee_line || target.carrier_name || "Check"}</div>
                <div className="text-xs text-muted-foreground">
                  Check #{target.check_number ?? "—"} · Expected ${Number(target.amount ?? 0).toLocaleString()}
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="conf">Confirmation Number</Label>
                <Input
                  id="conf"
                  value={confirmation}
                  onChange={(e) => setConfirmation(e.target.value)}
                  placeholder="e.g. CHK-20260503-001"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="amt">Deposited Amount</Label>
                <Input
                  id="amt"
                  type="number"
                  step="0.01"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.00"
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setTarget(null)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={submitDeposit} disabled={saving}>
              {saving && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
              Mark Reconciled
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteTarget} onOpenChange={(o) => {
        if (!o) {
          setDeleteTarget(null);
          setDeleteReason("");
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <Trash2 className="h-4 w-4" /> Permanently Delete Check?
            </DialogTitle>
            <DialogDescription>
              This will remove the check from the database, including its intake record, endorsements, and any deposit_items rows. This cannot be undone. An audit log entry will be written before deletion.
            </DialogDescription>
          </DialogHeader>
          {deleteTarget && (
            <div className="rounded-md bg-muted p-3 text-sm">
              <div className="font-medium">{deleteTarget.payee_line || deleteTarget.carrier_name || "Check"}</div>
              <div className="text-xs text-muted-foreground">
                Check #{deleteTarget.check_number ?? "—"} · ${Number(deleteTarget.amount ?? 0).toLocaleString()}
              </div>
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="tracker-delete-reason">Reason for deletion</Label>
            <Textarea
              id="tracker-delete-reason"
              value={deleteReason}
              onChange={(e) => setDeleteReason(e.target.value)}
              placeholder="Enter a reason (at least 3 characters)"
              rows={3}
              disabled={!!deleting}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)} disabled={!!deleting}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteTarget && deleteCheck(deleteTarget)}
              disabled={!!deleting || deleteReason.trim().length < 3}
            >
              {deleting ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Trash2 className="h-3 w-3 mr-1" />}
              Delete Check
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {editingIntakeId && (
        <CheckAdminEditDialog
          checkId={editingIntakeId}
          open={!!editingIntakeId}
          onOpenChange={(o) => !o && setEditingIntakeId(null)}
          onSaved={() => {
            setEditingIntakeId(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function SummaryCard({
  icon,
  label,
  value,
  tone,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  tone: "destructive" | "amber" | "muted";
  hint?: string;
}) {
  const toneClass =
    tone === "destructive"
      ? "text-destructive"
      : tone === "amber"
        ? "text-amber-500"
        : "text-muted-foreground";
  return (
    <Card>
      <CardContent className="p-3">
        <div className={`flex items-center gap-2 text-xs ${toneClass}`}>
          {icon} {label}
        </div>
        <div className="text-2xl font-semibold">{value}</div>
        {hint && <div className="text-[10px] text-muted-foreground mt-0.5 leading-tight">{hint}</div>}
      </CardContent>
    </Card>
  );
}

function Row({
  c,
  link,
  bucket,
  onDeposit,
  onEdit,
  onRoute,
  routing = false,
  onDelete,
  deleting = false,
}: {
  c: CheckRow;
  link?: DepositLink;
  bucket: Bucket;
  onDeposit: () => void;
  onEdit?: () => void;
  onRoute: (newStatus: string) => void;
  routing?: boolean;
  onDelete: () => void;
  deleting?: boolean;
}) {
  const ageDays = differenceInDays(new Date(), new Date(c.created_at));
  const status = c.deposit_status ?? "—";

  return (
    <div className="p-3 flex flex-col md:flex-row md:items-center justify-between gap-3 text-sm">
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate">
          {c.payee_line || c.carrier_name || `Check ${c.id.slice(0, 8)}`}
        </div>
        <div className="text-xs text-muted-foreground flex flex-wrap gap-x-2">
          <span>#{c.check_number ?? "—"}</span>
          <span>${Number(c.amount ?? 0).toLocaleString()}</span>
          <span>· {ageDays}d old</span>
          <span>· status: {status}</span>
          {link && <span>· deposit_items: {link.status ?? "—"}</span>}
          {!link && bucket === "unverified" && (
            <span className="text-destructive">· no deposit_items record</span>
          )}
          {!c.check_intake_item_id && (
            <span className="text-amber-500">· no intake link</span>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {bucket === "unverified" && <Badge variant="destructive" className="text-[10px]">Unverified</Badge>}
        {bucket === "stuck" && <Badge variant="outline" className="text-[10px] border-amber-500 text-amber-600">Stuck</Badge>}
        {bucket === "no_status" && <Badge variant="outline" className="text-[10px]">No Status</Badge>}

        {/* Route to a different status — controlled + reset so the same value can be re-selected */}
        <RouteSelect onRoute={onRoute} routing={routing} />

        {onEdit && (
          <Button size="sm" variant="outline" onClick={onEdit} title="Open full editor">
            <Pencil className="h-3 w-3 mr-1" /> Edit
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={onDeposit}>
          Reconcile
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={onDelete}
          disabled={deleting}
          className="border-destructive/50 text-destructive hover:bg-destructive/10"
          title="Permanently delete this check"
        >
          {deleting ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Trash2 className="h-3 w-3 mr-1" />}
          Delete
        </Button>
      </div>
    </div>
  );
}

/** Controlled wrapper around the route Select so re-selecting the same value still fires. */
function RouteSelect({ onRoute, routing }: { onRoute: (s: string) => void; routing: boolean }) {
  const [val, setVal] = useState<string>("");
  return (
    <Select
      value={val}
      onValueChange={(v) => {
        setVal(v);
        onRoute(v);
        // Reset on next tick so the same option can be picked again later.
        setTimeout(() => setVal(""), 0);
      }}
      disabled={routing}
    >
      <SelectTrigger className="h-8 w-[180px] text-xs">
        <ArrowRightCircle className="h-3 w-3 mr-1" />
        <SelectValue placeholder={routing ? "Routing…" : "Override Status (admin)"} />
      </SelectTrigger>
      <SelectContent>
        {ROUTE_OPTIONS.map((o) => (
          <SelectItem key={o.value} value={o.value} className="text-xs">
            <div className="flex flex-col">
              <span>{o.label}</span>
              <span className="text-[10px] text-muted-foreground">{o.hint}</span>
            </div>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
