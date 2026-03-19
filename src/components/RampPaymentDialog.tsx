import { useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { AlertCircle, Building2, CheckCircle, Loader2 } from "lucide-react";

interface RampPaymentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  recipientName: string;
  recipientEmail?: string;
  recipientPhone?: string;
  recipientType: "contractor" | "client" | "referrer";
  recipientReferenceId?: string;
  rampVendorId?: string;
  defaultAmount?: number;
  onSuccess?: () => void;
  onVendorCreated?: (vendorId: string) => void;
}

interface RampConfig {
  entityId: string | null;
  entityName: string | null;
  sourceBankAccountId: string | null;
  sourceBankAccountName: string | null;
  vendorOwnerId: string | null;
  hasBillPayAccount: boolean;
}

interface RampVendorAccount {
  id: string;
  accountName?: string | null;
  accountNumberLastFour?: string | null;
}

const buildExternalVendorId = (recipientType: string, recipientReferenceId?: string, recipientEmail?: string, recipientName?: string) => {
  const fallback = recipientEmail || recipientName || "recipient";
  const normalizedFallback = fallback.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  return `fc-${recipientType}-${recipientReferenceId || normalizedFallback}`;
};

export function RampPaymentDialog({
  open,
  onOpenChange,
  recipientName,
  recipientEmail,
  recipientPhone,
  recipientType,
  recipientReferenceId,
  rampVendorId,
  defaultAmount,
  onSuccess,
  onVendorCreated,
}: RampPaymentDialogProps) {
  const [isLoadingConfig, setIsLoadingConfig] = useState(false);
  const [isLoadingAccounts, setIsLoadingAccounts] = useState(false);
  const [isCreatingVendor, setIsCreatingVendor] = useState(false);
  const [isSubmittingPayment, setIsSubmittingPayment] = useState(false);
  const [config, setConfig] = useState<RampConfig | null>(null);
  const [vendorId, setVendorId] = useState<string | undefined>(rampVendorId);
  const [vendorAccounts, setVendorAccounts] = useState<RampVendorAccount[]>([]);
  const [formData, setFormData] = useState({
    amount: defaultAmount?.toString() || "",
    description: "",
    paymentMethod: "CHECK" as "CHECK" | "ACH",
  });

  useEffect(() => {
    setVendorId(rampVendorId);
  }, [rampVendorId]);

  useEffect(() => {
    if (!defaultAmount) return;
    setFormData((prev) => ({ ...prev, amount: defaultAmount.toString() }));
  }, [defaultAmount]);

  useEffect(() => {
    if (!open) return;
    void loadRampConfig();
  }, [open]);

  useEffect(() => {
    if (!open || !vendorId) return;
    void loadVendorAccounts(vendorId);
  }, [open, vendorId]);

  useEffect(() => {
    if (vendorAccounts.length > 0 && formData.paymentMethod === "CHECK") {
      setFormData((prev) => ({ ...prev, paymentMethod: "ACH" }));
    }
    if (vendorAccounts.length === 0 && formData.paymentMethod === "ACH") {
      setFormData((prev) => ({ ...prev, paymentMethod: "CHECK" }));
    }
  }, [vendorAccounts, formData.paymentMethod]);

  const canCreateVendor = useMemo(() => !!recipientEmail, [recipientEmail]);
  const hasBillPayConfig = !!config?.hasBillPayAccount;

  const loadRampConfig = async () => {
    setIsLoadingConfig(true);
    try {
      const { data, error } = await supabase.functions.invoke("ramp-payments", {
        body: { action: "get-default-config" },
      });
      if (error) throw error;
      if (data?.success === false) throw new Error(data.error || "Failed to load Ramp configuration");
      setConfig({
        entityId: data?.entityId ?? null,
        entityName: data?.entityName ?? null,
        sourceBankAccountId: data?.sourceBankAccountId ?? null,
        sourceBankAccountName: data?.sourceBankAccountName ?? null,
        vendorOwnerId: data?.vendorOwnerId ?? null,
        hasBillPayAccount: Boolean(data?.hasBillPayAccount),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to load Ramp configuration";
      toast.error(message);
    } finally {
      setIsLoadingConfig(false);
    }
  };

  const loadVendorAccounts = async (activeVendorId: string) => {
    setIsLoadingAccounts(true);
    try {
      const { data, error } = await supabase.functions.invoke("ramp-payments", {
        body: { action: "get-vendor-accounts", vendorId: activeVendorId },
      });
      if (error) throw error;
      if (data?.success === false) throw new Error(data.error || "Failed to fetch Ramp vendor accounts");

      const accounts = Array.isArray(data?.accounts) ? data.accounts : [];
      setVendorAccounts(
        accounts.map((account: any) => ({
          id: String(account.id),
          accountName: typeof account.account_name === "string" ? account.account_name : null,
          accountNumberLastFour:
            typeof account.account_number_last_four === "string" ? account.account_number_last_four : null,
        }))
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to fetch Ramp vendor accounts";
      toast.error(message);
    } finally {
      setIsLoadingAccounts(false);
    }
  };

  const createOrFetchVendor = async (): Promise<string | null> => {
    if (!canCreateVendor) {
      toast.error("Recipient email is required to create a Ramp vendor");
      return null;
    }

    setIsCreatingVendor(true);
    try {
      const externalVendorId = buildExternalVendorId(recipientType, recipientReferenceId, recipientEmail, recipientName);
      const { data, error } = await supabase.functions.invoke("ramp-payments", {
        body: {
          action: "upsert-vendor",
          name: recipientName,
          email: recipientEmail,
          phone: recipientPhone,
          externalVendorId,
        },
      });
      if (error) throw error;
      if (data?.success === false) throw new Error(data.error || "Failed to create Ramp vendor");

      const createdVendorId = String(data.vendorId);
      setVendorId(createdVendorId);
      onVendorCreated?.(createdVendorId);
      toast.success(data.existing ? "Ramp vendor is ready" : "Ramp vendor created");
      await loadVendorAccounts(createdVendorId);
      return createdVendorId;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to create Ramp vendor";
      toast.error(message);
      return null;
    } finally {
      setIsCreatingVendor(false);
    }
  };

  const handleSubmitPayment = async () => {
    const amount = parseFloat(formData.amount);
    if (!amount || amount <= 0) {
      toast.error("Please enter a valid amount");
      return;
    }

    if (!hasBillPayConfig) {
      toast.error("Ramp bill-pay account is not configured");
      return;
    }

    let activeVendorId = vendorId;
    if (!activeVendorId) {
      activeVendorId = await createOrFetchVendor() || undefined;
    }
    if (!activeVendorId) return;

    if (formData.paymentMethod === "ACH" && vendorAccounts.length === 0) {
      toast.error("This vendor does not have a Ramp bank account yet. Use Check or add bank details in Ramp.");
      return;
    }

    setIsSubmittingPayment(true);
    try {
      const { data, error } = await supabase.functions.invoke("ramp-payments", {
        body: {
          action: "create-bill-payment",
          vendorId: activeVendorId,
          amount,
          description: formData.description || `Payment to ${recipientName}`,
          paymentMethod: formData.paymentMethod,
          vendorAccountId: formData.paymentMethod === "ACH" ? vendorAccounts[0]?.id : undefined,
        },
      });
      if (error) throw error;
      if (data?.success === false) throw new Error(data.error || "Failed to create Ramp payment");

      const billId = data?.billId ? ` (Bill ${data.billId})` : "";
      toast.success(`$${amount.toFixed(2)} scheduled in Ramp${billId}`);
      onOpenChange(false);
      onSuccess?.();
      setFormData({ amount: "", description: "", paymentMethod: vendorAccounts.length > 0 ? "ACH" : "CHECK" });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to create Ramp payment";
      toast.error(message);
    } finally {
      setIsSubmittingPayment(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Send Payment via Ramp</DialogTitle>
          <DialogDescription>Create a vendor bill payment in Ramp for {recipientName}.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {isLoadingConfig ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
            </div>
          ) : (
            <div className="rounded-lg border bg-muted/40 p-3 space-y-2">
              <div className="flex items-center gap-2">
                <Building2 className="h-4 w-4" />
                <span className="text-sm font-medium">Ramp Configuration</span>
              </div>
              {config?.entityName && (
                <p className="text-xs text-muted-foreground">
                  Entity: <span className="text-foreground">{config.entityName}</span>
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Bank account:{" "}
                <span className="text-foreground">
                  {config?.sourceBankAccountName || (config?.hasBillPayAccount ? "Configured" : "Not configured")}
                </span>
              </p>
              {!hasBillPayConfig && (
                <div className="flex items-start gap-2 rounded-md bg-yellow-50 dark:bg-yellow-900/20 p-2 text-yellow-700 dark:text-yellow-300">
                  <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                  <p className="text-xs">
                    Ramp bill-pay source account is missing. Configure your Ramp entity/payment account environment values
                    before sending payments.
                  </p>
                </div>
              )}
            </div>
          )}

          <div className="rounded-lg border p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Ramp Vendor</span>
              {vendorId ? (
                <Badge variant="outline" className="text-green-600 border-green-200">
                  <CheckCircle className="h-3.5 w-3.5 mr-1" />
                  Connected
                </Badge>
              ) : (
                <Badge variant="outline">Not Connected</Badge>
              )}
            </div>

            {!vendorId && (
              <Button
                type="button"
                variant="outline"
                className="w-full"
                disabled={isCreatingVendor || !canCreateVendor}
                onClick={() => void createOrFetchVendor()}
              >
                {isCreatingVendor ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Creating Vendor...
                  </>
                ) : (
                  "Create Ramp Vendor"
                )}
              </Button>
            )}

            {!canCreateVendor && !vendorId && (
              <p className="text-xs text-muted-foreground">Recipient email is required before Ramp can create a vendor.</p>
            )}

            {vendorId && (
              <p className="text-xs text-muted-foreground">
                {isLoadingAccounts
                  ? "Checking vendor bank accounts..."
                  : vendorAccounts.length > 0
                    ? `${vendorAccounts.length} bank account${vendorAccounts.length > 1 ? "s" : ""} available for ACH`
                    : "No vendor bank account found in Ramp (check payments still available)."}
              </p>
            )}
          </div>

          <div>
            <Label>Recipient</Label>
            <Input value={recipientName} disabled className="bg-muted" />
          </div>

          <div>
            <Label>Amount *</Label>
            <Input
              type="number"
              step="0.01"
              min="0"
              placeholder="0.00"
              value={formData.amount}
              onChange={(e) => setFormData((prev) => ({ ...prev, amount: e.target.value }))}
            />
          </div>

          <div>
            <Label>Payment Method *</Label>
            <Select
              value={formData.paymentMethod}
              onValueChange={(value: "CHECK" | "ACH") => setFormData((prev) => ({ ...prev, paymentMethod: value }))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="CHECK">Check</SelectItem>
                <SelectItem value="ACH" disabled={vendorAccounts.length === 0}>
                  ACH {vendorAccounts.length === 0 ? "(requires vendor bank account)" : ""}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label>Description</Label>
            <Textarea
              placeholder="Payment memo (optional)"
              value={formData.description}
              onChange={(e) => setFormData((prev) => ({ ...prev, description: e.target.value }))}
            />
          </div>

          <div className="flex gap-2 pt-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} className="flex-1">
              Cancel
            </Button>
            <Button
              onClick={() => void handleSubmitPayment()}
              disabled={isSubmittingPayment || isCreatingVendor || isLoadingConfig || !hasBillPayConfig}
              className="flex-1"
            >
              {isSubmittingPayment ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Sending...
                </>
              ) : (
                `Send $${formData.amount || "0.00"}`
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
