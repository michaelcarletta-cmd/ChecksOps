import { getPreviewBuildInfo } from "@/lib/previewBuildInfo";

export function PreviewBuildMarker() {
  const info = getPreviewBuildInfo();
  if (!info?.isVercelPreview) return null;

  const sha = (info.gitCommitSha || "").slice(0, 8) || "unknown";
  const pr = info.gitPrNumber ? `PR #${info.gitPrNumber}` : "PR Preview";
  const auth = (info.viteAuthProvider || "").trim() || "unknown";
  const api = (info.viteChecksopsApiUrl || "").trim() || null;

  return (
    <div className="bg-slate-950 text-slate-50 text-center text-[11px] font-medium py-1 px-3 border-b border-slate-800">
      <span className="mr-2">{pr} Preview</span>
      <span className="opacity-80">Build:</span> <span className="font-mono">{sha}</span>
      {info.vercelUrl ? (
        <>
          <span className="mx-2 opacity-40">·</span>
          <span className="opacity-80">Host:</span> <span className="font-mono">{info.vercelUrl}</span>
        </>
      ) : null}
      <span className="mx-2 opacity-40">·</span>
      <span className="opacity-80">Auth:</span> <span className="font-mono">{auth}</span>
      {api ? (
        <>
          <span className="mx-2 opacity-40">·</span>
          <span className="opacity-80">API:</span> <span className="font-mono">{api}</span>
        </>
      ) : null}
    </div>
  );
}

