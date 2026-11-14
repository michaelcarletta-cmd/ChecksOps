import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Send, X, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useTenant } from "@/contexts/TenantContext";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { usePaymentProviderEligibility } from "@/hooks/usePaymentProviderEligibility";
import { useStepUp } from "@/hooks/useStepUp";
import { useVendorPayees } from "@/hooks/useVendorPayees";
import { checkSendsQuery } from "@/hooks/useCheckStakeholderList";
import { TRANSFER_FINANCE_QUERY_KEY, useIncomingTransfers } from "@/hooks/useTransferFinance";
import { PAYMENT_FLAGS } from "@/lib/payments/featureFlags";
import { sendPayment, SendPaymentError } from "@/lib/payments/sends";
import {
  dollarsInputToCents,
  partnerPayeeOptions,
  partnerSendAvailableCents,
  partnerSendRecipient,
  type OwnSendLegLike,
  type PartnerPayee,
  type PartnershipLike,
  type StakeholderAccountLike,
  type VendorPayeeLike,
} from "@/lib/payments/partnerSend";

/**
 * Send on a check another organization shares with this one (partnerSend.ts): from this
 * organization's own balance, up to what it received on the check and has not sent on yet, to its
 * own payees. The send route checks the share and every recipient again.
 */
interface Props {
  checkIntakeItemId: string;
  checkNumber?: string;
  /** Settled payments recorded to this organization on the check (claim_check_payments, splits), in cents. */
  settledRecordedCents: number;
}

// Server answers that settle a payment for good, or refuse it before anything is planned: only
// these let the next click start a new payment (the same rule as DisbursementConsole).
const FINAL_SEND_CODES = new Set([
  "send_failed",
  "send_partial",
  "provider_outcome_unknown",
  "idempotency_key_reused",
  "invalid_send_request",
  "check_not_found",
  "facilitator_changed",
]);
const isFinal = (code: string | null) => !!code && (FINAL_SEND_CODES.has(code) || /^(recipient|partner|vendor)_/.test(code));

// tenants_public is a view the generated types do not list.
type TenantsPublicClient = {
  from: (table: "tenants_public") => {
    select: (columns: string) => { in: (column: string, values: string[]) => Promise<{ data: unknown }> };
  };
};

const money = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

