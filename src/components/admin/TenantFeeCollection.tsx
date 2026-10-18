import { useCallback, useEffect, useState } from "react";
import { toast as sonnerToast } from "sonner";
import { Loader2, Landmark, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { SectionCard } from "@/components/settings/SectionCard";
import {
  OUTDATED_BILLING_SERVICE,
  feeErrorText,
  getFeeDestination,
  isUsableFeePreview,
  previewTenantFees,
  pullTenantFees,
  reasonText,
  resendTenantFeeInvoice,
  setFeeDestination,
  usd,
  verifyTenantBillingDebit,
  type FeeDestinationStatus,
  type FeePreview,
} from "@/lib/tenantFeeBilling";

/**
 * Collect fees for one tenant period: server preview first, a confirm dialog
 * with the server total, then the pull with the preview hash. The browser
 * never computes or sends an amount; double clicks are ignored while a step
 * is in flight and the server allows one charge per tenant period.
 */
export function TenantFeeCollectButton({
  tenantId,
  tenantName,
  period,
  label = "Preview & collect fees",
  onCollected,
}: {
  tenantId: string;
  tenantName: string;
  period?: string;
  label?: string;
  onCollected?: () => void;
}) {
  const [busy, setBusy] = useState<"preview" | "pull" | null>(null);
  const [preview, setPreview] = useState<FeePreview | null>(null);

  const openPreview = async () => {
    if (busy) return;
    setBusy("preview");
    const result = await previewTenantFees(tenantId, period);
    setBusy(null);
    if (!result.ok) {
      sonnerToast.error(feeErrorText(result));
      return;
    }
    if (!isUsableFeePreview(result)) {
      sonnerToast.error(OUTDATED_BILLING_SERVICE);
      return;
    }
    setPreview(result);
  };

  const collect = async () => {
    if (!preview || busy) return;
    setBusy("pull");
    const result = await pullTenantFees(tenantId, preview.period, preview.preview_hash);
    setBusy(null);
    setPreview(null);
    if (!result.ok) {
      sonnerToast.error(result.error === "preview_mismatch"
        ? "The invoice changed since the preview. Nothing was charged; preview again."
        : feeErrorText(result));
      return;
    }
    if (result.duplicate) {
      sonnerToast.info(`Already collected for ${preview.period}; nothing was charged again.`);
    } else if (result.charged) {
      const simulated = result.pull?.simulated ? " (simulated)" : "";
      sonnerToast.success(`ACH debit of ${usd(result.amount_cents_posted)} submitted for ${preview.period}${simulated}.`);
      const email = result.pull?.invoice_email?.status;
      if (email === "failed" || email === "no_recipient") {
        sonnerToast.warning("The invoice email was not sent. The charge stands; use Resend invoice email from the preview.");
      }
    } else {
      sonnerToast.error(`Collection failed: ${result.pull?.error ? reasonText(result.pull.error) : "the provider refused"}. The attempt is recorded.`);
    }
    onCollected?.();
  };

  const resendInvoice = async () => {
    if (!preview || busy) return;
    setBusy("pull");
    const result = await resendTenantFeeInvoice(tenantId, preview.period);
    setBusy(null);
    const status = result.invoice_email?.status;
    if (!result.ok) sonnerToast.error(feeErrorText(result));
    else if (status === "already_sent") sonnerToast.info(`The ${preview.period} invoice email was already sent.`);
    else if (status === "sent" || status === "sunk") sonnerToast.success(`Invoice email for ${preview.period} sent.`);
    else if (status === "disabled") sonnerToast.info("Invoice emails are turned off on this environment.");
    else sonnerToast.error(`Invoice email not sent (${status || "failed"}). It is recorded; try again later.`);
  };

  const blocked = preview ? (!preview.readiness.ready || preview.already_charged) : true;

  return (
    <>
      <Button size="sm" onClick={openPreview} disabled={busy !== null}>
        {busy === "preview" ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
        {label}
      </Button>
      <AlertDialog open={preview !== null} onOpenChange={(open) => { if (!open && busy === null) setPreview(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Collect {preview ? usd(preview.amount_cents) : ""} from {tenantName}?</AlertDialogTitle>
            <AlertDialogDescription>
              Period {preview?.period}. Computed by the server from this organization&apos;s Billing tab rates and
              recorded usage, pulled by ACH from the bank account the organization authorized into the ChecksOps
              platform account.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {preview && (
            <div className="space-y-3 text-sm">
              <table className="w-full">
                <tbody className="divide-y">
                  {preview.summary.map((line) => (
                    <tr key={line.key}>
                      <td className="py-1">{line.label}{line.count > 1 ? ` (${line.count})` : ""}</td>
                      <td className="py-1 text-right tabular-nums">{usd(line.amount_cents)}</td>
                    </tr>
                  ))}
                  <tr className="font-semibold">
                    <td className="py-1">Total to collect</td>
                    <td className="py-1 text-right tabular-nums">{usd(preview.amount_cents)}</td>
                  </tr>
                </tbody>
              </table>
              {preview.existing_charge && (
                <p className="text-xs text-muted-foreground">
                  This period is already booked ({preview.existing_charge.status}, {usd(preview.existing_charge.amount_cents)}).
                  {preview.already_charged ? " It will not be charged again." : " Collecting retries the booked amount."}
                </p>
              )}
              {!preview.readiness.ready && !preview.already_charged && (
                <ul className="list-disc pl-5 text-xs text-destructive">
                  {preview.readiness.reasons.map((reason) => <li key={reason}>{reasonText(reason)}</li>)}
                </ul>
              )}
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy !== null}>Cancel</AlertDialogCancel>
            {preview?.already_charged && preview.existing_charge?.status !== "returned" && (
              <Button variant="outline" disabled={busy !== null} onClick={() => { void resendInvoice(); }}>
                Resend invoice email
              </Button>
            )}
            <AlertDialogAction
              disabled={blocked || busy !== null}
              onClick={(event) => { event.preventDefault(); void collect(); }}
            >
              {busy === "pull" ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
              Collect {preview ? usd(preview.amount_cents) : ""}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/**
 * $1.00 billing verification debit. Platform owner only; amount fixed by the
 * server. `disabledReason` (no verified / authorized bank account yet) disables
 * it with a short hint.
 */
export function TenantBillingVerifyButton({
  tenantId,
  tenantName,
  disabledReason,
}: {
  tenantId: string;
  tenantName: string;
  disabledReason?: string | null;
}) {
  const [verificationId, setVerificationId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (!verificationId || busy) return;
    setBusy(true);
    const result = await verifyTenantBillingDebit(tenantId, verificationId);
    setBusy(false);
    setVerificationId(null);
    if (!result.ok) return sonnerToast.error(feeErrorText(result));
    if (result.charged) {
      sonnerToast.success(`$1.00 verification debit submitted${result.verify?.simulated ? " (simulated)" : ""}.`);
    } else if (result.duplicate) {
      sonnerToast.info("That verification was already submitted.");
    } else {
      sonnerToast.error(`Verification failed: ${result.verify?.error ? reasonText(result.verify.error) : "the provider refused"}. The attempt is recorded.`);
    }
  };

  return (
    <>
      <div className="flex flex-col items-end gap-0.5">
        <Button
          size="sm"
          variant="outline"
          onClick={() => setVerificationId(crypto.randomUUID())}
          disabled={busy || !!disabledReason}
          title={disabledReason || undefined}
        >
          <ShieldCheck className="w-4 h-4 mr-1" /> Verify billing debit ($1)
        </Button>
        {disabledReason && <span className="text-[10px] text-muted-foreground">{disabledReason}</span>}
      </div>
      <AlertDialog open={verificationId !== null} onOpenChange={(open) => { if (!open && !busy) setVerificationId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Debit $1.00 from {tenantName}?</AlertDialogTitle>
            <AlertDialogDescription>
              A one-time $1.00 ACH debit from the bank account the organization authorized, into the ChecksOps
              platform account, to verify that billing debits work.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={(event) => { event.preventDefault(); void run(); }}>
              {busy ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
              Debit $1.00
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/**
 * Where tenant fees land: the ChecksOps platform Moov account and payment
 * method. Read-only status plus a set action (platform owner only; the server
 * refuses any account other than the ChecksOps platform account).
 */
export function PlatformFeeDestinationCard() {
  const [status, setStatus] = useState<FeeDestinationStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [accountId, setAccountId] = useState("");
  const [paymentMethodId, setPaymentMethodId] = useState("");
  const [label, setLabel] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const result = await getFeeDestination();
    setLoading(false);
    if (!result.ok || !result.destination || typeof result.destination !== "object") {
      setLoadError(result.ok ? OUTDATED_BILLING_SERVICE : feeErrorText(result));
      return;
    }
    setStatus(result.destination);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const startEdit = () => {
    setAccountId(status?.account_id ?? status?.expected_sandbox_account_id ?? "");
    setPaymentMethodId(status?.payment_method_id ?? "");
    setLabel(status?.label ?? "ChecksOps platform account");
    setEditing(true);
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    const result = await setFeeDestination({ accountId, paymentMethodId, label });
    setSaving(false);
    if (!result.ok) {
      sonnerToast.error(feeErrorText(result));
      return;
    }
    if (result.destination && typeof result.destination === "object") setStatus(result.destination);
    else void load();
    setEditing(false);
    sonnerToast.success("Fee destination saved");
  };

  return (
    <SectionCard
      title="Fee destination"
      icon={<Landmark className="h-4 w-4 text-emerald-500" />}
      accent="bg-gradient-to-r from-emerald-500 to-emerald-500/30"
      description="Tenant fees are pulled into the ChecksOps platform account. Only the platform owner can set it; collection is refused while it is unset."
    >
      {loading ? (
        <div className="flex justify-center py-4"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
      ) : loadError ? (
        <div className="space-y-2 text-sm">
          <p className="font-medium">Couldn&apos;t load the fee destination</p>
          <p className="text-xs text-muted-foreground">{loadError}</p>
          <Button size="sm" variant="outline" onClick={() => { void load(); }}>Retry</Button>
        </div>
      ) : (
        <div className="space-y-3 text-sm">
          <div className="flex items-center gap-2">
            <Badge variant={status?.configured ? "default" : "destructive"}>
              {status?.configured ? "Configured" : "Not set"}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {status?.environment}{status?.source ? ` · from ${status.source === "env" ? "Lambda configuration" : "Tenant Management"}` : ""}
            </span>
          </div>
          {status?.configured ? (
            <div className="font-mono text-xs space-y-1">
              <div>Account {status.account_id}</div>
              <div>Payment method {status.payment_method_id}</div>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              {status?.reason || status?.error ? reasonText(String(status?.reason || status?.error)) : "No fee destination is set."}
            </p>
          )}
          {status?.env_override && (
            <p className="text-xs text-muted-foreground">Set by Lambda configuration; that value wins over a value saved here.</p>
          )}
          {editing ? (
            <div className="space-y-2">
              <div className="space-y-1">
                <Label htmlFor="fee-dest-account" className="text-xs">Platform Moov account id</Label>
                <Input id="fee-dest-account" value={accountId} onChange={(e) => setAccountId(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="fee-dest-method" className="text-xs">Platform payment method id (bank or wallet)</Label>
                <Input id="fee-dest-method" value={paymentMethodId} onChange={(e) => setPaymentMethodId(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="fee-dest-label" className="text-xs">Label</Label>
                <Input id="fee-dest-label" value={label} onChange={(e) => setLabel(e.target.value)} />
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={save} disabled={saving || !accountId || !paymentMethodId}>
                  {saving ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null} Save destination
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={saving}>Cancel</Button>
              </div>
            </div>
          ) : (
            <Button size="sm" variant="outline" onClick={startEdit}>Set destination</Button>
          )}
        </div>
      )}
    </SectionCard>
  );
}
