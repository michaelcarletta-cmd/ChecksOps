import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { CheckCircle2, Circle, Eye, Send, ArrowDownToLine, Landmark, Banknote } from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";

interface CheckStatusWorkflowProps {
  claimId: string;
}

interface StepConfig {
  key: string;
  label: string;
  badge: string;
  actionLabel?: string;
  actionIcon?: React.ElementType;
}

const NON_MONITORED_STEPS: StepConfig[] = [
  { key: "sent_to_mortgage", label: "Check sent to mortgage company", badge: "Sent", actionLabel: "View Details", actionIcon: Eye },
  { key: "received_from_mortgage", label: "Check received from mortgage company", badge: "Received", actionLabel: "View Details", actionIcon: Eye },
  { key: "endorsements_pending", label: "Send out emails for endorsements", badge: "Endorsements Pending", actionLabel: "View Email", actionIcon: Send },
  { key: "ready_to_deposit", label: "Move towards deposit", badge: "Ready to Deposit", actionLabel: "View Deposit", actionIcon: ArrowDownToLine },
];

const MONITORED_STEPS: StepConfig[] = [
  { key: "submitted_to_mortgage", label: "Send check to mortgage company", badge: "Submitted", actionLabel: "View Details", actionIcon: Eye },
  { key: "in_escrow", label: "Check in escrow", badge: "In Escrow", actionLabel: "View Escrow", actionIcon: Landmark },
  { key: "draw_requested", label: "Request draws", badge: "Draw Requested", actionLabel: "Request Draw", actionIcon: Banknote },
  { key: "funded", label: "Receive funds", badge: "Funded", actionLabel: "View Funds", actionIcon: ArrowDownToLine },
];

function resolveActiveStep(
  path: "monitored" | "not_monitored",
  lossDraft: any,
  checkStatus: string | null
): number {
  if (!lossDraft && !checkStatus) return 0;

  if (path === "not_monitored") {
    if (checkStatus === "approved_for_deposit" || checkStatus === "deposited") return 4;
    if (checkStatus === "endorsing") return 2;
    if (lossDraft?.check_received_back_date) return 2;
    if (lossDraft?.check_sent_date) return 1;
    return 0;
  }

  // Monitored
  if (lossDraft?.escrow_status === "funds_released" || lossDraft?.escrow_status === "completed") return 4;
  if (lossDraft?.escrow_status === "draw_requested" || lossDraft?.escrow_status === "partial_release") return 3;
  if (lossDraft?.escrow_status === "in_escrow") return 2;
  if (lossDraft?.check_sent_date) return 1;
  return 0;
}

function getTimestamp(
  stepIndex: number,
  path: "monitored" | "not_monitored",
  lossDraft: any
): string | null {
  if (!lossDraft) return null;

  if (path === "not_monitored") {
    if (stepIndex === 0 && lossDraft.check_sent_date) return lossDraft.check_sent_date;
    if (stepIndex === 1 && lossDraft.check_received_back_date) return lossDraft.check_received_back_date;
    return null;
  }

  if (stepIndex === 0 && lossDraft.check_sent_date) return lossDraft.check_sent_date;
  return null;
}

