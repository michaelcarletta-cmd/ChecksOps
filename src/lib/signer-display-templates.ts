/**
 * Signer-facing display templates for signature fields.
 * 
 * These are PRESENTATION ONLY — they do not affect field IDs, 
 * coordinates, submission payloads, or any backend logic.
 */

export interface FieldDisplayMeta {
  display_label: string;
  display_help_text: string;
  display_section?: string;
  display_order?: number;
}

export interface DocumentTypeTemplate {
  label: string;
  description: string;
  fields: Record<string, FieldDisplayMeta>; // keyed by field type + position hint
}

/**
 * Default signer-facing labels/help text per document type.
 * 
 * Keys use the pattern: `{field_type}` or `{field_type}_{index}` 
 * for multiple fields of the same type.
 */
export const SIGNER_DISPLAY_TEMPLATES: Record<string, DocumentTypeTemplate> = {
  contract: {
    label: "Contract",
    description: "Standard contract or agreement",
    fields: {
      signature_1: {
        display_label: "Owner Signature",
        display_help_text: "Sign here to approve and authorize the contract terms.",
        display_section: "Signatures",
        display_order: 1,
      },
      signature_2: {
        display_label: "Co-Owner / Authorized Representative Signature",
        display_help_text: "If applicable, the co-owner or authorized representative should sign here.",
        display_section: "Signatures",
        display_order: 2,
      },
      text_1: {
        display_label: "Owner Printed Name",
        display_help_text: "Enter the full legal name of the person signing this agreement.",
        display_section: "Identification",
        display_order: 3,
      },
      text_2: {
        display_label: "Co-Owner Printed Name",
        display_help_text: "Enter the full legal name of the co-owner or authorized representative.",
        display_section: "Identification",
        display_order: 4,
      },
      date_1: {
        display_label: "Date Signed",
        display_help_text: "Enter the date this agreement was signed.",
        display_section: "Signatures",
        display_order: 5,
      },
      date_2: {
        display_label: "Date Signed (Co-Owner)",
        display_help_text: "Enter the date the co-owner signed this agreement.",
        display_section: "Signatures",
        display_order: 6,
      },
      checkbox_1: {
        display_label: "Initial Here",
        display_help_text: "Check here to confirm you reviewed the authorization language.",
        display_section: "Acknowledgements",
        display_order: 7,
      },
    },
  },
  check_endorsement: {
    label: "Check Endorsement",
    description: "Insurance check endorsement",
    fields: {
      signature_1: {
        display_label: "Payee Signature",
        display_help_text: "Sign exactly as your name appears on the insurance check.",
        display_section: "Endorsement",
        display_order: 1,
      },
      signature_2: {
        display_label: "Additional Payee Signature",
        display_help_text: "If you are a named payee on the check, sign here.",
        display_section: "Endorsement",
        display_order: 2,
      },
      text_1: {
        display_label: "Printed Name",
        display_help_text: "Enter the printed name of the person endorsing the check.",
        display_section: "Endorsement",
        display_order: 3,
      },
      date_1: {
        display_label: "Date Signed",
        display_help_text: "Enter the date the check was endorsed.",
        display_section: "Endorsement",
        display_order: 4,
      },
    },
  },
  payment_authorization: {
    label: "Payment Authorization",
    description: "Authorization for payment or disbursement",
    fields: {
      signature_1: {
        display_label: "Authorizing Signature",
        display_help_text: "Sign here to authorize the payment described in this document.",
        display_section: "Authorization",
        display_order: 1,
      },
      text_1: {
        display_label: "Authorized By (Printed Name)",
        display_help_text: "Enter the full name of the person authorizing this payment.",
        display_section: "Authorization",
        display_order: 2,
      },
      date_1: {
        display_label: "Date Authorized",
        display_help_text: "Enter the date this payment was authorized.",
        display_section: "Authorization",
        display_order: 3,
      },
    },
  },
  work_authorization: {
    label: "Work Authorization",
    description: "Authorization to begin work or repairs",
    fields: {
      signature_1: {
        display_label: "Property Owner Signature",
        display_help_text: "Sign here to authorize the described work to begin on your property.",
        display_section: "Authorization",
        display_order: 1,
      },
      text_1: {
        display_label: "Property Owner Printed Name",
        display_help_text: "Enter the full legal name of the property owner.",
        display_section: "Identification",
        display_order: 2,
      },
      date_1: {
        display_label: "Date Authorized",
        display_help_text: "Enter the date the work was authorized to begin.",
        display_section: "Authorization",
        display_order: 3,
      },
      checkbox_1: {
        display_label: "Acknowledgement",
        display_help_text: "Check here to confirm you understand the scope of work described above.",
        display_section: "Acknowledgements",
        display_order: 4,
      },
    },
  },
};

/**
 * Available document type options for the admin template editor.
 */
export const DOCUMENT_TYPE_OPTIONS = Object.entries(SIGNER_DISPLAY_TEMPLATES).map(
  ([key, template]) => ({
    value: key,
    label: template.label,
    description: template.description,
  })
);

/**
 * Given a field type and its 1-based index among same-type fields,
 * returns the template key used to look up display metadata.
 */
export function getFieldTemplateKey(fieldType: string, indexAmongSameType: number): string {
  return `${fieldType}_${indexAmongSameType}`;
}

/**
 * Resolve display metadata for a field.
 * Priority: field-level overrides > document type template > null
 */
export function resolveFieldDisplay(
  field: {
    type?: string;
    field_type?: string;
    display_label?: string;
    display_help_text?: string;
    display_section?: string;
    display_order?: number;
  },
  documentType: string | null | undefined,
  indexAmongSameType: number,
): FieldDisplayMeta | null {
  // 1. Field-level overrides take priority
  if (field.display_label) {
    return {
      display_label: field.display_label,
      display_help_text: field.display_help_text || "",
      display_section: field.display_section,
      display_order: field.display_order,
    };
  }

  // 2. Look up from document type template
  if (documentType && SIGNER_DISPLAY_TEMPLATES[documentType]) {
    const template = SIGNER_DISPLAY_TEMPLATES[documentType];
    const fieldType = field.type || field.field_type || "text";
    const key = getFieldTemplateKey(fieldType, indexAmongSameType);
    if (template.fields[key]) {
      return template.fields[key];
    }
  }

  return null;
}

/**
 * Detect document type from document name heuristics.
 */
export function detectDocumentType(documentName: string): string | null {
  const name = (documentName || "").toLowerCase();
  if (name.includes("endorsement") || name.includes("check")) return "check_endorsement";
  if (name.includes("work auth") || name.includes("authorization to")) return "work_authorization";
  if (name.includes("payment auth")) return "payment_authorization";
  if (name.includes("contract") || name.includes("agreement")) return "contract";
  return null;
}
