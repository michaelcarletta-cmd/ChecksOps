import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown } from "lucide-react";
import { useState } from "react";

const MERGE_FIELDS = [
  { label: "Policyholder Name", value: "{claim.policyholder_name}" },
  { label: "Address", value: "{claim.policyholder_address}" },
  { label: "Claim Number", value: "{claim.claim_number}" },
  { label: "Policy Number", value: "{claim.policy_number}" },
  { label: "Insurance Company", value: "{claim.insurance_company}" },
  { label: "Loss Type", value: "{claim.loss_type}" },
  { label: "Loss Date", value: "{claim.loss_date}" },
  { label: "Status", value: "{claim.status}" },
  { label: "Phone", value: "{claim.policyholder_phone}" },
  { label: "Email", value: "{claim.policyholder_email}" },
  { label: "Inspection Date", value: "{inspection.date}" },
  { label: "Inspection Time", value: "{inspection.time}" },
  { label: "Inspector Name", value: "{inspection.inspector}" },
  { label: "Total RCV", value: "{settlement.total_rcv}" },
  { label: "Total Net", value: "{settlement.total_net}" },
  { label: "Total Deductible", value: "{settlement.total_deductible}" },
  { label: "Dwelling RCV", value: "{settlement.dwelling_rcv}" },
  { label: "Prior Offer", value: "{settlement.prior_offer}" },
  { label: "Total Recoverable Dep", value: "{settlement.total_recoverable_dep}" },
  { label: "Total Non-Recoverable Dep", value: "{settlement.total_non_recoverable_dep}" },
];

interface MergeFieldButtonsProps {
  onInsert: (field: string) => void;
  compact?: boolean;
}

export function MergeFieldButtons({ onInsert, compact = false }: MergeFieldButtonsProps) {
  const [open, setOpen] = useState(false);

  if (compact) {
    return (
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <Button type="button" variant="outline" size="sm" className="text-xs gap-1">
            Insert Placeholder
            <ChevronDown className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`} />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-2">
          <div className="flex gap-1 flex-wrap">
            {MERGE_FIELDS.map((field) => (
              <Button
                key={field.value}
                type="button"
                variant="outline"
                size="sm"
                className="text-xs h-6"
                onClick={() => onInsert(field.value)}
              >
                {field.label}
              </Button>
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    );
  }

  return (
    <div className="flex gap-1 flex-wrap">
      {MERGE_FIELDS.map((field) => (
        <Button
          key={field.value}
          type="button"
          variant="outline"
          size="sm"
          className="text-xs h-6"
          onClick={() => onInsert(field.value)}
        >
          {field.label}
        </Button>
      ))}
    </div>
  );
}

export { MERGE_FIELDS };
