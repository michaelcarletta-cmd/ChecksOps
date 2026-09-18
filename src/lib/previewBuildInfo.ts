export type PreviewBuildInfo = {
  isVercelPreview: boolean;
  vercelEnv: string | null;
  vercelUrl: string | null; // host only, no scheme
  gitCommitSha: string | null;
  gitPrNumber: string | null;
  viteAppUrl: string | null;
  viteAuthProvider: string | null;
  viteChecksopsApiUrl: string | null;
};

declare const __CHECKSOPS_PREVIEW_BUILD_INFO__: PreviewBuildInfo | undefined;

export function getPreviewBuildInfo(): PreviewBuildInfo | null {
  if (typeof __CHECKSOPS_PREVIEW_BUILD_INFO__ === "undefined") return null;
  return __CHECKSOPS_PREVIEW_BUILD_INFO__ ?? null;
}

export function enforceVercelPreviewCanonicalHost(): { redirected: boolean; to?: string } {
  const info = getPreviewBuildInfo();
  if (!info?.isVercelPreview) return { redirected: false };
  if (typeof window === "undefined") return { redirected: false };

  const canonicalHost = (info.vercelUrl || "").trim();
  if (!canonicalHost) return { redirected: false };
  if (!window.location.hostname) return { redirected: false };

  const current = window.location.hostname.trim().toLowerCase();
  if (current === canonicalHost.toLowerCase()) return { redirected: false };

  const to = `${window.location.protocol}//${canonicalHost}${window.location.pathname}${window.location.search}${window.location.hash}`;
  window.location.replace(to);
  return { redirected: true, to };
}

