import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { FileDown, Shield, AlertTriangle } from "lucide-react";
import { useRef } from "react";

interface StrategicMemoData {
  executive_summary: string;
  strongest_leverage: string;
  greatest_vulnerability: string;
  immediate_action: string;
  thirty_day_plan: string;
  escalation_trigger: string;
  settlement_range: string;
  bad_faith_viability: string;
}

interface StrategicMemoProps {
  memo: StrategicMemoData | null;
  claimNumber?: string;
  driftDetected?: boolean;
  driftReason?: string | null;
}

const sections: { key: keyof StrategicMemoData; label: string; icon: string }[] = [
  { key: "executive_summary", label: "1. Executive Strategic Summary", icon: "📋" },
  { key: "strongest_leverage", label: "2. Strongest Leverage Point", icon: "💪" },
  { key: "greatest_vulnerability", label: "3. Greatest Vulnerability", icon: "⚠️" },
  { key: "immediate_action", label: "4. Immediate Recommended Action", icon: "🎯" },
  { key: "thirty_day_plan", label: "5. 30-Day Tactical Plan", icon: "📅" },
  { key: "escalation_trigger", label: "6. Escalation Threshold Trigger", icon: "🔺" },
  { key: "settlement_range", label: "7. Settlement Range Estimate", icon: "💰" },
  { key: "bad_faith_viability", label: "8. Bad Faith Viability Assessment", icon: "⚖️" },
];

// Tone audit: flag problematic language
const PROBLEMATIC_PHRASES = [
  "will win", "guaranteed", "carrier is acting in bad faith", "definitely",
  "certain to", "without question", "undeniably", "we will prevail",
];

const hasToneIssue = (text: string): boolean => {
  const lower = text.toLowerCase();
  return PROBLEMATIC_PHRASES.some(p => lower.includes(p));
};

export const StrategicMemo = ({ memo, claimNumber, driftDetected, driftReason }: StrategicMemoProps) => {
  const memoRef = useRef<HTMLDivElement>(null);

  if (!memo) return null;

  const exportPDF = async () => {
    if (!memoRef.current) return;
    try {
      const html2pdf = (await import("html2pdf.js")).default;
      html2pdf()
        .set({
          margin: [10, 10],
          filename: `Strategic-Memo-${claimNumber || "claim"}.pdf`,
          html2canvas: { scale: 2 },
          jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
        })
        .from(memoRef.current)
        .save();
    } catch (e) {
      console.error("PDF export failed:", e);
    }
  };

  return (
    <Card className="border-primary/30 bg-gradient-to-r from-primary/5 to-transparent">
      {/* Strategic Drift Alert */}
      {driftDetected && (
        <div className="mx-4 mt-4 p-3 rounded-md bg-warning/10 border border-warning/30 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 text-warning shrink-0 mt-0.5" />
          <div className="text-xs">
            <span className="font-semibold text-warning">Strategic Drift Detected</span>
            <p className="text-muted-foreground mt-0.5">{driftReason || "Strategic posture weakening. Review escalation path."}</p>
          </div>
        </div>
      )}

      <CardHeader className="py-3 px-4 flex-row items-center justify-between">
        <CardTitle className="text-sm flex items-center gap-2">
          <Shield className="h-4 w-4 text-primary" />
          Strategic Command Memo
        </CardTitle>
        <Button variant="outline" size="sm" onClick={exportPDF} className="gap-1.5">
          <FileDown className="h-3.5 w-3.5" />
          Export PDF
        </Button>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        <p className="text-[10px] text-muted-foreground mb-3 italic">
          This memo contains strategic suggestions only — not legal advice. All assessments are based on available claim data.
        </p>
        <div ref={memoRef} className="space-y-4">
          {sections.map(({ key, label, icon }) => {
            const value = memo[key];
            if (!value) return null;
            const toneIssue = hasToneIssue(value);
            return (
              <div key={key}>
                <h4 className="text-xs font-semibold mb-1">
                  {icon} {label}
                </h4>
                <p className="text-sm text-muted-foreground leading-relaxed">{value}</p>
                {toneIssue && (
                  <Badge variant="outline" className="text-[9px] mt-1 border-warning/50 text-warning">
                    ⚠ Review tone — may contain absolute language
                  </Badge>
                )}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
};