export function CheckStatusWorkflow({ claimId }: CheckStatusWorkflowProps) {
  const [path, setPath] = useState<"monitored" | "not_monitored">("monitored");
  const [hoveredStep, setHoveredStep] = useState<number | null>(null);

  const { data: lossDraft } = useQuery({
    queryKey: ["claim-loss-draft-workflow", claimId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("loss_draft_tracking")
        .select("*, check_intake_items:check_intake_item_id(status)")
        .eq("claim_id", claimId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const checkStatus = (lossDraft as any)?.check_intake_items?.status ?? null;

  // Auto-detect path from data
  const effectivePath = useMemo(() => {
    if (lossDraft?.monitoring_type === "not_monitored") return "not_monitored";
    if (lossDraft?.monitoring_type === "monitored") return "monitored";
    return path;
  }, [lossDraft, path]);

  const steps = effectivePath === "monitored" ? MONITORED_STEPS : NON_MONITORED_STEPS;
  const activeStep = resolveActiveStep(effectivePath, lossDraft, checkStatus);

  if (!lossDraft) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <CardTitle className="text-base font-semibold">Check Status Workflow</CardTitle>
          <ToggleGroup
            type="single"
            value={effectivePath}
            onValueChange={(v) => v && setPath(v as "monitored" | "not_monitored")}
            className="bg-muted rounded-lg p-0.5"
          >
            <ToggleGroupItem
              value="monitored"
              className="text-xs px-3 py-1 h-7 rounded-md data-[state=on]:bg-background data-[state=on]:shadow-sm"
            >
              Monitored
            </ToggleGroupItem>
            <ToggleGroupItem
              value="not_monitored"
              className="text-xs px-3 py-1 h-7 rounded-md data-[state=on]:bg-background data-[state=on]:shadow-sm"
            >
              Not Monitored
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
      </CardHeader>
      <CardContent>
        <TooltipProvider delayDuration={200}>
          <div className="relative pl-6 transition-all duration-300 ease-in-out">
            {/* Vertical line */}
            <div className="absolute left-[11px] top-2 bottom-2 w-0.5 bg-border" />

            {steps.map((step, i) => {
              const isCompleted = i < activeStep;
              const isActive = i === activeStep;
              const isPending = i > activeStep;
              const timestamp = getTimestamp(i, effectivePath, lossDraft);
              const isHovered = hoveredStep === i;

              return (
                <div
                  key={step.key}
                  className={cn(
                    "relative flex items-start gap-3 pb-6 last:pb-0 transition-all duration-300 ease-in-out",
                    isPending && "opacity-50"
                  )}
                  onMouseEnter={() => setHoveredStep(i)}
                  onMouseLeave={() => setHoveredStep(null)}
                >
                  {/* Icon */}
                  <div className="absolute -left-6 flex items-center justify-center w-[22px] h-[22px] z-10">
                    {isCompleted ? (
                      <CheckCircle2
                        className="h-5 w-5 transition-colors duration-300"
                        style={{ color: "#10B981" }}
                      />
                    ) : isActive ? (
                      <div
                        className="h-5 w-5 rounded-full border-2 flex items-center justify-center transition-colors duration-300"
                        style={{ borderColor: "#3B82F6", backgroundColor: "#3B82F6" }}
                      >
                        <div className="h-2 w-2 rounded-full bg-white" />
                      </div>
                    ) : (
                      <Circle className="h-5 w-5 text-muted-foreground/50 transition-colors duration-300" />
                    )}
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span
                        className={cn(
                          "text-sm font-medium transition-colors duration-300",
                          isCompleted && "text-foreground",
                          isActive && "text-foreground",
                          isPending && "text-muted-foreground"
                        )}
                      >
                        {step.label}
                      </span>
                      <Badge
                        variant={isCompleted ? "default" : isActive ? "secondary" : "outline"}
                        className={cn(
                          "text-[10px] px-1.5 py-0 h-5 transition-colors duration-300",
                          isCompleted && "bg-emerald-500/15 text-emerald-600 border-emerald-500/30 hover:bg-emerald-500/15",
                          isActive && "bg-blue-500/15 text-blue-600 border-blue-500/30 hover:bg-blue-500/15"
                        )}
                      >
                        {step.badge}
                      </Badge>
                    </div>

                    {timestamp && (
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {format(new Date(timestamp), "MMM d, yyyy 'at' h:mm a")}
                      </p>
                    )}

                    {/* Action button on hover */}
                    {step.actionLabel && step.actionIcon && (
                      <div
                        className={cn(
                          "overflow-hidden transition-all duration-300 ease-in-out",
                          isHovered && (isCompleted || isActive)
                            ? "max-h-10 opacity-100 mt-1.5"
                            : "max-h-0 opacity-0 mt-0"
                        )}
                      >
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button variant="ghost" size="sm" className="h-7 text-xs px-2 gap-1.5">
                              <step.actionIcon className="h-3 w-3" />
                              {step.actionLabel}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="right">
                            <p>{step.actionLabel}</p>
                          </TooltipContent>
                        </Tooltip>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </TooltipProvider>
      </CardContent>
    </Card>
  );
}
