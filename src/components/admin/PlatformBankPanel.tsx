import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/aws/client";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  Landmark,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Plus,
  CheckCircle2,
  AlertTriangle,
  Copy,
} from "lucide-react";

/**
 * Platform (master merchant) banking panel.
 *
 * Links and verifies the settlement bank account on the ChecksOps platform
 * payment account so Tenant Management can pull funds from and send funds to
 * tenant accounts. Every action goes through the `moov-platform-bank`
 * function, which is locked to the platform owner login.
 */

type Capability = { capability: string; status: string };

type PlatformMethod = {
  id: string;
  bank_account_id: string;
  bank_name: string | null;
  last_four: string | null;
  account_type: string | null;
  holder_name: string | null;
  verification_status: string;
  connection_status: string;
  is_default: boolean;
  connected_at: string | null;
  micro_deposit: { status: string; attempts: number } | null;
};

type StatusPayload = {
  success: boolean;
  environment: string;
  platform_account_id: string;
  profile: { displayName: string | null; accountType: string | null; verificationStatus: string | null };
  capabilities: Capability[];
  provider_bank_accounts: Array<{
    bank_account_id: string;
    bank_name: string | null;
    last_four: string | null;
    status: string | null;
  }>;
  methods: PlatformMethod[];
  warnings: string[];
  error?: string;
};

function statusBadge(status: string | null | undefined) {
  const s = (status ?? "unknown").toLowerCase();
  if (s === "verified" || s === "enabled") {
    return <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30">{s}</Badge>;
  }
  if (s === "pending" || s === "pending_micro_deposit" || s === "review" || s === "inreview") {
    return <Badge className="bg-amber-500/15 text-amber-400 border-amber-500/30">{s.replace(/_/g, " ")}</Badge>;
  }
  if (s === "new" || s === "unverified") {
    return <Badge variant="outline" className="text-muted-foreground">{s}</Badge>;
  }
  return <Badge className="bg-red-500/15 text-red-400 border-red-500/30">{s.replace(/_/g, " ")}</Badge>;
}

