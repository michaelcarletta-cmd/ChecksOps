import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { CHECK_IMAGES_BUCKET } from "@/lib/storageBuckets";
import {
  combineCheckAltCompliance,
  emptySide,
  evaluateCheckAltImageCompliance,
  isRasterClaimPath,
  measureBlob,
  reportOfficialMissing,
  toCheckAltPath,
  type CheckAltComplianceStatus,
  type CheckAltSideReport,
} from "@/lib/checkaltImageCompliance";

type Props = {
  checkId: string;
  frontImagePath?: string | null;
  backImageDepositPath?: string | null;
  /** Presence-only rear source (original/back). Never used as the official CheckAlt rear. */
  rearPresencePath?: string | null;
  onStatusChange?: (status: CheckAltComplianceStatus) => void;
};

const downloadClaim = async (path: string | null | undefined) => {
  if (!path) return null;
  const { data, error } = await supabase.storage.from(CHECK_IMAGES_BUCKET).download(path);
  if (error || !data) return null;
  return data;
};

const inspectOfficialOrSource = async (
  sourcePath: string | null | undefined,
  side: "front" | "rear",
): Promise<CheckAltSideReport> => {
  const artifact = toCheckAltPath(sourcePath);
  if (artifact) {
    const official = await downloadClaim(artifact);
    if (official) {
      const info = await measureBlob(official);
      return evaluateCheckAltImageCompliance({ ...info, jpeg: true }, side);
    }
  }
  if (sourcePath && isRasterClaimPath(sourcePath)) {
    const source = await downloadClaim(sourcePath);
    if (source) return reportOfficialMissing(side, true, source.size);
  }
  return emptySide(side);
};

export async function loadCheckAltComplianceStatus(input: {
  frontImagePath?: string | null;
  backImageDepositPath?: string | null;
  rearPresencePath?: string | null;
}): Promise<CheckAltComplianceStatus> {
  const [front, rear] = await Promise.all([
    inspectOfficialOrSource(input.frontImagePath, "front"),
    input.backImageDepositPath
      ? inspectOfficialOrSource(input.backImageDepositPath, "rear")
      : Promise.resolve(
        reportOfficialMissing("rear", Boolean(input.rearPresencePath)),
      ),
  ]);
  return combineCheckAltCompliance(front, rear);
}

const SideRow = ({ label, report }: { label: string; report: CheckAltSideReport }) => (
  <div className="flex items-center justify-between gap-3 text-xs">
    <span className="text-muted-foreground">{label}</span>
    <span className={report.pass ? "font-medium text-emerald-400" : "font-medium text-red-300"}>
      {report.pass ? "PASS" : "FAIL"}
      {!report.pass && report.reason ? ` · ${report.reason}` : ""}
    </span>
    <span className="text-muted-foreground tabular-nums">
      {report.width && report.height ? `${report.width}×${report.height}` : "—"}
      {report.bytes ? ` · ${Math.round(report.bytes / 1024)} KB` : ""}
    </span>
  </div>
);

export function CheckAltImageComplianceCard({
  checkId,
  frontImagePath,
  backImageDepositPath,
  rearPresencePath,
  onStatusChange,
}: Props) {
  const query = useQuery({
    queryKey: ["checkalt-image-compliance", checkId, frontImagePath, backImageDepositPath, rearPresencePath],
    queryFn: async () => {
      const status = await loadCheckAltComplianceStatus({
        frontImagePath,
        backImageDepositPath,
        rearPresencePath,
      });
      onStatusChange?.(status);
      return status;
    },
    enabled: Boolean(checkId),
  });
  const status = query.data;
  const overall = status?.overall ?? "FAIL";
  const rearUnprepared = status?.rear.reason === "rear_unprepared";

  return (
    <div className="rounded-md border border-border/60 bg-background/40 p-2 mt-1 space-y-1">
      <div className="flex items-center justify-between text-xs font-medium">
        <span>Deposit image check</span>
        <span className={overall === "PASS" ? "text-emerald-400" : "text-red-300"}>
          {overall === "PASS" ? "Ready" : "Needs attention"}
        </span>
      </div>
      <SideRow label="Front" report={status?.front ?? emptySide("front")} />
      <SideRow label="Back" report={status?.rear ?? emptySide("rear")} />
      {overall !== "PASS" && (
        <p className="text-[10px] text-muted-foreground">
          {rearUnprepared
            ? "Open Adjust Received Endorsement to generate the endorsed rear, then reload."
            : "Deposit will prepare the front and back images automatically."}
        </p>
      )}
    </div>
  );
}
