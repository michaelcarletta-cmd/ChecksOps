/**
 * SPA representation of the accepted signature-request sender contract.
 *
 * The production sender is enforced in aws/functions/api/esign.mjs and is
 * release-locked. This helper only formats the same From header for preview.
 * It does not send mail and does not change shared email branding.
 */

export const PLATFORM_SUPPORT_EMAIL = "support@checksops.com";

export const SIGNATURE_REQUEST_SUBJECT_TEMPLATE = "Action Required: Sign {document.name}";

export const DEFAULT_SIGNATURE_DOCUMENT_NAME = "Release";

const stripViaChecksOps = (name: string) =>
  String(name || "")
    .replace(/\s+via\s+ChecksOps\s*$/i, "")
    .trim();

export function formatSignatureRequestFrom(tenantName: string | null | undefined): string {
  const name = stripViaChecksOps(tenantName || "");
  return `${name} <${PLATFORM_SUPPORT_EMAIL}>`;
}

export function signatureRequestSubject(documentName: string | null | undefined = DEFAULT_SIGNATURE_DOCUMENT_NAME): string {
  const document = String(documentName || DEFAULT_SIGNATURE_DOCUMENT_NAME).trim() || DEFAULT_SIGNATURE_DOCUMENT_NAME;
  return SIGNATURE_REQUEST_SUBJECT_TEMPLATE.replace("{document.name}", document);
}
