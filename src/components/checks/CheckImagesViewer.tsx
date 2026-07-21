import { useEffect, useState } from "react";

type Side = "front" | "back";

type CheckImagesViewerProps = {
  open: boolean;
  frontUrl: string | null;
  backUrl: string | null;
  title?: string;
  onClose: () => void;
};

/**
 * Full-screen viewer that lets the user toggle between the front and back
 * of a check. Available at every stage of the workflow, including after
 * the check has been deposited.
 */
export function CheckImagesViewer({
  open,
  frontUrl,
  backUrl,
  title = "Check Images",
  onClose,
}: CheckImagesViewerProps) {
  const [zoom, setZoom] = useState(1);
  const [side, setSide] = useState<Side>("front");

  useEffect(() => {
    if (!open) {
      setZoom(1);
      setSide(frontUrl ? "front" : backUrl ? "back" : "front");
    } else {
      // Pick whichever is available first when opening
      setSide(frontUrl ? "front" : backUrl ? "back" : "front");
    }
  }, [open, frontUrl, backUrl]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        if (frontUrl && backUrl) setSide((s) => (s === "front" ? "back" : "front"));
      }
    };
    if (open) window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose, frontUrl, backUrl]);

  if (!open) return null;

  const currentUrl = side === "front" ? frontUrl : backUrl;

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-neutral-900 text-white rounded-lg shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2 p-3 border-b border-white/10 flex-wrap">
          <div className="text-sm font-medium">
            {title} — {side === "front" ? "Front" : "Back"}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex rounded-md border border-white/20 overflow-hidden">
              <button
                type="button"
                className={`px-2.5 py-1.5 text-xs transition-colors ${
                  side === "front" ? "bg-white text-black" : "hover:bg-white/10"
                } ${!frontUrl ? "opacity-40 cursor-not-allowed" : ""}`}
                onClick={() => frontUrl && setSide("front")}
                disabled={!frontUrl}
              >
                Front
              </button>
              <button
                type="button"
                className={`px-2.5 py-1.5 text-xs transition-colors ${
                  side === "back" ? "bg-white text-black" : "hover:bg-white/10"
                } ${!backUrl ? "opacity-40 cursor-not-allowed" : ""}`}
                onClick={() => backUrl && setSide("back")}
                disabled={!backUrl}
              >
                Back
              </button>
            </div>
            <button
              type="button"
              className="rounded-md border border-white/20 px-2.5 py-1.5 text-xs hover:bg-white/10"
              onClick={() => setZoom((z) => Math.max(0.5, z - 0.1))}
            >
              −
            </button>
            <button
              type="button"
              className="rounded-md border border-white/20 px-2.5 py-1.5 text-xs hover:bg-white/10"
              onClick={() => setZoom(1)}
            >
              Reset
            </button>
            <button
              type="button"
              className="rounded-md border border-white/20 px-2.5 py-1.5 text-xs hover:bg-white/10"
              onClick={() => setZoom((z) => Math.min(3, z + 0.1))}
            >
              +
            </button>
            {currentUrl && (
              <a
                href={currentUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-md border border-white/20 px-2.5 py-1.5 text-xs hover:bg-white/10"
              >
                Open
              </a>
            )}
            <button
              type="button"
              className="rounded-md border border-white/20 px-2.5 py-1.5 text-xs hover:bg-white/10"
              onClick={onClose}
            >
              Close
            </button>
          </div>
        </div>
        <div className="flex-1 flex items-center justify-center overflow-auto p-4 bg-black/40">
          {currentUrl ? (
            <img
              src={currentUrl}
              alt={`${side === "front" ? "Front" : "Back"} of check`}
              className="max-w-full max-h-[65vh] object-contain select-none"
              style={{
                transform: `scale(${zoom})`,
                transformOrigin: "center center",
              }}
            />
          ) : (
            <div className="text-sm text-white/70">
              No {side} image available for this check.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
