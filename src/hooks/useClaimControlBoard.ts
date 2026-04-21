import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  ClaimBoardEntry,
  ClaimOperationalState,
  computeFollowUpStatus,
  computeNextBestAction,
  computePressureScore,
  computePriorityRank,
  daysBetween,
} from "@/services/claimOperationsService";

const ATTENTION_STATUSES = [
  "Appraisal",
  "Carrier Denial",
  "DOBI Complaint Filed",
  "DOBI Compliance",
  "Litigation",
  "On Hold",
  "Repair Attempt / Sample Needed",
  "Research / Investigation",
  "Reissue of Check Requested",
  "Schedule Reinspection",
  "Submitted Rebuttal to Carrier",
  "Waiting on ACV Funds",
  "Waiting on Insurance Funds (ACV)",
  "Waiting on Mortgage Check",
];

const CARRIER_WAITING_STATUSES = [
  "Carrier Review",
  "Funding from Insurance",
  "Recoverable Depreciation Requested",
  "Waiting on ACV Funds",
  "Waiting on Insurance Funds (ACV)",
];

const normalizeStatus = (status?: string | null) => (status || "").trim();

const deriveLifecycleStage = (status?: string | null) => {
  const normalized = normalizeStatus(status);
  if (["Claim Filed", "Claim Assigned to Freedom Adjustment", "Inspections", "Schedule Reinspection"].includes(normalized)) return "inspection_pending";
  if (["Freedom Adjustment Review", "Repair Attempt / Sample Needed", "Research / Investigation", "Prove It Method"].includes(normalized)) return "estimate_in_progress";
  if (["Carrier Review", "Submitted Rebuttal to Carrier", "Recoverable Depreciation Requested"].includes(normalized)) return "supplement_submitted";
  if (["Appraisal"].includes(normalized)) return "appraisal";
  if (["Litigation", "DOBI Complaint Filed", "DOBI Compliance", "Carrier Denial"].includes(normalized)) return "litigation";
  if (["Funding from Insurance", "Waiting on ACV Funds", "Waiting on Insurance Funds (ACV)", "Waiting on Mortgage Check", "Check Uploaded for Processing", "Check Processing on iink", "Check Received - No Mortgage", "Check Cleared - Issue Funds", "Reissue of Check Requested", "Fee Collection", "Recoverable Depreciation"].includes(normalized)) return "negotiation";
  return "new";
};

/**
 * Fetches all active claims joined with their operational state
 * for the Claims Control Board.
 */
