export function isGeneratedBackArtifactPath(path: string | null | undefined): boolean {
  const p = String(path ?? "").trim();
  if (!p) return false;
  return (
    /_endorsed(?:_\d+)?\.[^.]+$/i.test(p) ||
    /endorsed_deposit_[^/]+\.[^.]+$/i.test(p) ||
    /\.svg(\?|$)/i.test(p) ||
    /\.checkalt\.jpg(\?|$)/i.test(p)
  );
}

export function assertCleanBackOriginalPath(path: string | null | undefined): string {
  const p = String(path ?? "").trim();
  if (!p) throw new Error("Clean back-of-check image path is missing.");
  if (isGeneratedBackArtifactPath(p)) {
    throw new Error("Refusing to treat a generated artifact as the clean original back image.");
  }
  return p;
}

