import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { CHECK_IMAGES_BUCKET } from "@/lib/storageBuckets";
import {
  combineCheckAltCompliance,
  emptySide,
  evaluateCheckAltImageCompliance,
  measureBlob,
  toCheckAltPath,
  type CheckAltComplianceStatus,
  type CheckAltSideReport,
} from "@/lib/checkaltImageCompliance";

type Props = {
  checkId: string;
  frontImagePath?: string | null;
  backImageDepositPath?: string | null;
};

const inspectPath = async (path: string | null | undefined, side: "front" | "rear"): Promise<CheckAltSideReport> => {
  const artifact = toCheckAltPath(path);
  if (!artifact) return emptySide(side);
  const { data, error } = await supabase.storage.from(CHECK_IMAGES_BUCKET).download(artifact);
  if (error || !data) return emptySide(side);
  const info = await measureBlob(data);
  return evaluateCheckAltImageCompliance({ ...info, jpeg: true }, side);
};

export async function loadCheckAltComplianceStatus(input: {
  frontImagePath?: string | null;
  backImageDepositPath?: string | null;
}): Promise<CheckAltComplianceStatus> {
  const [front, rear] = await Promise.all([
    inspectPath(input.frontImagePath, "front"),
    inspectPath(input.backImageDepositPath, "rear"),
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
}: Props) {
  const query = useQuery({
    queryKey: ["checkalt-image-compliance", checkId, frontImagePath, backImageDepositPath],
    queryFn: () => loadCheckAltComplianceStatus({ frontImagePath, backImageDepositPath }),
    enabled: Boolean(checkId),
  });
  const status = query.data;
  const overall = status?.overall ?? "FAIL";

  return (
    <div className="rounded-md border border-border/60 bg-background/40 p-2 mt-1 space-y-1">
      <div className="flex items-center justify-between text-xs font-medium">
        <span>CHECKALT IMAGE COMPLIANCE</span>
        <span className={overall === "PASS" ? "text-emerald-400" : "text-red-300"}>{overall}</span>
      </div>
      <SideRow label="Front" report={status?.front ?? emptySide("front")} />
      <SideRow label="Rear" report={status?.rear ?? emptySide("rear")} />
      {overall !== "PASS" && (
        <p className="text-[10px] text-muted-foreground">
          Official 1920×1080 JPEGs (25–300 KB) are required on both sides before deposit.
        </p>
      )}
    </div>
  );
}
