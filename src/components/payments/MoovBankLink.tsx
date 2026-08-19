import { useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, ShieldCheck } from "lucide-react";

interface Props {
  tenantId: string;
  onConnected?: (bankAccountId: string) => void;
  onExit?: () => void;
}

/**
 * Settlement bank collection form.
 *
 * Moov.js exposes no hosted bank-account Drop, so the details are posted to the
 * `moov-bank-account-add` function, which forwards them straight to the payment
 * provider. Only safe metadata (bank name, account type, last four) is stored.
 * Ownership is proven afterwards with instant micro-deposit verification.
 */
export function MoovBankLink({ tenantId, onConnected, onExit }: Props) {
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
      const { data, error } = await supabase.functions.invoke("moov-bank-account-add", {
        body: {
          tenant_id: tenantId,
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
        title: "Bank account connected",
        description: "Verify ownership with an instant micro-deposit to finish.",
      });
      onConnected?.((data as any)?.bank_account_id ?? "");
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
    <form
      onSubmit={handleSubmit}
      className="space-y-4 p-4 border rounded-lg bg-card/50"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="bank-holder-name">Account holder name</Label>
          <Input
            id="bank-holder-name"
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
          <Label htmlFor="bank-routing">Routing number</Label>
          <Input
            id="bank-routing"
            inputMode="numeric"
            value={routingNumber}
            onChange={(e) => setRoutingNumber(digitsOnly(e.target.value, 9))}
            placeholder="9 digits"
            autoComplete="off"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="bank-account">Account number</Label>
          <Input
            id="bank-account"
            inputMode="numeric"
            value={accountNumber}
            onChange={(e) => setAccountNumber(digitsOnly(e.target.value, 17))}
            placeholder="4–17 digits"
            autoComplete="off"
          />
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground flex items-start gap-2">
        <ShieldCheck className="h-3.5 w-3.5 mt-px shrink-0" />
        Bank details are sent directly to our payment provider. ChecksOps stores only
        the bank name, account type, and last four digits.
      </p>

      <div className="flex gap-2 justify-end">
        <Button type="button" variant="ghost" onClick={() => onExit?.()} disabled={saving}>
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
