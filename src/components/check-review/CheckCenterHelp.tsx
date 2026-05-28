import {
  HelpCircle,
  ShieldCheck,
  ClipboardCheck,
  Send,
  FileCheck,
  Landmark,
  Building2,
  RotateCcw,
  PauseCircle,
  AlertTriangle,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

interface Section {
  id: string;
  label: string;
  icon: React.ReactNode;
  summary: string;
  details: string[];
}

const corePrinciples: Section[] = [
  {
    id: "lockdown",
    label: "Review-First Lockdown",
    icon: <ShieldCheck className="h-4 w-4 text-emerald-400" />,
    summary:
      "Every uploaded check now lands in Review first. The system never auto-routes to Endorsing, Deposit, or Loss Draft — a reviewer must explicitly choose the next stage.",
    details: [
      "OCR extracts data and produces an AI deposit recommendation (e.g. 'endorsements pending', 'ready for deposit').",
      "That recommendation is a hint only — it appears inside Review to help the reviewer decide.",
      "Nothing leaves Review until a reviewer clicks one of the 5 deposit-path actions.",
      "Endorsement records may be pre-seeded in the background, but the check itself stays in Review until routed.",
    ],
  },
];

const tabHelpData: Section[] = [
  {
    id: "review",
    label: "Review",
    icon: <ClipboardCheck className="h-4 w-4 text-orange-400" />,
    summary: "Every newly uploaded check starts here. Verify OCR and choose a deposit path.",
    details: [
      "Confirm or correct the amount, check number, carrier, claim #, and payees.",
      "Read the AI recommendation and supporting reasons.",
      "Pick one of 5 deposit paths: Endorsing, Ready for Deposit, Branch, Reissue, or Hold (Loss Draft auto-triggers when a mortgage payee is detected).",
      "Flag issues for exception handling instead of routing if something looks wrong.",
    ],
  },
  {
    id: "endorsements",
    label: "Endorsing",
    icon: <Send className="h-4 w-4 text-amber-400" />,
    summary: "Checks the reviewer has explicitly routed here to collect payee signatures.",
    details: [
      "Send or resend endorsement requests via email or SMS to each payee.",
      "Track per-payee signature status (pending, signed, waived, manual_required).",
      "Resending an endorsement regenerates the secure link — old links continue to work until the new one is signed.",
      "Once all payees are settled, the check auto-advances to Ready for Deposit.",
    ],
  },
  {
    id: "ready",
    label: "Ready for Deposit",
    icon: <FileCheck className="h-4 w-4 text-emerald-400" />,
    summary: "Fully endorsed and verified checks staged for deposit.",
    details: [
      "Generate a closeout/deposit packet (front, back, endorsement images, signatures).",
      "Batch for electronic (CheckAlt RDC, when available) or branch deposit.",
      "Once deposited, the check moves to a terminal Deposited state.",
    ],
  },
  {
    id: "branch",
    label: "Branch Deposit",
    icon: <Building2 className="h-4 w-4 text-blue-400" />,
    summary: "Fallback rail when electronic deposit isn't available or required.",
    details: [
      "Used for checks the reviewer flags for manual in-branch deposit.",
      "Remains available even after CheckAlt RDC launches as a guaranteed fallback.",
    ],
  },
  {
    id: "reissue",
    label: "Reissue Requested",
    icon: <RotateCcw className="h-4 w-4 text-rose-400" />,
    summary: "Checks returned to the carrier for replacement.",
    details: [
      "Used when the check is stale, has wrong payees, or carries a defect.",
      "Tracks the outstanding reissue request until a replacement check is received and uploaded.",
    ],
  },
  {
    id: "hold",
    label: "Hold",
    icon: <PauseCircle className="h-4 w-4 text-slate-300" />,
    summary: "Temporarily parked checks awaiting external resolution.",
    details: [
      "Use when a check can't move forward right now (open dispute, missing payee info, awaiting authorization).",
      "Held checks surface in Loss Prevention/Reconciliation so they don't disappear.",
    ],
  },
  {
    id: "lossdraft",
    label: "Loss Draft",
    icon: <Landmark className="h-4 w-4 text-orange-400" />,
    summary: "Mortgage-company-involved checks requiring escrow handling.",
    details: [
      "Auto-flagged when a mortgage company is detected as a payee.",
      "Track mortgage endorsement, release schedules, inspection draws, and held funds.",
      "Generate loss draft packets for submission to the mortgagee.",
    ],
  },
  {
    id: "reconciliation",
    label: "Loss Prevention / Reconciliation",
    icon: <AlertTriangle className="h-4 w-4 text-yellow-400" />,
    summary: "Catches stuck checks, orphan files, and count mismatches so nothing slips through.",
    details: [
      "Surfaces checks that have been sitting in a stage longer than expected.",
      "Detects orphan storage files with no matching check record.",
      "Flags count mismatches between intake, endorsements, and deposit batches.",
    ],
  },
];

function SectionCard({ section }: { section: Section }) {
  return (
    <div className="rounded-lg border border-border bg-card/60 p-3 space-y-1.5">
      <div className="flex items-center gap-2">
        {section.icon}
        <span className="font-semibold text-sm">{section.label}</span>
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed">{section.summary}</p>
      <ul className="space-y-0.5 ml-5 list-disc">
        {section.details.map((d, i) => (
          <li key={i} className="text-xs text-muted-foreground/80 leading-relaxed">{d}</li>
        ))}
      </ul>
    </div>
  );
}

export function CheckCenterHelpPanel() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <HelpCircle className="h-5 w-5 text-primary" />
          ChecksOps Guide
        </CardTitle>
        <CardDescription>
          How the Check Center works under the new review-first lockdown process.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-3">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Core Process
          </h3>
          <div className="space-y-3">
            {corePrinciples.map((s) => (
              <SectionCard key={s.id} section={s} />
            ))}
          </div>
        </div>

        <div className="space-y-3">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Tabs &amp; Deposit Paths
          </h3>
          <div className="grid gap-3 md:grid-cols-2">
            {tabHelpData.map((s) => (
              <SectionCard key={s.id} section={s} />
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
