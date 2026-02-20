import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { FileDown, Shield } from "lucide-react";
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

export const StrategicMemo = ({ memo, claimNumber }: StrategicMemoProps) => {
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
        <div ref={memoRef} className="space-y-4">
          {sections.map(({ key, label, icon }) => {
            const value = memo[key];
            if (!value) return null;
            return (
              <div key={key}>
                <h4 className="text-xs font-semibold mb-1">
                  {icon} {label}
                </h4>
                <p className="text-sm text-muted-foreground leading-relaxed">{value}</p>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
};
