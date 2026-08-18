/**
 * Pure validation for the admin-only merchant bulk-import PREVIEW.
 *
 * This layer never creates provider accounts. It exists so an existing book of
 * merchants can be validated and de-duplicated ahead of a future migration
 * run. Highly sensitive identity data (SSN/EIN/DOB, bank numbers) is REJECTED
 * outright — that data belongs in the provider-hosted onboarding flow, never in
 * an import file or in our database.
 */

export interface ImportRow {
  tenant_id?: string | null;
  legal_business_name?: string | null;
  email?: string | null;
  phone?: string | null;
  address_line1?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  [key: string]: unknown;
}

export interface RowIssue {
  field: string;
  message: string;
  severity: "error" | "warning";
}

export interface ValidatedRow {
  index: number;
  valid: boolean;
  issues: RowIssue[];
  normalized: {
    tenantId: string | null;
    legalBusinessName: string | null;
    email: string | null;
    phone: string | null;
    address: {
      addressLine1: string | null;
      city: string | null;
      stateOrProvince: string | null;
      postalCode: string | null;
      country: "US";
    } | null;
  };
}

/** Fields that must never appear in an import file. */
export const FORBIDDEN_FIELDS = [
  "ssn",
  "social_security_number",
  "ein",
  "tax_id",
  "taxid",
  "date_of_birth",
  "dob",
  "account_number",
  "routing_number",
  "card_number",
];

export const MAX_IMPORT_ROWS = 500;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizePhone(value: unknown): string | null {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length < 10) return null;
  return digits.slice(-10);
}

export function validateRow(row: ImportRow, index: number): ValidatedRow {
  const issues: RowIssue[] = [];

  for (const key of Object.keys(row ?? {})) {
    const flat = key.toLowerCase().replace(/[\s-]/g, "_");
    if (FORBIDDEN_FIELDS.includes(flat)) {
      issues.push({
        field: key,
        message: "Sensitive identity or bank data must not be imported. Collect it in the provider-hosted flow.",
        severity: "error",
      });
    }
  }

  const tenantId = typeof row.tenant_id === "string" && UUID_RE.test(row.tenant_id.trim())
    ? row.tenant_id.trim()
    : null;
  if (!tenantId) {
    issues.push({ field: "tenant_id", message: "A valid organization id is required.", severity: "error" });
  }

  const legalBusinessName = String(row.legal_business_name ?? "").trim() || null;
  if (!legalBusinessName) {
    issues.push({ field: "legal_business_name", message: "Legal business name is required.", severity: "error" });
  } else if (legalBusinessName.length > 120) {
    issues.push({ field: "legal_business_name", message: "Name is longer than 120 characters.", severity: "error" });
  }

  const emailRaw = String(row.email ?? "").trim().toLowerCase();
  const email = emailRaw && EMAIL_RE.test(emailRaw) ? emailRaw : null;
  if (emailRaw && !email) {
    issues.push({ field: "email", message: "Email address is not valid.", severity: "error" });
  }
  if (!emailRaw) {
    issues.push({ field: "email", message: "No contact email — the merchant will have to supply one.", severity: "warning" });
  }

  const phone = normalizePhone(row.phone);
  if (row.phone && !phone) {
    issues.push({ field: "phone", message: "Phone number must contain at least 10 digits.", severity: "warning" });
  }

  const line1 = String(row.address_line1 ?? "").trim() || null;
  const city = String(row.city ?? "").trim() || null;
  const state = String(row.state ?? "").trim().toUpperCase() || null;
  const postal = String(row.postal_code ?? "").trim() || null;
  const hasAnyAddress = !!(line1 || city || state || postal);
  if (hasAnyAddress && !(line1 && city && state && postal)) {
    issues.push({ field: "address", message: "Partial address — provide street, city, state and ZIP together.", severity: "warning" });
  }
  if (state && state.length !== 2) {
    issues.push({ field: "state", message: "State must be the 2-letter code.", severity: "warning" });
  }

  return {
    index,
    valid: !issues.some((i) => i.severity === "error"),
    issues,
    normalized: {
      tenantId,
      legalBusinessName,
      email,
      phone,
      address: line1 && city && state && postal
        ? { addressLine1: line1, city, stateOrProvince: state, postalCode: postal, country: "US" }
        : null,
    },
  };
}

export interface ImportPreview {
  totalRows: number;
  validRows: number;
  invalidRows: number;
  duplicateTenantIds: string[];
  rows: ValidatedRow[];
  errors: string[];
}

export function previewImport(rows: ImportRow[] | null | undefined): ImportPreview {
  const list = Array.isArray(rows) ? rows : [];
  const errors: string[] = [];
  if (list.length === 0) errors.push("The import file contained no rows.");
  if (list.length > MAX_IMPORT_ROWS) {
    errors.push(`Import files are limited to ${MAX_IMPORT_ROWS} rows; received ${list.length}.`);
  }

  const validated = list.slice(0, MAX_IMPORT_ROWS).map((r, i) => validateRow(r ?? {}, i));

  const seen = new Map<string, number>();
  const duplicates = new Set<string>();
  for (const r of validated) {
    const id = r.normalized.tenantId;
    if (!id) continue;
    if (seen.has(id)) {
      duplicates.add(id);
      r.issues.push({ field: "tenant_id", message: "Duplicate organization in this file.", severity: "error" });
      r.valid = false;
    }
    seen.set(id, r.index);
  }

  return {
    totalRows: list.length,
    validRows: validated.filter((r) => r.valid).length,
    invalidRows: validated.filter((r) => !r.valid).length,
    duplicateTenantIds: Array.from(duplicates),
    rows: validated,
    errors,
  };
}
