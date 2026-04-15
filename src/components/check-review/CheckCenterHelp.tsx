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
    id: "all",
    label: "All Checks",
    icon: <Inbox className="h-4 w-4 text-muted-foreground" />,
    summary: "A unified view of every check in the system regardless of status.",
    details: [
      "Browse all checks across every stage of the pipeline.",
      "Use the search bar to find checks by number, carrier, or claim.",
      "Click any row to open the check detail panel for quick actions.",
    ],
  },
  {
    id: "new",
    label: "New",
    icon: <FileCheck className="h-4 w-4 text-blue-400" />,
    summary: "Freshly uploaded checks awaiting initial OCR and review.",
    details: [
      "Upload new check images (front and back) here.",
      "OCR runs automatically to extract check number, amount, carrier, and payees.",
      "Once OCR completes, checks move to the Review queue.",
    ],
  },
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
    label: "Ready",
    icon: <FileCheck className="h-4 w-4 text-emerald-400" />,
    summary: "Fully endorsed checks ready for deposit.",
    details: [
      "All endorsements are complete and data has been verified.",
      "Generate a deposit packet or send directly to the deposit pipeline.",
      "Checks here can be batched for branch or electronic deposit.",
    ],
  },
  {
    id: "branch",
    label: "Branch",
    icon: <Building2 className="h-4 w-4 text-purple-400" />,
    summary: "Checks designated for physical branch deposit.",
    details: [
      "Print a branch deposit manifest with all included checks.",
      "Mark checks as deposited once the branch confirms receipt.",
      "Track branch deposit status and any discrepancies.",
    ],
  },
  {
    id: "reissue",
    label: "Reissue",
    icon: <RotateCcw className="h-4 w-4 text-red-400" />,
    summary: "Checks that need to be reissued due to errors, stale dates, or other issues.",
    details: [
      "Submit reissue requests with a reason category and notes.",
      "Track the status of pending reissue requests.",
      "Once a new check arrives, link it to the original for audit trail.",
    ],
  },
  {
    id: "deposit_ops",
    label: "Deposit Ops",
    icon: <ArrowDownToLine className="h-4 w-4 text-primary" />,
    summary: "The deposit operations console for managing the full deposit pipeline.",
    details: [
      "View approved checks in the deposit queue with real-time status.",
      "Manage deposit batches — group checks for electronic or branch deposit.",
      "Monitor deposit confirmation from banking providers.",
      "Access the Branch Deposit Manifest for physical deposit runs.",
    ],
  },
  {
    id: "reconciliation",
    label: "Reconciliation",
    icon: <Scale className="h-4 w-4 text-cyan-400" />,
    summary: "Match deposited checks against bank confirmations to close the loop.",
    details: [
      "Compare expected deposit amounts with actual bank-confirmed amounts.",
      "Identify and resolve variances between deposits and bank records.",
      "Mark items as reconciled once confirmed, completing the audit trail.",
      "Filter by date range, provider, or reconciliation status.",
    ],
  },
  {
    id: "exceptions",
    label: "Exceptions",
    icon: <ShieldAlert className="h-4 w-4 text-destructive" />,
    summary: "Flagged items that need manual intervention — NSF returns, variances, or processing errors.",
    details: [
      "Review NSF (non-sufficient funds) returns and determine next steps.",
      "Investigate deposit exceptions flagged by the bank or system.",
      "Resolve and close exceptions with notes for the audit log.",
      "Escalate unresolved exceptions to management via the Manager tab.",
    ],
  },
  {
    id: "aging",
    label: "Aging / SLA",
    icon: <Timer className="h-4 w-4 text-amber-400" />,
    summary: "Track how long checks have been in each stage and monitor SLA compliance.",
    details: [
      "View aging buckets: 0–3 days, 4–7 days, 8–14 days, and 15+ days.",
      "Identify bottlenecks where checks are stuck in endorsement or review.",
      "Monitor SLA targets for deposit turnaround time.",
      "Drill into aging items to take corrective action.",
    ],
  },
  {
    id: "reports",
    label: "Reports",
    icon: <FileBarChart className="h-4 w-4 text-blue-400" />,
    summary: "Pre-built reports for deposit activity, NSF tracking, variances, and unreconciled cash.",
    details: [
      "Daily Deposit Log — a day-by-day summary of all deposit activity.",
      "NSF / Return Report — tracks returned checks and reasons.",
      "Variance Report — highlights discrepancies between expected and actual amounts.",
      "Unreconciled Cash — shows deposits that haven't been matched to bank records.",
      "Export any report to CSV or print for your records.",
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
  {
    id: "kpis",
    label: "KPIs",
    icon: <BarChart3 className="h-4 w-4 text-emerald-400" />,
    summary: "Key performance indicators for the check and deposit operation.",
    details: [
      "Track deposit turnaround time, endorsement completion rate, and exception rate.",
      "Monitor daily deposit volume and average check value.",
      "View trend charts for week-over-week and month-over-month performance.",
      "Identify team members or carriers causing delays.",
    ],
  },
  {
    id: "workqueue",
    label: "Work Queue",
    icon: <Users className="h-4 w-4 text-violet-400" />,
    summary: "A prioritized task list for deposit operations staff.",
    details: [
      "See your assigned deposit tasks sorted by urgency and age.",
      "Claim or reassign tasks across the deposit operations team.",
      "Filter by task type: endorsement follow-up, review, reconciliation, etc.",
      "Mark tasks complete as you work through the queue.",
    ],
  },
  {
    id: "manager",
    label: "Manager",
    icon: <Command className="h-4 w-4 text-primary" />,
    summary: "Management command center with team oversight, escalations, and operational controls.",
    details: [
      "View team workload distribution and individual performance metrics.",
      "Handle escalated exceptions and approve high-value deposits.",
      "Configure deposit rules, SLA thresholds, and automation settings.",
      "Access the full audit log for compliance and oversight.",
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
            Check Command Center — Tab Guide
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
