import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { CHECK_IMAGES_BUCKET } from "@/lib/storageBuckets";
import { measureBlob, type CheckAltComplianceStatus } from "@/lib/checkaltImageCompliance";
import {
  checkAltCardHeading,
  describeCheckAltSide,
  loadCheckAltCardState,
  toCheckAltComplianceStatus,
  type CheckAltCardState,
  type CheckAltSideState,
  type CheckAltTone,
} from "@/lib/checkaltComplianceDisplay";

type Props = {
  checkId: string;
  frontImagePath?: string | null;
  backImageDepositPath?: string | null;
  onStatusChange?: (status: CheckAltComplianceStatus) => void;
};

const storageDeps = {
  download: (path: string) => supabase.storage.from(CHECK_IMAGES_BUCKET).download(path),
  measure: measureBlob,
};

const loadCardState = (input: { frontImagePath?: string | null; backImageDepositPath?: string | null }) =>
  loadCheckAltCardState(input, storageDeps);

export async function loadCheckAltComplianceStatus(input: {
  frontImagePath?: string | null;
  backImageDepositPath?: string | null;
}): Promise<CheckAltComplianceStatus> {
  return toCheckAltComplianceStatus(await loadCardState(input));
}

const TONE_CLASS: Record<CheckAltTone, string> = {
  good: "text-emerald-400",
  bad: "text-red-300",
  neutral: "text-muted-foreground",
};

const unknownState = (side: "front" | "rear"): CheckAltSideState => ({
  side,
  kind: "unknown",
  code: `${side}_check_unavailable`,
  report: null,
});

const SideRow = ({ state }: { state: CheckAltSideState }) => {
  const display = describeCheckAltSide(state);
  const report = state.report;
  return (
    <div className="text-xs" data-checkalt-side={state.side} data-checkalt-code={display.code ?? undefined}>
      <div className="flex items-center justify-between gap-3">
        <span className={`font-medium ${TONE_CLASS[display.tone]}`}>{display.label}</span>
        {report?.width && report?.height ? (
          <span className="text-muted-foreground tabular-nums">
            {`${report.width}×${report.height}`}
            {report.bytes ? ` · ${Math.round(report.bytes / 1024)} KB` : ""}
          </span>
        ) : null}
      </div>
      {display.hint && <p className="text-[10px] text-muted-foreground">{display.hint}</p>}
    </div>
  );
};

export function CheckAltImageComplianceCard({
  checkId,
  frontImagePath,
  backImageDepositPath,
  onStatusChange,
}: Props) {
  const query = useQuery({
    queryKey: ["checkalt-image-compliance", checkId, frontImagePath, backImageDepositPath],
    queryFn: async (): Promise<CheckAltCardState> => {
      const state = await loadCardState({ frontImagePath, backImageDepositPath });
      onStatusChange?.(toCheckAltComplianceStatus(state));
      return state;
    },
    enabled: Boolean(checkId),
  });
  const state: CheckAltCardState | null = query.data
    ?? (query.isError ? { front: unknownState("front"), rear: unknownState("rear") } : null);
  const heading = state ? checkAltCardHeading(state) : { text: "Checking images…", tone: "neutral" as const };

  return (
    <div className="rounded-md border border-border/60 bg-background/40 p-2 mt-1 space-y-1">
      <div className="flex items-center justify-between text-xs font-medium">
        <span>Deposit image check</span>
        <span className={TONE_CLASS[heading.tone]}>{heading.text}</span>
      </div>
      {state && (
        <>
          <SideRow state={state.front} />
          <SideRow state={state.rear} />
        </>
      )}
    </div>
  );
}