export function PlatformBankPanel() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [state, setState] = useState<StatusPayload | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("moov-platform-bank", {
        body: { action: "status" },
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      setState(data as StatusPayload);
    } catch (err: any) {
      toast({
        title: "Couldn't load platform banking",
        description: err?.message ?? "An unexpected error occurred.",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  async function initiateMicroDeposit(methodId: string) {
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke("moov-platform-bank", {
        body: { action: "initiate_micro_deposit", payment_method_id: methodId },
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).message ?? (data as any).error);
      if ((data as any)?.already_verified) {
        toast({ title: "Already verified", description: "This bank account is already verified." });
        await load();
        return;
      }
      toast({
        title: "Micro-deposit sent",
        description: "A $0.01 deposit with an MV#### code is on its way to the bank. It usually arrives within minutes.",
      });
      setVerifyingId(methodId);
      setCode("");
      await load();
    } catch (err: any) {
      toast({ title: "Couldn't start verification", description: err?.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function confirmMicroDeposit(methodId: string) {
    if (!/^\d{4}$/.test(code)) return;
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke("moov-platform-bank", {
        body: { action: "confirm_micro_deposit", payment_method_id: methodId, code },
      });
      if (error) throw error;
      if ((data as any)?.error) {
        throw new Error((data as any).message ?? "That code did not match.");
      }
      toast({ title: "Bank account verified", description: "The platform settlement bank is ready to move money." });
      setVerifyingId(null);
      setCode("");
      await load();
    } catch (err: any) {
      toast({ title: "Verification failed", description: err?.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  if (loading && !state) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const capabilities = state?.capabilities ?? [];
  const methods = state?.methods ?? [];

  return (
    <div className="space-y-6">
      {/* Platform account overview */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Landmark className="h-5 w-5 text-primary" />
              Platform Payment Account
            </CardTitle>
            <CardDescription>
              The ChecksOps master account. Tenant Management pulls from and sends to tenant
              accounts through this account's verified settlement bank.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Badge variant="outline" className="uppercase">{state?.environment ?? "…"}</Badge>
            <Button variant="ghost" size="sm" onClick={load} disabled={loading}>
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <p className="text-xs text-muted-foreground">Account</p>
              <p className="font-medium">{state?.profile?.displayName ?? "ChecksOps Platform"}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Account ID</p>
              <p className="font-mono text-xs flex items-center gap-1 break-all">
                {state?.platform_account_id ?? "—"}
                {state?.platform_account_id && (
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => {
                      navigator.clipboard.writeText(state.platform_account_id);
                      toast({ title: "Copied" });
                    }}
                  >
                    <Copy className="h-3 w-3" />
                  </button>
                )}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Verification</p>
              <div className="mt-0.5">{statusBadge(state?.profile?.verificationStatus)}</div>
            </div>
          </div>

          {capabilities.length > 0 && (
            <>
              <Separator />
              <div>
                <p className="text-xs text-muted-foreground mb-2">Capabilities</p>
                <div className="flex flex-wrap gap-2">
                  {capabilities.map((c) => (
                    <span key={c.capability} className="inline-flex items-center gap-1.5 text-xs">
                      {c.status === "enabled" ? (
                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                      ) : (
                        <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
                      )}
                      {c.capability}
                      {statusBadge(c.status)}
                    </span>
                  ))}
                </div>
                {capabilities.some((c) => c.status !== "enabled") && (
                  <p className="text-xs text-amber-400/90 mt-2">
                    Capabilities that are not enabled are still under provider review — money
                    movement unlocks once they flip to enabled.
                  </p>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Settlement bank accounts */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
          <div>
            <CardTitle>Settlement Bank Accounts</CardTitle>
            <CardDescription>
              Bank accounts linked to the platform account. Verify ownership with the instant
              micro-deposit code before pulling or sending funds.
            </CardDescription>
          </div>
          {!showAddForm && (
            <Button size="sm" variant="outline" onClick={() => setShowAddForm(true)}>
              <Plus className="h-4 w-4 mr-1" /> Add bank
            </Button>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          {methods.length === 0 && !showAddForm && (
            <p className="text-sm text-muted-foreground py-6 text-center">
              No platform bank account yet. Add the settlement bank to get started.
            </p>
          )}

          {methods.map((m) => {
            const verified = m.verification_status === "verified";
            const pending = m.verification_status === "pending_micro_deposit" ||
              m.micro_deposit?.status === "pending";
            const isVerifying = verifyingId === m.id;
            return (
              <div key={m.id} className="border rounded-lg p-4 space-y-3 bg-card/50">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-3">
                    <Landmark className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <p className="font-medium text-sm">
                        {m.bank_name ?? "Bank account"} ••••{m.last_four ?? "????"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {(m.account_type ?? "checking").replace(/^\w/, (c) => c.toUpperCase())}
                        {m.holder_name ? ` · ${m.holder_name}` : ""}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {statusBadge(m.verification_status)}
                    {!verified && !isVerifying && (
                      <Button
                        size="sm"
                        variant={pending ? "default" : "outline"}
                        disabled={busy}
                        onClick={() =>
                          pending ? setVerifyingId(m.id) : initiateMicroDeposit(m.id)
                        }
                      >
                        {busy && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
                        {pending ? "Enter code" : "Verify"}
                      </Button>
                    )}
                  </div>
                </div>

                {isVerifying && !verified && (
                  <div className="flex flex-wrap items-end gap-2 pt-1">
                    <div className="space-y-1">
                      <Label htmlFor={`code-${m.id}`} className="text-xs">
                        4-digit code from the $0.01 deposit (MV####)
                      </Label>
                      <Input
                        id={`code-${m.id}`}
                        inputMode="numeric"
                        className="w-32 font-mono tracking-widest"
                        placeholder="0000"
                        value={code}
                        onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 4))}
                      />
                    </div>
                    <Button
                      size="sm"
                      disabled={busy || code.length !== 4}
                      onClick={() => confirmMicroDeposit(m.id)}
                    >
                      {busy && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
                      Confirm
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => initiateMicroDeposit(m.id)}
                    >
                      Resend deposit
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => { setVerifyingId(null); setCode(""); }}>
                      Cancel
                    </Button>
                  </div>
                )}
              </div>
            );
          })}

          {showAddForm && (
            <AddPlatformBankForm
              onConnected={async () => {
                setShowAddForm(false);
                await load();
              }}
              onExit={() => setShowAddForm(false)}
            />
          )}

          <p className="text-[11px] text-muted-foreground flex items-start gap-2">
            <ShieldCheck className="h-3.5 w-3.5 mt-px shrink-0" />
            Bank details are sent directly to the payment provider. ChecksOps stores only the bank
            name, account type, and last four digits.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

/* ---------------- Add bank form ---------------- */

function AddPlatformBankForm({
  onConnected,
  onExit,
}: {
  onConnected: () => void;
  onExit: () => void;
}) {
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [holderName, setHolderName] = useState("");
  const [holderType, setHolderType] = useState("business");
  const [bankAccountType, setBankAccountType] = useState("checking");
  const [routingNumber, setRoutingNumber] = useState("");
  const [accountNumber, setAccountNumber] = useState("");

  const digitsOnly = (value: string, max: number) => value.replace(/\D/g, "").slice(0, max);

  const canSubmit =
    holderName.trim().length >= 2 &&
    routingNumber.length === 9 &&
    accountNumber.length >= 4 &&
    !saving;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSaving(true);
    try {
      const { data, error } = await supabase.functions.invoke("moov-platform-bank", {
        body: {
          action: "add",
          holder_name: holderName.trim(),
          holder_type: holderType,
          bank_account_type: bankAccountType,
          routing_number: routingNumber,
          account_number: accountNumber,
        },
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);

      setAccountNumber("");
      setRoutingNumber("");
      toast({
        title: "Platform bank account connected",
        description: "Verify ownership with an instant micro-deposit to finish.",
      });
      onConnected();
    } catch (err: any) {
      toast({
        title: "Couldn't connect the bank account",
        description: err?.message ?? "An unexpected error occurred.",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 p-4 border rounded-lg bg-card/50">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="platform-bank-holder-name">Account holder name</Label>
          <Input
            id="platform-bank-holder-name"
            value={holderName}
            onChange={(e) => setHolderName(e.target.value.slice(0, 128))}
            placeholder="Exactly as it appears at the bank"
            autoComplete="off"
          />
        </div>

        <div className="space-y-2">
          <Label>Holder type</Label>
          <Select value={holderType} onValueChange={setHolderType}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="business">Business</SelectItem>
              <SelectItem value="individual">Individual</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label>Account type</Label>
          <Select value={bankAccountType} onValueChange={setBankAccountType}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="checking">Checking</SelectItem>
              <SelectItem value="savings">Savings</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="platform-bank-routing">Routing number</Label>
          <Input
            id="platform-bank-routing"
            inputMode="numeric"
            value={routingNumber}
            onChange={(e) => setRoutingNumber(digitsOnly(e.target.value, 9))}
            placeholder="9 digits"
            autoComplete="off"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="platform-bank-account">Account number</Label>
          <Input
            id="platform-bank-account"
            inputMode="numeric"
            value={accountNumber}
            onChange={(e) => setAccountNumber(digitsOnly(e.target.value, 17))}
            placeholder="4–17 digits"
            autoComplete="off"
          />
        </div>
      </div>

      <div className="flex gap-2 justify-end">
        <Button type="button" variant="ghost" onClick={onExit} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" disabled={!canSubmit}>
          {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
          Connect bank
        </Button>
      </div>
    </form>
  );
}
