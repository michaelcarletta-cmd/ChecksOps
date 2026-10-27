import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/hooks/use-toast";
import {
  deactivateTenant,
  deleteEmptyTenant,
  describeTenantActivity,
  tenantActivity,
  type TenantActivity,
} from "@/lib/tenantLifecycle";

type LifecycleTenant = { id: string; name: string; slug: string };

/** Deactivate: the company is hidden and its users lose access; every record is kept. */
export function DeactivateTenantDialog({
  tenant,
  onClose,
  onDone,
}: {
  tenant: LifecycleTenant | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => setReason(""), [tenant?.id]);

  const submit = async () => {
    if (!tenant) return;
    setBusy(true);
    try {
      const suspended = await deactivateTenant(tenant.id, reason);
      toast({
        title: `${tenant.name} deactivated`,
        description: `${suspended} user${suspended === 1 ? "" : "s"} lost access. Reactivate it any time from "Show deactivated".`,
      });
      onDone();
      onClose();
    } catch (e) {
      toast({ title: "Not deactivated", description: e instanceof Error ? e.message : "Try again.", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!tenant} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Deactivate {tenant?.name}?</DialogTitle>
          <DialogDescription>
            The company is hidden from this list and its users can no longer open it. Its checks, payments and
            settings are kept, and you can reactivate it later with the same users.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="deactivate-reason">Reason (optional)</Label>
          <Textarea
            id="deactivate-reason"
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Closed account"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="destructive" onClick={submit} disabled={busy}>
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Deactivate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Delete permanently: only for a company with no checks or money movement. Otherwise the
 * dialog lists what it has and offers to deactivate instead.
 */
export function DeleteTenantDialog({
  tenant,
  onClose,
  onDone,
  onDeactivateInstead,
}: {
  tenant: LifecycleTenant | null;
  onClose: () => void;
  onDone: () => void;
  onDeactivateInstead: (tenant: LifecycleTenant) => void;
}) {
  const [activity, setActivity] = useState<TenantActivity | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setActivity(null);
    setLoadError(null);
    setConfirm("");
    if (!tenant) return;
    let cancelled = false;
    tenantActivity(tenant.id)
      .then((a) => { if (!cancelled) setActivity(a); })
      .catch((e) => { if (!cancelled) setLoadError(e instanceof Error ? e.message : "Could not check the company's records."); });
    return () => { cancelled = true; };
  }, [tenant]);

  const matches = !!tenant && confirm.trim().toLowerCase() === tenant.slug.toLowerCase();

  const submit = async () => {
    if (!tenant || !matches) return;
    setBusy(true);
    try {
      await deleteEmptyTenant(tenant.id, confirm);
      toast({ title: `${tenant.name} deleted`, description: "The company and its settings were permanently removed." });
      onDone();
      onClose();
    } catch (e) {
      toast({ title: "Not deleted", description: e instanceof Error ? e.message : "Try again.", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!tenant} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {tenant?.name} permanently?</DialogTitle>
          <DialogDescription>
            Only a company with no checks and no payment records can be deleted. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        {loadError ? (
          <p className="text-sm text-destructive">{loadError}</p>
        ) : !activity ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Checking the company's records…
          </div>
        ) : !activity.empty ? (
          <div className="space-y-2 text-sm" data-testid="tenant-not-empty">
            <p>
              This company has <strong>{describeTenantActivity(activity.counts)}</strong>. Those records must be kept,
              so it can only be deactivated.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            <Label htmlFor="delete-confirm">
              Type <span className="font-mono">{tenant?.slug}</span> to confirm
            </Label>
            <Input
              id="delete-confirm"
              value={confirm}
              autoComplete="off"
              onChange={(e) => setConfirm(e.target.value)}
              placeholder={tenant?.slug}
            />
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          {activity && !activity.empty && tenant ? (
            <Button variant="destructive" onClick={() => { onClose(); onDeactivateInstead(tenant); }}>
              Deactivate instead
            </Button>
          ) : (
            <Button variant="destructive" onClick={submit} disabled={busy || !activity?.empty || !matches}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Delete permanently
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
