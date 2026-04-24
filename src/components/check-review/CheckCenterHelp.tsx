import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { HelpCircle, ArrowDownToLine, Scale, ShieldAlert, Timer, FileBarChart, Landmark, BarChart3, Users, Command, ClipboardCheck, FileCheck, Inbox, Send, Building2, RotateCcw } from "lucide-react";

interface TabHelp {
  id: string;
  label: string;
  icon: React.ReactNode;
  summary: string;
  details: string[];
}

const tabHelpData: TabHelp[] = [
  {
    id: "endorsements",
    label: "Endorsing",
    icon: <Send className="h-4 w-4 text-amber-400" />,
    summary: "Checks waiting for one or more payee endorsements before deposit.",
    details: [
      "Track which payees have signed and which are still pending.",
      "Send or resend endorsement requests via email or SMS.",
      "Once all required endorsements are collected, the check moves to Ready.",
    ],
  },
  {
    id: "review",
    label: "Review",
    icon: <ClipboardCheck className="h-4 w-4 text-orange-400" />,
    summary: "Checks that need manual verification of OCR data before proceeding.",
    details: [
      "Confirm or correct the extracted amount, check number, carrier, and payees.",
      "Approve the check to move it to the endorsement or deposit stage.",
      "Flag checks with issues for reissue or exception handling.",
    ],
  },
  {
    id: "ready",
    label: "Ready for Deposit",
    icon: <FileCheck className="h-4 w-4 text-emerald-400" />,
    summary: "Fully endorsed checks ready for deposit.",
    details: [
      "All endorsements are complete and data has been verified.",
      "Generate a deposit packet or send directly to the deposit pipeline.",
      "Checks here can be batched for branch or electronic deposit.",
    ],
  },
  {
    id: "lossdraft",
    label: "Loss Draft",
    icon: <Landmark className="h-4 w-4 text-orange-400" />,
    summary: "Manage mortgage company loss draft requirements and disbursement tracking.",
    details: [
      "Track checks that require mortgage company endorsement or release.",
      "Monitor disbursement schedules and follow-up on held funds.",
      "View loss draft status per claim with expected release dates.",
      "Generate loss draft packets for mortgage company submission.",
    ],
  },
];

export function CheckCenterHelpButton() {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="text-xs gap-1.5">
          <HelpCircle className="h-3.5 w-3.5" />
          Help
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[85vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <HelpCircle className="h-5 w-5 text-primary" />
            CheckOps — Tab Guide
          </DialogTitle>
        </DialogHeader>
        <ScrollArea className="max-h-[65vh] pr-3">
          <div className="space-y-4 pb-2">
            {tabHelpData.map((tab) => (
              <div key={tab.id} className="rounded-lg border border-border bg-card/60 p-3 space-y-1.5">
                <div className="flex items-center gap-2">
                  {tab.icon}
                  <span className="font-semibold text-sm">{tab.label}</span>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">{tab.summary}</p>
                <ul className="space-y-0.5 ml-5 list-disc">
                  {tab.details.map((d, i) => (
                    <li key={i} className="text-xs text-muted-foreground/80 leading-relaxed">{d}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
