import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Printer, FileText, CheckCircle2, AlertTriangle, Building2, Users, Shield, FileCheck } from "lucide-react";
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

const payeeTypeIcons: Record<string, typeof Users> = {
  insured: Users,
  mortgage_company: Building2,
  contractor: Shield,
  public_adjuster: FileCheck,
  unknown: AlertTriangle,
};

const endorsementBadge: Record<string, { color: string; label: string }> = {
  pending: { color: "bg-muted text-muted-foreground", label: "Pending" },
  signed: { color: "bg-emerald-500/20 text-emerald-400", label: "Signed" },
  rejected: { color: "bg-red-500/20 text-red-400", label: "Rejected" },
  expired: { color: "bg-muted text-muted-foreground", label: "Expired" },
};

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
        .select("*, check_payees(*)")
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

  const handlePrint = () => {
    if (!printRef.current) return;
    const printWindow = window.open("", "_blank");
    if (!printWindow) return;
    printWindow.document.write(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Deposit Packet — Check #${check?.check_number ?? "Unknown"}</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 2rem; color: #1a1a2e; }
          h1 { font-size: 1.25rem; margin-bottom: 0.25rem; }
          h2 { font-size: 1rem; color: #444; margin-top: 1.5rem; margin-bottom: 0.5rem; border-bottom: 1px solid #ddd; padding-bottom: 0.25rem; }
          .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; }
          .meta-item label { font-size: 0.7rem; color: #888; text-transform: uppercase; letter-spacing: 0.5px; }
          .meta-item p { font-size: 0.9rem; margin: 0.15rem 0 0 0; font-weight: 500; }
          .payee-table { width: 100%; border-collapse: collapse; margin-top: 0.5rem; }
          .payee-table th, .payee-table td { border: 1px solid #ddd; padding: 0.4rem 0.6rem; text-align: left; font-size: 0.85rem; }
          .payee-table th { background: #f5f5f5; font-weight: 600; }
          .badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 9999px; font-size: 0.7rem; font-weight: 500; }
          .badge-signed { background: #d1fae5; color: #065f46; }
          .badge-pending { background: #f3f4f6; color: #6b7280; }
          .badge-rejected { background: #fee2e2; color: #991b1b; }
          .notes { background: #f9f9f9; padding: 0.75rem; border-radius: 0.25rem; font-size: 0.85rem; margin-top: 0.5rem; }
          .check-img { max-width: 100%; max-height: 300px; border: 1px solid #ddd; border-radius: 0.25rem; }
          .footer { margin-top: 2rem; padding-top: 0.75rem; border-top: 1px solid #ddd; font-size: 0.7rem; color: #999; }
          @media print { body { padding: 1rem; } }
        </style>
      </head>
      <body>${printRef.current.innerHTML}
        <div class="footer">
          Generated ${new Date().toLocaleString()} · Freedom Adjustment Deposit Packet
        </div>
      </body>
      </html>
    `);
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

      {/* Visible preview */}
      <Card>
        <CardContent className="p-4 text-sm space-y-3">
          <div ref={printRef}>
            <h1>Deposit Packet</h1>
            <p style={{ color: "#888", fontSize: "0.8rem" }}>
              Check #{check.check_number ?? "Unknown"} · {check.carrier_name ?? "Unknown Carrier"}
            </p>

            <h2>Check Details</h2>
            <div className="meta" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem" }}>
              <div className="meta-item">
                <label style={{ fontSize: "0.65rem", color: "#888", textTransform: "uppercase" }}>Carrier</label>
                <p style={{ fontSize: "0.85rem", fontWeight: 500, margin: "0.1rem 0 0" }}>{check.carrier_name ?? "—"}</p>
              </div>
              <div className="meta-item">
                <label style={{ fontSize: "0.65rem", color: "#888", textTransform: "uppercase" }}>Amount</label>
                <p style={{ fontSize: "0.85rem", fontWeight: 700, margin: "0.1rem 0 0" }}>
                  {check.amount != null ? `$${check.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}` : "—"}
                </p>
              </div>
              <div className="meta-item">
                <label style={{ fontSize: "0.65rem", color: "#888", textTransform: "uppercase" }}>Check #</label>
                <p style={{ fontSize: "0.85rem", fontWeight: 500, margin: "0.1rem 0 0", fontFamily: "monospace" }}>{check.check_number ?? "—"}</p>
              </div>
              <div className="meta-item">
                <label style={{ fontSize: "0.65rem", color: "#888", textTransform: "uppercase" }}>Claim #</label>
                <p style={{ fontSize: "0.85rem", fontWeight: 500, margin: "0.1rem 0 0" }}>{check.detected_claim_number ?? "—"}</p>
              </div>
              <div className="meta-item">
                <label style={{ fontSize: "0.65rem", color: "#888", textTransform: "uppercase" }}>Issue Date</label>
                <p style={{ fontSize: "0.85rem", margin: "0.1rem 0 0" }}>
                  {check.issue_date ? format(new Date(check.issue_date), "MMM d, yyyy") : "—"}
                </p>
              </div>
              <div className="meta-item">
                <label style={{ fontSize: "0.65rem", color: "#888", textTransform: "uppercase" }}>Recommendation</label>
                <p style={{ fontSize: "0.85rem", fontWeight: 500, margin: "0.1rem 0 0" }}>
                  {check.deposit_recommendation?.replace(/_/g, " ") ?? "—"}
                </p>
              </div>
            </div>

            <h2>Payees & Endorsements</h2>
            <table className="payee-table" style={{ width: "100%", borderCollapse: "collapse", marginTop: "0.5rem" }}>
              <thead>
                <tr>
                  <th style={{ border: "1px solid #ddd", padding: "0.4rem", background: "#f5f5f5", fontSize: "0.8rem" }}>Payee</th>
                  <th style={{ border: "1px solid #ddd", padding: "0.4rem", background: "#f5f5f5", fontSize: "0.8rem" }}>Type</th>
                  <th style={{ border: "1px solid #ddd", padding: "0.4rem", background: "#f5f5f5", fontSize: "0.8rem" }}>Status</th>
                  <th style={{ border: "1px solid #ddd", padding: "0.4rem", background: "#f5f5f5", fontSize: "0.8rem" }}>Date</th>
                </tr>
              </thead>
              <tbody>
                {(check.check_payees ?? []).map((p) => (
                  <tr key={p.id}>
                    <td style={{ border: "1px solid #ddd", padding: "0.4rem", fontSize: "0.8rem" }}>{p.payee_name}</td>
                    <td style={{ border: "1px solid #ddd", padding: "0.4rem", fontSize: "0.8rem" }}>{payeeTypeLabels[p.payee_type] ?? p.payee_type}</td>
                    <td style={{ border: "1px solid #ddd", padding: "0.4rem", fontSize: "0.8rem" }}>
                      <span className={`badge badge-${p.endorsement_status}`}>{p.endorsement_status}</span>
                    </td>
                    <td style={{ border: "1px solid #ddd", padding: "0.4rem", fontSize: "0.8rem" }}>
                      {p.endorsed_at ? format(new Date(p.endorsed_at), "MMM d, yyyy") : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {latestDecision && (
              <>
                <h2>Reviewer Decision</h2>
                <div className="notes" style={{ background: "#f9f9f9", padding: "0.75rem", borderRadius: "0.25rem" }}>
                  <p style={{ fontSize: "0.8rem", margin: 0 }}>
                    <strong>Decision:</strong> {latestDecision.deposit_path?.replace(/_/g, " ")}
                  </p>
                  {latestDecision.reviewer_notes && (
                    <p style={{ fontSize: "0.8rem", marginTop: "0.3rem" }}>
                      <strong>Notes:</strong> {latestDecision.reviewer_notes}
                    </p>
                  )}
                  <p style={{ fontSize: "0.7rem", color: "#888", marginTop: "0.3rem" }}>
                    Reviewed {format(new Date(latestDecision.created_at), "MMM d, yyyy h:mm a")}
                  </p>
                </div>
              </>
            )}

            {check.review_notes && !latestDecision && (
              <>
                <h2>Reviewer Notes</h2>
                <div className="notes" style={{ background: "#f9f9f9", padding: "0.75rem", borderRadius: "0.25rem", fontSize: "0.85rem" }}>
                  {check.review_notes}
                </div>
              </>
            )}

            {imageUrl && (
              <>
                <h2>Check Image</h2>
                <img src={imageUrl} alt="Check front" className="check-img" style={{ maxWidth: "100%", maxHeight: "300px", border: "1px solid #ddd", borderRadius: "0.25rem" }} />
              </>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
