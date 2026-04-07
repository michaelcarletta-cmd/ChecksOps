import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

const METHOD_TYPES = [
  { value: "card", label: "Credit/Debit Card" },
  { value: "ach", label: "ACH Transfer" },
  { value: "zelle", label: "Zelle" },
  { value: "venmo", label: "Venmo" },
  { value: "check", label: "Check" },
  { value: "cash", label: "Cash" },
  { value: "other", label: "Other" },
];

interface PaymentMethodFormProps {
  onSave: (fields: Record<string, string>) => Promise<void>;
  onCancel: () => void;
  saving: boolean;
}

export const PaymentMethodForm = ({ onSave, onCancel, saving }: PaymentMethodFormProps) => {
  const [methodType, setMethodType] = useState("card");
  const [cardLast4, setCardLast4] = useState("");
  const [customLabel, setCustomLabel] = useState("");

  const isCard = methodType === "card";

  const handleSave = () => {
    if (isCard) {
      if (!/^\d{4}$/.test(cardLast4)) {
        toast.error("Card last 4 must be exactly 4 digits");
        return;
      }
    }
    const typeInfo = METHOD_TYPES.find(m => m.value === methodType);
    const label = isCard
      ? `${customLabel || "Card"} ****${cardLast4}`
      : customLabel || typeInfo?.label || methodType;

    onSave({ label, method_type: methodType, card_last_four: isCard ? cardLast4 : "" });
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label>Method Type</Label>
        <Select value={methodType} onValueChange={setMethodType}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {METHOD_TYPES.map(m => (
              <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {isCard && (
        <div className="space-y-1.5">
          <Label>Last 4 Digits *</Label>
          <Input
            value={cardLast4}
            onChange={e => setCardLast4(e.target.value.replace(/\D/g, "").slice(0, 4))}
            placeholder="1234"
            maxLength={4}
          />
        </div>
      )}
      <div className="space-y-1.5">
        <Label>{isCard ? "Card Name (optional)" : "Label (optional)"}</Label>
        <Input
          value={customLabel}
          onChange={e => setCustomLabel(e.target.value)}
          placeholder={isCard ? "Visa, Amex, etc." : "e.g. My Zelle"}
        />
      </div>
      <div className="flex gap-2 justify-end">
        <Button variant="outline" onClick={onCancel}>Cancel</Button>
        <Button onClick={handleSave} disabled={saving || (isCard && cardLast4.length !== 4)}>
          {saving && <Loader2 className="h-4 w-4 mr-1 animate-spin" />} Save
        </Button>
      </div>
    </div>
  );
};
