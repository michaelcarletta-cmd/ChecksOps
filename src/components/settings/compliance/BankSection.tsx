import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Landmark, Plus } from "lucide-react";
import { MoovBankLink } from "@/components/payments/MoovBankLink";
import { MicroDepositVerification } from "@/components/payments/MicroDepositVerification";
import type { OnboardingBank } from "@/lib/payments/moovOnboarding";

function bankVerificationState(b: OnboardingBank): "verified" | "pending_micro_deposit" | "not_started" {
  const v = `${b.verification ?? ""} ${b.status ?? ""}`.toLowerCase();
  if (/\bverified\b/.test(v) && !/unverified/.test(v)) return "verified";
  if (/pending|micro/.test(v)) return "pending_micro_deposit";
  return "not_started";
}

interface Props {
  tenantId: string;
  banks: OnboardingBank[];
  environment: string | null;
  readOnly: boolean;
  accountConnected: boolean;
  onChanged: () => void | Promise<unknown>;
}

/** Settlement bank: add via moov-bank-account-add, then verify with micro-deposits. */
export function BankSection({ tenantId, banks, environment, readOnly, accountConnected, onChanged }: Props) {
  const [adding, setAdding] = useState(false);

  return (
    <div className="space-y-3">
      {banks.length === 0 ? (
        <p className="text-xs text-muted-foreground">No bank account connected yet.</p>
      ) : (
        banks.map((b) => {
          const state = bankVerificationState(b);
          return (
            <div key={b.id} className="flex items-start justify-between gap-3 rounded-md bg-muted/40 p-2.5">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 text-xs font-medium">
                  <Landmark className="h-3.5 w-3.5 text-muted-foreground" />
                  Account ••{b.last4 ?? "????"}
                </div>
                <div className="text-[11px] text-muted-foreground mt-0.5">
                  Routing {b.routing_masked ?? "on file"}{b.status ? ` · ${b.status}` : ""}
                </div>
              </div>
              <div className="shrink-0">
                {state === "verified" ? (
                  <Badge variant="outline" className="text-[10px] border-emerald-500/40 text-emerald-500">Verified</Badge>
                ) : readOnly ? (
                  <Badge variant="outline" className="text-[10px] border-amber-500/40 text-amber-500">
                    {state === "pending_micro_deposit" ? "Verification pending" : "Not verified"}
                  </Badge>
                ) : (
                  <MicroDepositVerification
                    tenantId={tenantId}
                    paymentMethodId={b.id}
                    verificationStatus={state}
                    environment={environment}
                    onVerified={() => onChanged()}
                  />
                )}
              </div>
            </div>
          );
        })
      )}

      {!readOnly && (
        adding ? (
          <MoovBankLink
            tenantId={tenantId}
            onConnected={() => {
              setAdding(false);
              void onChanged();
            }}
            onExit={() => setAdding(false)}
          />
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" variant="outline" className="h-8 text-xs" onClick={() => setAdding(true)} disabled={!accountConnected}>
              <Plus className="h-3.5 w-3.5 mr-1.5" /> Add bank account
            </Button>
            {!accountConnected && (
              <span className="text-[11px] text-muted-foreground">Save and submit your business details first.</span>
            )}
          </div>
        )
      )}
    </div>
  );
}
