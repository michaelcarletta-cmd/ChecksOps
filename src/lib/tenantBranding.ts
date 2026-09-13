/**
 * Branding & Email company identity is tenant-scoped (`tenants`), not the
 * global `company_branding` singleton. Outbound email already resolves from
 * `tenants` / `tenant_email_settings` — this keeps the settings UI on the
 * same source of truth.
 *
 * Persist only columns the staging write-allowlist accepts on `tenants`.
 */
export const TENANT_BRANDING_READ_COLUMNS =
  "id, name, logo_url, business_address, business_phone, email_reply_to, invoice_letterhead_url, invoice_footer_note, invoice_default_terms, invoice_accent_color, invoice_theme, primary_color";

export type TenantBrandingRow = {
  id: string;
  name?: string | null;
  logo_url?: string | null;
  business_address?: string | null;
  business_phone?: string | null;
  email_reply_to?: string | null;
  invoice_letterhead_url?: string | null;
  invoice_footer_note?: string | null;
  invoice_default_terms?: string | null;
  invoice_accent_color?: string | null;
  invoice_theme?: string | null;
  primary_color?: string | null;
};

export type TenantBrandingForm = {
  companyName: string;
  address: string;
  phone: string;
  email: string;
  logoUrl: string | null;
  invoiceLetterheadUrl: string | null;
  invoiceFooterNote: string;
  invoiceDefaultTerms: string;
  invoiceAccentColor: string;
  invoiceTheme: "light" | "dark";
};

export const TENANT_BRANDING_WRITE_COLUMNS = [
  "name",
  "logo_url",
  "invoice_letterhead_url",
  "invoice_footer_note",
  "invoice_default_terms",
] as const;

export function tenantBrandingFromRow(row: TenantBrandingRow | null | undefined): TenantBrandingForm {
  const tenant = row || ({} as TenantBrandingRow);
  return {
    companyName: tenant.name || "",
    address: tenant.business_address || "",
    phone: tenant.business_phone || "",
    email: tenant.email_reply_to || "",
    logoUrl: tenant.logo_url || null,
    invoiceLetterheadUrl: tenant.invoice_letterhead_url || null,
    invoiceFooterNote: tenant.invoice_footer_note || "",
    invoiceDefaultTerms: tenant.invoice_default_terms || "",
    invoiceAccentColor: tenant.invoice_accent_color || tenant.primary_color || "#3B82F6",
    invoiceTheme: tenant.invoice_theme === "dark" ? "dark" : "light",
  };
}

export function tenantBrandingWritePayload(form: TenantBrandingForm): Record<(typeof TENANT_BRANDING_WRITE_COLUMNS)[number], string | null> {
  return {
    name: form.companyName,
    logo_url: form.logoUrl,
    invoice_letterhead_url: form.invoiceLetterheadUrl,
    invoice_footer_note: form.invoiceFooterNote,
    invoice_default_terms: form.invoiceDefaultTerms,
  };
}