export function PartnerSendPanel({ checkIntakeItemId, checkNumber, settledRecordedCents }: Props) {
  const { tenant } = useTenant();
  const tenantId = tenant?.id ?? null;
  const { toast } = useToast();
  const qc = useQueryClient();
  const { requireStepUp } = useStepUp();
  const { enabled: moovEnabled } = usePaymentProviderEligibility();
  const [open, setOpen] = useState(false);
  const [payeeKey, setPayeeKey] = useState<string>("");
  const [amount, setAmount] = useState("");
  const [speed, setSpeed] = useState<"standard" | "same_day">("standard");
  // One key per payment: pressing Send again for the same payment continues it, never pays twice.
  const pendingSend = useRef<{ signature: string; key: string } | null>(null);

  const { data: incoming = [] } = useIncomingTransfers(tenantId);
  const { data: ownLegs = [] } = useQuery(checkSendsQuery(checkIntakeItemId));

  const { data: stakeholders = [] } = useQuery({
    queryKey: ["partner-send-stakeholders", tenantId],
    enabled: !!tenantId && open,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("stakeholder_accounts")
        .select("id, nickname, custname, is_active, origin, is_partner_payout, verification_status, provider, provider_account_id, provider_bank_account_id, provider_bank_name, provider_last_four")
        .eq("tenant_id", tenantId!)
        .eq("is_active", true)
        .order("nickname");
      if (error) throw error;
      return (data ?? []) as unknown as StakeholderAccountLike[];
    },
  });

  const { data: partnerData } = useQuery({
    queryKey: ["partner-send-partnerships", tenantId],
    enabled: !!tenantId && open,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenant_partnerships")
        .select("inviter_tenant_id, invitee_tenant_id, status, revoked_at")
        .eq("status", "active")
        .or(`inviter_tenant_id.eq.${tenantId},invitee_tenant_id.eq.${tenantId}`);
      if (error) throw error;
      const rows = (data ?? []) as unknown as PartnershipLike[];
      const ids = [...new Set(rows.flatMap((p) => [p.inviter_tenant_id, p.invitee_tenant_id]).filter((id) => id && id !== tenantId))];
      const names = new Map<string, string>();
      if (ids.length) {
        const { data: tenants } = await (supabase as unknown as TenantsPublicClient).from("tenants_public").select("id, name").in("id", ids as string[]);
        for (const t of (tenants ?? []) as unknown as { id?: string; name?: string }[]) if (t?.id && t.name) names.set(String(t.id).toLowerCase(), t.name);
      }
      return { rows, names };
    },
  });

  const { data: vendors = [] } = useVendorPayees(tenantId, open && PAYMENT_FLAGS.SHOW_VENDOR_PAYMENTS);

  const availableCents = useMemo(
    () => partnerSendAvailableCents({ incoming, checkId: checkIntakeItemId, settledRecordedCents, ownLegs: ownLegs as unknown as OwnSendLegLike[] }),
    [incoming, checkIntakeItemId, settledRecordedCents, ownLegs],
  );

  const payees = useMemo<PartnerPayee[]>(
    () =>
      tenantId
        ? partnerPayeeOptions({
            tenantId,
            stakeholders,
            partnerships: partnerData?.rows ?? [],
            partnerNames: partnerData?.names ?? null,
            vendors: vendors as VendorPayeeLike[],
            showVendors: PAYMENT_FLAGS.SHOW_VENDOR_PAYMENTS,
          })
        : [],
    [tenantId, stakeholders, partnerData, vendors],
  );
  const payee = payees.find((p) => p.key === payeeKey) ?? null;
  const amountCents = dollarsInputToCents(amount);
  const signature = payee ? JSON.stringify([checkIntakeItemId, speed, payee.key, amountCents]) : "";
  const continuing = !!signature && pendingSend.current?.signature === signature;
  const overAvailable = amountCents > availableCents && !continuing;

  const send = useMutation({
    mutationFn: async () => {
      if (!tenantId || !payee) throw new Error("Choose who to pay.");
      if (amountCents <= 0) throw new Error("Enter an amount.");
      if (overAvailable) throw new Error(`You can send up to ${money(availableCents)} from this check.`);
      if (pendingSend.current?.signature !== signature) {
        pendingSend.current = { signature, key: crypto.randomUUID() };
      }
      const idempotencyKey = pendingSend.current.key;
      const recipients = [partnerSendRecipient(payee, amountCents)];
      const call = () => sendPayment({ tenantId, checkId: checkIntakeItemId, speed, recipients, idempotencyKey });
      const attempt = async () => {
        try {
          return await call();
        } catch (error) {
          // The server decides whether this login has confirmed two-factor; ask only when it says so.
          if (!(error instanceof SendPaymentError) || error.code !== "totp_required") throw error;
          const confirmed = await requireStepUp(
            {
              actionKey: "wallet.fund",
              checkId: null,
              tenantId,
              title: "Confirm payment",
              description: "Enter the 6-digit code from your authenticator app. You'll only be asked once until you sign out.",
            },
            { force: true },
          );
          if (!confirmed) {
            pendingSend.current = null;
            throw new Error("Payment was cancelled. Two-factor confirmation is required.");
          }
          return call();
        }
      };
      // A long send is finished in steps; each step continues the same payment.
      for (let step = 0; ; step += 1) {
        try {
          const result = await attempt();
          pendingSend.current = null;
          return result;
        } catch (error) {
          if (error instanceof SendPaymentError && error.code === "send_incomplete" && step < 8) continue;
          throw error;
        }
      }
    },
    onSuccess: (result) => {
      toast({ title: "Payment sent", description: result?.message ?? `${money(amountCents)} is on its way to ${payee?.name ?? "the recipient"}.` });
      setAmount("");
      setPayeeKey("");
      setOpen(false);
    },
    onError: (e: unknown) => {
      if (e instanceof SendPaymentError) {
        if (isFinal(e.code)) pendingSend.current = null;
        toast({
          title: e.code === "send_partial"
            ? "Partially sent"
            : isFinal(e.code) && e.code !== "provider_outcome_unknown"
              ? "Payment not sent"
              : "Check the payment history",
          description: e.message,
          variant: "destructive",
        });
        return;
      }
      toast({ title: "Payment not sent", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["check-sends", checkIntakeItemId] });
      qc.invalidateQueries({ queryKey: ["funds-released-sends"] });
      qc.invalidateQueries({ queryKey: [TRANSFER_FINANCE_QUERY_KEY] });
      qc.invalidateQueries({ queryKey: ["payment-wallet"] });
    },
  });

  if (!moovEnabled || availableCents <= 0) return null;

  if (!open) {
    return (
      <div className="space-y-1">
        <Button className="w-full h-auto min-h-11 text-sm" onClick={() => setOpen(true)}>
          <Send className="h-4 w-4 mr-1.5 shrink-0" />
          Send from this check
        </Button>
        <p className="text-[10px] text-muted-foreground">
          Up to {money(availableCents)}: what you received on this check and have not sent yet. Paid from your balance.
        </p>
      </div>
    );
  }

  return (
    <Card>
      <CardContent className="pt-3 pb-3 space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium text-muted-foreground tracking-wider">
            Send from {checkNumber ? `check #${checkNumber}` : "this check"}
          </p>
          <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => setOpen(false)} disabled={send.isPending}>
            <X className="h-3 w-3 mr-1" />Cancel
          </Button>
        </div>
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-[11px] text-emerald-700 dark:text-emerald-300">
          Available to send: <span className="font-semibold">{money(availableCents)}</span>
        </div>

        <div className="space-y-1">
          <Label className="text-xs">Pay to</Label>
          <Select value={payeeKey} onValueChange={setPayeeKey} disabled={send.isPending}>
            <SelectTrigger className="h-9 text-sm">
              <SelectValue placeholder={payees.length ? "Choose a recipient" : "No recipients ready to be paid"} />
            </SelectTrigger>
            <SelectContent>
              {payees.map((p) => (
                <SelectItem key={p.key} value={p.key}>
                  {p.name} <span className="text-muted-foreground">· {p.detail}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {payees.length === 0 && (
            <p className="text-[10px] text-muted-foreground">
              Add a verified stakeholder bank account, a partner organization or a vendor in Settings first.
            </p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label className="text-xs">Amount</Label>
            <Input
              inputMode="decimal"
              placeholder="0.00"
              className="h-9 text-sm"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={send.isPending}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Speed</Label>
            <Select value={speed} onValueChange={(v) => setSpeed(v as "standard" | "same_day")} disabled={send.isPending}>
              <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="standard">Next Day</SelectItem>
                <SelectItem value="same_day">Same Day</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        {overAvailable && amountCents > 0 && (
          <p className="text-[11px] text-destructive">You can send up to {money(availableCents)} from this check.</p>
        )}

        <Button
          className="w-full"
          onClick={() => send.mutate()}
          disabled={send.isPending || !payee || amountCents <= 0 || overAvailable}
        >
          {send.isPending ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Send className="h-4 w-4 mr-1.5" />}
          {continuing ? "Finish this payment" : `Send ${amountCents > 0 ? money(amountCents) : ""}`}
        </Button>
        <p className="text-[10px] text-muted-foreground">
          Paid from your ChecksOps balance; any shortfall comes from your linked bank.
        </p>
      </CardContent>
    </Card>
  );
}
