import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChevronDown } from "lucide-react";

const MERGE_FIELD_GROUPS = [
  {
    label: "Policyholder",
    fields: [
      { label: "Policyholder Name", value: "${policyholder}" },
      { label: "Phone", value: "${policyholder_phone}" },
      { label: "Email", value: "${policyholder_email}" },
      { label: "Address", value: "${property_address}" },
      { label: "Street", value: "${address.street}" },
      { label: "City", value: "${address.city}" },
    ],
  },
  {
    label: "Claim",
    fields: [
      { label: "Claim Number", value: "${claim.claim_number}" },
      { label: "Policy Number", value: "${policy}" },
      { label: "Insurance Company", value: "${insurance_company}" },
      { label: "Loss Type", value: "${claim.loss_type}" },
      { label: "Loss Date", value: "${claim.loss_date}" },
      { label: "Status", value: "${claim.status}" },
      { label: "Mortgage Company", value: "${mortgage_company}" },
      { label: "Loan Number", value: "${loan_number}" },
      { label: "SSN Last Four", value: "${ssn_last_four}" },
    ],
  },
  {
    label: "Inspection",
    fields: [
      { label: "Inspection Date", value: "${inspection.date}" },
      { label: "Inspection Time", value: "${inspection.time}" },
      { label: "Inspector Name", value: "${inspection.inspector}" },
    ],
  },
  {
    label: "Settlement / Accounting",
    fields: [
      { label: "Total RCV", value: "${settlement.total_rcv}" },
      { label: "Total Net", value: "${settlement.total_net}" },
      { label: "Total Deductible", value: "${settlement.total_deductible}" },
      { label: "Dwelling RCV", value: "${settlement.dwelling_rcv}" },
      { label: "Dwelling ACV", value: "${settlement.dwelling_acv}" },
      { label: "Dwelling Net", value: "${settlement.dwelling_net}" },
      { label: "Other Structures RCV", value: "${settlement.other_structures_rcv}" },
      { label: "Paid When Incurred RCV", value: "${settlement.pwi_rcv}" },
      { label: "Prior Offer", value: "${settlement.prior_offer}" },
      { label: "Total Checks", value: "${settlement.total_checks}" },
      { label: "Outstanding", value: "${settlement.outstanding}" },
    ],
  },
  {
    label: "Depreciation",
    fields: [
      { label: "Total Recoverable Dep", value: "${settlement.total_recoverable_dep}" },
      { label: "Total Non-Recoverable Dep", value: "${settlement.total_non_recoverable_dep}" },
      { label: "Dwelling Recoverable Dep", value: "${settlement.dwelling_recoverable_dep}" },
      { label: "Dwelling Non-Recoverable Dep", value: "${settlement.dwelling_non_recoverable_dep}" },
      { label: "Other Structures Recoverable Dep", value: "${settlement.other_structures_recoverable_dep}" },
      { label: "Other Structures Non-Recoverable Dep", value: "${settlement.other_structures_non_recoverable_dep}" },
      { label: "Paid When Incurred Recoverable Dep", value: "${settlement.pwi_recoverable_dep}" },
      { label: "Paid When Incurred Non-Recoverable Dep", value: "${settlement.pwi_non_recoverable_dep}" },
    ],
  },
];

// Flat list for backward compat
const MERGE_FIELDS = MERGE_FIELD_GROUPS.flatMap((g) => g.fields);

interface MergeFieldButtonsProps {
  onInsert: (field: string) => void;
  compact?: boolean;
}

export function MergeFieldButtons({ onInsert }: MergeFieldButtonsProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="text-xs gap-1">
          Insert Merge Field
          <ChevronDown className="h-3 w-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="max-h-72 overflow-y-auto w-64" align="end">
        {MERGE_FIELD_GROUPS.map((group, gi) => (
          <div key={group.label}>
            {gi > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="text-xs">{group.label}</DropdownMenuLabel>
            <DropdownMenuGroup>
              {group.fields.map((field) => (
                <DropdownMenuItem
                  key={field.value}
                  onClick={() => onInsert(field.value)}
                  className="text-xs cursor-pointer"
                >
                  <span className="flex-1">{field.label}</span>
                  <span className="text-muted-foreground font-mono text-[10px] ml-2 truncate max-w-[120px]">
                    {field.value}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export { MERGE_FIELDS, MERGE_FIELD_GROUPS };
