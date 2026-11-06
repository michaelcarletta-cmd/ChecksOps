import type { ReactNode } from "react";
import { CalendarRange } from "lucide-react";
import { ProjectPlanCard } from "@/components/homeowner-ledger/ProjectPlanCard";

interface Props {
  /** The check's claim (check_intake_items.claim_id); the schedule lives on the claim. */
  claimId: string | null;
  /** The tenant that owns the check; the plan row is written with this tenant_id. */
  tenantId: string | null;
  /** Only the check's owner edits the schedule (same rule as the Funds tab card). */
  canEdit: boolean;
}

/**
 * "Project Schedule" tab of the check detail (owner, 2026-11-06): the claim's project plan
 * (start window, schedule status, note, contract total, deductible, out of pocket, homeowner
 * sharing) for the whole life of the check, at every stage, before and after deposit.
 * Editing rules are unchanged: the owner edits through ProjectPlanCard; a partner the check
 * is shared with does not get the editor.
 */
export function CheckProjectScheduleTab({ claimId, tenantId, canEdit }: Props) {
  if (!claimId) {
    return (
      <Notice>
        This check is not linked to a claim yet. Link it to a claim to set the project schedule.
      </Notice>
    );
  }
  if (!canEdit || !tenantId) {
    return <Notice>The project schedule is managed by the company that uploaded this check.</Notice>;
  }
  return <ProjectPlanCard claimId={claimId} tenantId={tenantId} />;
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
      <CalendarRange className="mt-0.5 h-4 w-4 shrink-0" />
      <p>{children}</p>
    </div>
  );
}
