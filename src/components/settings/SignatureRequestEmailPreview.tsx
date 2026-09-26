import { Mail } from "lucide-react";
import { TenantLogo } from "@/components/branding/TenantLogo";
import {
  DEFAULT_SIGNATURE_DOCUMENT_NAME,
  PLATFORM_SUPPORT_EMAIL,
  formatSignatureRequestFrom,
  signatureRequestSubject,
} from "@/lib/signatureRequestSender";

export type SignatureRequestEmailPreviewProps = {
  tenantName: string;
  logoUrl?: string | null;
  primaryColor?: string | null;
  replyTo?: string | null;
  documentName?: string;
};

export function SignatureRequestEmailPreview({
  tenantName,
  logoUrl,
  primaryColor,
  replyTo,
  documentName = DEFAULT_SIGNATURE_DOCUMENT_NAME,
}: SignatureRequestEmailPreviewProps) {
  const from = formatSignatureRequestFrom(tenantName);
  const subject = signatureRequestSubject(documentName);
  const color = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(primaryColor || ""))
    ? String(primaryColor)
    : "#3B82F6";
  const displayName = String(tenantName || "").replace(/\s+via\s+ChecksOps\s*$/i, "").trim();
  const reply = String(replyTo || "").trim();

  return (
    <section
      data-testid="signature-request-email-preview"
      className="space-y-3 rounded-lg border border-border/60 p-4"
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        <Mail className="h-4 w-4 text-emerald-500" />
        Email Preview
      </div>
      <p className="text-xs text-muted-foreground">
        How a signature-request email appears to a recipient. This preview does not send mail.
      </p>

      <div className="space-y-1 rounded-md border bg-muted/40 p-3 text-sm">
        <div data-testid="signature-preview-from">
          <span className="text-muted-foreground">From: </span>
          <span>{from}</span>
        </div>
        {reply ? (
          <div data-testid="signature-preview-reply-to">
            <span className="text-muted-foreground">Reply-To: </span>
            <span>{reply}</span>
          </div>
        ) : null}
        <div data-testid="signature-preview-subject">
          <span className="text-muted-foreground">Subject: </span>
          <span>{subject}</span>
        </div>
      </div>

      <div
        data-testid="signature-preview-appearance"
        className="overflow-hidden rounded-md border bg-[#f1f5f9]"
      >
        <div className="mx-auto max-w-[600px] overflow-hidden rounded-xl border border-[#e2e8f0] bg-white">
          <div className="border-b border-[#e2e8f0] px-6 py-4">
            <TenantLogo
              src={logoUrl}
              alt={`${displayName || "Tenant"} logo`}
              className="h-10 max-w-[220px] object-contain"
              fallback={<div className="text-sm font-medium text-slate-700">{displayName}</div>}
            />
            {displayName ? (
              <p data-testid="signature-preview-company-name" className="mt-1 text-xs text-slate-500">
                {displayName}
              </p>
            ) : null}
          </div>
          <div className="h-1" style={{ backgroundColor: color }} />
          <div className="space-y-3 px-6 py-6 text-sm text-slate-700">
            <h3 className="text-lg font-semibold text-slate-900">{subject}</h3>
            <p>Hello,</p>
            <p>Please review and sign {documentName}.</p>
            <div className="pt-2">
              <span
                data-testid="signature-preview-sign-button"
                className="inline-block rounded-md px-4 py-2 text-sm font-bold text-white"
                style={{ backgroundColor: color }}
              >
                Review and sign
              </span>
            </div>
          </div>
          <div className="border-t border-[#e2e8f0] px-6 py-4 text-xs text-slate-500">
            <p>
              Questions? Contact{" "}
              <a href={`mailto:${PLATFORM_SUPPORT_EMAIL}`} className="underline" style={{ color }}>
                {PLATFORM_SUPPORT_EMAIL}
              </a>
            </p>
            <p className="mt-2 text-[11px] text-slate-400">Sent by ChecksOps</p>
          </div>
        </div>
      </div>
    </section>
  );
}
