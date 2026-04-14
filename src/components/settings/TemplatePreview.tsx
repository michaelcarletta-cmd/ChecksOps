import { useMemo } from "react";
import { MERGE_FIELD_GROUPS } from "@/components/MergeFieldButtons";
import { Badge } from "@/components/ui/badge";
import { Eye } from "lucide-react";

// Sample data for preview rendering
const SAMPLE_DATA: Record<string, string> = {
  "${policyholder}": "John Smith",
  "${policyholder_phone}": "(555) 123-4567",
  "${policyholder_email}": "john.smith@email.com",
  "${property_address}": "123 Main St, Dallas, TX 75201",
  "${address.street}": "123 Main St",
  "${address.city}": "Dallas",
  "${claim.claim_number}": "CLM-2024-00142",
  "${policy}": "POL-HO3-98765",
  "${insurance_company}": "State Farm",
  "${claim.loss_type}": "Wind/Hail",
  "${claim.loss_date}": "03/15/2024",
  "${claim.status}": "Open",
  "${mortgage_company}": "Wells Fargo",
  "${loan_number}": "LN-456789",
  "${ssn_last_four}": "1234",
  "${inspection.date}": "04/01/2024",
  "${inspection.time}": "10:00 AM",
  "${inspection.inspector}": "Mike Johnson",
  "${settlement.total_rcv}": "$45,200.00",
  "${settlement.total_net}": "$38,700.00",
  "${settlement.total_deductible}": "$2,500.00",
  "${settlement.dwelling_rcv}": "$35,000.00",
  "${settlement.dwelling_acv}": "$28,500.00",
  "${settlement.dwelling_net}": "$32,500.00",
  "${settlement.other_structures_rcv}": "$5,200.00",
  "${settlement.pwi_rcv}": "$5,000.00",
  "${settlement.prior_offer}": "$12,000.00",
  "${settlement.total_checks}": "$25,000.00",
  "${settlement.outstanding}": "$13,700.00",
  "${settlement.total_recoverable_dep}": "$6,500.00",
  "${settlement.total_non_recoverable_dep}": "$1,200.00",
  "${settlement.dwelling_recoverable_dep}": "$5,000.00",
  "${settlement.dwelling_non_recoverable_dep}": "$800.00",
  "${settlement.other_structures_recoverable_dep}": "$750.00",
  "${settlement.other_structures_non_recoverable_dep}": "$200.00",
  "${settlement.pwi_recoverable_dep}": "$750.00",
  "${settlement.pwi_non_recoverable_dep}": "$200.00",
};

// All known merge field values for validation
const KNOWN_FIELDS = new Set(MERGE_FIELD_GROUPS.flatMap(g => g.fields.map(f => f.value)));

interface TemplatePreviewProps {
  text: string;
  label?: string;
}

export function TemplatePreview({ text, label = "Preview" }: TemplatePreviewProps) {
  const { rendered, invalidFields } = useMemo(() => {
    if (!text) return { rendered: "", invalidFields: [] as string[] };

    const invalid: string[] = [];
    // Find all ${...} patterns
    const result = text.replace(/\$\{([^}]+)\}/g, (match) => {
      if (SAMPLE_DATA[match]) {
        return SAMPLE_DATA[match];
      }
      if (!KNOWN_FIELDS.has(match)) {
        invalid.push(match);
      }
      return match;
    });

    return { rendered: result, invalidFields: invalid };
  }, [text]);

  if (!text) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Eye className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        {invalidFields.length > 0 && (
          <Badge variant="destructive" className="text-[10px] px-1.5 py-0">
            {invalidFields.length} invalid field{invalidFields.length > 1 ? "s" : ""}
          </Badge>
        )}
      </div>
      <div className="rounded-md border border-border bg-muted/30 p-3 text-sm whitespace-pre-wrap break-words">
        {renderHighlighted(rendered, invalidFields)}
      </div>
    </div>
  );
}

function renderHighlighted(text: string, invalidFields: string[]) {
  if (invalidFields.length === 0) return text;

  const parts: (string | JSX.Element)[] = [];
  let lastIndex = 0;

  for (const field of invalidFields) {
    let idx = text.indexOf(field, lastIndex);
    while (idx !== -1) {
      if (idx > lastIndex) {
        parts.push(text.slice(lastIndex, idx));
      }
      parts.push(
        <span key={`${field}-${idx}`} className="text-destructive bg-destructive/10 rounded px-0.5 font-mono text-xs">
          {field}
        </span>
      );
      lastIndex = idx + field.length;
      idx = text.indexOf(field, lastIndex);
    }
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return <>{parts}</>;
}