export function useClaimControlBoard() {
  const queryClient = useQueryClient();

  // Realtime subscription: refetch when microtasks or claim statuses change
  useEffect(() => {
    const channel = supabase
      .channel("control-board-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "claim_microtasks" },
        () => {
          queryClient.invalidateQueries({ queryKey: ["claim-control-board"] });
          queryClient.invalidateQueries({ queryKey: ["global-immediate-microtasks"] });
        }
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "claims" },
        () => {
          queryClient.invalidateQueries({ queryKey: ["claim-control-board"] });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [queryClient]);

  return useQuery({
    queryKey: ["claim-control-board"],
    queryFn: async (): Promise<ClaimBoardEntry[]> => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return [];

      // Fetch active claims with operational state
      const { data: claims, error } = await supabase
        .from("claims")
        .select(`
          id,
          claim_number,
          policyholder_name,
          policyholder_address,
          insurance_company,
          status,
          created_at,
          updated_at,
          claim_operational_state (*)
        `)
        .not("status", "in", '("Claim Settled","Dead File","Closed","closed","Fee Collection","Job Completed / Prepare Depreciation Package","Job Completed","Settled","Complete","Completed")')
        .order("created_at", { ascending: false })
        .limit(500);

      if (error) {
        console.error("[ClaimControlBoard] fetch error", error);
        return [];
      }

      // Fetch real last activity from the view
      const { data: activityData } = await supabase
        .from("claim_last_activity" as any)
        .select("claim_id, last_activity_at, days_inactive");

      const activityMap: Record<string, { last_activity_at: string; days_inactive: number }> = {};
      if (activityData) {
        for (const row of activityData as any[]) {
          activityMap[row.claim_id] = {
            last_activity_at: row.last_activity_at,
            days_inactive: row.days_inactive ?? 0,
          };
        }
      }

      // Fetch microtask counts per claim
      const claimIds = (claims || []).map((c: any) => c.id);
      let microtaskCounts: Record<string, { immediate: number; blocking: number; overdue: number }> = {};
      let taskCounts: Record<string, { open: number; overdue: number; immediate: number; blocking: number }> = {};

      if (claimIds.length > 0) {
        const { data: microtasks } = await supabase
          .from("claim_microtasks")
          .select("claim_id, priority, is_blocking, due_at")
          .in("claim_id", claimIds)
          .in("status", ["pending", "in_progress"]);

        if (microtasks) {
          for (const mt of microtasks) {
            if (!microtaskCounts[mt.claim_id]) {
              microtaskCounts[mt.claim_id] = { immediate: 0, blocking: 0, overdue: 0 };
            }
            if (mt.priority === "immediate") microtaskCounts[mt.claim_id].immediate++;
            if (mt.is_blocking) microtaskCounts[mt.claim_id].blocking++;
            if (mt.due_at && new Date(mt.due_at).getTime() < Date.now()) microtaskCounts[mt.claim_id].overdue++;
          }
        }

        const { data: tasks } = await supabase
          .from("tasks")
          .select("claim_id, status, priority, priority_level, due_date, due_at, blocked_reason")
          .in("claim_id", claimIds)
          .not("status", "in", '("completed","done","cancelled")');

        if (tasks) {
          for (const task of tasks as any[]) {
            if (!taskCounts[task.claim_id]) {
              taskCounts[task.claim_id] = { open: 0, overdue: 0, immediate: 0, blocking: 0 };
            }
            taskCounts[task.claim_id].open++;
            const dueDate = task.due_at || task.due_date;
            if (dueDate && new Date(dueDate).getTime() < Date.now()) taskCounts[task.claim_id].overdue++;
            if ([task.priority, task.priority_level].some((p) => ["immediate", "urgent", "high"].includes(String(p || "").toLowerCase()))) taskCounts[task.claim_id].immediate++;
            if (task.blocked_reason) taskCounts[task.claim_id].blocking++;
          }
        }
      }

      return (claims || []).map((c: any) => {
        const storedOps = c.claim_operational_state?.[0] || c.claim_operational_state || null;
        const normalizedStatus = normalizeStatus(c.status);
        const activity = activityMap[c.id];
        const daysInactive = activity?.days_inactive ?? daysBetween(c.updated_at || c.created_at);
        const microtaskSummary = microtaskCounts[c.id] || { immediate: 0, blocking: 0, overdue: 0 };
        const taskSummary = taskCounts[c.id] || { open: 0, overdue: 0, immediate: 0, blocking: 0 };
        const immediateCount = microtaskSummary.immediate + taskSummary.immediate;
        const blockingCount = microtaskSummary.blocking + taskSummary.blocking;
        const overdueCount = microtaskSummary.overdue + taskSummary.overdue;
        const attentionStatus = ATTENTION_STATUSES.includes(normalizedStatus);
        const carrierDelayStatus = CARRIER_WAITING_STATUSES.includes(normalizedStatus);
        const followUpStatus = computeFollowUpStatus(
          daysInactive,
          attentionStatus || overdueCount > 0 || blockingCount > 0,
          normalizedStatus.includes("DOBI") || normalizedStatus === "Litigation"
        );
        const pressureScore = Math.min(100, computePressureScore({
          claimValue: 0,
          carrierDelayDays: carrierDelayStatus ? daysInactive : 0,
          hasContradiction: normalizedStatus === "Carrier Denial",
          keyDocumentsUploaded: 0,
          expectedDocuments: 0,
          escalationInitiated: attentionStatus,
          daysSinceActivity: daysInactive,
        }) + immediateCount * 8 + blockingCount * 12 + overdueCount * 10 + taskSummary.open * 2);
        const staleFlag = daysInactive >= 14;
        const highExposureFlag = attentionStatus || pressureScore >= 60;
        const lifecycleStage = storedOps?.lifecycle_stage || deriveLifecycleStage(c.status);
        const nextAction = computeNextBestAction({
          lifecycleStage,
          followUpStatus,
          hasContradiction: normalizedStatus === "Carrier Denial",
          hasUnansweredDemand: carrierDelayStatus,
          hasPendingSupplement: normalizedStatus === "Carrier Review" || normalizedStatus === "Submitted Rebuttal to Carrier",
          hasEngineerReport: false,
          needsInspection: lifecycleStage === "inspection_pending",
          immediateMicrotasks: immediateCount,
          blockingMicrotasks: blockingCount,
        });
        const fallbackOps: ClaimOperationalState = {
          claim_id: c.id,
          lifecycle_stage: lifecycleStage,
          next_best_action: nextAction.action,
          next_best_action_confidence: nextAction.confidence,
          follow_up_status: followUpStatus,
          last_activity_at: activity?.last_activity_at || c.updated_at || c.created_at,
          days_since_last_activity: daysInactive,
          pressure_score: Math.round(pressureScore * 10) / 10,
          priority_rank: computePriorityRank(pressureScore, followUpStatus, {
            stale: staleFlag,
            contradiction: normalizedStatus === "Carrier Denial",
            highExposure: highExposureFlag,
          }),
          stale_flag: staleFlag,
          contradiction_flag: normalizedStatus === "Carrier Denial",
          high_exposure_flag: highExposureFlag,
          immediate_task_count: immediateCount,
          blocking_task_count: blockingCount,
          updated_at: new Date().toISOString(),
        };

        return {
          claim_id: c.id,
          claim_number: c.claim_number,
          policyholder_name: c.policyholder_name,
          property_address: c.policyholder_address,
          insurance_carrier: c.insurance_company,
          status: c.status,
          sub_status: null,
          ops: !storedOps || storedOps.days_since_last_activity === 0 || storedOps.follow_up_status === "on_track" ? fallbackOps : storedOps,
          immediate_microtasks: immediateCount,
          blocking_microtasks: blockingCount,
          open_tasks: taskSummary.open,
          overdue_tasks: overdueCount,
        };
      });
    },
    refetchInterval: 60000,
  });
}
