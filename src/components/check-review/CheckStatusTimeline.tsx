import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Upload,
  Send,
  PenTool,
  CheckCircle2,
  Landmark,
  AlertTriangle,
  Loader2,
} from "lucide-react";
import { format, formatDistanceToNow, differenceInHours } from "date-fns";
import { cn } from "@/lib/utils";

interface CheckStatusTimelineProps {
  checkId: string;
}

interface Endorsement {
  status: string;
  request_sent_at: string | null;
  signed_at: string | null;
}

interface CheckRow {
  status: string;
  created_at: string;
  updated_at: string;
}

type StageKey = "uploaded" | "sent" | "signed" | "ready_for_deposit";

interface Stage {
  key: StageKey;
  label: string;
  icon: typeof Upload;
  at: string | null;
  state: "complete" | "current" | "pending";
  hint?: string;
}

const TERMINAL_STATUSES = new Set([
  "approved_for_deposit",
  "branch_deposit_required",
  "loss_draft_required",
  "deposited",
]);

export function CheckStatusTimeline({ checkId }: CheckStatusTimelineProps) {
  const { data, isLoading } = useQuery({
    queryKey: ["check-status-timeline", checkId],
    queryFn: async () => {
      const [checkRes, endRes] = await Promise.all([
        supabase
          .from("check_intake_items")
          .select("status, created_at, updated_at")
          .eq("id", checkId)
          .maybeSingle(),
        supabase
          .from("check_endorsements")
          .select("status, request_sent_at, signed_at")
          .eq("check_id", checkId),
      ]);
      if (checkRes.error) throw checkRes.error;
      if (endRes.error) throw endRes.error;
      return {
        check: checkRes.data as CheckRow | null,
        endorsements: (endRes.data ?? []) as Endorsement[],
      };
    },
    refetchInterval: 30_000,
  });

  if (isLoading || !data?.check) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-6">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  const { check, endorsements: rawEndorsements } = data;
  
  // Deduplicate by name to handle orphaned or duplicate endorsement rows
  const endorsements = (() => {
    const best = new Map<string, Endorsement>();
    const rank = (e: Endorsement) => {
      const s = (e.status ?? "").toLowerCase();
      if (s === "signed" || !!e.signed_at) return 3;
      if (s === "waived") return 2;
      if (s === "sent") return 1;
      return 0;
    };
    for (const e of rawEndorsements) {
      const key = (e as any).payee_name?.trim().toLowerCase() || "unknown";
      const prev = best.get(key);
      if (!prev || rank(e) > rank(prev)) best.set(key, e);
    }
    return best.size > 0 ? Array.from(best.values()) : rawEndorsements;
  })();

  const sentTimestamps = endorsements
    .map((e) => e.request_sent_at)
    .filter((t): t is string => !!t)
    .sort();
  const firstSentAt = sentTimestamps[0] ?? null;

  const isSettled = (e: Endorsement) => {
    const status = (e.status ?? "").toLowerCase();
    return status === "signed" || status === "waived" || !!e.signed_at;
  };

  const settledCount = endorsements.filter(isSettled).length;

  const signedTimestamps = endorsements
    .filter(isSettled)
    .map((e) => e.signed_at)
    .filter((t): t is string => !!t)
    .sort();
  const allSettled = endorsements.length > 0 && endorsements.every(
    (e) => isSettled(e) || (e.status ?? "").toLowerCase() === "manual_required",
  );
  // Fall back to the check's own timestamp when a settled endorsement has no
  // signed_at (e.g. waived or manually recorded).
  const lastSignedAt = allSettled
    ? signedTimestamps[signedTimestamps.length - 1] ?? check.updated_at
    : null;

  // Signatures captured in person never have a request_sent_at — the collection
  // step is still complete, it just didn't happen over email.
  const collectedInPerson = !firstSentAt && settledCount > 0;

  const isReady = TERMINAL_STATUSES.has(check.status);
  const readyAt = isReady ? check.updated_at : null;

  const stalledHours =
    lastSignedAt && !isReady
      ? differenceInHours(new Date(), new Date(lastSignedAt))
      : 0;
  const isStalled = stalledHours >= 24;

  const stages: Stage[] = [
    {
      key: "uploaded",
      label: "Uploaded",
      icon: Upload,
      at: check.created_at,
      state: "complete",
    },
    {
      key: "sent",
      label: collectedInPerson ? "Signatures Collected" : "Signatures Sent",
      icon: Send,
      at: firstSentAt ?? (collectedInPerson ? signedTimestamps[0] ?? null : null),
      state: firstSentAt || collectedInPerson ? "complete" : "current",
      hint: collectedInPerson
        ? "Collected in person — no email request needed"
        : firstSentAt
          ? undefined
          : "Awaiting send",
    },
    {
      key: "signed",
      label: "Signatures Received",
      icon: PenTool,
      at: lastSignedAt,
      state: lastSignedAt
        ? "complete"
        : firstSentAt || settledCount > 0
          ? "current"
          : "pending",
      hint:
        !lastSignedAt && (firstSentAt || settledCount > 0)
          ? `${settledCount}/${Math.max(settledCount, endorsements.length)} received`
          : undefined,
    },

    {
      key: "ready_for_deposit",
      label:
        check.status === "loss_draft_required"
          ? "Loss Draft Routing"
          : check.status === "branch_deposit_required"
            ? "Branch Deposit"
            : check.status === "deposited"
              ? "Deposited"
              : "Ready for Deposit",
      icon: check.status === "deposited" ? Landmark : CheckCircle2,
      at: readyAt,
      state: isReady ? "complete" : lastSignedAt ? "current" : "pending",
    },
  ];

  return (
    <Card className={cn(isStalled && "border-destructive/50")}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="text-sm font-medium">Workflow Timeline</CardTitle>
          {isStalled && (
            <Badge variant="destructive" className="gap-1.5">
              <AlertTriangle className="h-3 w-3" />
              Status Update Pending — Contact Support
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <ol className="relative">
          {stages.map((stage, idx) => {
            const Icon = stage.icon;
            const isLast = idx === stages.length - 1;
            return (
              <li key={stage.key} className="relative flex gap-3 pb-5 last:pb-0">
                {!isLast && (
                  <span
                    aria-hidden
                    className={cn(
                      "absolute left-[15px] top-8 h-[calc(100%-1.5rem)] w-px",
                      stage.state === "complete" ? "bg-emerald-500/40" : "bg-border",
                    )}
                  />
                )}
                <span
                  className={cn(
                    "relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2",
                    stage.state === "complete" &&
                      "border-emerald-500/60 bg-emerald-500/15 text-emerald-400",
                    stage.state === "current" &&
                      "border-amber-500/60 bg-amber-500/15 text-amber-400 animate-pulse",
                    stage.state === "pending" &&
                      "border-border bg-muted text-muted-foreground",
                  )}
                >
                  <Icon className="h-4 w-4" />
                </span>
                <div className="flex-1 min-w-0 pt-1">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <p
                      className={cn(
                        "text-sm font-medium",
                        stage.state === "pending" && "text-muted-foreground",
                      )}
                    >
                      {stage.label}
                    </p>
                    {stage.at && (
                      <span className="text-xs text-muted-foreground">
                        {format(new Date(stage.at), "MMM d, h:mm a")}
                      </span>
                    )}
                  </div>
                  {stage.at && (
                    <p className="text-xs text-muted-foreground">
                      {formatDistanceToNow(new Date(stage.at), { addSuffix: true })}
                    </p>
                  )}
                  {stage.hint && (
                    <p className="text-xs text-amber-400/80 mt-0.5">{stage.hint}</p>
                  )}
                  {stage.key === "ready_for_deposit" && isStalled && (
                    <p className="text-xs text-destructive mt-1">
                      Stalled for {stalledHours}h after final signature. The auto-transition did not run — please contact support.
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
}
