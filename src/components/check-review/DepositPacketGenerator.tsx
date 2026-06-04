import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Printer, FileText } from "lucide-react";
import { format } from "date-fns";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface DepositPacketCheck {
  id: string;
  carrier_name: string | null;
  check_number: string | null;
  amount: number | null;
  issue_date: string | null;
  payee_line: string | null;
  detected_claim_number: string | null;
  claim_id: string | null;
  is_multi_payee: boolean;
  status: string;
  deposit_recommendation: string | null;
  deposit_recommendation_reasons: string[] | null;
  review_notes: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  front_image_path: string;
  back_image_path: string | null;
  check_payees?: {
    id: string;
    payee_name: string;
    payee_type: string;
    endorsement_status: string;
    endorsed_at: string | null;
  }[];
}

const payeeTypeLabels: Record<string, string> = {
  insured: "Insured",
  mortgage_company: "Mortgage Company",
  contractor: "Contractor",
  public_adjuster: "Public Adjuster",
  unknown: "Unknown",
};

/* ------------------------------------------------------------------ */
/*  HTML escape for print-safe output                                  */
/* ------------------------------------------------------------------ */

function esc(value: unknown): string {
  if (value == null) return "—";
  const str = String(value);
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtAmount(amount: number | null): string {
  if (amount == null) return "—";
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
}

function fmtDate(dateStr: string | null): string {
  if (!dateStr) return "—";
  try { return format(new Date(dateStr), "MMM d, yyyy"); } catch { return "—"; }
}

/* ------------------------------------------------------------------ */
/*  Deposit Packet Generator                                           */
/* ------------------------------------------------------------------ */

export function DepositPacketGenerator({ checkId }: { checkId: string }) {
  const printRef = useRef<HTMLDivElement>(null);

  const { data: check } = useQuery({
    queryKey: ["deposit-packet", checkId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("check_intake_items")
        .select("*, check_payees(*), tenants(name)")
        .eq("id", checkId)
        .single();
      if (error) throw error;
      return data as DepositPacketCheck;
    },
  });

  const { data: reviewDecisions = [] } = useQuery({
    queryKey: ["deposit-packet-decisions", checkId],
    queryFn: async () => {
      const { data } = await supabase
        .from("check_review_decisions")
        .select("*")
        .eq("check_id", checkId)
        .order("created_at", { ascending: false });
      return data ?? [];
    },
  });

  // Fetch reviewer profile for name display
  const { data: reviewerProfile } = useQuery({
    queryKey: ["deposit-packet-reviewer", check?.reviewed_by],
    enabled: !!check?.reviewed_by,
    queryFn: async () => {
      const { data } = await supabase
        .from("profiles")
        .select("full_name, email")
        .eq("id", check!.reviewed_by!)
        .single();
      return data;
    },
  });

  const { data: imageUrl } = useQuery({
    queryKey: ["check-image-url", check?.front_image_path],
    enabled: !!check?.front_image_path,
    queryFn: async () => {
      const { data } = await supabase.storage
        .from("claim-files")
        .createSignedUrl(check!.front_image_path, 3600);
      return data?.signedUrl ?? null;
    },
  });

  const { data: backImageUrl } = useQuery({
    queryKey: ["check-back-image-url", check?.back_image_path],
    enabled: !!check?.back_image_path,
    queryFn: async () => {
      const { data } = await supabase.storage
        .from("claim-files")
        .createSignedUrl(check!.back_image_path!, 3600);
      return data?.signedUrl ?? null;
    },
  });

  const handlePrint = () => {
    if (!check) return;
    const printWindow = window.open("", "_blank");
    if (!printWindow) return;

    const payeeRows = (check.check_payees ?? []).map((p) =>
      `<tr>
        <td style="border:1px solid #ddd;padding:0.4rem;font-size:0.8rem">${esc(p.payee_name)}</td>
        <td style="border:1px solid #ddd;padding:0.4rem;font-size:0.8rem">${esc(payeeTypeLabels[p.payee_type] ?? p.payee_type)}</td>
        <td style="border:1px solid #ddd;padding:0.4rem;font-size:0.8rem">${esc(p.endorsement_status)}</td>
        <td style="border:1px solid #ddd;padding:0.4rem;font-size:0.8rem">${p.endorsed_at ? esc(fmtDate(p.endorsed_at)) : "—"}</td>
      </tr>`
    ).join("");

    const reviewerName = reviewerProfile?.full_name || reviewerProfile?.email || "Staff";
    const companyName = (check as any).tenants?.name || "Freedom Adjustment";
    const latestDecision = reviewDecisions[0];
    const decisionHtml = latestDecision ? `
      <h2>Reviewer Decision</h2>
      <div class="notes">
        <p><strong>Decision:</strong> ${esc(latestDecision.deposit_path?.replace(/_/g, " "))}</p>
        <p><strong>Reviewed by:</strong> ${esc(reviewerName)}</p>
        ${latestDecision.reviewer_notes ? `<p><strong>Notes:</strong> ${esc(latestDecision.reviewer_notes)}</p>` : ""}
        <p style="font-size:0.7rem;color:#888;margin-top:0.3rem">Reviewed ${esc(fmtDate(latestDecision.created_at))}</p>
      </div>
    ` : "";

    const reviewNotesHtml = check.review_notes && !latestDecision ? `
      <h2>Reviewer Notes</h2>
      <div class="notes">${esc(check.review_notes)}</div>
    ` : "";

    const frontImgHtml = imageUrl ? `
      <h2>Check Front</h2>
      <img src="${esc(imageUrl)}" alt="Check front" class="check-img" />
    ` : "";

    const backImgHtml = backImageUrl ? `
      <h2>Check Back (Endorsements)</h2>
      <img src="${esc(backImageUrl)}" alt="Check back with endorsements" class="check-img" />
    ` : "";

    printWindow.document.write(`<!DOCTYPE html><html><head>
      <title>Deposit Packet — Check #${esc(check.check_number ?? "Unknown")}</title>
      <style>
        body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:2rem;color:#1a1a2e}
        h1{font-size:1.25rem;margin-bottom:0.25rem}
        h2{font-size:1rem;color:#444;margin-top:1.5rem;margin-bottom:0.5rem;border-bottom:1px solid #ddd;padding-bottom:0.25rem}
        .meta{display:grid;grid-template-columns:1fr 1fr;gap:0.5rem}
        .meta-item label{font-size:0.7rem;color:#888;text-transform:uppercase;letter-spacing:0.5px}
        .meta-item p{font-size:0.9rem;margin:0.15rem 0 0;font-weight:500}
        .notes{background:#f9f9f9;padding:0.75rem;border-radius:0.25rem;font-size:0.85rem;margin-top:0.5rem}
        .check-img{display:block;width:100%;height:auto;border:1px solid #ddd;border-radius:0.25rem}
        .footer{margin-top:2rem;padding-top:0.75rem;border-top:1px solid #ddd;font-size:0.7rem;color:#999}
        table{width:100%;border-collapse:collapse;margin-top:0.5rem}
        th{border:1px solid #ddd;padding:0.4rem;background:#f5f5f5;font-weight:600;font-size:0.8rem;text-align:left}
        @media print{body{padding:1rem}}
      </style>
    </head><body>
      <h1>Deposit Packet</h1>
      <p style="color:#888;font-size:0.8rem">Check #${esc(check.check_number ?? "Unknown")} · ${esc(check.carrier_name ?? "Unknown Carrier")}</p>
      <h2>Check Details</h2>
      <div class="meta">
        <div class="meta-item"><label>Carrier</label><p>${esc(check.carrier_name)}</p></div>
        <div class="meta-item"><label>Amount</label><p style="font-weight:700">${esc(fmtAmount(check.amount))}</p></div>
        <div class="meta-item"><label>Check #</label><p style="font-family:monospace">${esc(check.check_number)}</p></div>
        <div class="meta-item"><label>Claim #</label><p>${esc(check.detected_claim_number)}</p></div>
        <div class="meta-item"><label>Issue Date</label><p>${esc(fmtDate(check.issue_date))}</p></div>
        <div class="meta-item"><label>Recommendation</label><p>${esc(check.deposit_recommendation?.replace(/_/g, " "))}</p></div>
      </div>
      <h2>Payees &amp; Endorsements</h2>
      <table>
        <thead><tr><th>Payee</th><th>Type</th><th>Status</th><th>Date</th></tr></thead>
        <tbody>${payeeRows}</tbody>
      </table>
      ${decisionHtml}
      ${reviewNotesHtml}
      ${frontImgHtml}
      ${backImgHtml}
      <div class="footer">Generated ${esc(new Date().toLocaleString())} · ${esc(companyName)} Deposit Packet</div>
    </body></html>`);
    printWindow.document.close();
    printWindow.print();
  };

  if (!check) return null;

  const latestDecision = reviewDecisions[0];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <FileText className="h-4 w-4" />Deposit Packet
        </h3>
        <Button size="sm" variant="outline" onClick={handlePrint}>
          <Printer className="h-3.5 w-3.5 mr-1" />Print / Export
        </Button>
      </div>

      <Card>
        <CardContent className="p-4 text-sm space-y-3">
          <div ref={printRef}>
            <h1 className="text-base font-bold">Deposit Packet</h1>
            <p className="text-xs text-muted-foreground">
              Check #{check.check_number ?? "Unknown"} · {check.carrier_name ?? "Unknown Carrier"}
            </p>

            <h2 className="text-sm font-semibold mt-3 mb-1 border-b border-border pb-1">Check Details</h2>
            <div className="grid grid-cols-2 gap-2">
              <div><p className="text-[10px] text-muted-foreground uppercase">Carrier</p><p className="text-xs font-medium">{check.carrier_name ?? "—"}</p></div>
              <div><p className="text-[10px] text-muted-foreground uppercase">Amount</p><p className="text-xs font-bold">{fmtAmount(check.amount)}</p></div>
              <div><p className="text-[10px] text-muted-foreground uppercase">Check #</p><p className="text-xs font-mono">{check.check_number ?? "—"}</p></div>
              <div><p className="text-[10px] text-muted-foreground uppercase">Claim #</p><p className="text-xs">{check.detected_claim_number ?? "—"}</p></div>
              <div><p className="text-[10px] text-muted-foreground uppercase">Issue Date</p><p className="text-xs">{fmtDate(check.issue_date)}</p></div>
              <div><p className="text-[10px] text-muted-foreground uppercase">Recommendation</p><p className="text-xs">{check.deposit_recommendation?.replace(/_/g, " ") ?? "—"}</p></div>
            </div>

            <h2 className="text-sm font-semibold mt-3 mb-1 border-b border-border pb-1">Payees & Endorsements</h2>
            <div className="space-y-1">
              {(check.check_payees ?? []).map((p) => (
                <div key={p.id} className="flex items-center justify-between text-xs py-1 border-b border-border/50 last:border-0">
                  <span className="font-medium">{p.payee_name}</span>
                  <span className="text-muted-foreground">{payeeTypeLabels[p.payee_type] ?? p.payee_type}</span>
                  <span className={
                    p.endorsement_status === "signed" ? "text-emerald-400" :
                    p.endorsement_status === "rejected" ? "text-red-400" :
                    "text-muted-foreground"
                  }>{p.endorsement_status}</span>
                  <span className="text-muted-foreground">{p.endorsed_at ? fmtDate(p.endorsed_at) : "—"}</span>
                </div>
              ))}
            </div>

            {latestDecision && (
              <>
                <h2 className="text-sm font-semibold mt-3 mb-1 border-b border-border pb-1">Reviewer Decision</h2>
                <div className="bg-muted/50 p-2 rounded text-xs space-y-1">
                  <p><strong>Decision:</strong> {latestDecision.deposit_path?.replace(/_/g, " ")}</p>
                  <p><strong>Reviewed by:</strong> {reviewerProfile?.full_name || reviewerProfile?.email || "Staff"}</p>
                  {latestDecision.reviewer_notes && <p><strong>Notes:</strong> {latestDecision.reviewer_notes}</p>}
                  <p className="text-muted-foreground text-[10px]">
                    Reviewed {format(new Date(latestDecision.created_at), "MMM d, yyyy h:mm a")}
                  </p>
                </div>
              </>
            )}

            {check.review_notes && !latestDecision && (
              <>
                <h2 className="text-sm font-semibold mt-3 mb-1 border-b border-border pb-1">Reviewer Notes</h2>
                <div className="bg-muted/50 p-2 rounded text-xs">{check.review_notes}</div>
              </>
            )}

            {imageUrl && (
              <>
                <h2 className="text-sm font-semibold mt-3 mb-1 border-b border-border pb-1">Check Front</h2>
                <img src={imageUrl} alt="Check front" className="max-w-full border border-border rounded" />
              </>
            )}

            {backImageUrl && (
              <>
                <h2 className="text-sm font-semibold mt-3 mb-1 border-b border-border pb-1">Check Back (Endorsements)</h2>
                <img src={backImageUrl} alt="Check back with endorsements" className="max-w-full border border-border rounded" />
              </>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
