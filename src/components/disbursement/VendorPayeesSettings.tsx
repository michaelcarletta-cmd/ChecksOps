import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Info, Loader2, Store, X } from "lucide-react";
import { useTenant } from "@/contexts/TenantContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { SectionCard } from "@/components/settings/SectionCard";
import { VENDOR_PAYEES_QUERY_KEY, addVendorPayee, removeVendorPayee, useVendorPayees } from "@/hooks/useVendorPayees";
import {
  VENDOR_CODE_MAX,
  VENDOR_CODE_MIN,
  VENDOR_INACTIVE_LABEL,
  VENDOR_NO_PARTNERSHIP_NOTE,
  VENDOR_WALLET_ONLY_NOTE,
  isValidVendorCode,
  normalizeVendorCode,
  vendorPayeeName,
} from "@/lib/payments/vendorPayees";

const addedOn = (at: string | null) => {
  if (!at) return "—";
  const d = new Date(at);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }) : "—";
};

/**
 * Settings → Bank Account/Stakeholders → Vendors: the vendor payees this organization can pay.
 * Any member adds a vendor by the vendor's Partner Code and removes it again. Adding one creates no
 * partnership and shares nothing; it only lets this organization pay the vendor's ChecksOps wallet
 * from a check's Funds tab or the Payroll payment dialog.
 */
export function VendorPayeesSettings() {
  const { tenant } = useTenant();
  const tenantId = tenant?.id ?? null;
  const { toast } = useToast();
  const qc = useQueryClient();
  const [code, setCode] = useState("");
  const { data: payees = [], isLoading, error } = useVendorPayees(tenantId);
  const codeValid = isValidVendorCode(code);

  const refresh = () => qc.invalidateQueries({ queryKey: [VENDOR_PAYEES_QUERY_KEY, tenantId] });

  const add = useMutation({
    mutationFn: async () => {
      if (!tenantId) throw new Error("No organization selected.");
      if (!isValidVendorCode(code)) {
        throw new Error(`Vendor codes are ${VENDOR_CODE_MIN} to ${VENDOR_CODE_MAX} characters: letters, numbers, "-" and "_".`);
      }
      return addVendorPayee(tenantId, code);
    },
    onSuccess: (added) => {
      toast({
        title: added.replayed ? "Already on your list" : "Vendor added",
        description: `${added.vendor_name ?? "The vendor"} can now be paid from a check's Funds tab or a payroll payment.`,
      });
      setCode("");
      refresh();
    },
    onError: (e: Error) => toast({ title: "Vendor not added", description: e.message, variant: "destructive" }),
  });

  const remove = useMutation({
    mutationFn: async (vendorTenantId: string) => {
      if (!tenantId) throw new Error("No organization selected.");
      await removeVendorPayee(tenantId, vendorTenantId);
    },
    onSuccess: () => {
      toast({ title: "Vendor removed" });
      refresh();
    },
    onError: (e: Error) => toast({ title: "Vendor not removed", description: e.message, variant: "destructive" }),
  });

  return (
    <SectionCard
      title="Vendors"
      icon={<Store className="h-4 w-4 text-primary" />}
      description="Companies you pay to their ChecksOps wallet. Add a vendor by its Partner Code."
    >
      <div className="space-y-4" data-testid="vendor-payees-card">
        <div className="flex items-start gap-2 rounded-md border border-border/60 bg-muted/30 p-3 text-xs text-muted-foreground">
          <Info className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
          <p>
            {VENDOR_NO_PARTNERSHIP_NOTE} {VENDOR_WALLET_ONLY_NOTE} Pay a vendor from a check's Funds tab or from a
            payroll payment.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="vendor-partner-code">Vendor's Partner Code</Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="vendor-partner-code"
              placeholder="e.g. ACME-SUPPLY"
              value={code}
              onChange={(e) => setCode(normalizeVendorCode(e.target.value))}
              maxLength={VENDOR_CODE_MAX}
              autoComplete="off"
              className="h-9 flex-1 font-mono tracking-wider"
            />
            <Button
              size="sm"
              className="sm:w-32"
              onClick={() => codeValid && add.mutate()}
              disabled={!codeValid || add.isPending || !tenantId}
            >
              {add.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Add vendor"}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            {VENDOR_CODE_MIN} to {VENDOR_CODE_MAX} characters: letters, numbers, "-" and "_".
          </p>
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading vendors...
          </div>
        ) : error ? (
          <p className="text-xs text-destructive">{(error as Error).message}</p>
        ) : payees.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/60 bg-muted/20 py-6 text-center text-xs text-muted-foreground">
            No vendors yet. Ask a vendor for its Partner Code and add it above.
          </div>
        ) : (
          <div className="space-y-2">
            {payees.map((p) => (
              <div
                key={p.link_id}
                className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/20 p-3"
              >
                <div className="min-w-0 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{vendorPayeeName(p)}</span>
                    {!p.vendor_active && (
                      <Badge variant="outline" className="text-[10px] bg-amber-500/10 text-amber-700 border-amber-500/20">
                        {VENDOR_INACTIVE_LABEL}
                      </Badge>
                    )}
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Code used <span className="font-mono">{p.partner_code_used ?? "—"}</span> · Added {addedOn(p.created_at)}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 text-destructive hover:text-destructive"
                  disabled={remove.isPending}
                  onClick={() => {
                    if (confirm(`Remove ${vendorPayeeName(p)} from your vendors? You will no longer be able to pay it.`)) {
                      remove.mutate(p.vendor_tenant_id);
                    }
                  }}
                >
                  <X className="mr-1 h-3 w-3" /> Remove
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </SectionCard>
  );
}
