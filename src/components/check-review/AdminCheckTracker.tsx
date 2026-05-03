import { useEffect, useMemo, useState } from "react";
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
import { Label } from "@/components/ui/label";
import {
  Loader2,
  CheckCircle2,
  RefreshCw,
  Search,
  AlertTriangle,
  HelpCircle,
  Clock,
  ShieldAlert,
} from "lucide-react";
import { toast } from "sonner";
import { differenceInDays } from "date-fns";

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
};

type DepositLink = {
  claim_check_id: string | null;
  status: string | null;
  bank_confirmed_at: string | null;
  reconciled_at: string | null;
};

type Bucket = "unverified" | "stuck" | "no_status" | "all";

export function AdminCheckTracker() {
  const [checks, setChecks] = useState<CheckRow[]>([]);
  const [depositMap, setDepositMap] = useState<Record<string, DepositLink>>({});
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [target, setTarget] = useState<CheckRow | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [amount, setAmount] = useState("");
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    const { data: checksData, error } = await supabase
      .from("claim_checks")
      .select(
        "id, claim_id, amount, check_number, carrier_name, payee_line, deposit_status, deposit_confirmation_number, deposit_confirmed_amount, deposit_confirmed_at, created_at, updated_at"
      )
      .order("created_at", { ascending: false })
      .limit(1000);
    if (error) toast.error(error.message);

    const { data: depositData } = await supabase
      .from("deposit_items")
      .select("claim_check_id, status, bank_confirmed_at, reconciled_at")
      .limit(1000);

    const map: Record<string, DepositLink> = {};
    (depositData ?? []).forEach((d: any) => {
      if (d?.claim_check_id) map[d.claim_check_id] = d as DepositLink;
    });

    setChecks(((checksData as any) ?? []) as CheckRow[]);
    setDepositMap(map);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  const classified = useMemo(() => {
    const unverified: CheckRow[] = [];
    const stuck: CheckRow[] = [];
    const noStatus: CheckRow[] = [];
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
      if ((status === "deposited" || status === "cleared") && !link) unverified.push(c);
      if (!settled && ageDays > 14) stuck.push(c);
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
        String(c.amount ?? "").includes(q)
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

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" /> Scanning all checks...
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <ShieldAlert className="h-4 w-4 text-destructive" />
            Check Tracker — Admin Fallback
          </div>
          <p className="text-xs text-muted-foreground max-w-2xl">
            Safety-net to find checks that fell out of the normal Deposit Ops flow. Use this when a
            check seems missing, stuck, or bypassed the pipeline. For everyday deposits, use Deposit
            Ops.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={load}>
          <RefreshCw className="h-3.5 w-3.5 mr-1" /> Rescan
        </Button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <SummaryCard
          icon={<AlertTriangle className="h-3.5 w-3.5" />}
          label="Unverified"
          value={classified.unverified.length}
          tone="destructive"
          hint="Marked deposited but missing from Deposit Ops"
        />
        <SummaryCard
          icon={<Clock className="h-3.5 w-3.5" />}
          label="Stuck >14d"
          value={classified.stuck.length}
          tone="amber"
          hint="Old checks never resolved"
        />
        <SummaryCard
          icon={<HelpCircle className="h-3.5 w-3.5" />}
          label="No Status"
          value={classified.noStatus.length}
          tone="muted"
          hint="Checks with blank deposit status"
        />
        <SummaryCard
          icon={<CheckCircle2 className="h-3.5 w-3.5" />}
          label="Total Checks"
          value={classified.all.length}
          tone="muted"
        />
      </div>

      <div className="relative">
        <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search check #, payee, carrier, amount..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-8 h-9 text-sm"
        />
      </div>

      <Tabs defaultValue="unverified">
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="unverified" className="text-xs">
            Unverified ({classified.unverified.length})
          </TabsTrigger>
          <TabsTrigger value="stuck" className="text-xs">
            Stuck ({classified.stuck.length})
          </TabsTrigger>
          <TabsTrigger value="no_status" className="text-xs">
            No Status ({classified.noStatus.length})
          </TabsTrigger>
          <TabsTrigger value="all" className="text-xs">
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
              : classified.all
          );
          return (
            <TabsContent key={bucket} value={bucket} className="mt-3">
              <Card>
                <CardContent className="p-0 divide-y divide-border/50">
                  {rows.length === 0 ? (
                    <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                      {bucket === "unverified" &&
                        "No unverified checks. Everything reconciles cleanly with Deposit Ops. ✓"}
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
              <div className="rounded-md border border-border/60 p-3 bg-muted/30">
                <p className="text-sm font-medium">
                  {target.payee_line || target.carrier_name || "Check"}
                </p>
                <p className="text-xs text-muted-foreground">
                  Check #{target.check_number ?? "—"} · Expected $
                  {Number(target.amount ?? 0).toLocaleString()}
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="conf-num">Confirmation Number</Label>
                <Input
                  id="conf-num"
                  value={confirmation}
                  onChange={(e) => setConfirmation(e.target.value)}
                  placeholder="e.g. CHK-20260503-001"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="conf-amt">Deposited Amount</Label>
                <Input
                  id="conf-amt"
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
            <Button variant="outline" onClick={() => setTarget(null)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={submitDeposit} disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Mark Reconciled
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
        <div className={`flex items-center gap-1.5 text-[11px] ${toneClass}`}>
          {icon} {label}
        </div>
        <p className="text-xl font-semibold mt-1">{value}</p>
        {hint && <p className="text-[10px] text-muted-foreground mt-0.5 leading-tight">{hint}</p>}
      </CardContent>
    </Card>
  );
}

function Row({
  c,
  link,
  bucket,
  onDeposit,
}: {
  c: CheckRow;
  link?: DepositLink;
  bucket: Bucket;
  onDeposit: () => void;
}) {
  const ageDays = differenceInDays(new Date(), new Date(c.created_at));
  const status = c.deposit_status ?? "—";

  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm">
      <div className="min-w-0 flex-1">
        <div className="font-medium truncate">
          {c.payee_line || c.carrier_name || `Check ${c.id.slice(0, 8)}`}
        </div>
        <div className="text-[11px] text-muted-foreground flex items-center gap-1.5 flex-wrap mt-0.5">
          <span>#{c.check_number ?? "—"}</span>
          <span>·</span>
          <span>${Number(c.amount ?? 0).toLocaleString()}</span>
          <span>·</span>
          <span>{ageDays}d old</span>
          <span>·</span>
          <span>status: {status}</span>
          {link && (
            <>
              <span>·</span>
              <span>deposit_items: {link.status ?? "—"}</span>
            </>
          )}
          {!link && bucket === "unverified" && (
            <>
              <span>·</span>
              <span className="text-destructive">no deposit_items record</span>
            </>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {bucket === "unverified" && (
          <Badge variant="destructive" className="text-[10px]">
            Unverified
          </Badge>
        )}
        {bucket === "stuck" && (
          <Badge className="bg-amber-500/15 text-amber-500 border-amber-500/30 text-[10px]">
            Stuck
          </Badge>
        )}
        {bucket === "no_status" && (
          <Badge variant="outline" className="text-[10px]">
            No Status
          </Badge>
        )}
        <Button size="sm" variant="outline" onClick={onDeposit}>
          Reconcile
        </Button>
      </div>
    </div>
  );
}
